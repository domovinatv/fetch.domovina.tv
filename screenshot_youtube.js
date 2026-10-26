#!/usr/bin/env node

/**
 * screenshot_youtube.js
 *
 * Izvlači screenshotove iz YouTube videa na temelju timestampova iz .article.json.
 * Koristi yt-dlp za dohvaćanje stream URL-a u najboljoj mogućoj kvaliteti (4K/1080p/720p)
 * i ffmpeg za ekstrakciju pojedinačnog framea na točnom timestampu.
 *
 * PRINCIP: Ne downloada cijeli video — samo seekira na timestamp i izvlači 1 frame.
 *
 * ANTI-BOT FALLBACK: ako yt-dlp udari u IP-level anti-bot block, automatski se
 * prebacuje na lokalni već skinuti video file (.mp4/.mkv) i izvlači frame-ove
 * ffmpeg-om offline (bez yt-dlp). Niža rezolucija (lokalna kopija), ali radi bez
 * mreže. Jednom kad anti-bot udari, ostatak run-a ide offline (ne zove više yt-dlp).
 *
 * Načini pokretanja:
 *   1. Pojedinačni article.json:
 *      node screenshot_youtube.js --file /path/to/video.article.json
 *
 *   2. Batch (svi videi koji imaju article.json):
 *      node screenshot_youtube.js --input-dir /Volumes/DOMOVINA2TB/fetch_domovina_tv_output
 *      node screenshot_youtube.js --input-dir ... --channel domovina_tv --limit 5
 *      node screenshot_youtube.js --input-dir ... --dry-run
 *
 *   3. Preko proxy-ja (zaobilaženje YouTube IP-level anti-bot blocka):
 *      node screenshot_youtube.js --input-dir ... --proxy socks5://127.0.0.1:1080
 *      node screenshot_youtube.js --input-dir ... --proxy http://user:pass@host:8080
 *      Ili putem env vara: HTTPS_PROXY=socks5://... node screenshot_youtube.js ...
 *      (CLI --proxy ima prednost nad HTTPS_PROXY/HTTP_PROXY/ALL_PROXY env varima.)
 *
 *   4. Forsiraj re-snimanje i onoga što je već na R2:
 *      node screenshot_youtube.js --input-dir ... --ignore-r2
 *
 * IZBOR NAJLJEPŠEG KADRA (default ON od 26.10.2026.): umjesto kadra točno na
 * timestampu izvuče se 21 kandidat u prozoru ±5 s (2 fps), složi u numerirani
 * list i Gemini (Vertex, gemini.conf) izabere kadar s otvorenim očima, glavom
 * gore i bez grimase, iste osobe kao na timestampu. Svaka greška → stari točni
 * kadar. Gasi se s `--no-best-frame` ili SCREENSHOT_BEST_FRAME=0. Odluka ide u
 * `_manifest.json` (`best_frame`). Vidi docs/2026-10-26-screenshot-izbor-kadra.md.
 *
 * R2-AWARE SKIP: frame koji postoji na R2 (`.r2_keys_cache.json`) se NE snima
 * ponovno ni kad lokalnog PNG-a nema. Vidi komentar uz R2_KEYS niže — bez toga
 * brisanje lokalnih izvedenih fajlova znači 62.000 uzaludnih yt-dlp poziva.
 *
 * Preduvjeti:
 *   - yt-dlp (brew install yt-dlp)
 *   - ffmpeg (brew install ffmpeg)
 *   - Brave browser za YouTube cookies (anti-bot)
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawn, spawnSync } = require("child_process");

// ─── KONFIGURACIJA ───────────────────────────────────────────────

const BROWSER_NAME = "brave";
const COOKIES_FILE = path.join(__dirname, "automatic", "cookies.txt");
const SLEEP_BETWEEN_VIDEOS_MS = 2000;
const STREAM_URL_TIMEOUT_MS = 30000;

// Dvije klase failure-a koje treba razlikovati:
//   1. "Cookies expired"   — cookies.txt zastario (bilo dani, bilo ~1h u dugim
//                            runovima). Fix: re-export iz Brave-a.
//   2. "IP-level anti-bot" — YouTube je rate-limito IP nakon puno requestova.
//                            "Sign in to confirm you're not a bot" se javlja
//                            ČAK i bez cookies-a, ČAK i za javne videe.
//                            Fix nije code: čekaj 1-24h ili VPN/proxy.
const MAX_FAILURES_BEFORE_REFRESH = 3;
const MAX_REFRESH_ATTEMPTS_PER_RUN = 3;
const MAX_FAILURES_BEFORE_ABORT = 8;  // nakon refresh-a još ovoliko = IP block
let consecutiveStreamFailures = 0;
let cookieRefreshAttempts = 0;
let lastStderr = "";
// Kad yt-dlp jednom udari u IP-level anti-bot block, prebacujemo se na
// lokalni-file fallback (ffmpeg iz već skinutog .mp4/.mkv) za OSTATAK run-a —
// ne zovemo više yt-dlp (besmisleno + dodatno hamranje YouTube-a). Trade-off:
// lokalna kopija je tipično niže rezolucije nego yt-dlp "best" stream.
let antiBotOfflineMode = false;

// Prioritet: eksportirani cookies.txt (svjež, kontrolirani) iznad browser
// cookies (mogu biti stale). Identično kao u fetch.js.
const COOKIE_ARGS = fs.existsSync(COOKIES_FILE)
    ? ["--cookies", COOKIES_FILE]
    : ["--cookies-from-browser", BROWSER_NAME];

// Proxy se postavlja iz --proxy CLI flag-a (s HTTPS_PROXY/HTTP_PROXY/ALL_PROXY
// env fallbackom) u parseArgs(). Prazan array = direktna konekcija.
let PROXY_ARGS = [];

// --source-address: bind yt-dlp socket na konkretnu lokalnu IP-u (npr. iPhone USB tether
// 172.20.10.x) bez diranja default route. Postavlja se preko `./run_pipeline.sh --via-iphone`.
let SOURCE_ADDR_ARGS = [];

// ─── R2-AWARE SKIP ───────────────────────────────────────────────
//
// Do 2026-08 je "je li ovaj frame gotov?" bilo odgovoreno ISKLJUČIVO preko
// `fs.existsSync(lokalniPNG)`. To vrijedi samo dok su lokalni PNG-ovi tu — a
// APFS migracija 14.08.2026. obrisala ih je sve (klasa DERIVED_ON_R2, ~51 GiB,
// verificirano na R2 prije brisanja; manifesti su ostali). Sljedeći run bi zato
// pokušao ponovno snimiti ~62.000 frameova s YouTubea za sadržaj koji već stoji
// na cdn.domovina.ai — dani rada i siguran anti-bot ban, oboje bez ikakve koristi.
//
// Zato: frame koji već postoji na R2 se NE snima ponovno, neovisno o lokalnom disku.
//
// Izvor istine je `.r2_keys_cache.json` — isti fajl koji `upload_to_r2.js` održava
// (LIST-once pattern; on ga dopisuje nakon svakog uploada, a `--verify-r2` ga
// rebuilda iz stvarnog stanja bucketa). Ako ga nema, ponašanje je identično
// starom (samo lokalna provjera) i nema mrežnih poziva.
//
// NAMJERNO se NE gleda `_manifest.json`: on se zapisuje za SVE timestampove iz
// članka i onda kad je snimanje palo (vidi kraj processArticle). Manifest-based
// skip bi zato trajno oslijepio baš one videe kojima frameovi stvarno fale —
// npr. KvJlt9ewgTQ / e9CzkhTD43M, kojima je 14.08. manifest zapisan uz 0 uhvaćenih
// frameova. R2 ključ je jedini dokaz da slika STVARNO postoji.
const R2_KEYS_CACHE_PATH = path.join(__dirname, ".r2_keys_cache.json");
let R2_KEYS = null;        // Set<string> | null (null = provjera isključena)

function loadR2KeysCache() {
    try {
        if (!fs.existsSync(R2_KEYS_CACHE_PATH)) return null;
        const arr = JSON.parse(fs.readFileSync(R2_KEYS_CACHE_PATH, "utf-8"));
        if (Array.isArray(arr)) return new Set(arr);                                   // v1
        if (arr && arr.v === 2 && arr.sizes) return new Set(Object.keys(arr.sizes));   // v2 (upload_to_r2.js)
        return null;
    } catch {
        return null;   // corrupt cache → tretiraj kao da ga nema (fail-safe: radi kao prije)
    }
}

/** R2 ključ za jedan frame — mora pratiti mapiranje iz upload_to_r2.js:mapToAppKey. */
function r2ScreenshotKey(videoId, timestamp) {
    return `images/${videoId}/screenshots/${sanitizeTimestamp(timestamp)}.png`;
}

