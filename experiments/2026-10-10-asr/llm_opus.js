#!/usr/bin/env node
// Set 10.10.2026.: ISTI LLM (Opus 5.5 pod pretplatom) nad RAZLIČITIM transkriptima — mjeri
// koliko ASR + diarizacija utječu na članak. Kopija experiments/2026-10-11-asr-llm/llm_phase2.js;
// razlike: --input bira transkript, opus-5-5 slug, imena izlaza nose ulaz, EN samo uz --with-en.
//   --input speechmatics-enhanced | deepgram-nova3 | canary-1b-v2+pyannote-c1
//
// Promptovi se NE kopiraju — izvlače se doslovno iz produkcijskih skripti pri pokretanju
// (SYSTEM_PROMPT iz summarize_gemini.js, SYSTEM_PROMPT_1/2 + STRICT_NAMING_CLAUSE iz
// generate_article_gemini.js, TRANSLATOR_PROMPT iz translate_to_english.js), pa usporedba
// mjeri model, ne razliku u promptu. Sastav user poruke prati produkcijski kod
// (metapodaci → transkript; outline: službena mapa + kontekst + trajanje; iteracija: okvir +
// cijeli SRT). Službeni kontekst članka gradi se iz sažetka ISTOG modela, kao u produkciji.
//
// Izlaz (TRAJAN, README §Trajni izlaz):
//   data/output/<kanal>/<base>.exp-20261010.<ulaz>.<model>.sazetak.json
//   data/output/<kanal>/<base>.exp-20261010.<ulaz>.<model>.clanak.json      (outline u metadata.outline)
//   data/output/<kanal>/<base>.exp-20261010.<ulaz>.<model>.clanak.en.json   (samo uz --with-en)
//   data/output/<kanal>/<base>.exp-20261010_raw/<ulaz>.<model>-<korak>.json  sirovi odgovor + usage
//   data/logs/faza2_pozivi.jsonl                                      1 red = 1 API poziv
//
// Modeli: gemini-3-8-flash, gemini-4-argon (Vertex, krediti bimbo-sync-prod),
//         haiku-5-5 (Anthropic API, ANTHROPIC_API_KEY_HAIKU_EXPERIMENT),
//         sonnet-5-5 (`claude -p --model sonnet` pod PRETPLATOM — vidi docs/claude_code_backend_2026-07.md)
//
//   set -a; . ./.env.experiments; set +a
//   node experiments/2026-10-10-asr/llm_opus.js --model opus-5-5 --input deepgram-nova3 --id OspwepfLObY
//   node experiments/2026-10-10-asr/llm_opus.js --model opus-5-5 --dry-run    # plan poziva + tokeni
//   node experiments/2026-10-10-asr/llm_opus.js --summary   # zbroj iz llm_pozivi.jsonl
//
// Idempotentno: postojeći sazetak/clanak/clanak.en se preskaču; članak se nastavlja po iteraciji
// (sirove iteracije u _raw/ se ponovno koriste).
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const { spawn, execFileSync } = require("child_process");

const EXP = __dirname;
const REPO = path.resolve(EXP, "../..");
const OUT = path.join(EXP, "data/output");
const LOGS = path.join(EXP, "data/logs");
const CALLS_LOG = path.join(LOGS, "llm_pozivi.jsonl");
const TAG = "exp-20261010";
const INPUTS = ["speechmatics-enhanced", "deepgram-nova3", "canary-1b-v2+pyannote-c1"];

