#!/usr/bin/env node
/**
 * audit_overrides.js — neovisna provjera SLOJA LJUDSKIH ODLUKA.
 *
 * ⚠️ Zašto ovo uopće postoji. Pouka pilota glasi: deterministički kod nema
 * unutarnju provjeru — kad pogodi, „siguran" je 1.0, i jednako je siguran kad
 * promaši. Ljudska odluka ima točno isto svojstvo. Ona u izlaz ulazi s
 * pouzdanošću 1.0 i nadjačava sve, pa je jedini mehanizam imenovanja koji bi
 * inače prošao BEZ ijedne mjere koja ga može oboriti. Ovaj alat je ta mjera.
 *
 * Ne poništava ništa i ne odlučuje ništa — dovodi pred oči ono što je čovjek
 * nadjačao, i mjeri ono što se dade izmjeriti:
 *
 *   1. PROTOKOLARNI SUKOB   koliko je složnih najava odluka pregazila
 *   2. DIJELJENA OZNAKA     tvrdnja „ove dvije oznake su ista osoba" mjeri se
 *                           akustički (`audit_merge_cohesion.py --cross`)
 *   3. IME IZVAN REGISTRA   je li osoba ipak u registru, samo promašena
 *   4. ODLUKA BEZ DOKAZA    unos bez citata i razloga nije provjerljiv
 *   5. SUPROTNO MODELU      slijepa provjera je za tu oznaku rekla nešto drugo
 *   6. SUPROTNO EKRANU      natpis koji je režija ispisala imenuje drugu osobu
 *                           (`tools/ocr_captions.js`) — jedini izvor koji ne
 *                           ovisi ni o čijem govoru, pa je razina VISOKA
 *
 *   node sabor_pipeline/tools/audit_overrides.js --session <id>
 *   node sabor_pipeline/tools/audit_overrides.js --session <id> --json out.json
 *   node sabor_pipeline/tools/audit_overrides.js --session <id> --no-acoustic
 *
 * Izlazni kod: 0 = nema nalaza, 1 = ima nalaza za pregled, 2 = greška uporabe.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const humanOverrides = require("../utils/human_overrides.js");
const { RosterMatcher } = require("../utils/roster_match.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const getArg = (n, d = null) => {
    const i = args.indexOf(n);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : d;
};

const SESSION = getArg("--session");
if (!SESSION) {
    console.error("Uporaba: node sabor_pipeline/tools/audit_overrides.js --session <id>");
    process.exit(2);
}
const OUT_DIR = getArg("--output-dir", path.join(REPO_ROOT, "storage", "output", "sabor"));
const DIR = path.join(OUT_DIR, SESSION);
const JSON_OUT = getArg("--json", null);
const NO_ACOUSTIC = args.includes("--no-acoustic");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const doc = humanOverrides.load(DIR, SESSION);
const entries = Object.entries(doc.overrides || {});
if (entries.length === 0) {
    console.log("Sloj ljudskih odluka je prazan — nema što revidirati.");
    process.exit(0);
}

const aligned = readJson(path.join(DIR, "aligned_transcript.json"));
const smap = readJson(path.join(DIR, "speaker_map.json"));
const roster = readJson(path.join(__dirname, "..", "data", "rosters", "sabor_mps_11_saziv.json"));
const mpById = new Map(roster.mps.map((m) => [m.id, m]));
const matcher = new RosterMatcher(roster);

/** Sve najave koje su pokazivale na danu oznaku, s izgovorenim imenom. */
function anchorsFor(sid) {
    return (smap.anchors || []).filter((a) => a.target_speaker === sid);
}
function speechSec(sid) {
    return aligned.blocks.filter((b) => b.speaker_id === sid)
        .reduce((s, b) => s + b.duration_sec, 0);
}
/**
 * Što je NATPIS S EKRANA rekao za tu oznaku (`tools/ocr_captions.js`).
 *
 * Ovo je najstroži od izvora za provjeru ljudske odluke, jer je jedini koji ne
 * ovisi ni o čijem govoru: režija ispisuje ime u traci. Mjereno na pilotu —
 * 100 % slaganja s protokolom ondje gdje oba izvora imenuju osobu (67/67), uz
 * nula slučajeva u kojima ekran tvrdi drugu osobu. Ljudska odluka koja ide
 * protiv njega zato traži pogled, a ne prešućivanje.
 *
 * Uzima se samo `prijedlog` — ono što je prošlo ogradu protiv tankog dokaza.
 * Sirovi kandidati bi ovdje proizveli nalaze na temelju jednog očitanja s
 * oznake koja skuplja upadice, a to je upravo lažna uzbuna koja natjera
 * čovjeka da prestane čitati reviziju.
 */
function ocrFor(sid) {
    const f = path.join(DIR, "ocr_captions", "prijedlozi.json");
    if (!fs.existsSync(f)) return null;
    let j;
    try { j = readJson(f); } catch { return null; }
    const p = (j.prijedlozi || []).find((x) => x.speaker_id === sid);
    if (!p || !p.prijedlog) return null;
    const st = p.prijedlog.status;
    if (st !== "predlozi" && st !== "predlozi_izvan_registra") return null;
    return { ime: p.prijedlog.puno_ime, pokrivenost: p.pokrivenost, udio: p.udio_vodeceg };
}

