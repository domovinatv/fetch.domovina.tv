#!/usr/bin/env node
"use strict";
/**
 * fix_transcript_opus.js — KORAK 2.9: Opus ispravlja prijepis koji NIJE od Sonioxa.
 *
 * Plan i odluka: docs/2026-11-16-korak-2-9-opus-ispravak-prijepisa-plan.md,
 * mjerenje: docs/2026-11-16-ep11-soniox-vs-canary.md § „Opus 5.5 ispravlja Canary tekst”
 * (191 → 120 grešaka protiv 4 neovisne reference, bez zvuka, samo tekst + metapodaci).
 *
 * Kandidat: kanonski `{base}.wav.canary.diarized.srt` čiji `canonical_srt.origin`
 * (lib/processing_manifest.js) NE počinje sa `soniox` i nije „nepoznato” — Canary rezerva
 * (`canary+pyannote_modal`, `canary`, `canary+pyannote_local`) i Speechmatics
 * (`speechmatics`, `speechmatics+pyannote_ai`). Soniox se ne dira (najtočniji; Opus bi dodao lekturu).
 *
 * Datoteke (OBA prijepisa ostaju na disku i OBA idu na CDN):
 *   {base}.diarized.asr.srt       izvorni ASR prijepis (kopija kanonskog PRIJE ispravka)
 *   {base}.wav.canary.diarized.srt ispravljeni = kanonski (koraci 7+ ga čitaju)
 *   {base}.transcript_fix.json    provenance (backend, model, tokeni, promijenjeni cue-ovi)
 *
 * Rezerva (nikad ne blokira epizodu): Opus (`claude -p`) → agy Gemini (tekstualno) → izvorni
 * tekst tog komada. Ako NIJEDAN komad nije ispravljen, ništa se ne piše i kanonski ostaje izvorni.
 * Vremena i granice cue-ova se nikad ne mijenjaju (model ne vidi vremena).
 *
 *   node fix_transcript_opus.js --dry-run
 *   node fix_transcript_opus.js --video-id RdEN7Ny1bV8 --channel muzevni_budite --fresh-days 0
 *   node fix_transcript_opus.js --video-id <ID> --force           # ponovno, iz .diarized.asr.srt
 *   node fix_transcript_opus.js --video-id <ID> --allow-consumed  # i kad sažetak/članak već postoje
 *
 * Env: TRANSCRIPT_FIX_BACKEND (auto|claude|agy, default auto), TRANSCRIPT_FIX_MODEL (opus),
 * TRANSCRIPT_FIX_EFFORT (medium), TRANSCRIPT_FIX_AGY_MODEL (gemini-4-hydrogen-medium),
 * TRANSCRIPT_FIX_CHUNK (100 cue-ova), TRANSCRIPT_FIX_PARALLEL (3), TRANSCRIPT_FIX_TIMEOUT_SEC (900).
 *
 * ⚠️ NIKAD `--bare` (prebacuje s pretplate na per-token API). `--tools ''` i neutralni cwd
 * su obavezni (docs/claude_code_backend_2026-07.md).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { buildManifest, writeManifest } = require("./lib/processing_manifest");
const { claudeWindowClosed, claudeWindowReason } = require("./lib/claude_window");
const { skipStep } = require("./lib/channel_settings_steps");

const args = process.argv.slice(2);
function getArg(name, def = null) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : def;
}
const hasFlag = (f) => args.includes(f);

const INPUT_DIR = getArg("--input-dir") || path.join(__dirname, "storage", "output");
const ONLY_CHANNEL = getArg("--channel");
const ONLY_VIDEO = getArg("--video-id");
const LIMIT = parseInt(getArg("--limit", "30"), 10);
const FRESH_DAYS = parseFloat(getArg("--fresh-days", "3"));
const DRY_RUN = hasFlag("--dry-run");
const FORCE = hasFlag("--force");
const ALLOW_CONSUMED = hasFlag("--allow-consumed");

const BACKEND = (process.env.TRANSCRIPT_FIX_BACKEND || "auto").toLowerCase();
const CLAUDE_MODEL = process.env.TRANSCRIPT_FIX_MODEL || "opus";
const CLAUDE_EFFORT = process.env.TRANSCRIPT_FIX_EFFORT || "medium";
const AGY_MODEL = process.env.TRANSCRIPT_FIX_AGY_MODEL || "gemini-4-hydrogen-medium";
const CHUNK_CUES = parseInt(process.env.TRANSCRIPT_FIX_CHUNK || "100", 10);
const PARALLEL = Math.max(1, Math.min(3, parseInt(process.env.TRANSCRIPT_FIX_PARALLEL || "3", 10)));
const TIMEOUT_MS = parseInt(process.env.TRANSCRIPT_FIX_TIMEOUT_SEC || "900", 10) * 1000;
const CONTEXT_CUES = 5;
const CLAUDE_CWD = path.join(os.tmpdir(), "domovina_claude_cli");

const CANONICAL = ".wav.canary.diarized.srt";
const ASR_SRT = ".diarized.asr.srt";
const FIX_META = ".transcript_fix.json";

// ─── SRT ──────────────────────────────────────────────────────────────

/** SRT → [{seq, idx, time, speaker, text}]; seq je redni broj (1..N), idx izvorni indeks. */
function parseSrt(content) {
    const out = [];
    for (const block of content.replace(/\r/g, "").split(/\n\n+/)) {
        const lines = block.split("\n").filter((l) => l.length);
        if (lines.length < 2 || !lines[1].includes("-->")) continue;
        let text = lines.slice(2).join(" ").trim();
        let speaker = null;
        const m = text.match(/^\[([^\]]+)\]\s*/);
        if (m) { speaker = m[1]; text = text.slice(m[0].length); }
        out.push({ seq: out.length + 1, idx: lines[0].trim(), time: lines[1].trim(), speaker, text });
    }
    return out;
}

