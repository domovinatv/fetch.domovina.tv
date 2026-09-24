#!/usr/bin/env node
/**
 * watch_candidates.js — lagano praćenje KANDIDATA iz registryja (bez obrade).
 *
 * Svaku noć za nepraćene podcaste iz data/podcasts_registry.json povuče samo
 * POPIS zadnjih videa (yt-dlp --flat-playlist, nula medija) i zapiše koje su
 * epizode nove. Ništa se ne skida, ne transkribira ni ne šalje na CDN — cilj je
 * vidjeti KOJI kandidati stvarno izbacuju nove epizode, prije nego što se
 * ijedan promovira u pravi pipeline (automatic/refresh_podcasts.sh).
 *
 * ⚠️ Namjerno piše IZVAN automatic/podcasts/: fetch.js čita SVE *-lista.txt u
 * tom direktoriju i skinuo bi sve što ovdje otkrijemo.
 *
 * Izolacija derivata (shorts, isječci, Q&A izrezi, highlightsi): vidi classify().
 * Pravilo po kanalu dolazi (redom prvenstva) iz:
 *   1. registry `watch` polja unosa  { source_url, min_duration_sec,
 *      exclude_title_regex, include_title_regex }
 *   2. automatic/watchlist/rules.json  (isti oblik, po slugu — izlaz LLM klasifikacije)
 *   3. adaptivnog praga iz povijesti trajanja tog kanala (vidi adaptiveMinDuration)
 *
 * Izlaz (automatic/watchlist/):
 *   watch-state.json     — viđeni ID-jevi po kanalu (gitignored, *-state.json)
 *   events.jsonl         — append-only: jedna linija po NOVOJ epizodi (original ili derivat)
 *   lists/<slug>-lista.txt — samo originali, format DATE|TITLE|URL (isti kao
 *                          automatic/podcasts/) → promocija = premjesti datoteku
 *   REPORT.md            — tko je aktivan, kadenca, udio derivata
 *
 * Upotreba:
 *   node automatic/watch_candidates.js                 # svi kandidati
 *   node automatic/watch_candidates.js --slug atma-podcast --verbose
 *   node automatic/watch_candidates.js --limit 10 --dry-run
 *   node automatic/watch_candidates.js --report-only   # samo regeneriraj REPORT.md
 *   Opcije: --concurrency 4, --items 30, --baseline-items 60, --proxy URL
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REPO = path.join(__dirname, "..");
const REGISTRY = path.join(REPO, "data", "podcasts_registry.json");
const OUT_DIR = path.join(__dirname, "watchlist");
const STATE_FILE = path.join(OUT_DIR, "watch-state.json");
const EVENTS_FILE = path.join(OUT_DIR, "events.jsonl");
const RULES_FILE = path.join(OUT_DIR, "rules.json");
const LISTS_DIR = path.join(OUT_DIR, "lists");
const REPORT_FILE = path.join(OUT_DIR, "REPORT.md");

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const hasFlag = (n) => args.includes(n);

const DRY_RUN = hasFlag("--dry-run");
const VERBOSE = hasFlag("--verbose");
const REPORT_ONLY = hasFlag("--report-only");
const ONLY_SLUG = getArg("--slug");
const LIMIT = parseInt(getArg("--limit") || "0", 10);
const CONCURRENCY = parseInt(getArg("--concurrency") || "4", 10);
const ITEMS = parseInt(getArg("--items") || "30", 10);
const BASELINE_ITEMS = parseInt(getArg("--baseline-items") || "60", 10);
const PROXY = getArg("--proxy");
const TIMEOUT_MS = 120 * 1000;
const YTDLP = process.env.YTDLP_BIN || "yt-dlp";

// Pratimo i uspavane/neaktivne: jeftino je (jedan flat poziv), a tako vidimo kad se
// podcast vrati. Van su samo zaključeni arhivski unosi i oni presuđeni kao ne-podcast.
const SKIP_STATUSES = new Set(["archive", "completed", "not-podcast", "dead-url"]);
const SHORT_MAX_SEC = 180;      // YouTube Shorts su ≤3 min
const FLOOR_MIN_SEC = 901;      // isti prag kao refresh_podcasts.sh (15:01)
const ADAPTIVE_FACTOR = 0.35;   // original ≥ 35 % tipične duge epizode kanala
const ADAPTIVE_MIN_SAMPLES = 8;
// Naslovi koji gotovo uvijek znače derivat. Trajanje i dalje ima prednost: pravilo
// se primjenjuje samo kad je video i KRAĆI od tipične epizode (vidi classify).
const DERIVATIVE_TITLE_RE = /#shorts?\b|\bisječ(ak|ci)\b|\bisjecak\b|\bhighlights?\b|\bnajbolji trenuci\b|\btrailer\b|\bnajava\b|\bteaser\b|\bpromo\b|\bclip\b/i;

// ─── registry → popis kandidata ─────────────────────────────────────

function channelVideosUrl(url) {
    if (!url) return null;
    if (/[?&]list=/.test(url)) return url;                       // playlista
    const u = url.replace(/\/+$/, "");
    if (/\/(videos|streams|shorts|featured|playlists)$/.test(u)) return u.replace(/\/(shorts|featured|playlists)$/, "/videos");
    return u + "/videos";
}

function loadRules() {
    try { return JSON.parse(fs.readFileSync(RULES_FILE, "utf8")); } catch { return {}; }
}

function loadCandidates() {
    const reg = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
    const rules = loadRules();
    const trackedUrls = new Set(
        reg.podcasts.filter((p) => p.tracking?.enabled === true && p.youtube?.url)
            .map((p) => channelVideosUrl(p.youtube.url))
    );
    const list = [];
    for (const p of reg.podcasts) {
        if (ONLY_SLUG && p.slug !== ONLY_SLUG) continue;
        if (!ONLY_SLUG) {
            if (p.tracking?.enabled === true) continue;
            if (!p.youtube?.url) continue;
            if (p.youtube?.type === "umbrella") continue;        // prate se djeca-playliste
            if (SKIP_STATUSES.has(p.metadata?.status)) continue;
        }
        const rule = { ...(rules[p.slug] || {}), ...(p.watch || {}) };
        const source = rule.source_url || channelVideosUrl(p.youtube?.url);
        if (!source) continue;
        if (!ONLY_SLUG && trackedUrls.has(source)) continue;    // već ga vuče pravi pipeline
        // Neki podcasti izlaze kao livestream/premijera → /streams uz /videos.
        const sources = [source, ...(rule.extra_source_urls || [])];
        list.push({ slug: p.slug, name: p.display_name, source, sources, rule, tags: p.tags || [] });
    }
    return LIMIT > 0 ? list.slice(0, LIMIT) : list;
}

// ─── yt-dlp ─────────────────────────────────────────────────────────

function listVideos(url, items) {
    return new Promise((resolve) => {
        const a = [
            "--flat-playlist", "-j", "--no-warnings", "--ignore-errors",
            "--playlist-items", `1:${items}`,
            "--extractor-args", "youtubetab:approximate_date",
        ];
        if (PROXY) a.push("--proxy", PROXY);
        a.push(url);
        const child = spawn(YTDLP, a, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => {
            clearTimeout(timer);
            const entries = [];
            for (const line of out.split("\n")) {
                if (!line.trim()) continue;
                try {
                    const j = JSON.parse(line);
                    if (!j.id || j.id.length !== 11) continue;
                    entries.push({
                        id: j.id,
                        title: j.title || "",
                        duration: typeof j.duration === "number" ? Math.round(j.duration) : null,
                        upload_date: j.upload_date || null,
                        live_status: j.live_status || null,
                    });
                } catch { /* ne-JSON redak */ }
            }
            resolve({ entries, error: entries.length ? null : (err.trim().split("\n").pop() || `exit ${code}`) });
        });
    });
}

