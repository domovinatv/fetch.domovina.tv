#!/usr/bin/env node

/**
 * upload_to_r2.js
 *
 * Uploadira pipeline outpute u Cloudflare R2 (S3-kompatibilan) za serviranje
 * putem cdn.domovina.ai (Cloudflare Edge CDN).
 *
 * Pre-upload faza: MKV → MP4 remux
 *   Pipeline proizvodi .mkv (merged video+audio, 360p) ali Flutter app treba
 *   .mp4 (H.264+AAC) za cross-platform kompatibilnost. Prije uploada, za svaki
 *   video koji ima .mkv ali nema .mp4, pokreće se:
 *     ffmpeg -i {base}.mkv -c:v copy -c:a aac -movflags +faststart {base}.mp4
 *   Video stream se kopira bez re-encodinga, samo audio ide u AAC.
 *
 * Uploadira finalne produkcijske datoteke:
 *   - .canary.diarized.srt       (diarizirana transkripcija)
 *   - .canary.summary.json       (sumarizacija)
 *   - .canary.summary.md         (sumarizacija u markdown formatu)
 *   - .article.json              (generirani članak)
 *   - .outline.json              (semantički outline)
 *   - .rag_combined.jsonl        (RAG chunkovi)
 *   - _screenshots/*.png         (screenshotovi iz videa)
 *   - _screenshots/_manifest.json
 *   - .og-sections/og-t-{sec}.jpg (Tier B per-section composite, 1200×630 progressive JPEG q=85)
 *   - .og-sections/manifest.json  (map sec → filename za worker)
 *   - .png (thumbnail, full-res)
 *   - .og-share.jpg (social-sharing varijanta, 1200×630 progressive JPEG q=85, < 600 KB za WhatsApp)
 *   - .mkv (originalni video, 360p)
 *   - .mp4 (remuxed video, H.264+AAC, faststart)
 *   - .info.json (YouTube metapodaci)
 *
 * NE uploadira:
 *   - .wav, .mp3, .webm, .f*.mp4 (audio/intermediate video)
 *   - _raw/ direktoriji           (debug/recovery)
 *   - _whisper_prompt.txt         (intermediate)
 *   - .canary.csv, .canary.srt   (intermediate)
 *   - .rag_chunks.jsonl, .rag_import.jsonl  (stare RAG varijante)
 *   - .description                (raw opis)
 *   - .blocked.json               (markeri za blokirani sadržaj)
 *
 * Načini pokretanja:
 *   1. Pojedinačni video po YouTube ID:
 *      node upload_to_r2.js --input-dir /path/to/output --video-id H-p2Hl6x7I0
 *
 *   2. Cijeli kanal:
 *      node upload_to_r2.js --input-dir /path/to/output --channel domovina_tv
 *
 *   3. Sve kanale:
 *      node upload_to_r2.js --input-dir /path/to/output
 *
 *   4. Dry run (prikaz bez uploada):
 *      node upload_to_r2.js --input-dir /path/to/output --dry-run
 *
 *   5. S limitom:
 *      node upload_to_r2.js --input-dir /path/to/output --channel domovina_tv --limit 5
 *
 *   6. S Flutter app keyevima (oba seta: pipeline + app-friendly):
 *      node upload_to_r2.js --input-dir /path/to/output --flutter-keys
 *      node upload_to_r2.js --input-dir /path/to/output --video-id X --flutter-keys --dry-run
 *
 * Flutter key mapping (--flutter-keys):
 *   Pipeline: {channel}/{base}.canary.summary.json  →  App: data/{videoId}/summary.json
 *   Pipeline: {channel}/{base}...article.json       →  App: data/{videoId}/article.json
 *   Pipeline: {channel}/{base}...outline.json       →  App: data/{videoId}/outline.json
 *   Pipeline: {channel}/{base}.canary.diarized.srt  →  App: data/{videoId}/diarized.srt
 *   Pipeline: {channel}/{base}.info.json            →  App: data/{videoId}/info.json
 *   Pipeline: {channel}/{base}.png                  →  App: images/{videoId}/thumbnail.png
 *   Pipeline: {channel}/{base}.og-share.jpg         →  App: images/{videoId}/og-share.jpg
 *   Pipeline: {channel}/{base}.mp4                  →  App: data/{videoId}/video.mp4
 *   Pipeline: {channel}/{base}_screenshots/{ts}.png →  App: images/{videoId}/screenshots/{ts}.png
 *   Pipeline: {channel}/{base}_screenshots/_manifest →  App: images/{videoId}/screenshots/manifest.json
 *   Pipeline: {channel}/{base}.og-sections/og-t-{sec}.jpg → App: images/{videoId}/og-t-{sec}.jpg
 *   Pipeline: {channel}/{base}.og-sections/manifest.json → App: images/{videoId}/og-sections.json
 *
 * Preduvjeti:
 *   - npm install @aws-sdk/client-s3
 *   - .env s R2 credentials (vidi .env.example)
 *   - ffmpeg (za MKV → MP4 remux; opcionalno — ako nije dostupan, preskače se)
 *
 * Idempotentnost:
 *   - Uspoređuje lokalni MD5 hash s ETag u R2
 *   - Preskače datoteke koje su već uploadane i nepromijenjene
 *   - Isti MD5 check za oba seta keyeva (pipeline + flutter)
 *   - Remux se preskače ako .mp4 postoji i nije stariji od .mkv
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync, spawn } = require("child_process");

// ─── .env UČITAVANJE (ručno, bez dotenv dependency) ──────────────

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
        if (!process.env[key]) {
            process.env[key] = val;
        }
    }
}

loadEnvFile();

// ─── KONFIGURACIJA ───────────────────────────────────────────────

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || "https://cdn.domovina.ai";

// FAZA 3: Cloudflare cache purge (nakon prepisivanja immutable .mp4 keyeva).
const CF_PURGE_TOKEN = process.env.DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE;
const CF_ZONE_NAME = "domovina.ai";

// Sufiksi datoteka koje se uploadaju (po video bazi)
const UPLOAD_SUFFIXES = [
    ".canary.diarized.srt",
    ".canary.summary.json",
    ".canary.summary.md",
    ".info.json",
    ".mkv",                     // originalni video (360p)
    ".mp4",                     // remuxed video (H.264+AAC, faststart)
    ".png",                     // thumbnail (full-res)
    ".og-share.jpg",            // social-sharing OG image (1200×630 progressive JPEG q=85, < 600 KB)
    ".rag_combined.jsonl",
];

// Article, outline i magisterium imaju varijabilni datum/model u imenu — matchaju se regex-om
const MAGISTERIUM_PATTERN         = /\.article\.magisterium\.json$/;           // mora biti prije ARTICLE_PATTERN
const MAGISTERIUM_EN_PATTERN      = /\.article\.magisterium\.en\.json$/;       // engleski paralelan output (translate_to_english.js)
const MAGISTERIUM_BATCH_PATTERN   = /\.article\.magisterium_batch\.json$/;     // batch varijanta (usporedba)
const MAGISTERIUM_FULL_PATTERN    = /\.article\.magisterium_full\.json$/;      // full v1 (legacy, pre-prompt-versioning)
const MAGISTERIUM_FULL_PROMPT     = /\.article\.magisterium_full_prompt\.md$/; // v1 prompt
const MAGISTERIUM_FULL_V2_PATTERN = /\.article\.magisterium_full_v2\.json$/;   // full v2 (evangelizacijska revizija)
const MAGISTERIUM_FULL_V2_PROMPT  = /\.article\.magisterium_full_v2_prompt\.md$/;
const ARTICLE_PATTERN     = /\.article\.json$/;
const ARTICLE_EN_PATTERN  = /\.article\.en\.json$/;                            // engleski paralelan output
const OUTLINE_PATTERN     = /\.outline\.json$/;

// Prag za streaming upload (10MB) — iznad toga koristi fs.createReadStream
const STREAM_THRESHOLD = 10 * 1024 * 1024;

// Content-Type mapping
const CONTENT_TYPES = {
    ".srt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jsonl": "application/x-ndjson; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".mkv": "video/x-matroska",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".jpg": "image/jpeg",
};

// Cache-Control za per-video artefakte koji se generiraju jednom (article.json, video.mp4,
// screenshots, thumbnails, og-share, og-sections sličice itd. — write-once).
const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";

// Cache-Control za datoteke koje se mijenjaju kako pipeline napreduje:
//   - channels/data/index.json, index_bundle.json, {channel}.json  → novi video se pojavi
//   - channels/images/{channel}/avatar_*.jpg                       → kanali mijenjaju avatar
//   - {channel}/{base}_screenshots/_manifest.json                  → raste s novim frame-ovima
//   - {channel}/{base}.og-sections/manifest.json                   → raste s novim sekcijama
// 60s + must-revalidate: browser i CF edge re-validate-aju s If-None-Match;
// 304 ako isto, full fetch ako promijenjeno. Jeftino, a "novi video uskoro vidljiv".
const CACHE_CONTROL_MUTABLE = "public, max-age=60, must-revalidate";

function cacheControlFor(r2Key) {
    if (r2Key.startsWith("channels/")) return CACHE_CONTROL_MUTABLE;
    const basename = r2Key.split("/").pop();
    if (basename === "_manifest.json" || basename === "manifest.json") return CACHE_CONTROL_MUTABLE;
    return CACHE_CONTROL_IMMUTABLE;
}

// ─── CLI PARSIRANJE ──────────────────────────────────────────────

function getArg(name) {
    const idx = process.argv.indexOf(name);
    return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

function hasFlag(name) {
    return process.argv.includes(name);
}

// ─── POMOĆNE FUNKCIJE ────────────────────────────────────────────

function ts() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(emoji, msg) {
    console.log(`   ${emoji} [${ts()}] ${msg}`);
}

function extractVideoIdFromFilename(filename) {
    const match = filename.match(/_yt_([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
}

function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (filePath.endsWith(".jsonl")) return CONTENT_TYPES[".jsonl"];
    return CONTENT_TYPES[ext] || "application/octet-stream";
}

function humanSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Računa MD5 hash datoteke streaming-om (R2 koristi MD5 za ETag).
 * Streaming je potreban jer video datoteke mogu biti 60-130MB.
 */
