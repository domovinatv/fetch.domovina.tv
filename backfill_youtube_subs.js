#!/usr/bin/env node

/**
 * backfill_youtube_subs.js — povlači YouTube titlove za VEĆ preuzete videe.
 *
 * `fetch.js` od 2026-07 skida `--write-auto-subs` uz svaki novi download, ali sve
 * ranije obrađene epizode nemaju taj artefakt. Ova skripta ih dohvaća naknadno,
 * BEZ ponovnog skidanja zvuka ili videa (`--skip-download`) — dakle jeftino i bez
 * diranja postojećih datoteka.
 *
 * Zašto nam trebaju: engleski kanali prolaze kroz Canary s `--source-lang hr`, što
 * je zapravo EN→HR speech-translation. Taj put tiho ispušta cijele chunkove zvuka
 * (catholic_futurist gubi 8.9%, pojedine epizode preko 50%) i nigdje ne čuva izvorni
 * engleski tekst. YouTube auto-caption je nezavisan zapis protiv kojeg se to mjeri.
 * Vidi docs/transcript_coverage_gap_2026-07.md.
 *
 * Ne ulazi ni u jedan pipeline korak — čisti referentni artefakt.
 *
 * Korištenje:
 *   node backfill_youtube_subs.js --channel catholic_futurist
 *   node backfill_youtube_subs.js --channel subclub --dry-run
 *   node backfill_youtube_subs.js --english-only --limit 50
 *   node backfill_youtube_subs.js --video-id biRibr8NByE
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- KONFIGURACIJA ---
const DEFAULT_OUTPUT_DIR = path.join(__dirname, "storage", "output");
const COOKIES_FILE = path.join(__dirname, "automatic", "cookies.txt");
const BROWSER_NAME = "brave";

// Kanali na engleskom — za njih je YT caption jedini zapis izvornog jezika.
const ENGLISH_CHANNELS = ["catholic_futurist", "subclub", "launched"];

// Anti-bot. Titlovni endpoint je OSJETLJIVIJI od download endpointa: svaki poziv radi
// player API request + jedan dohvat po jeziku, pa 2s razmaka (kao u fetch.js) udari u
// HTTP 429 već nakon ~17 epizoda. Izmjereno 2026-07-27. 5s drži liniju.
const DEFAULT_SLEEP_MS = 5000;
const ERROR_THRESHOLD = 5;
const COOL_DOWN_MS = 60000;

// 429 nije trajna greška — vrati se na ISTI video nakon pauze, inače tiho ostane rupa.
const RATE_LIMIT_BACKOFF_MS = [60000, 180000, 420000];

// --- CLI (Pattern B) ---
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const OPTS = {
    inputDir: getArg("--input-dir") || DEFAULT_OUTPUT_DIR,
    channel: getArg("--channel"),
    videoId: getArg("--video-id"),
    limit: getArg("--limit") ? parseInt(getArg("--limit"), 10) : Infinity,
    sleepMs: getArg("--sleep") ? parseInt(getArg("--sleep"), 10) : DEFAULT_SLEEP_MS,
    subLangs: getArg("--sub-langs") || "hr,en",
    englishOnly: args.includes("--english-only"),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force")
};

// --- POMOĆNE FUNKCIJE (kopirane po repo konvenciji, ne importane) ---

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractVideoIdFromFilename(filename) {
    // Last-match (fix 2026-06-06): greedy `.*` forsira ZADNJI _yt_ jer naslov SAM može
    // sadržavati "_yt_". Boundary `(?:[._]|$)` pokriva bare base I filename sa sufiksom.
    const match = filename.match(/.*_yt_([a-zA-Z0-9_-]{11})(?:[._]|$)/);
    return match ? match[1] : null;
}

/**
 * Beamly epizode dobivaju sintetički 11-znakovni _yt_ ID koji NE postoji na YouTubeu
 * (marker `_yt_matched: false` u info.json). Za njih titlovi ne postoje — preskačemo
 * ih tiho da ne trošimo pozive i ne palimo anti-bot prag.
 */
