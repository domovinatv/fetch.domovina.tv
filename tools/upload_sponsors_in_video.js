#!/usr/bin/env node
"use strict";
/**
 * tools/upload_sponsors_in_video.js — bulk upload `data/{videoId}/sponsors_in_video.json`.
 *
 * Fast-path za katalog-wide backfill KORAKA 9.85 (detect_sponsors.js). `upload_to_r2.js`
 * nije alat za jedan sufiks preko cijelog kataloga — usput bi objavio sve ostalo što
 * na disku čeka (vidi MEMORY upload_to_r2_anti_pattern_single_suffix).
 *
 * Opseg je namjerno UZAK: šalje samo za epizode koje su VEĆ objavljene, tj. imaju
 * `data/{id}/info.json` u `.r2_keys_cache.json`. Objavljivanje novih epizoda je posao
 * nightlyja. Preskače ključ kad je veličina na R2 ista kao lokalna (detektor je
 * determinističan, pa ista veličina ≈ isti sadržaj).
 *
 * Ključ ide s immutable Cache-Controlom, pa se svaki poslani URL purgea u dvije
 * Vary varijante — i NOVI ključevi, jer je Flutter možda već zapamtio 404
 * (MEMORY cloudflare_cdn_caches_404s). Nakon uploada upisuje veličine u keys-cache,
 * da idući nightly ne šalje isto ponovno.
 *
 * Primjeri:
 *   node tools/upload_sponsors_in_video.js --dry-run
 *   node tools/upload_sponsors_in_video.js --channel rastuci_s_djecom
 *   node tools/upload_sponsors_in_video.js --limit 20
 *   node tools/upload_sponsors_in_video.js            # cijeli katalog
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// .env (ručno, mirror upload_to_r2.js — bez dotenv dependency)
try {
    const envPath = path.join(ROOT, ".env");
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
            const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
            if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
    }
} catch (_) { /* best-effort */ }

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "https://cdn.domovina.ai").replace(/\/$/, "");
const CF_PURGE_TOKEN = process.env.DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE;
const CF_ZONE_NAME = "domovina.ai";
const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";
const SUFFIX = ".sponsors_in_video.json";
const KEYS_CACHE = path.join(ROOT, ".r2_keys_cache.json");

const args = process.argv.slice(2);
const getArg = (n) => { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : null; };
const INPUT_DIR = getArg("--input-dir") || path.join(ROOT, "storage", "output");
const ONLY_CHANNEL = getArg("--channel");
const LIMIT = parseInt(getArg("--limit") || "0", 10) || 0;
const DRY_RUN = args.includes("--dry-run");
const CONCURRENCY = parseInt(getArg("--concurrency") || "8", 10);
const NO_PURGE = args.includes("--no-purge");

function extractVideoId(filename) {
    const m = [...filename.matchAll(/_yt_([A-Za-z0-9_-]{11})/g)];
    return m.length ? m[m.length - 1][1] : null;
}

function listChannelDirs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
        .map((e) => e.name).sort();
}

function loadKeysCache() {
    if (!fs.existsSync(KEYS_CACHE)) {
        console.error("❌ .r2_keys_cache.json ne postoji — pokreni upload_to_r2.js jednom da se cache napuni.");
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(KEYS_CACHE, "utf8"));
}

