#!/usr/bin/env node
/**
 * blind_speaker_check.js — SLIJEPA provjera imenovanja iz faze 03.
 *
 * ═══ Zašto obična usporedba s bilješkama faze 04 ne vrijedi ═══
 *
 * Prozori koje faza 04 šalje modelu već sadrže imena koja je faza 03 pripisala
 * („[02:12:42 | SPEAKER_001] Sandra Benčić (Možemo!): …"). Model koji ih zatim
 * „potvrdi" nije ništa provjerio — prepisao je odgovor koji mu je dan. Prvo
 * mjerenje na ovoj sjednici dalo je 98.9 % slaganja upravo tako, i ta je
 * brojka bezvrijedna.
 *
 * Ovaj alat modelu daje transkript s **golim oznakama** (`SPEAKER_042`) i traži
 * da identitet izvede iz konteksta: kako se govornik sam predstavi, kako ga
 * drugi oslovljavaju, čijim se klubom predstavlja. Tek se onda uspoređuje s
 * fazom 03. Neslaganje je tada stvaran nalaz, a ne odjek.
 *
 * Model NE dobiva registar zastupnika — inače bi popis imena sam po sebi bio
 * navođenje. Imena koja izmisli hvata se naknadno, kroz `RosterMatcher`.
 *
 *   node sabor_pipeline/tools/blind_speaker_check.js --session <id> --windows 0,4,9
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { RosterMatcher } = require("../utils/roster_match.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const getArg = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : d; };

const SESSION = getArg("--session");
const BACKEND = getArg("--backend", "agy");
const MODEL = getArg("--model", BACKEND === "agy" ? "gemini-3.7-flash-high" : "opus");
const WINDOW_CHARS = Number(getArg("--window-chars", 45000));
const PICK = (getArg("--windows", "0") || "").split(",").map(Number).filter((n) => !Number.isNaN(n));
const TIMEOUT_MS = Number(getArg("--timeout", 900)) * 1000;

if (!SESSION) { console.error("Uporaba: --session <id> [--windows 0,4,9]"); process.exit(2); }

const sessionDir = path.join(getArg("--output-dir", path.join(REPO_ROOT, "storage", "output", "sabor")), SESSION);
const aligned = JSON.parse(fs.readFileSync(path.join(sessionDir, "aligned_transcript.json"), "utf8"));
const roster = JSON.parse(fs.readFileSync(
    getArg("--roster", path.join(__dirname, "..", "data", "rosters", "sabor_mps_11_saziv.json")), "utf8"));
const matcher = new RosterMatcher(roster);
const outDir = path.join(sessionDir, `blind_check_${BACKEND}`);
fs.mkdirSync(outDir, { recursive: true });

/** ⚠️ Gola oznaka — nikakvo ime, nikakva uloga. To je cijela poanta alata. */
const renderBlind = (b) => `[${b.start_hms} | ${b.speaker_id}] ${b.text}`;

function buildWindows(blocks, target) {
    const w = []; let cur = [], size = 0;
    for (const b of blocks) {
        const r = renderBlind(b);
        if (size + r.length > target && cur.length) { w.push(cur); cur = [cur[cur.length - 1]]; size = renderBlind(cur[0]).length; }
        cur.push(b); size += r.length + 2;
    }
    if (cur.length > 1 || !w.length) w.push(cur);
    return w;
}

const SYSTEM = `Ti si analitičar koji iz doslovnog transkripta sjednice Hrvatskoga sabora pokušava utvrditi TKO je koji govornik.
Transkript je strojni (ASR) pa sadrži pogreške u imenima. Govornici su označeni samo šifrom (SPEAKER_042).

Identitet izvodiš ISKLJUČIVO iz konteksta:
- kako predsjedavajući najavi govornika prije njegova istupa,
- kako se govornik sam predstavi ili u čije ime govori,
- kako ga drugi oslovljavaju tijekom replika.

TVRDA PRAVILA:
1. Ako iz konteksta ne možeš razaznati ime, upiši null. NE POGAĐAJ. Nesigurno pogođeno ime je gore od priznatog neznanja.
2. Uz svako ime navedi doslovan dokaz iz transkripta i njegov timestamp.
3. Vraćaš ISKLJUČIVO valjan JSON, bez teksta izvan njega.`;

const userPrompt = (text, blocks) => `Transkript 11. izvanredne sjednice Hrvatskoga sabora (20.–21. 8. 2026., opasni otpad u Gospiću).
Raspon: ${blocks[0].start_hms} – ${blocks[blocks.length - 1].start_hms}.

Za SVAKU šifru koja se pojavljuje vrati stavku:
{"identifikacije": [
  {"speaker_id": "SPEAKER_042",
   "ime": "Ime Prezime ili null",
   "uloga": "zastupnik|predsjedavajući|član Vlade|nepoznato",
   "dokaz": "doslovan citat iz kojeg si to zaključio",
   "dokaz_timestamp": "HH:MM:SS",
   "sigurnost": "visoka|srednja|niska"}
]}

TRANSKRIPT:
${text}`;

