#!/usr/bin/env node
/**
 * tools/reprocess_episode.js — pomoćnik za PONOVNU OBRADU već objavljene epizode
 * (pipeline.domovina.ai admin „🔁 Ponovna obrada", bridge priority_poller.js).
 *
 * Pipeline je idempotentan po postojanju izvedenih fajlova: što postoji, preskače se
 * (memory: derived_files_are_idempotency_signals). Za ponovnu obradu to je upravo
 * prepreka — KORAK 2.8 ne promovira Speechmatics prijepis jer `.wav.canary.diarized.srt`
 * već postoji, koraci 7+8 ne pišu članak jer stari postoji, itd. Zato se stari izvedeni
 * fajlovi PRIJE runa sklone u stranu. NIKAD se ne brišu (memory: wildcard_delete_caution)
 * — premještaju se u `.reprocess_bak/` na ISTOM volumenu (rename, ne copy):
 *
 *   <realpath(dir)>/../.reprocess_bak/<ime dira>/<videoId>_<YYYYMMDD-HHMMSS>/
 *
 * Namjerno IZVAN channel dira i izvan storage/output/ (koji sadrži samo symlinkove na
 * channel dirove), da ga nijedan skener kataloga ni rclone sync ne vidi.
 *
 * Izvorni mediji i fetch metapodaci (mp3/wav/video, info.json, description, loudnorm)
 * se NE diraju — ponovna obrada ih koristi, a fetch.js ih ne bi ponovno skinuo.
 *
 * Uz fajlove se čiste i DONE CACHEOVI u korijenu storage/output/ (`summarize-done.json`,
 * `articles-done.json`, `rag-*-done.json` = { completed: [basename…] }). Koraci 7, 8 i 9
 * gledaju njih PRIJE diska — bez ovoga je ponovna obrada 09.10. sklonila stari članak,
 * a 7+8 svejedno javili „Preskočeno (cache): 1" i ništa nisu napisali. Ključ je goli
 * basename (dijeljen između kanala), pa se briše svaki unos s `_yt_<ID>`; netaknuti
 * kanal ga sljedeći run sam vrati („FS check → dodano u cache").
 *
 * Usage:
 *   node tools/reprocess_episode.js stash  --dir <channel> --video-id <ID> --scope derived|article [--dry-run]
 *   node tools/reprocess_episode.js locate --video-id <ID>
 *
 *   --scope derived  sve izvedeno (prijepisi, diarizacija, sažetak, članak, RAG, slike,
 *                    epub, words, segments, sponsors, speechmatics…) — za puni re-run
 *   --scope article  samo ono što ovisi o članku (sažetak, outline/article/magisterium,
 *                    _raw, RAG, screenshotovi, og-sections, og-share, epub, usage) —
 *                    prijepis, words.json, segments i sponsors ostaju
 *
 *   locate  ispiše ime channel dira koji ima `.wav.canary.diarized.srt` za taj ID
 *           (praćeni kanal ima prednost pred `_unlisted`); exit 1 ako ga nema.
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const CMD = args[0];
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const INPUT_DIR = getArg("--input-dir") || path.join(__dirname, "..", "storage", "output");
const VIDEO_ID = getArg("--video-id");
const DRY_RUN = args.includes("--dry-run");

// Izvorni mediji + fetch metapodaci (i thumbnail varijante) — ne diraju se ni u jednom scopeu.
const SOURCE_SUFFIX = /^(\.(mp3|wav|mkv|mp4|webm|m4a|part|ytdl|description|png|webp|jpg)|\.thumb-\d+\.webp|\.info\.json|\.loudnorm\.json|\.f\d+\.(mp4|webm|m4a))$/;

// Ono što ovisi o ČLANKU (a ne o prijepisu). Suffix je dio imena iza `_yt_<ID>`.
function isArticleDerived(suffix) {
    return (
        suffix === "_screenshots" ||
        suffix === ".og-sections" ||
        suffix === ".og-share.jpg" ||
        suffix === ".epub" || suffix === ".en.epub" ||
        suffix === ".gemini_usage.json" ||
        /^\.rag(_[a-z]+)?\.jsonl$/.test(suffix) ||
        /\.summary(\.[a-z]+)?\.(json|md)$/.test(suffix) ||
        /\.summary\.blocked\.json$/.test(suffix) ||
        /\.diarized\.blocked\.json$/.test(suffix) ||
        /_\d{4}-\d{2}-\d{2}_.+\.(outline|article)(\.[a-z_.0-9]+)?\.json$/.test(suffix) ||
        /_\d{4}-\d{2}-\d{2}_.+_raw$/.test(suffix)
    );
}

// Video ID: LAST match _yt_ (naslovi znaju sadržavati "_yt_") — memory extract_video_id_last_match.
function suffixAfterId(name, videoId) {
    const marker = `_yt_${videoId}`;
    const idx = name.lastIndexOf(marker);
    if (idx === -1) return null;
    const rest = name.slice(idx + marker.length);
    // Granica ID-a: iza njega mora doći . ili _ ili kraj (inače je to drugi, duži ID).
    if (rest && rest[0] !== "." && rest[0] !== "_") return null;
    return rest;
}

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function stash(dirName, scope) {
    const dir = path.join(INPUT_DIR, dirName);
    let names;
    try {
        names = fs.readdirSync(dir).filter((n) => !n.startsWith("."));
    } catch (e) {
        console.error(`❌ Ne mogu čitati ${dir}: ${e.message}`);
        process.exit(1);
    }
    const victims = [];
    for (const name of names) {
        const suffix = suffixAfterId(name, VIDEO_ID);
        if (suffix === null) continue;
        if (SOURCE_SUFFIX.test(suffix)) continue;
        if (scope === "article" && !isArticleDerived(suffix)) continue;
        victims.push(name);
    }
    if (!victims.length) {
        console.log(`   📦 ${dirName}/${VIDEO_ID}: nema izvedenih fajlova za skloniti (scope=${scope}).`);
        return;
    }
    const realDir = fs.realpathSync(dir);
    const bakDir = path.join(path.dirname(realDir), ".reprocess_bak", path.basename(realDir), `${VIDEO_ID}_${stamp()}`);
    console.log(`   📦 ${dirName}/${VIDEO_ID}: sklanjam ${victims.length} izvedenih (scope=${scope}) → ${bakDir}${DRY_RUN ? "  (DRY RUN)" : ""}`);
    if (!DRY_RUN) fs.mkdirSync(bakDir, { recursive: true });
    for (const name of victims.sort()) {
        console.log(`      ↪ ${name}`);
        if (!DRY_RUN) fs.renameSync(path.join(realDir, name), path.join(bakDir, name));
    }
}

// Makni sve unose ovog videa iz done cacheova (atomski: tmp + rename).
function clearDoneCaches() {
    let names;
    try {
        names = fs.readdirSync(INPUT_DIR).filter((n) => n.endsWith("-done.json"));
    } catch {
        return;
    }
    for (const name of names) {
        const p = path.join(INPUT_DIR, name);
        let data;
        try {
            data = JSON.parse(fs.readFileSync(p, "utf-8"));
        } catch {
            continue;
        }
        if (!data || !Array.isArray(data.completed)) continue;
        const kept = data.completed.filter((k) => suffixAfterId(String(k), VIDEO_ID) === null);
        const removed = data.completed.length - kept.length;
        if (!removed) continue;
        console.log(`   🧹 ${name}: mičem ${removed} unos(a) za ${VIDEO_ID}${DRY_RUN ? "  (DRY RUN)" : ""}`);
        if (DRY_RUN) continue;
        const tmp = `${p}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify({ ...data, completed: kept }, null, 2));
        fs.renameSync(tmp, p);
    }
}

function locate() {
    let dirs;
    try {
        dirs = fs.readdirSync(INPUT_DIR, { withFileTypes: true })
            .filter((e) => e.isDirectory() || e.isSymbolicLink())
            .map((e) => e.name)
            .filter((n) => !n.startsWith("."));
    } catch (e) {
        console.error(`❌ Ne mogu čitati ${INPUT_DIR}: ${e.message}`);
        process.exit(1);
    }
    const hits = [];
    for (const d of dirs) {
        let names;
        try { names = fs.readdirSync(path.join(INPUT_DIR, d)); } catch { continue; }
        if (names.some((n) => suffixAfterId(n, VIDEO_ID) === ".wav.canary.diarized.srt")) hits.push(d);
    }
    // Praćeni kanal (bez `_` prefiksa) ima prednost: on je ono što nightly uploada.
    hits.sort((a, b) => (a.startsWith("_") ? 1 : 0) - (b.startsWith("_") ? 1 : 0) || a.localeCompare(b));
    if (!hits.length) {
        console.error(`❌ ${VIDEO_ID}: nijedan kanal nema .wav.canary.diarized.srt`);
        process.exit(1);
    }
    process.stdout.write(hits[0] + "\n");
}

if (!VIDEO_ID || !/^[A-Za-z0-9_-]{11}$/.test(VIDEO_ID)) {
    console.error("❌ Zadaj --video-id <11-znakovni ID>");
    process.exit(1);
}
if (CMD === "stash") {
    const dirName = getArg("--dir");
    const scope = getArg("--scope") || "derived";
    if (!dirName || !["derived", "article"].includes(scope)) {
        console.error("❌ stash traži --dir <channel> i --scope derived|article");
        process.exit(1);
    }
    stash(dirName, scope);
    clearDoneCaches();
} else if (CMD === "locate") {
    locate();
} else {
    console.error("❌ Naredba: stash | locate");
    process.exit(1);
}
