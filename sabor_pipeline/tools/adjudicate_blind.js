#!/usr/bin/env node
/**
 * adjudicate_blind.js — priprema nalaza slijepe provjere za presudu.
 *
 * `blind_speaker_check.js` kaže DA se model i faza 03 razilaze, ali ne i TKO je
 * u pravu. Presuda je uvijek ista radnja: pogledaj što je predsjedavajući rekao
 * neposredno prije nego je ta oznaka prvi put progovorila. Ovaj alat tu radnju
 * radi za sve nalaze odjednom i ispisuje dokaz uz svaki.
 *
 * Ne odlučuje ništa sam — samo dovodi tekst pred oči. Nalaz se svrstava u:
 *
 *   PROPUŠTENO SIDRO  najava postoji i imenuje osobu koju je model naveo
 *                     → rupa u `HANDOVER_RE` ili u matcheru
 *   NEMA NAJAVE       predsjedavajući ga nije najavio (upadica, dobacivanje)
 *                     → faza 03 ga po konstrukciji ne može imenovati
 *   SUKOB             najava imenuje nekoga trećeg → traži ljudsku odluku
 *
 *   node sabor_pipeline/tools/adjudicate_blind.js --session <id>
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { RosterMatcher } = require("../utils/roster_match.js");
const { handoverSentence, findAnnouncements } = require("../utils/protocol_parser.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const getArg = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : d; };

const SESSION = getArg("--session");
if (!SESSION) { console.error("Uporaba: --session <id>"); process.exit(2); }
const dir = path.join(getArg("--output-dir", path.join(REPO_ROOT, "storage", "output", "sabor")), SESSION);
const CTX = Number(getArg("--context", 260));

const aligned = JSON.parse(fs.readFileSync(path.join(dir, "aligned_transcript.json"), "utf8"));
const res = JSON.parse(fs.readFileSync(
    path.join(getArg("--blind", path.join(dir, "blind_check_agy")), "rezultat.json"), "utf8"));
const matcher = new RosterMatcher(JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "data", "rosters", "sabor_mps_11_saziv.json"), "utf8")));

/** Blok predsjedavajućeg neposredno prije prvog istupa dane oznake. */
function chairBefore(speakerId) {
    const i = aligned.blocks.findIndex((b) => b.speaker_id === speakerId);
    if (i <= 0) return null;
    for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
        if (aligned.blocks[k].role === "predsjedatelj") return aligned.blocks[k];
    }
    return null;
}

function speechSec(speakerId) {
    return aligned.blocks.filter((b) => b.speaker_id === speakerId)
        .reduce((s, b) => s + b.duration_sec, 0);
}

const findings = [
    ...(res.newRows || []).map(([sid, ime]) => ({ sid, kind: "bez imena u fazi 03", model: ime, phase: null })),
    ...(res.wrongRows || []).map(([sid, phase, model]) => ({ sid, kind: "NESLAGANJE", model, phase })),
];
// Ista oznaka zna se pojaviti u više prozora — presuđuje se jednom.
const seen = new Set();
const uniq = findings.filter((f) => (seen.has(f.sid) ? false : seen.add(f.sid)));

let missed = 0, noAnnounce = 0, conflict = 0;
console.log(`Nalaza za presudu: ${uniq.length}\n`);
for (const f of uniq.sort((a, b) => speechSec(b.sid) - speechSec(a.sid))) {
    const chair = chairBefore(f.sid);
    const hs = chair ? handoverSentence(chair.text) : null;
    const evidence = hs || (chair ? chair.text.slice(-CTX) : null);
    // Imenuje li ta najava upravo osobu koju je model naveo?
    //
    // ⚠️ `matcher.resolve()` se NE smije pustiti na cijelu rečenicu — očekuje
    // ime, ne tekst, pa je prva verzija ovog alata svaku pravu najavu
    // („Repliku ima kolega Lalovac.") proglasila „nema najave" i prijavila
    // nula propuštenih sidara. Ime iz rečenice vadi `findAnnouncements`.
    const cands = chair
        ? findAnnouncements(chair.text, matcher).map((a) => a.mp.puno_ime)
        : [];
    let verdict;
    if (!chair) { verdict = "NEMA NAJAVE"; noAnnounce++; }
    else if (cands.includes(f.model)) { verdict = "PROPUŠTENO SIDRO"; missed++; }
    else if (f.kind === "NESLAGANJE") { verdict = "SUKOB"; conflict++; }
    else { verdict = "NEMA NAJAVE"; noAnnounce++; }

    console.log(`${f.sid}  ${(speechSec(f.sid) / 60).toFixed(1)} min  →  ${verdict}`);
    console.log(`   model:   ${f.model}${f.phase ? `   |   faza 03: ${f.phase}` : ""}`);
    if (evidence) console.log(`   najava:  ${JSON.stringify(String(evidence).slice(0, CTX))}`);
    console.log("");
}
console.log(`propuštenih sidara: ${missed}   bez najave: ${noAnnounce}   sukoba: ${conflict}`);
console.log(`\n„PROPUŠTENO SIDRO" je popravljivo u kodu. „NEMA NAJAVE" nije —`);
console.log(`predsjedavajući tu osobu nikad nije imenovao, pa je protokol nijem.`);
