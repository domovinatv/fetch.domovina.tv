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
 *      node screenshot_youtube.js --input-dir /Volumes/DOMOVINA1TB/fetch_domovina_tv_output
 *      node screenshot_youtube.js --input-dir ... --channel domovina_tv --limit 5
 *      node screenshot_youtube.js --input-dir ... --dry-run
 *
 *   3. Preko proxy-ja (zaobilaženje YouTube IP-level anti-bot blocka):
 *      node screenshot_youtube.js --input-dir ... --proxy socks5://127.0.0.1:1080
 *      node screenshot_youtube.js --input-dir ... --proxy http://user:pass@host:8080
 *      Ili putem env vara: HTTPS_PROXY=socks5://... node screenshot_youtube.js ...
 *      (CLI --proxy ima prednost nad HTTPS_PROXY/HTTP_PROXY/ALL_PROXY env varima.)
 *
 * Preduvjeti:
 *   - yt-dlp (brew install yt-dlp)
 *   - ffmpeg (brew install ffmpeg)
 *   - Brave browser za YouTube cookies (anti-bot)
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

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

    const args = [
        "-f", "96/95/94/93/18/bestvideo[ext=mp4]/bestvideo/best",
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

    if (pending.length === 0) {
        console.log(`   ✅ Svi screenshotovi već postoje (${skipped}/${screenshots.length})`);
        return { total: screenshots.length, captured: 0, skipped, failed: 0 };
    }

    if (skipped > 0) {
        console.log(`   ⏭️  ${skipped} screenshotova već postoji, ${pending.length} preostalo`);
    }

    // Odredi izvor frame-ova: yt-dlp stream (best quality) ili — ako yt-dlp
    // padne na anti-bot — lokalni već skinuti .mp4/.mkv (ffmpeg iz lokalnog filea).
    let source = null;
    let sourceLabel = "";

    if (!antiBotOfflineMode) {
        // Dohvati stream URL (jednom za sve screenshotove istog videa)
        console.log(`   🔗 Dohvaćam stream URL za ${videoId} (best quality)...`);
        try {
            const streamUrl = getStreamUrl(videoId);
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

    for (const ss of pending) {
        process.stdout.write(`      📸 ${ss.timestamp} — ${ss.section_subtitle.substring(0, 50)}... `);
        const ok = await captureFrame(source, ss.timestamp, ss.outputFile);
        if (ok) {
            const sizeKb = (fs.statSync(ss.outputFile).size / 1024).toFixed(0);
            console.log(`✅ (${sizeKb} KB)`);
            captured++;
        } else {
            console.log(`❌`);
            failed++;
        }
    }

    // Spremi manifest s metapodacima za sve screenshotove
    const manifestPath = path.join(screenshotDir, "_manifest.json");
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
            iteration: ss.iteration_number
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

    if (!file && !inputDir) {
        console.error("❌ Obavezan argument: --file <putanja> ili --input-dir <putanja>");
        console.error("");
        console.error("Primjeri:");
        console.error("  node screenshot_youtube.js --file /path/to/video.article.json");
        console.error("  node screenshot_youtube.js --input-dir /Volumes/DOMOVINA1TB/fetch_domovina_tv_output");
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

    // ── Single file mode ──
    if (opts.mode === "single") {
        console.log(`   📂 Datoteka: ${opts.file}`);
        console.log("");

        const result = await processArticle(opts.file);
        console.log("");
        console.log(`   📊 Ukupno: ${result.total} | Novo: ${result.captured} | Preskočeno: ${result.skipped} | Neuspjelo: ${result.failed}`);
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
    if (totalFailed > 0) console.log(`   ❌ Neuspjelih:           ${totalFailed}`);
    console.log(`   🎬 Videa obrađenih:      ${videosProcessed}`);
    console.log("");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
