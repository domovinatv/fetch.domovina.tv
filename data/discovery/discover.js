#!/usr/bin/env node
/**
 * discover.js — ponovljivi (mjesečni) research alat za širenje i reviziju registryja.
 *
 * Sve što alat zna čuva se u gitu, ne u LLM kontekstu:
 *   data/discovery/queries.txt      — upiti za YouTube search (kategorija|upit)
 *   data/discovery/ledger.json      — PRESUDE po kanalu/playlisti (podcast, nije podcast,
 *                                     nije HR…). Svaki idući prolaz preskače presuđeno →
 *                                     svaki prolaz je pametniji od prethodnog.
 *   data/discovery/query_stats.json — koliko je koji upit donio novih podcasta (kroz prolaze)
 *   data/discovery/runs/<datum>/    — sirovi artefakti prolaza (sweep, probe, triage,
 *                                     LLM prompt + sirovi odgovor, klasifikacija)
 *
 * Koraci (svaki idempotentan, cache po datoteci u runs/<datum>/):
 *   sweep      yt-dlp ytsearch po queries.txt                        (deterministički)
 *   seed       uvoz vanjskih kandidata (web research, Podscan…)     (deterministički uvoz)
 *   podcasts-tab  YouTube /podcasts tab kanala iz media_channels.txt (deterministički)
 *   aggregate  jedinstveni kanali/playliste − registry − ledger       (deterministički)
 *   probe      zadnjih 60 videa + metapodaci kanala, nula medija      (deterministički)
 *   triage     metrike + auto-presuda „je li podcast" po trajanjima   (deterministički)
 *   classify   LLM presuda: HR? podcast? tagovi, pravilo za derivate  (LLM, sirovo spremljeno)
 *   apply      registry += prihvaćeni; ledger += SVE presude          (deterministički)
 *   exact-dates  točan datum zadnjeg originala (1 ne-flat poziv po unosu) → status
 *   activity   watch-state (nightly) → registry `activity` (+ --update-status)
 *   ledger-import presude s razlogom (npr. odbijeni iz web researcha) → ledger
 *   revise-apply  revizija postojećih unosa (--file revisions.json) → status, URL, watch pravila
 *   all        sweep → podcasts-tab → aggregate → probe → triage → classify [→ apply uz --apply]
 *
 * Upotreba:
 *   node data/discovery/discover.js all                    # mjesečni prolaz, bez pisanja u registry
 *   node data/discovery/discover.js apply --dry-run        # pogledaj što bi ušlo
 *   node data/discovery/discover.js apply                  # upiši + regeneriraj md/csv/score
 *   node data/discovery/discover.js seed --file web/candidates.json --source web-research
 *   node data/discovery/discover.js classify --classifier manual   # piše prompt, LLM odgovor ručno
 *   node data/discovery/discover.js activity --update-status
 * Opcije: --run YYYY-MM-DD (default danas), --concurrency 4, --search-n 40,
 *         --model sonnet, --batch 25, --only-new-queries
 *
 * Runbook: docs/REGISTRY_DISCOVERY.md
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const DIR = __dirname;
const REGISTRY = path.join(ROOT, "data", "podcasts_registry.json");
const QUERIES = path.join(DIR, "queries.txt");
const LEDGER = path.join(DIR, "ledger.json");
const QSTATS = path.join(DIR, "query_stats.json");
const WATCH_STATE = path.join(ROOT, "automatic", "watchlist", "watch-state.json");
const WATCH_RULES = path.join(ROOT, "automatic", "watchlist", "rules.json");

const args = process.argv.slice(2);
const CMD = args[0];
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const hasFlag = (n) => args.includes(n);

const RUN = getArg("--run") || new Date().toISOString().slice(0, 10);
const RUN_DIR = path.join(DIR, "runs", RUN);
const CONCURRENCY = parseInt(getArg("--concurrency") || "4", 10);
const SEARCH_N = parseInt(getArg("--search-n") || "40", 10);
const PROBE_ITEMS = 60;
const DRY_RUN = hasFlag("--dry-run");
const YTDLP = process.env.YTDLP_BIN || "yt-dlp";
const CLAUDE_MODEL = getArg("--model") || process.env.DISCOVERY_CLAUDE_MODEL || "sonnet";
const BATCH = parseInt(getArg("--batch") || "25", 10);

// Presude i kad ih ponovno provjeriti (dani). Kanal koji danas nije podcast može to
// postati; nehrvatski kanal ne postaje hrvatski.
const VERDICTS = {
    podcast_hr: { recheck: null },          // ide u registry
    not_podcast: { recheck: 180 },
    not_hr: { recheck: null },
    institutional: { recheck: 365 },        // institucija/medij bez podcast formata
    too_small: { recheck: 120 },            // premalo epizoda — možda tek kreće
    uncertain: { recheck: 60 },
};

// ─── pomoćno ───────────────────────────────────────────────────────

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1) + "\n"); };
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const log = (...a) => console.log(...a);

function runYtdlp(a, timeoutMs = 120000) {
    return new Promise((resolve) => {
        const child = spawn(YTDLP, a, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
    });
}

async function pool(items, n, fn) {
    let i = 0, done = 0;
    async function w() {
        while (i < items.length) {
            const it = items[i++];
            await fn(it);
            if (++done % 25 === 0) log(`   … ${done}/${items.length}`);
        }
    }
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, w));
}

function playlistId(url) { const m = /[?&]list=([\w-]+)/.exec(url || ""); return m ? m[1] : null; }
function normHandleUrl(url) {
    return (url || "").toLowerCase().replace(/^https?:\/\/(www\.|m\.)?/, "").replace(/\/(videos|featured|streams|shorts|playlists)?\/?$/, "");
}

/** Ključevi svega što registry već zna: channel_id, playlist_id i normalizirani URL. */
function knownKeys(reg) {
    const k = new Set();
    for (const p of reg.podcasts) {
        const u = p.youtube?.url;
        const pl = playlistId(u);
        if (pl) k.add(pl);
        else if (p.youtube?.channel_id) k.add(p.youtube.channel_id);
        if (u) k.add(normHandleUrl(u));
    }
    return k;
}

function ledgerBlocks(entry) {
    if (!entry) return false;
    const days = VERDICTS[entry.verdict]?.recheck;
    if (days == null) return true;               // trajna presuda
    const age = (Date.now() - Date.parse(entry.judged_at)) / 86400000;
    return age < days;
}

// ─── sweep ─────────────────────────────────────────────────────────

function loadQueries() {
    return fs.readFileSync(QUERIES, "utf8").split("\n").map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("|"))
        .map((l) => ({ cat: l.slice(0, l.indexOf("|")).trim(), q: l.slice(l.indexOf("|") + 1).trim() }));
}