function computeMd5(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("md5");
        const stream = fs.createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}

// ─── DISK MD5 CACHE ──────────────────────────────────────────────
//
// Pamti MD5 hasheve po (localPath, mtime, size) da se ne čitaju
// nepromijenjeni fajlovi pri svakom re-runu (posebno važno za video).
// Format: { "/abs/path": { mtime, size, md5 } }

const MD5_CACHE_PATH = path.join(__dirname, ".r2_md5_cache.json");

function loadMd5Cache() {
    try {
        if (fs.existsSync(MD5_CACHE_PATH)) {
            return JSON.parse(fs.readFileSync(MD5_CACHE_PATH, "utf-8"));
        }
    } catch { /* corrupt cache — zanemarujem */ }
    return {};
}

function saveMd5Cache(cache) {
    try {
        fs.writeFileSync(MD5_CACHE_PATH, JSON.stringify(cache), "utf-8");
    } catch { /* disk full ili permissions — nije kritično */ }
}

/**
 * Vraća MD5 za datoteku. Koristi disk cache ako (mtime, size) odgovaraju.
 * In-memory map (`memCache`) dijeli istu vrijednost između više R2 keyeva
 * koji dijele isti localPath (npr. pipeline i flutter key za isti fajl).
 */
async function computeMd5Cached(filePath, diskCache, memCache) {
    const cached = memCache.get(filePath);
    if (cached) return cached;

    let stat;
    try { stat = fs.statSync(filePath); } catch { return null; }

    const diskEntry = diskCache[filePath];
    if (diskEntry && diskEntry.mtime === stat.mtimeMs && diskEntry.size === stat.size) {
        memCache.set(filePath, diskEntry.md5);
        return diskEntry.md5;
    }

    const md5 = await computeMd5(filePath);
    diskCache[filePath] = { mtime: stat.mtimeMs, size: stat.size, md5 };
    memCache.set(filePath, md5);
    return md5;
}

// ─── CONCURRENT UTILITY ───────────────────────────────────────────

/**
 * Pokreće N asinkronih taskova konkurentno s gornjom granicom `concurrency`.
 * Svaki task je funkcija () => Promise<T>.
 */
