#!/usr/bin/env node
/**
 * backfill_days.js — TOČNI datumi objave epizoda svih podcasta iz registryja (YouTube Data API v3).
 *
 * Zašto: watch_candidates.js čita flat popis videa, a YouTube tamo daje samo „prije 3 tjedna"
 * / „prije 2 mjeseca". yt-dlp to pretvara u datum, pa je datum točan samo ~12 dana unatrag;
 * starije pada na 13/20/27 dana, pa na mjesece (30, 61, 91…). Za arhivu po danima
 * (podcast.domovina.ai/dani/) treba pravi dan objave — Data API ga daje (videoPublishedAt).
 *
 * Za svaki kanal (kandidati iz watch_candidates.loadCandidates + praćeni kanali):
 *   1. playlistItems na uploads playlisti (UU…) ili na izvornoj playlisti (PL…) do --since
 *   2. videos.list (50 ID-ova po pozivu) → trajanje, naslov, live status
 *   3. classify() iz watch_candidates.js — isto pravilo original / derivat / short kao nightly
 * Dan = lokalni datum objave u Europe/Zagreb.
 *
 * Kvota: 1 jedinica po pozivu (besplatno 10 000/dan). Puni backfill od 01.01. ≈ 2–4 tisuće;
 * inkrementalni prolaz (nightly) ≈ 2 poziva po kanalu ≈ 1 000.
 *
 * Izlaz: automatic/watchlist/backfill.json — samo ORIGINALI (s datumom, trajanjem, naslovom)
 * + broj derivata/shortsa po kanalu. Jedan kanal = jedan redak, da su git diffovi mali.
 * `covered_until` kanala = do kad je kanal pokriven; build-catalog za dane do tog trenutka
 * vjeruje SAMO ovoj datoteci (watch-state datumi su tamo približni).
 *
 * Upotreba:
 *   node automatic/backfill_days.js                    # inkrementalno (zadnjih 7 dana + novi kanali od --since)
 *   node automatic/backfill_days.js --full             # sve od --since ispočetka
 *   node automatic/backfill_days.js --slug lood-podcast --verbose
 *   Opcije: --since 2026-01-01, --limit N, --dry-run, --max-units 9000
 */

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const REGISTRY = path.join(REPO, "data", "podcasts_registry.json");
const OUT_DIR = path.join(__dirname, "watchlist");
const OUT_FILE = path.join(OUT_DIR, "backfill.json");
const STATE_FILE = path.join(OUT_DIR, "watch-state.json");

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const hasFlag = (n) => args.includes(n);

const SINCE = getArg("--since") || "2026-01-01";
const FULL = hasFlag("--full");
const DRY_RUN = hasFlag("--dry-run");
const VERBOSE = hasFlag("--verbose");
const ONLY_SLUG = getArg("--slug");
const LIMIT = parseInt(getArg("--limit") || "0", 10);
const MAX_UNITS = parseInt(getArg("--max-units") || "9000", 10);
const INCREMENTAL_OVERLAP_DAYS = 7;   // premijere i naknadno javni videi znaju doći s ranijim datumom
const MAX_PAGES_CUSTOM = 40;          // ne-uploads playlista nije sortirana po datumu → čitamo cijelu (do 2 000)
const CONCURRENCY = 4;

// .env ručno, bez dotenv dependencyja (isti obrazac kao upload_to_r2.js)
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
const API = "https://www.googleapis.com/youtube/v3";

const { classify, adaptiveMinDuration, loadCandidates, loadRules } = require("./watch_candidates.js");

// ─── YouTube Data API ──────────────────────────────────────────────

let units = 0;
class QuotaStop extends Error {}