async function cmdSweep() {
    let queries = loadQueries();
    if (hasFlag("--only-new-queries")) {
        const st = readJson(QSTATS, {});
        queries = queries.filter((x) => !st[x.q]);
    }
    const outDir = path.join(RUN_DIR, "sweep");
    fs.mkdirSync(outDir, { recursive: true });
    log(`🔎 sweep: ${queries.length} upita × ytsearch${SEARCH_N}`);
    await pool(queries, CONCURRENCY, async ({ cat, q }) => {
        const f = path.join(outDir, `${hash(q)}.json`);
        if (fs.existsSync(f)) return;
        const r = await runYtdlp(["--flat-playlist", "-j", "--no-warnings", `ytsearch${SEARCH_N}:${q}`]);
        const hits = r.out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter((j) => j && j.channel_id)
            .map((j) => ({ channel_id: j.channel_id, channel: j.channel, channel_url: j.channel_url, id: j.id, title: j.title, duration: j.duration }));
        writeJson(f, { cat, q, at: new Date().toISOString(), hits });
    });
}

// ─── seed (vanjski izvori: web research agent, Podscan, ručne liste) ─

function cmdSeed() {
    const file = getArg("--file");
    const source = getArg("--source") || "seed";
    if (!file) throw new Error("seed treba --file <candidates.json>");
    const raw = readJson(path.resolve(file), null);
    let list = Array.isArray(raw) ? raw : raw?.candidates || raw?.rejected || [];
    const filter = getArg("--filter-reason");
    if (filter) list = list.filter((c) => new RegExp(filter, "i").test(c.reason || ""));
    const seeds = list.filter((c) => c.youtube_url || c.url).map((c) => ({
        url: c.youtube_url || c.url,
        channel_id: c.channel_id || null,
        playlist_id: c.playlist_id || playlistId(c.youtube_url || c.url),
        name: c.display_name || c.name || null,
        hint: { tags: c.tags, hosts: c.hosts, parent_channel: c.parent_channel, evidence: c.evidence, source_urls: c.source_urls, confidence: c.confidence, suggested_min_duration_sec: c.suggested_min_duration_sec },
    }));
    // --force: seed zaobilazi ledger i filtar „podskup kanala" (ručno odabrane playliste,
    // npr. podcast serije unutar kanala koji je u registryju kao cijeli kanal).
    const force = hasFlag("--force");
    writeJson(path.join(RUN_DIR, "seeds", `${source}.json`), { source, file, at: new Date().toISOString(), force, seeds });
    log(`🌱 seed: ${seeds.length} kandidata iz ${file} → runs/${RUN}/seeds/${source}.json`);
}


// ─── podcasts-tab (YouTubeov vlastiti popis podcasta kanala) ───────
//
// Kanali medijskih kuća/institucija često imaju tab /podcasts koji YouTube sam
// puni podcast playlistama — najplodniji izvor u web researchu 2026-09-24
// (sve 22 HRT-ove podcast playliste odjednom). Handle URL-ovi znaju vratiti
// „nema podcasts taba", pa idemo preko /channel/<UC…>/podcasts.

async function cmdPodcastsTab() {
    const lines = fs.readFileSync(path.join(DIR, "media_channels.txt"), "utf8").split("\n")
        .map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("|"));
    const chans = lines.map((l) => { const [name, ref] = l.split("|").map((x) => x.trim()); return { name, ref }; });
    if (hasFlag("--include-registry")) {
        const reg = readJson(REGISTRY);
        for (const p of reg.podcasts) if (p.youtube?.channel_id && !playlistId(p.youtube.url)) chans.push({ name: p.display_name, ref: p.youtube.channel_id });
    }
    const outDir = path.join(RUN_DIR, "podcasts_tab");
    fs.mkdirSync(outDir, { recursive: true });
    log(`🎙️  podcasts-tab: ${chans.length} kanala`);
    await pool(chans, CONCURRENCY, async (c) => {
        const f = path.join(outDir, `${hash(c.ref)}.json`);
        if (fs.existsSync(f)) return;
        const base = /^UC[\w-]{22}$/.test(c.ref) ? `https://www.youtube.com/channel/${c.ref}` : c.ref.replace(/\/+$/, "").replace(/\/(videos|featured|podcasts|playlists)$/, "");
        const r = await runYtdlp(["--flat-playlist", "-J", "--no-warnings", `${base}/podcasts`]);
        let j = null; try { j = JSON.parse(r.out); } catch { /* nema taba */ }
        writeJson(f, { name: c.name, ref: c.ref, playlists: (j?.entries || []).filter((e) => e && e.id).map((e) => ({ id: e.id, title: e.title, url: e.url })), error: j ? null : (r.err.trim().split("\n").pop() || "").slice(0, 200) });
    });
    const seeds = [];
    for (const f of fs.readdirSync(outDir)) {
        const t = readJson(path.join(outDir, f));
        for (const pl of t.playlists) seeds.push({ url: `https://www.youtube.com/playlist?list=${pl.id}`, channel_id: /^UC/.test(t.ref) ? t.ref : null, playlist_id: pl.id, name: pl.title, hint: { parent_channel: t.name, evidence: "YouTube /podcasts tab kanala" } });
    }
    writeJson(path.join(RUN_DIR, "seeds", "podcasts-tab.json"), { source: "podcasts-tab", at: new Date().toISOString(), seeds });
    log(`   → ${seeds.length} podcast playlista kao seed (runs/${RUN}/seeds/podcasts-tab.json)`);
}

// ─── aggregate ─────────────────────────────────────────────────────

