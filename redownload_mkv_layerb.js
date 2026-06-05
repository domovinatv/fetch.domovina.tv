#!/usr/bin/env node
/**
 * redownload_mkv_layerb.js
 * ────────────────────────
 * Re-download "layer-B" epizoda (one koje imaju SAMO format-18 `.mp4`, bez `.mkv`)
 * da dobiju pravi `.mkv` master: odvojeni bestvideo[h<=360] (VP9/AV1) + bestaudio
 * (Opus ~130k) → merge u `.mkv`. Time se popravlja i video codec i SLAB audio
 * (format 18 ima ~48k AAC). Vidi docs/video_formats_inventory_2026-06.md.
 *
 * NE klobbera postojeće: skida u temp pa atomski move SAMO ako je rezultat `.mkv`.
 * Ako YouTube za taj video stvarno nudi samo format 18 (nema odvojenih streamova),
 * merge ne uspije → ostaje `.mp4`-only, prijavi se i preskoči (ništa se ne dira).
 *
 * Anti-bot: ide kroz iPhone proxy/tether (YouTube IP fingerprint). Sekvencijalno
 * + 3s pauza + cooldown na nizu grešaka (kao fetch.js). Vidi memorije
 * iphone_http_proxy_via_tailscale / yt_dlp_source_address_via_iphone.
 *
 * POSLIJE ovog: re-transcode H.264 iz novog .mkv-a:
 *   node backfill_video_h264.js --force --channel <ch>   (ili po videu)
 *
 * Primjeri:
 *   node redownload_mkv_layerb.js --dry-run                              # plan: koje epizode
 *   node redownload_mkv_layerb.js --proxy http://100.71.146.11:8888      # iPhone Tailscale proxy
 *   node redownload_mkv_layerb.js --via-iphone                           # auto-detect 172.20.10.x tether
 *   node redownload_mkv_layerb.js --proxy http://... --channel cryptoverse_kripto_caffe
 *   node redownload_mkv_layerb.js --proxy http://... --limit 5           # test na 5
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

// ─── CLI ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def = null) { const i = args.indexOf(name); return i !== -1 && i + 1 < args.length ? args[i + 1] : def; }
function hasFlag(name) { return args.includes(name); }

const OUTPUT_DIR   = getArg("--input-dir", path.join(__dirname, "storage", "output"));
const ONLY_CHANNEL = getArg("--channel");
const LIMIT        = parseInt(getArg("--limit", "0"), 10);
const DRY_RUN      = hasFlag("--dry-run");
const PROXY        = getArg("--proxy");                 // npr. http://100.71.146.11:8888
let   SOURCE_ADDR  = getArg("--source-address");        // npr. 172.20.10.13
const VIA_IPHONE   = hasFlag("--via-iphone");           // auto-detect tether IP
// Cookies OPT-IN: --cookies-from-browser u non-tty (spawnSync) silently faila i daje
// slomljen prazan .mkv (memory macos_keychain_tty_yt_dlp). Clean cellular IP (proxy)
// ionako ne treba cookies. Koristi --cookies-file SAMO ako eksplicitno zadano.
const COOKIES_FILE = getArg("--cookies-file");
const MIN_VALID_BYTES = 1048576;   // <1MB = slomljen download (npr. 4KB EBML stub)
const DELAY_MS     = parseInt(getArg("--delay", "3000"), 10);
const COOLDOWN_MS  = 60000;
const ERR_THRESHOLD = 3;

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// --via-iphone: nađi lokalnu IP u 172.20.10.x (Personal Hotspot subnet)
if (VIA_IPHONE && !SOURCE_ADDR) {
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) {
            if (a.family === "IPv4" && a.address.startsWith("172.20.10.")) { SOURCE_ADDR = a.address; break; }
        }
        if (SOURCE_ADDR) break;
    }
    if (SOURCE_ADDR) console.log(`📡 --via-iphone: bind na ${SOURCE_ADDR}`);
    else console.log("⚠️  --via-iphone: nisam našao 172.20.10.x IP (je li iPhone tether aktivan?). Nastavljam bez bind-a.");
}

// ─── Discovery: layer-B epizode (mp4 && !mkv) ─────────────────────
function extractVideoId(base) { const m = base.match(/_yt_([A-Za-z0-9_-]{11})$/); return m ? m[1] : null; }
function listDirs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("._"))
        .map(e => e.name);
}
const INT = /\.f\d+\.mp4$/;
function discover() {
    const eps = [];
    const channels = ONLY_CHANNEL ? [ONLY_CHANNEL] : listDirs(OUTPUT_DIR);
    for (const ch of channels) {
        const chDir = path.join(OUTPUT_DIR, ch);
        let files; try { files = fs.readdirSync(chDir); } catch { continue; }
        const mkv = new Set(), mp4 = new Map();   // base → true
        for (const f of files) {
            if (f.startsWith("._") || f.includes(".loudnorm.") || INT.test(f)) continue;
            if (f.endsWith(".mkv")) mkv.add(f.slice(0, -4));
            else if (f.endsWith(".mp4") && !f.endsWith(".web.mp4")) mp4.set(f.slice(0, -4), true);
        }
        for (const base of mp4.keys()) {
            if (mkv.has(base)) continue;            // ima .mkv → nije layer-B, preskoči
            const vid = extractVideoId(base);
            if (!vid) continue;
            eps.push({ channel: ch, base, videoId: vid, chDir,
                       mkvPath: path.join(chDir, `${base}.mkv`),
                       url: `https://www.youtube.com/watch?v=${vid}` });
        }
    }
    eps.sort((a, b) => b.base.localeCompare(a.base));
    return LIMIT > 0 ? eps.slice(0, LIMIT) : eps;
}

// ─── yt-dlp args (mirror fetch.js, ali samo video merge → mkv) ────
function ytdlpArgs(ep, tmpDir) {
    const a = [
        "-f", "bestvideo[height<=360]+bestaudio/best[height<=360]",
        "--merge-output-format", "mkv",         // forsiraj mkv kontejner na merge-u
        "--prefer-free-formats",
        "--write-info-json",
        "--user-agent", USER_AGENT,
        "--remote-components", "ejs:github",
        "--no-check-certificate",
        "--restrict-filenames",
        "--no-progress",
        "-o", path.join(tmpDir, "%(id)s.%(ext)s"),
    ];
    if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) a.push("--cookies", COOKIES_FILE);
    if (PROXY) a.push("--proxy", PROXY);
    if (SOURCE_ADDR) a.push("--source-address", SOURCE_ADDR);
    a.push(ep.url);
    return a;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Obrada jedne epizode ─────────────────────────────────────────
function downloadOne(ep) {
    const tmpDir = path.join(ep.chDir, `.redl_tmp_${ep.videoId}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
        const r = spawnSync("yt-dlp", ytdlpArgs(ep, tmpDir), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        if (r.status !== 0) {
            const err = (r.stderr || "").trim().split("\n").slice(-2).join(" ");
            return { status: "FAIL", error: err.slice(-180) };
        }
        // Nađi rezultat: .mkv = uspjeh (odvojeni streamovi); .mp4 = i dalje fmt18-only
        const produced = fs.readdirSync(tmpDir).filter(f => f.endsWith(".mkv") || f.endsWith(".mp4"));
        const mkvFile = produced.find(f => f.endsWith(".mkv"));
        if (mkvFile) {
            fs.renameSync(path.join(tmpDir, mkvFile), ep.mkvPath);   // atomski u channel dir
            const sz = fs.statSync(ep.mkvPath).size;
            if (sz < MIN_VALID_BYTES) {                              // slomljen (4KB EBML stub)
                fs.rmSync(ep.mkvPath, { force: true });
                return { status: "FAIL", error: `slomljen .mkv (${sz}B) — vjerojatno cookies/auth problem` };
            }
            return { status: "mkv", mb: (sz / 1048576).toFixed(0) };
        }
        return { status: "still-mp4" };   // YouTube nema odvojene streamove za ovaj video
    } catch (e) {
        return { status: "FAIL", error: e.message };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// ─── Main (sekvencijalno + anti-bot cooldown) ─────────────────────
(async () => {
    const eps = discover().filter(ep => !fs.existsSync(ep.mkvPath));
    console.log(`Layer-B epizoda za re-download: ${eps.length}${ONLY_CHANNEL ? ` (kanal ${ONLY_CHANNEL})` : ""}`);
    if (PROXY) console.log(`🌐 proxy: ${PROXY}`);
    if (!eps.length) return;
    if (DRY_RUN) {
        eps.forEach((e, i) => console.log(`  [${i + 1}/${eps.length}] ${e.videoId}  ${e.channel}/${e.base.slice(0, 60)}`));
        console.log(`\n[DRY-RUN] Bi pokušalo ${eps.length} re-downloada. Dodaj --proxy ... za stvarno.`);
        return;
    }

    const by = { mkv: 0, "still-mp4": 0, FAIL: 0 };
    let consecutive = 0;
    for (let i = 0; i < eps.length; i++) {
        const ep = eps[i];
        const tag = `[${i + 1}/${eps.length}] ${ep.videoId}`;
        const res = downloadOne(ep);
        by[res.status] = (by[res.status] || 0) + 1;
        if (res.status === "mkv") { console.log(`${tag} ✓ .mkv ${res.mb}MB → ${ep.channel}/`); consecutive = 0; }
        else if (res.status === "still-mp4") { console.log(`${tag} ⏭️  YouTube nudi samo fmt18 (nema odvojenih streamova) — ostaje .mp4`); consecutive = 0; }
        else {
            console.error(`${tag} ✗ ${res.error}`);
            consecutive++;
            if (consecutive >= ERR_THRESHOLD) {
                console.log(`   ⏸️  ${ERR_THRESHOLD} uzastopne greške → cooldown ${COOLDOWN_MS / 1000}s (anti-bot?)`);
                await sleep(COOLDOWN_MS);
                consecutive = 0;
            }
        }
        if (i < eps.length - 1) await sleep(DELAY_MS);
    }

    console.log("\n=== SAŽETAK ===");
    console.log(`  ✓ Novi .mkv:            ${by.mkv}`);
    console.log(`  ⏭️  Ostaje .mp4 (fmt18):  ${by["still-mp4"]}`);
    console.log(`  ✗ Neuspjelih:          ${by.FAIL}`);
    if (by.mkv) console.log(`\nSljedeće: re-transcode H.264 iz novih .mkv → node backfill_video_h264.js --force ...`);
    if (by.FAIL) process.exitCode = 1;
})();
