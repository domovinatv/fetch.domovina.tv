#!/usr/bin/env node

/**
 * upload_og_share_fast.js
 *
 * Fast-path uploader za og-share.jpg backfill. NE koristiti za općenit upload —
 * postoji `upload_to_r2.js` koji radi cijeli pipeline output. Ova skripta postoji
 * isključivo zato što upload_to_r2.js trati MD5-hashanje svih 73k postojećih
 * datoteka (uključujući 200MB MP4) za svaki rerun, što čini single-suffix
 * backfill 100× sporijim nego što treba.
 *
 * Strategija:
 *   1. Glob storage/output/<channel>/*.og-share.jpg
 *   2. Extract videoId iz _yt_XXX patterna → R2 key images/{videoId}/og-share.jpg
 *   3. HEAD na R2 (paralelno) → odbaci datoteke koje već postoje
 *   4. PUT preostale (32 paralelno)
 *
 * Bez MD5 cache-a — za novi backfill svi su NOVO, etag check je dovoljan.
 *
 * Primjer:
 *   node upload_og_share_fast.js --input-dir storage/output
 *   node upload_og_share_fast.js --input-dir storage/output --dry-run
 *   node upload_og_share_fast.js --input-dir storage/output --force      # reupload sve
 */

const fs = require("fs");
const path = require("path");

// ─── .env ────────────────────────────────────────────────────────
function loadEnvFile() {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
    }
}
loadEnvFile();

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";

const HEAD_CONCURRENCY = 32;
const PUT_CONCURRENCY  = 32;
const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";

function getArg(name) {
    const idx = process.argv.indexOf(name);
    return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}
function hasFlag(name) { return process.argv.includes(name); }
function ts() { return new Date().toISOString().replace("T", " ").slice(0, 19); }
function log(emoji, msg) { console.log(`   ${emoji} [${ts()}] ${msg}`); }
function humanSize(b) { return b < 1024 ? `${b} B` : b < 1048576 ? `${(b/1024).toFixed(1)} KB` : `${(b/1048576).toFixed(1)} MB`; }

