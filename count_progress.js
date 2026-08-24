#!/usr/bin/env node

/**
 * count_progress.js
 *
 * Skenira stvarne datoteke na disku u output direktoriju
 * i prikazuje pipeline progres s progress barovima.
 *
 * Usage:
 *   node count_progress.js
 *   node count_progress.js --input-dir <putanja>
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const inputDirIdx = args.indexOf('--input-dir');
const OUTPUT_DIR = inputDirIdx !== -1 && inputDirIdx + 1 < args.length
    ? args[inputDirIdx + 1]
    : path.join(__dirname, 'storage', 'output');

// Opt-in: izmjeri H.264 video migraciju IZ R2 (cdn.domovina.ai). Nuzno jer se
// video_h264.mp4 nakon uploada brise lokalno (--rm-local-after-upload u
// backfill_video_h264.js) → lokalni scan ga ne vidi; istina je na R2.
const WITH_R2_VIDEO = args.includes('--with-r2-video');

if (!fs.existsSync(OUTPUT_DIR)) {
    console.error(`❌ Output direktorij ne postoji: ${OUTPUT_DIR}`);
    console.error(`   Je li disk mountan? Ili koristi: node count_progress.js --input-dir <putanja>`);
    process.exit(1);
}

// --- Helpers ---

function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

// Ukupan broj epizoda koje je refresh_podcasts.sh otkrio preko svih kanala.
// Ovo je upper bound korpusa — sve ostalo je downstream progres protiv ove baze.
function countTotalListaEntries() {
    const listaDir = path.join(__dirname, 'automatic', 'podcasts');
    if (!fs.existsSync(listaDir)) return 0;
    let total = 0;
    for (const f of fs.readdirSync(listaDir)) {
        if (!f.endsWith('-lista.txt')) continue;
        try {
            const content = fs.readFileSync(path.join(listaDir, f), 'utf8');
            for (const line of content.split('\n')) {
                const t = line.trim();
                if (t && !t.startsWith('#')) total++;
            }
        } catch { /* skip */ }
    }
    return total;
}

// --- Scan ---

console.log("Skeniram direktorije...");

const stats = {};
const outlinesByModel = {};
const articlesByModel = {};
const outlineVideosByModel = {};
const articleVideosByModel = {};
// Speaker embeddings: per-source (canary|sortformer) × per-model breakdown.
// Naming: `*.wav.{source}.diarized.embeddings.{model}.json` (model je dinamičan,
// npr. titanet, pyannote_wespeaker34) — pa ne ide kroz statički `matchers` niz.
const embeddingsByModel = { canary: {}, sortformer: {} };
const embeddingVideosByModel = { canary: {}, sortformer: {} };
const embeddingVideosBySource = { canary: new Set(), sortformer: new Set() };
const EMBEDDING_RE = /^(.+)\.(canary|sortformer)\.diarized\.embeddings\.(.+)\.json$/;
const blockedReasons = { summary: {}, article: {} };
const blockedPermanent = { summary: 0, article: 0 };

// Extension matchers — order matters (longer/more specific first)
const matchers = [
    ['_whisper_prompt.txt', 'prompts'],
    ['.canary.summary.blocked.json', 'summaryBlocked'],
    ['.canary.diarized.blocked.json', 'articleBlocked'],
    ['.canary.diarized.srt', 'canaryDiarized'],
    ['.canary.summary.json', 'summary'],
    ['.canary.srt', 'canarySrt'],
    ['.canary.csv', 'canaryCsv'],
    ['.sortformer.diarized.srt', 'sortformerDiarized'],
    ['.sortformer.srt', 'sortformerSrt'],
    ['.sortformer.csv', 'sortformerCsv'],
    ['.diarized.srt', 'diarized'],
    ['.wav.srt', 'srt'],
    ['.info.json', 'infoJson'],
    ['.description', 'description'],
    ['.outline.json', 'outline'],
    ['.article.magisterium.json', 'magisterium'],
    ['.article.json', 'article'],
    ['.rag_chunks.jsonl', 'ragChunks'],
    ['.rag_import.jsonl', 'ragImport'],
    ['.rag_combined.jsonl', 'ragCombined'],
    ['.mp3', 'mp3'],
    ['.wav', 'wav'],
    // Video fajlovi: yt-dlp merged video (.mkv) → ffmpeg remux na .mp4 (R2 publish)
    ['.mkv', 'mkv'],
    ['.mp4', 'mp4Final'],
];

