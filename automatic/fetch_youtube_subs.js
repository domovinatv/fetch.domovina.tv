#!/usr/bin/env node
/**
 * fetch_youtube_subs.js — RUČNI YouTube titlovi (HR/EN) svih originala iz backfill.json
 * → cdn.domovina.ai/registry/subs/<id>.<lang>.srt, za download na podcast.domovina.ai.
 *
 * Ručni titl (autor ga je uploadao uz video) je pregledan tekst, kakav ASR ne daje, i
 * znak da kanal ima vlastiti alat za prijepis. Automatski titlovi se NAMJERNO ignoriraju.
 *
 * Dva koraka:
 *   1. Detekcija — YouTube Data API `videos.list part=contentDetails`, 50 ID-ova = 1 jedinica.
 *      `contentDetails.caption === "true"` SAMO za ručne titlove (provjereno 28.10.2026.:
 *      19/20 videa s ručnim titlom → true, 30/30 bez ručnog ili samo s automatskim → false).
 *      Original se provjeri jednom; zadnjih RECHECK_DAYS dana svaki dan iznova, jer autori
 *      titl često dodaju dan-dva nakon objave.
 *   2. Download — yt-dlp `--write-subs` (bez `--write-auto-subs`) samo za `caption: true`,
 *      više videa po pozivu. `requested_subtitles` = NA znači da ručni titl postoji, ali ne
 *      na hrvatskom ni engleskom (npr. samo srpski) — to je konačan ishod, ne greška.
 *
 * Datoteke:
 *   automatic/watchlist/subs.json        — javni indeks (commitan): id → { slug, date, langs }
 *                                          čita ga podcast.domovina.ai/scripts/build-catalog.mjs
 *   automatic/watchlist/subs-state.json  — stanje provjera (gitignored, *-state.json)
 *   automatic/watchlist/subs/<id>.<lang>.srt — lokalna kopija (gitignored)
 *
 * Kvota: prvi prolaz ≈ broj originala / 50 (~900 jedinica za 44 000), nightly ≈ 20.
 * Download: 5 videa po yt-dlp pozivu, nasumična pauza 8–20 s između poziva + yt-dlp
 * `--sleep-requests 1.5 --sleep-subtitles 3` unutar poziva (čeka prije SVAKOG HTTP zahtjeva,
 * a jedan video ih ima više) → izmjereno ~16 s po videu (28.10.2026.), 100/noć ≈ 27 min.
 *
 * Upotreba:
 *   node automatic/fetch_youtube_subs.js                     # nightly: provjeri sve, skini samo nove (od --since 2026-10-28)
 *   node automatic/fetch_youtube_subs.js --backfill          # + stari katalog (ručno, 100 po pozivu)
 *   node automatic/fetch_youtube_subs.js --dry-run           # samo detekcija i popis, bez yt-dlp i R2
 *   node automatic/fetch_youtube_subs.js --video-id QkcpHsj43rE
 *   Opcije: --slug S, --max-units 2000, --max-downloads 100, --sleep-min 8 --sleep-max 20,
 *           --no-upload, --proxy URL, --via-iphone
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const REPO = path.join(__dirname, "..");
const WATCH_DIR = path.join(__dirname, "watchlist");
const BACKFILL_FILE = path.join(WATCH_DIR, "backfill.json");
const INDEX_FILE = path.join(WATCH_DIR, "subs.json");
const STATE_FILE = path.join(WATCH_DIR, "subs-state.json");
const LOCAL_DIR = path.join(WATCH_DIR, "subs");
const COOKIES_FILE = path.join(__dirname, "cookies.txt");

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const hasFlag = (n) => args.includes(n);

const DRY_RUN = hasFlag("--dry-run");
const NO_UPLOAD = hasFlag("--no-upload");
const ONLY_SLUG = getArg("--slug");
const ONLY_ID = getArg("--video-id");
const MAX_UNITS = parseInt(getArg("--max-units") || "2000", 10);
const MAX_DOWNLOADS = parseInt(getArg("--max-downloads") || "100", 10);
// Default skida SAMO nove epizode (odluka 28.10.2026.): stari katalog (~1400 videa s ručnim
// titlom) ide jedino uz --backfill, ručno. Detekcija ide svejedno nad svima.
const FORWARD_FROM = getArg("--since") || "2026-10-28";
const BACKFILL = hasFlag("--backfill");
const PROXY = getArg("--proxy");
const RECHECK_DAYS = 30;          // autori titl znaju dodati nakon objave
const MAX_TRIES = 3;              // yt-dlp greška (anti-bot, nedostupan video) → pokušaj idućih noći
const BATCH = 5;                  // videa po yt-dlp pozivu
// Pauze protiv anti-bota / blokade IP-a: nasumično između poziva (ravnomjeran ritam je
// lakše prepoznati), a unutar poziva yt-dlp sam čeka između HTTP zahtjeva i titlova.
const SLEEP_MIN_S = parseFloat(getArg("--sleep-min") || "8");
const SLEEP_MAX_S = parseFloat(getArg("--sleep-max") || "20");
const YTDLP_SLEEP_REQUESTS_S = "1.5";
const YTDLP_SLEEP_SUBTITLES_S = "3";
const TIMEOUT_MS = 5 * 60 * 1000;
const STOP_AFTER_FAILED_BATCHES = 2;   // dva prazna batcha zaredom = vjerojatno anti-bot, ne tjeraj dalje
const LANGS = ["hr", "en"];
const YTDLP = process.env.YTDLP_BIN || "yt-dlp";

// .env ručno, bez dotenv dependencyja (isti obrazac kao backfill_days.js)
(function loadEnvFile() {
    const envPath = path.join(REPO, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const i = t.indexOf("=");
        if (i === -1) continue;
        const k = t.slice(0, i).trim();
        if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
})();
const API_KEY = process.env.YOUTUBE_API_KEY;
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "https://cdn.domovina.ai").replace(/\/$/, "");
const R2_PREFIX = "registry/subs";

// --via-iphone: isto kao watch_candidates.js / run_pipeline.sh
function sourceAddressArgs() {
    const explicit = getArg("--source-address");
    if (explicit) return ["--source-address", explicit];
    if (!hasFlag("--via-iphone")) return [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) if (a.family === "IPv4" && /^172\.20\.10\.(\d+)$/.test(a.address) && a.address !== "172.20.10.1") return ["--source-address", a.address];
    }
    throw new Error("--via-iphone: nema 172.20.10.x adrese — je li Personal Hotspot uključen i iPhone spojen?");
}
const SRC_ARGS = sourceAddressArgs();

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
function writeAtomic(file, txt) {
    fs.writeFileSync(file + ".tmp", txt);
    fs.renameSync(file + ".tmp", file);
}
const sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000));
const today = () => new Date().toISOString().slice(0, 10);
function addDays(day, n) { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// ─── YouTube Data API ──────────────────────────────────────────────

class QuotaStop extends Error {}
let units = 0;
async function captionFlags(ids) {
    if (units >= MAX_UNITS) throw new QuotaStop(`dosegnut --max-units ${MAX_UNITS}`);
    units++;
    const url = `https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: "contentDetails", id: ids.join(","), maxResults: "50", key: API_KEY })}`;
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(url);
        if (res.ok) {
            const out = {};
            for (const v of (await res.json()).items || []) out[v.id] = v.contentDetails?.caption === "true";
            return out;   // ID kojeg nema u odgovoru = privatan/obrisan
        }
        const body = await res.text();
        if (res.status === 403 && /quotaExceeded|dailyLimitExceeded/.test(body)) throw new QuotaStop("YouTube API kvota potrošena za danas");
        if ((res.status >= 500 || res.status === 429) && attempt < 4) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
        throw new Error(`videos.list HTTP ${res.status}: ${body.slice(0, 160).replace(/\s+/g, " ")}`);
    }
}

// ─── yt-dlp ────────────────────────────────────────────────────────

/** → Map id → { langs: {hr: file, en: file} } za videe koje je yt-dlp obradio; ID kojeg nema = greška. */
function downloadBatch(ids, outDir) {
    return new Promise((resolve) => {
        const a = [
            "--skip-download", "--no-simulate", "--ignore-errors", "--no-warnings", "--quiet",
            "--write-subs", "--sub-langs", LANGS.map((l) => `${l}.*`).join(","),
            "--sub-format", "srt/vtt/best", "--convert-subs", "srt",
            "--sleep-requests", YTDLP_SLEEP_REQUESTS_S, "--sleep-subtitles", YTDLP_SLEEP_SUBTITLES_S,
            "--print", "before_dl:SUBS %(id)s %(requested_subtitles)j",
            "-o", path.join(outDir, "%(id)s.%(ext)s"),
        ];
        if (fs.existsSync(COOKIES_FILE)) a.push("--cookies", COOKIES_FILE);
        if (PROXY) a.push("--proxy", PROXY);
        a.push(...SRC_ARGS, ...ids.map((id) => `https://www.youtube.com/watch?v=${id}`));
        const child = spawn(YTDLP, a, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", () => {
            clearTimeout(timer);
            const seen = new Map();
            for (const line of out.split("\n")) {
                const m = line.match(/^SUBS (\S{11}) (.*)$/);
                if (m) seen.set(m[1], { langs: {} });
            }
            // Datoteke tek nakon izlaza: --convert-subs piše .srt na kraju. en-US/en-GB → en;
            // goli kod ima prednost pred regionalnom varijantom.
            for (const f of fs.readdirSync(outDir)) {
                const m = f.match(/^(.{11})\.([a-z]{2})(-[\w-]+)?\.srt$/);
                if (!m || !seen.has(m[1]) || !LANGS.includes(m[2])) continue;
                const cur = seen.get(m[1]).langs;
                if (!cur[m[2]] || !m[3]) cur[m[2]] = path.join(outDir, f);
            }
            resolve({ seen, err: err.trim().split("\n").filter(Boolean).slice(-3).join(" | ") });
        });
    });
}