let r2SkippedTotal = 0;    // brojač za završni sažetak

// ─── POMOĆNE FUNKCIJE ────────────────────────────────────────────

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Izvlači YouTube video ID iz naziva datoteke.
 * Očekuje format: ..._yt_XXXXXXXXXXX...
 */
function extractVideoIdFromFilename(filename) {
    // Last-match (fix 2026-06-06): greedy `.*` forsira ZADNJI _yt_ jer naslov SAM može
    // sadržavati "_yt_" (npr. ..._yt_kanala_crypto_hrvatska_yt_7OospmYpHRU → bez ovoga
    // bi uhvatilo "kanala_cryp"). Boundary `(?:[._]|$)` pokriva bare base I filename sa sufiksom.
    const match = filename.match(/.*_yt_([a-zA-Z0-9_-]{11})(?:[._]|$)/);
    return match ? match[1] : null;
}

/**
 * Parsira HH:MM:SS timestamp u sekunde.
 */
function timestampToSeconds(ts) {
    const parts = ts.split(":").map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
}

/**
 * Sanitizira timestamp za korištenje u nazivu datoteke (HH:MM:SS → HH-MM-SS).
 */
function sanitizeTimestamp(ts) {
    return ts.replace(/:/g, "-");
}

// ─── YT-DLP & FFMPEG ─────────────────────────────────────────────

/**
 * Re-eksportira cookies iz Brave preglednika u cookies.txt.
 * Pomaže kad YouTube auth tokeni isteknu tokom dugih batch runova.
 * Vraća true ako uspjelo. Brave mora biti pokrenut s logiranim YouTubeom.
 */
function refreshCookiesFromBrowser() {
    if (cookieRefreshAttempts >= MAX_REFRESH_ATTEMPTS_PER_RUN) {
        console.error(`   ⛔ Maksimalan broj refresh pokušaja (${MAX_REFRESH_ATTEMPTS_PER_RUN}) iscrpljen za ovaj run`);
        return false;
    }
    cookieRefreshAttempts++;
    console.log(`   🔄 Osvježavam cookies iz ${BROWSER_NAME} preglednika (pokušaj ${cookieRefreshAttempts}/${MAX_REFRESH_ATTEMPTS_PER_RUN})...`);
    try {
        const proxyFlag = PROXY_ARGS.length ? `--proxy '${PROXY_ARGS[1]}' ` : "";
        const srcAddrFlag = SOURCE_ADDR_ARGS.length ? `--source-address '${SOURCE_ADDR_ARGS[1]}' ` : "";
        execSync(
            `yt-dlp ${proxyFlag}${srcAddrFlag}--cookies-from-browser '${BROWSER_NAME}' --cookies '${COOKIES_FILE}' --skip-download --quiet --no-warnings 'https://www.youtube.com/'`,
            { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }
        );
        console.log(`   ✅ Cookies osvježeni → ${COOKIES_FILE}`);
        consecutiveStreamFailures = 0;
        return true;
    } catch (err) {
        const msg = (err.stderr ? err.stderr.toString() : err.message).split("\n")[0];
        console.error(`   ❌ Refresh cookies neuspješan: ${msg}`);
        console.error(`   💡 Provjeri je li Brave pokrenut i je li YouTube logiran`);
        return false;
    }
}

/**
 * Detektira je li yt-dlp greška IP-level anti-bot block.
 * Tipičan stderr: "Sign in to confirm you're not a bot."
 */