function cmdAggregate() {
    const reg = readJson(REGISTRY);
    const known = knownKeys(reg);
    const ledger = readJson(LEDGER, {});
    const targets = new Map();

    const sweepDir = path.join(RUN_DIR, "sweep");
    const perQuery = {};
    for (const f of fs.existsSync(sweepDir) ? fs.readdirSync(sweepDir) : []) {
        const s = readJson(path.join(sweepDir, f));
        const chans = new Set(s.hits.map((h) => h.channel_id));
        perQuery[s.q] = { cat: s.cat, channels: [...chans] };
        for (const h of s.hits) {
            const t = targets.get(h.channel_id) || { key: h.channel_id, type: "channel", url: `https://www.youtube.com/channel/${h.channel_id}/videos`, name: h.channel, channel_id: h.channel_id, sources: [], queries: [], search_long_hits: 0 };
            if (!t.queries.includes(s.q)) t.queries.push(s.q);
            if (!t.sources.includes("yt-search")) t.sources.push("yt-search");
            if ((h.duration || 0) >= 1800) t.search_long_hits++;
            targets.set(h.channel_id, t);
        }
    }
    const seedDir = path.join(RUN_DIR, "seeds");
    for (const f of fs.existsSync(seedDir) ? fs.readdirSync(seedDir) : []) {
        const s = readJson(path.join(seedDir, f));
        for (const c of s.seeds) {
            const key = c.playlist_id || c.channel_id || normHandleUrl(c.url);
            const t = targets.get(key) || { key, type: c.playlist_id ? "playlist" : "channel", url: c.url, name: c.name, channel_id: c.channel_id, playlist_id: c.playlist_id, sources: [], queries: [], hints: [] };
            if (!t.sources.includes(s.source)) t.sources.push(s.source);
            if (s.force) t.force = true;
            (t.hints = t.hints || []).push({ source: s.source, ...c.hint });
            targets.set(key, t);
        }
    }

    // Playliste kanala koji je u registryju kao CIJELI kanal su njegov podskup (sezone,
    // highlightsi, Q&A) — preskoči. Iznimka: kanal presuđen kao ne-podcast (TV, medij),
    // gdje je baš playlista pravi podcast (Z1 Press klub, Laudato Nota bene…).
    const wholeChannel = new Map();
    for (const p of reg.podcasts) {
        if (p.youtube?.channel_id && !playlistId(p.youtube.url)) wholeChannel.set(p.youtube.channel_id, p);
    }
    const fresh = [], skipped = { registry: 0, ledger: 0, subset: 0 };
    for (const t of targets.values()) {
        if (known.has(t.key) || (t.url && known.has(normHandleUrl(t.url)))) { skipped.registry++; continue; }
        const parent = t.type === "playlist" && t.channel_id && wholeChannel.get(t.channel_id);
        if (!t.force && parent && !["not-podcast", "dead-url"].includes(parent.metadata?.status)) { skipped.subset++; continue; }
        if (!t.force && ledgerBlocks(ledger[t.key])) { skipped.ledger++; continue; }
        fresh.push(t);
    }
    writeJson(path.join(RUN_DIR, "targets.json"), fresh);
    writeJson(path.join(RUN_DIR, "per_query.json"), perQuery);
    log(`🧮 aggregate: ${targets.size} jedinstvenih → ${fresh.length} za probe (već u registryju ${skipped.registry}, podskup kanala iz registryja ${skipped.subset}, presuđeno u ledgeru ${skipped.ledger})`);
}

// ─── probe ─────────────────────────────────────────────────────────

async function cmdProbe() {
    const targets = readJson(path.join(RUN_DIR, "targets.json"), []);
    const outDir = path.join(RUN_DIR, "probe");
    fs.mkdirSync(outDir, { recursive: true });
    log(`🔬 probe: ${targets.length} kanala/playlista (zadnjih ${PROBE_ITEMS} videa, nula medija)`);
    await pool(targets, CONCURRENCY, async (t) => {
        const f = path.join(outDir, `${hash(t.key)}.json`);
        if (fs.existsSync(f) && !hasFlag("--refresh")) return;
        let url = t.url;
        if (t.type === "channel" && !playlistId(url)) url = url.replace(/\/+$/, "").replace(/\/(featured|streams|shorts|playlists)$/, "") + (/\/videos$/.test(url) ? "" : "/videos");
        const r = await runYtdlp(["--flat-playlist", "-J", "--no-warnings", "--playlist-items", `1:${PROBE_ITEMS}`,
            "--extractor-args", "youtubetab:approximate_date", url]);
        let j = null;
        try { j = JSON.parse(r.out); } catch { /* greška ispod */ }
        if (!j) { writeJson(f, { key: t.key, url, error: (r.err.trim().split("\n").pop() || `exit ${r.code}`).slice(0, 300) }); return; }
        // Podcasti koji izlaze kao livestream/premijera vide se samo na /streams
        // (sweep 2026-09-24: +35 jakih kanala; Podcast 8_24 ima 3 duga na /videos, 58 uživo).
        if (/\/videos$/.test(url)) {
            const rs = await runYtdlp(["--flat-playlist", "-J", "--no-warnings", "--playlist-items", "1:30",
                "--extractor-args", "youtubetab:approximate_date", url.replace(/\/videos$/, "/streams")]);
            try {
                const js = JSON.parse(rs.out);
                const have = new Set((j.entries || []).map((e) => e && e.id));
                j.streams_count = (js.entries || []).length;
                j.entries = [...(j.entries || []), ...(js.entries || []).filter((e) => e && e.id && !have.has(e.id))];
            } catch { /* kanal nema /streams */ }
        }
        writeJson(f, {
            key: t.key, url,
            channel_id: j.channel_id || t.channel_id || null,
            playlist_id: playlistId(url),
            title: j.title, channel: j.channel || j.uploader, channel_url: j.channel_url,
            description: (j.description || "").slice(0, 1500),
            follower_count: j.channel_follower_count ?? null,
            streams_count: j.streams_count || 0,
            // -J (za razliku od -j) daje `timestamp`, ne `upload_date`.
            videos: (j.entries || []).filter((e) => e && e.id).map((e) => ({ id: e.id, title: e.title, duration: e.duration ?? null, live_status: e.live_status || null,
                upload_date: e.upload_date || (e.timestamp ? new Date(e.timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, "") : null) })),
        });
    });
}

// ─── triage (deterministička) ──────────────────────────────────────

const { classify: classifyVideo, adaptiveMinDuration } = require(path.join(ROOT, "automatic", "watch_candidates.js"));

function daysSince(d) {
    if (!d || !/^\d{8}$/.test(d)) return null;
    return Math.floor((Date.now() - Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))) / 86400000);
}

function metricsFor(videos, rule = {}) {
    const seen = Object.fromEntries(videos.map((v) => [v.id, { duration: v.duration }]));
    const minDur = rule.min_duration_sec || adaptiveMinDuration(seen);
    const cls = videos.map((v) => ({ ...v, ...classifyVideo(v, rule, minDur) }));
    const orig = cls.filter((v) => v.cls === "original");
    const longs = orig.filter((v) => v.duration >= 1800);
    const dates = orig.map((v) => v.upload_date).filter(Boolean).sort();
    return {
        sampled: videos.length,
        originals: orig.length,
        originals_30min: longs.length,
        derivative_ratio: videos.length ? +(1 - orig.length / videos.length).toFixed(2) : 0,
        avg_original_min: orig.length ? Math.round(orig.reduce((a, v) => a + v.duration, 0) / orig.length / 60) : 0,
        min_duration_sec: minDur,
        first_original: dates[0] || null,
        last_original: dates[dates.length - 1] || null,
        originals_90d: orig.filter((v) => { const d = daysSince(v.upload_date); return d != null && d <= 90; }).length,
        sample_titles: orig.slice(0, 8).map((v) => v.title),
        sample_derivatives: cls.filter((v) => v.cls !== "original").slice(0, 4).map((v) => `${v.title} (${v.reason || v.cls})`),
    };
}

