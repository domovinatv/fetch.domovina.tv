#!/usr/bin/env node
/**
 * verify_speaker_count.js — neovisna provjera broja globalnih govornika
 * „ODOZDO", iz protokola, a ne iz klasteriranja.
 *
 * ═══ Otvoreno pitanje koje ovo zatvara ═══
 *
 * Faza 02b je izbrojila **118** globalnih govornika. Ta brojka je potvrđena iz
 * tri smjera koja su SVA unutar iste metode (kalibracija praga, plato u
 * pretrazi, kontrola unutar komada — `docs/pipeline_memorija_i_propusnost_2026-08.md`
 * §8.6, §8.11). Nijedno mjerenje nije reklo koliko je ljudi DOISTA govorilo.
 *
 * Protokol daje neovisnu donju granicu: predsjedavajući svakog govornika
 * najavi imenom. Različitih imenovanih ljudi ne može biti više nego što je
 * stvarnih govornika, pa vrijedi:
 *
 *     donja granica = |različiti najavljeni zastupnici|
 *                   + |predsjedavajući|            (nikad se ne najavljuju)
 *                   + |članovi Vlade|              (nisu u registru zastupnika)
 *
 * Ako donja granica premaši 118, spajanje je preagresivno (dvije osobe pod
 * istom oznakom). Ako je znatno ispod, brojka nije opovrgnuta — samo znači da
 * protokol nije uhvatio svakoga (upadice iz klupa nemaju najavu).
 *
 *   node sabor_pipeline/tools/verify_speaker_count.js --session <id>
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
function getArg(n) { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : null; }

const session = getArg("--session");
if (!session) { console.error("Uporaba: --session <session_id>"); process.exit(2); }
const dir = path.join(getArg("--output-dir") || path.join(REPO_ROOT, "storage", "output", "sabor"), session);

const diar = JSON.parse(fs.readFileSync(path.join(dir, "diarization.json"), "utf8"));
const map = JSON.parse(fs.readFileSync(path.join(dir, "speaker_map.json"), "utf8"));
const aligned = JSON.parse(fs.readFileSync(path.join(dir, "aligned_transcript.json"), "utf8"));

// 1) Različiti zastupnici koje je predsjedavajući IKAD najavio — uključujući
//    najave čija oznaka na kraju nije razriješena (osoba je ipak govorila).
const announced = new Set(map.anchors.map((a) => a.mp_id));

// 2) Predsjedavajući — njih nitko ne najavljuje.
const chairs = new Set(map.chairs);

// 3) Uloge izvan registra (članovi Vlade) — prepoznate po predaji riječi ulozi.
const roleLabels = new Set(
    Object.entries(map.speakers).filter(([, v]) => v.role_hint).map(([k]) => k)
);

const lower = announced.size + chairs.size + roleLabels.size;
const clustered = diar.total_speakers_detected;

// Koliko oznaka uopće ima govora (i koliko ih je kratko) — za kontekst.
const secBy = new Map();
for (const b of aligned.blocks) {
    secBy.set(b.speaker_id, (secBy.get(b.speaker_id) || 0) + b.duration_sec);
}
const withSpeech = [...secBy.values()];
const under10 = withSpeech.filter((s) => s < 10).length;
const under30 = withSpeech.filter((s) => s < 30).length;

const rows = [
    ["različitih najavljenih zastupnika", announced.size],
    ["predsjedavajućih (nikad najavljeni)", chairs.size],
    ["uloga izvan registra (Vlada)", roleLabels.size],
    ["── DONJA GRANICA", lower],
    ["klasteriranjem (faza 02b)", clustered],
    ["oznaka s ikakvim govorom", withSpeech.length],
    ["   od toga < 30 s govora", under30],
    ["   od toga < 10 s govora", under10],
];
for (const [k, v] of rows) console.log(`${String(k).padEnd(38)} ${String(v).padStart(5)}`);

console.log();
if (lower > clustered) {
    console.log(`✖ DONJA GRANICA (${lower}) PREMAŠUJE broj iz klasteriranja (${clustered}).`);
    console.log("  Spajanje je preagresivno — dvije osobe dijele oznaku. Podigni prag.");
    process.exit(1);
}
const headroom = clustered - lower;
console.log(`✔ Donja granica ${lower} ≤ ${clustered} — brojka iz faze 02b nije opovrgnuta.`);
console.log(`  Zazor: ${headroom} oznaka (${(100 * headroom / clustered).toFixed(1)} %).`);
console.log("  Zazor je očekivan: upadice iz klupa, dobacivanja i tehnička javljanja");
console.log("  nemaju protokolarnu najavu, pa ih ova metoda po konstrukciji ne broji.");
if (under30 > headroom) {
    console.log(`  ⚠ ${under30} oznaka ima < 30 s govora — kandidati su i za nadsegmentaciju`);
    console.log("    i za stvarne kratke upadice. Ovo mjerenje ih ne razlikuje.");
}
