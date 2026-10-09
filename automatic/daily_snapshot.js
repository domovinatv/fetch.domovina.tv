#!/usr/bin/env node
/**
 * daily_snapshot.js — koliko novih epizoda HR podcasta stigne u 24 sata, i kojom dinamikom.
 *
 * Nula mrežnih poziva, nula LLM-a, deterministički: isti ulaz → isti izvještaj.
 * Dva izvora, oba već postoje:
 *   1. automatic/watchlist/events.jsonl — kandidati iz registryja (watch_candidates.js,
 *      nightly 5b). Uzimaju se samo ORIGINALI (shortsi/isječci/najave su odvojeni).
 *   2. git povijest automatic/podcasts/*-lista.txt — praćeni kanali. Svaki nightly
 *      commit „chore(podcasts): refresh podcast lists" doda retke novih epizoda; datum
 *      commita = noć otkrića. Liste imaju NA umjesto datuma i nemaju trajanje, pa za
 *      praćene nema sati ni dana u tjednu — samo broj.
 *
 * Jedinica je NOĆ OTKRIĆA (nightly ~03:00): sve što je izašlo od prethodnog runa.
 * To je točno; datum objave iz flat liste je približan („prije 1 dan"), pa se koristi
 * samo za raspodjelu po danu u tjednu. Noć bez ijednog događaja (ni derivata) znači
 * da watch nije radio — sljedeća noć tada pokupi dva dana, što 7-dnevni prosjek izgladi.
 *
 * Isti video u dva unosa (kanal + njegova playlista, gost objavi i kod sebe) broji se jednom.
 *
 * Izlaz: automatic/watchlist/DAILY.md + automatic/watchlist/daily.json
 *
 * Upotreba:
 *   node automatic/daily_snapshot.js              # zadnjih 30 noći
 *   node automatic/daily_snapshot.js --days 60
 *   node automatic/daily_snapshot.js --stdout     # samo ispiši, ne piši datoteke
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const OUT_DIR = path.join(__dirname, "watchlist");
const EVENTS_FILE = path.join(OUT_DIR, "events.jsonl");
const MD_FILE = path.join(OUT_DIR, "DAILY.md");
const JSON_FILE = path.join(OUT_DIR, "daily.json");
const NIGHTLY_SUBJECT = "chore(podcasts): refresh podcast lists";
// Više od ovoliko novih redaka u jednom kanalu u jednoj noći = onboarding/backfill
// cijelog kataloga, ne nove epizode (refresh novog kanala bez arhive povuče sve).
const BACKFILL_LINES = 5;

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const DAYS = parseInt(getArg("--days") || "30", 10);
const STDOUT = args.includes("--stdout");

const WEEKDAYS = ["ned", "pon", "uto", "sri", "čet", "pet", "sub"];

function isoDay(d) { return d.toISOString().slice(0, 10); }
function addDays(day, n) { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); }
function ymdToIso(s) { return /^\d{8}$/.test(s || "") ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null; }
function weekday(day) { return new Date(day + "T00:00:00Z").getUTCDay(); }
function hours(sec) { return Math.round(sec / 360) / 10; }

// ─── kandidati: events.jsonl ───────────────────────────────────────

function loadCandidateEvents() {
    const nightsWithRun = new Set();
    const episodes = [];
    let lines = [];
    try { lines = fs.readFileSync(EVENTS_FILE, "utf8").split("\n"); } catch { /* nema još */ }
    for (const line of lines) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        nightsWithRun.add(e.date);
        if (e.cls !== "original") continue;
        episodes.push({ night: e.date, id: e.id, slug: e.slug, duration: e.duration || null,
            upload: ymdToIso(e.upload_date), title: e.title || "", source: "kandidat" });
    }
    return { episodes, nightsWithRun };
}

// ─── praćeni: git povijest -lista.txt ──────────────────────────────