async function cfZoneId() {
    const r = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${CF_ZONE_NAME}`, {
        headers: { Authorization: `Bearer ${CF_PURGE_TOKEN}` },
    });
    const j = await r.json();
    return (j && j.success && j.result && j.result[0]) ? j.result[0].id : null;
}

// Dvije varijante po URL-u: R2 vraća `Vary: Origin`, CF drži zaseban zapis po Originu.
async function purge(urls) {
    if (!urls.length || NO_PURGE) return 0;
    if (!CF_PURGE_TOKEN) {
        console.log("⚠️  DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE nije postavljen — preskačem purge.");
        return 0;
    }
    const zoneId = await cfZoneId().catch(() => null);
    if (!zoneId) { console.log("⚠️  Ne mogu razriješiti zone ID — purge ručno."); return 0; }
    const entries = [];
    for (const u of urls) {
        entries.push(u);
        entries.push({ url: u, headers: { Origin: `https://${CF_ZONE_NAME}` } });
    }
    let purged = 0;
    for (let i = 0; i < entries.length; i += 30) {   // CF limit: 30 po pozivu
        const batch = entries.slice(i, i + 30);
        try {
            const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
                method: "POST",
                headers: { Authorization: `Bearer ${CF_PURGE_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify({ files: batch }),
            });
            const j = await r.json().catch(() => ({}));
            if (j && j.success) purged += batch.length;
            else console.log(`⚠️  purge batch greška: ${JSON.stringify(j.errors || j).slice(0, 160)}`);
        } catch (e) {
            console.log(`⚠️  purge batch iznimka: ${e.message}`);
        }
        if (i && i % 600 === 0) console.log(`   🧹 purge ${i}/${entries.length} …`);
    }
    return purged;
}

async function main() {
    const cache = loadKeysCache();
    const sizes = cache.sizes || {};
    const published = new Set(Object.keys(sizes)
        .map((k) => k.match(/^data\/([A-Za-z0-9_-]+)\/info\.json$/))
        .filter(Boolean).map((m) => m[1]));
    console.log(`🤝 Upload sponsors_in_video.json — objavljenih epizoda na R2: ${published.size}`);
    if (DRY_RUN) console.log("   ⚠️  DRY RUN — ništa se ne šalje niti purgea");

    const byKey = new Map();
    let notPublished = 0, unchanged = 0;
    for (const channel of (ONLY_CHANNEL ? [ONLY_CHANNEL] : listChannelDirs(INPUT_DIR))) {
        const dir = path.join(INPUT_DIR, channel);
        let files;
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith(SUFFIX) && !f.startsWith("._")); }
        catch { continue; }
        for (const f of files) {
            const videoId = extractVideoId(f);
            if (!videoId) continue;
            if (!published.has(videoId)) { notPublished++; continue; }
            const key = `data/${videoId}/sponsors_in_video.json`;
            const localPath = path.join(dir, f);
            const size = fs.statSync(localPath).size;
            if (sizes[key] === size) { unchanged++; continue; }
            // Ista epizoda u kanalu i u `_unlisted` (auto_reuse_adhoc.js) → kanalska pobjeđuje.
            const prev = byKey.get(key);
            if (prev && !prev.localPath.includes("/_unlisted/") && localPath.includes("/_unlisted/")) continue;
            byKey.set(key, { videoId, localPath, key, size });
        }
    }
    let jobs = [...byKey.values()];
    if (LIMIT) jobs = jobs.slice(0, LIMIT);
    console.log(`   🎯 za slanje: ${jobs.length} · nepromijenjeno: ${unchanged} · nije objavljeno (preskačem): ${notPublished}`);
    if (!jobs.length || DRY_RUN) {
        if (DRY_RUN) jobs.slice(0, 5).forEach((j) => console.log(`   • ${j.key} (${j.size} B) ← ${path.basename(j.localPath)}`));
        return;
    }

    for (const v of [["R2_ACCOUNT_ID", R2_ACCOUNT_ID], ["R2_ACCESS_KEY_ID", R2_ACCESS_KEY_ID], ["R2_SECRET_ACCESS_KEY", R2_SECRET_ACCESS_KEY]]) {
        if (!v[1]) { console.error(`❌ nedostaje ${v[0]} u .env`); process.exit(1); }
    }
    const { S3Client, PutObjectCommand } = require(path.join(ROOT, "node_modules", "@aws-sdk", "client-s3"));
    const client = new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });

    const sent = [];
    let done = 0, failed = 0;
    async function worker(queue) {
        while (queue.length) {
            const job = queue.pop();
            try {
                await client.send(new PutObjectCommand({
                    Bucket: R2_BUCKET_NAME,
                    Key: job.key,
                    Body: fs.readFileSync(job.localPath),
                    ContentType: "application/json; charset=utf-8",
                    CacheControl: CACHE_CONTROL_IMMUTABLE,
                }));
                sent.push(job);
            } catch (e) {
                failed++;
                console.log(`   ❌ ${job.key} — ${e.message}`);
            }
            if (++done % 250 === 0) console.log(`   ⬆️  ${done}/${jobs.length}`);
        }
    }
    const queue = jobs.slice();
    await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, () => worker(queue)));
    console.log(`\n⬆️  Poslano: ${sent.length} · greške: ${failed}`);

    // Keys-cache: svježe pročitan (nightly je mogao pisati u međuvremenu), samo naši ključevi.
    try {
        const fresh = JSON.parse(fs.readFileSync(KEYS_CACHE, "utf8"));
        fresh.sizes = fresh.sizes || {};
        for (const j of sent) fresh.sizes[j.key] = j.size;
        fs.writeFileSync(KEYS_CACHE, JSON.stringify(fresh));
        console.log(`🗂️  keys-cache ažuriran (+${sent.length})`);
    } catch (e) {
        console.log(`⚠️  keys-cache nije ažuriran: ${e.message} — nightly će ključeve poslati ponovno (bezopasno)`);
    }

    console.log(`🧹 Purge ${sent.length} URL-ova × 2 Vary varijante …`);
    const purged = await purge(sent.map((j) => `${R2_PUBLIC_URL}/${j.key}`));
    console.log(`   gotovo: ${purged} zapisa`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
