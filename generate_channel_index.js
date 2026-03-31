#!/usr/bin/env node

/**
 * generate_channel_index.js
 *
 * Generira statične JSON index datoteke za sve kanale i njihove videe.
 * Namijenjeno za master-detail pattern u Flutter appu — offline listing.
 *
 * Output (storage/meta/):
 *   channels/index.json           — popis svih kanala s metapodacima
 *   channels/{channelId}.json     — detalji kanala sa svim videima
 *
 * Svaki video sadrži podatke za sortiranje:
 *   datum, naslov, trajanje, pregledi, svidanja, magisterium score
 *
 * Podaci se čitaju iz pipeline outputa (po prioritetu):
 *   1. {videoBase}.info.json          — YouTube metapodaci (naslov, datum, trajanje, pregledi)
 *   2. {videoBase}.wav.canary.summary.json  — AI sažetak (hr naslov, abstract, teme, gosti)
 *   3. {videoBase}.*article.magisterium.json — teološki score (uzima se najnoviji)
 *
 * Upload na R2 CDN:
 *   node upload_to_r2.js --meta-dir storage/meta
 *   ili kao dio run_pipeline.sh:
 *   node generate_channel_index.js && node upload_to_r2.js --meta-dir storage/meta
 *
 * Usage:
 *   node generate_channel_index.js
 *   node generate_channel_index.js --input-dir storage/output
 *   node generate_channel_index.js --output-dir storage/meta
 *   node generate_channel_index.js --channel domovina_tv
 *   node generate_channel_index.js --dry-run
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

// --- CLI args (Pattern B) ---
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const INPUT_DIR      = getArg('--input-dir')  || path.join(__dirname, 'storage', 'output');
const OUTPUT_DIR     = getArg('--output-dir') || path.join(__dirname, 'storage', 'meta');
const CHANNEL_FILTER = getArg('--channel');
const DRY_RUN        = args.includes('--dry-run');

// Učitaj .env za R2_PUBLIC_URL
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
}
const CDN_BASE = (process.env.R2_PUBLIC_URL || 'https://cdn.domovina.ai').replace(/\/$/, '');
const PODCASTS_DIR = getArg('--podcasts-dir') || path.join(__dirname, 'automatic', 'podcasts');

// --- Helpers ---

function extractVideoId(filename) {
    const m = filename.match(/_yt_([A-Za-z0-9_-]{10,12})(?:[._]|$)/);
    return m ? m[1] : null;
}

// Pretvori upload_date (YYYYMMDD) u ISO date string (YYYY-MM-DD)
function parseDate(uploadDate) {
    if (!uploadDate || uploadDate.length !== 8) return null;
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
}

// Pretvori sekunde u "HH:MM:SS" ili "MM:SS"
function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return null;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

// Pronađi najnoviji fajl koji matchira suffix regex u listi fajlova
function findLatest(files, suffixRegex) {
    const matches = files.filter(f => suffixRegex.test(f));
    if (matches.length === 0) return null;
    // Lexikografski sort (datum je u imenu) — zadnji je najnoviji
    matches.sort();
    return matches[matches.length - 1];
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

// Preuzima datoteku s URL-a na disk. Podržava redirecte.
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const proto = url.startsWith('https') ? https : http;
        proto.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(true); });
            file.on('error', reject);
        }).on('error', reject);
    });
}

// Čita yt-dlp kanal metapodatke iz automatic/podcasts/{name}-channel.json.
// Mapira channelId (underscores) na podcast list name (hyphens).
function loadChannelMeta(channelId) {
    const listName = channelId.replace(/_/g, '-');
    const metaPath = path.join(PODCASTS_DIR, `${listName}-channel.json`);
    return readJson(metaPath);
}

// Normalizira naziv kanala iz uploader stringa (title case, cleanup)
function channelDisplayName(uploaderId, uploader) {
    if (uploader && uploader.trim()) return uploader.trim();
    // Fallback: pretvori "domovina_tv" → "Domovina TV"
    return uploaderId
        .split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

// --- Skupi sve videe za jedan kanal ---

function collectChannelVideos(channelId) {
    const channelPath = path.join(INPUT_DIR, channelId);
    let files;
    try {
        files = fs.readdirSync(channelPath).filter(f => !f.startsWith('._'));
    } catch (e) {
        console.error(`  ❌ Ne mogu čitati ${channelPath}: ${e.message}`);
        return [];
    }

    // Grupiraj fajlove po videoBase (sve što dijeli isti _yt_VIDEOID prefiks)
    const videoMap = new Map(); // videoId → { videoBase, files: [] }

    for (const file of files) {
        const videoId = extractVideoId(file);
        if (!videoId) continue;

        if (!videoMap.has(videoId)) {
            // videoBase je sve do prve točke u imenu
            const dotIdx = file.indexOf('.');
            const videoBase = dotIdx !== -1 ? file.slice(0, dotIdx) : file;
            videoMap.set(videoId, { videoBase, videoId, files: [] });
        }
        videoMap.get(videoId).files.push(file);
    }

    const videos = [];
    let channelName = null;
    let channelUrl  = null;

    for (const { videoId, videoBase, files: videoFiles } of videoMap.values()) {
        // ── 1. info.json ──────────────────────────────────────────
        const infoFile = videoFiles.find(f => f === `${videoBase}.info.json`);
        const info     = infoFile ? readJson(path.join(channelPath, infoFile)) : null;

        if (!info) continue; // Bez info.json nema smisla uključiti video

        // Izvuci channel metapodatke (jednom po kanalu)
        if (!channelName && info.uploader) {
            channelName = info.uploader.trim();
            channelUrl  = info.channel_url || null;
        }

        const title      = info.title || videoBase;
        const uploadDate = parseDate(info.upload_date);
        const duration   = info.duration || 0;
        const views      = info.view_count    ?? null;
        const likes      = info.like_count    ?? null;

        // ── 2. summary.json ───────────────────────────────────────
        const summaryFile = videoFiles.find(f => f === `${videoBase}.wav.canary.summary.json`);
        const summaryData = summaryFile ? readJson(path.join(channelPath, summaryFile)) : null;
        const summary     = summaryData?.summary || null;

        const titleHr   = summary?.title_hr   || null;
        const abstract   = summary?.abstract_hr || null;
        const topics     = Array.isArray(summary?.key_topics) ? summary.key_topics : [];
        const speakers   = Array.isArray(summary?.speakers)
            ? summary.speakers.filter(s => s && s !== 'NEPOZNAT')
            : [];

        // ── 3. Magisterium score (najnoviji fajl) ─────────────────
        // Uzimamo i batch i single — prednost dajemo single (non-batch) ako postoji
        const magisteriumFile = findLatest(videoFiles, /\.article\.magisterium\.json$/)
            || findLatest(videoFiles, /\.article\.magisterium_batch\.json$/);
        const magisteriumData = magisteriumFile
            ? readJson(path.join(channelPath, magisteriumFile))
            : null;
        const magisteriumScore = magisteriumData?.overall_score ?? null;

        // ── 4. Pipeline status flags ──────────────────────────────
        const hasSrt        = videoFiles.some(f => f.endsWith('.wav.srt') || f.endsWith('.canary.srt'));
        const hasDiarized   = videoFiles.some(f => f.endsWith('.canary.diarized.srt'));
        const hasSummary    = !!summaryFile;
        const hasArticle    = videoFiles.some(f =>
            f.endsWith('.article.json') && !f.endsWith('.magisterium.json') && !f.endsWith('.magisterium_batch.json'));
        const hasMagisterium = !!magisteriumFile;

        videos.push({
            id:               videoId,
            title,
            title_hr:         titleHr,
            date:             uploadDate,
            duration_seconds: duration,
            duration_display: formatDuration(duration),
            views,
            likes,
            thumbnail:        `${CDN_BASE}/images/${videoId}/thumbnail.png`,
            youtube_url:      info.webpage_url || `https://www.youtube.com/watch?v=${videoId}`,
            abstract,
            topics,
            speakers,
            magisterium_score: magisteriumScore,
            pipeline: {
                has_transcript:  hasSrt || hasDiarized,
                has_diarized:    hasDiarized,
                has_summary:     hasSummary,
                has_article:     hasArticle,
                has_magisterium: hasMagisterium,
            },
        });
    }

    // Sortiraj videe kronološki (najnoviji prvi) — ovo je defaultni redosljed u fajlu
    videos.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    return { videos, channelName, channelUrl };
}

// --- Main ---

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   📺  CHANNEL INDEX GENERATOR                    ║');
    console.log('╚══════════════════════════════════════════════════╝');
    if (DRY_RUN) console.log('   ⚠️  DRY RUN — nema pisanja na disk');
    console.log(`   Input:  ${INPUT_DIR}`);
    console.log(`   Output: ${OUTPUT_DIR}`);
    console.log(`   CDN:    ${CDN_BASE}`);
    if (CHANNEL_FILTER) console.log(`   Filtar: ${CHANNEL_FILTER}`);
    console.log('');

    if (!fs.existsSync(INPUT_DIR)) {
        console.error(`❌ Input direktorij ne postoji: ${INPUT_DIR}`);
        process.exit(1);
    }

    // Kreiraj output direktorij
    if (!DRY_RUN) {
        fs.mkdirSync(path.join(OUTPUT_DIR, 'channels', 'data'), { recursive: true });
    }

    // Pronađi sve kanale
    const channelIds = fs.readdirSync(INPUT_DIR).filter(f => {
        if (CHANNEL_FILTER && f !== CHANNEL_FILTER) return false;
        if (f.startsWith('.') || f.startsWith('_')) return false;
        try { return fs.statSync(path.join(INPUT_DIR, f)).isDirectory(); }
        catch { return false; }
    }).sort();

    console.log(`  Kanali pronađeni: ${channelIds.length}\n`);

    const channelIndex = []; // za channels/index.json
    const avatarDownloads = []; // {url, dest} — skupljaju se u petlji, izvršavaju paralelno

    for (const channelId of channelIds) {
        process.stdout.write(`  📁 ${channelId}... `);

        const { videos, channelName, channelUrl } = collectChannelVideos(channelId);

        if (videos.length === 0) {
            console.log('0 videa, preskačem');
            continue;
        }

        const displayName = channelDisplayName(channelId, channelName);
        const latestVideo = videos[0]; // vec sortirani kronoloski
        const totalDuration = videos.reduce((sum, v) => sum + (v.duration_seconds || 0), 0);
        const avgMagisterium = (() => {
            const scored = videos.filter(v => v.magisterium_score !== null);
            if (scored.length === 0) return null;
            return Math.round(scored.reduce((sum, v) => sum + v.magisterium_score, 0) / scored.length);
        })();

        // ── yt-dlp kanal metapodaci (avatar, opis, follower count) ─
        const channelMeta     = loadChannelMeta(channelId);
        const followerCount   = channelMeta?.channel_follower_count ?? null;
        const channelDesc     = channelMeta?.description?.trim() || null;
        const channelTags     = Array.isArray(channelMeta?.tags) ? channelMeta.tags : [];

        // Avatar: avatar_uncropped je UVIJEK square, thumbnails[0] može biti cover/banner (širi)
        const thumbs        = channelMeta?.thumbnails || [];
        const coverThumb    = thumbs.find(t => t.id === '0') || thumbs[0] || null;
        const squareThumb   = thumbs.find(t => t.id === 'avatar_uncropped') || coverThumb || null;

        // Playlist URL za kanale koji su zapravo playliste unutar većeg kanala
        const isPlaylist    = channelMeta?.webpage_url?.includes('playlist?list=');
        const playlistUrl   = isPlaylist ? channelMeta.webpage_url : null;

        // Dimenzije avatara iz yt-dlp metapodataka
        const squareDims = squareThumb?.width && squareThumb?.height
            ? { width: squareThumb.width, height: squareThumb.height } : null;
        const coverDims  = coverThumb?.width && coverThumb?.height
            ? { width: coverThumb.width, height: coverThumb.height } : null;

        // Download avatara na disk (paralelno se skupljaju, izvršavaju se poslije)
        const imgDir = path.join(OUTPUT_DIR, 'channels', 'images', channelId);
        let avatarSquareCdn = null;
        let avatarCoverCdn  = null;

        if (squareThumb?.url) {
            avatarSquareCdn = `${CDN_BASE}/channels/images/${channelId}/avatar_square.jpg`;
            if (!DRY_RUN) {
                avatarDownloads.push({ url: squareThumb.url, dest: path.join(imgDir, 'avatar_square.jpg') });
            }
        }
        if (coverThumb?.url) {
            avatarCoverCdn = `${CDN_BASE}/channels/images/${channelId}/avatar_cover.jpg`;
            if (!DRY_RUN) {
                avatarDownloads.push({ url: coverThumb.url, dest: path.join(imgDir, 'avatar_cover.jpg') });
            }
        }

        // ── channels/{channelId}.json ─────────────────────────────
        const channelDetail = {
            version:          '1.0',
            generated_at:     new Date().toISOString(),
            id:               channelId,
            name:             displayName,
            avatar_square:    avatarSquareCdn,
            avatar_square_dimensions: squareDims,
            avatar_cover:     avatarCoverCdn,
            avatar_cover_dimensions:  coverDims,
            youtube_channel_url: channelUrl,
            youtube_playlist_url: playlistUrl,
            description:      channelDesc,
            tags:             channelTags,
            follower_count:   followerCount,
            video_count:      videos.length,
            total_duration_seconds: totalDuration,
            avg_magisterium_score:  avgMagisterium,
            latest_video_date: latestVideo.date,
            videos,
        };

        const detailPath = path.join(OUTPUT_DIR, 'channels', 'data', `${channelId}.json`);
        if (!DRY_RUN) {
            fs.writeFileSync(detailPath, JSON.stringify(channelDetail, null, 2), 'utf-8');
        }

        // ── Dodaj u index ─────────────────────────────────────────
        channelIndex.push({
            id:               channelId,
            name:             displayName,
            avatar_square:    avatarSquareCdn,
            avatar_square_dimensions: squareDims,
            avatar_cover:     avatarCoverCdn,
            avatar_cover_dimensions:  coverDims,
            youtube_channel_url: channelUrl,
            youtube_playlist_url: playlistUrl,
            follower_count:   followerCount,
            video_count:      videos.length,
            total_duration_seconds: totalDuration,
            avg_magisterium_score:  avgMagisterium,
            latest_video: latestVideo ? {
                id:    latestVideo.id,
                date:  latestVideo.date,
                title: latestVideo.title_hr || latestVideo.title,
            } : null,
        });

        const articled   = videos.filter(v => v.pipeline.has_article).length;
        const magScored  = videos.filter(v => v.pipeline.has_magisterium).length;
        console.log(`${videos.length} videa | ${articled} članaka | ${magScored} magisterium | avg score: ${avgMagisterium ?? 'N/A'}`);

        if (!DRY_RUN) {
            console.log(`     → ${detailPath}`);
        }
    }

    // ── Preuzimanje avatara (paralelno) ──────────────────────────
    if (avatarDownloads.length > 0) {
        console.log(`\n  ⬇️  Preuzimam ${avatarDownloads.length} avatara...`);
        let ok = 0;
        let fail = 0;
        await Promise.all(avatarDownloads.map(t =>
            downloadFile(t.url, t.dest)
                .then(() => { ok++; })
                .catch(() => { fail++; })
        ));
        console.log(`  ✅ Avatari: ${ok} preuzeto${fail > 0 ? `, ${fail} neuspjelo` : ''}\n`);
    }

    // ── channels/index.json ───────────────────────────────────────
    // Ako je aktivan --channel filtar, mergea s postojećim indexom da ne
    // prepiše ostale kanale koji su već generirani.
    const indexPath = path.join(OUTPUT_DIR, 'channels', 'data', 'index.json');
    let finalChannels = channelIndex;
    if (CHANNEL_FILTER) {
        const existing = readJson(indexPath);
        if (existing?.channels) {
            const others = existing.channels.filter(c => c.id !== CHANNEL_FILTER);
            finalChannels = [...others, ...channelIndex].sort((a, b) => a.id.localeCompare(b.id));
        }
    }

    const indexData = {
        version:       '1.0',
        generated_at:  new Date().toISOString(),
        channel_count: finalChannels.length,
        channels:      finalChannels,
    };

    if (!DRY_RUN) {
        fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2), 'utf-8');
        console.log(`\n  ✅ Index: ${indexPath} (${finalChannels.length} kanala)`);
    } else {
        console.log(`\n  ✅ [DRY RUN] channels/index.json: ${finalChannels.length} kanala`);
    }

    const totalVideos = finalChannels.reduce((s, c) => s + c.video_count, 0);
    console.log(`     Ukupno: ${totalVideos} videa kroz ${finalChannels.length} kanala`);
    console.log(`\n  Upload: node upload_to_r2.js --meta-dir ${OUTPUT_DIR}\n`);
}

main().catch(e => {
    console.error('❌ Fatalna greška:', e.message);
    process.exit(1);
});
