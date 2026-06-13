#!/usr/bin/env node
/**
 * fix_channel_avatar_content_type.js — jednokratna remediacija avatara kanala.
 *
 * PROBLEM: avatari kanala (`channels/images/{channel}/avatar_{square,cover}.jpg`)
 * bulk-uploadani 31.03.2026. dobili su `Content-Type: application/octet-stream`
 * (stariji upload put nije postavljao tip). Frontend ne renderira octet-stream kao
 * sliku → sivi placeholder umjesto ikone kanala. 36/42 kanala je pogođeno; 6 kanala
 * re-uploadanih u lipnju ima ispravan `image/jpeg`.
 *
 * Zašto reindex to NE popravlja: `upload_to_r2.js` tretira avatar ključeve kao
 * immutable-po-imenu (`isContentMutable` vraća true samo za manifeste) → ako ključ
 * postoji u LIST setu, skip bez HEAD-a. Octet-stream objekt ostaje zaleđen.
 *
 * OVAJ SKRIPT: LIST `channels/images/`, HEAD svaki ključ, i za sve koji NEMAJU
 * `image/*` content-type → GET bajtove, odredi pravi tip iz magic-bytes, PutObject
 * overwrite s točnim Content-Type + mutable Cache-Control. Na kraju CF purge + GET-verify.
 *
 * Trajni popravak (da se ne ponovi) je u upload_to_r2.js (channels/images/* = mutable).
 *
 * Pokretanje:  node fix_channel_avatar_content_type.js [--dry-run]
 */
const fs = require("fs");
const path = require("path");

// ─── .env UČITAVANJE (ručno, isti pattern kao upload_to_r2.js) ──────
(() => {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const key = m[1];
        let val = m[2].trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
    }
})();

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "https://cdn.domovina.ai").replace(/\/$/, "");
const CF_PURGE_TOKEN = process.env.DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE;
const CF_ZONE_NAME = "domovina.ai";
const CACHE_CONTROL_MUTABLE = "public, max-age=60, must-revalidate";
const DRY_RUN = process.argv.includes("--dry-run");
const PREFIX = "channels/images/";

const log = (e, m) => console.log(`${e}  ${m}`);

// magic-byte sniff → točan image MIME (ne oslanjaj se na .jpg ekstenziju —
// neki avatari su zapravo PNG spremljeni pod .jpg ključem)
function sniffImageType(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
    return null; // nepoznato — ne diraj
}

async function listAllKeys(client, ListObjectsV2Command) {
    const keys = [];
    let token;
    do {
        const r = await client.send(new ListObjectsV2Command({
            Bucket: R2_BUCKET_NAME, Prefix: PREFIX, MaxKeys: 1000, ContinuationToken: token,
        }));
        for (const o of (r.Contents || [])) keys.push(o.Key);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return keys;
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

async function cfZoneId() {
    const r = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${CF_ZONE_NAME}`, {
        headers: { Authorization: `Bearer ${CF_PURGE_TOKEN}` },
    });
    const j = await r.json();
    return (j && j.success && j.result && j.result[0]) ? j.result[0].id : null;
}

async function purge(urls) {
    if (!urls.length) return;
    if (!CF_PURGE_TOKEN) { log("⚠️", "Nema CF purge tokena — purge-aj ručno (CF dashboard → Purge Everything)."); return; }
    let zoneId;
    try { zoneId = await cfZoneId(); } catch { zoneId = null; }
    if (!zoneId) { log("⚠️", "Ne mogu razriješiti zone ID — purge-aj ručno."); return; }
    let purged = 0;
    for (let i = 0; i < urls.length; i += 30) {
        const batch = urls.slice(i, i + 30);
        const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
            method: "POST",
            headers: { Authorization: `Bearer ${CF_PURGE_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ files: batch }),
        });
        const j = await r.json().catch(() => ({}));
        if (j && j.success) purged += batch.length;
        else log("⚠️", `CF purge batch greška: ${JSON.stringify(j.errors || j).slice(0, 200)}`);
    }
    log("🧹", `CDN purge: ${purged}/${urls.length} URL-ova.`);
}

async function main() {
    const missing = [];
    if (!R2_ACCOUNT_ID) missing.push("R2_ACCOUNT_ID");
    if (!R2_ACCESS_KEY_ID) missing.push("R2_ACCESS_KEY_ID");
    if (!R2_SECRET_ACCESS_KEY) missing.push("R2_SECRET_ACCESS_KEY");
    if (missing.length) { log("❌", `Nedostaju env varijable: ${missing.join(", ")}`); process.exit(1); }

    const { S3Client, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
    const client = new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });

    log("🪣", `Bucket: ${R2_BUCKET_NAME}  |  Prefix: ${PREFIX}${DRY_RUN ? "  |  DRY RUN" : ""}`);
    const keys = await listAllKeys(client, ListObjectsV2Command);
    log("📋", `Pronađeno ${keys.length} objekata pod ${PREFIX}`);

    const fixed = [];
    let okAlready = 0;
    for (const key of keys) {
        const head = await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
        const ct = (head.ContentType || "").toLowerCase();
        if (ct.startsWith("image/")) { okAlready++; continue; }

        // dohvati bajtove i odredi pravi tip
        const get = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
        const buf = await streamToBuffer(get.Body);
        const trueType = sniffImageType(buf);
        if (!trueType) { log("⚠️", `${key}: nepoznat tip (CT=${ct}, ${buf.length}B) — preskačem`); continue; }

        log("🔧", `${key}  ${ct || "(prazno)"} → ${trueType}  (${buf.length}B)`);
        if (!DRY_RUN) {
            await client.send(new PutObjectCommand({
                Bucket: R2_BUCKET_NAME, Key: key, Body: buf,
                ContentLength: buf.length, ContentType: trueType,
                CacheControl: CACHE_CONTROL_MUTABLE,
            }));
        }
        fixed.push(`${R2_PUBLIC_URL}/${key}`);
    }

    log("📊", `Već ispravnih (image/*): ${okAlready}  |  Popravljeno: ${fixed.length}`);
    if (!DRY_RUN && fixed.length) {
        log("🧹", `Purge-am ${fixed.length} CDN URL-ova (edge cachira immutable iz ožujka)...`);
        await purge(fixed);
    } else if (DRY_RUN && fixed.length) {
        log("💡", `[DRY RUN] Bilo bi popravljeno + purgano ${fixed.length} URL-ova.`);
    }
    log("✅", "Gotovo.");
}

main().catch(e => { console.error("❌ Fatalna greška:", e.message); process.exit(1); });
