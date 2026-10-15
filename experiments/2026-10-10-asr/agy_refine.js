#!/usr/bin/env node
// KORAK 2.8 („Gemini sluh") kroz `agy` (Antigravity CLI, Google AI Pro pretplata) umjesto Vertexa.
//
//   node experiments/2026-10-10-asr/agy_refine.js --id OspwepfLObY [--skeleton canary-1b-v2+pyannote-c1]
//
// Kostur (govornik + vremena) dolazi iz postojećeg dijariziranog SRT-a; agy SLUŠA isječak po
// prozoru i prepisuje SAMO tekst. Prompt je doslovno SKELETON_PROMPT iz refine_diarized_gemini.js
// (izvlači se pri svakom pokretanju), prozori kao u produkciji (≤10 min, ≤70 segmenata).
//
// Zašto tmux: `agy -p` (1.3.5) pošalje zahtjev, ali odgovor nikad ne stigne na izlaz (print
// timeout, prazan response) — interaktivni način radi. Zato skripta tipka u interaktivnu
// sesiju (`tmux send-keys`) i čeka da agy zapiše izlaznu datoteku. Gledanje: `tmux attach -t agyi`.
// Radni dir mora biti „trusted" u agy-ju (inače agy pita i visi).
"use strict";
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");

const EXP = __dirname, REPO = path.resolve(EXP, "../..");
const TAG = "exp-20261010";
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : d; };
const ID = getArg("--id");
const SKEL = getArg("--skeleton", "canary-1b-v2+pyannote-c1");
const SESSION = getArg("--session", "agyi");
const WORK = getArg("--work-dir");             // agy-trusted direktorij (cwd tmux sesije)
const WINDOW_SEC = parseFloat(getArg("--window-min", "10")) * 60;
const MAX_SEGS = parseInt(getArg("--max-segments", "70"), 10);
const TIMEOUT_MS = parseInt(getArg("--timeout-min", "15"), 10) * 60000;
const BACKEND = getArg("--backend", "agy");     // agy | vertex (ista podjela na prozore, isti prompt)
const MODEL_SLUG = getArg("--slug", BACKEND === "vertex" ? "vertex-gemini-3-8-flash" : "agy-gemini-3-8-flash");
if (!ID || !WORK) { console.error("Treba --id i --work-dir"); process.exit(2); }

// ── Vertex grana: isti poziv kao refine_diarized_gemini.js (inlineData + responseSchema, temp 0) ──
const { vertexEndpointUrl, vertexAccessToken } = require(path.join(REPO, "lib/vertex_auth.js"));
const CONF = Object.fromEntries(fs.readFileSync(path.join(REPO, "gemini.conf"), "utf-8").split("\n")
    .filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const REGIONS = (CONF.VERTEX_REGIONS || "global").split(",");
const SEGMENT_SCHEMA = { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "INTEGER" }, text: { type: "STRING" } }, required: ["id", "text"] } };
const vertexUsage = { in: 0, out: 0, think: 0 };
async function callVertex(clip, promptText) {
    const body = {
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/mpeg", data: fs.readFileSync(clip).toString("base64") } }, { text: promptText }] }],
        generationConfig: { temperature: 0.0, maxOutputTokens: 65536, responseMimeType: "application/json", responseSchema: SEGMENT_SCHEMA },
    };
    for (let attempt = 0; attempt < 9; attempt++) {
        const url = vertexEndpointUrl(CONF.VERTEX_PROJECT, REGIONS[attempt % REGIONS.length], CONF.GEMINI_MODEL);
        const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${vertexAccessToken({ account: CONF.VERTEX_ACCOUNT })}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await res.json();
        if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, attempt < REGIONS.length ? 1000 : 20000)); continue; }
        if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
        const u = data.usageMetadata || {};
        vertexUsage.in += u.promptTokenCount || 0; vertexUsage.out += u.candidatesTokenCount || 0; vertexUsage.think += u.thoughtsTokenCount || 0;
        return ((data.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
    }
    throw new Error("Vertex: iscrpljeni pokušaji (429/5xx)");
}

// ── produkcijski prompt, doslovno ──
const src = fs.readFileSync(path.join(REPO, "refine_diarized_gemini.js"), "utf-8");
const m = src.match(/const SKELETON_PROMPT = `([\s\S]*?)`;/);
if (!m || m[1].includes("${")) throw new Error("SKELETON_PROMPT nije pronađen ili ima interpolaciju");
const PROMPT = m[1].replace("%JEZIK%", "hrvatskom jeziku");

// ── ulaz ──
const row = fs.readFileSync(path.join(EXP, "bases.tsv"), "utf-8").trim().split("\n").slice(1).map(l => l.split("\t")).find(r => r[0] === ID);
if (!row) throw new Error(`${ID} nije u bases.tsv`);
const [, kanal, base] = row;
const dir = path.join(EXP, "data/output", kanal);
const srtPath = path.join(dir, `${base}.${TAG}.${SKEL}.dijariziran.srt`);
const audio = path.join(EXP, "data/audio", `${ID}.mp3`);
const outPath = path.join(dir, `${base}.${TAG}.${SKEL}+${MODEL_SLUG}.dijariziran.srt`);