/** Auto-presuda po trajanjima (+ ćirilica). LLM dobiva samo `candidate` i `maybe`. */
function autoVerdict(m) {
    const t = m.sample_titles || [];
    if (t.length >= 3 && t.filter((x) => /[\u0400-\u04FF]/.test(x)).length / t.length > 0.5) return "not_hr";
    if (m.originals_30min >= 8 && m.avg_original_min >= 30) return "candidate";
    if (m.originals_30min >= 4 && m.avg_original_min >= 25) return "maybe";
    if (m.originals_30min >= 1 && m.sampled < 12) return "maybe";      // mlad kanal — LLM odlučuje too_small
    return "not_podcast";
}

function cmdTriage() {
    const reg = readJson(REGISTRY);
    const known = knownKeys(reg);
    const targets = readJson(path.join(RUN_DIR, "targets.json"), []);
    const rows = [];
    const seenKeys = new Set();
    for (const t of targets) {
        const p = readJson(path.join(RUN_DIR, "probe", `${hash(t.key)}.json`), null);
        if (!p) continue;
        if (p.error) { rows.push({ key: t.key, name: t.name, url: t.url, auto: "error", error: p.error }); continue; }
        // Seed bez ID-a dobije pravi ključ tek u probeu → ponovni dedupe.
        const realKey = p.playlist_id || p.channel_id || t.key;
        if (seenKeys.has(realKey)) continue;
        // Ne izbacuj ono što je u međuvremenu ušlo u registry (npr. apply istog runa) —
        // triage.json je artefakt prolaza i ponovni triage ga ne smije osiromašiti.
        const inRegistry = known.has(realKey);
        seenKeys.add(realKey);
        const hintMin = (t.hints || []).map((h) => h.suggested_min_duration_sec).find((x) => x > 0);
        const m = metricsFor(p.videos, hintMin ? { min_duration_sec: hintMin } : {});
        rows.push({
            key: realKey, type: p.playlist_id ? "playlist" : "channel",
            name: p.playlist_id ? p.title : (p.channel || p.title || t.name),
            parent_channel: p.playlist_id ? p.channel : null,
            url: p.playlist_id ? `https://www.youtube.com/playlist?list=${p.playlist_id}` : `https://www.youtube.com/channel/${p.channel_id}/videos`,
            channel_id: p.channel_id, playlist_id: p.playlist_id, follower_count: p.follower_count, streams_count: p.streams_count || 0,
            description: p.description, sources: t.sources, queries: t.queries, hints: t.hints || [],
            auto: autoVerdict(m), ...(inRegistry ? { in_registry: true } : {}), ...m,
        });
    }
    writeJson(path.join(RUN_DIR, "triage.json"), rows);
    const c = (v) => rows.filter((r) => r.auto === v).length;
    log(`⚖️  triage: ${rows.length} → candidate ${c("candidate")}, maybe ${c("maybe")}, not_podcast ${c("not_podcast")}, not_hr (ćirilica) ${c("not_hr")}, error ${c("error")}`);
}

// ─── classify (LLM) ────────────────────────────────────────────────

const SYSTEM_PROMPT = `Ti si urednik javnog kataloga HRVATSKIH podcasta na YouTubeu. Za svaki kanal ili playlistu iz ulaza doneseš presudu isključivo iz priloženih podataka (naziv, opis, naslovi, metrike). Ne izmišljaj.

Presude (polje "verdict"):
- "podcast_hr": razgovorni/podcast format (pune epizode, razgovor, intervju, monolog-podcast), na hrvatskom jeziku ILI hrvatska dijaspora/tematika. Uključuje i BiH Hrvate.
- "not_hr": srpski, bosanski (nehrvatski), slovenski, crnogorski, makedonski, engleski bez hrvatske veze… Srpska ekavica i ćirilica su jasni znakovi.
- "not_podcast": propovijedi/mise bez razgovora, predavanja/konferencije, vijesti, TV emisije koje nisu podcast, glazba, gaming streamovi, tutoriali, audioknjige, prijenosi sjednica.
- "institutional": institucija/medij čiji kanal NIJE podcast, ali možda ima podcast playlistu (napiši u reason).
- "too_small": izgleda kao podcast ali premalo epizoda za sada.
- "uncertain": podaci ne dopuštaju odluku.

Budi editorijalno neutralan: politička, vjerska ili svjetonazorska orijentacija NIJE kriterij.

Za "podcast_hr" dodaj: "slug" (kebab-case, ascii, bez dijakritika), "display_name", "tags" (1–3 iz dopuštene liste), "hosts" (samo ako su jasni iz naslova/opisa, inače []), i po potrebi "watch_rule" s "exclude_title_regex" / "include_title_regex" (JavaScript regex bez delimitera, prefiks (?i) za case-insensitive) SAMO ako naslovi pokazuju jasan obrazac derivata (Q&A izrezi, isječci, najave) ili originala (npr. "#\\d+").

Vrati ISKLJUČIVO JSON niz, jedan objekt po ulazu, istim redom: [{"key": "...", "verdict": "...", "reason": "kratko, hrvatski", "slug": ..., "display_name": ..., "tags": [...], "hosts": [...], "watch_rule": {...}|null}]`;

function batchInput(rows, tags) {
    return JSON.stringify({
        dopusteni_tagovi: tags,
        kanali: rows.map((r) => ({
            key: r.key, type: r.type, name: r.name, parent_channel: r.parent_channel, url: r.url,
            follower_count: r.follower_count, description: (r.description || "").slice(0, 600),
            originals: r.originals, originals_30min: r.originals_30min, avg_original_min: r.avg_original_min,
            derivative_ratio: r.derivative_ratio, last_original: r.last_original, originals_90d: r.originals_90d,
            sample_titles: r.sample_titles, sample_derivatives: r.sample_derivatives,
            hints: (r.hints || []).map((h) => ({ source: h.source, evidence: h.evidence, tags: h.tags, hosts: h.hosts })),
        })),
    }, null, 1);
}