const args = process.argv.slice(2);
function getArg(name, def = null) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : def;
}
const hasFlag = (n) => args.includes(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INPUT_TOOL = getArg("--input", "speechmatics-enhanced");
if (!INPUTS.includes(INPUT_TOOL)) { console.error(`--input mora biti jedno od: ${INPUTS.join(", ")}`); process.exit(2); }
const WITH_EN = hasFlag("--with-en");

// ─── Modeli i cjenik (USD / M tokena; razmišljanje se naplaćuje kao izlaz) ───
const MODELS = {
    "gemini-3-8-flash": { kind: "vertex", model: "gemini-3.8-flash", priceIn: 0.75, priceOut: 3.75 },
    "gemini-4-argon":   { kind: "vertex", model: "gemini-4-argon",   priceIn: 2.00, priceOut: 10.00 },
    // Haiku 5.5: $0,10/$0,50 do 100k tokena prompta, iznad $0,50/$2,50. Effort default (medium).
    "haiku-5-5":        { kind: "anthropic", model: "claude-haiku-5-5", priceIn: 0.10, priceOut: 0.50,
                          longIn: 0.50, longOut: 2.50, longAbove: 100000 },
    // Pretplata — $ je ekvivalent (total_cost_usd iz CLI-ja), ne naplaćuje se. Effort kao produkcija.
    "sonnet-5-5":       { kind: "claude-cli", model: "sonnet", effort: "high", priceIn: 2.00, priceOut: 10.00 },
    // Produkcijski Opus (claude backend, effort high kao CLAUDE_EFFORT default u generate_article_gemini.js).
    "opus-5-5":         { kind: "claude-cli", model: "opus", effort: "high", priceIn: 5.00, priceOut: 25.00 },
};

// ─── Promptovi doslovno iz produkcije ───
function extractConst(file, name) {
    const src = fs.readFileSync(path.join(REPO, file), "utf-8");
    const m = src.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;\\n"));
    if (!m) throw new Error(`Ne nalazim ${name} u ${file}`);
    if (m[1].includes("${")) throw new Error(`${name} u ${file} ima interpolaciju — ne znam ga izvući`);
    return new Function("return `" + m[1] + "`;")();   // razriješi \` escapeove kao JS
}
const P_SUMMARY = extractConst("summarize_gemini.js", "SYSTEM_PROMPT");
const P_OUTLINE = extractConst("generate_article_gemini.js", "SYSTEM_PROMPT_1");
const P_ITER = extractConst("generate_article_gemini.js", "SYSTEM_PROMPT_2");
const P_STRICT = extractConst("generate_article_gemini.js", "STRICT_NAMING_CLAUSE");
const P_TRANSLATOR = extractConst("translate_to_english.js", "TRANSLATOR_PROMPT");

// EN: isti strogi prevoditelj, ali cijeli članak u JEDNOM pozivu (produkcija prevodi polje po
// polje — 74 % poziva su pojedinačne riječi). Mijenja se samo pravilo o obliku izlaza.
const P_EN = (() => {
    const rule10 = /10\. Output ONLY valid JSON[^\n]*\n/;
    if (!rule10.test(P_TRANSLATOR)) throw new Error("TRANSLATOR_PROMPT: pravilo 10 promijenjeno — provjeri P_EN");
    return P_TRANSLATOR
        .replace("for a Catholic podcast platform", "for a podcast platform (topics vary: sport, history, health, faith, politics)")
        .replace(rule10,
            "10. The input is a JSON object (a whole article). Return ONLY valid JSON of EXACTLY the same shape: same keys, " +
            "same array lengths and order, same iteration_number values. Translate every string value of \"theme\", \"subtitle\", " +
            "\"screenshot_description\", \"content\" and every element of \"keywords\"; in \"entities\" translate only common nouns, keep proper names. " +
            "No commentary, no markdown fences.\n")
        .replace(/\nIf the source is empty[^\n]*$/, "");
})();

const SECTION_REQUIRED_FIELDS = ["subtitle", "screenshot_timestamp", "content", "keywords", "entities"];
const STRICT_SPEAKER_THRESHOLD = 8;

// ─── Pomoćne (preslika iz generate_article_gemini.js / summarize_gemini.js) ───
function secToHMS(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return [h, m, s].map(n => String(n).padStart(2, "0")).join(":");
}
function hmsToSec(t) {
    const m = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(String(t || ""));
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
}
function srtToText(srt) {
    return srt.split("\n").map(l => l.trim())
        .filter(l => l && !/^\d+$/.test(l) && !/^\d{2}:\d{2}:\d{2}[,.]/.test(l)).join("\n");
}
function lastCueSeconds(srt) {
    let last = 0, m;
    const re = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g;
    while ((m = re.exec(srt)) !== null) last = Math.max(last, (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]));
    return last;
}
function countSpeakers(srt) {
    const set = new Set(); let m; const re = /\[SPEAKER_(\d+)\]/g;
    while ((m = re.exec(srt)) !== null) set.add(m[1]);
    return set.size;
}
function loadPublisherChapters(info, descPath) {
    if (info && Array.isArray(info.chapters) && info.chapters.length) {
        return info.chapters.filter(c => c && c.title != null && c.start_time != null)
            .map(c => ({ seconds: Math.round(Number(c.start_time)), label: String(c.title).trim() }));
    }
    if (!descPath || !fs.existsSync(descPath)) return [];
    const out = [];
    for (const line of fs.readFileSync(descPath, "utf-8").split("\n")) {
        const m = line.match(/^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(\S.*?)\s*$/);
        if (!m) continue;
        const hasH = m[3] != null;
        const h = hasH ? +m[1] : 0, mm = hasH ? +m[2] : +m[1], ss = hasH ? +m[3] : +m[2];
        out.push({ seconds: h * 3600 + mm * 60 + ss, label: m[4].trim() });
    }
    return out;
}
function buildChapterMapBlock(chapters) {
    const lines = chapters.map(c => ` - ${secToHMS(c.seconds)}  ${c.label}`).join("\n");
    return `\n\nSLUŽBENA MAPA GOVORNIKA / POGLAVLJA (od izdavača — AUTORITATIVNO za imena; poravnaj vrijeme nastupa govornika s ovim oznakama; stavke koje su nazivi pjesama ne odnose se na osobe):\n${lines}\n`;
}
function buildDurationBlock(lastSec) {
    const hms = secToHMS(lastSec);
    return `\n\nSTVARNO TRAJANJE TRANSKRIPTA: zadnji cue završava na ${hms}. ` +
        `Transkript NEMA sadržaja nakon tog vremena.\n` +
        `- Nijedan "start_time", "end_time" ni "timestamp" ne smije biti veći od ${hms}.\n` +
        `- Pravilo o 35-45 minuta vrijedi NEPROMIJENJENO za snimke dulje od 45 minuta: ` +
        `dugu snimku i dalje dijeli na blokove od cca 35-45 minuta (4 sata ≈ 6 iteracija).\n` +
        `- Ono NIJE kvota koju treba popuniti kad je snimka kraća od jednog bloka. Tada vrati ` +
        `onoliko iteracija koliko sadržaj stvarno pokriva (za transkript kraći od 35 minuta ` +
        `to je TOČNO JEDNA iteracija).\n` +
        `- Strogo je zabranjeno izmišljati teme, poglavlja ili nastavak razgovora kojih nema u transkriptu.\n`;
}
function buildOfficialContextBlock(info, summary) {
    const title = info ? (info.title || info.fulltitle || null) : null;
    const channel = info ? (info.channel || info.uploader || null) : null;
    const speakers = ((summary && summary.speakers) || []).filter(sp => sp && (sp.suggested_name || sp.name));
    if (!title && !channel && !speakers.length) return "";
    const lines = [];
    if (title) lines.push(` - Naslov epizode: ${title}`);
    if (channel) lines.push(` - Kanal/emisija: ${channel}`);
    if (speakers.length) {
        const sp = speakers.map(x => ` - ${x.id ? `[${x.id}] = ` : ""}${x.suggested_name || x.name}${x.role ? ` (${x.role})` : ""}`).join("\n");
        lines.push(` - Govornici (mapirani na diarizacijske oznake, izvedeno iz službenog opisa epizode):\n${sp}`);
    }
    return `\n\nSLUŽBENI KONTEKST EPIZODE (autoritativno — iz metapodataka izdavača i službenog opisa; POBJEĐUJE suprotne zaključke iz ASR transkripta. Zapis imena preuzmi DOSLOVNO — bez pravopisne korekcije; ako se zapis u naslovu epizode i mapi razlikuje, mjerodavan je NASLOV):\n${lines.join("\n")}\n`;
}
function clampOutline(outline, lastSec) {
    const hms = secToHMS(lastSec);
    let dropped = 0;
    const kept = [];
    for (const it of outline.iterations || []) {
        const st = hmsToSec(it.start_time);
        if (st !== null && st > lastSec) { dropped++; continue; }
        const ch = (it.chapters || []).filter(c => { const t = hmsToSec(c.timestamp); return !(t !== null && t > lastSec); });
        dropped += (it.chapters || []).length - ch.length;
        if (ch.length === 0 && (it.chapters || []).length > 0) continue;
        it.chapters = ch;
        if (hmsToSec(it.end_time) > lastSec) it.end_time = hms;
        kept.push(it);
    }
    outline.iterations = kept;
    return dropped;
}
function sectionsMissingFields(sections) {
    const missing = new Set();
    for (const sec of sections || []) for (const f of SECTION_REQUIRED_FIELDS) {
        const v = sec ? sec[f] : undefined;
        if (v == null || (Array.isArray(v) && !v.length) || (typeof v === "string" && !v.trim())) missing.add(f);
    }
    return [...missing];
}