function cueLine(c) {
    return `${c.seq} ${c.speaker ? `[${c.speaker}] ` : ""}${c.text}`.trimEnd();
}

function formatSrt(cues) {
    return cues.map((c) => `${c.idx}\n${c.time}\n${c.speaker ? `[${c.speaker}] ` : ""}${c.text}`.trimEnd()).join("\n\n") + "\n";
}

function chunkCues(cues, size = CHUNK_CUES) {
    const out = [];
    for (let i = 0; i < cues.length; i += size) out.push({ from: i, to: Math.min(i + size, cues.length) });
    // Mrvica na kraju (< 25 % komada) ide u prethodni komad.
    if (out.length > 1 && out[out.length - 1].to - out[out.length - 1].from < size / 4) {
        out[out.length - 2].to = out.pop().to;
    }
    return out;
}

// ─── Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Ispravljaš automatski prijepis podcasta (ASR, govornici iz dijarizacije). NE čuješ zvuk; ispravljaš samo ono što se pouzdano da zaključiti iz teksta i metapodataka epizode. Ovo je DOSLOVAN prijepis, ne lektura.

ISPRAVLJAJ SAMO vjerojatne ASR greške:
- fonetski zapisi i krivo prepoznate riječi kad je točna riječ jasna iz konteksta (npr. „klijenti” → „klinci” kad se govori o djeci),
- oblici koji nemaju smisla u rečenici, rastavljene ili spojene riječi,
- imena osoba, mjesta, institucija, naslovi i strani pojmovi — prema metapodacima epizode i općem znanju,
- interpunkcija, velika slova, kratice („itd.”).

NE SMIJEŠ:
- mijenjati riječ koja postoji i ima smisla u rečenici, čak ni kad bi „ljepše” zvučala druga (nema sinonima, nema stilskih zamjena),
- zamjenjivati dijalekt, žargon, regionalizme, anglizme ni razgovorne oblike standardnim jezikom („sa odgovornosti”, „nervni”, „šta” ostaju),
- dodavati riječi — osim imena iz metapodataka kad je predstavljanje očito progutano,
- brisati poštapalice, ponavljanja i nedovršene rečenice govornika,
- prepričavati, skraćivati, spajati ili dijeliti cue-ove, prevoditi (jezik prijepisa ostaje kakav jest),
- izmišljati sadržaj: ako je ASR progutao dio rečenice i točan tekst se ne može pouzdano zaključiti, ostavi kako jest.