function callClaude(system, user) {
    // Isti obrazac kao summarize_gemini.js: pretplata (NIKAD --bare), bez toolova,
    // bez settings/CLAUDE.md konteksta (neutralni cwd).
    const cwd = path.join(os.tmpdir(), "domovina_claude_cli");
    fs.mkdirSync(cwd, { recursive: true });
    const r = spawnSync("claude", ["-p", "--model", CLAUDE_MODEL, "--output-format", "json", "--setting-sources", "",
        "--strict-mcp-config", "--max-turns", "1", "--tools", "", "--system-prompt", system],
    { input: user, cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
    if (r.status !== 0) throw new Error(`claude exit ${r.status}: ${(r.stderr || r.stdout || "").slice(0, 300)}`);
    const env = JSON.parse(r.stdout);
    if (env.is_error) throw new Error(`claude greška: ${String(env.result).slice(0, 300)}`);
    return env.result || "";
}

function parseJsonArray(text) {
    const s = text.indexOf("["), e = text.lastIndexOf("]");
    if (s < 0 || e < s) throw new Error("odgovor nema JSON niz");
    return JSON.parse(text.slice(s, e + 1));
}

function cmdClassify() {
    const reg = readJson(REGISTRY);
    const tags = Object.keys(reg.tag_legend || {});
    const rows = readJson(path.join(RUN_DIR, "triage.json"), []).filter((r) => r.auto === "candidate" || r.auto === "maybe");
    const outDir = path.join(RUN_DIR, "classify");
    fs.mkdirSync(outDir, { recursive: true });
    const mode = getArg("--classifier") || "claude";
    const result = readJson(path.join(RUN_DIR, "classification.json"), {});
    const todo = rows.filter((r) => !result[r.key]);
    log(`🧠 classify (${mode}${mode === "claude" ? `:${CLAUDE_MODEL}` : ""}): ${todo.length} za presudu (${rows.length - todo.length} već presuđeno u ovom runu)`);
    for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        const n = String(Math.floor(i / BATCH) + 1).padStart(2, "0");
        const input = batchInput(batch, tags);
        fs.writeFileSync(path.join(outDir, `batch_${n}.input.json`), input);
        const rawFile = path.join(outDir, `batch_${n}.raw.txt`);
        if (mode === "manual") {
            if (!fs.existsSync(rawFile)) { fs.writeFileSync(path.join(outDir, "SYSTEM_PROMPT.txt"), SYSTEM_PROMPT); continue; }
        } else if (!fs.existsSync(rawFile)) {
            log(`   batch ${n}: ${batch.length} kanala → claude`);
            fs.writeFileSync(rawFile, callClaude(SYSTEM_PROMPT, input));
        }
        const out = parseJsonArray(fs.readFileSync(rawFile, "utf8"));
        for (const o of out) {
            if (!o.key || !VERDICTS[o.verdict]) continue;
            result[o.key] = { ...o, classifier: mode === "manual" ? "manual" : `claude:${CLAUDE_MODEL}` };
        }
        writeJson(path.join(RUN_DIR, "classification.json"), result);
    }
    if (mode === "manual") log(`   ✍️  manual: popuni classify/batch_NN.raw.txt (JSON niz) prema SYSTEM_PROMPT.txt, pa ponovi naredbu`);
    const c = {};
    for (const v of Object.values(result)) c[v.verdict] = (c[v.verdict] || 0) + 1;
    log(`   presude: ${JSON.stringify(c)}`);
}

// ─── apply ─────────────────────────────────────────────────────────

function slugify(s) {
    return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "d")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
const ym = (d) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}` : null);
function statusFrom(last) {
    const d = daysSince(last);
    if (d == null) return "unknown";
    return d <= 60 ? "active" : d <= 365 ? "active-slowing" : "inactive";
}

function cmdApply() {
    const reg = readJson(REGISTRY);
    const ledger = readJson(LEDGER, {});
    const qstats = readJson(QSTATS, {});
    const triage = readJson(path.join(RUN_DIR, "triage.json"), []);
    const cls = readJson(path.join(RUN_DIR, "classification.json"), {});
    const perQuery = readJson(path.join(RUN_DIR, "per_query.json"), {});
    const known = knownKeys(reg);
    const slugs = new Set(reg.podcasts.map((p) => p.slug));
    const tagOk = new Set(Object.keys(reg.tag_legend || {}));
    const source = `registry-discovery-${RUN.slice(0, 7)}`;
    const rules = readJson(WATCH_RULES, {});
    const added = [], merged = [], judged = {};

    for (const r of triage) {
        if (r.auto === "error") continue;
        const c = cls[r.key];
        const verdict = c ? c.verdict : ["not_podcast", "not_hr"].includes(r.auto) ? r.auto : null;
        if (!verdict) continue;                                   // čeka LLM presudu
        judged[verdict] = (judged[verdict] || 0) + 1;
        const prev = ledger[r.key] || {};
        ledger[r.key] = {
            ...(prev.slug ? { slug: prev.slug } : {}), ...(prev.merged_into ? { merged_into: prev.merged_into } : {}),
            name: r.name, url: r.url, type: r.type, verdict,
            reason: c ? c.reason : r.auto === "not_hr" ? "auto: većina naslova ćirilicom" : `auto: ${r.originals_30min} originala ≥30 min od ${r.sampled}, prosjek ${r.avg_original_min} min`,
            judged_at: prev.run === RUN && prev.judged_at ? prev.judged_at : today(), run: RUN, by: c ? c.classifier : "triage",
            metrics: { sampled: r.sampled, originals_30min: r.originals_30min, avg_original_min: r.avg_original_min, last_original: r.last_original, follower_count: r.follower_count },
        };
        if (verdict !== "podcast_hr" || known.has(r.key)) continue;

        let slug = slugify(c.slug || c.display_name || r.name);
        if (!slug) continue;
        // Isti podcast pod drugim ID-em (unos bez channel_id, stari handle, kanal vs playlista)?
        const twin = findTwin(reg.podcasts, slug, c.display_name || r.name);
        if (twin) {
            const alt = { url: r.url, type: r.type, key: r.key, originals_30min: r.originals_30min, last_original: r.last_original, run: RUN };
            const alts = (twin.youtube_alternatives = twin.youtube_alternatives || []);
            if (!alts.some((a) => a.key === r.key)) alts.push(alt);
            // Postojeći unos je mrtav ili presuđen kao ne-podcast, a ovo je provjereni
            // podcast istog imena → to je njegov pravi izvor.
            if (["dead-url", "not-podcast"].includes(twin.metadata?.status) && twin.tracking?.enabled !== true) {
                twin.youtube = { ...(twin.youtube || {}), previous_url: twin.youtube?.url, url: r.url, type: r.type, channel_id: r.channel_id, ...(r.playlist_id ? { playlist_id: r.playlist_id } : {}) };
                twin.metadata = { ...(twin.metadata || {}), status: statusFrom(r.last_original), last_episode: ym(r.last_original) };
                merged.push(`${twin.slug} ⇐ ${r.url} (bio ${twin.youtube.previous_url || "?"}, zamijenjen)`);
            } else merged.push(`${twin.slug} ⇐ ${r.url} (zapisan kao alternativa)`);
            ledger[r.key].slug = twin.slug; ledger[r.key].merged_into = twin.slug;
            continue;
        }
        if (slugs.has(slug)) slug = `${slug}-${r.key.slice(-4).toLowerCase()}`;
        ledger[r.key].slug = slug;
        const entry = {
            slug, display_name: c.display_name || r.name,
            youtube: { url: r.url, channel_id: r.channel_id, type: r.type, ...(r.playlist_id ? { playlist_id: r.playlist_id, parent_channel: r.parent_channel } : {}) },
            tags: (c.tags || []).filter((t) => tagOk.has(t)).slice(0, 3),
            voditelji: c.hosts || [],
            metadata: {
                last_episode: ym(r.last_original), average_duration_minutes: r.avg_original_min,
                episodes_sampled: r.sampled, episodes_over_30min_sampled: r.originals_30min,
                subscribers: r.follower_count, status: statusFrom(r.last_original),
            },
            tracking: { enabled: false, reason_disabled: `Kandidat iz registry discovery prolaza ${RUN} — verificiran format (${r.originals_30min}/${r.sampled} originala ≥30 min), čeka editorial odluku o praćenju.`, candidate_phase: 1 },
            tier: 3, data_quality: "partial", sources: [source],
            discovery: { run: RUN, via: r.sources, queries: r.queries.slice(0, 5), classifier: c.classifier, reason: c.reason, derivative_ratio: r.derivative_ratio },
            notes: c.reason || "",
        };
        if (c.watch_rule && (c.watch_rule.exclude_title_regex || c.watch_rule.include_title_regex)) {
            rules[slug] = { ...c.watch_rule, from: `${source} (${c.classifier})` };
        }
        reg.podcasts.push(entry);
        slugs.add(slug); known.add(r.key);
        added.push(`${slug} (${r.type}, ${r.originals_30min} ep, zadnji ${r.last_original || "?"})`);
    }

    // Kanal koji objavljuje i uživo → watch mora čitati i /streams (inače ga vidi kao uspavanog).
    for (const r of triage) {
        const slug = ledger[r.key]?.verdict === "podcast_hr" && !ledger[r.key]?.merged_into ? ledger[r.key]?.slug : null;
        if (!slug || r.type !== "channel" || !r.streams_count || !r.channel_id) continue;
        const base = `https://www.youtube.com/channel/${r.channel_id}`;
        const rule = rules[slug] || (rules[slug] = { from: `${source} (streams)` });
        rule.source_url = rule.source_url || `${base}/videos`;
        const extra = new Set(rule.extra_source_urls || []);
        extra.add(`${base}/streams`);
        rule.extra_source_urls = [...extra];
    }

    // Statistika upita kroz prolaze: koliko kanala, koliko ih je završilo kao podcast_hr.
    for (const [q, pq] of Object.entries(perQuery)) {
        const s = qstats[q] || { cat: pq.cat, runs: [], channels_total: 0, accepted_total: 0 };
        if (s.runs.includes(RUN)) continue;
        const acc = pq.channels.filter((id) => ledger[id]?.verdict === "podcast_hr" && ledger[id]?.run === RUN).length;
        s.runs.push(RUN); s.channels_total += pq.channels.length; s.accepted_total += acc;
        s.last = { run: RUN, channels: pq.channels.length, accepted: acc };
        qstats[q] = s;
    }

    log(`📥 apply: +${added.length} u registry, ${merged.length} spojeno s postojećim; presude: ${JSON.stringify(judged)}`);
    for (const a of added) log(`   + ${a}`);
    for (const m of merged) log(`   ≈ ${m}`);
    if (DRY_RUN) { log("   (dry-run — ništa nije zapisano)"); return; }
    if (added.length) {
        reg.sources = [...new Set([...(reg.sources || []), source])];
        reg.generated_at = today();
        fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
    }
    writeJson(LEDGER, ledger);
    writeJson(QSTATS, qstats);
    writeJson(WATCH_RULES, rules);
    regenerateViews();
}