const ts = (s) => { const [h, mi, r] = s.trim().replace(",", ".").split(":"); return +h * 3600 + +mi * 60 + parseFloat(r); };
const segs = fs.readFileSync(srtPath, "utf-8").trim().split(/\n\n+/).map(b => {
    const L = b.split("\n"); const [a, z] = L[1].split(" --> ");
    const txt = L.slice(2).join(" "); const sm = txt.match(/^\[(\w+)\]\s*/);
    return { times: L[1], start: ts(a), end: ts(z), speaker: sm ? sm[1] : "?", text: sm ? txt.slice(sm[0].length) : txt };
});

const wins = [];
for (let i = 0; i < segs.length;) {
    const idx = [], st = segs[i].start;
    for (let j = i; j < segs.length && idx.length < MAX_SEGS && (idx.length === 0 || segs[j].end - st <= WINDOW_SEC); j++) idx.push(j);
    wins.push(idx); i += idx.length;
}

const tmux = (...a) => execFileSync("tmux", a, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);

async function ask(text) {
    tmux("send-keys", "-t", SESSION, "-l", text);
    await sleep(500);
    tmux("send-keys", "-t", SESSION, "Enter");
}

(async () => {
    log(`${ID}: ${segs.length} segmenata, ${wins.length} prozora → ${path.relative(EXP, outPath)}`);
    const texts = new Map(), t0 = Date.now(), perWin = [];
    for (let w = 0; w < wins.length; w++) {
        const idx = wins[w];
        const b = Math.max(0, segs[idx[0]].start - 0.5);
        const dur = segs[idx[idx.length - 1]].end - b + 1.0;
        const stem = `${ID}-w${w + 1}`;
        const clip = path.join(WORK, `${stem}.mp3`), pf = path.join(WORK, `${stem}.upute.md`), of = path.join(WORK, `${stem}.izlaz.json`);
        execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(b), "-t", String(dur), "-i", audio, "-c:a", "libmp3lame", "-b:a", "64k", clip]);
        const listing = idx.map(j => ({ id: j, od: Math.round((segs[j].start - b) * 10) / 10, do: Math.round((segs[j].end - b) * 10) / 10, govornik: segs[j].speaker, speechmatics: segs[j].text }));
        fs.writeFileSync(pf, PROMPT + JSON.stringify(listing));
        try { fs.unlinkSync(of); } catch (_) {}

        const tw = Date.now();
        log(`prozor ${w + 1}/${wins.length}: ${idx.length} seg., ${(dur / 60).toFixed(1)} min zvuka`);
        let parsed = null;
        if (BACKEND === "vertex") {
            try { parsed = JSON.parse(await callVertex(clip, fs.readFileSync(pf, "utf-8"))); } catch (e) { log(`   Vertex greška: ${e.message}`); }
        } else {
            await ask("/clear"); await sleep(3000);
            await ask(`Pročitaj upute u datoteci ${stem}.upute.md i izvrši ih nad zvučnim isječkom ${stem}.mp3 (poslušaj zvuk). ` +
                `Izlaz (samo JSON niz, ništa drugo) zapiši u datoteku ${stem}.izlaz.json. Ne pokreći skripte ni alate za transkripciju.`);
        }
        while (BACKEND === "agy" && Date.now() - tw < TIMEOUT_MS) {
            await sleep(5000);
            if (!fs.existsSync(of)) continue;
            try { parsed = JSON.parse(fs.readFileSync(of, "utf-8").replace(/^```(json)?\s*|\s*```$/g, "")); break; } catch (_) { /* još piše */ }
        }
        if (!parsed) { log(`⚠️  prozor ${w + 1}: nema valjanog izlaza nakon ${TIMEOUT_MS / 60000} min — zadržavam kostur`); continue; }
        let n = 0;
        for (const o of parsed) if (idx.includes(o.id) && typeof o.text === "string") { texts.set(o.id, o.text.trim()); n++; }
        const s = (Date.now() - tw) / 1000; perWin.push(s);
        log(`   ✓ ${n}/${idx.length} segmenata, ${s.toFixed(0)} s`);
    }

    // sastavi SRT; prazan ili nedostajući segment → tekst kostura (kao fallback u produkciji)
    let kept = 0, empty = 0;
    const out = segs.map((s, j) => {
        let t = texts.get(j);
        if (t === undefined) { t = s.text; kept++; } else if (!t) { t = s.text; empty++; }
        return `${j + 1}\n${s.times}\n[${s.speaker}] ${t}`;
    });
    fs.writeFileSync(outPath, out.join("\n\n") + "\n");
    const words = (a) => a.reduce((x, y) => x + y.split(/\s+/).filter(Boolean).length, 0);
    log(`gotovo za ${((Date.now() - t0) / 60000).toFixed(1)} min: ${texts.size}/${segs.length} prepisano, ` +
        `${kept} bez izlaza, ${empty} prazno → kostur; riječi ${words(segs.map(s => s.text))} → ${words([...texts.values()])}`);
    if (BACKEND === "vertex") {
        const usd = (vertexUsage.in * parseFloat(CONF.GEMINI_PRICE_IN) + (vertexUsage.out + vertexUsage.think) * parseFloat(CONF.GEMINI_PRICE_OUT)) / 1e6;
        log(`Vertex tokeni: ulaz ${vertexUsage.in}, izlaz ${vertexUsage.out}, razmišljanje ${vertexUsage.think} ≈ $${usd.toFixed(3)} (procjena po cjeniku iz gemini.conf)`);
    }
})();