GOVORNICI: zadrži oznaku [SPEAKER_xx] kakva jest (ne upisuj imena). Promijeni je samo na mrvici od 1–3 riječi koja je očito rečenica druge osobe (npr. pozdrav voditelja razlomljen na dva cue-a), i samo na oznaku koja se već pojavljuje u prijepisu.
RIJEČ U SUSJEDNI CUE premjesti samo kad je rečenica očito presječena na krivom mjestu (jedna-dvije riječi).

ULAZ: metapodaci epizode, nekoliko cue-ova KONTEKSTA prije i poslije (samo za razumijevanje, NE vraćaj ih), te cue-ovi ZA ISPRAVAK u formatu \`<seq> [SPEAKER_xx] <tekst>\`.
IZLAZ: SAMO cue-ovi za ispravak, svaki seq točno jednom, istim redom, u istom formatu \`<seq> [SPEAKER_xx] <tekst>\`, jedan po retku. Nepromijenjene cue-ove prepiši doslovno. Bez uvoda, objašnjenja, markdowna i ograđivača.`;

const AGY_SUFFIX = `

ZA OVAJ POZIV izlaz je JSON objekt: {"cues":[{"seq":<broj>,"speaker":"SPEAKER_xx","text":"<tekst>"}, ...]} — isti cue-ovi i ista pravila kao gore.`;

function readMeta(dir, base) {
    let info = null;
    try { info = JSON.parse(fs.readFileSync(path.join(dir, base + ".info.json"), "utf-8")); } catch { /* nema */ }
    if (!info) return { title: base };
    return {
        title: info.title || base,
        channel: info.channel || info.uploader || null,
        upload_date: info.upload_date || null,
        language: info.language || null,
        description: (info.description || "").slice(0, 3000),
        tags: Array.isArray(info.tags) ? info.tags.slice(0, 40) : [],
        chapters: Array.isArray(info.chapters)
            ? info.chapters.map((c) => `${Math.floor((c.start_time || 0) / 60)}:${String(Math.floor((c.start_time || 0) % 60)).padStart(2, "0")} ${c.title}`)
            : [],
    };
}

function buildUserMessage(meta, cues, chunk) {
    const before = cues.slice(Math.max(0, chunk.from - CONTEXT_CUES), chunk.from);
    const after = cues.slice(chunk.to, chunk.to + CONTEXT_CUES);
    const body = cues.slice(chunk.from, chunk.to);
    const parts = [`METAPODACI EPIZODE:\n${JSON.stringify(meta, null, 1)}`];
    if (before.length) parts.push(`KONTEKST PRIJE (ne vraćaj):\n${before.map(cueLine).join("\n")}`);
    parts.push(`CUE-OVI ZA ISPRAVAK (seq ${body[0].seq}–${body[body.length - 1].seq}, ukupno ${body.length}):\n${body.map(cueLine).join("\n")}`);
    if (after.length) parts.push(`KONTEKST POSLIJE (ne vraćaj):\n${after.map(cueLine).join("\n")}`);
    return parts.join("\n\n");
}

// ─── Izlaz modela ─────────────────────────────────────────────────────

