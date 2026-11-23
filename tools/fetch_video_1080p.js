#!/usr/bin/env node
/**
 * Jedno video skidanje po epizodi (23.11.2026., prekidač VIDEO_SINGLE_1080P=1).
 *
 * Bez prekidača epizoda ima DVA video pristupa YouTubeu: fetch.js (MP3 + 360p) i
 * screenshot_youtube.js (`--get-url` 1080p streama + ~16 seekova). S prekidačem:
 *   KORAK 1  fetch.js --audio-only            → samo MP3 (+ info/description/thumbnail)
 *   ovaj alat (prije KORAKA 10):
 *     1. skine 1080p (video + najbolji audio) na VANJSKI SSD (VIDEO_1080P_DIR)
 *     2. lokalno izvede `{kanal}/{base}.mkv` 360p (H.264 + izvorni audio) — isti ulaz koji
 *        KORAK 12.5 (video_h264.mp4) i screenshot rezerva čitaju i danas
 *   KORAK 10 screenshot_youtube.js čita kadrove iz lokalnog 1080p (SCREENSHOT_LOCAL_VIDEO_DIR),
 *            bez ijednog YouTube poziva
 *   --cleanup nakon KORAKA 10 obriše 1080p (360p .mkv ostaje, kao i danas).
 *
 * Usage:
 *   node tools/fetch_video_1080p.js --video-id ID [--channel _unlisted] [--proxy URL]
 *   node tools/fetch_video_1080p.js --video-id ID --cleanup
 *   node tools/fetch_video_1080p.js --video-id ID --keep --stats   # mjerenje, ne briše
 *
 * Non-fatal po dizajnu: izlaz 0 i kad skidanje padne (epizoda tada nema lokalni 1080p, pa
 * KORAK 10 ide starim putem preko streama; .mkv se pokuša skinuti starim 360p formatom).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const VIDEO_ID = getArg('--video-id');
const CHANNEL = getArg('--channel') || '_unlisted';
const PROXY = getArg('--proxy');
const CLEANUP = args.includes('--cleanup');
const KEEP = args.includes('--keep');
const STATS = args.includes('--stats');

const WORK_DIR = process.env.VIDEO_1080P_DIR || '/Volumes/DOMOVINA1TB/fetch_domovina_tv_work/video1080';
const MIN_FREE_GB = parseFloat(process.env.VIDEO_1080P_MIN_FREE_GB || '30');
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// Isti izbor kao screenshot_youtube.js getStreamUrl (avc1 = hardversko dekodiranje), ali uz audio.
const FORMAT = 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]';
// Stari fetch.js format — rezerva kad 1080p ne uspije, da epizoda ipak dobije .mkv za 12.5.
const FORMAT_360 = 'bestvideo[height<=360]+bestaudio/best[height<=360]';

function log(m) { console.log(`   ${m}`); }
function mb(n) { return (n / 1e6).toFixed(0) + ' MB'; }

function channelDir() {
    return path.join(REPO, 'storage/output', CHANNEL);
}
function baseFor(id) {
    let files = [];
    try { files = fs.readdirSync(channelDir()); } catch { return null; }
    const info = files.find(f => f.includes('_yt_' + id) && f.endsWith('.info.json') && !f.startsWith('._'));
    return info ? info.replace(/\.info\.json$/, '') : null;
}
function local1080(base) {
    try {
        const f = fs.readdirSync(WORK_DIR).find(x => x.startsWith(base + '.1080p.') && !x.endsWith('.part'));
        return f ? path.join(WORK_DIR, f) : null;
    } catch { return null; }
}
function freeGb(dir) {
    const r = spawnSync('df', ['-k', dir], { encoding: 'utf8' });
    const cols = (r.stdout || '').trim().split('\n').pop().split(/\s+/);
    return parseInt(cols[3], 10) / 1024 / 1024;
}
function cookieArgs() {
    const ck = path.join(REPO, 'cookies.txt');
    return fs.existsSync(ck) ? ['--cookies', ck] : ['--cookies-from-browser', 'brave'];
}
function ytdlp(format, outTemplate, extra = []) {
    const a = ['-f', format, '--merge-output-format', 'mkv', '--concurrent-fragments', '8',
        '--user-agent', USER_AGENT, '--remote-components', 'ejs:github', '--no-check-certificate',
        '--no-write-subs', '--no-write-info-json', '--no-playlist',
        ...cookieArgs(), ...extra, '-o', outTemplate, `https://www.youtube.com/watch?v=${VIDEO_ID}`];
    if (PROXY) a.unshift('--proxy', PROXY);
    const t = Date.now();
    const r = spawnSync('yt-dlp', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { ok: r.status === 0, sec: (Date.now() - t) / 1000, err: (r.stderr || '') };
}
function antiBot(err) {
    if (!/confirm you[’']re not a bot|confirm you are not a bot/i.test(err)) return false;
    // Isti marker kao fetch.js/screenshot_youtube.js → poller pauzira nove jobove.
    try {
        const dir = path.join(require('os').homedir(), '.cache', 'domovina-pipeline');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'youtube_antibot.json'),
            JSON.stringify({ at: new Date().toISOString(), source: 'fetch_video_1080p.js', video_id: VIDEO_ID }));
    } catch { /* marker nije kritičan */ }
    return true;
}
function probe(p) {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
        'stream=codec_name,height,width', '-show_entries', 'format=duration,size', '-of', 'json', p], { encoding: 'utf8' });
    try { const j = JSON.parse(r.stdout); return { ...j.streams[0], ...j.format }; } catch { return {}; }
}

