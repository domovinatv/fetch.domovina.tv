#!/usr/bin/env node
/**
 * diff_naming.js — što se promijenilo u imenovanju između dva prolaza.
 *
 * Petlja „AI → čovjek → AI" nema smisla ako se učinak ne vidi. Ovaj alat
 * uspoređuje dva `aligned_transcript.json` snimka i kaže točno koliko je
 * oznaka novo imenovano i koliko je govornog vremena time dobiveno.
 *
 * ⚠️ Postotak imenovanog vremena se namjerno razlaže na PROTOKOL i ČOVJEKA.
 * Bez toga bi svaki krug pregleda izgledao kao da se popravilo protokolarno
 * sidrenje, a ono stoji na mjestu — mjeri se ljudski rad, ne stroj.
 *
 *   node sabor_pipeline/tools/diff_naming.js --session <id> --before <snapshot.json>
 *   node sabor_pipeline/tools/diff_naming.js --before a.json --after b.json --json out.json
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const getArg = (n, d = null) => {
    const i = args.indexOf(n);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : d;
};

function load(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

/** Sažetak stanja jedne verzije transkripta, po oznaci i ukupno. */
function summarize(t) {
    const perSpeaker = new Map();
    let totalSec = 0, namedSec = 0, humanSec = 0;
    for (const b of t.blocks) {
        totalSec += b.duration_sec;
        if (b.speaker_name) namedSec += b.duration_sec;
        if (b.speaker_name && b.identity_source === "covjek") humanSec += b.duration_sec;
        if (!perSpeaker.has(b.speaker_id)) {
            perSpeaker.set(b.speaker_id, { sec: 0, blocks: 0, name: null, source: null, role: null });
        }
        const e = perSpeaker.get(b.speaker_id);
        e.sec += b.duration_sec;
        e.blocks += 1;
        if (b.speaker_name) { e.name = b.speaker_name; e.source = b.identity_source || "protokol"; }
        e.role = b.role;
    }
    return {
        perSpeaker, totalSec, namedSec, humanSec,
        labels: perSpeaker.size,
        namedLabels: [...perSpeaker.values()].filter((v) => v.name).length,
        persons: new Set([...perSpeaker.values()].filter((v) => v.name).map((v) => v.name)).size,
        pct: pct(namedSec, totalSec),
        pctHuman: pct(humanSec, totalSec),
        pctProtokol: pct(namedSec - humanSec, totalSec),
    };
}

function pct(a, b) { return b > 0 ? Math.round((1000 * a) / b) / 10 : 0; }
function min(sec) { return `${(sec / 60).toFixed(1)} min`; }

function diff(beforeT, afterT) {
    const A = summarize(beforeT);
    const B = summarize(afterT);
    const novo = [], izgubljeno = [], promijenjeno = [];

    for (const [sid, b] of B.perSpeaker) {
        const a = A.perSpeaker.get(sid);
        const prije = a ? a.name : null;
        if (!prije && b.name) novo.push({ speaker: sid, ime: b.name, izvor: b.source, sec: b.sec });
        else if (prije && !b.name) izgubljeno.push({ speaker: sid, ime: prije, sec: b.sec });
        else if (prije && b.name && prije !== b.name) {
            promijenjeno.push({ speaker: sid, prije, poslije: b.name, izvor: b.source, sec: b.sec });
        }
    }
    const bysec = (x, y) => y.sec - x.sec;
    novo.sort(bysec); izgubljeno.sort(bysec); promijenjeno.sort(bysec);

    return {
        prije: metrics(A), poslije: metrics(B),
        delta: {
            imenovanih_oznaka: B.namedLabels - A.namedLabels,
            razlicitih_osoba: B.persons - A.persons,
            imenovano_vrijeme_sec: Math.round((B.namedSec - A.namedSec) * 10) / 10,
            imenovano_pct: Math.round((B.pct - A.pct) * 10) / 10,
        },
        novo, izgubljeno, promijenjeno,
    };
}

function metrics(S) {
    return {
        oznaka: S.labels, imenovanih_oznaka: S.namedLabels, razlicitih_osoba: S.persons,
        imenovano_pct: S.pct, imenovano_pct_protokol: S.pctProtokol, imenovano_pct_covjek: S.pctHuman,
        ukupno_sec: Math.round(S.totalSec),
    };
}

function report(d) {
    const L = [];
    const znak = (v) => (v > 0 ? `+${v}` : String(v));
    L.push(`                     prije   poslije   razlika`);
    L.push(`imenovanih oznaka  ${String(d.prije.imenovanih_oznaka).padStart(7)}${String(d.poslije.imenovanih_oznaka).padStart(10)}${znak(d.delta.imenovanih_oznaka).padStart(10)}`);
    L.push(`različitih osoba   ${String(d.prije.razlicitih_osoba).padStart(7)}${String(d.poslije.razlicitih_osoba).padStart(10)}${znak(d.delta.razlicitih_osoba).padStart(10)}`);
    L.push(`imenovano vrijeme  ${(d.prije.imenovano_pct + " %").padStart(7)}${(d.poslije.imenovano_pct + " %").padStart(10)}${(znak(d.delta.imenovano_pct) + " pp").padStart(10)}`);
    L.push(`   od toga protokol${(d.prije.imenovano_pct_protokol + " %").padStart(7)}${(d.poslije.imenovano_pct_protokol + " %").padStart(10)}`);
    L.push(`   od toga čovjek  ${(d.prije.imenovano_pct_covjek + " %").padStart(7)}${(d.poslije.imenovano_pct_covjek + " %").padStart(10)}`);
    L.push("");
    if (d.novo.length) {
        L.push(`NOVO IMENOVANO (${d.novo.length}):`);
        for (const r of d.novo) L.push(`  + ${r.speaker}  ${min(r.sec).padStart(9)}  ${r.ime}  [${r.izvor}]`);
        L.push("");
    }
    if (d.promijenjeno.length) {
        L.push(`PROMIJENJENO IME (${d.promijenjeno.length}):`);
        for (const r of d.promijenjeno) L.push(`  ~ ${r.speaker}  ${min(r.sec).padStart(9)}  ${r.prije} → ${r.poslije}  [${r.izvor}]`);
        L.push("");
    }
    if (d.izgubljeno.length) {
        L.push(`IZGUBILO IME (${d.izgubljeno.length}) — očekivano kad ljudska odluka povuče protokolarno ime:`);
        for (const r of d.izgubljeno) L.push(`  − ${r.speaker}  ${min(r.sec).padStart(9)}  bilo: ${r.ime}`);
        L.push("");
    }
    if (!d.novo.length && !d.promijenjeno.length && !d.izgubljeno.length) {
        L.push("Nema razlike u imenovanju.");
    }
    return L.join("\n");
}

if (require.main === module) {
    const session = getArg("--session");
    const outDir = getArg("--output-dir", path.join(REPO_ROOT, "storage", "output", "sabor"));
    const beforeP = getArg("--before");
    const afterP = getArg("--after") ||
        (session ? path.join(outDir, session, "aligned_transcript.json") : null);
    if (!beforeP || !afterP) {
        console.error("Uporaba: --before <snapshot.json> [--after <file> | --session <id>] [--json out.json]");
        process.exit(2);
    }
    const d = diff(load(beforeP), load(afterP));
    console.log(report(d));
    const jsonOut = getArg("--json");
    if (jsonOut) {
        fs.writeFileSync(jsonOut, JSON.stringify(d, null, 1) + "\n", "utf8");
        console.log(`\nZapisano: ${jsonOut}`);
    }
}

module.exports = { summarize, diff, report, metrics };
