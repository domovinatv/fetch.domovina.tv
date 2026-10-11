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
 *   1b. Remux    → {base}.web.fmp4.mp4 → R2 data/{videoId}/video_h264_fmp4.mp4
 *                 (iste struje, fragmentirani MP4 + sidx; vidi „Brzi start" niže)
 *   2. Upload    → R2 data/{videoId}/video_h264.mp4   (HEAD-skip ako isti size)
 *   3. Delete    → R2 data/{videoId}/video.mp4   [--delete-old, gateano]
 *
 * BRZI START (od 2026-10-11): `video_h264.mp4` ima faststart, ali `moov` indeksira
 * SVAKI uzorak — za epizodu od 1 h to je 2,7 MB koje player mora povući prije
 * prvog framea (15,9 s na Chromeovom „Slow 4G"). Isti bajtovi prepakirani u
 * fragmentirani MP4 sa `sidx` imaju zaglavlje od ~11 KB → prvi frame za 2,6 s,
 * nastavak od 30:00 za 5,9 s umjesto 17,1 s. Bez `sidx` Chrome skenira fragment
 * po fragment i ne krene ni u 2 min — zato `verifyFmp4` odbija izlaz bez njega.
 * `video_h264.mp4` ostaje (fallback, cutter, stari buildovi); fmp4 je dodatak koji
 * klijent bira samo kad ga `episode.json` navodi. Fmp4 se uploada PRIJE
 * video_h264.mp4: skip-on-r2 gleda video_h264 ključ, pa bi obrnut redoslijed uz
 * pad između dva uploada ostavio epizodu trajno bez fmp4.
 * Stari katalog se NE backfilla; pojedinačno: --fmp4-only --video-id ID[,ID2].
 * Vidi domovina.ai docs/2026-10-11-brzi-start-videa-fmp4.md.
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
 *   node backfill_video_h264.js --web-output-dir /Volumes/DOMOVINA2TB/web_mp4_h264   # ČUVAJ lokalne kopije (bez --rm-local) na disku s mjesta
 *   node backfill_video_h264.js --fmp4-only --video-id ID1,ID2   # samo fmp4 iz video_h264.mp4 s R2 (bez lokalnog sourcea)
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
// Jedan ID ili lista odvojena zarezima.
const ONLY_VIDEO_IDS = getArg("--video-id") ? new Set(getArg("--video-id").split(",").map(x => x.trim()).filter(Boolean)) : null;
const CONCURRENCY   = parseInt(getArg("--concurrency", "2"), 10);   // USB volume → drži nisko (memory)
const CRF           = getArg("--crf", "30");
// Ako je zadan, web.mp4 se pišu ovdje (po kanalu: {dir}/{channel}/{base}.web.mp4)
// umjesto pored sourcea. Koristi se da se lokalne kopije čuvaju na disku s mjesta
// (DOMOVINA2TB) umjesto da pune tijesni source-disk (DOMOVINA1TB → ENOSPC rizik).
const WEB_OUT_DIR   = getArg("--web-output-dir");
const LIMIT         = parseInt(getArg("--limit", "0"), 10);
const DRY_RUN       = hasFlag("--dry-run");
const TRANSCODE_ONLY= hasFlag("--transcode-only");
const UPLOAD_ONLY   = hasFlag("--upload-only");
const DELETE_OLD    = hasFlag("--delete-old");
const ONLY_PUBLISHED= hasFlag("--only-published");   // procesiraj samo ako video.mp4 već postoji na R2
const RM_LOCAL      = hasFlag("--rm-local-after-upload"); // štedi disk (memory: ENOSPC rizik)
const KEEP_GOING    = hasFlag("--keep-going") || true;    // nastavi na greškama (default da)
const FORCE         = hasFlag("--force");
const VERIFY_R2     = hasFlag("--verify-r2");  // pravi LIST + rebuild video keys-cache (umjesto čitanja cachea)
const FMP4_ONLY     = hasFlag("--fmp4-only");  // samo fmp4: povuci video_h264.mp4 s R2, remux, upload (traži --video-id)
const NO_FMP4       = hasFlag("--no-fmp4");    // isključi fmp4 korak (samo video_h264.mp4, kao prije 2026-10-11)
const FMP4_TMP_DIR  = getArg("--fmp4-tmp-dir", path.join(require("os").tmpdir(), "domovina_fmp4"));

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
async function r2Download(key, file) {
    const resp = await s3().send(new _S3.GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const tmp = `${file}.part`;
    await require("stream/promises").pipeline(resp.Body, fs.createWriteStream(tmp));
    fs.renameSync(tmp, file);
}
async function r2Delete(key) { await s3().send(new _S3.DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })); }

// ─── R2 prefetch (LIST umjesto per-epizodi HEAD) ──────────────────
// Optimizacija (2026-06-08): jedan paginiran ListObjectsV2 (prefix data/, 1000/str)
// → Map ključ→veličina za sve video_h264.mp4 (+ legacy video.mp4). Zamjenjuje ~N
// per-epizodi HEAD-ova (Class B read) s ~N/1000 LIST poziva (Class A). Na ~2700
// epizoda: ~3 LIST stranice umjesto ~2700 HEAD-ova. Isti pattern kao
// upload_to_r2.js listAllR2Keys. LIST vraća SAMO metapodatke (ključ+veličina), NE
// skida sadržaj. R2_INDEX=null → processEpisode fallback-a na r2Head (npr. no-creds).
let R2_INDEX = null;
let cacheDirty = false;
// Lokalni cache R2 video ključeva (key→size) — isti princip kao upload_to_r2 .r2_keys_cache.json,
// ali ovdje treba i VELIČINU (size-skip). Default run čita cache (BEZ data/ LIST-a koji raste s
// katalogom); --verify-r2 radi pravi LIST + rebuild. Novi video_h264 ključevi se dopisuju.
const VIDEO_CACHE_PATH = path.join(__dirname, ".r2_video_cache.json");
function loadVideoCache() {
    try { if (fs.existsSync(VIDEO_CACHE_PATH)) { const o = JSON.parse(fs.readFileSync(VIDEO_CACHE_PATH, "utf-8"));
        if (o && typeof o === "object") return new Map(Object.entries(o).map(([k, v]) => [k, Number(v)])); } } catch {}
    return null;
}
function saveVideoCache(map) {
    try { fs.writeFileSync(VIDEO_CACHE_PATH, JSON.stringify(Object.fromEntries(map)), "utf-8"); } catch {}
}
async function prefetchR2Index() {
    const client = s3();   // inicijalizira i _S3
    const map = new Map();
    let token, pages = 0;
    do {
        const resp = await client.send(new _S3.ListObjectsV2Command({
            Bucket: R2_BUCKET, Prefix: "data/", ContinuationToken: token, MaxKeys: 1000,
        }));
        for (const o of resp.Contents || []) {
            if (o.Key.endsWith("/video_h264.mp4") || o.Key.endsWith("/video.mp4") || o.Key.endsWith("/" + FMP4_NAME))
                map.set(o.Key, Number(o.Size));
        }
        token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        if (++pages % 10 === 0) process.stdout.write(`\r   📋 LIST str. ${pages} (${map.size} video ključeva)   `);
    } while (token);
    if (pages >= 10) process.stdout.write("\n");
    return map;
}

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
            if (ONLY_VIDEO_IDS && !ONLY_VIDEO_IDS.has(vid)) continue;
            const mkv = path.join(chDir, `${base}.mkv`);
            const mp4 = path.join(chDir, `${base}.mp4`);
            const src = fs.existsSync(mkv) ? mkv : (fs.existsSync(mp4) ? mp4 : null);
            if (!src) continue;
            const webMp4 = WEB_OUT_DIR
                ? path.join(WEB_OUT_DIR, ch, `${base}.web.mp4`)
                : path.join(chDir, `${base}.web.mp4`);
            eps.push({ channel: ch, base, videoId: vid, src, chDir, webMp4,
                       fmp4: webMp4.replace(/\.web\.mp4$/, ".web.fmp4.mp4"),
                       keyFmp4: `data/${vid}/${FMP4_NAME}`,
                       keyNew: `data/${vid}/video_h264.mp4`,
                       keyOld: `data/${vid}/video.mp4` });
        }
    }
    eps.sort((a, b) => b.base.localeCompare(a.base));   // najnovije prvo
    return LIMIT > 0 ? eps.slice(0, LIMIT) : eps;
}

