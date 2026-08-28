#!/usr/bin/env node
/**
 * force_upload.js — prisilni re-upload IMMUTABLE `data/{videoId}/*.json` ključeva.
 *
 * `upload_to_r2.js` te ključeve tretira kao write-once immutable (LIST-once → skip
 * postojećih) pa NE prepisuje naknadno ispravljene datoteke (npr. korekcija
 * halucinirane atribucije govornika). Ovaj alat radi DIREKTAN S3 PutObject preko
 * postojećeg ključa i zatim PURGE-a Cloudflare CDN (keyevi imaju Cache-Control
 * immutable 1god → bez purge-a edge servira stari sadržaj; GET, ne HEAD, za verifikaciju).
 *
 * Vidi memory: upload_r2_data_dir_immutable_force_pattern, cloudflare_cdn_caches_404s,
 * r2_cost_list_once. Cache-Control se namjerno drži IMMUTABLE (isto kao upload_to_r2)
 * — nakon purge-a novi sadržaj se ponovno cache-ira na 1god.
 *
 * Uporaba:
 *   node force_upload.js --video-id VID --channel CH \
 *        [--targets article,magisterium,article-en,magisterium-en,summary,summary-en]
 *   (default targets: article,magisterium,article-en,magisterium-en)
 */

const fs = require("fs");
const path = require("path");

// ─── .env UČITAVANJE (ručno, mirror upload_to_r2.js — bez dotenv dependency) ───
try {
    const envPath = path.join(__dirname, ".env");
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
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || "https://cdn.domovina.ai";
const CF_PURGE_TOKEN = process.env.DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE;
const CF_ZONE_NAME = "domovina.ai";
const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";

function getArg(name) {
    const i = process.argv.indexOf(name);
    return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const videoId = getArg("--video-id");
const channel = getArg("--channel");
const targetsArg = getArg("--targets") || "article,magisterium,article-en,magisterium-en";
if (!videoId || !channel) {
    console.error("Uporaba: node force_upload.js --video-id VID --channel CH [--targets ...]");
    process.exit(1);
}

// target → { lokalni suffix, R2 basename }.
// VAŽNO: `.article.magisterium.en.json` NE završava na `.article.en.json`, a
// `.article.magisterium.json` NE završava na `.article.json` → endsWith je jednoznačan.
const TARGET_MAP = {
    "article":        { suffix: ".article.json",                r2: "article.json" },
    "magisterium":    { suffix: ".article.magisterium.json",    r2: "article.magisterium.json" },
    "article-en":     { suffix: ".article.en.json",             r2: "article.en.json" },
    "magisterium-en": { suffix: ".article.magisterium.en.json", r2: "article.magisterium.en.json" },
    "summary":        { suffix: ".canary.summary.json",         r2: "summary.json" },
    "summary-en":     { suffix: ".canary.summary.en.json",      r2: "summary.en.json" },
};

const dir = path.join("storage/output", channel);

function findLocal(suffix) {
    const files = fs.readdirSync(dir).filter(f =>
        f.includes("_yt_" + videoId) &&
        f.endsWith(suffix) &&
        !f.startsWith("._") &&
        !f.endsWith(".bak")
    );
    files.sort(); // leksikografski najnoviji (isti kriterij kao article-dedup)
    return files.length ? path.join(dir, files[files.length - 1]) : null;
}

async function cfZoneId() {
    const r = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${CF_ZONE_NAME}`, {
        headers: { Authorization: `Bearer ${CF_PURGE_TOKEN}` },
    });
    const j = await r.json();
    return (j && j.success && j.result && j.result[0]) ? j.result[0].id : null;
}

async function main() {
    for (const v of [["R2_ACCOUNT_ID", R2_ACCOUNT_ID], ["R2_ACCESS_KEY_ID", R2_ACCESS_KEY_ID], ["R2_SECRET_ACCESS_KEY", R2_SECRET_ACCESS_KEY]]) {
        if (!v[1]) { console.error(`❌ nedostaje ${v[0]} u .env`); process.exit(1); }
    }
    const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
    const client = new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });

    const purgeUrls = [];
    for (const t of targetsArg.split(",").map(s => s.trim()).filter(Boolean)) {
        const map = TARGET_MAP[t];
        if (!map) { console.error(`⚠️  nepoznat target: ${t}`); continue; }
        const local = findLocal(map.suffix);
        if (!local) { console.error(`⏭️  nema lokalnog fajla za '${t}' (${map.suffix})`); continue; }
        const key = `data/${videoId}/${map.r2}`;
        const body = fs.readFileSync(local);
        await client.send(new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            Body: body,
            ContentType: "application/json",
            CacheControl: CACHE_CONTROL_IMMUTABLE,
        }));
        console.log(`⬆️  PUT ${key}  (${(body.length / 1024).toFixed(1)} KB)  ← ${path.basename(local)}`);
        purgeUrls.push(`${R2_PUBLIC_URL}/${key}`);
    }

    if (!purgeUrls.length) { console.log("Ništa za upload."); return; }

    if (!CF_PURGE_TOKEN) {
        console.log("⚠️  CF_PURGE_TOKEN nije postavljen — purge-aj ručno:");
        purgeUrls.forEach(u => console.log("   " + u));
        return;
    }
    let zoneId = null;
    try { zoneId = await cfZoneId(); } catch (_) { /* fallthrough */ }
    if (!zoneId) { console.log("⚠️  ne mogu razriješiti zoneId — purge ručno preko dashboarda."); return; }
    const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CF_PURGE_TOKEN}`, "Content-Type": "application/json" },
        // R2 vraća `Vary: Origin` → Cloudflare drži ODVOJEN cache zapis po Originu.
        // Purge po golom URL-u čisti samo zapis bez Origina (onaj koji vidi curl);
        // preglednik šalje `Origin: https://domovina.ai` i dobiva drugi, netaknut.
        // Zato svaki URL ide u obje varijante. Vidi upload_to_r2.js purgeCloudflareCache.
        body: JSON.stringify({
            files: purgeUrls.flatMap(u => [u, { url: u, headers: { Origin: `https://${CF_ZONE_NAME}` } }]),
        }),
    });
    const j = await r.json().catch(() => ({}));
    console.log(j && j.success
        ? `🧹 CDN purge OK: ${purgeUrls.length} URL-ova × 2 Vary varijante (verificiraj GET-om S Origin headerom)`
        : `⚠️  CDN purge greška: ${JSON.stringify(j.errors || j).slice(0, 200)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
