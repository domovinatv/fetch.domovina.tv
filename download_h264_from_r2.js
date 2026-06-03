#!/usr/bin/env node
/**
 * download_h264_from_r2.js
 * ────────────────────────
 * Skida već-uploadane video_h264.mp4 s R2 natrag lokalno — za epizode koje su
 * migrirane PRIJE nego smo počeli čuvati lokalne kopije (backfill_video_h264.js
 * je tada brisao web.mp4 uz --rm-local). Cilj: kompletan lokalni set na disku
 * s mjesta (DOMOVINA2TB), isti layout kao --web-output-dir backfilla:
 *   {WEB_OUT_DIR}/{channel}/{base}.web.mp4
 *
 * Idempotentno: preskače ako lokalna kopija već postoji ili ako video_h264.mp4
 * nije na R2 (još nije migriran — backfill_video_h264.js će ga proizvesti).
 * Sigurno paralelno s backfillom: različiti videoId-evi, distinktan tmp (.r2dl.tmp).
 *
 *   node download_h264_from_r2.js                       # cijeli katalog
 *   node download_h264_from_r2.js --channel domovina_tv # jedan kanal
 *   node download_h264_from_r2.js --dry-run             # samo plan
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function getArg(name, def = null) {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : def;
}
function hasFlag(name) { return args.includes(name); }

const OUTPUT_DIR  = getArg("--input-dir", path.join(__dirname, "storage", "output"));
const WEB_OUT_DIR = getArg("--web-output-dir", "/Volumes/DOMOVINA2TB/web_mp4_h264");
const ONLY_CHANNEL = getArg("--channel");
const CONCURRENCY = parseInt(getArg("--concurrency", "4"), 10);   // mrežno-vezano → može više od transcode-a
const DRY_RUN     = hasFlag("--dry-run");

// ─── .env (ručni parser, kao upload_to_r2.js) ─────────────────────
(function loadEnv() {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
})();
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET     = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";

let _s3 = null, _S3 = null;
function s3() {
    if (_s3) return _s3;
    _S3 = require("@aws-sdk/client-s3");
    _s3 = new _S3.S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
    return _s3;
}
async function r2Head(key) {
    try { return await s3().send(new _S3.HeadObjectCommand({ Bucket: R2_BUCKET, Key: key })); }
    catch { return null; }
}
async function r2Download(key, outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tmp = outPath.replace(/\.web\.mp4$/, ".r2dl.tmp.mp4");
    const resp = await s3().send(new _S3.GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        resp.Body.on("error", reject);
        ws.on("error", reject);
        ws.on("finish", resolve);
        resp.Body.pipe(ws);
    });
    fs.renameSync(tmp, outPath);   // atomski
    return fs.statSync(outPath).size;
}

function extractVideoId(base) {
    const m = base.match(/_yt_([A-Za-z0-9_-]{11})$/);
    return m ? m[1] : null;
}
function listDirs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("._"))
        .map(e => e.name);
}
function isFragment(stem) { return /\.f\d+$/.test(stem) || stem.endsWith(".loudnorm"); }

// Mapiranje videoId → {channel, base} iz lokalnog scana (isti princip kao backfill discover()).
function discover() {
    const eps = [];
    const channels = ONLY_CHANNEL ? [ONLY_CHANNEL] : listDirs(OUTPUT_DIR);
    for (const ch of channels) {
        const chDir = path.join(OUTPUT_DIR, ch);
        let files;
        try { files = fs.readdirSync(chDir); } catch { continue; }
        const bases = new Set();
        for (const f of files) {
            if (f.startsWith("._")) continue;
            const m = f.match(/^(.*)\.(mkv|mp4)$/);
            if (!m) continue;
            if (isFragment(m[1])) continue;
            bases.add(m[1]);
        }
        for (const base of bases) {
            const vid = extractVideoId(base);
            if (!vid) continue;
            eps.push({
                channel: ch, base, videoId: vid,
                webMp4: path.join(WEB_OUT_DIR, ch, `${base}.web.mp4`),
                keyNew: `data/${vid}/video_h264.mp4`,
            });
        }
    }
    return eps;
}

async function processEpisode(ep, idx, total) {
    const tag = `[${idx + 1}/${total}] ${ep.videoId}`;
    if (fs.existsSync(ep.webMp4)) return { status: "have-local" };

    const head = await r2Head(ep.keyNew);
    if (!head) return { status: "not-on-r2" };   // još nije migriran — backfill će ga proizvesti

    if (DRY_RUN) { console.log(`${tag} bi skinuo ${ep.keyNew} → ${ep.channel}/`); return { status: "dry" }; }

    const size = await r2Download(ep.keyNew, ep.webMp4);
    console.log(`${tag} ✓ skinuto ${(size / 1048576).toFixed(0)}MB → ${ep.channel}/`);
    return { status: "downloaded" };
}

async function runPool(items, worker, n) {
    const out = []; let i = 0; const t0 = Date.now();
    const runner = async () => {
        while (i < items.length) {
            const idx = i++;
            try { out[idx] = await worker(items[idx], idx, items.length); }
            catch (e) { out[idx] = { status: "FAIL" }; console.error(`[${idx + 1}] ${items[idx].videoId} ✗ ${e.message}`); }
            if ((idx + 1) % 25 === 0) {
                const done = idx + 1, rate = done / ((Date.now() - t0) / 1000);
                const eta = Math.round((items.length - done) / Math.max(rate, 1e-6) / 60);
                console.log(`── progress ${done}/${items.length}  ~${eta} min preostalo ──`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, n) }, runner));
    return out;
}

(async () => {
    const eps = discover();
    console.log(`Pronađeno ${eps.length} epizoda${ONLY_CHANNEL ? ` (kanal ${ONLY_CHANNEL})` : ""}.`);
    const res = await runPool(eps, processEpisode, CONCURRENCY);
    const by = res.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
    console.log("\n=== SAŽETAK ===");
    for (const [k, v] of Object.entries(by)) console.log(`  ${k}: ${v}`);
})();
