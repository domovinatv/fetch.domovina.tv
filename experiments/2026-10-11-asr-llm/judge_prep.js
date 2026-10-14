#!/usr/bin/env node
// Faza 3b, priprema: anonimizirani paketi za slijepu ocjenu članaka (Opus subagenti).
//
//   node experiments/2026-10-11-asr-llm/judge_prep.js            # svih 14
//   node experiments/2026-10-11-asr-llm/judge_prep.js --id X
//
// Izlaz: data/slijepo/<id>/transkript.srt + <SLOVO>.md (sažetak + članak, bez ikakvog traga
// modela), data/slijepo/kljuc.json (slovo → model). Poredak slova je nasumičan PO EPIZODI,
// pa ocjenjivač ne može naučiti „A je uvijek Gemini". Za 2 referentne epizode dodaje se i
// produkcijski Opus članak (`storage/output`, samo čitanje) kao peti kandidat.
// Ocjenjivač NE smije čitati kljuc.json ni data/output — vidi prompt u README §Faza 3b.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const EXP = __dirname, REPO = path.resolve(EXP, "../..");
const OUT = path.join(EXP, "data/output"), DST = path.join(EXP, "data/slijepo");
const TAG = "exp-20261011";
const MODELS = ["gemini-3-8-flash", "gemini-4-argon", "haiku-5-5", "sonnet-5-5"];
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

const rows = fs.readFileSync(path.join(EXP, "bases.tsv"), "utf-8").trim().split("\n").slice(1).map(l => l.split("\t"));
const key = fs.existsSync(path.join(DST, "kljuc.json")) ? JSON.parse(fs.readFileSync(path.join(DST, "kljuc.json"), "utf-8")) : {};
for (const [id, kanal, base] of rows) {
    if (onlyId && id !== onlyId) continue;
    const dir = path.join(OUT, kanal);
    const cands = [];
    for (const m of MODELS) {
        const ap = path.join(dir, `${base}.${TAG}.${m}.clanak.json`), sp = path.join(dir, `${base}.${TAG}.${m}.sazetak.json`);
        if (!fs.existsSync(ap)) { console.warn(`⚠️  ${id}: nema članka ${m}`); continue; }
        const a = JSON.parse(fs.readFileSync(ap, "utf-8"));
        if (!a.metadata.complete) console.warn(`⚠️  ${id}: ${m} članak NEKOMPLETAN`);
        cands.push({ model: m, md: render(fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf-8")).summary : null, a) });
    }
    // produkcijski Opus (referentne epizode) — drugi transkript (Speechmatics + Gemini refine), označeno u ključu
    const prodDir = path.join(REPO, "storage/output", kanal);
    const prod = fs.existsSync(prodDir) ? fs.readdirSync(prodDir).filter(f => f.startsWith(base) && /_opus\.article\.json$/.test(f)).sort().pop() : null;
    if (prod) {
        const a = JSON.parse(fs.readFileSync(path.join(prodDir, prod), "utf-8"));
        const sp = path.join(prodDir, `${base}.wav.canary.summary.json`);
        const s = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf-8")) : null;
        cands.push({ model: "produkcija-opus", md: render(s && (s.summary || s), a) });
    }
    // nasumičan poredak, deterministički po epizodi (ponovno pokretanje daje isti ključ)
    const seed = crypto.createHash("sha256").update("slijepo-" + id).digest();
    cands.sort((x, y) => seed[MODELS.indexOf(x.model) + 1] - seed[MODELS.indexOf(y.model) + 1] || x.model.localeCompare(y.model));
    const ed = path.join(DST, id);
    fs.mkdirSync(ed, { recursive: true });
    fs.copyFileSync(path.join(dir, `${base}.${TAG}.speechmatics-enhanced.dijariziran.srt`), path.join(ed, "transkript.srt"));
    key[id] = {};
    cands.forEach((c, i) => {
        const L = String.fromCharCode(65 + i);
        fs.writeFileSync(path.join(ed, `${L}.md`), c.md);
        key[id][L] = c.model;
    });
    console.log(`${id}: ${cands.length} kandidata → ${ed}`);
}
fs.writeFileSync(path.join(DST, "kljuc.json"), JSON.stringify(key, null, 2));