// Intermediate yt-dlp video fragmenti (.f140.mp4, .f396.mp4, ...) NISU final
// remuxed mp4 — preskoči ih da ne unesu šum u "MP4 remux" brojač.
const INTERMEDIATE_MP4_RE = /\.f\d+\.mp4$/;

function classify(filename) {
    if (INTERMEDIATE_MP4_RE.test(filename)) return null;
    for (const [suffix, key] of matchers) {
        if (filename.endsWith(suffix)) return key;
    }
    return null;
}

const channels = fs.readdirSync(OUTPUT_DIR).filter(f => {
    const stat = fs.statSync(path.join(OUTPUT_DIR, f));
    return stat.isDirectory() && !f.startsWith('.');
});

let totalOutlineVideos = 0;
let totalArticleVideos = 0;
let totalMagisteriumVideos = 0;
// Praćenje MKV/MP4 po videu (za izračun "koliko MKV-ova ima par .mp4 = remuxed").
// MP4 može postojati i bez MKV-a (yt-dlp ponekad skida direktno .mp4), pa
// jednostavan g('mp4Final')/g('mkv') ne mjeri remux-progress smisleno.
let totalMkvRemuxed = 0;
let totalMkvWaiting = 0;

for (const channel of channels) {
    const channelPath = path.join(OUTPUT_DIR, channel);

    try {
        const files = fs.readdirSync(channelPath);
        const videosWithOutline = new Set();
        const videosWithArticle = new Set();
        const videosWithMagisterium = new Set();
        const videosWithMkv = new Set();
        const videosWithMp4 = new Set();
        // Baze videa (iz .info.json) + koje imaju screenshot dir — potrebno da se
        // audio-only epizode izbace iz screenshot NAZIVNIKA (vidi computeAudioOnly nize).
        const infoBases = [];
        const screenshotBases = new Set();

        for (const file of files) {
            if (file.startsWith('._')) continue;
            // Loudness namespace (.loudnorm.mp3/.mp4/.json/.wav) je izveden artefakt,
            // NIJE epizoda — ignoriraj da ne iskrivi brojeve (kao .sortformer.*).
            if (file.includes('.loudnorm.')) continue;

            // Screenshot direktoriji: jedan po videu, sufiks `_screenshots`,
            // sadrže `_manifest.json` + N PNG fajlova (jedan po timestampu).
            // Manifest je jedini pouzdan signal "screenshot batch završen za ovaj video".
            if (file.endsWith('_screenshots')) {
                const ssPath = path.join(channelPath, file);
                screenshotBases.add(file.slice(0, -'_screenshots'.length));
                try {
                    if (fs.statSync(ssPath).isDirectory()) {
                        if (fs.existsSync(path.join(ssPath, '_manifest.json'))) {
                            stats.screenshots = (stats.screenshots || 0) + 1;
                        }
                        for (const inner of fs.readdirSync(ssPath)) {
                            if (inner.startsWith('._')) continue;
                            if (inner.endsWith('.png')) {
                                stats.screenshotPng = (stats.screenshotPng || 0) + 1;
                            }
                        }
                    }
                } catch { /* skip */ }
                continue;
            }

            const key = classify(file);
            if (key) {
                stats[key] = (stats[key] || 0) + 1;

                if (key === 'infoJson') {
                    infoBases.push(file.slice(0, -'.info.json'.length));
                }

                // Track blocked reasons and retry status
                if (key === 'summaryBlocked' || key === 'articleBlocked') {
                    try {
                        const content = JSON.parse(fs.readFileSync(path.join(channelPath, file), 'utf-8'));
                        const reason = content.reason || 'UNKNOWN';
                        const type = (key === 'summaryBlocked') ? 'summary' : 'article';
                        blockedReasons[type][reason] = (blockedReasons[type][reason] || 0) + 1;
                        if ((content.retry_count || 0) >= 3) {
                            blockedPermanent[type]++;
                        }
                    } catch (e) { /* ignore parse errors */ }
                }
            }

            // Track unique videos and models for outline/article/magisterium
            if (key === 'outline') {
                const base = file.replace(/\.wav\.canary\.diarized_.*\.outline\.json$/, '');
                videosWithOutline.add(base);
                const m = file.match(/\.wav\.canary\.diarized_\d{4}-\d{2}-\d{2}_(.+)\.outline\.json$/);
                if (m) {
                    outlinesByModel[m[1]] = (outlinesByModel[m[1]] || 0) + 1;
                    if (!outlineVideosByModel[m[1]]) outlineVideosByModel[m[1]] = new Set();
                    outlineVideosByModel[m[1]].add(base);
                }
            } else if (key === 'article') {
                const base = file.replace(/\.wav\.canary\.diarized_.*\.article\.json$/, '');
                videosWithArticle.add(base);
                const m = file.match(/\.wav\.canary\.diarized_\d{4}-\d{2}-\d{2}_(.+)\.article\.json$/);
                if (m) {
                    articlesByModel[m[1]] = (articlesByModel[m[1]] || 0) + 1;
                    if (!articleVideosByModel[m[1]]) articleVideosByModel[m[1]] = new Set();
                    articleVideosByModel[m[1]].add(base);
                }
            } else if (key === 'magisterium') {
                const base = file.replace(/\.wav\.canary\.diarized_.*\.article\.magisterium\.json$/, '');
                videosWithMagisterium.add(base);
            } else if (key === 'mkv') {
                videosWithMkv.add(file.slice(0, -4));
            } else if (key === 'mp4Final') {
                videosWithMp4.add(file.slice(0, -4));
            }

            // Speaker embeddings (per-source × per-model). Brojimo i jedinstvene
            // videe po source (jer isti video može imati više modela), i datoteke
            // po (source, model) za breakdown ispod.
            const embMatch = file.match(EMBEDDING_RE);
            if (embMatch) {
                const [, base, source, model] = embMatch;
                embeddingVideosBySource[source].add(base);
                embeddingsByModel[source][model] = (embeddingsByModel[source][model] || 0) + 1;
                if (!embeddingVideosByModel[source][model]) embeddingVideosByModel[source][model] = new Set();
                embeddingVideosByModel[source][model].add(base);
            }
        }

        // Audio-only epizode (beamly direct-MP3 bez YT matcha) NIKAD ne dobiju
        // screenshote — `screenshot_youtube.js` ih preskace na `_yt_matched === false`.
        // Drzati ih u nazivniku znaci trajno prikazivati laznu rupu (2026-08-17: 170
        // takvih je izgledalo kao 131-video zaostatak). Citamo .info.json SAMO za videe
        // BEZ screenshot dira — audio-only su svi u tom skupu, pa je rezultat potpun,
        // a trosak ostaje na ~stotinu fajlova umjesto na cijelom katalogu.
        for (const base of infoBases) {
            if (screenshotBases.has(base)) continue;
            try {
                const info = JSON.parse(fs.readFileSync(path.join(channelPath, base + '.info.json'), 'utf-8'));
                if (info._yt_matched === false) stats.audioOnly = (stats.audioOnly || 0) + 1;
            } catch { /* neispravan/nedostupan info.json — tretiraj kao obican video */ }
        }

        totalOutlineVideos += videosWithOutline.size;
        totalArticleVideos += videosWithArticle.size;
        totalMagisteriumVideos += videosWithMagisterium.size;
        for (const base of videosWithMkv) {
            if (videosWithMp4.has(base)) totalMkvRemuxed++;
            else totalMkvWaiting++;
        }
    } catch (e) {
        console.error(`Greška pri čitanju: ${channelPath} - ${e.message}`);
    }
}

