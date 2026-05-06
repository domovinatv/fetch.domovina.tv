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
 *   - .png (thumbnail)
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
 *   Pipeline: {channel}/{base}.mp4                  →  App: data/{videoId}/video.mp4
 *   Pipeline: {channel}/{base}_screenshots/{ts}.png →  App: images/{videoId}/screenshots/{ts}.png
 *   Pipeline: {channel}/{base}_screenshots/_manifest →  App: images/{videoId}/screenshots/manifest.json
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

// Sufiksi datoteka koje se uploadaju (po video bazi)
const UPLOAD_SUFFIXES = [
    ".canary.diarized.srt",
    ".canary.summary.json",
    ".canary.summary.md",
    ".info.json",
    ".mkv",                     // originalni video (360p)
    ".mp4",                     // remuxed video (H.264+AAC, faststart)
    ".png",                     // thumbnail
    ".rag_combined.jsonl",
];

// Article, outline i magisterium imaju varijabilni datum/model u imenu — matchaju se regex-om
const MAGISTERIUM_PATTERN         = /\.article\.magisterium\.json$/;           // mora biti prije ARTICLE_PATTERN
const MAGISTERIUM_BATCH_PATTERN   = /\.article\.magisterium_batch\.json$/;     // batch varijanta (usporedba)
const MAGISTERIUM_FULL_PATTERN    = /\.article\.magisterium_full\.json$/;      // full v1 (legacy, pre-prompt-versioning)
const MAGISTERIUM_FULL_PROMPT     = /\.article\.magisterium_full_prompt\.md$/; // v1 prompt
const MAGISTERIUM_FULL_V2_PATTERN = /\.article\.magisterium_full_v2\.json$/;   // full v2 (evangelizacijska revizija)
const MAGISTERIUM_FULL_V2_PROMPT  = /\.article\.magisterium_full_v2_prompt\.md$/;
const ARTICLE_PATTERN     = /\.article\.json$/;
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
};

// Cache-Control: immutable za sve outpute (generiraju se jednom, ne mijenjaju se)
const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";

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
function remuxVideo(mkvPath, mp4Path) {
    return new Promise((resolve) => {
        const proc = spawn("ffmpeg", [
            "-i", mkvPath,
            "-c:v", "copy",
            "-c:a", "aac",
            "-movflags", "+faststart",
            "-y",
            mp4Path
        ], { stdio: ["pipe", "pipe", "pipe"] });

        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

        proc.on("close", (code) => {
            if (code === 0 && fs.existsSync(mp4Path)) {
                const size = fs.statSync(mp4Path).size;
                if (size > 1000) {
                    resolve(true);
                    return;
                }
                try { fs.unlinkSync(mp4Path); } catch {}
            }
            resolve(false);
        });

        proc.on("error", () => resolve(false));
    });
}

/**
 * Remux faza: za svaki video koji ima .mkv ali nema svjež .mp4, pokreće ffmpeg.
 * Ide PRIJE discovery/upload faze.
 */
