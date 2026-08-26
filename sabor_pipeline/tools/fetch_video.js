#!/usr/bin/env node

/**
 * fetch_video.js — preuzimanje slike sjednice u `video/part_NN.mp4`
 *
 * `01_ingest.js` skida SAMO `bestaudio`, jer sve nizvodne faze (diarizacija,
 * ASR, LLM) rade nad zvukom i slika im je bespotrebnih nekoliko GB. Ali za
 * ručni pregled u `sabor_review/` slika je često presudan dokaz: lice govornika
 * i ime koje režija ispiše u donjoj traci.
 *
 * Do sada je tu ulogu igrao YouTube `<iframe>`. Tri stvari koje on ne može:
 *
 *   1. **Ne premota se bez ponovnog učitavanja.** Bez YouTube IFrame API-ja
 *      (vanjska skripta) svaki skok znači novi `src` — okvir se ruši i gradi
 *      iznova, pa uspoređivanje dva trenutka traje sekundama umjesto trenutak.
 *   2. **Ne pokreće se sam.** Autoplay u prekograničnom `<iframe>`-u pada na
 *      politikama preglednika, pa svaki `▶` traži još jedan klik u okviru.
 *      Lokalni `<video>` je isti element kao `<audio>` — `play()` nakon
 *      korisnikovog klika prolazi.
 *   3. **Traži internet i pristaje na anti-bot.** Pregled je lokalni alat nad
 *      snimkom koja je već na disku; slika ne bi trebala biti iznimka.
 *
 * ⚠️ Datoteka se NE upisuje u `session_manifest.json`. Manifest je vremenska os
 * sjednice — svaki nizvodni deep link računa se iz njega — i ne dira se zbog
 * pomoćnog artefakta koji ne mijenja nijedno trajanje. `sabor_review/server.js`
 * zato traži `video/part_NN.*` po DOGOVORU O IMENU, a manifest čita samo ako
 * `video_file` ondje već postoji.
 *
 * Format: 480p avc1 (`-f 135`) + m4a zvuk, spojeno u mp4. Isti izbor kao
 * `ocr_captions.js` i iz istog mjerenja: na 360p natpis s ekrana više nije
 * pouzdano čitljiv, a 720p ne donosi ništa osim dvostruke datoteke
 * (`docs/sabor_ocr_imena_s_ekrana_2026-08.md`). Za 20 h sjednice u 4 dijela to
 * je ~5.5 GB.
 *
 * Idempotentno: preskače dijelove koji već postoje i nisu krnji (trajanje je
 * jedini dokaz — yt-dlp zna izaći s 0 i na prekinutom preuzimanju).
 *
 * Primjeri:
 *   node sabor_pipeline/tools/fetch_video.js --session sabor_11_izvanredna_11_gospic --dry-run
 *   node sabor_pipeline/tools/fetch_video.js --session sabor_11_izvanredna_11_gospic
 *   node sabor_pipeline/tools/fetch_video.js --session sabor_11_izvanredna_11_gospic --part 3
 */

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "storage", "output", "sabor");
const COOKIES_FILE = path.join(REPO_ROOT, "cookies.txt");
const BROWSER_NAME = "brave";

// Isti UA kao 01_ingest.js i fetch.js — YouTube je osjetljiv na nesklad UA/klijenta.
const MY_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

const DURATION_TOLERANCE_SEC = 2;
const DELAY_BETWEEN_DOWNLOADS_MS = 3000;
// Ostavi diska koliko je za još jedan dio — pola preuzetog dijela nije upotrebljivo.
const MIN_FREE_HEADROOM_BYTES = 3 * 1024 * 1024 * 1024;

// --- CLI (Pattern B) ---

const args = process.argv.slice(2);
const getArg = (name, dflt = null) => {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : dflt;
};
const hasFlag = (name) => args.includes(name);