// --- Output ---

const g = (k) => stats[k] || 0;

// Baza = ukupno u automatic/podcasts/*-lista.txt (korpus koji refresh otkriva).
// Fallback na broj .mp3 ako direktorij nije dostupan (npr. pokretano izvan repoa).
const listaTotal = countTotalListaEntries();
const mp3Count   = g('mp3');
// "Preuzeto" se MORA mjeriti .info.json-om, ne .mp3-om: `convert_to_wav.js` brise .mp3
// nakon konverzije, pa je .mp3 tranzijentan i mjeri samo "jos nije konvertirano".
// Racunanje backloga iz njega je prijavljivalo 3119 zaostalih dok ih je stvarno bilo 6
// (2026-08-17). .info.json se pise pri downloadu i nikad se ne brise → trajni signal.
const fetchedCount = g('infoJson');
const total      = listaTotal || fetchedCount;
const backlog    = listaTotal ? Math.max(0, listaTotal - fetchedCount) : 0;

const BAR_WIDTH = 20;

function progressBar(count, base) {
    const ratio = base > 0 ? Math.min(count / base, 1) : 0;
    const pct = (ratio * 100).toFixed(3);
    const filled = Math.round(ratio * BAR_WIDTH);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(BAR_WIDTH - filled);
    return { bar, pct };
}