async function api(endpoint, params) {
    if (units >= MAX_UNITS) throw new QuotaStop(`dosegnut --max-units ${MAX_UNITS}`);
    units++;
    const url = `${API}/${endpoint}?${new URLSearchParams({ ...params, key: API_KEY })}`;
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(url);
        if (res.ok) return res.json();
        const body = await res.text();
        if (res.status === 403 && /quotaExceeded|dailyLimitExceeded/.test(body)) throw new QuotaStop("YouTube API kvota potrošena za danas");
        if ((res.status >= 500 || res.status === 429) && attempt < 4) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
        const err = new Error(`${endpoint} HTTP ${res.status}: ${body.slice(0, 160).replace(/\s+/g, " ")}`);
        err.status = res.status;
        throw err;
    }
}

// PT1H2M3S → sekunde
function isoDuration(s) {
    const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || "");
    if (!m) return null;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

const ZAGREB = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zagreb", year: "numeric", month: "2-digit", day: "2-digit" });
const zagrebDate = (iso) => ZAGREB.format(new Date(iso));   // en-CA → YYYY-MM-DD

// ─── izvor kanala → playlist ID ────────────────────────────────────

function playlistFromUrl(url) {
    const m = /[?&]list=([\w-]+)/.exec(url || "");
    return m ? m[1] : null;
}
function channelIdFromUrl(url) {
    const m = /\/channel\/(UC[\w-]{22})/.exec(url || "");
    return m ? m[1] : null;
}
async function resolveChannelId(url, p) {
    const direct = channelIdFromUrl(url) || (p.youtube?.channel_id && /^UC[\w-]{22}$/.test(p.youtube.channel_id) ? p.youtube.channel_id : null);
    if (direct) return direct;
    const h = /\/@([^/?]+)/.exec(url || "")?.[1] || p.youtube?.handle?.replace(/^@/, "");
    if (h) {
        const r = await api("channels", { part: "id", forHandle: `@${decodeURIComponent(h)}` });
        if (r.items?.[0]?.id) return r.items[0].id;
    }
    const u = /\/user\/([^/?]+)/.exec(url || "")?.[1];
    if (u) {
        const r = await api("channels", { part: "id", forUsername: u });
        if (r.items?.[0]?.id) return r.items[0].id;
    }
    return null;
}

/** Izvori jednog unosa: { playlistId, sorted } — uploads (UU…) su sortirani po datumu, ostale playliste nisu. */
async function sourcesFor(c, p) {
    const urls = [c.source, ...(c.rule.extra_source_urls || [])];
    const out = [];
    for (const url of urls) {
        const pl = playlistFromUrl(url);
        if (pl) { out.push({ playlistId: pl, sorted: pl.startsWith("UU") }); continue; }
        const ch = await resolveChannelId(url, p);
        // /videos i /streams istog kanala = ista uploads playlista; dodaj jednom.
        if (ch) { const id = "UU" + ch.slice(2); if (!out.some((s) => s.playlistId === id)) out.push({ playlistId: id, sorted: true }); }
    }
    return out;
}

async function listPlaylist(src, sinceIso) {
    const ids = [];
    let pageToken, pages = 0;
    while (true) {
        const r = await api("playlistItems", { part: "contentDetails", playlistId: src.playlistId, maxResults: "50", ...(pageToken ? { pageToken } : {}) });
        pages++;
        let older = 0;
        for (const it of r.items || []) {
            const at = it.contentDetails?.videoPublishedAt;
            if (!at) continue;                                    // privatni / obrisani video u playlisti
            if (at >= sinceIso) ids.push(it.contentDetails.videoId); else older++;
        }
        pageToken = r.nextPageToken;
        if (!pageToken) break;
        // Uploads: cijela stranica starija od granice → dalje je samo starije.
        if (src.sorted && older === (r.items || []).length) break;
        if (!src.sorted && pages >= MAX_PAGES_CUSTOM) break;
    }
    return ids;
}

async function videoDetails(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
        const r = await api("videos", { part: "snippet,contentDetails", id: ids.slice(i, i + 50).join(","), maxResults: "50" });
        for (const v of r.items || []) {
            out.push({
                id: v.id,
                title: v.snippet?.title || "",
                published_at: v.snippet?.publishedAt,
                duration: isoDuration(v.contentDetails?.duration),
                live: v.snippet?.liveBroadcastContent,            // none | live | upcoming
            });
        }
    }
    return out;
}

