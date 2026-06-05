#!/usr/bin/env node
/**
 * delete_legacy_video_mp4.js
 * ──────────────────────────
 * Briše legacy `data/{id}/video.mp4` (VP9/AV1-u-mp4, ne svira na Apple) s R2 —
 * ali SAMO ako sibling `data/{id}/video_h264.mp4` postoji (HEAD 200). Time se nikad
 * ne obriše jedini video epizode. Oslobađa ~50% bucketa (legacy video je 304 GB).
 *
 * SIGURNOST:
 *   - Default je DRY-RUN — ništa se ne briše bez `--confirm`.
 *   - Per-epizoda gate: bez potvrđenog video_h264.mp4 na R2 → SKIP (ne briše).
 *
 * ⚠️ PREDUVJET: Flutter `data_service.dart resolveVideoUri()` probe-a video_h264.mp4
 *   i tek na 404 fallback-a na video.mp4. Uz 100% h264 pokrivenost probe uvijek
 *   pogodi → fallback se praktički ne koristi. Nakon brisanja, fallback path postaje
 *   mrtav (404) SAMO ako h264 HEAD transientno padne (mreža/CORS). Prihvatljivo uz
 *   punu pokrivenost; ako želiš nula rizika, prvo makni fallback u appu.
 *
 *   node delete_legacy_video_mp4.js              # DRY-RUN (plan + oslobođeni prostor)
 *   node delete_legacy_video_mp4.js --confirm    # stvarno briše
 *   node delete_legacy_video_mp4.js --confirm --channel-prefix data/ABC  # podskup (po prefiksu ključa)
 */
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function getArg(name, def = null) { const i = args.indexOf(name); return i !== -1 && i + 1 < args.length ? args[i + 1] : def; }
const CONFIRM     = args.includes("--confirm");
const CONCURRENCY = parseInt(getArg("--concurrency", "8"), 10);   // HEAD+DELETE su mrežno-laki
const KEY_PREFIX  = getArg("--key-prefix", "data/");

(function loadEnv() {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
})();

const S3 = require("@aws-sdk/client-s3");
const client = new S3.S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const BUCKET = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";

function human(b) {
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
    return `${(b / 1073741824).toFixed(2)} GB`;
}
async function head(key) { try { return await client.send(new S3.HeadObjectCommand({ Bucket: BUCKET, Key: key })); } catch { return null; } }

// 1) Skupi sve legacy video.mp4 ključeve (+veličine) listanjem bucketa.
async function listLegacy() {
    const items = []; let token, pages = 0;
    process.stdout.write("Listam legacy video.mp4");
    do {
        const resp = await client.send(new S3.ListObjectsV2Command({ Bucket: BUCKET, Prefix: KEY_PREFIX, ContinuationToken: token }));
        for (const o of resp.Contents || []) {
            if (o.Key.endsWith("/video.mp4")) items.push({ key: o.Key, size: o.Size || 0, h264: o.Key.replace(/\/video\.mp4$/, "/video_h264.mp4") });
        }
        token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        if (++pages % 10 === 0) process.stdout.write(".");
    } while (token);
    process.stdout.write("\n");
    return items;
}

async function runPool(items, worker, n) {
    let i = 0; const out = [];
    const runner = async () => { while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx], idx); } };
    await Promise.all(Array.from({ length: Math.max(1, n) }, runner));
    return out;
}

(async () => {
    const legacy = await listLegacy();
    console.log(`Pronađeno ${legacy.length} legacy video.mp4 ključeva.\n`);
    if (!legacy.length) return;

    let deleted = 0, freed = 0, skippedNoH264 = 0, wouldDelete = 0, wouldFree = 0;
    let done = 0;
    await runPool(legacy, async (it) => {
        const h = await head(it.h264);              // gate: h264 mora postojati
        if (!h) { skippedNoH264++; }
        else if (CONFIRM) {
            await client.send(new S3.DeleteObjectCommand({ Bucket: BUCKET, Key: it.key }));
            deleted++; freed += it.size;
        } else { wouldDelete++; wouldFree += it.size; }
        if (++done % 200 === 0) process.stdout.write(`  …${done}/${legacy.length}\n`);
    }, CONCURRENCY);

    console.log("\n=== SAŽETAK ===");
    if (CONFIRM) {
        console.log(`  Obrisano video.mp4:        ${deleted}`);
        console.log(`  Oslobođeno:                ${human(freed)}`);
    } else {
        console.log(`  [DRY-RUN] Bi obrisalo:     ${wouldDelete}`);
        console.log(`  [DRY-RUN] Bi oslobodilo:   ${human(wouldFree)}`);
        console.log(`  → pokreni s --confirm za stvarno brisanje`);
    }
    console.log(`  Preskočeno (nema h264):    ${skippedNoH264}  ${skippedNoH264 ? "⚠️ ovima video.mp4 ostaje (sigurnosni gate)" : ""}`);
})();