/** Tekst `seq [SPK] tekst` po retku → Map(seq → {speaker, text}). */
function parseLines(text) {
    const out = new Map();
    for (const raw of String(text || "").split("\n")) {
        const l = raw.trim().replace(/^```.*$/, "");
        const m = l.match(/^(\d+)\s+(?:\[([^\]]+)\]\s*)?(.*)$/);
        if (!m) continue;
        const seq = parseInt(m[1], 10);
        if (!out.has(seq)) out.set(seq, { speaker: m[2] || null, text: m[3].trim() });
    }
    return out;
}

/** agy JSON → isti Map. */
function parseAgy(obj) {
    const out = new Map();
    const arr = obj && Array.isArray(obj.cues) ? obj.cues : Array.isArray(obj) ? obj : [];
    for (const c of arr) {
        const seq = parseInt(c && c.seq, 10);
        if (!Number.isFinite(seq) || out.has(seq)) continue;
        const spk = c.speaker ? String(c.speaker).replace(/^\[|\]$/g, "") : null;
        out.set(seq, { speaker: spk, text: String(c.text || "").trim() });
    }
    return out;
}

const wordCount = (s) => (String(s).match(/\S+/g) || []).length;

/**
 * Provjera komada: isti skup seq-ova i razumna duljina. Vraća {ok, reason, cues}
 * gdje su `cues` ispravljeni cue-ovi (vremena/idx iz izvornika). Promjene govornika
 * izvan pravila (> 3 riječi, nepoznata oznaka) i prazan tekst se tiho vraćaju na izvornik.
 */
function validateChunk(orig, parsed, knownSpeakers) {
    const seqs = orig.map((c) => c.seq);
    const missing = seqs.filter((s) => !parsed.has(s));
    if (missing.length) return { ok: false, reason: `nedostaju seq ${missing.slice(0, 5).join(",")}${missing.length > 5 ? "…" : ""} (${missing.length})` };
    const lenIn = orig.reduce((a, c) => a + c.text.length, 0);
    const lenOut = seqs.reduce((a, s) => a + parsed.get(s).text.length, 0);
    if (lenIn > 200 && (lenOut < lenIn * 0.8 || lenOut > lenIn * 1.25)) {
        return { ok: false, reason: `duljina ${lenOut} prema ${lenIn} znakova (izvan 80–125 %)` };
    }
    const cues = orig.map((c) => {
        const p = parsed.get(c.seq);
        let speaker = c.speaker;
        if (p.speaker && p.speaker !== c.speaker && knownSpeakers.has(p.speaker) && wordCount(c.text) <= 3) speaker = p.speaker;
        const text = p.text ? p.text : c.text;
        return { ...c, speaker, text };
    });
    return { ok: true, cues };
}

// ─── Backendi ─────────────────────────────────────────────────────────

function callClaude(systemPrompt, userMessage) {
    return new Promise((resolve, reject) => {
        try { fs.mkdirSync(CLAUDE_CWD, { recursive: true }); } catch (_) {}
        const cliArgs = [
            "-p",
            "--model", CLAUDE_MODEL,
            "--effort", CLAUDE_EFFORT,
            "--output-format", "json",
            "--setting-sources", "",
            "--strict-mcp-config",
            "--max-turns", "1",
            "--tools", "",            // variadic: MORA biti praćen sljedećim flagom
            "--system-prompt", systemPrompt,
        ];
        const proc = spawn("claude", cliArgs, { stdio: ["pipe", "pipe", "pipe"], cwd: CLAUDE_CWD });
        let stdout = "", stderr = "";
        const timer = setTimeout(() => { proc.kill("SIGTERM"); }, TIMEOUT_MS);
        proc.stdout.on("data", (d) => { stdout += d; });
        proc.stderr.on("data", (d) => { stderr += d; });
        proc.on("error", (err) => { clearTimeout(timer); reject(new Error(`claude spawn: ${err.message}`)); });
        proc.stdin.on("error", (err) => reject(new Error(`claude stdin: ${err.message}`)));
        proc.on("close", (code, signal) => {
            clearTimeout(timer);
            if (signal) return reject(new Error(`claude prekinut (${signal}) nakon ${TIMEOUT_MS / 1000} s`));
            if (code !== 0) return reject(new Error(`claude exit ${code}: ${(stderr || stdout).substring(0, 300) || "(bez outputa)"}`));
            let env;
            try { env = JSON.parse(stdout); } catch (_) { return reject(new Error(`claude nije vratio JSON envelope: ${stdout.substring(0, 200)}`)); }
            if (env.is_error || env.subtype !== "success") {
                return reject(new Error(`claude greška (subtype=${env.subtype}, api_status=${env.api_error_status}): ${String(env.result || "").substring(0, 200)}`));
            }
            resolve({ text: env.result || "", usage: env.usage || null, costUsd: typeof env.total_cost_usd === "number" ? env.total_cost_usd : null });
        });
        proc.stdin.write(userMessage);
        proc.stdin.end();
    });
}

async function callAgy(systemPrompt, userMessage) {
    const { agyJson } = require("./lib/agy_tmux");
    const session = `agyfix-s${process.env.PRIORITY_SLOT || "0"}`;
    const obj = await agyJson({ system: systemPrompt + AGY_SUFFIX, user: userMessage, session, model: AGY_MODEL, timeoutMs: TIMEOUT_MS });
    return obj;
}

function addUsage(acc, u, cost) {
    if (u) {
        acc.input_tokens += u.input_tokens || 0;
        acc.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
        acc.cache_read_input_tokens += u.cache_read_input_tokens || 0;
        acc.output_tokens += u.output_tokens || 0;
    }
    if (typeof cost === "number") acc.cost_usd = Math.round((acc.cost_usd + cost) * 10000) / 10000;
}

/**
 * Jedan komad kroz lanac rezervi. `state.claudeOk` = smije li Opus (prozor otvoren).
 * → {cues, backend} ; backend `original` kad nijedan nije uspio.
 */
async function fixChunk(cues, chunk, meta, knownSpeakers, state, label) {
    const orig = cues.slice(chunk.from, chunk.to);
    const user = buildUserMessage(meta, cues, chunk);
    const tag = `${label} komad ${orig[0].seq}–${orig[orig.length - 1].seq}`;
    if (state.claudeOk && BACKEND !== "agy") {
        for (let attempt = 1; attempt <= 2; attempt++) {
            const t0 = Date.now();
            try {
                const res = await callClaude(SYSTEM_PROMPT, user);
                addUsage(state.usage, res.usage, res.costUsd);
                const u = res.usage || {};
                const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
                const v = validateChunk(orig, parseLines(res.text), knownSpeakers);
                console.log(`      🧠 ${tag}: Opus ${inTok}→${u.output_tokens || 0} tok, ${Math.round((Date.now() - t0) / 1000)} s${v.ok ? "" : ` — ❌ ${v.reason}`}`);
                if (v.ok) return { cues: v.cues, backend: `claude:${CLAUDE_MODEL}` };
            } catch (e) {
                console.log(`      ⚠️  ${tag}: Opus pokušaj ${attempt}/2 — ${e.message}`);
            }
        }
    }
    if (BACKEND !== "claude") {
        const t0 = Date.now();
        try {
            const v = validateChunk(orig, parseAgy(await callAgy(SYSTEM_PROMPT, user)), knownSpeakers);
            console.log(`      ♊ ${tag}: agy ${AGY_MODEL}, ${Math.round((Date.now() - t0) / 1000)} s${v.ok ? "" : ` — ❌ ${v.reason}`}`);
            if (v.ok) return { cues: v.cues, backend: `agy:${AGY_MODEL}` };
        } catch (e) {
            console.log(`      ⚠️  ${tag}: agy — ${e.message}`);
        }
    }
    console.log(`      ↩️  ${tag}: ostaje izvorni tekst`);
    return { cues: orig, backend: "original" };
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}

// ─── Epizoda ──────────────────────────────────────────────────────────

/** Promijenjeni cue-ovi i promjene govornika između dva popisa cue-ova (isti seq). */
function diffStats(before, after) {
    let changed = 0, speakers = 0;
    for (let i = 0; i < before.length; i++) {
        const a = before[i], b = after[i];
        if (a.speaker !== b.speaker) speakers++;
        if (a.text !== b.text || a.speaker !== b.speaker) changed++;
    }
    return { changed, speakers };
}

async function processEpisode(cand) {
    const { dir, base, channel, origin } = cand;
    const label = `${channel}/${cand.videoId || base}`;
    const canonPath = path.join(dir, base + CANONICAL);
    const asrPath = path.join(dir, base + ASR_SRT);
    const metaPath = path.join(dir, base + FIX_META);

    // Ulaz UVIJEK izvorni: prvi prolaz kopira kanonski → .asr.srt; --force čita .asr.srt.
    const fromAsr = FORCE && fs.existsSync(metaPath) && fs.existsSync(asrPath);
    const srcContent = fs.readFileSync(fromAsr ? asrPath : canonPath, "utf-8");
    const cues = parseSrt(srcContent);
    if (!cues.length) { console.log(`   ⏭️  ${label}: prazan SRT`); return { status: "empty" }; }

    const knownSpeakers = new Set(cues.map((c) => c.speaker).filter(Boolean));
    const meta = readMeta(dir, base);
    const chunks = chunkCues(cues);
    const state = {
        claudeOk: BACKEND !== "agy",
        usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    };
    if (state.claudeOk && claudeWindowClosed()) {
        state.claudeOk = false;
        console.log(`   ⏸️  [ODGOĐENO] Opus za ${label}: ${claudeWindowReason()} — ispravak ide kroz agy ${AGY_MODEL}`);
    }
    console.log(`   ✍️  ${label} [${origin}] — ${cues.length} cue-ova, ${chunks.length} komada${state.claudeOk ? ` · Opus ${CLAUDE_EFFORT}` : ` · agy ${AGY_MODEL}`}`);

    const t0 = Date.now();
    // agy sesija je serijalizirana, pa paralelizam ima smisla samo za Claude.
    const results = await mapLimit(chunks, state.claudeOk ? PARALLEL : 1,
        (ch) => fixChunk(cues, ch, meta, knownSpeakers, state, label));
    const fixed = results.flatMap((r) => r.cues);
    const backends = {};
    for (const r of results) backends[r.backend] = (backends[r.backend] || 0) + 1;
    const okChunks = results.filter((r) => r.backend !== "original").length;
    const seconds = Math.round((Date.now() - t0) / 1000);
    const u = state.usage;
    const tokIn = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;

    if (!okChunks) {
        console.log(`   ⚠️  ${label}: nijedan komad nije ispravljen (Opus i agy) — izvorni ostaje kanonski (${seconds} s)`);
        return { status: "failed", usage: u };
    }

    const { changed, speakers } = diffStats(cues, fixed);
    const used = Object.keys(backends).filter((b) => b !== "original");
    const doc = {
        v: 1,
        video_id: cand.videoId,
        source_origin: origin,
        source_file: base + ASR_SRT,
        backend: used.length === 1 ? used[0] : "mixed",
        backends,
        model: state.claudeOk ? CLAUDE_MODEL : AGY_MODEL,
        effort: state.claudeOk ? CLAUDE_EFFORT : null,
        at: new Date().toISOString(),
        chunks: chunks.length,
        chunk_cues: CHUNK_CUES,
        cues: cues.length,
        changed_cues: changed,
        speaker_changes: speakers,
        partial: okChunks < chunks.length,
        usage: { ...u, total_input_tokens: tokIn },
        seconds,
    };
    console.log(`   ✅ ${label}: promijenjeno ${changed}/${cues.length} cue-ova (govornik ${speakers}), ` +
        `${tokIn}→${u.output_tokens} tok${u.cost_usd ? ` (~$${u.cost_usd.toFixed(2)} API-ekviv.)` : ""}, ${seconds} s` +
        `${doc.partial ? ` · ⚠️ djelomično ${okChunks}/${chunks.length}` : ""}`);

    if (!DRY_RUN) {
        if (!fromAsr) fs.writeFileSync(asrPath, srcContent);
        const tmp = canonPath + ".tmp";
        fs.writeFileSync(tmp, formatSrt(fixed));
        fs.renameSync(tmp, canonPath);
        fs.writeFileSync(metaPath, JSON.stringify(doc, null, 2) + "\n");
        writeManifest(dir, base);
    }
    return { status: "fixed", usage: u, doc };
}

// ─── Kandidati ────────────────────────────────────────────────────────

function extractVideoId(name) {
    const all = [...name.matchAll(/(?=_yt_([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-]))/g)];
    return all.length ? all[all.length - 1][1] : null;
}

/** Treba li izvor ispravak: sve osim Sonioxa i nepoznatog (npr. HR prijevod EN kanala). */
function originNeedsFix(origin) {
    if (!origin || origin === "nepoznato") return false;
    return !origin.startsWith("soniox");
}

function listChannelDirs(root) {
    return fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
        .map((e) => e.name).sort();
}

function findCandidates(stats) {
    const out = [];
    const channels = ONLY_CHANNEL ? [ONLY_CHANNEL] : listChannelDirs(INPUT_DIR);
    for (const channel of channels) {
        const dir = path.join(INPUT_DIR, channel);
        let files;
        try { files = fs.readdirSync(dir).filter((f) => !f.startsWith("._")); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith(CANONICAL)) continue;
            const base = f.slice(0, -CANONICAL.length);
            const videoId = extractVideoId(base);
            if (ONLY_VIDEO && videoId !== ONLY_VIDEO) continue;
            const p = path.join(dir, f);
            if (FRESH_DAYS > 0) {
                let age;
                try { age = (Date.now() - fs.statSync(p).mtimeMs) / 86400000; } catch { continue; }
                if (age > FRESH_DAYS) continue;
            }
            const hasFix = files.includes(base + FIX_META);
            if (hasFix && !FORCE) { stats.done++; continue; }
            const epFiles = files.filter((x) => x.startsWith(base));
            const origin = buildManifest(dir, base, epFiles).canonical_srt?.origin || null;
            if (!originNeedsFix(origin)) { stats.soniox++; continue; }
            // Koraci 7+ su već pročitali izvorni prijepis (i on je možda već na CDN-u pod
            // immutable ključem): ispravak bi razdvojio članak od prijepisa. Reobrada to traži izričito.
            const consumed = epFiles.some((x) => x.endsWith(".canary.summary.json") || /\.article\.json$/.test(x));
            if (consumed && !ALLOW_CONSUMED && !hasFix) {
                stats.consumed++;
                if (ONLY_VIDEO) console.log(`   ⏭️  ${channel}/${videoId}: sažetak/članak već postoje — preskačem (--allow-consumed za reobradu)`);
                continue;
            }
            if (skipStep("transcript_fix", p, { label: `${channel}/${videoId}` })) { stats.settings++; continue; }
            out.push({ dir, base, channel, videoId, origin, mtime: fs.statSync(p).mtimeMs });
        }
    }
    // Najnovije prvo.
    return out.sort((a, b) => b.mtime - a.mtime);
}

async function main() {
    console.log(`✍️  KORAK 2.9 — ispravak prijepisa (nije Soniox): backend ${BACKEND}, Opus ${CLAUDE_MODEL}/${CLAUDE_EFFORT}, ` +
        `rezerva agy ${AGY_MODEL}, komad ${CHUNK_CUES}, svježina ${FRESH_DAYS || "∞"} d${DRY_RUN ? " · DRY RUN" : ""}`);
    const stats = { done: 0, soniox: 0, consumed: 0, settings: 0 };
    const cands = findCandidates(stats);
    console.log(`   kandidata: ${cands.length} (već ispravljeno ${stats.done}, Soniox/nepoznato ${stats.soniox}` +
        `${stats.consumed ? `, već iskorišteno ${stats.consumed}` : ""}${stats.settings ? `, postavke kanala ${stats.settings}` : ""})`);
    const todo = cands.slice(0, LIMIT);
    if (cands.length > todo.length) console.log(`   limit ${LIMIT}: ostatak (${cands.length - todo.length}) u idući run`);
    if (DRY_RUN) {
        for (const c of todo) console.log(`   • ${c.channel}/${c.videoId} [${c.origin}]`);
        return;
    }
    const tot = { fixed: 0, failed: 0, tokIn: 0, tokOut: 0 };
    for (const c of todo) {
        try {
            const r = await processEpisode(c);
            if (r.status === "fixed") tot.fixed++;
            else if (r.status === "failed") tot.failed++;
            if (r.usage) {
                tot.tokIn += r.usage.input_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens;
                tot.tokOut += r.usage.output_tokens;
            }
        } catch (e) {
            tot.failed++;
            console.log(`   ❌ ${c.channel}/${c.videoId}: ${e.message}`);
        }
    }
    console.log(`\n✍️  Ispravljeno: ${tot.fixed} · bez ispravka (izvorni ostaje): ${tot.failed} · Opus tokeni ${tot.tokIn}→${tot.tokOut}`);
}

if (require.main === module) {
    main().catch((e) => { console.error(`❌ ${e.stack || e.message}`); process.exit(1); });
}

module.exports = { parseSrt, formatSrt, cueLine, chunkCues, buildUserMessage, parseLines, parseAgy, validateChunk, diffStats, originNeedsFix, SYSTEM_PROMPT };