async function remuxPhase(videos, dryRun) {
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

    if (filename.endsWith(".canary.summary.json"))
        return `data/${videoId}/summary.json`;

    if (filename.endsWith(".canary.diarized.srt"))
        return `data/${videoId}/diarized.srt`;

    if (filename === `${videoBase}.info.json`)
        return `data/${videoId}/info.json`;

    if (filename === `${videoBase}.png`)
        return `images/${videoId}/thumbnail.png`;

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

    if (MAGISTERIUM_PATTERN.test(filename))
        return `data/${videoId}/article.magisterium.json`;

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
                // .png, .mkv, .mp4: samo točan match na videoBase (thumbnail / merged video)
                if (suffix === ".png" && filename !== `${videoBase}.png`) continue;
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
        if (!shouldUpload && MAGISTERIUM_PATTERN.test(filename)) shouldUpload = true;
        if (!shouldUpload && ARTICLE_PATTERN.test(filename)) shouldUpload = true;
        if (!shouldUpload && OUTLINE_PATTERN.test(filename)) shouldUpload = true;

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
        CacheControl: CACHE_CONTROL_IMMUTABLE,
    }));
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

    remuxStats = await remuxPhase(videos, dryRun);

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

    const allFiles = appFiles;

    log("📊", `Ukupno za provjeru: ${allFiles.length} (od ${discoveredFiles.length} otkrivenih datoteka)`);
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

    const R2_CHECK_CONCURRENCY = 20; // paralelni HeadObject pozivi

    // ── FAZA 1: Paralelni HeadObject za sve fajlove ───────────────
    // Samo dohvaćamo remote ETag — ne čitamo lokalne fajlove ovdje.

    log("🔍", `Provjera R2 statusa (${allFiles.length} fajlova, ${R2_CHECK_CONCURRENCY} paralelno)...`);

    const remoteEtags = new Array(allFiles.length).fill(undefined); // null = ne postoji u R2
    let checked = 0;

    const checkTasks = allFiles.map((f, i) => async () => {
        try {
            remoteEtags[i] = await getRemoteEtag(client, f.r2Key);
        } catch (err) {
            log("❌", `Greška pri provjeri ${f.r2Key}: ${err.message}`);
            remoteEtags[i] = undefined; // undefined = greška, preskočit ćemo upload
        }
        checked++;
        if (checked % 100 === 0 || checked === allFiles.length) {
            process.stdout.write(`\r   🔍 Provjereno: ${checked}/${allFiles.length}   `);
        }
    });

    await runConcurrent(checkTasks, R2_CHECK_CONCURRENCY);
    process.stdout.write("\n");

    const countMissing  = remoteEtags.filter(e => e === null).length;
    const countExisting = remoteEtags.filter(e => e !== null && e !== undefined).length;
    log("📊", `R2 status: ${countMissing} novih, ${countExisting} već postoji (uspoređujem MD5...)${failed > 0 ? `, ${failed} grešaka` : ""}`);
    console.log("");

    // ── FAZA 2: MD5 usporedba i upload ────────────────────────────
    // Novi fajlovi (remoteEtag === null) → upload odmah, bez MD5.
    // Postojeći fajlovi (remoteEtag !== null) → MD5 iz disk cachea, usporedi.

    const diskMd5Cache = loadMd5Cache();
    const memMd5Cache  = new Map(); // in-memory, dijeli MD5 za isti localPath
    let diskCacheDirty = false;

    for (let i = 0; i < allFiles.length; i++) {
        const f = allFiles[i];
        const remoteEtag = remoteEtags[i];

        // Greška u fazi 1 — preskoči
        if (remoteEtag === undefined) {
            failed++;
            continue;
        }

        let action;
        if (remoteEtag === null) {
            // Ne postoji u R2 — upload bez MD5 provjere
            action = "NOVO";
        } else {
            // Postoji — usporedi MD5
            const localMd5 = await computeMd5Cached(f.localPath, diskMd5Cache, memMd5Cache);
            diskCacheDirty = true;
            if (localMd5 === null) {
                log("❌", `Ne mogu pročitati: ${f.localPath}`);
                failed++;
                continue;
            }
            if (localMd5 === remoteEtag) {
                skipped++;
                continue; // Nepromijenjeno — preskoči
            }
            action = "UPDATE";
        }

        try {
            await uploadToR2(client, f.localPath, f.r2Key);
            if (action === "NOVO") uploaded++; else updated++;
            uploadedBytes += f.size;
            log("⬆️", `[${uploaded + updated}] ${action} ${f.r2Key} (${humanSize(f.size)})`);
        } catch (err) {
            log("❌", `Upload neuspješan za ${f.r2Key}: ${err.message}`);
            failed++;
        }
    }

    // Spremi disk MD5 cache ako se promijenio
    if (diskCacheDirty) saveMd5Cache(diskMd5Cache);

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