async function runConcurrent(tasks, concurrency) {
    const results = new Array(tasks.length);
    let idx = 0;
    async function worker() {
        while (idx < tasks.length) {
            const i = idx++;
            try { results[i] = await tasks[i](); }
            catch (e) { results[i] = { error: e }; }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    return results;
}

// ─── FFMPEG REMUX (MKV → MP4) ───────────────────────────────────

/**
 * Provjerava je li ffmpeg dostupan na PATH-u.
 */
function hasFfmpeg() {
    try {
        execSync("ffmpeg -version", { stdio: "pipe", timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Remuxira MKV → MP4: kopira video stream, transkodira audio u AAC,
 * stavlja moov atom na početak za brži streaming/seek.
 * @returns {Promise<boolean>} true ako je remux uspješan
 */
// FAZA 3: loudness-normalizacija audija pri remuxu (vidi docs/loudness_faza3_mp4_r2_runbook.md).
// Single-pass dynamic loudnorm (TP -2 dBTP — headroom za lossy codec inflaciju).
const LOUDNORM_AF = "loudnorm=I=-16:TP=-2:LRA=11:linear=false";

function remuxVideo(mkvPath, mp4Path, normalize = false) {
    return new Promise((resolve) => {
        // Pri normalizaciji pišemo u temp pa atomski rename — štiti postojeći live .mp4.
        // Temp ima `.loudnorm.` infix → ignoriran od svih pipeline skenera.
        const out = normalize ? mp4Path.replace(/\.mp4$/, ".loudnorm.tmp.mp4") : mp4Path;
        const args = ["-i", mkvPath];
        if (normalize) args.push("-af", LOUDNORM_AF);
        args.push("-c:v", "copy", "-c:a", "aac");
        // loudnorm interno resampla na 192kHz → aac ostane na 96kHz i video se svira
        // krivom brzinom. Resample audio natrag na standardni 48kHz.
        if (normalize) args.push("-ar", "48000");
        args.push("-movflags", "+faststart", "-y", out);
        const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

        proc.on("close", (code) => {
            if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 1000) {
                if (normalize) {
                    try { fs.renameSync(out, mp4Path); }
                    catch { resolve(false); return; }
                }
                resolve(true);
                return;
            }
            try { fs.unlinkSync(out); } catch {}
            resolve(false);
        });

        proc.on("error", () => resolve(false));
    });
}

/**
 * Remux faza: za svaki video koji ima .mkv ali nema svjež .mp4, pokreće ffmpeg.
 * Ide PRIJE discovery/upload faze.
 */
async function remuxPhase(videos, dryRun, normalizeAudio = false) {
    const ffmpegAvailable = hasFfmpeg();
    if (!ffmpegAvailable) {
        log("⚠️", "ffmpeg nije instaliran — preskačem MKV → MP4 remux");
        return { remuxed: 0, skipped: 0, failed: 0, noMkv: 0 };
    }

    let remuxed = 0;
    let skipped = 0;
    let failed = 0;
    let noMkv = 0;

    for (const video of videos) {
        const mkvPath = path.join(video.channelDir, `${video.videoBase}.mkv`);
        const mp4Path = path.join(video.channelDir, `${video.videoBase}.mp4`);

        if (!fs.existsSync(mkvPath)) {
            noMkv++;
            continue;
        }

        // FAZA 3: --normalize-audio → loudnorm audija u .mp4 (in-place). Idempotentno
        // preko markera {base}.loudnorm.applied (ignoriran od svih skenera).
        if (normalizeAudio) {
            const marker = path.join(video.channelDir, `${video.videoBase}.loudnorm.applied`);
            if (fs.existsSync(marker)) { skipped++; continue; }
            if (dryRun) {
                log("🔊", `[DRY RUN] Bi normalizirao+remuxao: ${video.videoBase} → .mp4 (loudnorm)`);
                remuxed++;
                continue;
            }
            log("🔊", `Normalize+remux: ${video.videoBase} (${LOUDNORM_AF}) ...`);
            const ok = await remuxVideo(mkvPath, mp4Path, true);
            if (ok) {
                fs.writeFileSync(marker, new Date().toISOString() + "\n");
                log("✅", `Normalized MP4: ${video.videoBase}.mp4 (${humanSize(fs.statSync(mp4Path).size)})`);
                remuxed++;
            } else {
                log("⚠️", `Normalize-remux neuspješan: ${video.videoBase}`);
                failed++;
            }
            continue;
        }

        // Preskoči ako .mp4 postoji i nije stariji od .mkv
        if (fs.existsSync(mp4Path)) {
            const mkvMtime = fs.statSync(mkvPath).mtimeMs;
            const mp4Mtime = fs.statSync(mp4Path).mtimeMs;
            if (mp4Mtime >= mkvMtime) {
                skipped++;
                continue;
            }
        }

        if (dryRun) {
            const mkvSize = humanSize(fs.statSync(mkvPath).size);
            log("🎬", `[DRY RUN] Bi remuxao: ${video.videoBase}.mkv (${mkvSize}) → .mp4`);
            remuxed++;
            continue;
        }

        const mkvSize = humanSize(fs.statSync(mkvPath).size);
        log("🎬", `Remux: ${video.videoBase}.mkv (${mkvSize}) → .mp4 ...`);

        const ok = await remuxVideo(mkvPath, mp4Path);
        if (ok) {
            const mp4Size = humanSize(fs.statSync(mp4Path).size);
            log("✅", `Remux OK: ${video.videoBase}.mp4 (${mp4Size})`);
            remuxed++;
        } else {
            log("⚠️", `Remux neuspješan za ${video.videoBase}.mkv — nastavljam bez MP4 videa`);
            failed++;
        }
    }

    return { remuxed, skipped, failed, noMkv };
}

// ─── FLUTTER APP KEY MAPPING ─────────────────────────────────────

/**
 * Za danu pipeline datoteku vraća odgovarajući Flutter app R2 key.
 * Vraća null ako datoteka nema app-friendly ekvivalent (npr. .rag_combined.jsonl, .mkv).
 */
function getFlutterKey(localPath, r2Key, videoId, videoBase) {
    const filename = path.basename(localPath);

    if (filename.endsWith(".canary.summary.en.json"))
        return `data/${videoId}/summary.en.json`;

    if (filename.endsWith(".canary.summary.json"))
        return `data/${videoId}/summary.json`;

    if (filename.endsWith(".canary.diarized.srt"))
        return `data/${videoId}/diarized.srt`;

    if (filename === `${videoBase}.info.json`)
        return `data/${videoId}/info.json`;

    if (filename === `${videoBase}.png`)
        return `images/${videoId}/thumbnail.png`;

    if (filename === `${videoBase}.og-share.jpg`)
        return `images/${videoId}/og-share.jpg`;

    // Flutter app koristi .mp4 (ne .mkv) za cross-platform kompatibilnost
    if (filename === `${videoBase}.mp4`)
        return `data/${videoId}/video.mp4`;

    if (MAGISTERIUM_FULL_V2_PATTERN.test(filename))
        return `data/${videoId}/article.magisterium_full_v2.json`;

    if (MAGISTERIUM_FULL_V2_PROMPT.test(filename))
        return `data/${videoId}/article.magisterium_full_v2_prompt.md`;

    if (MAGISTERIUM_FULL_PATTERN.test(filename))
        return `data/${videoId}/article.magisterium_full.json`;

    if (MAGISTERIUM_FULL_PROMPT.test(filename))
        return `data/${videoId}/article.magisterium_full_prompt.md`;

    if (MAGISTERIUM_BATCH_PATTERN.test(filename))
        return `data/${videoId}/article.magisterium_batch.json`;

    if (MAGISTERIUM_EN_PATTERN.test(filename))
        return `data/${videoId}/article.magisterium.en.json`;

    if (MAGISTERIUM_PATTERN.test(filename))
        return `data/${videoId}/article.magisterium.json`;

    if (ARTICLE_EN_PATTERN.test(filename))
        return `data/${videoId}/article.en.json`;

    if (ARTICLE_PATTERN.test(filename))
        return `data/${videoId}/article.json`;

    if (OUTLINE_PATTERN.test(filename))
        return `data/${videoId}/outline.json`;

    // Screenshots
    if (r2Key.includes("_screenshots/")) {
        if (filename === "_manifest.json")
            return `images/${videoId}/screenshots/manifest.json`;
        // {videoBase}_{HH-MM-SS}.png → {HH-MM-SS}.png
        const tsMatch = filename.match(/_(\d{2}-\d{2}-\d{2})\.png$/);
        if (tsMatch)
            return `images/${videoId}/screenshots/${tsMatch[1]}.png`;
    }

    // Og-sections (Tier B per-section composites za /v/<ytId>/t/<sec> share URL-ove)
    if (r2Key.includes(".og-sections/")) {
        if (filename === "manifest.json")
            return `images/${videoId}/og-sections.json`;
        // og-t-{sec}.jpg → images/{videoId}/og-t-{sec}.jpg (na top level images dir-a)
        if (/^og-t-\d+\.jpg$/.test(filename))
            return `images/${videoId}/${filename}`;
    }

    return null;
}

// ─── DISCOVERY ────────────────────────────────────────────────────

/**
 * Pronalazi sve datoteke za upload za jedan video (po video bazi).
 * @returns {Array<{localPath, r2Key, size}>}
 */
function collectFilesForVideo(channelDir, channelName, videoBase) {
    const files = [];

    let dirEntries;
    try {
        dirEntries = fs.readdirSync(channelDir);
    } catch {
        return files;
    }

    for (const filename of dirEntries) {
        if (filename.startsWith("._")) continue;
        if (!filename.startsWith(videoBase)) continue;

        const localPath = path.join(channelDir, filename);
        let stat;
        try {
            stat = fs.statSync(localPath);
        } catch {
            continue;
        }

        if (stat.isDirectory()) continue;

        let shouldUpload = false;

        for (const suffix of UPLOAD_SUFFIXES) {
            if (filename.endsWith(suffix)) {
                // .png, .og-share.jpg, .mkv, .mp4: samo točan match na videoBase (thumbnail / merged video)
                // .og-share.jpg PRIJE .png check (jer ".og-share.jpg".endsWith(".png") je false, ali držimo ekspl. radi jasnoće)
                if (suffix === ".png" && filename !== `${videoBase}.png`) continue;
                if (suffix === ".og-share.jpg" && filename !== `${videoBase}.og-share.jpg`) continue;
                if (suffix === ".mkv" && filename !== `${videoBase}.mkv`) continue;
                if (suffix === ".mp4" && filename !== `${videoBase}.mp4`) continue;
                shouldUpload = true;
                break;
            }
        }

        if (!shouldUpload && MAGISTERIUM_FULL_V2_PATTERN.test(filename)) shouldUpload = true;
        if (!shouldUpload && MAGISTERIUM_FULL_V2_PROMPT.test(filename)) shouldUpload = true;
        if (!shouldUpload && MAGISTERIUM_FULL_PATTERN.test(filename)) shouldUpload = true;
        if (!shouldUpload && MAGISTERIUM_FULL_PROMPT.test(filename)) shouldUpload = true;
        if (!shouldUpload && MAGISTERIUM_BATCH_PATTERN.test(filename)) shouldUpload = true;
        if (!shouldUpload && MAGISTERIUM_EN_PATTERN.test(filename)) shouldUpload = true;
        if (!shouldUpload && MAGISTERIUM_PATTERN.test(filename)) shouldUpload = true;
        if (!shouldUpload && ARTICLE_EN_PATTERN.test(filename)) shouldUpload = true;
        if (!shouldUpload && ARTICLE_PATTERN.test(filename)) shouldUpload = true;
        if (!shouldUpload && OUTLINE_PATTERN.test(filename)) shouldUpload = true;
        // Summary engleski paralelan output (.canary.summary.en.json) — UPLOAD_SUFFIXES match .canary.summary.json prvo, pa explicit fallback
        if (!shouldUpload && filename.endsWith(".canary.summary.en.json")) shouldUpload = true;

        if (shouldUpload) {
            files.push({
                localPath,
                r2Key: `${channelName}/${filename}`,
                size: stat.size
            });
        }
    }

    // Screenshots direktorij
    const screenshotDir = path.join(channelDir, `${videoBase}_screenshots`);
    if (fs.existsSync(screenshotDir)) {
        let ssFiles;
        try {
            ssFiles = fs.readdirSync(screenshotDir);
        } catch {
            ssFiles = [];
        }

        for (const ssFile of ssFiles) {
            if (ssFile.startsWith("._")) continue;
            if (!ssFile.endsWith(".png") && ssFile !== "_manifest.json") continue;

            const ssLocalPath = path.join(screenshotDir, ssFile);
            let stat;
            try {
                stat = fs.statSync(ssLocalPath);
            } catch {
                continue;
            }

            if (!stat.isFile()) continue;

            files.push({
                localPath: ssLocalPath,
                r2Key: `${channelName}/${videoBase}_screenshots/${ssFile}`,
                size: stat.size
            });
        }
    }

    // Og-sections direktorij (Tier B per-section composites)
    const ogSectionsDir = path.join(channelDir, `${videoBase}.og-sections`);
    if (fs.existsSync(ogSectionsDir)) {
        let ogFiles;
        try {
            ogFiles = fs.readdirSync(ogSectionsDir);
        } catch {
            ogFiles = [];
        }

        for (const ogFile of ogFiles) {
            if (ogFile.startsWith("._")) continue;
            // Prihvati samo og-t-{sec}.jpg i manifest.json — ignoriraj sve drugo
            if (!/^og-t-\d+\.jpg$/.test(ogFile) && ogFile !== "manifest.json") continue;

            const ogLocalPath = path.join(ogSectionsDir, ogFile);
            let stat;
            try {
                stat = fs.statSync(ogLocalPath);
            } catch {
                continue;
            }
            if (!stat.isFile()) continue;

            files.push({
                localPath: ogLocalPath,
                r2Key: `${channelName}/${videoBase}.og-sections/${ogFile}`,
                size: stat.size
            });
        }
    }

    return files;
}

/**
 * Pronalazi sve video baze u direktoriju (po _yt_ patternu).
 */
function discoverVideoBases(channelDir) {
    const bases = new Set();

    let files;
    try {
        files = fs.readdirSync(channelDir);
    } catch {
        return [];
    }

    for (const f of files) {
        if (f.startsWith("._")) continue;
        const match = f.match(/^(.+_yt_[a-zA-Z0-9_-]{11})/);
        if (match) {
            bases.add(match[1]);
        }
    }

    return Array.from(bases).sort((a, b) => b.localeCompare(a));
}

/**
 * Pronalazi sve video baze za obradu prema filterima.
 */
function discoverVideos(inputDir, channelFilter, videoIdFilter) {
    const results = [];

    let entries;
    try {
        entries = fs.readdirSync(inputDir, { withFileTypes: true });
    } catch (err) {
        log("❌", `Ne mogu čitati direktorij: ${inputDir} — ${err.message}`);
        return results;
    }

    for (const entry of entries) {
        if (!(entry.isDirectory() || entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;
        if (channelFilter && entry.name !== channelFilter) continue;

        const channelName = entry.name;
        const channelDir = path.join(inputDir, channelName);
        const bases = discoverVideoBases(channelDir);

        for (const videoBase of bases) {
            const videoId = extractVideoIdFromFilename(videoBase);
            if (!videoId) continue;
            if (videoIdFilter && videoId !== videoIdFilter) continue;

            results.push({
                channel: channelName,
                channelDir,
                videoBase,
                videoId
            });
        }
    }

    results.sort((a, b) => b.videoBase.localeCompare(a.videoBase));
    return results;
}

// ─── R2 UPLOAD ────────────────────────────────────────────────────

/**
 * Inicijalizira S3 klijent za Cloudflare R2.
 */
function createR2Client() {
    const { S3Client } = require("@aws-sdk/client-s3");

    return new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
    });
}

/**
 * Dohvaća remote ETag iz R2 (samo HeadObject, bez čitanja lokalnog fajla).
 * @returns {string|null} ETag bez navodnika, ili null ako fajl ne postoji u R2
 */
async function getRemoteEtag(client, key) {
    const { HeadObjectCommand } = require("@aws-sdk/client-s3");
    try {
        const resp = await client.send(new HeadObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
        }));
        return (resp.ETag || "").replace(/"/g, "");
    } catch (err) {
        if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

/**
 * Lista sve ključeve u R2 bucketu (paginirano, 1000 per page).
 * 1 Class A operacija per stranica vs 1 Class B per HEAD — za 130k+ objekata
 * to je ~130 LIST poziva vs ~130k HEAD poziva (1000× manje API operacija).
 * @returns {Promise<Set<string>>} Set svih remote ključeva
 */
async function listAllR2Keys(client) {
    const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
    const keys = new Set();
    let continuationToken;
    let pages = 0;
    do {
        const resp = await client.send(new ListObjectsV2Command({
            Bucket: R2_BUCKET_NAME,
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
        }));
        for (const obj of resp.Contents || []) keys.add(obj.Key);
        continuationToken = resp.NextContinuationToken;
        pages++;
        if (pages % 10 === 0) {
            process.stdout.write(`\r   📋 LIST stranica ${pages} (${keys.size} ključeva)   `);
        }
    } while (continuationToken);
    process.stdout.write("\n");
    return keys;
}

/**
 * Je li ovaj R2 ključ content-mutable (sadržaj se može mijenjati pod istim imenom)?
 *
 * Većina file-ova ima timestamp ili YouTube ID u nazivu → naziv jednoznačno
 * određuje sadržaj (npr. `xxx_2026-05-15_gemini-2.5-flash.article.json`,
 * `screenshots/xxx_00-15-30.png`). Re-generacija proizvodi NOVI naziv, ne
 * overwrite starog.
 *
 * Iznimke (mutable basename-i):
 *   - `_manifest.json` u `_screenshots/` — dopisuje se kad se doda novi frame
 *   - `manifest.json` u `.og-sections/` — dopisuje se kad se doda nova sekcija
 *
 * Za ove dvije kategorije i dalje radimo HEAD + MD5 usporedbu da bismo detektirali
 * update. Za sve ostalo: ako ključ postoji u LIST set-u, skipamo bez HEAD-a.
 */
function isContentMutable(r2Key) {
    const basename = r2Key.split("/").pop();
    return basename === "_manifest.json" || basename === "manifest.json";
}

/**
 * Uploadira datoteku u R2.
 * Za datoteke > STREAM_THRESHOLD koristi fs.createReadStream (video datoteke).
 */
async function uploadToR2(client, localPath, key) {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");

    const contentType = getContentType(localPath);
    const size = fs.statSync(localPath).size;

    const body = size > STREAM_THRESHOLD
        ? fs.createReadStream(localPath)
        : fs.readFileSync(localPath);

    await client.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: body,
        ContentLength: size,
        ContentType: contentType,
        CacheControl: cacheControlFor(key),
    }));
}

// ─── CLOUDFLARE CDN PURGE (FAZA 3) ────────────────────────────────
// video.mp4 ima Cache-Control immutable (1god) — nakon prepisivanja na R2, CF
// servira stari sadržaj dok se ne purge-a. Vidi memory cloudflare-cdn-caches-404s.
async function cfZoneId() {
    const r = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${CF_ZONE_NAME}`, {
        headers: { Authorization: `Bearer ${CF_PURGE_TOKEN}` },
    });
    const j = await r.json();
    return (j && j.success && j.result && j.result[0]) ? j.result[0].id : null;
}

async function purgeCloudflareCache(urls) {
    if (!urls.length) return;
    if (!CF_PURGE_TOKEN) {
        log("⚠️", "DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE nije postavljen — preskačem CDN purge.");
        log("💡", `Ručno: CF dashboard → ${CF_ZONE_NAME} → Caching → Purge Everything.`);
        return;
    }
    let zoneId;
    try { zoneId = await cfZoneId(); } catch (e) { zoneId = null; }
    if (!zoneId) {
        log("⚠️", `Ne mogu razriješiti zone ID za ${CF_ZONE_NAME} (token možda nema zone:read).`);
        log("💡", `Purge-aj ručno ${urls.length} .mp4 URL-ova ili Purge Everything preko dashboarda.`);
        return;
    }
    let purged = 0;
    for (let i = 0; i < urls.length; i += 30) {   // CF limit: 30 file-ova po pozivu
        const batch = urls.slice(i, i + 30);
        try {
            const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
                method: "POST",
                headers: { Authorization: `Bearer ${CF_PURGE_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify({ files: batch }),
            });
            const j = await r.json().catch(() => ({}));
            if (j && j.success) purged += batch.length;
            else log("⚠️", `CF purge batch greška: ${JSON.stringify(j.errors || j).slice(0, 200)}`);
        } catch (e) {
            log("⚠️", `CF purge batch iznimka: ${e.message}`);
        }
    }
    log("🧹", `CDN purge: ${purged}/${urls.length} URL-ova (GET-verify, ne HEAD).`);
}