// ─── JSON: strogo (bez ikakvog čišćenja) vs blago (fence, uvodni tekst, kontrolni znakovi) ───
function parseJson(text) {
    const res = { strict: false, lenient: false, value: null };
    try { res.value = JSON.parse(text.trim()); res.strict = res.lenient = true; return res; } catch (_) {}
    let c = text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    if (!c.startsWith("{") && !c.startsWith("[")) {
        const a = c.indexOf("{"), b = c.lastIndexOf("}");
        if (a !== -1 && b > a) c = c.slice(a, b + 1);
    }
    for (const cand of [c, c.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")]) {
        try { res.value = JSON.parse(cand); res.lenient = true; return res; } catch (_) {}
    }
    return res;
}

// ─── Backend: Vertex (Gemini) ───
let vertexToken = null, vertexTokenAt = 0;
function getVertexToken() {
    if (vertexToken && Date.now() - vertexTokenAt < 50 * 60 * 1000) return vertexToken;
    const account = process.env.VERTEX_ACCOUNT || "stepanic.matija@gmail.com";
    vertexToken = execFileSync("gcloud", ["auth", "print-access-token", `--account=${account}`], { encoding: "utf-8" }).trim();
    vertexTokenAt = Date.now();
    return vertexToken;
}
async function callVertex(cfg, system, user) {
    const project = "bimbo-sync-prod";   // CLAUDE.md pravilo 0 — jedini važeći projekt
    const url = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${cfg.model}:generateContent`;
    const payload = {
        contents: [{ role: "user", parts: [{ text: user }] }],
        systemInstruction: { role: "system", parts: [{ text: system }] },
        // isto kao produkcija (generate_article_gemini.js); thinkingConfig namjerno default
        generationConfig: { temperature: 0.2, maxOutputTokens: 65536, responseMimeType: "application/json" },
    };
    for (let attempt = 1; attempt <= 8; attempt++) {
        const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${getVertexToken()}` },
            body: JSON.stringify(payload),
        });
        if (r.status === 401) { vertexToken = null; continue; }
        if (r.status === 429 || r.status >= 500) {
            const w = Math.min(60000, 5000 * 2 ** (attempt - 1));
            console.error(`      ⏳ Vertex ${r.status} — čekam ${w / 1000}s (pokušaj ${attempt})`);
            await sleep(w); continue;
        }
        const body = await r.text();
        if (!r.ok) throw new Error(`Vertex HTTP ${r.status}: ${body.slice(0, 300)}`);
        const data = JSON.parse(body);
        const cand = (data.candidates || [])[0] || {};
        const text = ((cand.content || {}).parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
        const u = data.usageMetadata || {};
        return {
            text, finish: cand.finishReason || (data.promptFeedback || {}).blockReason || null, raw: data,
            inTok: u.promptTokenCount || 0, outTok: u.candidatesTokenCount || 0, thinkTok: u.thoughtsTokenCount || 0,
            cachedTok: u.cachedContentTokenCount || 0, transientRetries: attempt - 1,
        };
    }
    throw new Error("Vertex: iscrpljeni pokušaji (429/5xx)");
}

