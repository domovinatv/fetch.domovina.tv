#!/usr/bin/env node
/**
 * build_episode_bundle.js — `data/{id}/episode.json`: jedna datoteka po epizodi.
 *
 * Ekran epizode na domovina.ai traži ~18 datoteka, a tipično ih postoji 7; svaki
 * 404 klijent ponovi s cache-busterom, pa otvaranje epizode koči ~29 zahtjeva.
 * Bundle u jednom zahtjevu nosi sadržaj za prvi prikaz i popis datoteka koje
 * postoje — klijent ostalo traži samo ako je na popisu (3 zahtjeva umjesto 29).
 * Ugovor (v1) je doc komentar u domovina.ai `lib/models/episode_bundle.dart`:
 *
 *   { "version": 1, "generated_at": "…",
 *     "files":  [ime svake datoteke pod data/{id}/, kako je servira CDN],
 *     "inline": { "info.json": {…}, "summary.json": {…}, "outline.json": {…},
 *                 "article.json": {…}, "article.magisterium.json": {…} } }
 *
 * Tri pravila:
 *   1. `files` je IZMJERENI listing R2 prefiksa, ne pipeline zastavice. Klijent ne
 *      traži datoteku koje nema na popisu — zastario bundle SAKRIVA novu datoteku.
 *      Zato se bundle regenerira nakon uploada (upload_to_r2.js, force_upload.js
 *      ga zovu sami) i u KORAKU 12.7 svakog run_pipeline uploada.
 *   2. `inline` sadržaj se čita s R2 (ono što CDN servira), ne s diska: CDN zna
 *      biti bogatiji od diska (Opus članak), a bundle mora reći isto što i
 *      pojedinačne datoteke. Titlovi, words.json i EN prijevodi ostaju vani.
 *   3. Upload samo kad se sadržaj promijenio (bez `generated_at`) → stabilan ETag.
 *      Otisak = popis imena + ETag-ovi inline datoteka iz LIST-a, pa nepromijenjena
 *      epizoda ne košta nijedan GET. Prepis medija ili e-knjige ne mijenja otisak.
 *
 * Cache-Control kao listinzi (`max-age=60, must-revalidate`), NE immutable — bundle
 * se mijenja pod istim imenom. Novi bundle se purgea (obje `Vary: Origin` varijante),
 * jer je edge možda zapamtio 404 dok ga klijent tražio prije backfilla.
 *
 * Trošak: LIST `data/` prefiksa je ~28 stranica (28k objekata) za cijeli katalog;
 * GET-ovi samo za epizode kojima se otisak promijenio. Nula LLM poziva.
 *
 * Uporaba:
 *   node build_episode_bundle.js --all [--dry-run] [--limit N] [--force] [--no-purge]
 *   node build_episode_bundle.js --video-id ID[,ID2,...]
 *
 * Vidi docs/2026-10-09-episode-json-bundle.md, docs/data_contract.md §15.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "https://cdn.domovina.ai").replace(/\/$/, "");
const CF_PURGE_TOKEN = process.env.DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE;
const CF_ZONE_NAME = "domovina.ai";

const BUNDLE_NAME = "episode.json";
const BUNDLE_VERSION = 1;
// Redoslijed je i redoslijed ključeva u `inline` → deterministički JSON.
const INLINE_FILES = ["info.json", "summary.json", "outline.json", "article.json", "article.magisterium.json"];
const CACHE_CONTROL_MUTABLE = "public, max-age=60, must-revalidate";
const STATE_PATH = path.join(__dirname, ".episode_bundle_state.json");
const CONCURRENCY = 8;

// ─── ČISTE FUNKCIJE (testirane u build_episode_bundle.test.js) ─────────────

/**
 * Grupira LIST rezultat (`data/{id}/{ime}` → {etag, size}) po epizodi.
 * @returns {Map<string, Map<string, {etag: string, size: number}>>}
 */