function isAntiBotBlock(stderr) {
    if (!stderr) return false;
    return /Sign in to confirm you[’']re not a bot/i.test(stderr) ||
           /confirm you are not a bot/i.test(stderr);
}

/**
 * Detektira age-restriction grešku. yt-dlp serializacija Brave cookies-a u
 * Netscape cookies.txt format ne čuva sve age-verification tokene; live
 * `--cookies-from-browser brave` ima što treba. Fallback se aktivira per-video.
 * Tipičan stderr: "Sign in to confirm your age. This video may be inappropriate..."
 */
function isAgeRestricted(stderr) {
    if (!stderr) return false;
    return /Sign in to confirm your age/i.test(stderr) ||
           /age-restricted/i.test(stderr) ||
           /may be inappropriate for some users/i.test(stderr);
}

/**
 * Dohvaća direktni stream URL za best video quality putem yt-dlp.
 * Razlikuje cookies-expired od IP-level anti-bot blocka.
 *   - cookies expired → refresh + retry
 *   - IP block        → refresh ne pomaže; abort cijeli run nakon N puta
 * Vraća URL string, null, ili throw-a sa "ANTI_BOT_BLOCK" za abort.
 */
function getStreamUrl(videoId, allowRefreshRetry = true, useLiveBrowserCookies = false) {
    // Per-video fallback na live brave cookies za age-restricted videe.
    // cookies.txt nema age-verification token (serializacija ne čuva sve),
    // ali live `--cookies-from-browser brave` ima → radi.
    const cookieArgs = useLiveBrowserCookies
        ? ["--cookies-from-browser", BROWSER_NAME]
        : COOKIE_ARGS;

    // FORMAT LANAC (ispravljeno 2026-07-30) — RANIJE: "96/95/94/93/18/bestvideo[ext=mp4]/…"
    // Zamka: 96/95/94/93 su HLS formati koji postoje SAMO za live streamove, pa je za
    // obični VOD lanac padao na "18" = 640x360 progressive (uvijek postoji) i do
    // "bestvideo" se nikad nije došlo. Rezultat: 360p screenshotovi kroz cijeli korpus,
    // koji se onda još i upscale-aju u og-share (1200x630) → mutno.
    // Sada bestvideo ide PRVI, s avc1 preferencom (hardverski dekod u ffmpegu; AV1/VP9
    // bi radili softverski i bili bitno sporiji). Cap 1080p — 4K ne donosi ništa za
    // 1200x630 og-share, a troši bandwidth i disk.
    const args = [
        "-f", "bestvideo[height<=1080][vcodec^=avc1]/bestvideo[height<=1080]/96/95/94/93/bestvideo/18/best",
        "--get-url",
        ...PROXY_ARGS,
        ...SOURCE_ADDR_ARGS,
        ...cookieArgs,
        "--no-check-certificate",
        `https://www.youtube.com/watch?v=${videoId}`
    ];

    try {
        if (useLiveBrowserCookies) {
            console.log(`   🔐 Decryptam Brave keychain (može potrajati ~5s)...`);
        }
        // Za live brave cookies treba TTY na stderr — macOS Keychain ne dozvoli
        // pristup Brave-ovoj decryption key-i ako pozivatelj nema tty (vidi
        // dijagnoza: https://github.com/yt-dlp/yt-dlp/issues — Security framework
        // tretira non-tty process kao background service bez UI auth-a).
        // Trade-off: yt-dlp stderr šum se izlije u naš stderr, ali age-restricted
        // videi inače uopće ne rade.
        const stderrMode = useLiveBrowserCookies ? "inherit" : "pipe";
        const url = execSync(`yt-dlp ${args.map(a => `'${a}'`).join(" ")}`, {
            encoding: "utf-8",
            timeout: STREAM_URL_TIMEOUT_MS,
            stdio: ["pipe", "pipe", stderrMode]
        }).trim();

        // Uspjeh — resetiraj counter
        consecutiveStreamFailures = 0;
        lastStderr = "";

        if (useLiveBrowserCookies) {
            console.log(`   🔞✅ Stream OK preko --cookies-from-browser (age-restricted ${videoId})`);
        }

        // yt-dlp može vratiti više URL-ova (video + audio), uzimamo prvi
        return url.split("\n")[0].trim();
    } catch (err) {
        consecutiveStreamFailures++;
        lastStderr = err.stderr ? err.stderr.toString() : "";

        // ── Age-restriction: jedinokratni fallback na live browser cookies ──
        // Pokušaj samo jednom (useLiveBrowserCookies=true sprečava infinite loop).
        if (!useLiveBrowserCookies && isAgeRestricted(lastStderr)) {
            console.log(`   🔞 Age-restricted ${videoId} — fallback na --cookies-from-browser ${BROWSER_NAME}`);
            // Ne broji ovaj failure jer ćemo retry-ati
            consecutiveStreamFailures--;
            return getStreamUrl(videoId, false, true);
        }

        // ── IP-level anti-bot ──
        // Refresh cookies-a NIŠTA ne pomaže. Najbrža potvrda: greška se
        // javlja čak i bez cookies-a. Abort run nakon dovoljno failure-a.
        if (isAntiBotBlock(lastStderr)) {
            if (consecutiveStreamFailures === 1) {
                console.log(`   🚫 YouTube anti-bot block detektiran (Sign in to confirm...)`);
                console.log(`   ℹ️  Ovo je IP-level rate limit, ne cookies problem.`);
            }
            if (consecutiveStreamFailures >= MAX_FAILURES_BEFORE_ABORT) {
                throw new Error("ANTI_BOT_BLOCK");
            }
            return null;
        }

        // ── Cookies expired (drugi tip greške) ──
        if (allowRefreshRetry && consecutiveStreamFailures >= MAX_FAILURES_BEFORE_REFRESH) {
            console.log(`   ⚠️  ${consecutiveStreamFailures} uzastopnih grešaka — pokušavam refresh cookies-a`);
            if (refreshCookiesFromBrowser()) {
                console.log(`   🔁 Pokušavam ponovo s osvježenim cookies-ima...`);
                return getStreamUrl(videoId, false);
            }
        }
        return null;
    }
}

/**
 * Pronalazi najbolji lokalni video file za fallback (kad yt-dlp padne na anti-bot).
 * captureFrame radi identično sa stream URL-om i s lokalnom putanjom (ffmpeg -i).
 * Bira najveću rezoluciju među već skinutim kontejnerima; tie-break po veličini.
 *
 * @returns {{path: string, height: number}|null}
 */
function findBestLocalVideo(dir, videoBase) {
    const exts = ["mp4", "mkv", "webm", "m4v", "mov"];
    const candidates = exts
        .map(ext => path.join(dir, `${videoBase}.${ext}`))
        .filter(p => { try { return fs.statSync(p).size > 100000; } catch { return false; } });
    if (candidates.length === 0) return null;

    let best = null;
    for (const p of candidates) {
        let height = 0;
        try {
            height = parseInt(execSync(
                `ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 '${p}'`,
                { encoding: "utf-8", timeout: 15000 }
            ).trim(), 10) || 0;
        } catch { /* nema video stream ili ffprobe fail → height 0 */ }
        const size = fs.statSync(p).size;
        // height 0 (npr. audio-only) tretiraj kao neupotrebljiv ako ima boljih
        if (!best || height > best.height || (height === best.height && size > best.size)) {
            best = { path: p, height, size };
        }
    }
    // Ako najbolji kandidat nema video stream (height 0), nije upotrebljiv.
    return best && best.height > 0 ? { path: best.path, height: best.height } : null;
}

/**
 * Izvlači jedan frame iz video streama na zadanom timestampu pomoću ffmpeg.
 * -ss prije -i = brzi seek bez dekodiranja cijelog videa.
 * Izvor (`source`) može biti yt-dlp stream URL ILI lokalna putanja — ffmpeg
 * tretira oba identično.
 *
 * @returns {boolean} true ako je screenshot uspješno spremljen
 */
function captureFrame(source, timestamp, outputPath) {
    return new Promise((resolve) => {
        const args = [
            "-ss", timestamp,
            "-i", source,
            "-frames:v", "1",
            "-update", "1",     // Potrebno za novije ffmpeg verzije s jednim frameom
            "-q:v", "1",        // Najviša kvaliteta
            "-y",               // Overwrite
            outputPath
        ];

        const proc = spawn("ffmpeg", args, {
            stdio: ["pipe", "pipe", "pipe"]
        });

        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

        proc.on("close", (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                const size = fs.statSync(outputPath).size;
                if (size > 1000) {  // Minimalno 1KB za validan screenshot
                    resolve(true);
                    return;
                }
                // Premali file — vjerovatno crni frame
                try { fs.unlinkSync(outputPath); } catch {}
            }
            resolve(false);
        });

        proc.on("error", () => resolve(false));
    });
}

// ─── IZBOR NAJLJEPŠEG KADRA (Gemini vision) ─────────────────────
//
// Problem (26.10.2026., ja70p_gJWZA): kadar točno na timestampu često uhvati
// zatvorene oči, pogled u stol, grimasu usred riječi ili pretapanje kamera —
// na 29 screenshotova jedne epizode barem 7 loših. Timestamp ne mora biti na
// sekundu, pa se bira najljepši kadar u prozoru ±BEST_FRAME_WINDOW_SEC.
//
// Jedan ffmpeg prolaz (seek + 10 s dekodiranja, ~8 s iz 1080p streama) daje sve
// kandidate u punoj rezoluciji; list za model je smanjen (640 px po ćeliji).
// Prototip kroz agy je za 29 kadrova dao prosjek 4.8 → 8.9/10.

let BEST_FRAME = process.env.SCREENSHOT_BEST_FRAME !== "0";
const BEST_FRAME_WINDOW_SEC = 5;
const BEST_FRAME_FPS = 2;
const BEST_FRAME_CONCURRENCY = 3;
// Vertex 3.8 Flash zna danima vraćati 429 (dijeljena kvota, DSQ) na eu i global
// (izmjereno 26.10.) — zato više pokušaja i duže čekanje; na kraju točni kadar.
const BEST_FRAME_MAX_RETRIES = 8;
const BEST_FRAME_REQ_TIMEOUT_MS = 90000;   // tipičan poziv ~12 s (zadano razmišljanje)
const FONT_PATH = "/System/Library/Fonts/Supplemental/Arial.ttf";