// ─── Backend: Anthropic Messages API (Haiku) — raw fetch + SSE, repo nema SDK ovisnosti ───
async function callAnthropic(cfg, system, user) {
    const key = process.env.ANTHROPIC_API_KEY_HAIKU_EXPERIMENT;
    if (!key) throw new Error("ANTHROPIC_API_KEY_HAIKU_EXPERIMENT nije postavljen (set -a; . ./.env.experiments; set +a)");
    for (let attempt = 1; attempt <= 6; attempt++) {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({
                model: cfg.model, max_tokens: 64000, stream: true,
                system, messages: [{ role: "user", content: user }],
            }),
        });
        if (r.status === 429 || r.status === 529 || r.status >= 500) {
            const ra = parseInt(r.headers.get("retry-after") || "0", 10);
            const w = Math.max(ra * 1000, Math.min(60000, 5000 * 2 ** (attempt - 1)));
            console.error(`      ⏳ Anthropic ${r.status} — čekam ${w / 1000}s (pokušaj ${attempt})`);
            await r.text().catch(() => {}); await sleep(w); continue;
        }
        if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
        let buf = "", text = "", inTok = 0, outTok = 0, cacheR = 0, cacheW = 0, stop = null, reqId = r.headers.get("request-id");
        const dec = new TextDecoder();
        for await (const chunk of r.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) !== -1) {
                const ev = buf.slice(0, i); buf = buf.slice(i + 2);
                const dl = ev.split("\n").find(l => l.startsWith("data: "));
                if (!dl) continue;
                const d = JSON.parse(dl.slice(6));
                if (d.type === "message_start") {
                    const u = d.message.usage || {};
                    inTok = u.input_tokens || 0; cacheR = u.cache_read_input_tokens || 0; cacheW = u.cache_creation_input_tokens || 0;
                } else if (d.type === "content_block_delta" && d.delta.type === "text_delta") {
                    text += d.delta.text;
                } else if (d.type === "message_delta") {
                    if (d.usage && d.usage.output_tokens != null) outTok = d.usage.output_tokens;
                    if (d.delta && d.delta.stop_reason) stop = d.delta.stop_reason;
                } else if (d.type === "error") {
                    throw new Error(`Anthropic stream error: ${JSON.stringify(d.error).slice(0, 300)}`);
                }
            }
        }
        // output_tokens uključuje razmišljanje (API ga ne razdvaja); procjena razmišljanja = izlaz − tekst/≈3,5
        return { text, finish: stop, raw: { request_id: reqId, stop_reason: stop }, inTok: inTok + cacheR + cacheW, outTok,
                 thinkTok: null, cachedTok: cacheR, transientRetries: attempt - 1 };
    }
    throw new Error("Anthropic: iscrpljeni pokušaji");
}

