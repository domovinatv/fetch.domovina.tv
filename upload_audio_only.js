#!/usr/bin/env node
/**
 * upload_audio_only.js
 * ────────────────────
 * Za AUDIO-ONLY epizode (nemaju YouTube video → nema `video_h264.mp4`) uploada izvorni
 * `{base}.mp3` na R2 pod ključem **`data/{videoId}/audio.mp3`** da player ima što svirati.
 *
 * Detekcija audio-only: `info.json._yt_matched === false` (beamly subclub/launched —
 * epizode bez YouTube matcha; vidi [[beamly-audio-only-yt-matched-marker]]). YouTube
 * epizode (_yt_matched undefined/true) imaju audio u `video_h264.mp4` → NE uploadaju .mp3.
 *
 * CONSUMER (domovina.ai, zaseban repo): `data_service.dart` mora dobiti audio fallback —
 * ako `video_h264.mp4` (i legacy `video.mp4`) vrate 404, probati `data/{id}/audio.mp3` i
 * svirati preko `background_audio` servisa. + `CdnConfig.audioUrl(ytId)`. Vidi docs/data_contract.md.
 *
 * IDEMPOTENTNO: reuse `.r2_keys_cache.json` (kao upload_to_r2) → preskoči ako je ključ već
 * u cacheu; inače LIST-seed (ako nema cache-a). Novouploadani ključ se dopisuje u cache.
 *
 *   node upload_audio_only.js [--channel subclub,launched] [--video-id ID] [--dry-run] [--verify-r2]
 */
const fs = require("fs");
const path = require("path");

(() => { const p = path.join(__dirname, ".env"); if (!fs.existsSync(p)) return;
    for (const l of fs.readFileSync(p, "utf-8").split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } })();

const _S3 = require("@aws-sdk/client-s3");
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";
const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";
const KEYS_CACHE_PATH = path.join(__dirname, ".r2_keys_cache.json");

const args = process.argv.slice(2);
const getArg = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : d; };
const hasFlag = (n) => args.includes(n);
const OUTPUT_DIR = getArg("--input-dir", path.join(__dirname, "storage", "output"));
const CHANNELS = (getArg("--channel") || "subclub,launched").split(",").map(s => s.trim()).filter(Boolean);
const ONLY_VID = getArg("--video-id");
const DRY_RUN = hasFlag("--dry-run");
const VERIFY_R2 = hasFlag("--verify-r2");

function extractVideoId(name) { const m = name.match(/.*_yt_([A-Za-z0-9_-]{11})(?:[._]|$)/); return m ? m[1] : null; }
function s3() { return new _S3.S3Client({ region: "auto", endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } }); }

function loadKeysCache() { try { if (fs.existsSync(KEYS_CACHE_PATH)) { const a = JSON.parse(fs.readFileSync(KEYS_CACHE_PATH, "utf-8")); if (Array.isArray(a)) return new Set(a); } } catch {} return null; }
function saveKeysCache(set) { try { fs.writeFileSync(KEYS_CACHE_PATH, JSON.stringify([...set]), "utf-8"); } catch {} }

async function listAllKeys(client) {
    const keys = new Set(); let token, pages = 0;
    do { const r = await client.send(new _S3.ListObjectsV2Command({ Bucket: R2_BUCKET, ContinuationToken: token, MaxKeys: 1000 }));
        for (const o of r.Contents || []) keys.add(o.Key); token = r.IsTruncated ? r.NextContinuationToken : undefined;
        if (++pages % 10 === 0) process.stdout.write(`\r   📋 LIST str ${pages} (${keys.size})   `);
    } while (token); process.stdout.write("\n"); return keys;
}

(async () => {
    console.log(`\n🎧 Audio-only .mp3 upload — kanali: ${CHANNELS.join(", ")}${DRY_RUN ? " | DRY-RUN" : ""}`);
    const client = (R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID) ? s3() : null;
    if (!client) { console.error("❌ Nema R2 credentials (.env)"); process.exit(1); }

    let keySet = VERIFY_R2 ? null : loadKeysCache();
    if (keySet) console.log(`   ⚡ keys-cache: ${keySet.size} ključeva (BEZ LIST-a).`);
    else { console.log(`   📋 ${VERIFY_R2 ? "--verify-r2" : "nema cache"} → LIST...`); keySet = await listAllKeys(client); if (!DRY_RUN) saveKeysCache(keySet); }

    // Discovery: audio-only epizode (_yt_matched===false) s .mp3 na disku.
    const tasks = [];
    for (const ch of CHANNELS) {
        let entries; try { entries = fs.readdirSync(path.join(OUTPUT_DIR, ch)); } catch { continue; }
        for (const f of entries) {
            if (!f.endsWith(".info.json") || f.startsWith("._")) continue;
            const base = f.replace(/\.info\.json$/, ""); const vid = extractVideoId(base);
            if (!vid || (ONLY_VID && vid !== ONLY_VID)) continue;
            let info; try { info = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, ch, f), "utf-8")); } catch { continue; }
            if (info._yt_matched !== false) continue;             // samo audio-only
            const mp3 = path.join(OUTPUT_DIR, ch, `${base}.mp3`);
            if (!fs.existsSync(mp3)) continue;
            tasks.push({ ch, vid, mp3, key: `data/${vid}/audio.mp3` });
        }
    }

    const pending = tasks.filter(t => !keySet.has(t.key));
    console.log(`   🔎 Audio-only: ${tasks.length} | već na R2 (cache): ${tasks.length - pending.length} | ZA UPLOAD: ${pending.length}`);

    let ok = 0, fail = 0, n = 0; const t0 = Date.now();
    for (const t of pending) {
        n++;
        if (DRY_RUN) { console.log(`   [dry] ${t.ch}/${t.vid} → ${t.key}`); continue; }
        try {
            const size = fs.statSync(t.mp3).size;
            await client.send(new _S3.PutObjectCommand({ Bucket: R2_BUCKET, Key: t.key,
                Body: fs.createReadStream(t.mp3), ContentType: "audio/mpeg", ContentLength: size,
                CacheControl: CACHE_CONTROL_IMMUTABLE }));
            keySet.add(t.key); ok++;
            const eta = ((Date.now() - t0) / n * (pending.length - n) / 1000 / 60).toFixed(0);
            console.log(`   ⬆️ [${n}/${pending.length}] ${t.key} (${(size / 1e6).toFixed(1)} MB, ETA ~${eta}min)`);
        } catch (e) { console.log(`   ❌ ${t.key}: ${e.message}`); fail++; }
    }
    if (!DRY_RUN && ok) saveKeysCache(keySet);
    console.log(`\n   ✓ Gotovo: ${ok} uploadano, ${fail} neuspjelo, ${tasks.length - pending.length} preskočeno (cache).`);
})();