// ─── popis unosa ───────────────────────────────────────────────────

function loadEntries() {
    const reg = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
    const bySlug = Object.fromEntries(reg.podcasts.map((p) => [p.slug, p]));
    const rules = loadRules();
    const entries = loadCandidates().map((c) => ({ ...c, tracked: bySlug[c.slug]?.tracking?.enabled === true }));   // poštuje --slug / --limit
    if (!ONLY_SLUG || !entries.length) {
        for (const p of reg.podcasts) {
            if (ONLY_SLUG && p.slug !== ONLY_SLUG) continue;
            if (p.tracking?.enabled !== true || !p.youtube?.url || p.youtube?.type === "umbrella") continue;
            if (entries.some((e) => e.slug === p.slug)) continue;
            const rule = { ...(rules[p.slug] || {}), ...(p.watch || {}) };
            entries.push({ slug: p.slug, name: p.display_name, source: rule.source_url || p.youtube.url, sources: [], rule, tracked: true });
        }
    }
    const list = LIMIT > 0 ? entries.slice(0, LIMIT) : entries;
    return { list, bySlug };
}

// ─── jedan kanal ───────────────────────────────────────────────────

async function processEntry(e, p, prev, watchCh) {
    const fresh = FULL || !prev || prev.since !== SINCE || prev.error;
    const fromDay = fresh ? SINCE : addDays(prev.covered_until.slice(0, 10), -INCREMENTAL_OVERLAP_DAYS);
    const fromIso = `${fromDay}T00:00:00Z`;
    const startedAt = new Date().toISOString();

    // Inkrementalno: playliste su već razriješene (štedi forHandle pozive), osim kad se izvor promijenio.
    const sources = !FULL && prev?.playlists?.length && prev.source === e.source
        ? prev.playlists.map((id) => ({ playlistId: id, sorted: id.startsWith("UU") }))
        : await sourcesFor(e, p);
    if (!sources.length) throw new Error("nema YouTube izvora (channel_id/handle/playlist)");
    const ids = new Set();
    for (const s of sources) for (const id of await listPlaylist(s, fromIso)) ids.add(id);
    const vids = (await videoDetails([...ids])).filter((v) => v.published_at && v.published_at >= fromIso);

    // Prag „pune epizode": ručno pravilo → nightly prag kanala → adaptivno iz ovog uzorka.
    const pool = {};
    for (const [id, v] of Object.entries(watchCh?.seen || {})) if (v.duration) pool[id] = { duration: v.duration };
    for (const v of vids) pool[v.id] = { duration: v.duration };
    const minDur = e.rule.min_duration_sec || watchCh?.min_duration_sec || adaptiveMinDuration(pool);

    const originals = fresh ? {} : { ...(prev.originals || {}) };
    const counts = fresh ? { derivative: 0, short: 0 } : { ...(prev.counts || { derivative: 0, short: 0 }) };
    // Inkrementalno: preklapanje se ponovno klasificira, pa ga prvo makni.
    if (!fresh) for (const [id, o] of Object.entries(originals)) if (o.published_at >= fromIso) delete originals[id];
    let pending = 0;
    for (const v of vids) {
        const r = classify({ duration: v.duration, title: v.title, live_status: v.live === "live" ? "is_live" : v.live === "upcoming" ? "is_upcoming" : null }, e.rule, minDur);
        if (r.cls === "pending") { pending++; continue; }
        if (r.cls === "original") {
            originals[v.id] = { date: zagrebDate(v.published_at), published_at: v.published_at, duration: v.duration, title: v.title.slice(0, 160) };
        } else if (fresh || v.published_at >= prev.covered_until) {
            counts[r.cls] = (counts[r.cls] || 0) + 1;              // preklapanje je već prebrojano
        }
        if (VERBOSE) console.log(`     ${r.cls.padEnd(10)} ${zagrebDate(v.published_at)} ${String(Math.round((v.duration || 0) / 60)).padStart(4)} min  ${v.title.slice(0, 70)}${r.reason ? `  (${r.reason})` : ""}`);
    }
    return {
        slug: e.slug,
        tracked: e.tracked,
        since: SINCE,
        // Pokriveno do trenutka kad je popis povučen — video objavljen poslije toga ide u idući prolaz.
        covered_until: startedAt,
        source: e.source,
        playlists: sources.map((s) => s.playlistId),
        min_duration_sec: minDur,
        counts,
        ...(pending ? { pending } : {}),
        originals,
    };
}