// ─── Backend: Claude Code CLI pod pretplatom (Sonnet) ───
// Isti flagovi kao callClaudeCli() u produkciji: --tools '' (inače 21k tokena overheada),
// neutralan cwd (inače učita CLAUDE.md), NIKAD --bare (prebaci na API naplatu).
const CLAUDE_CWD = path.join(os.tmpdir(), "domovina_claude_cli_exp");
function callClaudeCli(cfg, system, user) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(CLAUDE_CWD, { recursive: true });
        const env = { ...process.env };
        delete env.ANTHROPIC_API_KEY;                       // pretplata, nikad per-token
        delete env.ANTHROPIC_API_KEY_HAIKU_EXPERIMENT;
        const a = ["-p", "--model", cfg.model, "--effort", cfg.effort, "--output-format", "json",
                   "--setting-sources", "", "--strict-mcp-config", "--max-turns", "1",
                   "--tools", "", "--system-prompt", system];
        const p = spawn("claude", a, { stdio: ["pipe", "pipe", "pipe"], cwd: CLAUDE_CWD, env });
        let so = "", se = "";
        p.stdout.on("data", d => { so += d; }); p.stderr.on("data", d => { se += d; });
        p.on("error", e => reject(new Error(`claude spawn: ${e.message}`)));
        p.on("close", code => {
            if (code !== 0) return reject(new Error(`claude exit ${code}: ${(se || so).slice(0, 400)}`));
            let e; try { e = JSON.parse(so); } catch (_) { return reject(new Error(`claude: nije JSON envelope: ${so.slice(0, 300)}`)); }
            if (e.is_error || e.subtype !== "success") return reject(new Error(`claude greška ${e.subtype}/${e.api_error_status}: ${String(e.result || "").slice(0, 300)}`));
            const u = e.usage || {};
            resolve({ text: e.result || "", finish: e.stop_reason || null,
                      raw: { usage: u, total_cost_usd: e.total_cost_usd, duration_ms: e.duration_ms, modelUsage: e.modelUsage, session_id: e.session_id },
                      inTok: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
                      outTok: u.output_tokens || 0, thinkTok: null, cachedTok: u.cache_read_input_tokens || 0,
                      costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null, transientRetries: 0 });
        });
        p.stdin.write(user); p.stdin.end();
    });
}

function priceCall(cfg, r) {
    if (r.costUsd != null) return r.costUsd;
    const long = cfg.longAbove && r.inTok > cfg.longAbove;
    const pin = long ? cfg.longIn : cfg.priceIn, pout = long ? cfg.longOut : cfg.priceOut;
    return (r.inTok * pin + (r.outTok + (r.thinkTok || 0)) * pout) / 1e6;
}

// Jedan logički poziv: do 2 pokušaja ako JSON ni blago ne prolazi. Bilježi svaki pokušaj.
async function llmJson(ctx, step, system, user) {
    const cfg = MODELS[ctx.model];
    const fn = cfg.kind === "vertex" ? callVertex : cfg.kind === "anthropic" ? callAnthropic : callClaudeCli;
    let firstStrict = null, firstLenient = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const t0 = Date.now();
        let r, err = null;
        try { r = await fn(cfg, system, user); } catch (e) { err = e; }
        const ms = Date.now() - t0;
        if (err) {
            logCall(ctx, step, attempt, { ms, error: err.message.slice(0, 300) });
            if (attempt === 2) throw err;
            console.error(`      ⚠️  ${step}: ${err.message.slice(0, 160)} — ponavljam`);
            await sleep(10000); continue;
        }
        const pj = parseJson(r.text);
        if (attempt === 1) { firstStrict = pj.strict; firstLenient = pj.lenient; }
        const usd = priceCall(cfg, r);
        fs.writeFileSync(path.join(ctx.rawDir, `${ctx.label}-${step}${attempt > 1 ? `.pokusaj${attempt}` : ""}.json`),
            JSON.stringify({ model: cfg.model, step, attempt, ms, finish: r.finish, inTok: r.inTok, outTok: r.outTok,
                             thinkTok: r.thinkTok, usd, meta: r.raw && r.raw.candidates ? { usageMetadata: r.raw.usageMetadata, modelVersion: r.raw.modelVersion } : r.raw,
                             text: r.text }, null, 2));
        logCall(ctx, step, attempt, { ms, inTok: r.inTok, outTok: r.outTok, thinkTok: r.thinkTok, cachedTok: r.cachedTok,
                                      usd, finish: r.finish, jsonStrict: pj.strict, jsonLenient: pj.lenient,
                                      transientRetries: r.transientRetries, outChars: r.text.length });
        console.log(`      🧠 ${step}: ${r.inTok}→${r.outTok}${r.thinkTok ? `+${r.thinkTok}💭` : ""} tok, ${(ms / 1000).toFixed(1)} s, $${usd.toFixed(4)}, JSON ${pj.strict ? "strogo✓" : pj.lenient ? "blago✓" : "✗"}${r.finish && !/^(STOP|end_turn)$/.test(r.finish) ? `, kraj=${r.finish}` : ""}`);
        if (pj.lenient) return { value: pj.value, firstStrict, firstLenient, attempts: attempt };
        if (attempt === 2) throw new Error(`${step}: neispravan JSON i u 2. pokušaju`);
    }
}

function logCall(ctx, step, attempt, rec) {
    fs.mkdirSync(LOGS, { recursive: true });
    fs.appendFileSync(CALLS_LOG, JSON.stringify({ ts: new Date().toISOString(), model: ctx.model, input: INPUT_TOOL, id: ctx.id, step, attempt, ...rec }) + "\n");
}

