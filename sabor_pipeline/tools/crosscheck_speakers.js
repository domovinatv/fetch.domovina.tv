#!/usr/bin/env node
/**
 * crosscheck_speakers.js — neovisna provjera imenovanja iz faze 03, besplatno.
 *
 * Faza 03 imenuje govornike **deterministički**: iz protokolarne najave
 * predsjedavajućeg, bez ijednog LLM poziva. To znači da nitko nikad nije
 * pročitao ono što imenovana osoba govori i potvrdio da se poklapa.
 *
 * Faza 04 (klizni prozor) usput proizvodi upravo tu potvrdu: model koji piše
 * bilješke po prozoru vidi tekst i navodi tko je govorio. Ako model za neki
 * prozor navede ime koje faza 03 u tom rasponu NIJE pripisala nijednoj oznaci
 * — ili obrnuto — to je mjesto koje treba pogledati.
 *
 * ⚠️ Ovo NIJE arbitraža. Model može halucinirati ime jednako lako kao što
 * sidrenje može promašiti. Alat proizvodi **popis neslaganja za pregled**,
 * ne presudu o tome tko je u pravu.
 *
 *   node sabor_pipeline/tools/crosscheck_speakers.js --session <id> \
 *        --notes storage/output/sabor/<id>/article_agy_.../windows
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { RosterMatcher } = require("../utils/roster_match.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const getArg = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : d; };

const SESSION = getArg("--session");
const NOTES_DIR = getArg("--notes");
if (!SESSION || !NOTES_DIR) {
    console.error("Uporaba: --session <id> --notes <dir s wNN.json>");
    process.exit(2);
}
const sessionDir = path.join(getArg("--output-dir", path.join(REPO_ROOT, "storage", "output", "sabor")), SESSION);
const aligned = JSON.parse(fs.readFileSync(path.join(sessionDir, "aligned_transcript.json"), "utf8"));
const roster = JSON.parse(fs.readFileSync(
    getArg("--roster", path.join(__dirname, "..", "data", "rosters", "sabor_mps_11_saziv.json")), "utf8"));
const matcher = new RosterMatcher(roster);

const hmsToSec = (s) => {
    const m = String(s || "").match(/(\d{1,2}):(\d{2}):(\d{2})/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

const files = fs.readdirSync(NOTES_DIR).filter((f) => /^w\d+\.json$/.test(f)).sort();
if (!files.length) { console.error(`Nema bilježaka u ${NOTES_DIR}`); process.exit(1); }

let agree = 0, modelOnly = 0, phaseOnly = 0;
const rows = [];

for (const f of files) {
    const n = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, f), "utf8"));
    const from = hmsToSec(n.raspon && n.raspon.od);
    const to = hmsToSec(n.raspon && n.raspon.do);
    if (from == null || to == null) continue;

    // Tko je po fazi 03 govorio u ovom rasponu.
    const phase = new Set(
        aligned.blocks
            .filter((b) => b.end_global_sec > from && b.start_global_sec < to + 1)
            .map((b) => b.speaker_name)
            .filter(Boolean)
    );

    // Tko je po modelu govorio — imena se provuku kroz isti registar da bi se
    // uspoređivala ista normalizirana imena, a ne slobodan tekst.
    const model = new Set();
    const modelUnresolved = [];
    for (const g of n.govornici || []) {
        // Model vraća ime u obliku „Marijana Petir (NZ)" — zagrada je stranka,
        // a ne dio imena. Bez skidanja postaje nepodudaren token i obara
        // rezultat ispod praga, pa se svaki govornik lažno prikaže kao neslaganje.
        const clean = String(g.ime || "").replace(/\([^)]*\)/g, "").replace(/\[[^\]]*\]/g, "").trim();
        const r = matcher.resolve(clean);
        if (r.mp) model.add(r.mp.puno_ime);
        else if (clean && !/neimenovan|predsjedavaju|član vlade|ministric|ministar/i.test(clean)) {
            modelUnresolved.push(clean);
        }
    }

    const both = [...phase].filter((x) => model.has(x));
    const onlyModel = [...model].filter((x) => !phase.has(x));
    const onlyPhase = [...phase].filter((x) => !model.has(x));
    agree += both.length; modelOnly += onlyModel.length; phaseOnly += onlyPhase.length;
    rows.push({ f, raspon: `${n.raspon.od}–${n.raspon.do}`, both: both.length, onlyModel, onlyPhase, modelUnresolved });
}

console.log(`Prozora s bilješkama: ${rows.length}\n`);
for (const r of rows) {
    console.log(`${r.f}  ${r.raspon}  slaganje ${r.both}`);
    if (r.onlyModel.length) console.log(`    model DA / faza 03 NE : ${r.onlyModel.join(", ")}`);
    if (r.onlyPhase.length) console.log(`    faza 03 DA / model NE : ${r.onlyPhase.join(", ")}`);
    if (r.modelUnresolved.length) console.log(`    model navodi ime izvan registra: ${r.modelUnresolved.join(", ")}`);
}

const tot = agree + modelOnly + phaseOnly;
console.log(`\nSlaganje: ${agree}/${tot} (${tot ? ((100 * agree) / tot).toFixed(1) : 0} %)`);
console.log(`  samo model:   ${modelOnly}  → kandidati za PROPUŠTENO sidro ili halucinaciju modela`);
console.log(`  samo faza 03: ${phaseOnly}  → kandidati za KRIVO sidro ili za govornika kojeg model nije spomenuo`);
console.log(`\n⚠ Ovo je popis za pregled, ne presuda — obje strane mogu griješiti.`);
