#!/usr/bin/env node
/**
 * generate_webp_screenshots.js — WebP 960 px uz svaki screenshot sekcije.
 *
 * Zašto: screenshotovi su PNG 1920×1080 (~1,3 MB svaki), a aplikacija ih crta na
 * najviše 480×270. Epizoda `PPXbSP14H4Y` ima 26 screenshotova = 33,3 MB, koje
 * na sporoj vezi guše video. Isti kadar kao WebP 960 px q80 je ~19 KB (66× manje;
 * 960 = 480 px prikaza × 2 za retinu).
 *
 * PNG ostaje NETAKNUT — to su trajni full-HD originali. WebP je samo varijanta za
 * prikaz, kao `thumb-*.webp` uz `thumbnail.png` (generate_webp_thumbs.js).
 *
 * Opseg: SAMO screenshotovi nastali od [SINCE] (10. 10. 2026.). Stari katalog se
 * namjerno ne backfilla. Granica je mtime lokalnog PNG-a, pa ponovno snimljeni
 * screenshotovi stare epizode također dobiju WebP.
 *
 * Izlaz na R2 (po epizodi):
 *   images/{id}/screenshots/{HH-MM-SS}-960.webp   image/webp, immutable
 *   data/{id}/screenshots_webp.json               oznaka, max-age=60
 *
 * Oznaka ide ZADNJA i u `data/{id}/`, pa je `episode.json` (KORAK 12.7) navodi u
 * `files` — klijent po njoj zna da WebP postoje, bez ijednog probe-a. Za stare
 * epizode oznake nema i klijent ostaje na PNG-u. Pojedini kadar bez WebP-a klijent
 * pokrije padom na PNG.
 *
 * Idempotentno: epizoda se preskače kad R2 oznaka već nabraja sve lokalne kadrove.
 * WebP se radi u temp direktoriju; lokalni `_screenshots/` se ne dira.
 *
 *   node generate_webp_screenshots.js --input-dir storage/output [--channel X]
 *   node generate_webp_screenshots.js --video-id ID1,ID2 [--dry-run] [--force]
 *
 * Vidi domovina.ai docs/2026-10-11-brzi-start-videa-fmp4.md (§ Screenshotovi).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const args = process.argv.slice(2);
const getArg = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : d; };
const hasFlag = (n) => args.includes(n);

const OUTPUT_DIR = getArg("--input-dir", path.join(__dirname, "storage", "output"));
const ONLY_CHANNEL = getArg("--channel");
const ONLY_IDS = getArg("--video-id") ? new Set(getArg("--video-id").split(",").map(s => s.trim()).filter(Boolean)) : null;
const DRY_RUN = hasFlag("--dry-run");
const FORCE = hasFlag("--force");
const CONCURRENCY = parseInt(getArg("--concurrency", "4"), 10);

const SINCE = new Date("2026-10-10T00:00:00+02:00");
const WIDTH = 960;
const QUALITY = 80;
const MARKER = "screenshots_webp.json";

(function loadEnv() {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
})();
const R2_BUCKET = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";

let _s3 = null, _S3 = null;
function s3() {
    if (_s3) return _s3;
    _S3 = require("@aws-sdk/client-s3");
    _s3 = new _S3.S3Client({
        region: "auto",
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
    return _s3;
}
async function r2GetJson(key) {
    try {
        const r = await s3().send(new _S3.GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
        return JSON.parse(await r.Body.transformToString());
    } catch { return null; }
}
async function r2Put(key, body, contentType, cacheControl) {
    await s3().send(new _S3.PutObjectCommand({
        Bucket: R2_BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl,
    }));
}

function listDirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("._") && !e.name.startsWith("."))
            .map(e => e.name);
    } catch { return []; }
}

/** Epizode s barem jednim screenshotom od SINCE: {videoId, dir, frames:[{ts, png}]} */
function discover() {
    const eps = [];
    for (const ch of ONLY_CHANNEL ? [ONLY_CHANNEL] : listDirs(OUTPUT_DIR)) {
        const chDir = path.join(OUTPUT_DIR, ch);
        for (const d of listDirs(chDir)) {
            const m = d.match(/_yt_([A-Za-z0-9_-]{11})_screenshots$/);
            if (!m || (ONLY_IDS && !ONLY_IDS.has(m[1]))) continue;
            const dir = path.join(chDir, d);
            let files;
            try { files = fs.readdirSync(dir); } catch { continue; }
            const frames = [];
            for (const f of files) {
                const t = f.match(/_(\d{2}-\d{2}-\d{2})\.png$/);
                if (!t || f.startsWith("._")) continue;
                const png = path.join(dir, f);
                if (!FORCE && fs.statSync(png).mtime < SINCE) continue;
                frames.push({ ts: t[1], png });
            }
            if (frames.length) eps.push({ videoId: m[1], dir, frames: frames.sort((a, b) => a.ts.localeCompare(b.ts)) });
        }
    }
    return eps;
}

function magickWebp(src, out) {
    return new Promise((resolve, reject) => {
        const p = spawn("magick", [src, "-resize", `${WIDTH}x>`, "-strip", "-quality", String(QUALITY),
            "-define", "webp:method=6", out], { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        p.stderr.on("data", c => { err += c; });
        p.on("error", reject);
        p.on("close", c => c === 0 ? resolve() : reject(new Error(`magick exit ${c}: ${err.slice(-300)}`)));
    });
}

async function processEpisode(ep) {
    const markerKey = `data/${ep.videoId}/${MARKER}`;
    const local = ep.frames.map(f => f.ts);
    if (!FORCE && !DRY_RUN) {
        const marker = await r2GetJson(markerKey);
        if (marker && local.every(ts => (marker.timestamps || []).includes(ts))) {
            console.log(`${ep.videoId} · oznaka već pokriva ${local.length} kadrova, skip`);
            return "skip";
        }
    }
    if (DRY_RUN) { console.log(`${ep.videoId} bi napravio ${local.length} WebP-ova + ${markerKey}`); return "dry"; }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-webp-"));
    let png = 0, webp = 0;
    try {
        for (const f of ep.frames) {
            const out = path.join(tmp, `${f.ts}.webp`);
            await magickWebp(f.png, out);
            png += fs.statSync(f.png).size; webp += fs.statSync(out).size;
            await r2Put(`images/${ep.videoId}/screenshots/${f.ts}-${WIDTH}.webp`, fs.readFileSync(out),
                "image/webp", "public, max-age=31536000, immutable");
        }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

    // Oznaka ZADNJA: tek kad su svi kadrovi gore, bundle smije reći da postoje.
    await r2Put(markerKey, JSON.stringify({ version: 1, width: WIDTH, timestamps: local }),
        "application/json", "public, max-age=60, must-revalidate");
    console.log(`${ep.videoId} ✓ ${local.length} WebP · ${(png / 1048576).toFixed(1)} MB PNG → ${(webp / 1048576).toFixed(2)} MB WebP`);
    return "done";
}

(async () => {
    const eps = discover();
    console.log(`Epizoda sa screenshotovima od 10. 10. 2026.: ${eps.length}`);
    const res = [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
        while (i < eps.length) {
            const ep = eps[i++];
            try { res.push(await processEpisode(ep)); }
            catch (e) { res.push("FAIL"); console.error(`${ep.videoId} ✗ ${e.message}`); }
        }
    }));
    const by = res.reduce((a, r) => (a[r] = (a[r] || 0) + 1, a), {});
    console.log("=== SAŽETAK ===", JSON.stringify(by));
    if (by.FAIL) process.exitCode = 1;
})();