function levenshtein(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
}
const normName = (s) => slugify(s).replace(/\b(podcast|podkast|the|kanal)\b/g, "").replace(/[^a-z0-9]/g, "");

/** Postojeći unos istog imena: isti slug ili gotovo isto ime (≤1 slovo razlike za duža imena). */
function findTwin(podcasts, slug, name) {
    const a = normName(name), b = normName(slug);
    for (const p of podcasts) {
        if (p.slug === slug) return p;
        const n = normName(p.display_name), s = normName(p.slug);
        for (const x of [a, b]) for (const y of [n, s]) {
            if (x.length < 5 || y.length < 5) continue;
            if (x === y || (x.length >= 8 && levenshtein(x, y) <= 1)) return p;
        }
    }
    return null;
}

function regenerateViews() {
    for (const s of ["score_podcasts.js", "generate_registry_md.js", "generate_registry_csv.js"]) {
        const r = spawnSync("node", [path.join(ROOT, "data", s)], { cwd: ROOT, encoding: "utf8" });
        log(`   ${r.status === 0 ? "✓" : "✗"} data/${s}${r.status === 0 ? "" : ": " + (r.stderr || "").slice(0, 200)}`);
    }
}

// ─── activity (watch-state iz nightlyja → registry) ────────────────

function watchStatus(ch) {
    const vids = Object.values(ch.seen || {});
    const orig = vids.filter((v) => v.cls === "original");
    const last = orig.map((v) => v.upload_date).filter(Boolean).sort().pop() || null;
    return {
        checked_at: (ch.last_check || "").slice(0, 10),
        last_original_upload: last,
        originals_90d: orig.filter((v) => { const d = daysSince(v.upload_date); return d != null && d <= 90; }).length,
        new_originals_since_baseline: orig.filter((v) => !v.baseline).length,
        derivative_ratio: vids.length ? +(1 - orig.length / vids.length).toFixed(2) : null,
        min_duration_sec: ch.min_duration_sec || null,
        no_originals: vids.length >= 20 && !orig.length,
        error: ch.last_error || null,
    };
}