function ffmpegTranscode(src, out) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(out), { recursive: true });   // za --web-output-dir
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

// ─── Fragmentirani MP4 (brzi start) ───────────────────────────────
const FMP4_NAME = "video_h264_fmp4.mp4";
// `global_sidx` je ono što radi: bez njega Chrome ne zna gdje je koji fragment i
// skenira datoteku (izmjereno: 140 range zahtjeva, nije krenuo u 120 s).
const FMP4_MOVFLAGS = "+frag_keyframe+empty_moov+default_base_moof+global_sidx";
// Zaglavlje (ftyp+moov+sidx) za 1 h je ~11 KB; prag ostavlja mjesta za epizode
// od više sati, a i dalje hvata slučaj da je ffmpeg pao natrag na klasični moov.
const FMP4_MAX_HEADER = 512 * 1024;

function ffmpegRemuxFmp4(src, out) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const tmp = out.replace(/\.mp4$/, ".tmp.mp4");
        const p = spawn("ffmpeg", [
            "-nostdin", "-v", "error", "-y", "-i", src,
            "-map", "0", "-c", "copy",
            "-movflags", FMP4_MOVFLAGS, tmp,
        ]);
        let err = "";
        p.stderr.on("data", d => { err += d.toString(); });
        p.on("close", code => {
            if (code !== 0) { try { fs.unlinkSync(tmp); } catch {} return reject(new Error(err.slice(-400))); }
            try { verifyFmp4(tmp); } catch (e) { try { fs.unlinkSync(tmp); } catch {} return reject(e); }
            fs.renameSync(tmp, out); resolve();
        });
        p.on("error", reject);
    });
}