const SESSION = getArg("--session");
const OUTPUT_DIR = getArg("--output-dir") || DEFAULT_OUTPUT_DIR;
const ONLY_PART = getArg("--part") ? Number(getArg("--part")) : null;
const FMT = getArg("--fmt", "135");
const SOURCE_ADDRESS = getArg("--source-address");
const DRY_RUN = hasFlag("--dry-run");
const FORCE = hasFlag("--force");

if (!SESSION || hasFlag("--help") || hasFlag("-h")) {
    console.log(`
Uporaba: node sabor_pipeline/tools/fetch_video.js --session <id> [opcije]

  --session <id>        ID sjednice (direktorij u storage/output/sabor/)
  --output-dir <dir>    Izlazni direktorij (default: storage/output/sabor)
  --part <N>            Samo taj dio
  --fmt <id>            yt-dlp video format (default: 135 = 854x480 avc1)
  --source-address <ip> Proslijedi yt-dlp-u (npr. iPhone hotspot IP)
  --force               Preuzmi ponovno i kad datoteka postoji
  --dry-run             Ispiši plan bez preuzimanja
`);
    process.exit(SESSION ? 0 : 1);
}

// --- Pomoćne ---

function ytDlpBaseArgs() {
    const base = [
        "--no-playlist",
        "--user-agent", MY_USER_AGENT,
        "--remote-components", "ejs:github",
        "--no-check-certificate",
        "--no-progress",
    ];
    if (fs.existsSync(COOKIES_FILE)) base.push("--cookies", COOKIES_FILE);
    else base.push("--cookies-from-browser", BROWSER_NAME);
    if (SOURCE_ADDRESS) base.push("--source-address", SOURCE_ADDRESS);
    return base;
}

function humanBytes(n) {
    const units = ["B", "kB", "MB", "GB", "TB"];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
}

function freeBytes(dir) {
    let probe = dir;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    const st = fs.statfsSync(probe);
    return st.bavail * st.bsize;
}

function secondsToHms(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function probeDuration(file) {
    if (!fs.existsSync(file)) return null;
    const res = spawnSync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", file,
    ], { encoding: "utf8" });
    const val = parseFloat((res.stdout || "").trim());
    return Number.isFinite(val) ? val : null;
}

function runAsync(cmd, cmdArgs) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, cmdArgs, { stdio: "inherit" });
        proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
        proc.on("error", reject);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Datoteka dijela bez obzira na nastavak (mp4/mkv/webm) — kao findExisting u 01_ingest.js. */
function findExisting(dir, stem) {
    if (!fs.existsSync(dir)) return null;
    const hit = fs.readdirSync(dir).find((f) => f.startsWith(`${stem}.`) && !f.endsWith(".part"));
    return hit ? path.join(dir, hit) : null;
}

// --- Glavni tok ---

