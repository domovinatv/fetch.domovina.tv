#!/usr/bin/env node

/**
 * tools/scan_modal_candidates.js — popis WAV-ova koje Modal treba transkribirati.
 *
 * ZAŠTO NODE, A NE `find` U SHELLU
 * --------------------------------
 * Do 2026-08-28 je KORAK 2.6 gradio listu shell `find`-om. Pod launchd-om je
 * taj `find` na SVAKOM kanalskom direktoriju vraćao `Operation not permitted`
 * (macOS TCC: agent pokreće `/bin/bash`, koji nema pristup vanjskim volumenima
 * na koje kanali pokazuju symlinkovima), stderr je išao u /dev/null, a rezultat
 * je bio prazna lista. `📋 Modal kandidata: 0` u svakom nightlyju od 02.08. do
 * 27.08.2026. — 26 noći u kojima nijedna epizoda praćenog kanala nije
 * automatski transkribirana, a nitko to nije vidio jer je korak non-fatal.
 * Node (nvm binary) ima pristup — `convert_to_wav.js` je cijelo to vrijeme
 * uredno čitao iste direktorije u istom runu. Otud ovaj skript.
 * Vidi docs/2026-08-27-nightly-modal-nula-kandidata.md.
 *
 * ZAŠTO NEMA mtime GATEA
 * ----------------------
 * Stara verzija je uzimala samo WAV-ove mlađe od MODAL_FRESH_DAYS (2). To znači
 * da je propuštena noć bila TRAJNA: epizoda starija od dva dana nikad se više
 * nije ponudila. Kriterij je sada stanje, ne vrijeme — "WAV bez .canary.srt" —
 * pa svaki idući run ponovno pokuša ono što prethodni nije uspio. Trošak je
 * ograničen capom (--max), a ne prozorom; poredak je najnovije-prvo, pa svjež
 * priljev uvijek ima prednost pred backlogom.
 *
 * OGRADA OD VJEČNOG PONAVLJANJA
 * -----------------------------
 * Bez prozora bi WAV na kojem Modal uvijek puca (predugačka snimka, korumpiran
 * audio) trošio jedno mjesto u capu svake noći. `storage/.modal_attempts.json`
 * broji pokušaje po videu; nakon --max-attempts (3) kandidat ispada i prijavi
 * se kao iscrpljen. Brisanje tog zapisa (ili --reset-attempts) vraća ga u igru.
 *
 * Usage:
 *   node tools/scan_modal_candidates.js --output-dir storage/output --scope channels
 *   node tools/scan_modal_candidates.js --scope unlisted --only-id VIDEOID
 *   node tools/scan_modal_candidates.js --record <wav-putanja>   # zabilježi pokušaj
 *   node tools/scan_modal_candidates.js --reset-attempts VIDEOID
 *
 * stdout = putanje kandidata (jedna po retku, spremne za `while read`).
 * stderr = dijagnostika (koliko skenirano, koliko odbačeno i zašto).
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function getArg(name, dflt = null) {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : dflt;
}
function hasFlag(name) { return args.includes(name); }

const REPO = path.join(__dirname, "..");
const OUTPUT_DIR = path.resolve(getArg("--output-dir", path.join(REPO, "storage", "output")));
const SCOPE = getArg("--scope", "unlisted");
const ONLY_ID = getArg("--only-id");
const MAX = parseInt(getArg("--max", "20"), 10);
const MAX_ATTEMPTS = parseInt(getArg("--max-attempts", process.env.MODAL_MAX_ATTEMPTS || "3"), 10);
const ATTEMPTS_PATH = path.join(REPO, "storage", ".modal_attempts.json");

function loadAttempts() {
    try { return JSON.parse(fs.readFileSync(ATTEMPTS_PATH, "utf-8")); } catch { return {}; }
}
function saveAttempts(a) {
    try {
        fs.mkdirSync(path.dirname(ATTEMPTS_PATH), { recursive: true });
        fs.writeFileSync(ATTEMPTS_PATH, JSON.stringify(a, null, 2));
    } catch (e) {
        process.stderr.write(`   ⚠️  Ne mogu spremiti ${ATTEMPTS_PATH}: ${e.message}\n`);
    }
}

// Zadnji `_yt_<id>`: naslov epizode sam može sadržavati "_yt_" (MEMORY:
// extract_video_id_last_match). Sintetički beamly nazivi imaju kraći ID, pa
// fallback na ime datoteke bez ekstenzije.
function videoKey(wavPath) {
    const base = path.basename(wavPath, ".wav");
    const m = [...base.matchAll(/_yt_([A-Za-z0-9_-]{6,})/g)];
    return m.length ? m[m.length - 1][1] : base;
}

// ── --record: zabilježi pokušaj (zove ga run_pipeline.sh PRIJE Modal poziva,
//    pa se i run koji padne/prekine se broji — inače bi crash resetirao brojač).
if (hasFlag("--record")) {
    const attempts = loadAttempts();
    const now = new Date().toISOString();
    for (const w of args.filter(a => a.endsWith(".wav"))) {
        const k = videoKey(w);
        const prev = attempts[k] || { count: 0 };
        attempts[k] = { count: prev.count + 1, last: now, wav: path.basename(w) };
    }
    saveAttempts(attempts);
    process.exit(0);
}

// ── --reset-attempts: vrati video u igru nakon ručne sanacije ──────────────
if (hasFlag("--reset-attempts")) {
    const attempts = loadAttempts();
    let n = 0;
    for (const id of args.slice(args.indexOf("--reset-attempts") + 1)) {
        if (id.startsWith("--")) break;
        if (attempts[id]) { delete attempts[id]; n++; }
    }
    saveAttempts(attempts);
    process.stderr.write(`   ♻️  Resetirano ${n} zapisa pokušaja.\n`);
    process.exit(0);
}

// ── SKEN ───────────────────────────────────────────────────────────────────

if (!fs.existsSync(OUTPUT_DIR)) {
    process.stderr.write(`   ❌ Output direktorij ne postoji: ${OUTPUT_DIR} (disk nije mountan?)\n`);
    process.exit(1);
}

let dirs;
if (SCOPE === "unlisted") {
    dirs = ["_unlisted"];
} else {
    // statSync (ne withFileTypes) jer su kanali symlinkovi — vidi CLAUDE.md.
    dirs = fs.readdirSync(OUTPUT_DIR).filter(d => {
        if (d.startsWith(".")) return false;
        if (SCOPE === "channels" && d === "_unlisted") return false;
        try { return fs.statSync(path.join(OUTPUT_DIR, d)).isDirectory(); } catch { return false; }
    });
}

const attempts = loadAttempts();
const stats = { dirs: 0, wavs: 0, haveSrt: 0, otherId: 0, exhausted: 0, unreadable: 0 };
const candidates = [];

for (const d of dirs) {
    const dirPath = path.join(OUTPUT_DIR, d);
    let files;
    try { files = fs.readdirSync(dirPath); } catch (e) {
        stats.unreadable++;
        process.stderr.write(`   ⚠️  ${d}: ${e.message}\n`);
        continue;
    }
    stats.dirs++;

    const present = new Set(files);
    for (const f of files) {
        if (!f.endsWith(".wav") || f.startsWith("._") || f.includes(".loudnorm.")) continue;
        stats.wavs++;

        // Idempotencija: transkript pokraj WAV-a znači "gotovo". Isto pravilo
        // koje je koristio stari find (`-f "${w}.canary.srt"`).
        if (present.has(`${f}.canary.srt`)) { stats.haveSrt++; continue; }

        const key = videoKey(f);
        if (ONLY_ID && key !== ONLY_ID && !f.includes(`_yt_${ONLY_ID}`)) { stats.otherId++; continue; }

        const rec = attempts[key];
        if (rec && rec.count >= MAX_ATTEMPTS) { stats.exhausted++; continue; }

        let mtime = 0;
        try { mtime = fs.statSync(path.join(dirPath, f)).mtimeMs; } catch { /* nedostupan → na kraj reda */ }
        candidates.push({ p: path.join(dirPath, f), mtime, tries: rec ? rec.count : 0 });
    }
}

// Najnovije prvo: svjež priljev ima prednost pred backlogom kad cap reže.
// Sekundarno po broju pokušaja (netaknuti prije već pokušanih), da jedan
// tvrdoglav fajl ne blokira mjesto epizodi koja bi prošla iz prve.
candidates.sort((a, b) => (a.tries - b.tries) || (b.mtime - a.mtime));

const selected = candidates.slice(0, MAX);
for (const c of selected) process.stdout.write(c.p + "\n");

const overflow = candidates.length - selected.length;
process.stderr.write(
    `   🔍 Modal scan: dirova=${stats.dirs}/${dirs.length} | wav=${stats.wavs} ` +
    `| vec .canary.srt=${stats.haveSrt} | van --only-id=${stats.otherId} ` +
    `| iscrpljeno (>=${MAX_ATTEMPTS} pokusaja)=${stats.exhausted} ` +
    `| kandidata=${candidates.length} → uzimam ${selected.length} (cap ${MAX})` +
    (overflow > 0 ? `, ${overflow} ostaje za sljedeci run/Colab` : "") + "\n"
);
if (stats.unreadable) {
    process.stderr.write(`   ⚠️  ${stats.unreadable} direktorija nečitljivo — provjeri mount i TCC dozvole.\n`);
}