async function runConcurrent(tasks, concurrency) {
    const results = new Array(tasks.length);
    let i = 0;
    async function worker() {
        while (true) {
            const idx = i++;
            if (idx >= tasks.length) return;
            try { results[idx] = await tasks[idx](); } catch (e) { results[idx] = { error: e }; }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    return results;
}

function discoverOgShares(inputDir) {
    const files = [];
    let channels;
    try { channels = fs.readdirSync(inputDir, { withFileTypes: true }); } catch { return files; }
    for (const ch of channels) {
        if (!ch.isDirectory() && !ch.isSymbolicLink()) continue;
        if (ch.name.startsWith(".") || ch.name.startsWith("_")) continue;
        const chDir = path.join(inputDir, ch.name);
        let entries;
        try { entries = fs.readdirSync(chDir); } catch { continue; }
        for (const fn of entries) {
            if (fn.startsWith("._")) continue;
            if (!fn.endsWith(".og-share.jpg")) continue;
            const m = fn.match(/_yt_([a-zA-Z0-9_-]{11})/);
            if (!m) continue;
            const localPath = path.join(chDir, fn);
            let stat;
            try { stat = fs.statSync(localPath); } catch { continue; }
            if (!stat.isFile()) continue;
            files.push({
                localPath,
                videoId: m[1],
                r2Key: `images/${m[1]}/og-share.jpg`,
                size: stat.size,
            });
        }
    }
    return files;
}

async function main() {
    const inputDir = getArg("--input-dir");
    const dryRun = hasFlag("--dry-run");
    const force = hasFlag("--force");

    console.log("");
    log("🚀", `Fast-path og-share uploader — bucket: ${R2_BUCKET_NAME}, parallelism: HEAD=${HEAD_CONCURRENCY} PUT=${PUT_CONCURRENCY}`);
    if (!inputDir) { console.error("❌ --input-dir je obavezan"); process.exit(1); }
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
        console.error("❌ Nedostaju R2_* env varijable (vidi .env)");
        process.exit(1);
    }

    log("🔍", `Skeniranje ${inputDir} za *.og-share.jpg ...`);
    const files = discoverOgShares(inputDir);
    log("📊", `Pronađeno: ${files.length} og-share.jpg datoteka`);
    if (files.length === 0) { console.log(""); return; }

    const { S3Client, HeadObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
    const client = new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });

    // Phase 1: HEAD check (skip force)
    let toUpload;
    if (force) {
        toUpload = files;
        log("♻️ ", `--force aktivan, preskačem HEAD provjeru (svih ${files.length} ide na upload)`);
    } else {
        log("🔍", `HEAD provjera (${HEAD_CONCURRENCY} paralelno)...`);
        let checked = 0;
        const headTasks = files.map((f) => async () => {
            try {
                await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: f.r2Key }));
                checked++;
                if (checked % 200 === 0) process.stdout.write(`\r   ✓ Provjereno: ${checked}/${files.length}   `);
                return { ...f, exists: true };
            } catch (err) {
                checked++;
                if (checked % 200 === 0) process.stdout.write(`\r   ✓ Provjereno: ${checked}/${files.length}   `);
                if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
                    return { ...f, exists: false };
                }
                throw err;
            }
        });
        const headResults = await runConcurrent(headTasks, HEAD_CONCURRENCY);
        process.stdout.write("\n");
        toUpload = headResults.filter((r) => !r.error && !r.exists);
        const skipped = headResults.filter((r) => r.exists).length;
        const errors = headResults.filter((r) => r.error).length;
        log("📊", `HEAD: ${toUpload.length} novih, ${skipped} već postoji, ${errors} grešaka`);
    }

    if (toUpload.length === 0) { console.log(""); log("✅", "Sve već uploadano."); console.log(""); return; }

    if (dryRun) {
        log("🧪", `[DRY] Bi uploadao ${toUpload.length} datoteka, ukupno ${humanSize(toUpload.reduce((s,f) => s+f.size, 0))}`);
        return;
    }

    // Phase 2: PUT
    const totalBytes = toUpload.reduce((s, f) => s + f.size, 0);
    log("⬆️ ", `Upload ${toUpload.length} datoteka, ${humanSize(totalBytes)} ukupno, ${PUT_CONCURRENCY} paralelno...`);
    const start = Date.now();
    let uploaded = 0, failed = 0, bytesUp = 0;

    const putTasks = toUpload.map((f) => async () => {
        try {
            const body = fs.readFileSync(f.localPath);
            await client.send(new PutObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: f.r2Key,
                Body: body,
                ContentType: "image/jpeg",
                ContentLength: f.size,
                CacheControl: CACHE_CONTROL_IMMUTABLE,
            }));
            uploaded++;
            bytesUp += f.size;
            if (uploaded % 50 === 0 || uploaded <= 5) {
                const elapsed = (Date.now() - start) / 1000;
                const rate = uploaded / elapsed;
                const eta = (toUpload.length - uploaded) / rate;
                process.stdout.write(`\r   ⬆️  ${uploaded}/${toUpload.length} (${humanSize(bytesUp)}, ${rate.toFixed(1)}/s, ETA ${Math.ceil(eta)}s)   `);
            }
        } catch (err) {
            failed++;
            console.log(`\n   ❌ ${f.r2Key}: ${err.message}`);
        }
    });
    await runConcurrent(putTasks, PUT_CONCURRENCY);
    process.stdout.write("\n");

    const elapsed = (Date.now() - start) / 1000;
    console.log("");
    log("✅", `Uploadano: ${uploaded} | Greške: ${failed} | ${humanSize(bytesUp)} u ${elapsed.toFixed(1)}s (${(bytesUp/elapsed/1024/1024).toFixed(2)} MB/s, ${(uploaded/elapsed).toFixed(1)} files/s)`);
    console.log("");
}

main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