// ─── klasifikacija original vs derivat ─────────────────────────────

function percentile(sorted, q) {
    if (!sorted.length) return null;
    const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[i];
}

/**
 * Prag „pune epizode" iz povijesti kanala: 35 % od p80 trajanja videa ≥ 15 min.
 * Na kanalu gdje su epizode 2 h a isječci 20–40 min (Podcast Inkubator) to daje
 * ~42 min — isto što je ručno bilo postavljeno (MIN_DURATION=2881). Na kanalu s
 * epizodama 45–60 min prag ostaje na podu od 15 min.
 */
function adaptiveMinDuration(seen) {
    const d = Object.values(seen).map((v) => v.duration).filter((x) => x && x >= FLOOR_MIN_SEC).sort((a, b) => a - b);
    if (d.length < ADAPTIVE_MIN_SAMPLES) return FLOOR_MIN_SEC;
    return Math.max(FLOOR_MIN_SEC, Math.round(ADAPTIVE_FACTOR * percentile(d, 0.8)));
}

function safeRegex(src) {
    if (!src) return null;
    try {
        // Dopusti Python-stil "(?i)..." iz LLM pravila.
        const ci = src.startsWith("(?i)");
        return new RegExp(ci ? src.slice(4) : src, ci ? "i" : "");
    } catch { return null; }
}

