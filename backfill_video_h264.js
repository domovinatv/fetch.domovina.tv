#!/usr/bin/env node
/**
 * backfill_video_h264.js
 * ───────────────────────
 * Re-transkodira cijeli katalog u STVARNI cross-platform H.264 video, uploada na
 * R2 pod verzioniranim ključem `data/{videoId}/video_h264.mp4` i (opcionalno)
 * briše stari VP9/AV1 `data/{videoId}/video.mp4`.
 *
 * Pozadina i odluke: docs/video_crossplatform_strategy_2026-06.md
 *   - Stari video.mp4 = VP9/AV1-u-mp4 (remux -c:v copy) → ne svira na Safari/iOS web
 *     ni starijim TV-ima bez AV1 HW (~84% kataloga).
 *   - Fix = re-encode u H.264 Main L3.1 + AAC + faststart + EQ_IZRAZENIJI (libx264 crf30).
 *
 * FAZE (po epizodi, pipelinano):
 *   1. Transcode → {base}.web.mp4   (idempotent; preskače ako je svjež; atomski tmp→rename)
 *   2. Upload    → R2 data/{videoId}/video_h264.mp4   (HEAD-skip ako isti size)
 *   3. Delete    → R2 data/{videoId}/video.mp4   [--delete-old, gateano]
 *
 * ⚠️  PREDUVJET ZA --delete-old:
 *     Flutter `lib/services/cdn_config.dart` videoUrl MORA pokazivati na
 *     `video_h264.mp4` I app mora biti DEPLOYAN prije brisanja, inače brišeš
 *     live video starim klijentima. Skripta dodatno odbija brisati ako
 *     video_h264.mp4 nije potvrđen na R2 (HEAD 200).
 *
 * ✅  UPSTREAM FIX (riješeno): ova skripta je uvezana kao KORAK 12.5 u run_pipeline.sh
 *     (iza upload_to_r2.js, uz --with-r2-upload). Nightly tako svaku NOVU epizodu
 *     transkodira u H.264 i uploada video_h264.mp4 — ne regresira na VP9/AV1. Recept
 *     živi SAMO ovdje (SSOT); upload_to_r2.js remuxPhase i dalje puni legacy video.mp4
 *     (`-c:v copy`) koji ostaje kao fallback dok se catalog-wide --delete-old ne pokrene.
 *
 * Primjeri:
 *   node backfill_video_h264.js --dry-run                 # plan, bez ičega
 *   node backfill_video_h264.js --channel domovina_tv     # jedan kanal: transcode+upload
 *   node backfill_video_h264.js --concurrency 2           # cijeli katalog
 *   node backfill_video_h264.js --only-published          # samo epizode koje imaju live video.mp4 na R2
 *   node backfill_video_h264.js --delete-old --channel domovina_tv   # TEK nakon app cutover-a
 *   node backfill_video_h264.js --upload-only             # preskoči transcode (web.mp4 već postoje)
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ─── CLI (Pattern B) ──────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def = null) {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : def;
}
function hasFlag(name) { return args.includes(name); }

const OUTPUT_DIR    = getArg("--input-dir", path.join(__dirname, "storage", "output"));
const ONLY_CHANNEL  = getArg("--channel");
const ONLY_VIDEO_ID = getArg("--video-id");
const CONCURRENCY   = parseInt(getArg("--concurrency", "2"), 10);   // USB volume → drži nisko (memory)
const CRF           = getArg("--crf", "30");
const LIMIT         = parseInt(getArg("--limit", "0"), 10);
const DRY_RUN       = hasFlag("--dry-run");
const TRANSCODE_ONLY= hasFlag("--transcode-only");
const UPLOAD_ONLY   = hasFlag("--upload-only");
const DELETE_OLD    = hasFlag("--delete-old");
const ONLY_PUBLISHED= hasFlag("--only-published");   // procesiraj samo ako video.mp4 već postoji na R2
const RM_LOCAL      = hasFlag("--rm-local-after-upload"); // štedi disk (memory: ENOSPC rizik)
const KEEP_GOING    = hasFlag("--keep-going") || true;    // nastavi na greškama (default da)
const FORCE         = hasFlag("--force");

// EQ_IZRAZENIJI (high-pass 100 + low-shelf −4@200 + presence +2@3.2k) PRIJE loudnorm-a.
const AUDIO_FILTER =
    "highpass=f=100,bass=g=-4:f=200:w=0.7,equalizer=f=3200:width_type=q:w=1.2:g=2," +
    "loudnorm=I=-16:TP=-2:LRA=11:linear=false";

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
const R2_PUBLIC     = process.env.R2_PUBLIC_URL  || "https://cdn.domovina.ai";

// ─── R2 klijent (lazy; samo ako nije transcode-only/dry) ──────────
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
async function r2Put(key, file) {
    const size = fs.statSync(file).size;
    await s3().send(new _S3.PutObjectCommand({
        Bucket: R2_BUCKET, Key: key,
        Body: fs.createReadStream(file), ContentLength: size,
        ContentType: "video/mp4",
        CacheControl: "public, max-age=31536000, immutable",   // verzioniran ključ → smije immutable
    }));
    return size;
}
async function r2Delete(key) { await s3().send(new _S3.DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })); }

// ─── Util ─────────────────────────────────────────────────────────
function extractVideoId(base) {
    const m = base.match(/_yt_([A-Za-z0-9_-]{11})$/);
    return m ? m[1] : null;
}
// Symlink-aware listanje kanala (storage/output/{ch} može biti symlink — memory)
function listDirs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("._"))
        .map(e => e.name);
}
function isFragment(stem) { return /\.f\d+$/.test(stem) || stem.endsWith(".loudnorm"); }

// Discovery: za svaki kanal nađi epizode + najbolji source (mkv > mp4).
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
            const stem = m[1];
            if (isFragment(stem)) continue;       // .fNNN / .loudnorm
            bases.add(stem);
        }
        for (const base of bases) {
            const vid = extractVideoId(base);
            if (!vid) continue;
            if (ONLY_VIDEO_ID && vid !== ONLY_VIDEO_ID) continue;
            const mkv = path.join(chDir, `${base}.mkv`);
            const mp4 = path.join(chDir, `${base}.mp4`);
            const src = fs.existsSync(mkv) ? mkv : (fs.existsSync(mp4) ? mp4 : null);
            if (!src) continue;
            eps.push({ channel: ch, base, videoId: vid, src, chDir,
                       webMp4: path.join(chDir, `${base}.web.mp4`),
                       keyNew: `data/${vid}/video_h264.mp4`,
                       keyOld: `data/${vid}/video.mp4` });
        }
    }
    eps.sort((a, b) => b.base.localeCompare(a.base));   // najnovije prvo
    return LIMIT > 0 ? eps.slice(0, LIMIT) : eps;
}

function ffmpegTranscode(src, out) {
    return new Promise((resolve, reject) => {
        const tmp = out.replace(/\.web\.mp4$/, ".web.tmp.mp4");
        const p = spawn("ffmpeg", [
            "-nostdin", "-v", "error", "-y", "-i", src,
            "-map", "0:v:0", "-map", "0:a:0",
            "-c:v", "libx264", "-preset", "medium", "-crf", String(CRF),
            "-profile:v", "main", "-level", "3.1", "-pix_fmt", "yuv420p",
            "-af", AUDIO_FILTER,
            "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
            "-movflags", "+faststart", tmp,
        ]);
        let err = "";
        p.stderr.on("data", d => { err += d.toString(); });
        p.on("close", code => {
            if (code === 0) { fs.renameSync(tmp, out); resolve(); }       // atomski
            else { try { fs.unlinkSync(tmp); } catch {} reject(new Error(err.slice(-400))); }
        });
        p.on("error", reject);
    });
}

// Treba li (re)transkodirati: nema web.mp4, ili je stariji od source-a, ili --force.
function needsTranscode(ep) {
    if (FORCE) return true;
    if (!fs.existsSync(ep.webMp4)) return true;
    return fs.statSync(ep.webMp4).mtimeMs < fs.statSync(ep.src).mtimeMs;
}

// ─── Obrada jedne epizode ─────────────────────────────────────────
async function processEpisode(ep, idx, total) {
    const tag = `[${idx + 1}/${total}] ${ep.videoId}`;

    if (ONLY_PUBLISHED && !UPLOAD_ONLY) {
        if (!(await r2Head(ep.keyOld)) && !(await r2Head(ep.keyNew)))
            return { ...ep, status: "skip-unpublished" };
    }

    // Idempotentnost preko R2: ako video_h264.mp4 već postoji na R2, preskoči cijelu
    // epizodu (i transcode i upload). Omogućava --rm-local-after-upload bez ponovnog
    // transkodiranja na re-runu/nightlyju (lokalni web.mp4 ne mora postojati). --force gazi.
    if (!FORCE && !TRANSCODE_ONLY && !DRY_RUN) {
        if (await r2Head(ep.keyNew)) {
            console.log(`${tag} · već na R2 (video_h264.mp4), skip`);
            return { ...ep, status: "skip-on-r2" };
        }
    }

    // 1. Transcode
    if (!UPLOAD_ONLY) {
        if (needsTranscode(ep)) {
            if (DRY_RUN) { console.log(`${tag} bi transkodirao ${path.basename(ep.src)}`); }
            else { await ffmpegTranscode(ep.src, ep.webMp4);
                   console.log(`${tag} ✓ transcode ${(fs.statSync(ep.webMp4).size/1048576).toFixed(0)}MB`); }
        } else { console.log(`${tag} · web.mp4 svjež, preskačem transcode`); }
    }
    if (TRANSCODE_ONLY) return { ...ep, status: "transcoded" };
    if (DRY_RUN) { console.log(`${tag} bi uploadao → ${ep.keyNew}${DELETE_OLD ? `  + obrisao ${ep.keyOld}` : ""}`);
                   return { ...ep, status: "dry" }; }

    if (!fs.existsSync(ep.webMp4)) return { ...ep, status: "no-webmp4" };

    // 2. Upload (HEAD-skip ako isti size)
    const localSize = fs.statSync(ep.webMp4).size;
    const head = await r2Head(ep.keyNew);
    if (head && Number(head.ContentLength) === localSize) {
        console.log(`${tag} · već na R2 (isti size), skip upload`);
    } else {
        await r2Put(ep.keyNew, ep.webMp4);
        console.log(`${tag} ✓ upload → ${R2_PUBLIC}/${ep.keyNew}`);
    }

    // 3. Delete starog (gateano: tek ako je novi POTVRĐEN na R2)
    if (DELETE_OLD) {
        const confirm = await r2Head(ep.keyNew);
        if (!confirm) { console.log(`${tag} ⚠️  video_h264.mp4 nije na R2 — NE brišem stari`); }
        else if (await r2Head(ep.keyOld)) {
            await r2Delete(ep.keyOld);
            console.log(`${tag} ✗ obrisan stari ${ep.keyOld}`);
        }
    }

    if (RM_LOCAL && fs.existsSync(ep.webMp4)) { fs.unlinkSync(ep.webMp4); }
    return { ...ep, status: "done" };
}

// ─── Concurrency pool ─────────────────────────────────────────────
async function runPool(items, worker, n) {
    const out = []; let i = 0; const t0 = Date.now();
    const runner = async () => {
        while (i < items.length) {
            const idx = i++;
            try { out[idx] = await worker(items[idx], idx, items.length); }
            catch (e) {
                out[idx] = { ...items[idx], status: "FAIL", error: e.message };
                console.error(`[${idx + 1}/${items.length}] ${items[idx].videoId} ✗ ${e.message}`);
                if (!KEEP_GOING) throw e;
            }
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

// ─── Main ─────────────────────────────────────────────────────────
(async () => {
    if (DELETE_OLD && !DRY_RUN) {
        console.log("⚠️  --delete-old: brišem stari video.mp4 SAMO ako video_h264.mp4 postoji na R2.");
        console.log("⚠️  Provjeri da Flutter cdn_config.dart pokazuje na video_h264.mp4 i da je app deployan!\n");
    }
    const eps = discover();
    console.log(`Pronađeno ${eps.length} epizoda${ONLY_CHANNEL ? ` (kanal ${ONLY_CHANNEL})` : ""}.`);
    if (!eps.length) return;

    const res = await runPool(eps, processEpisode, CONCURRENCY);

    const by = res.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
    console.log("\n=== SAŽETAK ===");
    for (const [k, v] of Object.entries(by)) console.log(`  ${k}: ${v}`);
    const fails = res.filter(r => r.status === "FAIL");
    if (fails.length) {
        console.log(`\nNeuspjeli (${fails.length}):`);
        fails.slice(0, 20).forEach(f => console.log(`  ${f.videoId}  ${f.error}`));
        process.exitCode = 1;
    }
})();