/**
 * Ugovor brzog starta, provjeren nad bajtovima: ftyp → moov (malen) → sidx →
 * prvi moof, sve prije ijednog mdat-a. Baca ako išta od toga ne vrijedi.
 */
function topLevelBoxes(buf) {
    const boxes = [];
    let o = 0;
    while (o + 8 <= buf.length) {
        let size = buf.readUInt32BE(o);
        const type = buf.toString("latin1", o + 4, o + 8);
        if (size === 1) size = Number(buf.readBigUInt64BE(o + 8));
        boxes.push({ type, offset: o, size });
        if (size < 8) break;
        o += size;
    }
    return boxes;
}
function verifyFmp4(file) {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(FMP4_MAX_HEADER + 16);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const boxes = topLevelBoxes(buf.subarray(0, n));
    const types = boxes.map(b => b.type);
    const firstMoof = types.indexOf("moof");
    const firstMdat = types.indexOf("mdat");
    if (types[0] !== "ftyp" || types[1] !== "moov")
        throw new Error(`fmp4: očekivan ftyp+moov na početku, a ima ${types.slice(0, 4).join(",")}`);
    if (!types.includes("sidx") || types.indexOf("sidx") > firstMoof)
        throw new Error(`fmp4: nema sidx prije prvog fragmenta (${types.slice(0, 6).join(",")})`);
    if (firstMoof === -1 || (firstMdat !== -1 && firstMdat < firstMoof))
        throw new Error(`fmp4: nema moof u prvih ${FMP4_MAX_HEADER} B ili mdat dolazi prije njega`);
    return { header: boxes[firstMoof].offset };
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
        const oldOn = R2_INDEX ? R2_INDEX.has(ep.keyOld) : !!(await r2Head(ep.keyOld));
        const newOn = R2_INDEX ? R2_INDEX.has(ep.keyNew) : !!(await r2Head(ep.keyNew));
        if (!oldOn && !newOn)
            return { ...ep, status: "skip-unpublished" };
    }

    // Idempotentnost preko R2: ako video_h264.mp4 već postoji na R2, preskoči cijelu
    // epizodu (i transcode i upload). Omogućava --rm-local-after-upload bez ponovnog
    // transkodiranja na re-runu/nightlyju (lokalni web.mp4 ne mora postojati). --force gazi.
    if (!FORCE && !TRANSCODE_ONLY && !DRY_RUN) {
        const onR2 = R2_INDEX ? R2_INDEX.has(ep.keyNew) : !!(await r2Head(ep.keyNew));
        if (onR2) {
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

    // 1b. Fmp4 (brzi start) — PRIJE video_h264.mp4, vidi zaglavlje. Pad nije
    // fatalan: klijent bez fmp4 u bundleu pušta video_h264.mp4 kao i dosad.
    let fmp4Status = NO_FMP4 ? "off" : "ok";
    if (!NO_FMP4) {
        try {
            await ffmpegRemuxFmp4(ep.webMp4, ep.fmp4);
            await r2Put(ep.keyFmp4, ep.fmp4);
            console.log(`${tag} ✓ fmp4 → ${R2_PUBLIC}/${ep.keyFmp4}`);
            if (R2_INDEX) { R2_INDEX.set(ep.keyFmp4, fs.statSync(ep.fmp4).size); cacheDirty = true; }
        } catch (e) {
            fmp4Status = "fail";
            console.error(`${tag} ⚠️  fmp4 nije napravljen (${e.message}) — ostaje samo video_h264.mp4`);
        } finally {
            try { fs.unlinkSync(ep.fmp4); } catch {}
        }
    }

    // 2. Upload (size-skip ako isti size — iz R2_INDEX, fallback HEAD)
    const localSize = fs.statSync(ep.webMp4).size;
    let remoteSize;
    if (R2_INDEX) {
        remoteSize = R2_INDEX.has(ep.keyNew) ? R2_INDEX.get(ep.keyNew) : null;
    } else {
        const head = await r2Head(ep.keyNew);
        remoteSize = head ? Number(head.ContentLength) : null;
    }
    if (remoteSize === localSize) {
        console.log(`${tag} · već na R2 (isti size), skip upload`);
    } else {
        await r2Put(ep.keyNew, ep.webMp4);
        console.log(`${tag} ✓ upload → ${R2_PUBLIC}/${ep.keyNew}`);
        if (R2_INDEX) { R2_INDEX.set(ep.keyNew, localSize); cacheDirty = true; }  // dopuni keys-cache
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
    return { ...ep, status: fmp4Status === "fail" ? "done-bez-fmp4" : "done" };
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

// ─── --fmp4-only: video_h264.mp4 s R2 → fmp4 → R2 ─────────────────
// Za epizode čiji je video_h264.mp4 nastao prije fmp4 koraka (lokalni web.mp4 je
// obrisan s --rm-local-after-upload). Ne treba lokalni source.
async function fmp4FromR2(vid, idx, total) {
    const tag = `[${idx + 1}/${total}] ${vid}`;
    const keySrc = `data/${vid}/video_h264.mp4`, keyOut = `data/${vid}/${FMP4_NAME}`;
    if (!FORCE && await r2Head(keyOut)) { console.log(`${tag} · ${FMP4_NAME} već na R2, skip`); return { videoId: vid, status: "skip-on-r2" }; }
    if (!await r2Head(keySrc)) { console.log(`${tag} · nema video_h264.mp4 na R2`); return { videoId: vid, status: "no-source" }; }
    if (DRY_RUN) { console.log(`${tag} bi napravio ${keyOut}`); return { videoId: vid, status: "dry" }; }
    fs.mkdirSync(FMP4_TMP_DIR, { recursive: true });
    const src = path.join(FMP4_TMP_DIR, `${vid}.src.mp4`), out = path.join(FMP4_TMP_DIR, `${vid}.fmp4.mp4`);
    try {
        await r2Download(keySrc, src);
        await ffmpegRemuxFmp4(src, out);
        const { header } = verifyFmp4(out);
        await r2Put(keyOut, out);
        console.log(`${tag} ✓ fmp4 (zaglavlje ${(header / 1024).toFixed(1)} KB) → ${R2_PUBLIC}/${keyOut}`);
        return { videoId: vid, status: "done" };
    } finally {
        for (const f of [src, out]) { try { fs.unlinkSync(f); } catch {} }
    }
}

// ─── Main ─────────────────────────────────────────────────────────
(async () => {
    if (FMP4_ONLY) {
        if (!ONLY_VIDEO_IDS) { console.error("--fmp4-only traži --video-id ID[,ID2,...] (katalog se namjerno ne backfilla)"); process.exit(2); }
        const ids = [...ONLY_VIDEO_IDS];
        const res = await runPool(ids.map(videoId => ({ videoId })), (ep, i, n) => fmp4FromR2(ep.videoId, i, n), CONCURRENCY);
        const by = res.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
        console.log("\n=== SAŽETAK (fmp4) ===");
        for (const [k, v] of Object.entries(by)) console.log(`  ${k}: ${v}`);
        if (res.some(r => r.status === "FAIL")) process.exitCode = 1;
        return;
    }
    if (DELETE_OLD && !DRY_RUN) {
        console.log("⚠️  --delete-old: brišem stari video.mp4 SAMO ako video_h264.mp4 postoji na R2.");
        console.log("⚠️  Provjeri da Flutter cdn_config.dart pokazuje na video_h264.mp4 i da je app deployan!\n");
    }
    const eps = discover();
    console.log(`Pronađeno ${eps.length} epizoda${ONLY_CHANNEL ? ` (kanal ${ONLY_CHANNEL})` : ""}.`);
    if (!eps.length) return;

    // R2 prefetch: jedan LIST umjesto ~N HEAD-ova (Class B → Class A). Preskoči ako
    // nema R2 interakcije (--transcode-only) ili nema R2 credsa → fallback na HEAD.
    if (!TRANSCODE_ONLY && R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID) {
        const cached = VERIFY_R2 ? null : loadVideoCache();
        if (cached) {
            R2_INDEX = cached;
            console.log(`⚡ R2 video ključevi iz cache-a: ${R2_INDEX.size} (BEZ data/ LIST-a). Prava provjera: --verify-r2.`);
        } else {
            console.log(`📋 ${VERIFY_R2 ? "--verify-r2: " : ""}LIST R2 (data/ video ključevi) — paginirano...`);
            try {
                R2_INDEX = await prefetchR2Index();
                saveVideoCache(R2_INDEX);   // seed je čisti R2-read → spremi i u dry-run
                console.log(`📊 R2 ima ${R2_INDEX.size} video ključeva (cache osvježen)`);
            } catch (e) {
                console.log(`⚠️  R2 LIST nije uspio (${e.message}) — fallback na per-epizodi HEAD`);
                R2_INDEX = null;
            }
        }
    }

    const res = await runPool(eps, processEpisode, CONCURRENCY);

    // Dopiši novouploadane video ključeve u cache (default put bez LIST-a ostaje točan).
    if (cacheDirty && !DRY_RUN && R2_INDEX) saveVideoCache(R2_INDEX);

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