async function main() {
    const sessionDir = path.join(OUTPUT_DIR, SESSION);
    const manifestFile = path.join(sessionDir, "session_manifest.json");
    if (!fs.existsSync(manifestFile)) {
        console.error(`⛔ Nema ${path.relative(REPO_ROOT, manifestFile)} — pokreni prvo 01_ingest.js.`);
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    let parts = manifest.parts || [];
    if (ONLY_PART !== null) parts = parts.filter((p) => p.part === ONLY_PART);
    if (!parts.length) {
        console.error(`⛔ Manifest nema ${ONLY_PART !== null ? `dio ${ONLY_PART}` : "nijedan dio"}.`);
        process.exit(1);
    }

    const videoDir = path.join(sessionDir, "video");
    if (!DRY_RUN) fs.mkdirSync(videoDir, { recursive: true });

    const ukupno = parts.reduce((s, p) => s + (p.duration_sec || 0), 0);
    console.log(`\n🎬 ${SESSION} — ${parts.length} dio(dijelova), ${secondsToHms(ukupno)}, format ${FMT}`);
    console.log(`   izlaz: ${path.relative(REPO_ROOT, videoDir)}`);
    console.log(`   slobodno: ${humanBytes(freeBytes(sessionDir))}\n`);

    let preuzeto = 0, preskoceno = 0;
    const neuspjeli = [];

    for (const p of parts) {
        const stem = `part_${String(p.part).padStart(2, "0")}`;
        const existing = findExisting(videoDir, stem);

        if (existing && !FORCE) {
            const dur = probeDuration(existing);
            // Krnja snimka je gora od nikakve: player bi je otvorio i tiho stao
            // na pola sjednice, a to izgleda kao da snimka tu i završava.
            if (dur !== null && Math.abs(dur - p.duration_sec) <= DURATION_TOLERANCE_SEC) {
                console.log(`   ⏭️  ${stem}: već preuzet (${secondsToHms(dur)}, ${humanBytes(fs.statSync(existing).size)})`);
                preskoceno++;
                continue;
            }
            console.warn(`   ⚠️  ${stem}: krnji (${dur === null ? "nečitljiv" : secondsToHms(dur)} vs ${secondsToHms(p.duration_sec)}) — preuzimam ponovno`);
            if (!DRY_RUN) fs.unlinkSync(existing);
        } else if (existing && FORCE && !DRY_RUN) {
            fs.unlinkSync(existing);
        }

        if (DRY_RUN) {
            console.log(`   ⬇️  ${stem}: ${p.video_id} (${secondsToHms(p.duration_sec)}) — [dry-run]`);
            continue;
        }
        if (freeBytes(sessionDir) < MIN_FREE_HEADROOM_BYTES) {
            neuspjeli.push(`${stem}: premalo diska (${humanBytes(freeBytes(sessionDir))})`);
            console.error(`   ⛔ ${stem}: premalo diska — prekidam.`);
            break;
        }

        console.log(`   ⬇️  ${stem}: ${p.video_id} (${secondsToHms(p.duration_sec)})`);
        const t0 = Date.now();
        try {
            await runAsync("yt-dlp", [
                ...ytDlpBaseArgs(),
                // Izričit format, NE „bestvideo". Zamka iz screenshot_youtube.js:
                // lanac koji krene od live-only HLS formata tiho vrati 360p.
                "-f", `${FMT}+bestaudio[ext=m4a]/${FMT}+bestaudio/best[height<=480]`,
                "--merge-output-format", "mp4",
                "-o", path.join(videoDir, `${stem}.%(ext)s`),
                `https://www.youtube.com/watch?v=${p.video_id}`,
            ]);
        } catch (e) {
            neuspjeli.push(`${stem}: ${e.message}`);
            console.error(`   ⛔ ${stem}: ${e.message}`);
            continue;
        }

        const got = findExisting(videoDir, stem);
        const dur = got ? probeDuration(got) : null;
        if (!got || dur === null || Math.abs(dur - p.duration_sec) > DURATION_TOLERANCE_SEC) {
            if (got) fs.unlinkSync(got);
            neuspjeli.push(`${stem}: krnje preuzimanje (${dur === null ? "nečitljivo" : Math.round(dur) + "s"} vs ${Math.round(p.duration_sec)}s)`);
            console.error(`   ⛔ ${stem}: krnje — obrisano.`);
            continue;
        }
        preuzeto++;
        console.log(`   ✅ ${stem}: ${humanBytes(fs.statSync(got).size)} u ${Math.round((Date.now() - t0) / 1000)}s`);

        if (p !== parts[parts.length - 1]) await sleep(DELAY_BETWEEN_DOWNLOADS_MS);
    }

    console.log(`\n📊 preuzeto ${preuzeto}, preskočeno ${preskoceno}, neuspjelo ${neuspjeli.length}`);
    for (const n of neuspjeli) console.log(`   ⛔ ${n}`);
    console.log(neuspjeli.length
        ? "\n⚠️  Pregled radi i s dijelovima koji nedostaju — za njih ostaje zvuk.\n"
        : "\n✅ Pregled sada svira lokalnu sliku. Osvježi stranicu.\n");
    process.exit(neuspjeli.length ? 1 : 0);
}

main().catch((e) => { console.error(`⛔ ${e.message}`); process.exit(1); });