function groupListing(objects) {
    const byId = new Map();
    for (const o of objects) {
        const m = o.key.match(/^data\/([^/]+)\/(.+)$/);
        if (!m) continue;
        if (!byId.has(m[1])) byId.set(m[1], new Map());
        byId.get(m[1]).set(m[2], { etag: (o.etag || "").replace(/"/g, ""), size: o.size });
    }
    return byId;
}

/** Imena datoteka epizode za `files` (bez samog bundlea), sortirana. */
function listedFiles(entries) {
    return [...entries.keys()].filter(n => n !== BUNDLE_NAME).sort();
}

/**
 * Otisak ulaza: popis imena + ETag inline datoteka. Isti otisak = isti bundle,
 * pa se ni ne čita s R2. ETag-ovi ostalih datoteka namjerno nisu u otisku —
 * prepis e-knjige ili videa ne mijenja ništa što bundle nosi.
 */
function fingerprint(entries) {
    const parts = listedFiles(entries).map(n =>
        INLINE_FILES.includes(n) ? `${n}:${entries.get(n).etag}` : n);
    return crypto.createHash("sha1").update(`v${BUNDLE_VERSION}\n` + parts.join("\n")).digest("hex");
}

/** Bundle bez `generated_at` — oblik nad kojim se uspoređuje „je li se promijenio". */
function buildBody(files, inlineContents) {
    const inline = {};
    for (const n of INLINE_FILES) {
        if (inlineContents[n] !== undefined) inline[n] = inlineContents[n];
    }
    return { version: BUNDLE_VERSION, files, inline };
}

function withTimestamp(body, generatedAt) {
    return { version: body.version, generated_at: generatedAt, files: body.files, inline: body.inline };
}

function sameContent(a, b) {
    if (!a || !b) return false;
    const strip = o => JSON.stringify({ version: o.version, files: o.files, inline: o.inline });
    return strip(a) === strip(b);
}

// ─── R2 / CDN ─────────────────────────────────────────────────────────────

function createR2Client() {
    const { S3Client } = require("@aws-sdk/client-s3");
    for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
        if (!process.env[k]) { console.error(`❌ nedostaje ${k} u .env`); process.exit(1); }
    }
    return new S3Client({
        region: "auto",
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

async function listPrefix(client, prefix) {
    const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
    const out = [];
    let token;
    do {
        const resp = await client.send(new ListObjectsV2Command({
            Bucket: R2_BUCKET_NAME, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000,
        }));
        for (const o of resp.Contents || []) out.push({ key: o.Key, etag: o.ETag, size: o.Size });
        token = resp.NextContinuationToken;
    } while (token);
    return out;
}

async function getText(client, key) {
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    try {
        const resp = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
        return await resp.Body.transformToString("utf-8");
    } catch (err) {
        if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

async function putBundle(client, id, bundle) {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    await client.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: `data/${id}/${BUNDLE_NAME}`,
        Body: JSON.stringify(bundle),
        ContentType: "application/json; charset=utf-8",
        CacheControl: CACHE_CONTROL_MUTABLE,
    }));
}

// Obje `Vary: Origin` varijante — goli URL čisti samo zapis koji vidi curl, a
// preglednik šalje Origin i dobiva drugi. Vidi upload_to_r2.js purgeCloudflareCache.
async function purge(urls) {
    if (!urls.length) return;
    if (!CF_PURGE_TOKEN) { console.log("⚠️  DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE nije postavljen — preskačem purge."); return; }
    const z = await (await fetch(`https://api.cloudflare.com/client/v4/zones?name=${CF_ZONE_NAME}`, {
        headers: { Authorization: `Bearer ${CF_PURGE_TOKEN}` },
    })).json().catch(() => null);
    const zoneId = z && z.success && z.result && z.result[0] ? z.result[0].id : null;
    if (!zoneId) { console.log("⚠️  ne mogu razriješiti zoneId — purge preskočen."); return; }
    const entries = urls.flatMap(u => [u, { url: u, headers: { Origin: `https://${CF_ZONE_NAME}` } }]);
    let ok = 0;
    for (let i = 0; i < entries.length; i += 30) {
        const batch = entries.slice(i, i + 30);
        try {
            const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
                method: "POST",
                headers: { Authorization: `Bearer ${CF_PURGE_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify({ files: batch }),
            });
            const j = await r.json().catch(() => ({}));
            if (j && j.success) ok += batch.length;
            else console.log(`⚠️  purge batch greška: ${JSON.stringify(j.errors || j).slice(0, 200)}`);
        } catch (e) {
            console.log(`⚠️  purge batch iznimka: ${e.message}`);
        }
    }
    console.log(`🧹 CDN purge: ${urls.length} novih bundleova × 2 Vary varijante = ${ok}/${entries.length}`);
}

// ─── STATE ────────────────────────────────────────────────────────────────

function loadState() {
    try {
        const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
        if (raw && raw.v === 1 && raw.ids) return raw.ids;
    } catch { /* nema ili korumpiran — kreni od nule, GET-ovi to riješe */ }
    return {};
}

function saveState(ids) {
    try { fs.writeFileSync(STATE_PATH, JSON.stringify({ v: 1, ids }), "utf-8"); } catch { /* nije kritično */ }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────

function getArg(name) {
    const i = process.argv.indexOf(name);
    return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const hasFlag = name => process.argv.includes(name);

async function runConcurrent(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const it = items[i++]; await fn(it); }
    }));
}

async function main() {
    const all = hasFlag("--all");
    const idArg = getArg("--video-id");
    const dryRun = hasFlag("--dry-run");
    const force = hasFlag("--force");
    const noPurge = hasFlag("--no-purge");
    const limit = getArg("--limit") ? parseInt(getArg("--limit"), 10) : 0;
    if (!all && !idArg) {
        console.error("Uporaba: node build_episode_bundle.js --all | --video-id ID[,ID2] [--dry-run] [--limit N] [--force] [--no-purge]");
        process.exit(1);
    }

    const client = createR2Client();
    const t0 = Date.now();

    let byId;
    if (all) {
        byId = groupListing(await listPrefix(client, "data/"));
    } else {
        const ids = [...new Set(idArg.split(",").map(s => s.trim()).filter(Boolean))];
        byId = new Map();
        for (const id of ids) {
            const g = groupListing(await listPrefix(client, `data/${id}/`));
            if (g.has(id)) byId.set(id, g.get(id));
            else console.log(`⚠️  ${id}: nema ničega pod data/${id}/ — preskačem`);
        }
    }

    const state = loadState();
    const stats = { episodes: byId.size, unchanged: 0, written: 0, created: 0, sameBody: 0, empty: 0, failed: 0 };
    const todo = [];
    for (const [id, entries] of byId) {
        const files = listedFiles(entries);
        if (!files.length) { stats.empty++; continue; }
        const fp = fingerprint(entries);
        if (!force && entries.has(BUNDLE_NAME) && state[id] === fp) { stats.unchanged++; continue; }
        todo.push({ id, entries, files, fp });
    }
    const work = limit ? todo.slice(0, limit) : todo;
    console.log(`📋 ${byId.size} epizoda pod data/ · nepromijenjeno ${stats.unchanged} · za provjeru ${work.length}${limit && todo.length > limit ? ` (od ${todo.length}, --limit)` : ""} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

    const createdUrls = [];
    let bytes = 0;
    await runConcurrent(work, CONCURRENCY, async ({ id, entries, files, fp }) => {
        try {
            const inlineContents = {};
            for (const n of INLINE_FILES) {
                if (!entries.has(n)) continue;
                const text = await getText(client, `data/${id}/${n}`);
                if (text === null) continue;
                try { inlineContents[n] = JSON.parse(text); }
                catch { console.log(`⚠️  ${id}/${n}: nečitljiv JSON — ne ulaže se (klijent ga traži zasebno)`); }
            }
            const body = buildBody(files, inlineContents);

            const existed = entries.has(BUNDLE_NAME);
            if (existed && !force) {
                let old = null;
                try { old = JSON.parse(await getText(client, `data/${id}/${BUNDLE_NAME}`) || "null"); } catch { /* prepiši */ }
                if (sameContent(old, body)) { stats.sameBody++; state[id] = fp; return; }
            }

            const bundle = withTimestamp(body, new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
            const size = Buffer.byteLength(JSON.stringify(bundle));
            if (dryRun) {
                console.log(`🏜️  [DRY] ${id}: ${existed ? "UPDATE" : "NOVO"} ${files.length} datoteka, inline ${Object.keys(body.inline).length}, ${(size / 1024).toFixed(1)} KB`);
            } else {
                await putBundle(client, id, bundle);
                state[id] = fp;
                if (!existed) createdUrls.push(`${R2_PUBLIC_URL}/data/${id}/${BUNDLE_NAME}`);
            }
            bytes += size;
            stats.written++;
            if (!existed) stats.created++;
        } catch (err) {
            stats.failed++;
            console.log(`❌ ${id}: ${err.message}`);
        }
    });

    if (!dryRun) {
        saveState(state);
        if (!noPurge) await purge(createdUrls);
    }

    console.log(`✅ episode.json: ${dryRun ? "bi zapisao" : "zapisano"} ${stats.written} (novih ${stats.created}, ${(bytes / 1024 / 1024).toFixed(1)} MB) · isti sadržaj ${stats.sameBody} · nepromijenjen otisak ${stats.unchanged}${stats.failed ? ` · ❌ ${stats.failed}` : ""} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (stats.failed) process.exitCode = 1;
}

if (require.main === module) {
    main().catch(e => { console.error("Fatal:", e); process.exit(1); });
}

module.exports = { groupListing, listedFiles, fingerprint, buildBody, withTimestamp, sameContent, INLINE_FILES, BUNDLE_NAME };