/** Što je slijepa provjera (model, bez registra) rekla za tu oznaku. */
function blindFor(sid) {
    const bdir = path.join(DIR, "blind_check_agy");
    if (!fs.existsSync(bdir)) return [];
    const out = [];
    for (const f of fs.readdirSync(bdir).filter((x) => /^w\d+\.json$/.test(x)).sort()) {
        let j;
        try { j = readJson(path.join(bdir, f)); } catch { continue; }
        for (const id of j.identifikacije || []) {
            if (id.speaker_id === sid && id.ime) {
                out.push({ prozor: f.replace(/\.json$/, ""), ime: id.ime, sigurnost: id.sigurnost });
            }
        }
    }
    return out;
}

const nalazi = [];
const add = (razina, vrsta, speaker, poruka, extra = {}) =>
    nalazi.push({ razina, vrsta, speaker, poruka, ...extra });

// ─── 0. valjanost ────────────────────────────────────────────────────────
for (const b of humanOverrides.validateDoc(doc, mpById)) {
    add("greška", "nevaljan unos", b.split(":")[0], b);
}

// ─── 1..5 po unosu ───────────────────────────────────────────────────────
const osobaNaOznakama = new Map();

for (const [sid, e] of entries) {
    if (!humanOverrides.ODLUKE_KOJE_MIJENJAJU.includes(e.odluka)) continue;

    const mp = e.mp_id != null ? mpById.get(String(e.mp_id)) : null;
    const ime = mp ? mp.puno_ime : e.puno_ime;
    if (e.odluka !== "odbaci" && ime) {
        const key = mp ? `mp:${mp.id}` : `ime:${ime}`;
        if (!osobaNaOznakama.has(key)) osobaNaOznakama.set(key, { ime, sids: [] });
        osobaNaOznakama.get(key).sids.push(sid);
    }

    // 1. protokolarni sukob — koliko je složnih najava odluka pregazila
    const anch = anchorsFor(sid);
    const protivne = anch.filter((a) => (mp ? a.mp_id !== mp.id : true));
    if (anch.length > 0 && protivne.length === anch.length && e.odluka !== "potvrdi") {
        const imena = [...new Set(protivne.map((a) => a.mp))];
        add(protivne.length >= 3 ? "visok" : "srednji", "protokolarni sukob", sid,
            `odluka „${ime || "bez imena"}" pregazila ${protivne.length} najava ` +
            `koje imenuju: ${imena.join(", ")}`,
            { najave: protivne.slice(0, 5).map((a) => ({ hms: hms(a.at_global_sec), izgovoreno: a.spoken_name, mp: a.mp })) });
    }

    // 3. ime izvan registra koje je registar ipak poznaje
    if (!mp && e.odluka !== "odbaci" && ime) {
        const hit = matcher.resolve(ime);
        if (hit && hit.mp && hit.score >= 0.9) {
            add("srednji", "ime izvan registra a u registru je", sid,
                `„${ime}" upisan slobodno, ali registar ga poznaje kao ` +
                `${hit.mp.puno_ime} (${hit.score.toFixed(3)}) — upiši mp_id ${hit.mp.id}`);
        }
    }

    // 4. odluka bez dokaza
    const imaDokaz = e.dokaz && (e.dokaz.citat || e.dokaz.youtube_url);
    if (!imaDokaz && !e.razlog) {
        add("srednji", "odluka bez dokaza", sid,
            "nema ni citata ni razloga — odluka se poslije ne da provjeriti");
    }

    // 5. suprotno slijepoj provjeri
    //
    // ⚠️ Usporedba ide po IDENTITETU, ne po nizu znakova. Registar nosi
    // „Jasenka Auguštan", model je rekao „Jasenka Auguštan-Pentek" — oboje se
    // razrješava u istog zastupnika (145086), a doslovna usporedba je to
    // prijavila kao proturječje. Isti propust je prije toga svaku ASR-varijantu
    // prezimena („Habijen"/„Habijan") brojao kao dvije osobe.
    const blind = blindFor(sid);
    const protivni = blind.filter((b) => ime && b.ime && !istiIdentitet(b.ime, ime));
    if (ime && protivni.length && protivni.length === blind.length) {
        add("srednji", "suprotno slijepoj provjeri", sid,
            `model je za tu oznaku rekao: ${[...new Set(protivni.map((b) => b.ime))].join(", ")}`,
            { prozori: protivni.map((b) => b.prozor) });
    }

    // 6. suprotno natpisu s ekrana
    //
    // Razina je VISOKA, za razliku od nalaza 5. Model zaključuje iz teksta i zna
    // pogriješiti; natpis je ono što je režija doslovno ispisala dok je osoba
    // govorila. Ako čovjek upiše jedno ime a traka je cijelo vrijeme pokazivala
    // drugo, jedno od toga dvoga je promašaj i mora se pogledati prije objave.
    const ocr = ocrFor(sid);
    if (ime && ocr && ocr.ime && !istiIdentitet(ocr.ime, ime)) {
        add("visok", "suprotno natpisu s ekrana", sid,
            `natpis je za tu oznaku pokazivao „${ocr.ime}" ` +
            `(pokrivenost ${(ocr.pokrivenost * 100).toFixed(0)} %, slaganje ${(ocr.udio * 100).toFixed(0)} %)`,
            { ekran: ocr.ime });
    }
}