function validSrt(file) {
    try {
        const t = fs.readFileSync(file, "utf8");
        return t.length > 20 && t.includes("-->");
    } catch { return false; }
}

// ─── R2 ────────────────────────────────────────────────────────────

let s3;
async function r2() {
    if (s3) return s3;
    for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
        if (!process.env[k]) throw new Error(`Nedostaje ${k} u .env`);
    }
    const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
    s3 = {
        PutObjectCommand,
        client: new S3Client({
            region: "auto",
            endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
        }),
    };
    return s3;
}

/** Ime za download: naslov epizode, ne YouTube ID (Content-Disposition, jer `download` atribut cross-origin ne radi). */
function downloadName(title, id, lang) {
    const base = (title || id).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || id;
    const ascii = base.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
    return `attachment; filename="${ascii}.${lang}.srt"; filename*=UTF-8''${encodeURIComponent(`${base}.${lang}.srt`)}`;
}

async function upload(file, id, lang, title) {
    const { client, PutObjectCommand } = await r2();
    await client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME || "cdn-domovina-ai",
        Key: `${R2_PREFIX}/${id}.${lang}.srt`,
        Body: fs.readFileSync(file),
        ContentType: "application/x-subrip; charset=utf-8",
        ContentDisposition: downloadName(title, id, lang),
        // Ključ se ne prepisuje (titl se skida jednom), ali ne i immutable: ako jednom
        // zatreba ponovni dohvat, CDN se sam osvježi za dan.
        CacheControl: "public, max-age=86400",
    }));
}