function loadTrackedEpisodes(sinceDay) {
    let out = "";
    try {
        out = execFileSync("git", ["-C", REPO, "log", `--since=${sinceDay}`, "--no-merges",
            "--date=format:%Y-%m-%d", "--format=@@COMMIT %ad %s", "-p", "-U0", "--no-color",
            "--", "automatic/podcasts/*-lista.txt"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    } catch (e) {
        console.error(`⚠️  git log nije uspio — praćeni kanali izostaju: ${e.message.split("\n")[0]}`);
        return { episodes: [], skipped: [] };
    }
    const episodes = [], skipped = [];
    let night = null, nightly = false, file = null, buf = [];
    const flush = () => {
        if (!nightly || !file || !buf.length) { buf = []; return; }
        if (buf.length > BACKFILL_LINES) skipped.push({ night, slug: file, lines: buf.length });
        else for (const b of buf) episodes.push({ ...b, night, slug: file, source: "praćeni" });
        buf = [];
    };
    for (const line of out.split("\n")) {
        if (line.startsWith("@@COMMIT ")) {
            flush(); file = null;
            const rest = line.slice(9);
            night = rest.slice(0, 10);
            nightly = rest.slice(11) === NIGHTLY_SUBJECT;
        } else if (line.startsWith("+++ ")) {
            flush();
            const m = line.match(/automatic\/podcasts\/(.+)-lista\.txt$/);
            file = m ? m[1] : null;
        } else if (line.startsWith("+") && !line.startsWith("+#")) {
            const m = line.match(/(?:youtu\.be\/|[?&]v=)([\w-]{11})/);
            if (!m) continue;
            const parts = line.slice(1).split("|").map((s) => s.trim());
            buf.push({ id: m[1], duration: null, upload: ymdToIso(parts[0]),
                title: parts.slice(1, -1).join(" | ") });
        }
    }
    flush();
    return { episodes, skipped };
}

// ─── agregacija ────────────────────────────────────────────────────

function build() {
    const today = isoDay(new Date());
    const since = addDays(today, -DAYS);
    const cand = loadCandidateEvents();
    const tracked = loadTrackedEpisodes(addDays(since, -1));

    // Dedup po ID-u: prvo otkriće pobjeđuje; praćeni prije kandidata iste noći.
    const all = [...tracked.episodes, ...cand.episodes]
        .sort((a, b) => a.night.localeCompare(b.night) || (a.source === "praćeni" ? -1 : 1));
    const seen = new Set(), eps = [];
    let dupes = 0;
    for (const e of all) {
        if (seen.has(e.id)) { dupes++; continue; }
        seen.add(e.id);
        eps.push(e);
    }
    const firstCandNight = [...cand.nightsWithRun].sort()[0] || today;
    const startNight = since > firstCandNight ? since : firstCandNight;

    const nights = [];
    for (let d = startNight; d <= today; d = addDays(d, 1)) {
        const list = eps.filter((e) => e.night === d);
        const c = list.filter((e) => e.source === "kandidat");
        const t = list.filter((e) => e.source === "praćeni");
        nights.push({
            night: d,
            watch_ran: cand.nightsWithRun.has(d),
            candidates: c.length,
            tracked: t.length,
            total: list.length,
            channels: new Set(list.map((e) => e.slug)).size,
            candidate_hours: hours(c.reduce((s, e) => s + (e.duration || 0), 0)),
        });
    }
    // 7-dnevni prosjek po kalendaru: noć bez runa doprinosi 0, a sljedeća nosi dva dana —
    // zbroj kroz 7 noći ostaje ispravan.
    for (let i = 0; i < nights.length; i++) {
        if (i < 6) { nights[i].avg7 = null; continue; }
        const w = nights.slice(i - 6, i + 1);
        nights[i].avg7 = Math.round((w.reduce((s, n) => s + n.total, 0) / 7) * 10) / 10;
    }

    const ran = nights.filter((n) => n.watch_ran);
    const inWindow = eps.filter((e) => e.night >= startNight);
    const candWin = inWindow.filter((e) => e.source === "kandidat");

    // Dan u tjednu po datumu objave (samo kandidati — praćeni nemaju datum).
    const byWeekday = Array.from({ length: 7 }, () => 0);
    const weekdayDays = Array.from({ length: 7 }, () => new Set());
    for (const e of candWin) if (e.upload) { byWeekday[weekday(e.upload)]++; }
    for (let d = startNight; d < today; d = addDays(d, 1)) weekdayDays[weekday(addDays(d, -1))].add(d);

    const perChannel = {};
    for (const e of inWindow) {
        const k = e.slug;
        perChannel[k] = perChannel[k] || { slug: k, source: e.source, count: 0, seconds: 0, last: null };
        perChannel[k].count++;
        perChannel[k].seconds += e.duration || 0;
        if (!perChannel[k].last || e.night > perChannel[k].last) perChannel[k].last = e.night;
    }
    const channels = Object.values(perChannel).sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));

    const durBuckets = [["<30 min", 0, 1800], ["30–60 min", 1800, 3600], ["60–90 min", 3600, 5400], ["90–120 min", 5400, 7200], ["≥120 min", 7200, Infinity]];
    const durations = durBuckets.map(([label, lo, hi]) => ({ label, count: candWin.filter((e) => e.duration >= lo && e.duration < hi).length }));

    const last = [...nights].reverse().find((n) => n.watch_ran) || nights[nights.length - 1];
    const lastEps = eps.filter((e) => e.night === last?.night);

    return {
        generated_at: new Date().toISOString(),
        window: { from: startNight, to: today, nights: nights.length, nights_with_run: ran.length },
        totals: {
            episodes: inWindow.length,
            candidates: candWin.length,
            tracked: inWindow.length - candWin.length,
            channels: channels.length,
            candidate_hours: hours(candWin.reduce((s, e) => s + (e.duration || 0), 0)),
            per_run_avg: ran.length ? Math.round((inWindow.length / ran.length) * 10) / 10 : null,
            per_day_avg: nights.length ? Math.round((inWindow.length / Math.max(1, nights.length - 1)) * 10) / 10 : null,
            duplicates_merged: dupes,
        },
        last_night: last ? { ...last, episodes: lastEps.map(({ id, slug, source, duration, title }) => ({ id, slug, source, duration, title })) } : null,
        nights,
        weekday: WEEKDAYS.map((w, i) => ({ weekday: w, episodes: byWeekday[i], days: weekdayDays[i].size })),
        durations,
        channels,
        skipped_backfills: tracked.skipped,
    };
}

