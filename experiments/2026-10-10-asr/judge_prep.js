#!/usr/bin/env node
// Slijepa ocjena, priprema: isti LLM (Opus 5.5), tri ASR ulaza → anonimizirani paketi.
//
//   node experiments/2026-10-10-asr/judge_prep.js            # svih 15
//   node experiments/2026-10-10-asr/judge_prep.js --id X
//
// Kopija ../2026-10-11-asr-llm/judge_prep.js; ključ je ovdje ASR, ne model.
// Izlaz: data/slijepo/<id>/{A,B,C}.md (sažetak + članak) i transkript_{X,Y,Z}.srt (sva tri
// dijarizirana prijepisa kao referenca, jer nijedan nije istina). Slova članaka i slova
// transkripata miješaju se NEOVISNO, pa ocjenjivač ne može spariti „članak A ← transkript X".
// data/slijepo/kljuc.json: { id: { clanci: {A: asr}, transkripti: {X: asr} } }.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const EXP = __dirname;
const OUT = path.join(EXP, "data/output"), DST = path.join(EXP, "data/slijepo");
const TAG = "exp-20261010";
const ASR = {
    "speechmatics-enhanced": "speechmatics-enhanced",
    "deepgram-nova3": "deepgram-nova3",
    "canary-1b-v2+pyannote-c1": "canary-1b-v2+pyannote-c1",
};
const args = process.argv.slice(2);
const onlyId = (() => { const i = args.indexOf("--id"); return i !== -1 ? args[i + 1] : null; })();

function render(summary, article) {
    const L = [];
    if (summary) {
        L.push(`# Sažetak`, ``, `**Naslov:** ${summary.title_hr || ""}`, ``, summary.abstract_hr || "", ``);
        L.push(`**Govornici:** ` + (summary.speakers || []).map(s => `${s.id} = ${s.suggested_name} (${s.role || "?"})`).join("; "), ``);
        L.push(`**Ključne točke:**`, ...(summary.key_points || []).map(p => `- ${p}`), ``);
        L.push(`**Spomenute osobe:** ${(summary.mentioned_people || []).join(", ")}`, ``);
    }
    L.push(`# Članak`, ``);
    for (const it of article.iterations || []) {
        L.push(`## Dio ${it.iteration_number}: ${it.theme || ""} (${it.start_time}–${it.end_time})`, ``);
        for (const s of it.sections || []) {
            L.push(`### ${s.subtitle || "(bez podnaslova)"}`, `*[slika ${s.screenshot_timestamp || "?"}: ${s.screenshot_description || ""}]*`, ``, s.content || "", ``);
        }
    }
    return L.join("\n");
}

// deterministički nasumičan poredak po epizodi i namjeni (ponovno pokretanje daje isti ključ)
function shuffled(list, salt) {
    const h = (x) => crypto.createHash("sha256").update(`${salt}|${x}`).digest("hex");
    return [...list].sort((a, b) => h(a).localeCompare(h(b)));
}

const rows = fs.readFileSync(path.join(EXP, "bases.tsv"), "utf-8").trim().split("\n").slice(1).map(l => l.split("\t"));
const keyPath = path.join(DST, "kljuc.json");
const key = fs.existsSync(keyPath) ? JSON.parse(fs.readFileSync(keyPath, "utf-8")) : {};
for (const [id, kanal, base] of rows) {
    if (onlyId && id !== onlyId) continue;
    const dir = path.join(OUT, kanal);
    const asrs = Object.keys(ASR).filter(a => {
        const ok = fs.existsSync(path.join(dir, `${base}.${TAG}.${a}.opus-5-5.clanak.json`));
        if (!ok) console.warn(`⚠️  ${id}: nema članka nad ${a}`);
        return ok;
    });
    const ed = path.join(DST, id);
    fs.mkdirSync(ed, { recursive: true });
    key[id] = { clanci: {}, transkripti: {} };
    shuffled(asrs, `clanak-${id}`).forEach((a, i) => {
        const L = String.fromCharCode(65 + i);
        const art = JSON.parse(fs.readFileSync(path.join(dir, `${base}.${TAG}.${a}.opus-5-5.clanak.json`), "utf-8"));
        if (art.metadata && art.metadata.complete === false) console.warn(`⚠️  ${id}: članak nad ${a} NEKOMPLETAN`);
        const sp = path.join(dir, `${base}.${TAG}.${a}.opus-5-5.sazetak.json`);
        const sum = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf-8")) : null;
        fs.writeFileSync(path.join(ed, `${L}.md`), render(sum && (sum.summary || sum), art));
        key[id].clanci[L] = a;
    });
    shuffled(asrs, `transkript-${id}`).forEach((a, i) => {
        const L = String.fromCharCode(88 + i); // X, Y, Z
        fs.copyFileSync(path.join(dir, `${base}.${TAG}.${a}.dijariziran.srt`), path.join(ed, `transkript_${L}.srt`));
        key[id].transkripti[L] = a;
    });
    // epizode koje pipeline već ima: info.json je u produkcijskom kanalskom diru (samo čitanje)
    const info = [path.join(dir, `${base}.info.json`), path.join(EXP, "../../storage/output", kanal, `${base}.info.json`)].find(p => fs.existsSync(p));
    if (info) {
        const j = JSON.parse(fs.readFileSync(info, "utf-8"));
        fs.writeFileSync(path.join(ed, "epizoda.txt"), `Naslov: ${j.title}\nKanal: ${j.channel || j.uploader || ""}\n\nOpis:\n${j.description || ""}\n`);
    }
    console.log(`${id}: ${asrs.length} članka → ${ed}`);
}
fs.writeFileSync(keyPath, JSON.stringify(key, null, 2));