function line(label, count, base, opts = {}) {
    const { bar, pct } = progressBar(count, base);
    const blocked = opts.blocked ? ` (+${opts.blocked} blocked)` : '';
    const extraLabel = opts.extraLabel || 'files';
    const extra = opts.extra ? ` (${opts.extra} ${extraLabel})` : '';
    console.log(
        `    ${pad(label, 30)} ${bar} ${rpad(pct + '%', 9)} ${rpad(count, 5)}/${base}${blocked}${extra}`
    );
    // Sub-items (model breakdown)
    if (opts.models) {
        const sorted = Object.entries(opts.models).sort((a, b) => b[1] - a[1]);
        for (const [model, fileCount] of sorted) {
            const videos = opts.modelVideos?.[model]?.size || 0;
            console.log(`      └─ ${model}: ${videos} videa (${fileCount} datoteka)`);
        }
    }
}

if (listaTotal) {
    console.log(`\n  Pipeline progress (${listaTotal} u listama, ${fetchedCount} preuzeto, ${backlog} u backlogu)\n`);
} else {
    console.log(`\n  Pipeline progress (${total} preuzetih videa)\n`);
}

console.log('    -- Download & konverzija --');
line('Preuzeto (.info.json)', g('infoJson'), total);
// .mp3 je medukorak prema .wav i brise se nakon konverzije — nizak postotak je OCEKIVAN
// i NIJE zaostatak. Ostaje vidljiv samo kao "koliko ceka convert_to_wav.js".
line('  └─ .mp3 ceka WAV konverziju', g('mp3'), total);
line('WAV konverzija (.wav)', g('wav'), total);
// NIJE delivery signal: `backfill_video_h264.js --rm-local-after-upload` NAMJERNO brise
// lokalni .mkv nakon uspjesnog H.264 uploada (DOMOVINA1TB je tijesan), pa nedostatak
// .mkv najcesce znaci "vec isporuceno", a ne "rupa". 2026-08-17 je ovaj redak izgledao
// kao 678 videa zaostatka, a uzorak 20/20 je vec bio live na CDN-u.
// Za stvarnu isporuku: node count_progress.js --with-r2-video
line('Lokalni MKV master (≠isporuka)', g('mkv'), total);
line('Opisi (.description)', g('description'), total);

console.log('\n    -- Whisper (OpenAI) --');
line('Whisper prompt (.txt)', g('prompts'), total);
line('Whisper transkripcija (.srt)', g('srt'), total);
line('Whisper diarizacija', g('diarized'), total);

console.log('\n    -- Canary (NVIDIA) --');
line('Canary transkripcija', g('canarySrt'), total);
line('Canary CSV', g('canaryCsv'), total);
line('Canary diarizacija', g('canaryDiarized'), total);

console.log('\n    -- Sortformer (NVIDIA, GPU end-to-end, eksperimentalno) --');
line('Sortformer transkripcija', g('sortformerSrt'), total);
line('Sortformer CSV', g('sortformerCsv'), total);
line('Sortformer diarizacija', g('sortformerDiarized'), total);