function addDays(day, n) { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// ─── zapis ─────────────────────────────────────────────────────────

function load() {
    try { return JSON.parse(fs.readFileSync(OUT_FILE, "utf8")); } catch { return { channels: {} }; }
}
/** Jedan kanal po retku: diff nightly inkrementa = samo kanali koji su se promijenili. */
function save(data) {
    const slugs = Object.keys(data.channels).sort();
    const lines = slugs.map((s, i) => `  ${JSON.stringify(s)}: ${JSON.stringify(data.channels[s])}${i < slugs.length - 1 ? "," : ""}`);
    const head = { generated_at: data.generated_at, since: data.since, note: data.note };
    const txt = `{\n${Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n  "channels": {\n${lines.map((l) => "  " + l).join("\n")}\n  }\n}\n`;
    fs.writeFileSync(OUT_FILE + ".tmp", txt);
    fs.renameSync(OUT_FILE + ".tmp", OUT_FILE);
}

// ─── main ──────────────────────────────────────────────────────────

async function main() {
    if (!API_KEY) { console.error("❌ Nema YOUTUBE_API_KEY u .env"); process.exit(1); }
    const { list, bySlug } = loadEntries();
    const data = load();
    let watch = {};
    try { watch = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).channels || {}; } catch { /* bez watch-statea */ }

    console.log(`📅 Backfill točnih datuma od ${SINCE}: ${list.length} unosa (${FULL ? "puni" : "inkrementalni"}${DRY_RUN ? ", DRY RUN" : ""})`);
    const t0 = Date.now();
    let idx = 0, done = 0, errors = 0, origTotal = 0, stopped = null;

    async function worker() {
        while (idx < list.length && !stopped) {
            const e = list[idx++];
            const p = bySlug[e.slug] || {};
            const prev = data.channels[e.slug];
            try {
                const r = await processEntry(e, p, prev, watch[e.slug]);
                data.channels[e.slug] = r;
                const n = Object.keys(r.originals).length;
                origTotal += n;
                if (VERBOSE || list.length <= 5) console.log(`  [${e.slug}] ${n} originala, ${r.counts.derivative} derivata, ${r.counts.short} shortsa, prag ${Math.round(r.min_duration_sec / 60)} min`);
            } catch (err) {
                if (err instanceof QuotaStop) { stopped = err.message; break; }
                errors++;
                data.channels[e.slug] = { ...(prev || {}), slug: e.slug, error: err.message.slice(0, 200), error_at: new Date().toISOString() };
                console.log(`  ⚠️  [${e.slug}] ${err.message.slice(0, 140)}`);
            }
            done++;
            if (done % 50 === 0) {
                console.log(`  … ${done}/${list.length} · ${units} jedinica kvote`);
                if (!DRY_RUN) { data.generated_at = new Date().toISOString(); save(data); }
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));

    data.generated_at = new Date().toISOString();
    data.since = SINCE;
    data.note = "Točni datumi objave (YouTube Data API, Europe/Zagreb) — automatic/backfill_days.js. Samo originali; covered_until = do kad je kanal pokriven.";
    if (!DRY_RUN) save(data);

    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`✅ ${done}/${list.length} unosa za ${secs}s · ${origTotal} originala · ${errors} grešaka · ${units} jedinica kvote${stopped ? ` · ⏸️ ZAUSTAVLJENO: ${stopped} (nastavi sutra, isti poziv)` : ""}`);
    if (done === 0 && list.length) process.exit(1);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { isoDuration, zagrebDate };