// ─── indeks ────────────────────────────────────────────────────────

/** Jedan video po retku, da je nightly diff samo ono što je stvarno novo. */
function saveIndex(videos) {
    const ids = Object.keys(videos).sort((a, b) => (videos[b].date || "").localeCompare(videos[a].date || "") || a.localeCompare(b));
    const lines = ids.map((id, i) => `    ${JSON.stringify(id)}: ${JSON.stringify(videos[id])}${i < ids.length - 1 ? "," : ""}`);
    const head = { generated_at: new Date().toISOString(), cdn: `${R2_PUBLIC_URL}/${R2_PREFIX}/<id>.<lang>.srt`, count: ids.length };
    writeAtomic(INDEX_FILE, `{\n${Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n  "videos": {\n${lines.join("\n")}\n  }\n}\n`);
}

// ─── main ──────────────────────────────────────────────────────────

async function main() {
    if (!API_KEY) { console.error("❌ Nema YOUTUBE_API_KEY u .env"); process.exit(1); }
    const backfill = readJson(BACKFILL_FILE, null);
    if (!backfill?.channels) { console.error(`❌ Nema ${BACKFILL_FILE} — prvo node automatic/backfill_days.js`); process.exit(1); }
    const state = readJson(STATE_FILE, { videos: {} });
    const index = readJson(INDEX_FILE, { videos: {} }).videos || {};

    // Original iz više unosa (roditelj + podkanal) vodi se pod prvim slugom.
    const originals = new Map();
    for (const [slug, ch] of Object.entries(backfill.channels)) {
        if (ONLY_SLUG && slug !== ONLY_SLUG) continue;
        for (const [id, o] of Object.entries(ch.originals || {})) {
            if (ONLY_ID && id !== ONLY_ID) continue;
            if (!originals.has(id)) originals.set(id, { slug, date: o.date, title: o.title });
        }
    }
    const day = today();
    const recentFrom = addDays(day, -RECHECK_DAYS);

    // 1. Detekcija
    const toCheck = [...originals].filter(([id, o]) => {
        const s = state.videos[id];
        if (ONLY_ID || !s?.checked) return true;
        if (s.done) return false;
        return o.date >= recentFrom && s.checked < day;
    }).map(([id]) => id);
    console.log(`📝 Ručni titlovi: ${originals.size} originala, provjera ${toCheck.length} (≈${Math.ceil(toCheck.length / 50)} jedinica kvote)`);

    let flagged = 0;
    try {
        for (let i = 0; i < toCheck.length; i += 50) {
            const ids = toCheck.slice(i, i + 50);
            const flags = await captionFlags(ids);
            for (const id of ids) {
                const s = (state.videos[id] ||= {});
                s.checked = day;
                if (!(id in flags)) { s.gone = true; continue; }
                delete s.gone;
                if (flags[id] && !s.caption) { s.caption = true; flagged++; }
            }
            if ((i / 50) % 100 === 99) { writeAtomic(STATE_FILE, JSON.stringify(state)); process.stdout.write("."); }
        }
    } catch (e) {
        if (!(e instanceof QuotaStop)) throw e;
        console.log(`\n⏸️  ${e.message} — ostatak iduće noći`);
    }
    writeAtomic(STATE_FILE, JSON.stringify(state));
    console.log(`   novo s ručnim titlom: ${flagged} · jedinica potrošeno: ${units}`);

    // 2. Download
    const queue = [...originals.keys()].filter((id) => {
        const s = state.videos[id];
        if (!BACKFILL && !ONLY_ID && originals.get(id).date < FORWARD_FROM) return false;
        return s?.caption && !s.done && !s.gone && (s.tries || 0) < MAX_TRIES;
    });
    console.log(`   za download${BACKFILL ? " (backfill)" : ` (objavljeno od ${FORWARD_FROM}; stari samo uz --backfill)`}: ${queue.length}${queue.length > MAX_DOWNLOADS ? ` (ovaj run ${MAX_DOWNLOADS})` : ""}`);
    if (DRY_RUN) {
        for (const id of queue.slice(0, 20)) console.log(`     ${id}  ${originals.get(id).slug}  ${originals.get(id).date}  ${originals.get(id).title}`);
        return;
    }

    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    const work = queue.slice(0, MAX_DOWNLOADS);
    const got = { videos: 0, files: 0, none: 0, failed: 0 };
    let failedBatches = 0;
    for (let i = 0; i < work.length; i += BATCH) {
        const ids = work.slice(i, i + BATCH);
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ytsubs-"));
        const { seen, err } = await downloadBatch(ids, tmp);
        if (!seen.size) failedBatches++; else failedBatches = 0;
        for (const id of ids) {
            const s = state.videos[id];
            const o = originals.get(id);
            const r = seen.get(id);
            if (!r) { s.tries = (s.tries || 0) + 1; s.err = err.slice(0, 200); got.failed++; continue; }
            const langs = [];
            for (const [lang, file] of Object.entries(r.langs)) {
                if (!validSrt(file)) continue;
                const local = path.join(LOCAL_DIR, `${id}.${lang}.srt`);
                fs.copyFileSync(file, local);
                if (!NO_UPLOAD) await upload(local, id, lang, o.title);
                langs.push(lang);
            }
            s.done = day;
            delete s.err;
            if (langs.length) {
                s.langs = langs.sort();
                // Bez --no-upload je u indeksu samo ono što stvarno postoji na CDN-u — stranica linka samo to.
                if (!NO_UPLOAD) index[id] = { slug: o.slug, date: o.date, langs: s.langs };
                got.videos++; got.files += langs.length;
            } else {
                got.none++;   // ručni titl postoji, ali ne HR ni EN
            }
        }
        fs.rmSync(tmp, { recursive: true, force: true });
        writeAtomic(STATE_FILE, JSON.stringify(state));
        saveIndex(index);
        process.stdout.write(`   ${Math.min(i + BATCH, work.length)}/${work.length}\r`);
        if (failedBatches >= STOP_AFTER_FAILED_BATCHES) {
            console.log(`\n⚠️  ${failedBatches} batcha zaredom bez ijednog videa — stajem (anti-bot?). Zadnja greška: ${err}`);
            break;
        }
        if (i + BATCH < work.length) await sleep(SLEEP_MIN_S + Math.random() * (SLEEP_MAX_S - SLEEP_MIN_S));
    }
    saveIndex(index);
    console.log(`\n✅ ${got.videos} videa / ${got.files} SRT-ova${NO_UPLOAD ? " (lokalno, bez uploada)" : " na CDN"} · ${got.none} samo u drugim jezicima · ${got.failed} neuspjelo · indeks ${Object.keys(index).length}`);
}

main().catch((e) => { console.error(`❌ ${e.stack || e.message}`); process.exit(1); });