// ─── 2. dijeljena oznaka — akustička provjera ────────────────────────────
const parovi = [];
for (const { ime, sids } of osobaNaOznakama.values()) {
    if (sids.length < 2) continue;
    for (let i = 1; i < sids.length; i++) parovi.push({ ime, a: sids[0], b: sids[i] });
}
let akustika = [];
if (parovi.length && !NO_ACOUSTIC) {
    const cross = [];
    for (const p of parovi) cross.push("--cross", `${p.a},${p.b}`);
    try {
        const tmp = path.join(DIR, ".audit_overrides_cross.json");
        execFileSync("python3", [
            path.join(__dirname, "audit_merge_cohesion.py"),
            "--session", SESSION, "--output-dir", OUT_DIR,
            ...cross, "--cross-json", tmp,
        ], { stdio: ["ignore", "ignore", "inherit"] });
        akustika = readJson(tmp).parovi || [];
        fs.unlinkSync(tmp);
    } catch (err) {
        add("greška", "akustička provjera pala", "-",
            `nije se dala izmjeriti udaljenost oznaka: ${err.message.split("\n")[0]}`);
    }
}
for (const p of parovi) {
    const m = akustika.find((r) => r.a === p.a && r.b === p.b);
    if (!m) {
        add("visok", "dijeljena oznaka NIJE izmjerena", `${p.a}+${p.b}`,
            `„${p.ime}" je na dvije oznake, a tvrdnja nije akustički provjerena ` +
            `(pokreni bez --no-acoustic)`);
        continue;
    }
    if (m.greska) {
        add("visok", "dijeljena oznaka bez centroida", `${p.a}+${p.b}`, m.greska);
    } else if (!m.ista_osoba_vjerojatna) {
        add("visok", "dijeljena oznaka OBORENA mjerenjem", `${p.a}+${p.b}`,
            `„${p.ime}": najbliži centroidi ${p.a} i ${p.b} udaljeni su ${m.min.toFixed(3)} ` +
            `uz prag ${m.prag.toFixed(3)} — to nisu isti glasovi`,
            { mjera: m });
    } else {
        add("info", "dijeljena oznaka potvrđena mjerenjem", `${p.a}+${p.b}`,
            `„${p.ime}": min ${m.min.toFixed(3)} ≤ prag ${m.prag.toFixed(3)}`,
            { mjera: m });
    }
}

// ─── ispis ───────────────────────────────────────────────────────────────
const REDOSLIJED = { "greška": 0, visok: 1, srednji: 2, info: 3 };
nalazi.sort((a, b) => (REDOSLIJED[a.razina] - REDOSLIJED[b.razina]) ||
                      speechSec(b.speaker) - speechSec(a.speaker));

const mijenjaju = entries.filter(([, e]) => humanOverrides.ODLUKE_KOJE_MIJENJAJU.includes(e.odluka));
console.log(`Sloj ljudskih odluka: ${entries.length} unosa (${mijenjaju.length} mijenja izlaz)`);
console.log(`Nalaza za pregled: ${nalazi.filter((n) => n.razina !== "info").length}\n`);

const IKONA = { "greška": "✖", visok: "⚠", srednji: "•", info: "✓" };
for (const n of nalazi) {
    console.log(`${IKONA[n.razina]} [${n.vrsta}] ${n.speaker}`);
    console.log(`   ${n.poruka}`);
    for (const a of n.najave || []) {
        console.log(`   najava ${a.hms}  „${a.izgovoreno}" → ${a.mp}`);
    }
    console.log("");
}

if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({
        session_id: SESSION,
        generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        unosa: entries.length,
        nalazi,
    }, null, 1) + "\n", "utf8");
    console.log(`Zapisano: ${JSON_OUT}`);
}

console.log("Ovaj alat ne poništava ništa. Ljudska odluka ostaje na snazi —");
console.log("nalaz je poziv da se pogleda, a ne presuda da je pogrešna.");

/** Razrješava oba imena kroz registar pa uspoređuje ono što ona označavaju. */
function istiIdentitet(a, b) {
    if (norm(a) === norm(b)) return true;
    const ha = matcher.resolve(a), hb = matcher.resolve(b);
    if (ha && ha.mp && ha.score >= 0.9 && hb && hb.mp && hb.score >= 0.9) {
        return ha.mp.id === hb.mp.id;
    }
    return false;
}

function norm(s) {
    return String(s || "").replace(/[đĐ]/g, "D").normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z]+/g, " ").trim();
}
function hms(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

process.exit(nalazi.some((n) => n.razina !== "info") ? 1 : 0);