function hasRealYoutubeId(infoJsonPath) {
    if (!fs.existsSync(infoJsonPath)) return true;  // nema markera → pretpostavi pravi YT
    try {
        return JSON.parse(fs.readFileSync(infoJsonPath, "utf-8"))._yt_matched !== false;
    } catch {
        return true;
    }
}

/** Postoji li već ijedan .srt/.vtt titl za ovaj base (bilo koji jezik)? */
function hasSubtitles(channelDir, base) {
    const langs = OPTS.subLangs.split(",").map(s => s.trim()).filter(Boolean);
    return langs.some(lang =>
        [".srt", ".vtt"].some(ext => fs.existsSync(path.join(channelDir, `${base}.${lang}${ext}`)))
    );
}

function buildCookieArgs() {
    if (fs.existsSync(COOKIES_FILE)) return ["--cookies", COOKIES_FILE];
    return ["--cookies-from-browser", BROWSER_NAME];
}

// --- SKUPLJANJE KANDIDATA ---

function collectCandidates() {
    const entries = fs.readdirSync(OPTS.inputDir, { withFileTypes: true })
        // Symlinkani kanali: isDirectory() je false za symlink, mora se pitati i za link.
        .filter(e => e.isDirectory() || e.isSymbolicLink());

    let channels = entries.map(e => e.name);
    if (OPTS.channel) channels = channels.filter(c => c === OPTS.channel);
    else if (OPTS.englishOnly) channels = channels.filter(c => ENGLISH_CHANNELS.includes(c));

    const candidates = [];
    const skipped = { synthetic: 0, alreadyHave: 0 };

    for (const channel of channels.sort()) {
        const channelDir = path.join(OPTS.inputDir, channel);
        let files;
        try {
            files = fs.readdirSync(channelDir);
        } catch {
            continue;
        }

        for (const f of files.sort()) {
            if (f.startsWith("._") || !f.endsWith(".mp3")) continue;
            const base = f.replace(/\.mp3$/, "");
            if (base.endsWith(".loudnorm")) continue;  // izvedeni audio, isti video

            const videoId = extractVideoIdFromFilename(base);
            if (!videoId) continue;
            if (OPTS.videoId && videoId !== OPTS.videoId) continue;

            if (!hasRealYoutubeId(path.join(channelDir, `${base}.info.json`))) {
                skipped.synthetic++;
                continue;
            }
            if (!OPTS.force && hasSubtitles(channelDir, base)) {
                skipped.alreadyHave++;
                continue;
            }

            candidates.push({ channel, channelDir, base, videoId });
        }
    }

    return { candidates, skipped };
}

// --- DOHVAT ---

function fetchSubtitles(candidate) {
    const outputTemplate = path.join(candidate.channelDir, `${candidate.base}.%(ext)s`);
    const ytArgs = [
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-lang", OPTS.subLangs,
        "--sub-format", "srt/vtt",
        "--no-check-certificate",
        "--no-warnings",
        ...buildCookieArgs(),
        "-o", outputTemplate,
        `https://www.youtube.com/watch?v=${candidate.videoId}`
    ];

    const res = spawnSync("yt-dlp", ytArgs, { encoding: "utf-8", timeout: 180000 });
    const output = `${res.stdout || ""}${res.stderr || ""}`;

    // yt-dlp izlazi s 0 i kad titlova jednostavno nema — to nije greška, nego nalaz.
    if (/There are no subtitles for the requested languages|has no automatic captions/.test(output)) {
        return { status: "none" };
    }
    if (/HTTP Error 429|Too Many Requests/.test(output)) {
        return { status: "ratelimit" };
    }
    if (res.status !== 0) {
        const line = output.split("\n").find(l => l.includes("ERROR")) || `exit ${res.status}`;
        return { status: "error", detail: line.trim().slice(0, 160) };
    }

    const written = (output.match(/Writing video subtitles to: (.+)/g) || [])
        .map(l => path.basename(l.replace("Writing video subtitles to: ", "")));
    return written.length ? { status: "ok", written } : { status: "none" };
}

// --- MAIN ---