function call(system, user) {
    if (BACKEND === "claude") {
        const neutral = fs.mkdtempSync(path.join(os.tmpdir(), "blind-"));
        return run("claude", ["-p", "--model", MODEL, "--tools", "", "--append-system-prompt", system], user, { cwd: neutral })
            .finally(() => { try { fs.rmSync(neutral, { recursive: true, force: true }); } catch (_) {} });
    }
    return run("agy", ["-p", `${system}\n\n---\n\n${user}`, "--model", MODEL,
                       "--output-format", "json", "--dangerously-skip-permissions"], null)
        .then((o) => {
            const env = JSON.parse(o);
            if (env.status !== "SUCCESS") throw new Error(`agy status=${env.status}`);
            return String(env.response || "");
        });
}

function run(cmd, argv, stdin, opts = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, argv, { stdio: ["pipe", "pipe", "pipe"], ...opts });
        let out = "", err = "";
        const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("timeout")); }, TIMEOUT_MS);
        p.stdout.on("data", (d) => { out += d; });
        p.stderr.on("data", (d) => { err += d; });
        p.on("error", (e) => { clearTimeout(t); reject(e); });
        p.on("close", (c) => { clearTimeout(t); c === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${c}: ${(err || out).slice(0, 300)}`)); });
        p.stdin.on("error", () => {});
        p.stdin.end(stdin == null ? "" : stdin);
    });
}

function extractJson(t) {
    const s = String(t); const f = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    const b = f ? f[1] : s; const i = b.indexOf("{"), j = b.lastIndexOf("}");
    if (i === -1) throw new Error(`nema JSON-a: ${s.slice(0, 200)}`);
    return JSON.parse(b.slice(i, j + 1));
}

(async () => {
    const windows = buildWindows(aligned.blocks, WINDOW_CHARS);
    const truth = new Map();          // speaker_id → ime iz faze 03
    for (const b of aligned.blocks) if (b.speaker_name) truth.set(b.speaker_id, b.speaker_name);
    const chairs = new Set(aligned.chairs);

    console.log(`Slijepa provjera: ${BACKEND}/${MODEL}, prozori ${PICK.join(", ")} od ${windows.length}\n`);
    let ok = 0, wrong = 0, modelNull = 0, phaseNull = 0, invented = 0;
    const wrongRows = [], newRows = [];

    for (const wi of PICK) {
        if (!windows[wi]) { console.log(`prozor ${wi} ne postoji`); continue; }
        const blocks = windows[wi];
        const cache = path.join(outDir, `w${String(wi).padStart(2, "0")}.json`);
        let res;
        if (fs.existsSync(cache)) { res = JSON.parse(fs.readFileSync(cache, "utf8")); }
        else {
            const text = blocks.map(renderBlind).join("\n\n");
            res = extractJson(await call(SYSTEM, userPrompt(text, blocks)));
            fs.writeFileSync(cache, JSON.stringify(res, null, 1) + "\n", "utf8");
        }
        console.log(`── prozor ${wi}  ${blocks[0].start_hms}–${blocks[blocks.length - 1].start_hms}`);
        for (const id of res.identifikacije || []) {
            const sid = id.speaker_id;
            const phase = truth.get(sid) || null;
            const guess = id.ime ? String(id.ime).replace(/\([^)]*\)/g, "").trim() : null;
            const r = guess ? matcher.resolve(guess) : { mp: null };
            const norm = r.mp ? r.mp.puno_ime : guess;

            if (!guess) { if (phase) { phaseNull++; console.log(`   ${sid}  model NE ZNA, faza 03 kaže ${phase}`); } continue; }
            if (!r.mp && !chairs.has(sid)) { invented++; console.log(`   ${sid}  ✖ model navodi ime izvan registra: „${guess}"`); continue; }
            if (!phase) {
                modelNull++; newRows.push([sid, norm, id.dokaz_timestamp, id.sigurnost]);
                console.log(`   ${sid}  ⊕ model: ${norm} (${id.sigurnost}) — faza 03 nema ime`);
                continue;
            }
            if (norm === phase) { ok++; }
            else { wrong++; wrongRows.push([sid, phase, norm, id.dokaz_timestamp, id.dokaz]);
                   console.log(`   ${sid}  ✖ NESLAGANJE  faza 03: ${phase}   model: ${norm} (${id.sigurnost})`); }
        }
    }

    const cmp = ok + wrong;
    console.log(`\n═══ REZULTAT (slijepo) ═══`);
    console.log(`usporedivih (obje strane imenovale): ${cmp}`);
    console.log(`  slaganje:   ${ok}  (${cmp ? ((100 * ok) / cmp).toFixed(1) : 0} %)`);
    console.log(`  neslaganje: ${wrong}`);
    console.log(`model imenovao gdje faza 03 nije: ${modelNull}  → potencijalno PROPUŠTENA sidra`);
    console.log(`model ne zna gdje faza 03 zna:    ${phaseNull}`);
    console.log(`model izmislio ime izvan registra: ${invented}`);
    if (wrongRows.length) {
        console.log(`\nNeslaganja za ručni pregled:`);
        for (const [sid, p, mdl, ts, dok] of wrongRows) {
            console.log(`  ${sid}  faza03=${p}  model=${mdl}  [${ts}]`);
            console.log(`      dokaz modela: ${String(dok).slice(0, 140)}`);
        }
    }
    fs.writeFileSync(path.join(outDir, "rezultat.json"),
        JSON.stringify({ backend: BACKEND, model: MODEL, windows: PICK, ok, wrong, modelNull, phaseNull, invented, wrongRows, newRows }, null, 2) + "\n");
})().catch((e) => { console.error("GREŠKA:", e.message); process.exit(1); });