// Speaker embeddings — denominator je broj dijariziranih videa za taj source
// (embeddings dolaze direktno iz .diarized.srt), ne globalni `total`, jer bi
// to bilo iskrivljeno za sortformer (eksperimentalni, malo videa).
function embeddingsTotalFiles(source) {
    let n = 0;
    for (const m of Object.values(embeddingsByModel[source])) n += m;
    return n;
}
const canaryDiarizedCount = g('canaryDiarized');
const sortformerDiarizedCount = g('sortformerDiarized');
const canaryEmbVideos = embeddingVideosBySource.canary.size;
const sortformerEmbVideos = embeddingVideosBySource.sortformer.size;
if (canaryEmbVideos > 0 || sortformerEmbVideos > 0 || canaryDiarizedCount > 0) {
    console.log('\n    -- Speaker embeddings (per-speaker voice vectors) --');
    line('Canary embeddings', canaryEmbVideos, canaryDiarizedCount || total, {
        extra: embeddingsTotalFiles('canary'),
        models: embeddingsByModel.canary,
        modelVideos: embeddingVideosByModel.canary,
    });
    if (sortformerEmbVideos > 0 || sortformerDiarizedCount > 0) {
        line('Sortformer embeddings', sortformerEmbVideos, sortformerDiarizedCount || total, {
            extra: embeddingsTotalFiles('sortformer'),
            models: embeddingsByModel.sortformer,
            modelVideos: embeddingVideosByModel.sortformer,
        });
    }
}

console.log('\n    -- Gemini (Google) --');

function formatBlocked(type) {
    const count = g(type + 'Blocked');
    if (!count) return undefined;
    const reasons = Object.entries(blockedReasons[type === 'summary' ? 'summary' : 'article']);
    const reasonStr = reasons.length > 0 ? ` [${reasons.map(([r, c]) => `${r}: ${c}`).join(', ')}]` : '';
    const permCount = blockedPermanent[type === 'summary' ? 'summary' : 'article'];
    const permStr = permCount > 0 ? ` (${permCount} trajno)` : '';
    return `${count}${reasonStr}${permStr}`;
}

line('Gemini sazeci', g('summary'), total, { blocked: formatBlocked('summary') });
line('Gemini outlinei', totalOutlineVideos, total, { extra: g('outline'), models: outlinesByModel, modelVideos: outlineVideosByModel });
line('Gemini clanci', totalArticleVideos, total, { extra: g('article'), blocked: formatBlocked('article'), models: articlesByModel, modelVideos: articleVideosByModel });
line('Magisterium (teol. score)', totalMagisteriumVideos, total, { extra: g('magisterium') });

console.log('\n    -- RAG priprema --');
line('RAG chunks', g('ragChunks'), total);
line('RAG import', g('ragImport'), total);
line('RAG combined', g('ragCombined'), total);

// Delivery je sada data/{id}/video_h264.mp4 na R2 (mjeri se IZ R2 jer se web.mp4 briše
// lokalno → vidi --with-r2-video). Stari "MKV → MP4 remux" flow (layer C, VP9/AV1-u-mp4
// `-c:v copy`) je DEPRECATED: legacy lokalni .mp4 su mrtvi artefakti (kandidati za disk
// cleanup), više NISU publish-ready. Lokalni .mkv ostaju masteri (izvor za H.264 transcode).
console.log('\n    -- Screenshots & H.264 publish --');
// Nazivnik iskljucuje audio-only (beamly `_yt_matched:false`) — one se preskacu po
// dizajnu, pa bi ih drzanje u nazivniku prikazivalo kao trajnu rupu.
const audioOnly = g('audioOnly');
const screenshotBase = Math.max(0, total - audioOnly);
line('Screenshot dirovi (po videu)', g('screenshots'), screenshotBase, { extra: g('screenshotPng'), extraLabel: 'PNG' });
if (audioOnly) {
    console.log(`      └─ ${audioOnly} audio-only epizoda izuzeto (bez YT videa, skip po dizajnu)`);
}
console.log('    H.264 delivery se mjeri IZ R2 → node count_progress.js --with-r2-video');
if (g('mp4Final')) {
    console.log(`    Legacy lokalni .mp4 (VP9/AV1 layer C): ${g('mp4Final')} — DEPRECATED, kandidati za disk cleanup`);
}

console.log();

// --- Disk usage ---

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

console.log('    -- Disk usage po kanalu --\n');

const diskUsage = [];
for (const channel of channels) {
    const channelPath = path.join(OUTPUT_DIR, channel);
    try {
        const raw = execSync(`du -skL "${channelPath}"`, { encoding: 'utf-8' });
        const kb = parseInt(raw.split('\t')[0], 10);
        // Resolve real path (follow symlink) for volume info
        let realPath = channelPath;
        try { realPath = fs.realpathSync(channelPath); } catch {}
        const volume = realPath.split('/').slice(0, 3).join('/'); // /Volumes/DISKNAME
        diskUsage.push({ channel, kb, volume });
    } catch {
        diskUsage.push({ channel, kb: 0, volume: '?' });
    }
}

