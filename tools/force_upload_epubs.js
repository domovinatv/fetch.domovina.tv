#!/usr/bin/env node
"use strict";
/**
 * tools/force_upload_epubs.js — bulk re-upload `data/{videoId}/book.epub` ključeva.
 *
 * `upload_to_r2.js` `data/` ključeve tretira kao write-once (LIST-once → skip
 * postojećih), a `force_upload.js` radi jednu epizodu i samo JSON targete. Za
 * katalog-wide zahvat (npr. promjena formata linkova u knjizi, 15.09.2026.)
 * treba fast-path uploader — vidi MEMORY upload_to_r2_anti_pattern_single_suffix.
 *
 * Opseg je namjerno UZAK: šalje samo knjige za koje ključ na R2 VEĆ postoji
 * (`.r2_keys_cache.json`). Objavljivanje novih epizoda je posao nightlyja, ne
 * ovog alata — inače bi backfill usput objavio `_unlisted` i sve ostalo što
 * nikad nije bilo namijenjeno CDN-u.
 *
 * Ključ ide s immutable Cache-Controlom (godina dana), pa se SVAKI prepisani
 * URL mora purgeati — u dvije Vary varijante (vidi MEMORY cloudflare_cdn_caches_404s).
 *
 * Primjeri:
 *   node tools/force_upload_epubs.js --dry-run
 *   node tools/force_upload_epubs.js --limit 5
 *   node tools/force_upload_epubs.js --channel muzevni_budite
 *   node tools/force_upload_epubs.js              # cijeli katalog
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

const args = process.argv.slice(2);
const getArg = (n) => { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : null; };
const INPUT_DIR = getArg("--input-dir") || path.join(ROOT, "storage", "output");
const ONLY_CHANNEL = getArg("--channel");
const LIMIT = parseInt(getArg("--limit") || "0", 10) || 0;
const DRY_RUN = args.includes("--dry-run");
const CONCURRENCY = parseInt(getArg("--concurrency") || "4", 10);
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

function loadPublishedKeys() {
    const p = path.join(ROOT, ".r2_keys_cache.json");
    if (!fs.existsSync(p)) {
        console.error("❌ .r2_keys_cache.json ne postoji — pokreni upload_to_r2.js jednom da se cache napuni.");
        process.exit(1);
    }
    const cache = JSON.parse(fs.readFileSync(p, "utf8"));
    const sizes = cache.sizes || {};
    const keys = new Set();
    for (const k of Object.keys(sizes)) {
        if (/^data\/[A-Za-z0-9_-]+\/book(\.en)?\.epub$/.test(k)) keys.add(k);
    }
    return { keys, mtime: fs.statSync(p).mtime.toISOString().slice(0, 16).replace("T", " ") };
}

async function cfZoneId() {
    const r = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${CF_ZONE_NAME}`, {
        headers: { Authorization: `Bearer ${CF_PURGE_TOKEN}` },
    });
    const j = await r.json();
    return (j && j.success && j.result && j.result[0]) ? j.result[0].id : null;
}

// Svaki URL u DVIJE varijante: R2 vraća `Vary: Origin`, pa CF drži odvojen zapis
// po Originu. Purge golog URL-a čisti samo ono što vidi curl — preglednik šalje
// `Origin: https://domovina.ai` i dobio bi netaknut stari zapis.
async function purge(urls) {
    if (!urls.length || NO_PURGE) return 0;
    if (!CF_PURGE_TOKEN) {
        console.log("⚠️  DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE nije postavljen — knjige su na R2, ali edge servira stare.");
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
    for (let i = 0; i < entries.length; i += 30) {   // CF limit: 30 file-ova po pozivu
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
    const { keys: published, mtime } = loadPublishedKeys();
    console.log(`📚 Bulk re-upload book.epub — objavljenih knjiga na R2: ${published.size} (cache od ${mtime})`);
    if (DRY_RUN) console.log("   ⚠️  DRY RUN — ništa se ne šalje niti purgea");

    const jobs = [];
    for (const channel of (ONLY_CHANNEL ? [ONLY_CHANNEL] : listChannelDirs(INPUT_DIR))) {
        const dir = path.join(INPUT_DIR, channel);
        let files;
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".epub") && !f.startsWith("._")); }
        catch { continue; }
        for (const f of files) {
            const videoId = extractVideoId(f);
            if (!videoId) continue;
            // `{base}.en.epub` ide na SVOJ ključ — inače bi englesko izdanje
            // pregazilo hrvatsku knjigu na `book.epub`.
            const key = `data/${videoId}/book${f.endsWith(".en.epub") ? ".en" : ""}.epub`;
            if (!published.has(key)) continue;   // nije objavljeno → nije naš posao
            jobs.push({ videoId, localPath: path.join(dir, f), key });
            if (LIMIT && jobs.length >= LIMIT) break;
        }
        if (LIMIT && jobs.length >= LIMIT) break;
    }
    // Ista epizoda zna postojati DVAPUT na disku: jednom kao ad-hoc obrada u
    // `_unlisted`, jednom u kanalu koji ju je posvojio (auto_reuse_adhoc.js).
    // Oba imena vode na isti CDN ključ, pa bez razrješenja upload ovisi o
    // redoslijedu čitanja direktorija. Servira se kanalska epizoda — `_unlisted`
    // nije indeksiran — pa kanalska kopija pobjeđuje; kod izjednačenja veća.
    const byKey = new Map();
    let collisions = 0;
    for (const j of jobs) {
        const prev = byKey.get(j.key);
        if (!prev) { byKey.set(j.key, j); continue; }
        collisions++;
        const better = (a, b) => {
            const aUn = a.localPath.includes("/_unlisted/");
            const bUn = b.localPath.includes("/_unlisted/");
            if (aUn !== bUn) return aUn ? b : a;
            return fs.statSync(a.localPath).size >= fs.statSync(b.localPath).size ? a : b;
        };
        byKey.set(j.key, better(prev, j));
    }
    if (collisions) console.log(`   ⚖️  ${collisions} epizoda postoji i u kanalu i u _unlisted → šaljem kanalsku`);
    jobs.length = 0;
    jobs.push(...byKey.values());

    console.log(`   🎯 za slanje: ${jobs.length}`);
    if (!jobs.length || DRY_RUN) {
        if (DRY_RUN) jobs.slice(0, 5).forEach((j) => console.log(`   • ${j.key} ← ${path.basename(j.localPath)}`));
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

    const purgeUrls = [];
    let done = 0, failed = 0, bytes = 0;
    const started = Date.now();

    async function worker(queue) {
        while (queue.length) {
            const job = queue.pop();
            try {
                const body = fs.readFileSync(job.localPath);
                await client.send(new PutObjectCommand({
                    Bucket: R2_BUCKET_NAME,
                    Key: job.key,
                    Body: body,
                    ContentType: "application/epub+zip",
                    CacheControl: CACHE_CONTROL_IMMUTABLE,
                }));
                bytes += body.length;
                purgeUrls.push(`${R2_PUBLIC_URL}/${job.key}`);
            } catch (e) {
                failed++;
                console.log(`   ❌ ${job.key} — ${e.message}`);
            }
            if (++done % 100 === 0) {
                const rate = done / ((Date.now() - started) / 1000);
                console.log(`   ⬆️  ${done}/${jobs.length} · ${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB · ${rate.toFixed(1)}/s`);
            }
        }
    }
    const queue = jobs.slice();
    await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, () => worker(queue)));
    console.log(`\n⬆️  Poslano: ${purgeUrls.length} · greške: ${failed} · ${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`);

    console.log(`🧹 Purge ${purgeUrls.length} URL-ova × 2 Vary varijante …`);
    const purged = await purge(purgeUrls);
    console.log(`   gotovo: ${purged} zapisa`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