/** Vraća { cls, reason }; cls ∈ original | short | derivative | pending */
function classify(v, rule, minDur) {
    if (v.live_status === "is_upcoming" || v.live_status === "is_live") return { cls: "pending", reason: v.live_status };
    if (v.duration == null) return { cls: "pending", reason: "nema trajanja" };
    if (v.duration <= SHORT_MAX_SEC || /#shorts?\b/i.test(v.title)) return { cls: "short", reason: `${v.duration}s` };
    const ex = safeRegex(rule.exclude_title_regex);
    if (ex && ex.test(v.title)) return { cls: "derivative", reason: "exclude_title_regex" };
    const inc = safeRegex(rule.include_title_regex);
    if (inc && !inc.test(v.title)) return { cls: "derivative", reason: "ne pogađa include_title_regex" };
    if (v.duration < minDur) return { cls: "derivative", reason: `${Math.round(v.duration / 60)} min < prag ${Math.round(minDur / 60)} min` };
    if (DERIVATIVE_TITLE_RE.test(v.title) && v.duration < 2 * minDur) return { cls: "derivative", reason: "naslov (isječak/najava/…)" };
    return { cls: "original", reason: null };
}

// ─── stanje ────────────────────────────────────────────────────────

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { channels: {} }; }
}
function saveState(st) {
    fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(st, null, 1));
    fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
}

const today = () => new Date().toISOString().slice(0, 10);

async function processChannel(c, state) {
    let ch = state.channels[c.slug];
    const sourceKey = c.sources.join(" ");
    // Promijenjen izvor (npr. kanal → podcast playlista) = drugi skup videa → novi baseline,
    // inače bi cijela nova playlista izgledala kao „nove epizode".
    if (!ch || (ch.source && ch.source !== sourceKey)) ch = state.channels[c.slug] = { seen: {}, baseline_at: null };
    const isBaseline = !ch.baseline_at;
    const n = isBaseline ? BASELINE_ITEMS : ITEMS;
    let entries = [], error = null;
    for (const src of c.sources) {
        const r = await listVideos(src, n);
        if (r.error && src === c.source) error = r.error;       // greška sporednog izvora nije fatalna
        for (const e of r.entries) if (!entries.some((x) => x.id === e.id)) entries.push(e);
    }
    if (entries.length) error = null;
    ch.last_check = new Date().toISOString();
    ch.source = sourceKey;
    if (error) {
        ch.errors = (ch.errors || 0) + 1;
        ch.last_error = error.slice(0, 200);
        return { slug: c.slug, error, fresh: [] };
    }
    ch.errors = 0; delete ch.last_error;

    // Prag računamo i nad novim trajanjima, da baseline odmah dobije pravi prag.
    const pool = { ...ch.seen };
    for (const e of entries) if (!pool[e.id]) pool[e.id] = { duration: e.duration };
    const minDur = c.rule.min_duration_sec || adaptiveMinDuration(pool);
    ch.min_duration_sec = minDur;
    ch.rule_source = c.rule.min_duration_sec ? "pravilo" : "adaptivno";

    const fresh = [], classified = [];
    for (const e of entries) {
        if (ch.seen[e.id]) continue;
        const { cls, reason } = classify(e, c.rule, minDur);
        classified.push({ ...e, cls, reason });
        if (cls === "pending") continue;                          // provjeri opet sutra
        ch.seen[e.id] = {
            first_seen: today(), upload_date: e.upload_date, duration: e.duration,
            title: e.title.slice(0, 140), cls, ...(reason ? { reason } : {}),
            ...(isBaseline ? { baseline: true } : {}),
        };
        if (!isBaseline) fresh.push({ ...e, cls, reason });
    }
    if (isBaseline) ch.baseline_at = new Date().toISOString();
    // Pravilo se mijenja (revizija, LLM klasifikacija) → primijeni ga i na već viđene,
    // da izvještaj uvijek odražava TRENUTNO pravilo, a ne ono iz dana otkrića.
    for (const v of Object.values(ch.seen)) {
        const r = classify({ duration: v.duration, title: v.title, live_status: null }, c.rule, minDur);
        if (r.cls === "pending") continue;
        v.cls = r.cls;
        if (r.reason) v.reason = r.reason; else delete v.reason;
    }
    return { slug: c.slug, error: null, fresh, classified, baseline: isBaseline, count: entries.length, minDur };
}