function cmdActivity() {
    const reg = readJson(REGISTRY);
    const st = readJson(WATCH_STATE, null);
    if (!st) throw new Error(`nema ${WATCH_STATE} — pokreni prvo automatic/watch_candidates.js`);
    const UPDATE = hasFlag("--update-status");
    let n = 0; const changes = [];
    for (const p of reg.podcasts) {
        const ch = st.channels[p.slug];
        if (!ch || p.tracking?.enabled === true) continue;
        const a = watchStatus(ch);
        p.activity = a; n++;
        if (UPDATE && !a.error && !a.no_originals && a.last_original_upload) {
            const s = statusFrom(a.last_original_upload);
            const cur = p.metadata?.status;
            if (["active", "active-slowing", "inactive", "unknown"].includes(cur || "unknown") && s !== cur) {
                changes.push(`${p.slug}: ${cur} → ${s}`);
                p.metadata = { ...(p.metadata || {}), status: s, last_episode: ym(a.last_original_upload) };
            }
        }
    }
    log(`📈 activity: ${n} unosa dobilo \`activity\`${UPDATE ? `, ${changes.length} promjena statusa` : ""}`);
    for (const c of changes) log(`   ~ ${c}`);
    if (DRY_RUN) return;
    fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
    regenerateViews();
}


// ─── revise-apply (revizija postojećih unosa → registry + watch pravila) ─
//
// Ulaz: JSON { "<slug>": { recommended_status, is_podcast, derivative_risk,
// last_original_upload, originals_90d, originals_365d, avg_original_min,
// watch_rule, fixes, evidence } } — izlaz revizijskog prolaza (LLM agent + yt-dlp).
// Kopija ulaza se sprema u data/discovery/revisions/<datum>.json pa je svaka
// promjena u registryju sljediva do presude koja ju je izazvala.

const REVISION_STATUS = { "active": "active", "active-slowing": "active-slowing", "inactive": "inactive", "not-a-podcast": "not-podcast", "dead-url": "dead-url" };
const FROZEN_STATUSES = new Set(["archive", "completed"]);

function cmdReviseApply() {
    const file = getArg("--file");
    if (!file) throw new Error("revise-apply treba --file <revisions.json>");
    const rev = readJson(path.resolve(file));
    const reg = readJson(REGISTRY);
    const rules = readJson(WATCH_RULES, {});
    const bySlug = Object.fromEntries(reg.podcasts.map((p) => [p.slug, p]));
    const stamp = getArg("--label") || RUN;
    const changes = { status: [], url: [], rules: 0, flagged: [] };

    for (const [slug, v] of Object.entries(rev)) {
        const p = bySlug[slug];
        if (!p) { log(`   ? ${slug} nije u registryju`); continue; }
        const f = v.fixes || {};
        const notes = [f.WARNING, f.NOTE].filter(Boolean);
        p.revision = {
            date: stamp, recommended_status: v.recommended_status, is_podcast: v.is_podcast,
            derivative_risk: v.derivative_risk, last_original_upload: v.last_original_upload || null,
            originals_90d: v.originals_90d ?? null, originals_365d: v.originals_365d ?? null,
            avg_original_min: v.avg_original_min ?? null,
            ...(notes.length ? { notes } : {}),
            evidence: (v.evidence || "").slice(0, 400),
        };
        p.metadata = p.metadata || {};
        const cur = p.metadata.status;
        let next = REVISION_STATUS[v.recommended_status] || cur;
        if (f.WARNING) { next = "disputed"; changes.flagged.push(`${slug}: ${f.WARNING.slice(0, 120)}`); }
        if (!FROZEN_STATUSES.has(cur) && next && next !== cur) {
            changes.status.push(`${slug}: ${cur} → ${next}`);
            p.metadata.status = next;
        }
        if (v.last_original_upload) p.metadata.last_episode = v.last_original_upload.slice(0, 7);
        if (v.avg_original_min) p.metadata.average_duration_minutes = v.avg_original_min;

        const url = f["youtube.url"];
        if (url && /^https:\/\//.test(url) && url !== p.youtube?.url) {
            changes.url.push(`${slug}: ${p.youtube?.url} → ${url}`);
            p.youtube = { ...(p.youtube || {}), previous_url: p.youtube?.url, url };
            const pl = playlistId(url);
            if (pl) p.youtube.playlist_id = pl;
        }
        if (f["youtube.type"]) p.youtube.type = f["youtube.type"];
        if (f["youtube.channel_id"]) p.youtube.channel_id = f["youtube.channel_id"];
        if (f.display_name && f.display_name !== p.display_name) { p.previous_display_name = p.display_name; p.display_name = f.display_name; }

        const w = v.watch_rule;
        if (w && w.source_url) {
            rules[slug] = {
                source_url: w.source_url,
                ...(w.extra_source_urls?.length ? { extra_source_urls: w.extra_source_urls } : {}),
                ...(w.min_duration_sec ? { min_duration_sec: w.min_duration_sec } : {}),
                ...(w.exclude_title_regex ? { exclude_title_regex: w.exclude_title_regex } : {}),
                ...(w.include_title_regex ? { include_title_regex: w.include_title_regex } : {}),
                ...(w.notes ? { notes: w.notes } : {}),
                from: `revision ${stamp}`,
                ...(v.rule_check ? { check: { sample: v.rule_check.sample, originals: v.rule_check.originals, derivatives: v.rule_check.derivatives } } : {}),
            };
            changes.rules++;
        }
    }
    const c = {};
    for (const p of reg.podcasts) if (p.tracking?.enabled !== true) c[p.metadata?.status || "?"] = (c[p.metadata?.status || "?"] || 0) + 1;
    log(`🩺 revise-apply: ${changes.status.length} promjena statusa, ${changes.url.length} URL-ova, ${changes.rules} watch pravila, ${changes.flagged.length} označeno kao disputed`);
    for (const x of [...changes.url, ...changes.flagged]) log(`   ~ ${x}`);
    log(`   nepraćeni po statusu nakon revizije: ${JSON.stringify(c)}`);
    if (DRY_RUN) { log("   (dry-run — ništa nije zapisano)"); return; }
    writeJson(path.join(DIR, "revisions", `${stamp}.json`), rev);
    reg.generated_at = today();
    fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
    writeJson(WATCH_RULES, rules);
    regenerateViews();
}


// ─── ledger-import (presude drugih prolaza/agenata → ledger) ───────
//
// Za odbijene kandidate s razlogom (npr. web/rejected.json): presuda se izvodi iz
// teksta razloga. Ne prepisuje postojeće presude u ledgeru.

function verdictFromReason(reason) {
    const r = (reason || "").toLowerCase();
    if (/srpsk|bosansk|bošnj|slovensk|crnogor|makedon|engleski|english|ćirilic|regionaln|strani jezik/.test(r)) return "not_hr";
    if (/institucional|tv\/medij|tv kanal|medijsk/.test(r)) return "institutional";
    if (/već u registryju|duplikat|re-?upload|re-?publikacij|podskup/.test(r)) return "institutional";
    if (/premalo|prekratk|isječ|kratk|nije podcast|ne prolazi triage|radio drama|audio ?knjig|ai-sinkroniz|generiran|propovij|misa|predavanj|vijesti|glazb|trailer|vlog|gameplay|tutorial/.test(r)) return "not_podcast";
    return "uncertain";
}