// ─── MAIN ─────────────────────────────────────────────────────────

async function main() {
    const inputDir = getArg("--input-dir");
    const channelFilter = getArg("--channel");
    const videoIdFilter = getArg("--video-id");
    const limit = getArg("--limit") ? parseInt(getArg("--limit"), 10) : 0;
    const dryRun = hasFlag("--dry-run");
    const metaDir = getArg("--meta-dir"); // npr. storage/meta — uploadira sve JSON fajlove iz tog direktorija
    const flutterKeys = hasFlag("--flutter-keys");
    // FAZA 3 (vidi docs/loudness_faza3_mp4_r2_runbook.md):
    //   --normalize-audio → remux normalizira audio (loudnorm) u .mp4 in-place
    //   --force-mp4       → prisili re-upload .mp4 ključeva (inače immutable=skip) + CDN purge
    // normalize implicira force (normalizirani .mp4 mora prepisati postojeći na R2).
    const normalizeAudio = hasFlag("--normalize-audio");
    const forceMp4 = hasFlag("--force-mp4") || normalizeAudio;

    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   ☁️  CLOUDFLARE R2 UPLOADER                     ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log("");

    if (!inputDir && !metaDir) {
        console.error("❌ Obavezan argument: --input-dir <putanja> ili --meta-dir <putanja>");
        console.error("");
        console.error("Primjeri:");
        console.error("  node upload_to_r2.js --input-dir /path/to/output --video-id H-p2Hl6x7I0");
        console.error("  node upload_to_r2.js --input-dir /path/to/output --channel domovina_tv");
        console.error("  node upload_to_r2.js --input-dir /path/to/output");
        console.error("  node upload_to_r2.js --meta-dir storage/meta");
        process.exit(1);
    }

    if (inputDir && !fs.existsSync(inputDir)) {
        log("❌", `Input direktorij ne postoji: ${inputDir}`);
        process.exit(1);
    }

    // Provjeri R2 konfiguraciju (potrebno i za video i za meta upload)
    const missing = [];
    if (!R2_ACCOUNT_ID) missing.push("R2_ACCOUNT_ID");
    if (!R2_ACCESS_KEY_ID) missing.push("R2_ACCESS_KEY_ID");
    if (!R2_SECRET_ACCESS_KEY) missing.push("R2_SECRET_ACCESS_KEY");

    if (missing.length > 0 && !dryRun) {
        log("❌", `Nedostaju env varijable: ${missing.join(", ")}`);
        log("💡", "Postavi ih u .env datoteku. Vidi .env.example.");
        process.exit(1);
    }

    // Zajednički brojači — koriste ih i video i meta upload sekcija
    let uploaded = 0;
    let skipped = 0;
    let updated = 0;
    let failed = 0;
    let uploadedBytes = 0;
    let remuxStats = null;
    const client = dryRun ? null : createR2Client();

if (inputDir) {
    log("📂", `Input:    ${inputDir}`);
    log("🪣", `Bucket:   ${R2_BUCKET_NAME}`);
    log("🌐", `CDN URL:  ${R2_PUBLIC_URL}`);
    if (channelFilter) log("🎯", `Kanal:    ${channelFilter}`);
    if (videoIdFilter) log("🎬", `Video ID: ${videoIdFilter}`);
    if (limit > 0) log("🔢", `Limit:    ${limit}`);
    if (dryRun) log("🏜️", "DRY RUN — samo prikaz, bez uploada");
    console.log("");

    // Pronađi videe
    log("🔍", "Skeniram direktorije...");
    let videos = discoverVideos(inputDir, channelFilter, videoIdFilter);

    if (limit > 0) videos = videos.slice(0, limit);

    if (videos.length === 0) {
        log("✨", "Nema videa za obradu.");
        return;
    }

    log("📊", `Pronađeno videa: ${videos.length}`);

    // Pre-scan: klasificiraj statusu video processinga (cheap local check, no R2 calls).
    // Pokazuje koliko je već dovršeno (idempotentnost), koliko treba još rada.
    let alreadyMp4 = 0;
    let needsRemux = 0;
    let noVideoYet = 0;
    for (const v of videos) {
        const mkvPath = path.join(v.channelDir, `${v.videoBase}.mkv`);
        const mp4Path = path.join(v.channelDir, `${v.videoBase}.mp4`);
        const hasMkv = fs.existsSync(mkvPath);
        const hasMp4 = fs.existsSync(mp4Path);
        if (hasMp4) {
            // Provjeri freshness: ako .mp4 starija od .mkv, treba re-remux
            if (hasMkv && fs.statSync(mp4Path).mtimeMs < fs.statSync(mkvPath).mtimeMs) {
                needsRemux++;
            } else {
                alreadyMp4++;
            }
        } else if (hasMkv) {
            needsRemux++;
        } else {
            noVideoYet++;
        }
    }
    log("📊", `MP4 pripremljen: ${alreadyMp4} | Treba remux: ${needsRemux} | Bez video fajla: ${noVideoYet}`);
    console.log("");

    // ── FAZA 1: MKV → MP4 REMUX ──────────────────────────────────
    console.log("   ━━━ MKV → MP4 remux ━━━");
    console.log("");

    remuxStats = await remuxPhase(videos, dryRun, normalizeAudio);

    if (remuxStats.remuxed > 0 || remuxStats.failed > 0) {
        log("📊", `Remux: ${remuxStats.remuxed} novo, ${remuxStats.skipped} preskočeno, ${remuxStats.failed} neuspjelo`);
    } else if (remuxStats.skipped > 0) {
        log("⏭️", `Svi MP4 fajlovi već postoje (${remuxStats.skipped} preskočeno)`);
    } else {
        log("ℹ️", `Nema MKV datoteka za remux`);
    }
    console.log("");

    // ── FAZA 2: DISCOVERY I UPLOAD ────────────────────────────────
    console.log("   ━━━ Upload ━━━");
    console.log("");

    // Prikupi sve kandidate za upload (discovery koristi UPLOAD_SUFFIXES)
    const discoveredFiles = [];

    for (const video of videos) {
        const videoFiles = collectFilesForVideo(video.channelDir, video.channel, video.videoBase);
        for (const f of videoFiles) {
            discoveredFiles.push({ ...f, videoId: video.videoId, videoBase: video.videoBase, channel: video.channel });
        }
    }

    // Generiraj flutter app keyeve (kratki app-friendly R2 ključevi).
    // Ovo je default ponašanje — svaki upload koristi data/{videoId}/... i images/{videoId}/...
    // keyeve umjesto dugačkih pipeline filenamea.
    const appFiles = [];
    for (const f of discoveredFiles) {
        const appKey = getFlutterKey(f.localPath, f.r2Key, f.videoId, f.videoBase);
        if (appKey) {
            appFiles.push({
                localPath: f.localPath,
                r2Key: appKey,
                size: f.size,
                videoId: f.videoId,
                videoBase: f.videoBase,
                channel: f.channel,
            });
        }
    }

    // Dedup: više pipeline fajlova može mapirati na isti R2 ključ. Tipičan
    // slučaj: pipeline producira `*.diarized_<date>_<model>.article.json` po
    // svakom Gemini modelu, a `getFlutterKey()` ih sve mapira na isti
    // `data/{videoId}/article.json`. Bez dedupa se upload-aju svi sekvencijalno
    // (waste) i ono što na kraju živi na CDN-u ovisi o redoslijedu — non-det.
    //
    // Strategija: najnoviji mtime pobjeđuje (tiebreaker: veći fajl). Najnoviji
    // file = najsvježija pipeline runa = ono što user trenutno smatra "best".
    const dedupMap = new Map(); // r2Key → best appFile
    for (const f of appFiles) {
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(f.localPath).mtimeMs; } catch { /* fallback 0 */ }
        const candidate = { ...f, mtimeMs };
        const existing = dedupMap.get(f.r2Key);
        if (!existing) {
            dedupMap.set(f.r2Key, candidate);
            continue;
        }
        const newer = candidate.mtimeMs > existing.mtimeMs;
        const sameTimeBigger = candidate.mtimeMs === existing.mtimeMs && candidate.size > existing.size;
        if (newer || sameTimeBigger) {
            dedupMap.set(f.r2Key, candidate);
        }
    }
    const allFiles = Array.from(dedupMap.values());
    const droppedDups = appFiles.length - allFiles.length;

    log("📊", `Ukupno za provjeru: ${allFiles.length} (od ${discoveredFiles.length} otkrivenih, ${droppedDups} duplikata po R2 ključu)`);
    const totalSize = allFiles.reduce((sum, f) => sum + f.size, 0);
    log("💾", `Ukupna veličina: ${humanSize(totalSize)}`);
    console.log("");

    if (allFiles.length === 0) {
        log("✨", "Nema datoteka za upload (možda nedostaju article/summary fileovi?).");
        return;
    }

    // Dry run: prikaži što bi se uploadalo
    if (dryRun) {
        if (appFiles.length > 0) {
            log("🏜️", "Datoteke za upload (R2 keyevi):");
            console.log("");

            let prevPrefix = "";
            for (const f of appFiles) {
                const prefix = f.r2Key.split("/").slice(0, 2).join("/");
                if (prefix !== prevPrefix) {
                    console.log(`      📁 ${prefix}/`);
                    prevPrefix = prefix;
                }
                const shortKey = f.r2Key.split("/").slice(2).join("/");
                console.log(`         ${shortKey}  (${humanSize(f.size)})`);
            }
        }

        console.log("");
        log("🏜️", `DRY RUN završen. ${allFiles.length} datoteka, ${humanSize(totalSize)}.`);
        log("🏜️", "Pokreni bez --dry-run za stvarni upload.");
        return;
    }

    // Inicijaliziraj R2 klijent (lokalno za video upload; zajednički client deklariran dolje)

    const R2_CHECK_CONCURRENCY  = 20; // paralelni HeadObject pozivi (samo za mutable file-ove)
    // PUT je teži od HEAD (full body upload), pa malo niža concurrency. Konfigurabilno
    // preko env vara — povećaj ako mreža/disk to izdrže (R2 nema striktnih rate limita).
    const R2_UPLOAD_CONCURRENCY = parseInt(process.env.R2_UPLOAD_CONCURRENCY, 10) || 8;

    // ── FAZA 1: LIST + klasifikacija + selektivni HEAD ────────────
    // Strategija (vidi listAllR2Keys + isContentMutable docstring):
    //   1. LIST sve ključeve u bucketu (paginirano, ~1 Class A op per 1000 objekata)
    //   2. Klasificiraj lokalne file-ove:
    //        - "novi" (ključ nije u LIST set-u) → upload odmah, bez ikakve provjere
    //        - "postojeći immutable" (ključ u set-u, naziv content-immutable) → SKIP
    //        - "postojeći mutable" (ključ u set-u, basename = *manifest.json) → HEAD+MD5
    //   3. HEAD samo na mutable file-ove (par stotina, ne 130k+)
    //
    // Trošak po runu na 132k fajlova:
    //   PRIJE: 132k Class B (HEAD) = 1.32% mjesečnog free tier-a (10M)
    //   SAD:   ~132 Class A (LIST) + ~par stotina Class B (HEAD na manifeste)
    //          = 0.013% Class A free tier-a + <0.005% Class B
    //   Override: --full-head flag vraća staro ponašanje (HEAD na sve).

    const forceFullHead = hasFlag("--full-head");

    let newFiles, existingImmutable, existingMutable;
    const remoteEtags = new Map(); // r2Key → etag (string) ili null/undefined

    if (forceFullHead) {
        log("🔍", `--full-head: HEAD na sve ${allFiles.length} fajlova (${R2_CHECK_CONCURRENCY} paralelno)...`);
        let checked = 0;
        const checkTasks = allFiles.map(f => async () => {
            try {
                remoteEtags.set(f.r2Key, await getRemoteEtag(client, f.r2Key));
            } catch (err) {
                log("❌", `HEAD greška ${f.r2Key}: ${err.message}`);
                remoteEtags.set(f.r2Key, undefined);
            }
            checked++;
            if (checked % 100 === 0 || checked === allFiles.length) {
                process.stdout.write(`\r   🔍 HEAD: ${checked}/${allFiles.length}   `);
            }
        });
        await runConcurrent(checkTasks, R2_CHECK_CONCURRENCY);
        process.stdout.write("\n");

        // U full-head modu sve tretiramo kao mutable (HEAD+MD5 verifikacija)
        newFiles = allFiles.filter(f => remoteEtags.get(f.r2Key) === null);
        existingImmutable = [];
        existingMutable = allFiles.filter(f => {
            const e = remoteEtags.get(f.r2Key);
            return e !== null && e !== undefined;
        });
    } else {
        log("📋", `LIST svih R2 ključeva (paginirano)...`);
        const remoteKeySet = await listAllR2Keys(client);
        log("📊", `R2 sadrži ${remoteKeySet.size} ključeva ukupno`);

        newFiles = [];
        existingImmutable = [];
        existingMutable = [];

        for (const f of allFiles) {
            if (!remoteKeySet.has(f.r2Key)) {
                newFiles.push(f);
            } else if (isContentMutable(f.r2Key)) {
                existingMutable.push(f);
            } else {
                existingImmutable.push(f);
            }
        }

        log("📊", `Klasifikacija: ${newFiles.length} novih, ${existingImmutable.length} postojećih immutable (skip), ${existingMutable.length} postojećih mutable (HEAD+MD5)`);

        // HEAD samo za mutable
        if (existingMutable.length > 0) {
            log("🔍", `HEAD na ${existingMutable.length} mutable manifesta (${R2_CHECK_CONCURRENCY} paralelno)...`);
            let headChecked = 0;
            const headTasks = existingMutable.map(f => async () => {
                try {
                    remoteEtags.set(f.r2Key, await getRemoteEtag(client, f.r2Key));
                } catch (err) {
                    log("❌", `HEAD greška ${f.r2Key}: ${err.message}`);
                    remoteEtags.set(f.r2Key, undefined);
                }
                headChecked++;
                if (headChecked % 50 === 0 || headChecked === existingMutable.length) {
                    process.stdout.write(`\r   🔍 HEAD: ${headChecked}/${existingMutable.length}   `);
                }
            });
            await runConcurrent(headTasks, R2_CHECK_CONCURRENCY);
            process.stdout.write("\n");
        }
    }
    console.log("");

    // FAZA 3 / --force-mp4: video.mp4 je immutable pa bi postojeći bio skipan;
    // normalizirani audio mora prepisati postojeći → prebaci .mp4 ključeve u upload.
    if (forceMp4) {
        const isMp4Key = (k) => k.endsWith(".mp4");
        const forced = existingImmutable.filter(f => isMp4Key(f.r2Key));
        if (forced.length) {
            existingImmutable = existingImmutable.filter(f => !isMp4Key(f.r2Key));
            newFiles.push(...forced);
            log("🔁", `--force-mp4: ${forced.length} postojećih .mp4 ključeva → re-upload`);
        }
    }

    // Immutable file-ovi koji već postoje na R2 = automatski skip
    skipped += existingImmutable.length;

    // ── FAZA 2: Upload ────────────────────────────────────────────
    // - newFiles: PUT bez MD5 (nema remote da se uspoređuje)
    // - existingMutable: usporedi local MD5 vs remote ETag, PUT ako se razlikuje

    const diskMd5Cache = loadMd5Cache();
    const memMd5Cache  = new Map(); // in-memory, dijeli MD5 za isti localPath
    let diskCacheDirty = false;

    log("🚀", `Upload (${R2_UPLOAD_CONCURRENCY} paralelno)...`);

    // Combined task list: nove file-ove gore (najveći prioritet), pa mutable koje treba verify-ati
    const uploadCandidates = [
        ...newFiles.map(f => ({ f, kind: "NEW" })),
        ...existingMutable.map(f => ({ f, kind: "VERIFY" })),
    ];

    const uploadTasks = uploadCandidates.map(({ f, kind }) => async () => {
        if (kind === "NEW") {
            try {
                await uploadToR2(client, f.localPath, f.r2Key);
                uploaded++;
                uploadedBytes += f.size;
                log("⬆️", `[${uploaded + updated}] NOVO ${f.r2Key} (${humanSize(f.size)})`);
            } catch (err) {
                log("❌", `Upload neuspješan za ${f.r2Key}: ${err.message}`);
                failed++;
            }
            return;
        }

        // kind === "VERIFY" — mutable, usporedi MD5 vs remote ETag
        const remoteEtag = remoteEtags.get(f.r2Key);
        if (remoteEtag === undefined) {
            failed++;
            return;
        }
        const localMd5 = await computeMd5Cached(f.localPath, diskMd5Cache, memMd5Cache);
        diskCacheDirty = true;
        if (localMd5 === null) {
            log("❌", `Ne mogu pročitati: ${f.localPath}`);
            failed++;
            return;
        }
        if (localMd5 === remoteEtag) {
            skipped++;
            return; // Nepromijenjeno
        }
        try {
            await uploadToR2(client, f.localPath, f.r2Key);
            updated++;
            uploadedBytes += f.size;
            log("⬆️", `[${uploaded + updated}] UPDATE ${f.r2Key} (${humanSize(f.size)})`);
        } catch (err) {
            log("❌", `Upload neuspješan za ${f.r2Key}: ${err.message}`);
            failed++;
        }
    });

    await runConcurrent(uploadTasks, R2_UPLOAD_CONCURRENCY);

    // Spremi disk MD5 cache ako se promijenio
    if (diskCacheDirty) saveMd5Cache(diskMd5Cache);

    // FAZA 3: purge CDN za prepisane .mp4 (immutable cache, inače stari servira 1god).
    if (forceMp4 && !dryRun) {
        const mp4Urls = newFiles
            .filter(f => f.r2Key.endsWith(".mp4"))
            .map(f => `${R2_PUBLIC_URL.replace(/\/$/, "")}/${f.r2Key}`);
        if (mp4Urls.length) {
            log("🧹", `Pokrećem CDN purge za ${mp4Urls.length} prepisanih .mp4 ...`);
            await purgeCloudflareCache(mp4Urls);
        }
    }

} // end if (inputDir)

    // ── META UPLOAD (--meta-dir) ──────────────────────────────────
    // Uploadira statične JSON fajlove iz meta direktorija (channels/index.json,
    // channels/{id}.json) koristeći relativnu putanju kao R2 ključ.

    if (metaDir) {
        const resolvedMetaDir = path.resolve(metaDir);

        if (!fs.existsSync(resolvedMetaDir)) {
            log("⚠️", `Meta direktorij ne postoji: ${resolvedMetaDir} — preskačem`);
        } else {
            console.log("");
            console.log("   ━━━ Meta fajlovi ━━━");
            console.log("");

            // Rekurzivno skupi sve JSON fajlove iz meta direktorija
            function collectMetaFiles(dir, baseDir) {
                const metaFiles = [];
                for (const entry of fs.readdirSync(dir)) {
                    if (entry.startsWith('.') || entry.startsWith('._')) continue;
                    const fullPath = path.join(dir, entry);
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        metaFiles.push(...collectMetaFiles(fullPath, baseDir));
                    } else if (entry.endsWith('.json') || entry.endsWith('.jpg') || entry.endsWith('.png')) {
                        const r2Key = path.relative(baseDir, fullPath).replace(/\\/g, '/');
                        metaFiles.push({ localPath: fullPath, r2Key, size: stat.size });
                    }
                }
                return metaFiles;
            }

            const metaFiles = collectMetaFiles(resolvedMetaDir, resolvedMetaDir);
            log("📊", `Meta fajlova: ${metaFiles.length}`);

            if (dryRun) {
                for (const f of metaFiles) {
                    log("🏜️", `[DRY RUN] ${f.r2Key} (${humanSize(f.size)})`);
                }
            } else {
                const metaDiskCache = loadMd5Cache();
                const metaMemCache  = new Map();

                for (const f of metaFiles) {
                    // Meta JSON fajlovi su mali — uvijek provjeri MD5 (nema smisla skip HeadObject)
                    const remoteEtag = await getRemoteEtag(client, f.r2Key);
                    const localMd5   = await computeMd5Cached(f.localPath, metaDiskCache, metaMemCache);

                    if (remoteEtag && remoteEtag === localMd5) {
                        log("⏭️", `Nepromijenjeno: ${f.r2Key}`);
                        skipped++;
                    } else {
                        try {
                            await uploadToR2(client, f.localPath, f.r2Key);
                            const action = remoteEtag ? "UPDATE" : "NOVO";
                            log("⬆️", `${action} ${f.r2Key} (${humanSize(f.size)})`);
                            if (remoteEtag) updated++; else uploaded++;
                            uploadedBytes += f.size;
                        } catch (err) {
                            log("❌", `Upload neuspješan: ${f.r2Key}: ${err.message}`);
                            failed++;
                        }
                    }
                }

                saveMd5Cache(metaDiskCache);
            }
        }
    }

    // Statistika
    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📊 R2 UPLOAD ZAVRŠEN                          ║");
    console.log("╚══════════════════════════════════════════════════╝");
    if (remuxStats?.remuxed > 0) console.log(`   🎬 Remuxano:        ${remuxStats.remuxed}`);
    console.log(`   ⬆️  Novih:          ${uploaded}`);
    if (updated > 0) console.log(`   🔄 Ažuriranih:     ${updated}`);
    console.log(`   ⏭️  Nepromijenjenih: ${skipped}`);
    if (failed > 0) console.log(`   ❌ Neuspjelih:      ${failed}`);
    console.log(`   💾 Uploadano:       ${humanSize(uploadedBytes)}`);
    console.log(`   🌐 CDN:            ${R2_PUBLIC_URL}`);
    console.log("");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