diskUsage.sort((a, b) => b.kb - a.kb);

const maxKb = diskUsage[0]?.kb || 1;
const totalKb = diskUsage.reduce((s, d) => s + d.kb, 0);

for (const { channel, kb, volume } of diskUsage) {
    const bar = progressBar(kb, maxKb);
    const disk = volume !== OUTPUT_DIR ? `  [${volume.replace('/Volumes/', '')}]` : '';
    console.log(`    ${pad(channel, 30)} ${bar.bar} ${rpad(formatBytes(kb * 1024), 10)}${disk}`);
}
console.log(`\n    ${'─'.repeat(72)}`);
console.log(`    ${pad('UKUPNO', 30)} ${''.padStart(BAR_WIDTH + 1)} ${rpad(formatBytes(totalKb * 1024), 10)}`);

// Per-volume summary
const volumes = {};
for (const { kb, volume } of diskUsage) {
    volumes[volume] = (volumes[volume] || 0) + kb;
}
if (Object.keys(volumes).length > 1) {
    console.log();
    for (const [vol, kb] of Object.entries(volumes).sort((a, b) => b[1] - a[1])) {
        const volName = vol.replace('/Volumes/', '');
        console.log(`    Disk ${pad(volName, 20)} ${rpad(formatBytes(kb * 1024), 10)}`);
    }
}
console.log();

// --- H.264 video migracija (opt-in, IZ R2) ---
// video_h264.mp4 ne postoji lokalno (brise se po uploadu) → broji se s R2.
if (!WITH_R2_VIDEO) {
    console.log('    -- Video H.264 cross-platform --');
    console.log('    (za R2 status: node count_progress.js --with-r2-video)\n');
} else {
    (async () => {
        // .env (R2 credsi) — isti rucni parser kao upload_to_r2.js
        const envPath = path.join(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
                const t = line.trim();
                if (!t || t.startsWith('#')) continue;
                const i = t.indexOf('=');
                if (i === -1) continue;
                const k = t.slice(0, i).trim();
                if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
            }
        }
        let S3;
        try { S3 = require('@aws-sdk/client-s3'); }
        catch { console.error('    ⚠️  --with-r2-video traži @aws-sdk/client-s3 (npm install @aws-sdk/client-s3)\n'); return; }

        const client = new S3.S3Client({
            region: 'auto',
            endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            },
        });
        const bucket = process.env.R2_BUCKET_NAME || 'cdn-domovina-ai';

        let h264 = 0, legacy = 0, token, pages = 0;
        process.stdout.write('    -- Video H.264 cross-platform (R2 cdn.domovina.ai) --\n    listam R2');
        try {
            do {
                const resp = await client.send(new S3.ListObjectsV2Command({
                    Bucket: bucket, Prefix: 'data/', ContinuationToken: token,
                }));
                for (const obj of resp.Contents || []) {
                    if (obj.Key.endsWith('/video_h264.mp4')) h264++;
                    else if (obj.Key.endsWith('/video.mp4')) legacy++;
                }
                token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
                if (++pages % 5 === 0) process.stdout.write('.');
            } while (token);
        } catch (e) {
            console.error(`\n    ⚠️  R2 listanje neuspjelo: ${e.message}\n`);
            return;
        }
        process.stdout.write('\n');

        // Denominator = objavljeni videi (legacy video.mp4 postoji za svaki dok --delete-old
        // ne pocisti); h264 je migrirano. cap na max() za slucaj nakon brisanja.
        const denom = Math.max(legacy, h264, 1);
        const { bar, pct } = progressBar(h264, denom);
        console.log(`    ${pad('H.264 (video_h264.mp4)', 30)} ${bar} ${rpad(pct + '%', 9)} ${rpad(h264, 5)}/${denom}`);
        console.log(`      └─ legacy video.mp4 (VP9/AV1 fallback): ${legacy}`);
        console.log(`      └─ preostalo za migraciju: ${Math.max(0, legacy - h264)}`);
        console.log();
    })();
}