async function main() {
    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📝 BACKFILL YOUTUBE TITLOVA (referenca)       ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📂 Input:   ${OPTS.inputDir}`);
    console.log(`   🌐 Jezici:  ${OPTS.subLangs}`);
    if (OPTS.channel) console.log(`   🎯 Kanal:   ${OPTS.channel}`);
    if (OPTS.englishOnly) console.log(`   🎯 Samo engleski kanali: ${ENGLISH_CHANNELS.join(", ")}`);
    if (OPTS.videoId) console.log(`   🎯 Video:   ${OPTS.videoId}`);
    if (OPTS.dryRun) console.log("   🧪 DRY RUN — bez poziva");
    console.log("");

    const { candidates, skipped } = collectCandidates();

    console.log(`   📋 Kandidata:              ${candidates.length}`);
    console.log(`   ⏭️  Preskočeno (beamly):    ${skipped.synthetic} (sintetički _yt_ ID, nema YouTube videa)`);
    console.log(`   ⏭️  Preskočeno (već ima):   ${skipped.alreadyHave}`);
    console.log("");

    if (OPTS.dryRun || candidates.length === 0) {
        for (const c of candidates.slice(0, 20)) console.log(`      • [${c.channel}] ${c.videoId}  ${c.base.slice(0, 60)}`);
        if (candidates.length > 20) console.log(`      … i još ${candidates.length - 20}`);
        return;
    }

    const stats = { ok: 0, none: 0, error: 0, rateLimited: 0 };
    let consecutiveErrors = 0;
    const todo = candidates.slice(0, OPTS.limit);

    for (let i = 0; i < todo.length; i++) {
        const c = todo[i];
        process.stdout.write(`   [${i + 1}/${todo.length}] [${c.channel}] ${c.videoId} … `);

        let res = fetchSubtitles(c);

        // 429: pauziraj i vrati se na ISTI video. Preskakanje bi ostavilo rupu koju
        // sljedeći run ne bi razlikovao od "ovaj video nema titlove".
        for (let attempt = 0; res.status === "ratelimit" && attempt < RATE_LIMIT_BACKOFF_MS.length; attempt++) {
            const wait = RATE_LIMIT_BACKOFF_MS[attempt];
            console.log(`⏳ 429 — čekam ${wait / 1000}s (pokušaj ${attempt + 1}/${RATE_LIMIT_BACKOFF_MS.length})`);
            await sleep(wait);
            process.stdout.write(`   [${i + 1}/${todo.length}] [${c.channel}] ${c.videoId} … `);
            res = fetchSubtitles(c);
        }

        if (res.status === "ratelimit") {
            stats.rateLimited++;
            console.log("🛑 429 i nakon svih pauza — prekidam (ostatak ostaje za idući run)");
            break;
        }

        if (res.status === "ok") {
            stats.ok++;
            consecutiveErrors = 0;
            console.log(`✅ ${res.written.map(w => w.split(".").slice(-2).join(".")).join(", ")}`);
        } else if (res.status === "none") {
            stats.none++;
            consecutiveErrors = 0;
            console.log("➖ nema titlova");
        } else {
            stats.error++;
            consecutiveErrors++;
            console.log(`❌ ${res.detail}`);

            if (consecutiveErrors >= ERROR_THRESHOLD) {
                console.log(`   ⚠️  ${consecutiveErrors} uzastopnih grešaka — pauza ${COOL_DOWN_MS / 1000}s (anti-bot)`);
                await sleep(COOL_DOWN_MS);
                consecutiveErrors = 0;
            }
        }

        if (i < todo.length - 1) await sleep(OPTS.sleepMs);
    }

    console.log("");
    console.log("   ─────────────────────────────────────");
    console.log(`   ✅ Preuzeto:      ${stats.ok}`);
    console.log(`   ➖ Nema titlova:  ${stats.none}`);
    console.log(`   ❌ Grešaka:       ${stats.error}`);
    if (stats.rateLimited) {
        console.log(`   🛑 Prekinuto zbog 429 — pokreni ponovno kasnije (idempotentno, preskače već preuzeto)`);
    }
    console.log("");
}

main().catch(err => {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
});