// ─── Epizode ───
function loadEpisodes() {
    const rows = fs.readFileSync(path.join(EXP, "bases.tsv"), "utf-8").trim().split("\n").slice(1).map(l => l.split("\t"));
    return rows.map(([id, kanal, base]) => {
        const dir = path.join(OUT, kanal);
        // 2 referentne epizode nemaju metapodatke u data/output → čitaj (samo čitaj) iz storage/output
        const metaDir = fs.existsSync(path.join(dir, `${base}.info.json`)) ? dir : path.join(REPO, "storage/output", kanal);
        return { id, kanal, base, dir, metaDir,
                 srt: path.join(dir, `${base}.${TAG}.${INPUT_TOOL}.dijariziran.srt`),
                 rawDir: path.join(dir, `${base}.${TAG}_raw`) };
    });
}
const outPath = (ep, model, art) => path.join(ep.dir, `${ep.base}.${TAG}.${INPUT_TOOL}.${model}.${art}.json`);

async function processEpisode(ep, model) {
    const ctx = { model, label: `${INPUT_TOOL}.${model}`, id: ep.id, rawDir: ep.rawDir };
    fs.mkdirSync(ep.rawDir, { recursive: true });
    const srt = fs.readFileSync(ep.srt, "utf-8");
    const infoPath = path.join(ep.metaDir, `${ep.base}.info.json`);
    const info = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, "utf-8")) : null;
    const now = () => new Date().toISOString();
    const provenance = { model, backend: MODELS[model].kind, model_id: MODELS[model].model, input: `${INPUT_TOOL}.dijariziran.srt` };

    // ── 1. SAŽETAK (summarize_gemini.js callGemini) ──
    const sumPath = outPath(ep, model, "sazetak");
    let summary;
    if (fs.existsSync(sumPath)) {
        summary = JSON.parse(fs.readFileSync(sumPath, "utf-8")).summary;
    } else {
        let u = "";
        if (info) {
            u += "=== METAPODACI ===\n";
            if (info.title) u += `Naslov: ${info.title}\n`;
            if (info.description) u += `Opis: ${info.description}\n`;
            if (info.tags && info.tags.length) u += `Tagovi: ${info.tags.slice(0, 20).join(", ")}\n`;
            if (info.duration) u += `Trajanje: ${Math.floor(info.duration / 60)} minuta\n`;
            if (info.channel) u += `Kanal: ${info.channel}\n`;
            u += "\n";
        }
        u += "=== DIARIZIRANI TRANSKRIPT ===\n" + srtToText(srt);
        const r = await llmJson(ctx, "sazetak", P_SUMMARY, u);
        summary = r.value;
        fs.writeFileSync(sumPath, JSON.stringify({ metadata: { ...provenance, generated_at: now(), json_first_try_strict: r.firstStrict, attempts: r.attempts }, summary }, null, 2));
    }

    // ── 2. OUTLINE + ITERACIJE (generate_article_gemini.js processFile) ──
    const artPath = outPath(ep, model, "clanak");
    let article = fs.existsSync(artPath) ? JSON.parse(fs.readFileSync(artPath, "utf-8")) : null;
    if (!article || !article.metadata.complete) {
        const chapters = loadPublisherChapters(info, path.join(ep.metaDir, `${ep.base}.description`));
        const speakerCount = countSpeakers(srt);
        const officialBlock = buildOfficialContextBlock(info, summary);
        const strict = chapters.length >= 3 || speakerCount > STRICT_SPEAKER_THRESHOLD || !!officialBlock;
        const chapterBlock = (chapters.length >= 3 ? buildChapterMapBlock(chapters) : "") + officialBlock;
        const lastSec = lastCueSeconds(srt);
        const sys1 = P_OUTLINE + (strict ? P_STRICT : ""), sys2 = P_ITER + (strict ? P_STRICT : "");

        let outline = article && article.metadata.outline;
        if (!outline) {
            const r = await llmJson(ctx, "outline", sys1, `Evo cijelog diariziranog transkripta:${chapterBlock}${lastSec ? buildDurationBlock(lastSec) : ""}\n\n${srt}`);
            outline = Array.isArray(r.value) ? { iterations: r.value } : r.value;
            const dropped = lastSec ? clampOutline(outline, lastSec) : 0;
            if (dropped) console.warn(`      ⚠️  outline prelazio kraj snimke — odbačeno ${dropped} stavki`);
            if (!outline.iterations || !outline.iterations.length) throw new Error("outline bez iteracija");
            article = { metadata: { ...provenance, source_file: path.basename(ep.srt), generated_at: now(), strict_attribution: strict,
                                    outline, outline_json_first_try_strict: r.firstStrict, outline_dropped_beyond_end: dropped,
                                    iterations_expected: outline.iterations.length, complete: false }, iterations: [] };
            fs.writeFileSync(artPath, JSON.stringify(article, null, 2));
        }
        const done = new Set(article.iterations.map(i => i.iteration_number));
        for (const iter of outline.iterations) {
            if (done.has(iter.iteration_number)) continue;
            const details = `Fokusiraj se ISKLJUČIVO na iteraciju broj ${iter.iteration_number}.\n` +
                `Vremenski okvir: od ${iter.start_time} do ${iter.end_time}.\n` +
                `Tema: ${iter.theme}\n` +
                `Poglavlja u ovoj iteraciji:\n` +
                `${(iter.chapters || []).map(c => ` - ${c.timestamp}: ${c.topic}`).join("\n")}\n` +
                chapterBlock +
                `\nTranskript cijelog razgovora (iskoristi za kontekst i prepoznavanje imena, ali PIŠI SAMO O VREMENSKOM OKVIRU ${iter.start_time} - ${iter.end_time}):\n\n${srt}`;
            const step = `iteracija-${iter.iteration_number}`;
            const r = await llmJson(ctx, step, sys2, details);
            let sections = Array.isArray(r.value) ? r.value : r.value.sections;
            if (!Array.isArray(sections)) {
                const k = Object.keys(r.value || {}).find(k => Array.isArray(r.value[k]) && r.value[k].length);
                sections = k ? r.value[k] : [];
            }
            let schemaFix = false;
            const missing = sectionsMissingFields(sections);
            if (missing.length || !sections.length) {
                console.error(`      ⚠️  ${step}: nedostaju polja [${missing.join(", ") || "sections"}] — 1 korektivni poziv (kao produkcija)`);
                const fix = sys2 + `\n\nKRITIČNO: U prethodnom pokušaju izostavio si obavezna polja: ${missing.join(", ")}.` +
                    ` SVAKA sekcija u "sections" MORA sadržavati SVIH šest ključeva:` +
                    ` "subtitle", "screenshot_timestamp", "screenshot_description", "content", "keywords", "entities".` +
                    ` Nijedan ključ se ne smije izostaviti ni ostaviti prazan.`;
                try {
                    const f = await llmJson(ctx, `${step}.schemafix`, fix, details);
                    const fs2 = Array.isArray(f.value) ? f.value : f.value.sections;
                    if (Array.isArray(fs2) && fs2.length && !sectionsMissingFields(fs2).length) { sections = fs2; schemaFix = true; }
                } catch (e) { console.error(`      ⚠️  schema fix pao: ${e.message.slice(0, 160)}`); }
            }
            article.iterations.push({ iteration_number: iter.iteration_number, start_time: iter.start_time, end_time: iter.end_time,
                                      theme: iter.theme, sections, json_first_try_strict: r.firstStrict, schema_fix: schemaFix,
                                      missing_fields: sectionsMissingFields(sections) });
            article.metadata.complete = article.iterations.length === outline.iterations.length &&
                article.iterations.every(i => Array.isArray(i.sections) && i.sections.length);
            fs.writeFileSync(artPath, JSON.stringify(article, null, 2));
        }
    }

    // ── 3. EN prijevod: cijeli članak u jednom pozivu ──
    const enPath = outPath(ep, model, "clanak.en");
    if (WITH_EN && !fs.existsSync(enPath) && article.metadata.complete) {
        const src = { iterations: article.iterations.map(it => ({
            iteration_number: it.iteration_number, theme: it.theme,
            sections: it.sections.map(s => ({ subtitle: s.subtitle, screenshot_description: s.screenshot_description || "",
                                              content: s.content, keywords: s.keywords || [], entities: s.entities || [] })) })) };
        const r = await llmJson(ctx, "en", P_EN, JSON.stringify(src, null, 1));
        const en = r.value || {};
        // Spoji s HR strukturom (vremena iz HR) i izmjeri je li oblik sačuvan
        let shapeOk = Array.isArray(en.iterations) && en.iterations.length === src.iterations.length;
        const iterations = article.iterations.map((it, i) => {
            const e = (en.iterations || [])[i] || {};
            if (!Array.isArray(e.sections) || e.sections.length !== it.sections.length) shapeOk = false;
            return { iteration_number: it.iteration_number, start_time: it.start_time, end_time: it.end_time, theme: e.theme || null,
                     sections: it.sections.map((s, j) => {
                         const es = (e.sections || [])[j] || {};
                         return { subtitle: es.subtitle || null, screenshot_timestamp: s.screenshot_timestamp,
                                  screenshot_description: es.screenshot_description || null, content: es.content || null,
                                  keywords: es.keywords || null, entities: es.entities || null };
                     }) };
        });
        fs.writeFileSync(enPath, JSON.stringify({ metadata: { ...provenance, generated_at: now(), language: "en",
            json_first_try_strict: r.firstStrict, shape_preserved: shapeOk, hr_chars: JSON.stringify(src).length }, iterations }, null, 2));
        if (!shapeOk) console.warn(`      ⚠️  EN: oblik se ne poklapa s HR člankom (shape_preserved=false)`);
    }
    return article.metadata.complete;
}