function cmdLedgerImport() {
    const file = getArg("--file");
    const by = getArg("--by") || "import";
    if (!file) throw new Error("ledger-import treba --file <rejected.json>");
    const raw = readJson(path.resolve(file));
    const list = Array.isArray(raw) ? raw : raw.rejected || [];
    const ledger = readJson(LEDGER, {});
    const c = {};
    let added = 0;
    for (const x of list) {
        const key = x.playlist_id || x.channel_id;
        if (!key || ledger[key]) continue;
        const verdict = x.verdict && VERDICTS[x.verdict] ? x.verdict : verdictFromReason(x.reason);
        ledger[key] = { name: x.title || x.name || x.display_name, url: x.url || x.youtube_url, type: x.playlist_id ? "playlist" : "channel", verdict, reason: x.reason, judged_at: today(), run: RUN, by, ...(x.channel || x.parent ? { parent_channel: x.channel || x.parent } : {}) };
        c[verdict] = (c[verdict] || 0) + 1; added++;
    }
    log(`📒 ledger-import: +${added} presuda iz ${file} ${JSON.stringify(c)}`);
    if (!DRY_RUN) writeJson(LEDGER, ledger);
}


// ─── exact-dates (točan datum zadnjeg originala) ───────────────────
//
// Flat liste daju približne datume („prije 3 godine" → danas − 3 god.), pa je
// Big Podcast (zadnja epizoda 14.12.2022.) ispao kao 2023-09. Status aktivno/
// uspavano ovisi o tom datumu, zato za svaki nepraćeni unos jedan ne-flat poziv
// na najnoviji original iz watch-statea. Rezultat: metadata.last_episode_date.
// Ponavlja se samo za unose čiji je najnoviji original promijenjen.

async function cmdExactDates() {
    const reg = readJson(REGISTRY);
    const st = readJson(WATCH_STATE, null);
    if (!st) throw new Error(`nema ${WATCH_STATE} — pokreni prvo automatic/watch_candidates.js`);
    const jobs = [];
    for (const p of reg.podcasts) {
        if (p.tracking?.enabled === true) continue;
        const ch = st.channels[p.slug];
        if (!ch) continue;
        const orig = Object.entries(ch.seen).filter(([, v]) => v.cls === "original");
        if (!orig.length) continue;
        const maxApprox = orig.map(([, v]) => v.upload_date || "").sort().pop();
        const [id] = orig.find(([, v]) => (v.upload_date || "") === maxApprox);   // prvi u redoslijedu liste = najnoviji
        // Snimke livestreamova (/streams) u flat listi nemaju ni približni datum — uzmi i
        // prva dva takva, pa pobjeđuje najnoviji točan datum.
        const ids = [id, ...orig.filter(([, v]) => !v.upload_date).slice(0, 2).map(([k]) => k)].filter((x, i, a) => a.indexOf(x) === i);
        if (p.metadata?.last_episode_video && ids.includes(p.metadata.last_episode_video) && p.metadata?.last_episode_date && !p.metadata?.last_episode_date_approx && !hasFlag("--all")) continue;
        jobs.push({ p, ids, approx: maxApprox || null, approxId: id });
    }
    log(`📅 exact-dates: ${jobs.length} unosa`);
    const changes = [];
    let failed = 0, antiBot = 0;
    await pool(jobs, CONCURRENCY, async ({ p, ids, approx, approxId }) => {
        let d = null, id = null, exact = true;
        for (const x of ids) {
            if (antiBot >= 5) break;                              // YouTube nas je označio — ne tuci dalje
            const r = await runYtdlp(["--skip-download", "--no-warnings", "--print", "%(upload_date)s", `https://youtu.be/${x}`], 60000);
            const v = r.out.trim();
            if (/^\d{8}$/.test(v)) { if (!d || v > d) { d = v; id = x; } }
            else if (/not a bot/i.test(r.err)) antiBot++;
        }
        const known = (p.metadata?.last_episode_date || "").replace(/-/g, "");
        if (!d) {
            failed++;
            // Bez točnog datuma: približni vrijedi samo ako je NOVIJI od zapisanog (inače bi
            // „prije 3 godine" pregazio točan datum).
            if (!approx || approx <= known) return;
            d = approx; id = approxId; exact = false;
        }
        const prevStatus = p.metadata?.status;
        p.metadata = { ...(p.metadata || {}), last_episode: ym(d), last_episode_date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, last_episode_video: id };
        if (exact) delete p.metadata.last_episode_date_approx; else p.metadata.last_episode_date_approx = true;
        if (["active", "active-slowing", "inactive", "unknown"].includes(prevStatus || "unknown")) {
            const next = statusFrom(d);
            if (next !== prevStatus) { p.metadata.status = next; changes.push(`${p.slug}: ${prevStatus} → ${next} (${p.metadata.last_episode_date})`); }
        }
    });
    log(`   ${changes.length} promjena statusa, ${failed} bez točnog datuma${antiBot ? ` (⚠️  ${antiBot}× YouTube anti-bot — ponovi kasnije ili kroz --proxy/--via-iphone)` : ""}`);
    for (const c of changes) log(`   ~ ${c}`);
    if (DRY_RUN) return;
    fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
    regenerateViews();
}

// ─── main ──────────────────────────────────────────────────────────

async function main() {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    switch (CMD) {
        case "sweep": return cmdSweep();
        case "seed": return cmdSeed();
        case "podcasts-tab": return cmdPodcastsTab();
        case "ledger-import": return cmdLedgerImport();
        case "aggregate": return cmdAggregate();
        case "probe": return cmdProbe();
        case "triage": return cmdTriage();
        case "classify": return cmdClassify();
        case "apply": return cmdApply();
        case "activity": return cmdActivity();
        case "exact-dates": return cmdExactDates();
        case "revise-apply": return cmdReviseApply();
        case "all":
            await cmdSweep(); await cmdPodcastsTab(); cmdAggregate(); await cmdProbe(); cmdTriage(); cmdClassify();
            if (hasFlag("--apply")) cmdApply();
            else log(`\n👉 Pregledaj runs/${RUN}/classification.json pa: node data/discovery/discover.js apply --run ${RUN}`);
            return;
        default:
            console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]);
            process.exit(CMD ? 1 : 0);
    }
}

if (require.main === module) main().catch((e) => { console.error("❌", e.message); process.exit(1); });
module.exports = { findTwin, verdictFromReason, autoVerdict, metricsFor, slugify, statusFrom, ledgerBlocks, knownKeys, parseJsonArray };