function main() {
    if (!VIDEO_ID) { console.error('❌ --video-id je obavezan'); process.exit(2); }
    if (!WORK_DIR.startsWith('/Volumes/')) {
        console.error(`❌ VIDEO_1080P_DIR mora biti na vanjskom disku (/Volumes/…), ne ${WORK_DIR}`);
        process.exit(2);
    }
    const base = baseFor(VIDEO_ID);
    if (!base) { log(`⚠️  ${CHANNEL}: nema .info.json za ${VIDEO_ID} — preskačem (KORAK 1 nije uspio?)`); return; }

    if (CLEANUP) {
        const p = local1080(base);
        if (p) { fs.rmSync(p, { force: true }); log(`🧹 obrisan 1080p: ${path.basename(p)}`); }
        return;
    }

    const mkv = path.join(channelDir(), base + '.mkv');
    let src = local1080(base);
    const t0 = Date.now();
    if (!src) {
        try { fs.mkdirSync(WORK_DIR, { recursive: true }); } catch (e) {
            log(`⚠️  ${WORK_DIR} nedostupan (${e.message}) — bez 1080p, KORAK 10 ide preko streama`);
        }
        const free = fs.existsSync(WORK_DIR) ? freeGb(WORK_DIR) : 0;
        if (free < MIN_FREE_GB) {
            log(`⚠️  na ${WORK_DIR} slobodno ${free.toFixed(0)} GB < ${MIN_FREE_GB} GB — bez 1080p`);
        } else {
            log(`⬇️  1080p → ${WORK_DIR} (${free.toFixed(0)} GB slobodno)`);
            const r = ytdlp(FORMAT, path.join(WORK_DIR, base + '.1080p.%(ext)s'));
            src = local1080(base);
            if (r.ok && src) {
                const st = fs.statSync(src).size;
                log(`✅ 1080p skinut: ${mb(st)} za ${r.sec.toFixed(0)} s (${(st / 1e6 / r.sec).toFixed(1)} MB/s)`);
                if (STATS) console.log(JSON.stringify({ stage: 'download_1080p', bytes: st, sec: r.sec, ...probe(src) }));
            } else {
                const bot = antiBot(r.err);
                log(`❌ 1080p nije uspio${bot ? ' (YouTube anti-bot)' : ''}: ` +
                    `${(r.err.split('\n').find(l => /ERROR/.test(l)) || '').slice(0, 200)}`);
                src = null;
                if (bot) return;            // ne pokušavaj odmah ponovno — produljuje blok
            }
        }
    } else {
        log(`📦 1080p već na disku: ${path.basename(src)}`);
    }

    // 360p .mkv za KORAK 12.5 / screenshot rezervu — isti naziv i isto mjesto kao danas.
    if (!fs.existsSync(mkv)) {
        if (src) {
            const t = Date.now();
            const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
                '-vf', 'scale=-2:360', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
                '-c:a', 'copy', mkv + '.tmp.mkv'], { encoding: 'utf8' });
            if (r.status === 0) {
                fs.renameSync(mkv + '.tmp.mkv', mkv);
                const sec = (Date.now() - t) / 1000;
                log(`✅ 360p .mkv izveden lokalno: ${mb(fs.statSync(mkv).size)} za ${sec.toFixed(0)} s`);
                if (STATS) console.log(JSON.stringify({ stage: 'derive_360p', bytes: fs.statSync(mkv).size, sec, ...probe(mkv) }));
            } else {
                fs.rmSync(mkv + '.tmp.mkv', { force: true });
                log(`❌ 360p iz 1080p nije uspio: ${(r.stderr || '').slice(0, 200)}`);
            }
        }
        if (!fs.existsSync(mkv)) {
            log('↩️  rezerva: stari 360p format s YouTubea');
            const r = ytdlp(FORMAT_360, path.join(channelDir(), base + '.%(ext)s'), ['--prefer-free-formats']);
            if (!r.ok) {
                antiBot(r.err);
                log(`❌ ni 360p — epizoda zasad bez videa (KORAK 12.5 je preskoči)`);
            }
        }
    }
    if (STATS) log(`⏱️  ukupno ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    if (KEEP) log('📌 --keep: 1080p ostaje na disku');
}

main();