// ─── --dry-run: plan poziva i procjena tokena ───
function dryRun(eps, models) {
    const CH_PER_TOK = 3.2;   // hr SRT s vremenima; grubo, za procjenu kvote
    let tot = { calls: 0, inTok: 0 };
    console.log("id            min  SRT KB  iter  pozivi  ulaz Mtok (po modelu)");
    for (const ep of eps) {
        const srt = fs.readFileSync(ep.srt, "utf-8");
        const min = Math.round(lastCueSeconds(srt) / 60);
        const iters = Math.max(1, Math.round(min / 40));
        const t = srt.length / CH_PER_TOK, tText = srtToText(srt).length / CH_PER_TOK;
        const calls = 1 + 1 + iters + 1;
        const inTok = tText + t + iters * t + 0.25 * t;   // sažetak + outline + N×SRT + EN (~¼ članka)
        tot.calls += calls; tot.inTok += inTok;
        console.log(`${ep.id.padEnd(13)} ${String(min).padStart(4)} ${String(Math.round(srt.length / 1024)).padStart(6)}  ${String(iters).padStart(4)}  ${String(calls).padStart(6)}  ${(inTok / 1e6).toFixed(2)}`);
    }
    console.log(`UKUPNO po modelu: ${tot.calls} poziva, ~${(tot.inTok / 1e6).toFixed(1)} M ulaznih tokena`);
    for (const m of models) {
        const c = MODELS[m];
        const out = tot.calls * 6000;   // grubo: ~6k izlaza po pozivu uklj. razmišljanje
        console.log(`  ${m.padEnd(17)} ≈ $${((tot.inTok * c.priceIn + out * c.priceOut) / 1e6).toFixed(2)}${c.kind === "claude-cli" ? " (ekvivalent — pretplata/kvota)" : ""}`);
    }
}