// ─── izlazi ────────────────────────────────────────────────────────

function appendEvents(c, fresh) {
    if (!fresh.length || DRY_RUN) return;
    const lines = fresh.map((e) => JSON.stringify({
        date: today(), slug: c.slug, id: e.id, cls: e.cls, reason: e.reason || undefined,
        duration: e.duration, upload_date: e.upload_date, title: e.title,
    }));
    fs.appendFileSync(EVENTS_FILE, lines.join("\n") + "\n");
}

/** lists/<slug>-lista.txt = svi originali, najnoviji prvi (format automatic/podcasts/). */
function writeList(slug, ch) {
    const rows = Object.entries(ch.seen).filter(([, v]) => v.cls === "original")
        .sort((a, b) => (b[1].upload_date || "").localeCompare(a[1].upload_date || ""))
        .map(([id, v]) => `${v.upload_date || "NA"}|${v.title.replace(/\|/g, "/")}|https://youtu.be/${id}`);
    if (!rows.length || DRY_RUN) return;
    fs.writeFileSync(path.join(LISTS_DIR, `${slug}-lista.txt`), rows.join("\n") + "\n");
}

function daysSince(yyyymmdd) {
    if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return null;
    const t = Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8));
    return Math.floor((Date.now() - t) / 86400000);
}

function writeReport(state, candidates) {
    const names = Object.fromEntries(candidates.map((c) => [c.slug, c.name]));
    const rows = [];
    for (const [slug, ch] of Object.entries(state.channels)) {
        if (!names[slug]) continue;                               // više nije kandidat (promoviran / nije podcast)
        const vids = Object.values(ch.seen);
        const orig = vids.filter((v) => v.cls === "original");
        const deriv = vids.filter((v) => v.cls !== "original");
        const lastOrig = orig.map((v) => v.upload_date).filter(Boolean).sort().pop() || null;
        const age = daysSince(lastOrig);
        const in90 = orig.filter((v) => { const d = daysSince(v.upload_date); return d != null && d <= 90; }).length;
        const newOrig = orig.filter((v) => !v.baseline).length;
        const status = ch.last_error && !vids.length ? "⚠️ greška"
            : !orig.length && vids.length >= 20 ? "⛔ bez originala"
            : age == null ? "⚪ nepoznato"
            : age <= 30 ? "🟢 aktivan" : age <= 120 ? "🟡 usporava" : "🔴 uspavan";
        rows.push({ slug, name: names[slug] || slug, status, age, lastOrig, in90, newOrig,
            derivPct: vids.length ? Math.round((100 * deriv.length) / vids.length) : 0,
            minDur: ch.min_duration_sec, ruleSrc: ch.rule_source, err: ch.last_error });
    }
    const order = { "🟢": 0, "🟡": 1, "🔴": 2, "⚪": 3, "⛔": 4, "⚠️": 5 };
    rows.sort((a, b) => (order[[...a.status][0]] - order[[...b.status][0]]) || (b.newOrig - a.newOrig) || (b.in90 - a.in90));

    const count = (p) => rows.filter((r) => r.status.startsWith(p)).length;
    const recent = [];
    try {
        const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
        for (const line of fs.readFileSync(EVENTS_FILE, "utf8").split("\n")) {
            if (!line) continue;
            const e = JSON.parse(line);
            if (e.cls === "original" && e.date >= cutoff) recent.push(e);
        }
    } catch { /* još nema događaja */ }
    recent.sort((a, b) => b.date.localeCompare(a.date));

    const md = [
        "# Praćenje kandidata (watch-only)",
        "",
        `Generirano ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC skriptom \`automatic/watch_candidates.js\`.`,
        "Samo popis videa — ništa se ne skida ni ne obrađuje. „Novi originali\" = epizode otkrivene NAKON baselinea.",
        "",
        `**${rows.length} kanala** · 🟢 ${count("🟢")} aktivno (original ≤30 d) · 🟡 ${count("🟡")} usporava (≤120 d) · 🔴 ${count("🔴")} uspavano · ⚪ ${count("⚪")} nepoznato · ⛔ ${count("⛔")} bez ijednog originala (vjerojatno nije podcast ili treba pravilo) · ⚠️ ${count("⚠️")} greška`,
        "",
        "## Novi originali, zadnjih 14 dana",
        "",
        recent.length ? "| otkriveno | kanal | min | naslov |\n|---|---|---|---|\n" +
            recent.slice(0, 80).map((e) => `| ${e.date} | ${e.slug} | ${e.duration ? Math.round(e.duration / 60) : "?"} | [${e.title.replace(/\|/g, "/").slice(0, 80)}](https://youtu.be/${e.id}) |`).join("\n")
            : "_Još ništa — prvi prolaz je baseline; nove epizode pojavljuju se od sljedećeg runa._",
        "",
        "## Kanali",
        "",
        "| status | kanal | zadnji original | originala 90 d | novih od baselinea | derivata % | prag min |",
        "|---|---|---|---|---|---|---|",
        ...rows.map((r) => `| ${r.status} | ${r.name} \`${r.slug}\` | ${r.lastOrig ? `${r.lastOrig} (${r.age} d)` : "—"} | ${r.in90} | ${r.newOrig} | ${r.derivPct} | ${r.minDur ? Math.round(r.minDur / 60) : "—"}${r.ruleSrc === "pravilo" ? " ✎" : ""} |`),
        "",
        "✎ = prag iz ručnog/LLM pravila (registry `watch` ili `rules.json`), inače adaptivno iz trajanja kanala.",
        "Datumi uploada iz flat liste su približni (YouTube „prije 3 tjedna\"); datum otkrića u events.jsonl je točan.",
        "",
    ].join("\n");
    if (!DRY_RUN) fs.writeFileSync(REPORT_FILE, md);
    return rows;
}