// ─── markdown ──────────────────────────────────────────────────────

function render(s) {
    const t = s.totals, ln = s.last_night;
    const multi = ln ? Object.values(ln.episodes.reduce((m, e) => ((m[e.slug] = (m[e.slug] || 0) + 1), m), {})).filter((n) => n > 1).length : 0;
    const bar = (n, max) => "█".repeat(max ? Math.round((n / max) * 20) : 0);
    const maxNight = Math.max(1, ...s.nights.map((n) => n.total));
    const md = [
        "# Dnevni snapshot novih epizoda",
        "",
        `Generirano ${s.generated_at.slice(0, 16).replace("T", " ")} UTC skriptom \`automatic/daily_snapshot.js\` — nula mrežnih poziva, deterministički iz \`events.jsonl\` (kandidati, samo originali) i git povijesti \`automatic/podcasts/*-lista.txt\` (praćeni).`,
        "",
        ln ? `**Zadnja noć (${ln.night}): ${ln.total} novih epizoda u ${ln.channels} kanala** — ${ln.candidates} kandidata + ${ln.tracked} praćenih, ${ln.candidate_hours} h audia kod kandidata${multi ? `, ${multi} kanal(a) s više od jedne` : ", svaki kanal po jedna"}.` : "_Još nema podataka._",
        "",
        `**Prozor ${s.window.from} → ${s.window.to}** (${s.window.nights_with_run}/${s.window.nights} noći s runom): ${t.episodes} epizoda iz ${t.channels} kanala · **${t.per_day_avg}/dan** · ${t.candidate_hours} h audia kod kandidata${t.duplicates_merged ? ` · ${t.duplicates_merged} duplikata spojeno (isti video u dva unosa)` : ""}.`,
        "",
        "## Po noći",
        "",
        "| noć | dan | ukupno | kandidati | praćeni | kanala | h (kand.) | 7d prosjek | |",
        "|---|---|---|---|---|---|---|---|---|",
        ...[...s.nights].reverse().map((n) => n.watch_ran
            ? `| ${n.night} | ${WEEKDAYS[weekday(n.night)]} | **${n.total}** | ${n.candidates} | ${n.tracked} | ${n.channels} | ${n.candidate_hours} | ${n.avg7 ?? "—"} | ${bar(n.total, maxNight)} |`
            : `| ${n.night} | ${WEEKDAYS[weekday(n.night)]} | — | — | ${n.tracked} | — | — | ${n.avg7 ?? "—"} | _watch nije radio; sljedeća noć nosi dva dana_ |`),
        "",
        "## Po danu objave u tjednu (kandidati)",
        "",
        "Datum objave iz flat liste je približan (±1 dan nakon propuštenog runa).",
        "",
        "| dan | epizoda | prosjek/dan | |",
        "|---|---|---|---|",
        ...[1, 2, 3, 4, 5, 6, 0].map((i) => { const w = s.weekday[i]; const avg = w.days ? Math.round((w.episodes / w.days) * 10) / 10 : 0;
            return `| ${w.weekday} | ${w.episodes} | ${avg} | ${bar(avg, Math.max(...s.weekday.map((x) => (x.days ? x.episodes / x.days : 0))))} |`; }),
        "",
        "## Trajanje (kandidati)",
        "",
        "| trajanje | epizoda |",
        "|---|---|",
        ...s.durations.map((d) => `| ${d.label} | ${d.count} |`),
        "",
        "## Kanali u prozoru",
        "",
        `${s.channels.length} kanala objavilo je barem jednu epizodu; ${s.channels.filter((c) => c.count === 1).length} točno jednu.`,
        "",
        "| kanal | izvor | epizoda | h | zadnja noć |",
        "|---|---|---|---|---|",
        ...s.channels.map((c) => `| \`${c.slug}\` | ${c.source} | ${c.count} | ${c.seconds ? hours(c.seconds) : "—"} | ${c.last} |`),
        "",
    ];
    if (ln && ln.episodes.length) {
        md.push("## Epizode zadnje noći", "", "| kanal | izvor | min | naslov |", "|---|---|---|---|",
            ...ln.episodes.map((e) => `| \`${e.slug}\` | ${e.source} | ${e.duration ? Math.round(e.duration / 60) : "—"} | [${e.title.replace(/\|/g, "/").slice(0, 90)}](https://youtu.be/${e.id}) |`), "");
    }
    if (s.skipped_backfills.length) {
        md.push(`_Preskočeno kao onboarding/backfill (>${BACKFILL_LINES} redaka u kanalu u jednoj noći): ${s.skipped_backfills.map((b) => `${b.slug} ${b.night} (${b.lines})`).join(", ")}._`, "");
    }
    return md.join("\n");
}

function main() {
    const s = build();
    const md = render(s);
    if (STDOUT) { process.stdout.write(md + "\n"); return; }
    fs.writeFileSync(MD_FILE, md + "\n");
    fs.writeFileSync(JSON_FILE, JSON.stringify(s, null, 1) + "\n");
    const ln = s.last_night;
    console.log(`📊 Zadnja noć ${ln?.night}: ${ln?.total} epizoda / ${ln?.channels} kanala · prosjek ${s.totals.per_day_avg}/dan · ${path.relative(REPO, MD_FILE)}`);
}

if (require.main === module) main();
module.exports = { build, render };
