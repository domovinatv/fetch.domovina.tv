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

if (!fs.existsSync(OUTPUT_DIR)) {
    console.error(`❌ Output direktorij ne postoji: ${OUTPUT_DIR}`);
    console.error(`   Je li disk mountan? Ili koristi: node count_progress.js --input-dir <putanja>`);
    process.exit(1);
}

// --- Helpers ---

function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

// --- Scan ---

console.log("Skeniram direktorije...");

const stats = {};
const outlinesByModel = {};
const articlesByModel = {};
const outlineVideosByModel = {};
const articleVideosByModel = {};
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
];

function classify(filename) {
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

for (const channel of channels) {
    const channelPath = path.join(OUTPUT_DIR, channel);

    try {
        const files = fs.readdirSync(channelPath);
        const videosWithOutline = new Set();
        const videosWithArticle = new Set();
        const videosWithMagisterium = new Set();

        for (const file of files) {
            if (file.startsWith('._')) continue;

            const key = classify(file);
            if (key) {
                stats[key] = (stats[key] || 0) + 1;

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
            }
        }

        totalOutlineVideos += videosWithOutline.size;
        totalArticleVideos += videosWithArticle.size;
        totalMagisteriumVideos += videosWithMagisterium.size;
    } catch (e) {
        console.error(`Greška pri čitanju: ${channelPath} - ${e.message}`);
    }
}

// --- Output ---

const g = (k) => stats[k] || 0;
const total = g('mp3');

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
    const extra = opts.extra ? ` (${opts.extra} files)` : '';
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

console.log(`\n  Pipeline progress (${total} preuzetih videa)\n`);

console.log('    -- Download & konverzija --');
line('Preuzeto (.mp3)', g('mp3'), total);
line('WAV konverzija (.wav)', g('wav'), total);
line('Metadata (.info.json)', g('infoJson'), total);
line('Opisi (.description)', g('description'), total);

console.log('\n    -- Whisper (OpenAI) --');
line('Whisper prompt (.txt)', g('prompts'), total);
line('Whisper transkripcija (.srt)', g('srt'), total);
line('Whisper diarizacija', g('diarized'), total);

console.log('\n    -- Canary (NVIDIA) --');
line('Canary transkripcija', g('canarySrt'), total);
line('Canary CSV', g('canaryCsv'), total);
line('Canary diarizacija', g('canaryDiarized'), total);

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