// ─── main ──────────────────────────────────────────────────────────

async function main() {
    fs.mkdirSync(LISTS_DIR, { recursive: true });
    const candidates = loadCandidates();
    const state = loadState();

    if (REPORT_ONLY) {
        writeReport(state, candidates);
        console.log(`📝 ${REPORT_FILE}`);
        return;
    }

    console.log(`👀 Watch-only kandidati: ${candidates.length} kanala (concurrency ${CONCURRENCY}${DRY_RUN ? ", DRY RUN" : ""})`);
    const t0 = Date.now();
    let idx = 0, done = 0, errors = 0, baselines = 0, newOrig = 0, newDeriv = 0;

    async function worker() {
        while (idx < candidates.length) {
            const c = candidates[idx++];
            const r = await processChannel(c, state);
            done++;
            if (r.error) {
                errors++;
                console.log(`  ⚠️  [${c.slug}] ${r.error.slice(0, 120)}`);
            } else {
                if (r.baseline) baselines++;
                const o = r.fresh.filter((e) => e.cls === "original");
                newOrig += o.length; newDeriv += r.fresh.length - o.length;
                appendEvents(c, r.fresh);
                writeList(c.slug, state.channels[c.slug]);
                if (o.length) for (const e of o) console.log(`  🆕 [${c.slug}] ${e.title.slice(0, 90)} (${Math.round(e.duration / 60)} min)`);
                if (VERBOSE) {
                    console.log(`  [${c.slug}] ${r.count} videa, prag ${Math.round(r.minDur / 60)} min${r.baseline ? ", BASELINE" : ""}`);
                    for (const e of r.classified) console.log(`     ${e.cls.padEnd(10)} ${String(e.duration == null ? "?" : Math.round(e.duration / 60)).padStart(4)} min  ${e.title.slice(0, 80)}${e.reason ? `  (${e.reason})` : ""}`);
                }
            }
            if (done % 25 === 0) {
                console.log(`  … ${done}/${candidates.length}`);
                if (!DRY_RUN) saveState(state);                   // prekid ne gubi cijeli prolaz
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));
    if (!DRY_RUN) saveState(state);
    const rows = writeReport(state, candidates);

    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`✅ Gotovo za ${secs}s: ${done} kanala, ${baselines} baseline, ${newOrig} novih originala, ${newDeriv} novih derivata/shortsa, ${errors} grešaka`);
    console.log(`   🟢 ${rows.filter((r) => r.status.startsWith("🟢")).length} aktivno · izvještaj: automatic/watchlist/REPORT.md`);
    // Nikad nenula zbog pojedinih kanala — ovo je opažanje, ne korak o kojem išta ovisi.
    if (errors === done && done > 0) process.exit(1);
}

if (require.main === module) {
    main().catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { classify, adaptiveMinDuration, channelVideosUrl, safeRegex };