function loadGeminiConf() {
    const confPath = path.join(__dirname, "gemini.conf");
    const conf = {};
    if (fs.existsSync(confPath)) {
        for (const line of fs.readFileSync(confPath, "utf-8").split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx === -1) continue;
            conf[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
    }
    return conf;
}

const GEMINI_CONF = loadGeminiConf();
const GEMINI_MODEL = process.env.GEMINI_MODEL || GEMINI_CONF.GEMINI_MODEL || "gemini-3.8-flash";
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || GEMINI_CONF.VERTEX_PROJECT || "bimbo-sync-prod";
const VERTEX_ACCOUNT = process.env.VERTEX_ACCOUNT || GEMINI_CONF.VERTEX_ACCOUNT || "";
const VERTEX_REGIONS = (process.env.VERTEX_REGIONS || GEMINI_CONF.VERTEX_REGIONS || "global")
    .split(",").map(r => r.trim()).filter(Boolean);
const GEMINI_PRICE_IN = parseFloat(GEMINI_CONF.GEMINI_PRICE_IN || "0.75");
const GEMINI_PRICE_OUT = parseFloat(GEMINI_CONF.GEMINI_PRICE_OUT || "3.75");

let regionIndex = 0;
let cachedAccessToken = null;
let tokenExpiry = 0;
const bestFrameUsage = { calls: 0, promptTokens: 0, outputTokens: 0, agyCalls: 0 };

function getOrRefreshAccessToken() {
    const now = Date.now();
    if (cachedAccessToken && now < tokenExpiry) return cachedAccessToken;
    const { vertexAccessToken } = require("./lib/vertex_auth");
    cachedAccessToken = vertexAccessToken({ account: VERTEX_ACCOUNT });
    tokenExpiry = now + 50 * 60 * 1000;
    return cachedAccessToken;
}

const BEST_FRAME_PROMPT = (n, originalLabel) => `This contact sheet shows ${n} numbered candidate frames (c01..c${String(n).padStart(2, "0")}) from one podcast video, 0.5 s apart. ${originalLabel} is the frame at the exact timestamp. Pick the single best frame to illustrate an article section.

Rules, in order:
1. Show the SAME PERSON (same camera shot) as ${originalLabel}, unless ${originalLabel} is a transition/crossfade, blurred, black or shows nobody — then pick the best clean frame of whoever is on screen.
2. The person's eyes are open, head up, looking forward or at the conversation partner — not down at the table, lap or notes.
3. Natural neutral or pleasant expression: no grimace, no squint, no pressed or twisted lips, mouth not frozen mid-word.
4. No motion blur, no crossfade/double exposure, no hand covering the face.
If several frames are equally good, prefer the one closest to ${originalLabel}.

Reply with JSON: best (label like "c07"), best_score (1-10), original_score (1-10 for ${originalLabel}), reason (one short sentence in Croatian).`;

const BEST_FRAME_SCHEMA = {
    type: "OBJECT",
    properties: {
        best: { type: "STRING" },
        best_score: { type: "INTEGER" },
        original_score: { type: "INTEGER" },
        reason: { type: "STRING" }
    },
    required: ["best", "best_score", "original_score", "reason"]
};

function runProcess(cmd, args) {
    return new Promise((resolve) => {
        const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        proc.on("close", (code) => resolve({ code, stderr }));
        proc.on("error", (err) => resolve({ code: -1, stderr: err.message }));
    });
}

async function askGeminiBestFrame(sheetPath, n, originalLabel) {
    // SCREENSHOT_BEST_FRAME_BACKEND=agy → odmah agy, bez Vertexa (test, ili kad je
    // Vertex kvota danima puna). Ako agy ne uspije, ide se na Vertex.
    if (AGY_FIRST && agyAvailable()) {
        const verdict = await askAgyBestFrame(sheetPath, n, originalLabel);
        if (verdict) return verdict;
    }
    const { vertexEndpointUrl } = require("./lib/vertex_auth");
    const payload = {
        contents: [{
            role: "user",
            parts: [
                { text: BEST_FRAME_PROMPT(n, originalLabel) },
                { inlineData: { mimeType: "image/jpeg", data: fs.readFileSync(sheetPath).toString("base64") } }
            ]
        }],
        generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: BEST_FRAME_SCHEMA
        }
    };

    let consecutive429 = 0;
    let agyTried = false;
    for (let attempt = 1; attempt <= BEST_FRAME_MAX_RETRIES; attempt++) {
        const region = VERTEX_REGIONS[regionIndex++ % VERTEX_REGIONS.length];
        // Bez timeouta je poziv znao visjeti minutama (test 26.10.), a "fetch failed"
        // (mrežna greška) se baca umjesto da vrati status — oboje ide u retry.
        let response;
        try {
            response = await fetch(vertexEndpointUrl(VERTEX_PROJECT, region, GEMINI_MODEL), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${getOrRefreshAccessToken()}`
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(BEST_FRAME_REQ_TIMEOUT_MS)
            });
        } catch (err) {
            await sleep(2000 * attempt);
            continue;
        }
        if (!response.ok) {
            if (response.status === 401) { cachedAccessToken = null; continue; }
            if (response.status === 429) consecutive429++;
            else consecutive429 = 0;
            // Dva 429 zaredom (dvije regije) = DSQ je pun → isti list kroz agy.
            // Ako agy ne uspije, Vertex nastavlja s preostalim pokušajima.
            if (consecutive429 >= AGY_AFTER_429 && !agyTried && agyAvailable()) {
                agyTried = true;
                const verdict = await askAgyBestFrame(sheetPath, n, originalLabel);
                if (verdict) return verdict;
            }
            if (response.status === 429 || response.status >= 500) {
                await sleep(Math.min(5000 * attempt, 30000));
                continue;
            }
            throw new Error(`Gemini HTTP ${response.status} (${region}): ${(await response.text()).slice(0, 200)}`);
        }
        const data = await response.json();
        const um = data.usageMetadata || {};
        bestFrameUsage.calls++;
        bestFrameUsage.promptTokens += um.promptTokenCount || 0;
        bestFrameUsage.outputTokens += (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0);
        const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
        return { ...JSON.parse(text), model: GEMINI_MODEL };
    }
    throw new Error(`Gemini: ${BEST_FRAME_MAX_RETRIES} neuspjelih pokušaja`);
}

// ─── agy FALLBACK (Gemini kroz Antigravity CLI, tmux) ──────────
//
// Kad Vertex vraća 429 (DSQ pun, izmjereno 26.10. na eu i global), isti list ide
// kroz agy: Gemini 3.8 Flash na Google AI Pro pretplati, $0 i neovisno o Vertex
// kvoti. `agy -p` ne vraća odgovor (bug od 1.3.5), pa upit ide kroz `tmux
// send-keys`, a agy odgovor zapiše u datoteku (isti obrazac kao
// ~/.claude/scripts/agy_glasovna.sh). Jedna sesija → pozivi idu jedan po jedan.
// Sporije od Vertexa (prototip ~37 s po listu), zato samo kao fallback.
//
// Radni dir mora biti „trusted" u agy-ju (~/git je trusted roditelj), inače agy
// pita i visi. Ako se agy ne pokrene (nije prijavljen), gasi se do kraja runa.
// Gasi se i s SCREENSHOT_AGY_FALLBACK=0. Gledanje: tmux attach -t agyss -r

const AGY_AFTER_429 = 2;
const AGY_FIRST = process.env.SCREENSHOT_BEST_FRAME_BACKEND === "agy";
const AGY_SESSION = process.env.SCREENSHOT_AGY_SESSION || "agyss";
const AGY_MODEL = process.env.SCREENSHOT_AGY_MODEL || "gemini-3.8-flash-high";
const AGY_DIR = path.join(require("os").homedir(), "git", ".agy-screenshots");
const AGY_TIMEOUT_MS = 180000;
let agyDisabled = process.env.SCREENSHOT_AGY_FALLBACK === "0";
let agyReady = false;
let agyQueue = Promise.resolve();

function agyAvailable() {
    if (agyDisabled) return false;
    const which = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
    if (!which("tmux") || !which("agy")) { agyDisabled = true; return false; }
    return true;
}

function tmux(...a) {
    return spawnSync("tmux", a, { encoding: "utf-8" });
}

async function agyEnsureSession() {
    if (agyReady && tmux("has-session", "-t", AGY_SESSION).status === 0) return true;
    agyReady = false;
    fs.mkdirSync(AGY_DIR, { recursive: true });
    if (tmux("has-session", "-t", AGY_SESSION).status !== 0) {
        tmux("new-session", "-d", "-s", AGY_SESSION, "-x", "180", "-y", "50", "-c", AGY_DIR);
        tmux("send-keys", "-t", AGY_SESSION, `agy --model ${AGY_MODEL} --dangerously-skip-permissions`, "Enter");
    }
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const screen = tmux("capture-pane", "-p", "-t", AGY_SESSION).stdout || "";
        // Novi direktorij: agy pita za povjerenje. Prva opcija je „Yes".
        if (/trust the contents/i.test(screen)) { tmux("send-keys", "-t", AGY_SESSION, "Enter"); continue; }
        if (screen.includes("for shortcuts")) { agyReady = true; return true; }
    }
    console.log(`   ⚠️  agy se nije pokrenuo (prijava?) — fallback ugašen do kraja runa`);
    tmux("kill-session", "-t", AGY_SESSION);
    agyDisabled = true;
    return false;
}

function agySend(text) {
    tmux("send-keys", "-t", AGY_SESSION, "-l", text);
    spawnSync("sleep", ["0.5"]);
    tmux("send-keys", "-t", AGY_SESSION, "Enter");
}

async function agyAsk(sheetPath, n, originalLabel) {
    if (!(await agyEnsureSession())) return null;
    const stem = `req-${process.pid}-${Date.now()}`;
    const img = path.join(AGY_DIR, `${stem}.jpg`);
    const out = path.join(AGY_DIR, `${stem}.json`);
    fs.copyFileSync(sheetPath, img);
    try {
        agySend("/clear");
        await sleep(3000);
        agySend(`Pogledaj sliku ${stem}.jpg. ${BEST_FRAME_PROMPT(n, originalLabel).replace(/\n+/g, " ")} ` +
            `Write ONLY the JSON object {"best","best_score","original_score","reason"} to the file ${stem}.json. ` +
            `Do not run scripts or other tools, do not crop or edit the image — just look at it and write the file.`);
        const t0 = Date.now();
        while (Date.now() - t0 < AGY_TIMEOUT_MS) {
            await sleep(3000);
            if (!fs.existsSync(out)) continue;
            try {
                const v = JSON.parse(fs.readFileSync(out, "utf-8"));
                if (v && v.best) {
                    bestFrameUsage.agyCalls++;
                    return { ...v, model: `agy:${AGY_MODEL}` };
                }
            } catch { /* agy još piše datoteku */ }
        }
        console.log(`   ⚠️  agy: nema odgovora nakon ${AGY_TIMEOUT_MS / 1000} s`);
        // Prekini zaglavljeni potez, inače /clear i idući upit čekaju u redu iza njega.
        tmux("send-keys", "-t", AGY_SESSION, "Escape");
        await sleep(2000);
        tmux("send-keys", "-t", AGY_SESSION, "Escape");
        return null;
    } finally {
        fs.rmSync(img, { force: true });
        fs.rmSync(out, { force: true });
    }
}

// Serijalizira pozive iz BEST_FRAME_CONCURRENCY workera kroz jednu tmux sesiju.
function askAgyBestFrame(sheetPath, n, originalLabel) {
    const run = agyQueue.then(() => agyAsk(sheetPath, n, originalLabel)).catch(() => null);
    agyQueue = run;
    return run;
}

function logBestFrameUsage() {
    if (bestFrameUsage.calls) {
        const usd = bestFrameUsage.promptTokens / 1e6 * GEMINI_PRICE_IN + bestFrameUsage.outputTokens / 1e6 * GEMINI_PRICE_OUT;
        console.log(`   🎯 Izbor kadra (${GEMINI_MODEL}): ${bestFrameUsage.calls} poziva · ${bestFrameUsage.promptTokens} in / ${bestFrameUsage.outputTokens} out · ~$${usd.toFixed(3)}`);
    }
    if (bestFrameUsage.agyCalls) {
        console.log(`   🎯 Izbor kadra (agy:${AGY_MODEL}, fallback na Vertex 429): ${bestFrameUsage.agyCalls} poziva · $0`);
    }
}

/**
 * Izvuče kandidate oko timestampa, pita Gemini za najljepši i spremi ga u outputPath.
 * @returns {object|null} odluka za manifest, ili null → pozivatelj radi stari captureFrame
 */
async function captureBestFrame(source, timestamp, outputPath) {
    const sec = timestampToSeconds(timestamp);
    const start = Math.max(0, sec - BEST_FRAME_WINDOW_SEC);
    const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "bestframe-"));
    try {
        const { code } = await runProcess("ffmpeg", [
            "-loglevel", "error",
            "-ss", String(start),
            "-i", source,
            "-t", String(sec - start + BEST_FRAME_WINDOW_SEC + 0.4),
            "-vf", `fps=${BEST_FRAME_FPS}`,
            path.join(tmpDir, "c%02d.png")
        ]);
        const frames = fs.readdirSync(tmpDir).filter(f => /^c\d\d\.png$/.test(f)).sort();
        if (code !== 0 || frames.length < 3) return null;

        const originalIdx = Math.min(frames.length, Math.round((sec - start) * BEST_FRAME_FPS) + 1);
        const originalLabel = `c${String(originalIdx).padStart(2, "0")}`;

        const sheetPath = path.join(tmpDir, "sheet.jpg");
        const montageArgs = ["montage", ...frames.map(f => path.join(tmpDir, f))];
        if (fs.existsSync(FONT_PATH)) montageArgs.push("-font", FONT_PATH);
        montageArgs.push("-resize", "640x", "-set", "label", "%t", "-pointsize", "30",
            "-tile", "5x", "-geometry", "+4+4", "-quality", "85", sheetPath);
        const m = await runProcess("magick", montageArgs);
        if (m.code !== 0 || !fs.existsSync(sheetPath)) return null;

        const verdict = await askGeminiBestFrame(sheetPath, frames.length, originalLabel);
        const chosen = /^c\d\d$/.test(verdict.best || "") && frames.includes(`${verdict.best}.png`)
            ? verdict.best : originalLabel;
        fs.copyFileSync(path.join(tmpDir, `${chosen}.png`), outputPath);
        if (fs.statSync(outputPath).size <= 1000) return null;

        const idx = parseInt(chosen.slice(1), 10);
        return {
            offset_sec: Math.round(((start + (idx - 1) / BEST_FRAME_FPS) - sec) * 10) / 10,
            score: verdict.best_score,
            original_score: verdict.original_score,
            reason: verdict.reason,
            candidates: frames.length,
            model: verdict.model || GEMINI_MODEL
        };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// ─── ARTICLE PROCESSING ──────────────────────────────────────────

/**
 * Izvlači sve screenshot timestampove iz article.json.
 * @returns {Array<{timestamp, description, section_subtitle, iteration_number}>}
 */
function extractScreenshots(articleJson) {
    const screenshots = [];
    if (!articleJson.iterations) return screenshots;

    for (const iter of articleJson.iterations) {
        if (!iter.sections) continue;
        for (const section of iter.sections) {
            if (section.screenshot_timestamp) {
                screenshots.push({
                    timestamp: section.screenshot_timestamp,
                    description: section.screenshot_description || "",
                    section_subtitle: section.subtitle || "",
                    iteration_number: iter.iteration_number
                });
            }
        }
    }
    return screenshots;
}

/**
 * Obrađuje jedan article.json — izvlači sve screenshotove za taj video.
 * @returns {{total: number, captured: number, skipped: number, failed: number}}
 */
async function processArticle(articlePath) {
    const dir = path.dirname(articlePath);
    const articleFilename = path.basename(articlePath);

    // Izvuci base video ime (bez _DATE_MODEL.article.json sufiksa)
    const videoBase = articleFilename.replace(/\.wav\.canary\.diarized_.*\.article\.json$/, "");
    const videoId = extractVideoIdFromFilename(videoBase);

    if (!videoId) {
        console.error(`   ❌ Ne mogu izvući YouTube ID iz: ${articleFilename}`);
        return { total: 0, captured: 0, skipped: 0, failed: 0 };
    }

    // Audio-only (beamly direct-MP3: subclub, launched) epizode nemaju pravi YouTube video —
    // _yt_ je sintetički ID (npr. 3e963b98XXX), pa yt-dlp vrati "Video unavailable" za svaku.
    // info.json marker `_yt_matched === false` pouzdano ih razlikuje (verificirano 2026-06-27:
    // matched=true → 112 ep imaju screenshote, false → 154 nemaju — 100% korelacija). Preskoči
    // PRIJE yt-dlp poziva da ne hammeramo YouTube s ~150+ beskorisnih lookupa po runu (rizik
    // anti-bot fingerprinta + bačeno vrijeme). Matchane beamly epizode (_yt_matched=true) prolaze normalno.
    // localOnly: ne-YouTube izvor (npr. X/Twitter, info.json `_source` != 'youtube').
    // Takav video IMA pravi video track (skinut lokalno), ali `_yt_<id>` je sintetički
    // synthId pa `yt-dlp --get-url https://youtube.com/watch?v=<synthId>` ne postoji.
    // → idi ODMAH na lokalni-file (ffmpeg) put, bez uzaludnog YouTube stream pokušaja.
    let localOnly = false;
    // Varijanta epizode (eksperiment, sintetički ID npr. OspwepfLO_2): kadrovi su iz izvornog
    // YouTube videa (`_variant_of`), a ključevi/datoteke ostaju na sintetičkom ID-u.
    let streamVideoId = videoId;
    const infoPath = path.join(dir, `${videoBase}.info.json`);
    if (fs.existsSync(infoPath)) {
        try {
            const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
            if (info._yt_matched === false) {
                console.log(`   🎧 Audio-only (beamly, _yt_matched=false) — preskačem screenshote: ${videoBase}`);
                return { total: 0, captured: 0, skipped: 0, failed: 0 };
            }
            // `_yt_matched === true` znači da epizoda IMA pravi YouTube video (beamly
            // matchan na YT), pa je stream put ispravan — `_source` sam po sebi nije
            // dokaz sintetičkog ID-a. Bez ove ograde su 4 matchane subclub epizode
            // (1R1_ZbmLyJI, jzlPf100vy4, sKonOtcJFTU, DnzG2OvRflI) trajno padale na
            // "ne mogu dohvatiti ni stream URL ni lokalni video" — lokalni .mp4 ne
            // postoji jer se za matchane epizode i ne skida.
            if (info._source && info._source !== "youtube" && info._yt_matched !== true) {
                localOnly = true;
            }
            if (typeof info._variant_of === "string" && /^[\w-]{11}$/.test(info._variant_of)) {
                streamVideoId = info._variant_of;
                console.log(`   🔀 Varijanta od ${streamVideoId} — kadrovi iz izvornog videa`);
            }
        } catch (_) { /* nevažeći info.json — nastavi normalno (yt-dlp put) */ }
    }

    // Parsiraj article.json
    let article;
    try {
        article = JSON.parse(fs.readFileSync(articlePath, "utf-8"));
    } catch (err) {
        console.error(`   ❌ Nevažeći JSON: ${articleFilename}`);
        return { total: 0, captured: 0, skipped: 0, failed: 0 };
    }

    const screenshots = extractScreenshots(article);
    if (screenshots.length === 0) {
        console.log(`   ⚠️  Nema screenshot timestampova u: ${articleFilename}`);
        return { total: 0, captured: 0, skipped: 0, failed: 0 };
    }

    // Provjeri koji screenshotovi već postoje
    const screenshotDir = path.join(dir, `${videoBase}_screenshots`);
    const pending = [];
    let skipped = 0;

    for (const ss of screenshots) {
        const outputFile = path.join(screenshotDir, `${videoBase}_${sanitizeTimestamp(ss.timestamp)}.png`);
        if (fs.existsSync(outputFile)) {
            skipped++;
        } else {
            pending.push({ ...ss, outputFile });
        }
    }

    // Frame kojeg lokalno nema, ali JE na R2 — ne snimaj ponovno (vidi R2-AWARE SKIP
    // gore). Filtrira se PRIJE dohvata stream URL-a, jer je cijela poanta ne zvati
    // yt-dlp za video kojemu ništa stvarno ne fali.
    let r2Skipped = 0;
    if (R2_KEYS) {
        for (let i = pending.length - 1; i >= 0; i--) {
            if (R2_KEYS.has(r2ScreenshotKey(videoId, pending[i].timestamp))) {
                pending.splice(i, 1);
                r2Skipped++;
            }
        }
        r2SkippedTotal += r2Skipped;
    }

    if (pending.length === 0) {
        if (r2Skipped > 0) {
            console.log(`   ☁️  Svi screenshotovi postoje (${skipped} lokalno, ${r2Skipped} na R2) — preskačem yt-dlp`);
        } else {
            console.log(`   ✅ Svi screenshotovi već postoje (${skipped}/${screenshots.length})`);
        }
        return { total: screenshots.length, captured: 0, skipped: skipped + r2Skipped, failed: 0 };
    }

    if (skipped > 0 || r2Skipped > 0) {
        const parts = [];
        if (skipped > 0) parts.push(`${skipped} lokalno`);
        if (r2Skipped > 0) parts.push(`${r2Skipped} na R2`);
        console.log(`   ⏭️  ${parts.join(" + ")} već postoji, ${pending.length} preostalo`);
    }

    // Od ovdje nadalje "skipped" znači "nije trebalo snimiti", neovisno o razlogu —
    // da svi return-ovi ispod broje isto.
    skipped += r2Skipped;

    // Odredi izvor frame-ova: yt-dlp stream (best quality) ili — ako yt-dlp
    // padne na anti-bot — lokalni već skinuti .mp4/.mkv (ffmpeg iz lokalnog filea).
    let source = null;
    let sourceLabel = "";

    if (localOnly) {
        console.log(`   📁 Ne-YouTube izvor (_source) — koristim lokalni video file (ffmpeg), bez YouTube streama.`);
    } else if (!antiBotOfflineMode) {
        // Dohvati stream URL (jednom za sve screenshotove istog videa)
        console.log(`   🔗 Dohvaćam stream URL za ${videoId} (best quality)...`);
        try {
            const streamUrl = getStreamUrl(streamVideoId);
            if (streamUrl) {
                source = streamUrl;
                sourceLabel = "yt-dlp stream (best quality)";
            } else if (isAntiBotBlock(lastStderr)) {
                antiBotOfflineMode = true;
            }
        } catch (err) {
            if (err.message === "ANTI_BOT_BLOCK") {
                antiBotOfflineMode = true;
            } else {
                throw err;
            }
        }
        if (antiBotOfflineMode) {
            console.log(`   🚫 YouTube anti-bot — prelazim na lokalni-file fallback (ffmpeg, offline) za OSTATAK run-a`);
        }
    }

    // Fallback: lokalni video file (kad nema stream URL-a — anti-bot ili istekli cookies).
    if (!source) {
        const local = findBestLocalVideo(dir, videoBase);
        if (local) {
            source = local.path;
            sourceLabel = `lokalni file ${local.height}p (${path.extname(local.path).slice(1)})`;
            console.log(`   📁 Fallback izvor: ${path.basename(local.path)} [${local.height}p] — niža kvaliteta od yt-dlp "best"`);
        }
    }

    if (!source) {
        console.error(`   ❌ Ne mogu dohvatiti ni stream URL ni lokalni video za ${videoId}`);
        if (lastStderr) {
            const errLine = lastStderr.split("\n").find(l => l.includes("ERROR")) || lastStderr.split("\n").slice(0, 3).join(" | ");
            console.error(`      yt-dlp: ${errLine.slice(0, 240)}`);
        }
        return { total: screenshots.length, captured: 0, skipped, failed: pending.length };
    }

    console.log(`   🎬 Izvor frame-ova: ${sourceLabel}`);

    // Kreiraj screenshot direktorij
    if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
    }

    // Izvuci svaki frame
    let captured = 0;
    let failed = 0;

    // Izbor kadra radi BEST_FRAME_CONCURRENCY timestampova paralelno (ffmpeg seek
    // iz streama + Gemini poziv), pa se ispisuje cijeli redak odjednom.
    const bestFrames = {};
    const captureOne = async (ss) => {
        let decision = null;
        if (BEST_FRAME) {
            try {
                decision = await captureBestFrame(source, ss.timestamp, ss.outputFile);
            } catch (err) {
                console.log(`      ⚠️  ${ss.timestamp} izbor kadra pao (${err.message.slice(0, 120)}) — točni kadar`);
            }
        }
        const ok = decision ? true : await captureFrame(source, ss.timestamp, ss.outputFile);
        const label = `      📸 ${ss.timestamp} — ${ss.section_subtitle.substring(0, 50)}... `;
        if (ok) {
            const sizeKb = (fs.statSync(ss.outputFile).size / 1024).toFixed(0);
            const pick = decision
                ? ` 🎯 ${decision.offset_sec >= 0 ? "+" : ""}${decision.offset_sec}s ${decision.original_score}→${decision.score}/10`
                : "";
            console.log(`${label}✅ (${sizeKb} KB)${pick}`);
            if (decision) bestFrames[ss.timestamp] = decision;
            captured++;
        } else {
            console.log(`${label}❌`);
            failed++;
        }
    };
    const queue = [...pending];
    const workers = Array.from({ length: BEST_FRAME ? BEST_FRAME_CONCURRENCY : 1 }, async () => {
        while (queue.length) await captureOne(queue.shift());
    });
    await Promise.all(workers);

    // Odluke iz ranijih runova (kadrovi koji su sada preskočeni) ostaju u manifestu.
    const manifestPath = path.join(screenshotDir, "_manifest.json");
    let previousBest = {};
    try {
        for (const s of JSON.parse(fs.readFileSync(manifestPath, "utf-8")).screenshots || []) {
            if (s.best_frame) previousBest[s.timestamp] = s.best_frame;
        }
    } catch {}

    // Spremi manifest s metapodacima za sve screenshotove
    const manifest = {
        video_id: videoId,
        video_base: videoBase,
        article_file: articleFilename,
        generated_at: new Date().toISOString(),
        screenshots: screenshots.map(ss => ({
            timestamp: ss.timestamp,
            filename: `${videoBase}_${sanitizeTimestamp(ss.timestamp)}.png`,
            description: ss.description,
            section_subtitle: ss.section_subtitle,
            iteration: ss.iteration_number,
            ...((bestFrames[ss.timestamp] || previousBest[ss.timestamp])
                ? { best_frame: bestFrames[ss.timestamp] || previousBest[ss.timestamp] } : {})
        }))
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    return { total: screenshots.length, captured, skipped, failed };
}

// ─── DISCOVERY ────────────────────────────────────────────────────

/**
 * Pronalazi sve .article.json datoteke za obradu.
 * Za svaki video bira najnoviju article.json (po datumu u imenu).
 */
function discoverArticleFiles(inputDir, channelFilter, videoIdFilter) {
    const results = [];

    const entries = fs.readdirSync(inputDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!(entry.isDirectory() || entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;
        if (channelFilter && entry.name !== channelFilter) continue;

        const channelName = entry.name;
        const channelDir = path.join(inputDir, channelName);
        const files = fs.readdirSync(channelDir);

        // Grupiraj article.json po video bazi, uzmi najnoviji
        const byVideo = new Map();

        for (const file of files) {
            if (!file.endsWith(".article.json")) continue;
            if (file.startsWith("._")) continue;
            // Filtriraj po YouTube video ID-u (u imenu kao _yt_VIDEOID)
            if (videoIdFilter && !file.includes(`_yt_${videoIdFilter}`)) continue;

            const videoBase = file.replace(/\.wav\.canary\.diarized_.*\.article\.json$/, "");
            if (!byVideo.has(videoBase) || file > byVideo.get(videoBase)) {
                byVideo.set(videoBase, file);
            }
        }

        for (const [videoBase, articleFile] of byVideo) {
            const articlePath = path.join(channelDir, articleFile);
            const screenshotDir = path.join(channelDir, `${videoBase}_screenshots`);
            const manifestPath = path.join(screenshotDir, "_manifest.json");

            // Provjeri ima li manifest (označava da je obrada završena)
            // Ali i dalje dodaj — processArticle provjerava pojedinačne fileove
            results.push({
                articlePath,
                channel: channelName,
                videoBase,
                hasManifest: fs.existsSync(manifestPath)
            });
        }
    }

    // Sortiraj: najnoviji videi prvo (YYYYMMDD prefiks)
    results.sort((a, b) => b.videoBase.localeCompare(a.videoBase));

    return results;
}

// ─── CLI ──────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    function getArg(name) {
        const idx = args.indexOf(name);
        return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
    }

    const file = getArg("--file");
    const inputDir = getArg("--input-dir");
    const channel = getArg("--channel");
    // --video-id filter: u batch modu obradi samo jedan video po YouTube ID-u (11 znakova)
    const videoId = getArg("--video-id");
    const limit = getArg("--limit") ? parseInt(getArg("--limit"), 10) : null;
    const dryRun = args.includes("--dry-run");

    // --proxy zaobilazi YouTube IP-level anti-bot block. CLI ima prednost nad
    // env varima (HTTPS_PROXY/HTTP_PROXY/ALL_PROXY). Format: socks5://host:port,
    // http://user:pass@host:port, itd. (sve što yt-dlp prihvaća).
    const proxy = getArg("--proxy")
        || process.env.HTTPS_PROXY
        || process.env.HTTP_PROXY
        || process.env.ALL_PROXY
        || null;
    if (proxy) {
        PROXY_ARGS = ["--proxy", proxy];
    }

    // --source-address bind-a yt-dlp socket na lokalnu IP-u (npr. iPhone tether
    // 172.20.10.13) bez mijenjanja default route. Komplementarno s --proxy.
    const sourceAddr = getArg("--source-address");
    if (sourceAddr) {
        SOURCE_ADDR_ARGS = ["--source-address", sourceAddr];
    }

    // --no-best-frame: stari način — jedan kadar točno na timestampu, bez Geminija.
    if (args.includes("--no-best-frame")) {
        BEST_FRAME = false;
    }

    // --ignore-r2: forsiraj re-snimanje i onoga što je na R2 (npr. kad su frameovi
    // na R2 loši/360p pa ih namjerno želiš prepisati). Default je R2-aware skip.
    if (!args.includes("--ignore-r2")) {
        R2_KEYS = loadR2KeysCache();
    }

    if (!file && !inputDir) {
        console.error("❌ Obavezan argument: --file <putanja> ili --input-dir <putanja>");
        console.error("");
        console.error("Primjeri:");
        console.error("  node screenshot_youtube.js --file /path/to/video.article.json");
        console.error("  node screenshot_youtube.js --input-dir /Volumes/DOMOVINA2TB/fetch_domovina_tv_output");
        console.error("  node screenshot_youtube.js --input-dir ... --channel domovina_tv --limit 5");
        console.error("  node screenshot_youtube.js --input-dir ... --video-id dQw4w9WgXcQ");
        console.error("  node screenshot_youtube.js --input-dir ... --dry-run");
        console.error("  node screenshot_youtube.js --input-dir ... --proxy socks5://127.0.0.1:1080");
        process.exit(1);
    }

    if (file) {
        if (!fs.existsSync(file)) {
            console.error(`❌ Datoteka ne postoji: ${file}`);
            process.exit(1);
        }
        return { mode: "single", file };
    }

    if (!fs.existsSync(inputDir)) {
        console.error(`❌ Direktorij ne postoji: ${inputDir}`);
        process.exit(1);
    }

    return { mode: "batch", inputDir, channel, videoId, limit, dryRun };
}

// ─── MAIN ─────────────────────────────────────────────────────────

async function main() {
    const opts = parseArgs();

    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📸 YOUTUBE SCREENSHOT EXTRACTOR                ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   🔧 yt-dlp + ffmpeg (best available quality)`);
    console.log(`   🍪 Cookies: ${fs.existsSync(COOKIES_FILE) ? COOKIES_FILE : `browser:${BROWSER_NAME}`}`);
    if (PROXY_ARGS.length) {
        // Maskiraj credentials u logu (user:pass@host → ***@host)
        const masked = PROXY_ARGS[1].replace(/\/\/[^@]+@/, "//***@");
        console.log(`   🌐 Proxy:   ${masked}`);
    }
    if (SOURCE_ADDR_ARGS.length) {
        console.log(`   📡 Bind IP: ${SOURCE_ADDR_ARGS[1]}`);
    }
    if (R2_KEYS) {
        console.log(`   ☁️  R2 skip:  ${R2_KEYS.size} ključeva iz .r2_keys_cache.json (frame na R2 se ne snima ponovno)`);
    } else {
        console.log(`   ☁️  R2 skip:  ISKLJUČEN — snima se sve što lokalno fali`);
    }

    // ── Single file mode ──
    if (opts.mode === "single") {
        console.log(`   📂 Datoteka: ${opts.file}`);
        console.log("");

        const result = await processArticle(opts.file);
        console.log("");
        console.log(`   📊 Ukupno: ${result.total} | Novo: ${result.captured} | Preskočeno: ${result.skipped} | Neuspjelo: ${result.failed}`);
        logBestFrameUsage();
        console.log("");
        return;
    }

    // ── Batch mode ──
    const { inputDir, channel, videoId, limit, dryRun } = opts;
    console.log(`   📂 Input:   ${inputDir}`);
    if (channel) console.log(`   🎯 Kanal:   ${channel}`);
    if (videoId) console.log(`   🎯 Video ID: ${videoId}`);
    if (limit) console.log(`   🔢 Limit:   ${limit}`);
    if (dryRun) console.log("   ⚠️  DRY RUN — samo prikaz, bez screenshotanja");
    console.log("");

    console.log("   Skeniram direktorije...");
    const allFiles = discoverArticleFiles(inputDir, channel, videoId);

    console.log(`   📊 Videa s article.json: ${allFiles.length}`);
    console.log("");

    if (allFiles.length === 0) {
        console.log("   ✨ Nema article.json datoteka za obradu.");
        return;
    }

    const finalList = limit ? allFiles.slice(0, limit) : allFiles;

    // Pre-flight: koliko ih već ima `_manifest.json` (znači batch završen u
    // prethodnom run-u, processArticle će ih instant-skipnuti) vs koliko ne
    // ima manifest (potpuno novi videi, stvarno treba rad). Daje korisniku
    // upfront sliku "koliko od X iteracija je realno posla".
    // Caveat: hasManifest=true ne garantira da su SVI PNG-ovi tu (user može
    // ručno obrisati frame); takvi case-evi su rijetki i pickup-aju ih per-PNG
    // existsSync provjere unutar processArticle.
    const withManifest = finalList.filter(it => it.hasManifest).length;
    const withoutManifest = finalList.length - withManifest;
    console.log(`   📊 Pre-flight:`);
    console.log(`      ✅ Sa manifestom (vjerojatno fully done):  ${withManifest}`);
    console.log(`      📸 Bez manifesta (potpuno novi videi):     ${withoutManifest}`);
    console.log("");

    if (dryRun) {
        console.log(`   📋 Videi za obradu (${finalList.length}):`);
        for (let i = 0; i < finalList.length; i++) {
            const item = finalList[i];
            const marker = item.hasManifest ? "✅" : "📸";
            console.log(`      ${String(i + 1).padStart(4)}. ${marker} [${item.channel}] ${item.videoBase}`);
        }
        console.log("");
        return;
    }

    // Obradi sve
    let totalCaptured = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let videosProcessed = 0;

    let abortedAntiBot = false;
    let jobCount = 0;  // Brojač samo videa koji STVARNO trebaju rad (bez manifesta)
    for (let i = 0; i < finalList.length; i++) {
        const item = finalList[i];
        // Dual counter: [iter | job] — iter ide kroz sve, job samo kroz one koji
        // trebaju rad. Daje smisleni progres umjesto samo "X/2559" gdje 98%
        // budu instant-skipovi.
        let jobLabel = "";
        if (!item.hasManifest) {
            jobCount++;
            jobLabel = ` | job ${jobCount}/${withoutManifest}`;
        }
        console.log(`\n   ━━━ [${i + 1}/${finalList.length}${jobLabel}] [${item.channel}] ${item.videoBase} ━━━`);

        let result;
        try {
            result = await processArticle(item.articlePath);
        } catch (err) {
            if (err.message === "ANTI_BOT_BLOCK") {
                abortedAntiBot = true;
                console.log("");
                console.log("╔══════════════════════════════════════════════════╗");
                console.log("║   🚫 ABORT: YouTube IP-level anti-bot block      ║");
                console.log("╚══════════════════════════════════════════════════╝");
                console.log(`   Posljednji yt-dlp stderr (sažeto):`);
                console.log(`     ${lastStderr.split("\n").find(l => l.includes("ERROR")) || lastStderr.split("\n")[0]}`);
                console.log("");
                console.log("   Što sad:");
                console.log("     1. Sačekaj 1-24h da YouTube oslobodi IP block");
                console.log("     2. ILI promijeni IP (VPN, mobile hotspot, drugi network)");
                console.log("     3. ILI proslijedi proxy: --proxy socks5://host:port");
                console.log("        (ili HTTPS_PROXY=socks5://... env var)");
                console.log("     4. Onda ponovo: ./run_pipeline.sh --with-screenshots ...");
                console.log("");
                console.log(`   Stigao do: ${i}/${finalList.length} videa`);
                break;
            }
            throw err;
        }
        totalCaptured += result.captured;
        totalSkipped += result.skipped;
        totalFailed += result.failed;
        if (result.captured > 0) videosProcessed++;

        // Pauza između videa (yt-dlp rate limiting)
        if (result.captured > 0 && i < finalList.length - 1) {
            await sleep(SLEEP_BETWEEN_VIDEOS_MS);
        }
    }

    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📊 SCREENSHOT BATCH ZAVRŠEN                   ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📸 Novih screenshotova:  ${totalCaptured}`);
    console.log(`   ⏭️  Preskočenih:         ${totalSkipped}`);
    if (r2SkippedTotal > 0) {
        console.log(`      od toga s R2:        ${r2SkippedTotal} (lokalno ih nema, ali su na cdn.domovina.ai)`);
    }
    if (totalFailed > 0) console.log(`   ❌ Neuspjelih:           ${totalFailed}`);
    console.log(`   🎬 Videa obrađenih:      ${videosProcessed}`);
    logBestFrameUsage();
    console.log("");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
