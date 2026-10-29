#!/usr/bin/env node
/**
 * select_reels.js — KORAK 9.9: kandidati za reels / shorts iz gotove epizode.
 *
 * Jedan LLM poziv po epizodi nad {base}.segments.jsonl (1 red = 1 cue kanonskog SRT-a
 * s imenom govornika, KORAK 9) → {base}.reels.json: rangirani trenuci od 30–90 s koji
 * stoje sami za sebe (priča, uvid, emocija, humor, kontroverza), s naslovom, hookom i
 * karticama za animaciju.
 *
 * Model vraća REDNE BROJEVE cue-ova (seq), ne vremena — vrijeme se uzima iz segmenata,
 * pa svaki reel počinje i završava točno na granici cue-a i nema izmišljenih timestampova.
 *
 * Kartice (`cards`) su podaci, ne dizajn: tip + trenutak + tekst. Generator HyperFrames
 * kompozicije i branding kanala (tools/hyperframes_reel/, data/branding/) ih tek čitaju.
 * Vidi docs/2026-10-25-reels-kandidati.md.
 *
 * Backend prati korake 7+8 (GEMINI_BACKEND): `claude` = `claude -p` pod pretplatom
 * (nightly, Opus), `vertex` = Gemini na Vertexu (bimbo-sync-prod) — DEPRECATED od 29.10.2026., ne radi.
 *
 * Idempotentno: preskače epizodu čiji reels.json je noviji od segments.jsonl.
 * Doseg: bez --video-id/--channel samo epizode objavljene u zadnjih --since-days dana
 * (default 21), najnovije prve, najviše --max-episodes (default 20). Katalog se NE
 * backfilla sam od sebe — to je odluka, ne nuspojava nightlyja.
 *
 * Upotreba:
 *   node select_reels.js --video-id f2HIRJPHHK4
 *   node select_reels.js --video-id f2HIRJPHHK4 --force --count 8
 *   node select_reels.js --channel muzevni_budite --since-days 0 --dry-run
 *   GEMINI_BACKEND=vertex node select_reels.js --video-id DOfcONrRyDY   # DEPRECATED, ruši se
 *
 * Zastavice:
 *   --input-dir <dir>    korijen kanala (default storage/output)
 *   --channel <ime>      samo jedan kanal
 *   --video-id <id>      samo jedna epizoda (ignorira --since-days)
 *   --since-days <n>     samo epizode s upload_date unutar n dana; 0 = bez ograničenja
 *   --max-episodes <n>   najviše n LLM poziva po runu
 *   --count <n>          koliko kandidata tražiti (default 8)
 *   --force              prepiši postojeći reels.json
 *   --dry-run            samo popis kandidata i procjena tokena
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { vertexEndpointUrl, vertexAccessToken, vertexEnabled, VERTEX_DISABLED_MSG } = require("./lib/vertex_auth");
const { claudeWindowClosed, claudeWindowReason } = require("./lib/claude_window");

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const INPUT_DIR = getArg("--input-dir") || path.join(__dirname, "storage", "output");
const ONLY_CHANNEL = getArg("--channel");
const ONLY_VIDEO = getArg("--video-id");
const SINCE_DAYS = parseInt(getArg("--since-days") || "21", 10);
const MAX_EPISODES = parseInt(getArg("--max-episodes") || "20", 10);
const COUNT = parseInt(getArg("--count") || "8", 10);
const FORCE = args.includes("--force");
const DRY_RUN = args.includes("--dry-run");

const SEG_SUFFIX = ".segments.jsonl";
const OUT_SUFFIX = ".reels.json";
const SCHEMA_VERSION = 1;
const MIN_REEL_SEC = 25;
const MAX_REEL_SEC = 100;
const MIN_EPISODE_SEC = 8 * 60;   // kraće epizode su već same po sebi isječak

// ─── konfiguracija (gemini.conf, env ima prednost) ─────────────────
function loadConf() {
    const conf = {};
    try {
        for (const line of fs.readFileSync(path.join(__dirname, "gemini.conf"), "utf8").split("\n")) {
            const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
            if (m) conf[m[1]] = m[2];
        }
    } catch (_) {}
    return conf;
}
const CONF = loadConf();
// Bez GEMINI_BACKEND ide `claude` (Opus, pretplata). `vertex` je DEPRECATED od 29.10.2026.
// (lib/vertex_auth.js) i ruši se odmah ispod; grana ostaje u sourceu, ne brisati.
const BACKEND = (process.env.GEMINI_BACKEND || (vertexEnabled() ? "vertex" : "claude")).toLowerCase();
if (BACKEND === "vertex" && !vertexEnabled()) {
    console.error(`❌ ${VERTEX_DISABLED_MSG} (GEMINI_BACKEND=vertex). Koristi claude ili agy.`);
    process.exit(1);
}
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || CONF.VERTEX_PROJECT || "bimbo-sync-prod";
const VERTEX_ACCOUNT = process.env.VERTEX_ACCOUNT || CONF.VERTEX_ACCOUNT;
const VERTEX_REGIONS = (process.env.VERTEX_REGIONS || CONF.VERTEX_REGIONS || "global").split(",").map(s => s.trim()).filter(Boolean);
const GEMINI_MODEL = process.env.GEMINI_MODEL || CONF.GEMINI_MODEL || "gemini-3.8-flash";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || CONF.CLAUDE_MODEL || "opus";
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || CONF.CLAUDE_EFFORT || "high";
const CLAUDE_CWD = path.join(os.tmpdir(), "domovina_claude_cli");

if (!["claude", "vertex"].includes(BACKEND)) {
    console.error(`❌ select_reels.js podržava GEMINI_BACKEND=claude|vertex (zadano: ${BACKEND})`);
    process.exit(2);
}

// ─── pomoćne ───────────────────────────────────────────────────────
function extractVideoId(filename) {
    // Zadnji _yt_ — naslovi znaju sadržavati "_yt_". Lookahead da se pogoci ne „pojedu"
    // (bez njega „_yt_naslov_yt_ID" vrati „naslov_yt_X").
    const all = [...filename.matchAll(/(?=_yt_([A-Za-z0-9_-]{11}))/g)];
    return all.length ? all[all.length - 1][1] : null;
}

function fmtTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = String(m).padStart(2, "0"), ss = String(r).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function listChannels() {
    return fs.readdirSync(INPUT_DIR, { withFileTypes: true })
        .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
        .map(e => e.name)
        .filter(n => !ONLY_CHANNEL || n === ONLY_CHANNEL);
}

function findEpisodes() {
    const out = [];
    for (const ch of listChannels()) {
        const dir = path.join(INPUT_DIR, ch);
        let files;
        try { files = fs.readdirSync(dir); } catch (_) { continue; }
        for (const f of files) {
            if (!f.endsWith(SEG_SUFFIX)) continue;
            const vid = extractVideoId(f);
            if (!vid || (ONLY_VIDEO && vid !== ONLY_VIDEO)) continue;
            const base = f.slice(0, -SEG_SUFFIX.length);
            out.push({ channel: ch, dir, base, vid, segPath: path.join(dir, f), outPath: path.join(dir, base + OUT_SUFFIX) });
        }
    }
    return dropUnlistedDuplicates(out);
}

// Ista epizoda u kanalu i u `_unlisted` (auto_reuse_adhoc.js) → kanalska pobjeđuje, inače
// bi ista epizoda dobila dva LLM poziva (ep. 7 re:DEFINICIJE, 25.10.2026.).
function dropUnlistedDuplicates(eps) {
    const inChannel = new Set(eps.filter(e => e.channel !== "_unlisted").map(e => e.vid));
    return eps.filter(e => e.channel !== "_unlisted" || !inChannel.has(e.vid));
}

function readSegments(p) {
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; } }

function episodeContext(ep) {
    const info = readJson(path.join(ep.dir, ep.base + ".info.json")) || {};
    const summ = (readJson(path.join(ep.dir, ep.base + ".wav.canary.summary.json")) || {}).summary || {};
    const speakers = (summ.speakers || []).map(s => `${s.suggested_name || s.id} (${s.role || "?"})`).join(", ");
    return {
        title: summ.title_hr || info.title || ep.base,
        channel: info.channel || ep.channel,
        abstract: summ.abstract_hr || "",
        topics: (summ.key_topics || []).join(", "),
        speakers,
    };
}

// ─── prompt ────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Ti si urednik kratkih videa (Instagram Reels, TikTok, YouTube Shorts) za hrvatske podcaste.
Iz prijepisa epizode biraš trenutke koji kao samostalan vertikalni video od 30 do 90 sekundi
zadrže gledatelja koji NIJE gledao epizodu.

Dobar trenutak:
- stoji sam za sebe: razumljiv bez prethodnog konteksta, ima početak i kraj (zaokružena misao, priča s poantom);
- prvih 3 s već nose udicu (konkretna tvrdnja, neočekivan obrat, pitanje, slika);
- konkretan je (događaj, brojka, ime, mjesto, izreka) radije nego općenit;
- ima emociju, humor, iznenađenje, jasan uvid ili praktičan savjet;
- najčešće ga izgovara jedan govornik; kratko pitanje voditelja na početku je u redu.

Izbjegavaj: uvod i odjavu emisije, sponzorske poruke, najave, dijelove koji se oslanjaju na
„kao što sam rekao", tehničke prekide, trenutke gdje se priča prekida usred misli.

Granice biraš po rednom broju cue-a [seq] iz prijepisa: start_seq je prvi cue reela, end_seq zadnji.
Reel počinje na početku rečenice i završava kad je misao zaokružena — ne ranije.
Trenuci se ne smiju preklapati.

Za svaki trenutak predloži i kartice za animirani reel (tekst preko videa, jedna po jedna):
- "hook": 0–3 s, do 60 znakova, vlastita udica (ne doslovni citat);
- "lower_third": ime i kratka uloga govornika kad prvi put progovori;
- "context": jedna rečenica konteksta koja gledatelju fali (gdje, kada, tko);
- "quote": najjača rečenica doslovno iz prijepisa (može se skratiti, ne mijenjati);
- "number" / "pin": brojka ili mjesto koje se spominje (uz polje "value");
- "end": završna kartica (naslov epizode).
Svaka kartica ima "at_seq" (cue na kojem se pojavljuje) i "anchor": 2–5 riječi doslovno prepisanih
iz tog cue-a na kojima kartica treba izaći (npr. kad govornik izgovori ime mjesta ili brojku).
Hook i lower_third idu na početak i ne trebaju anchor. Kartice slijede tijek priče i ne izlaze
sve odjednom. Ne izmišljaj činjenice koje nisu u prijepisu.

Piši na hrvatskom. Vrati ISKLJUČIVO JSON objekt, bez markdowna:
{"reels":[{"start_seq":int,"end_seq":int,"title":"do 70 znakova","hook":"do 60 znakova",
"why":"1–2 rečenice zašto radi","kind":"story|insight|emotion|humor|controversy|practical|faith",
"score":1-10,"speaker":"ime glavnog govornika","quote":"doslovna rečenica",
"cards":[{"type":"hook|lower_third|context|quote|number|pin|end","at_seq":int,"anchor":"doslovne riječi","text":"...","value":"opcionalno"}]}]}`;

function buildUserMessage(ctx, segs) {
    const lines = segs.map(s => `[${s.seq}] ${fmtTime(s.start_sec)} ${s.speaker || s.speaker_id || "?"}: ${s.text}`);
    const total = segs.length ? segs[segs.length - 1].end_sec : 0;
    return [
        `Kanal: ${ctx.channel}`,
        `Epizoda: ${ctx.title}`,
        `Trajanje: ${fmtTime(total)}`,
        ctx.speakers ? `Govornici: ${ctx.speakers}` : "",
        ctx.abstract ? `Sažetak: ${ctx.abstract}` : "",
        ctx.topics ? `Teme: ${ctx.topics}` : "",
        "",
        `Predloži do ${COUNT} najboljih trenutaka, od najboljeg prema slabijem. Radije manje nego slabe.`,
        "",
        "PRIJEPIS ([seq] vrijeme govornik: tekst):",
        ...lines,
    ].filter(l => l !== null).join("\n");
}

// ─── LLM pozivi ────────────────────────────────────────────────────
// Kritični flagovi isti kao u summarize_gemini.js: --tools "" (overhead), neutralni cwd
// (inače se učita CLAUDE.md repoa), NIKAD --bare (prebacuje na per-token API).
function callClaude(system, user) {
    return new Promise((resolve, reject) => {
        try { fs.mkdirSync(CLAUDE_CWD, { recursive: true }); } catch (_) {}
        const proc = spawn("claude", [
            "-p", "--model", CLAUDE_MODEL, "--effort", CLAUDE_EFFORT,
            "--output-format", "json", "--setting-sources", "", "--strict-mcp-config",
            "--max-turns", "1", "--tools", "", "--system-prompt", system,
        ], { stdio: ["pipe", "pipe", "pipe"], cwd: CLAUDE_CWD });
        let stdout = "", stderr = "";
        proc.stdout.on("data", d => { stdout += d; });
        proc.stderr.on("data", d => { stderr += d; });
        proc.on("error", err => reject(new Error(`claude CLI spawn: ${err.message}`)));
        proc.on("close", code => {
            if (code !== 0) return reject(new Error(`claude CLI exit ${code}: ${(stderr || stdout).slice(0, 400)}`));
            let env;
            try { env = JSON.parse(stdout); } catch (_) { return reject(new Error(`claude CLI nije vratio JSON: ${stdout.slice(0, 300)}`)); }
            if (env.is_error || env.subtype !== "success") return reject(new Error(`claude CLI greška: ${String(env.result || "").slice(0, 300)}`));
            const u = env.usage || {};
            resolve({
                text: env.result || "",
                model: `claude-code:${CLAUDE_MODEL}`,
                usage: {
                    input_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
                    output_tokens: u.output_tokens || 0,
                },
                cost_usd: typeof env.total_cost_usd === "number" ? env.total_cost_usd : null,
            });
        });
        proc.stdin.write(user);
        proc.stdin.end();
    });
}

// ⚠️ DEPRECATED (29.10.2026.) — Vertex AI se ne koristi (lib/vertex_auth.js: vertexEnabled() je
// uvijek false, token se ne izdaje). Ostaje u sourceu kao zapis stare implementacije, ne
// brisati. Obično LLM zaključivanje je ograničeno izlaznim tokenima; agy/Claude Code su
// asistenti koji sami spoje 1..M poziva u upotrebljiv JSON.
let vertexToken = null, vertexTokenAt = 0, regionIdx = 0;
async function callVertex(system, user) {
    const price = { in: parseFloat(CONF.GEMINI_PRICE_IN || "0.75"), out: parseFloat(CONF.GEMINI_PRICE_OUT || "3.75") };
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
        if (!vertexToken || Date.now() - vertexTokenAt > 50 * 60 * 1000) {
            vertexToken = vertexAccessToken({ account: VERTEX_ACCOUNT });
            vertexTokenAt = Date.now();
        }
        const region = VERTEX_REGIONS[regionIdx++ % VERTEX_REGIONS.length];
        const res = await fetch(vertexEndpointUrl(VERTEX_PROJECT, region, GEMINI_MODEL), {
            method: "POST",
            headers: { Authorization: `Bearer ${vertexToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: [{ role: "user", parts: [{ text: user }] }],
                generationConfig: { temperature: 0.4, maxOutputTokens: 32768, responseMimeType: "application/json" },
            }),
        });
        if (res.status === 429 || res.status >= 500) {
            lastErr = new Error(`Vertex ${region} HTTP ${res.status}`);
            await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
            continue;
        }
        const body = await res.json();
        if (!res.ok) throw new Error(`Vertex ${region} HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
        const cand = (body.candidates || [])[0] || {};
        const text = ((cand.content || {}).parts || []).map(p => p.text || "").join("");
        const um = body.usageMetadata || {};
        const inTok = um.promptTokenCount || 0, outTok = (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0);
        return {
            text,
            model: GEMINI_MODEL,
            usage: { input_tokens: inTok, output_tokens: outTok },
            cost_usd: Math.round((inTok * price.in + outTok * price.out) / 1e6 * 1e6) / 1e6,
        };
    }
    throw lastErr;
}

function parseJsonLoose(text) {
    const t = String(text).replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a === -1 || b <= a) throw new Error("odgovor nema JSON objekt");
    return JSON.parse(t.slice(a, b + 1));
}

// ─── validacija i lijepljenje na cue-ove ───────────────────────────
// {base}.words.json (KORAK 9.87) ima cue-ove 1:1 sa segments.jsonl i vrijeme svake riječi
// (tokeni = text.split(/\s+/)). Kartica se tako sidri na riječ, a ne na početak cue-a koji
// zna trajati 15 s. Bez words.json kartica ostaje na početku cue-a.
function normTok(t) {
    return String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

function anchorSec(words, segs, seq, anchor) {
    const idx = segs.findIndex(s => s.seq === seq);
    const cue = words && words.cues && words.cues[idx];
    const seg = segs[idx];
    if (!cue || !anchor || !seg) return null;
    const toks = seg.text.split(/\s+/).filter(Boolean).map(normTok);
    if (toks.length * 2 !== cue.w.length) return null;
    const want = String(anchor).split(/\s+/).map(normTok).filter(Boolean);
    if (!want.length) return null;
    for (let i = 0; i + want.length <= toks.length; i++) {
        if (want.every((w, k) => toks[i + k] === w)) return cue.w[2 * i] / 1000;
    }
    // Djelomično: prva riječi sidra
    const j = toks.indexOf(want[0]);
    return j >= 0 ? cue.w[2 * j] / 1000 : null;
}

function normalizeReels(raw, segs, words = null) {
    const bySeq = new Map(segs.map(s => [s.seq, s]));
    const rejected = [];
    const ok = [];
    for (const r of (raw && raw.reels) || []) {
        const a = bySeq.get(r.start_seq), b = bySeq.get(r.end_seq);
        if (!a || !b || r.end_seq < r.start_seq) { rejected.push({ title: r.title, reason: "nepostojeći seq" }); continue; }
        const dur = b.end_sec - a.start_sec;
        if (dur < MIN_REEL_SEC || dur > MAX_REEL_SEC) { rejected.push({ title: r.title, reason: `trajanje ${dur.toFixed(1)} s` }); continue; }
        const inRange = segs.filter(s => s.seq >= r.start_seq && s.seq <= r.end_seq);
        const cards = (r.cards || [])
            .filter(c => c && c.type && bySeq.has(c.at_seq))
            .map(c => {
                const anchored = anchorSec(words, segs, c.at_seq, c.anchor);
                const at = Math.min(b.end_sec, Math.max(a.start_sec, anchored != null ? anchored : bySeq.get(c.at_seq).start_sec));
                const card = { type: c.type, at_sec: +(at - a.start_sec).toFixed(2), text: c.text || "" };
                card.anchor = c.anchor || null;
                card.anchored = anchored != null;
                if (c.value) card.value = c.value;
                return card;
            })
            .sort((x, y) => x.at_sec - y.at_sec);
        ok.push({
            start_sec: a.start_sec,
            end_sec: b.end_sec,
            duration_sec: +dur.toFixed(2),
            start_seq: r.start_seq,
            end_seq: r.end_seq,
            title: r.title || "",
            hook: r.hook || "",
            why: r.why || "",
            kind: r.kind || "",
            score: Number(r.score) || 0,
            speaker: r.speaker || a.speaker || "",
            speakers: [...new Set(inRange.map(s => s.speaker || s.speaker_id))],
            quote: r.quote || "",
            cards,
        });
    }
    // Preklapanja: zadrži bolje ocijenjen trenutak
    ok.sort((x, y) => y.score - x.score);
    const kept = [];
    for (const r of ok) {
        const clash = kept.find(k => Math.min(k.end_sec, r.end_sec) - Math.max(k.start_sec, r.start_sec) > 0);
        if (clash) { rejected.push({ title: r.title, reason: `preklapa se s „${clash.title}"` }); continue; }
        kept.push(r);
    }
    kept.forEach((r, i) => { r.rank = i + 1; });
    return { reels: kept.map(r => ({ rank: r.rank, ...r })), rejected };
}

// Ponovni izbor ne smije pregaziti izrenderirane reelove: mp4 na CDN-u i lokalno je izrezan
// iz TOG raspona, a domovina.ai ih prikazuje kao markere. Izrenderirani ostaju kakvi jesu
// (s rangom), novi kandidati koji se s njima preklapaju idu u rejected, ostali popunjavaju
// slobodne rangove. 25.10. je reprocess ep. 1–4 ovako izgubio render{} (CDN ostao na starom).
function keepRendered(prev, reels, rejected, count) {
    const done = ((prev && prev.reels) || []).filter(r => r.render && (r.render.file || r.render.url));
    if (!done.length) return { reels, rejected };
    const fresh = [];
    for (const r of reels) {
        const clash = done.find(k => Math.min(k.end_sec, r.end_sec) - Math.max(k.start_sec, r.start_sec) > 0);
        if (clash) rejected.push({ title: r.title, reason: `preklapa se s izrenderiranim „${clash.title}"` });
        else fresh.push(r);
    }
    const used = new Set(done.map(r => r.rank));
    let rank = 1;
    const out = [...done];
    for (const r of fresh.slice(0, Math.max(0, count - done.length))) {
        while (used.has(rank)) rank++;
        used.add(rank);
        out.push({ ...r, rank });
    }
    return { reels: out.sort((a, b) => a.rank - b.rank), rejected };
}

// ─── glavni tok ────────────────────────────────────────────────────
function isStale(ep) {
    if (FORCE || !fs.existsSync(ep.outPath)) return true;
    return fs.statSync(ep.outPath).mtimeMs < fs.statSync(ep.segPath).mtimeMs;
}

function withinWindow(segs) {
    if (ONLY_VIDEO || SINCE_DAYS <= 0) return true;
    const d = segs[0] && segs[0].upload_date;
    if (!d) return false;
    return (Date.now() - Date.parse(d)) / 86400000 <= SINCE_DAYS;
}

async function main() {
    console.log(`🎬 select_reels.js — backend=${BACKEND} (${BACKEND === "claude" ? CLAUDE_MODEL : GEMINI_MODEL}), count=${COUNT}` +
        (ONLY_VIDEO ? `, video=${ONLY_VIDEO}` : `, since-days=${SINCE_DAYS}, max=${MAX_EPISODES}`));

    const todo = [];
    let fresh = 0, tooShort = 0, outside = 0;
    for (const ep of findEpisodes()) {
        if (!isStale(ep)) { fresh++; continue; }
        const segs = readSegments(ep.segPath);
        if (!withinWindow(segs)) { outside++; continue; }
        const total = segs.length ? segs[segs.length - 1].end_sec : 0;
        if (total < MIN_EPISODE_SEC) { tooShort++; continue; }
        todo.push({ ...ep, segs, uploadDate: (segs[0] && segs[0].upload_date) || "" });
    }
    todo.sort((x, y) => y.uploadDate.localeCompare(x.uploadDate));
    const batch = todo.slice(0, MAX_EPISODES);

    console.log(`   kandidata: ${todo.length} (u ovom runu ${batch.length}) | svježih: ${fresh} | izvan prozora: ${outside} | prekratkih: ${tooShort}`);

    let done = 0, failed = 0, deferred = 0;
    for (const ep of batch) {
        const ctx = episodeContext(ep);
        const user = buildUserMessage(ctx, ep.segs);
        const estTok = Math.round((SYSTEM_PROMPT.length + user.length) / 3.5);
        console.log(`\n▶ ${ep.channel}/${ep.vid} — ${ctx.title}\n   ${ep.segs.length} cue-ova, ~${estTok.toLocaleString("hr")} input tokena`);
        if (DRY_RUN) continue;

        if (BACKEND === "claude" && claudeWindowClosed()) {
            console.log(`   ⏸️  [ODGOĐENO] ${claudeWindowReason()}`);
            deferred++;
            continue;
        }

        try {
            const t0 = Date.now();
            const res = BACKEND === "claude" ? await callClaude(SYSTEM_PROMPT, user) : await callVertex(SYSTEM_PROMPT, user);
            const words = readJson(path.join(ep.dir, ep.base + ".words.json"));
            const norm = normalizeReels(parseJsonLoose(res.text), ep.segs, words);
            const { reels, rejected } = keepRendered(readJson(ep.outPath), norm.reels, norm.rejected, COUNT);
            const doc = {
                version: SCHEMA_VERSION,
                video_id: ep.vid,
                channel: ep.channel,
                title: ctx.title,
                generated_at: new Date().toISOString(),
                model: res.model,
                source: path.basename(ep.segPath),
                word_timing: words ? (words.source || "words.json") : null,
                llm: { ...res.usage, cost_usd: res.cost_usd, seconds: Math.round((Date.now() - t0) / 1000) },
                reels,
                rejected,
            };
            fs.writeFileSync(ep.outPath, JSON.stringify(doc, null, 2) + "\n");
            done++;
            console.log(`   ✅ ${reels.length} reelova (odbačeno ${rejected.length}), ${doc.llm.seconds} s → ${path.basename(ep.outPath)}`);
            for (const r of reels) {
                console.log(`      #${r.rank} [${r.score}] ${fmtTime(r.start_sec)}–${fmtTime(r.end_sec)} (${Math.round(r.duration_sec)} s) ${r.title}`);
            }
        } catch (err) {
            failed++;
            console.log(`   ❌ ${err.message}`);
        }
    }

    console.log(`\n📊 select_reels: gotovo ${done}, grešaka ${failed}, odgođeno ${deferred}${DRY_RUN ? " (dry-run)" : ""}`);
    if (failed && !done) process.exit(1);
}

if (require.main === module) {
    main().catch(err => { console.error(`❌ ${err.stack || err.message}`); process.exit(1); });
}

module.exports = { dropUnlistedDuplicates, normalizeReels, keepRendered, parseJsonLoose, buildUserMessage, extractVideoId, anchorSec, normTok };