function summarize() {
    const rows = fs.readFileSync(CALLS_LOG, "utf-8").trim().split("\n").map(l => JSON.parse(l));
    const by = {};
    for (const r of rows) {
        const k = r.input ? `${r.input}.${r.model}` : r.model;
        const m = by[k] || (by[k] = { calls: 0, err: 0, inTok: 0, outTok: 0, thinkTok: 0, usd: 0, ms: 0, strict: 0, lenient: 0, eps: new Set() });
        m.calls++; m.eps.add(r.id);
        if (r.error) { m.err++; continue; }
        m.inTok += r.inTok; m.outTok += r.outTok; m.thinkTok += r.thinkTok || 0; m.usd += r.usd; m.ms += r.ms;
        if (r.jsonStrict) m.strict++; if (r.jsonLenient) m.lenient++;
    }
    console.log("model              ep  pozivi greške  ulaz Mtok  izlaz ktok  💭 ktok   $       $/ep    s/poziv  JSON strogo/blago");
    for (const [k, m] of Object.entries(by)) {
        const ok = m.calls - m.err;
        console.log(`${k.padEnd(17)} ${String(m.eps.size).padStart(3)} ${String(m.calls).padStart(7)} ${String(m.err).padStart(7)}  ${(m.inTok / 1e6).toFixed(2).padStart(9)}  ${(m.outTok / 1e3).toFixed(0).padStart(10)}  ${(m.thinkTok / 1e3).toFixed(0).padStart(7)}  ${m.usd.toFixed(2).padStart(6)}  ${(m.usd / m.eps.size).toFixed(3).padStart(6)}  ${(m.ms / ok / 1000).toFixed(1).padStart(7)}  ${m.strict}/${m.lenient}/${ok}`);
    }
}

async function main() {
    if (hasFlag("--summary")) return summarize();
    const modelArg = getArg("--model");
    const models = modelArg === "all" ? Object.keys(MODELS) : (modelArg || "").split(",").filter(Boolean);
    for (const m of models) if (!MODELS[m]) { console.error(`Nepoznat model: ${m}. Dostupni: ${Object.keys(MODELS).join(", ")}`); process.exit(2); }
    if (!models.length) { console.error("--model <slug|all> obavezan"); process.exit(2); }
    const ids = (getArg("--id") || "").split(",").filter(Boolean);
    let eps = loadEpisodes().filter(e => !ids.length || ids.includes(e.id));
    for (const e of eps) if (!fs.existsSync(e.srt)) { console.error(`Nema ulaza: ${e.srt}`); process.exit(2); }
    if (hasFlag("--dry-run")) return dryRun(eps, models);
    if (models.some(m => MODELS[m].kind === "claude-cli") && process.env.ANTHROPIC_API_KEY) {
        console.error("⛔ ANTHROPIC_API_KEY je postavljen — claude -p bi mogao prijeći na per-token naplatu. Unset pa ponovi.");
        process.exit(2);
    }
    // Najkraće prvo: rane greške koštaju najmanje
    eps.sort((a, b) => fs.statSync(a.srt).size - fs.statSync(b.srt).size);
    let failed = 0;
    for (const model of models) {
        for (const ep of eps) {
            console.log(`\n▶ ${model} ← ${INPUT_TOOL} · ${ep.id} · ${ep.kanal}`);
            const t0 = Date.now();
            try {
                const ok = await processEpisode(ep, model);
                console.log(`   ${ok ? "✅" : "⚠️  nekompletno"} ${((Date.now() - t0) / 1000).toFixed(0)} s`);
            } catch (e) {
                failed++;
                console.error(`   ❌ ${e.message}`);
            }
        }
    }
    console.log(`\ngotovo — grešaka: ${failed}`);
    if (failed) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exit(1); });
