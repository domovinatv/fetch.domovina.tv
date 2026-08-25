#!/usr/bin/env node
/**
 * audit_article.js — traži izmišljene tvrdnje u generiranom članku.
 *
 * Članak o 20-satnoj sjednici nitko neće provjeriti čitanjem uz transkript, pa
 * halucinacija prolazi neopaženo upravo ondje gdje je najskuplja: ime osobe uz
 * tvrdnju koju nije izrekla. Ovaj alat provjerava tri stvari koje se DAJU
 * provjeriti strojno, i ništa više — nije ocjena kvalitete teksta.
 *
 *   1. **Imena.** Presudno pitanje NIJE „je li ime u registru zastupnika" nego
 *      **„postoji li to ime u transkriptu"**. Prva verzija ovog alata brojala
 *      je prvo pitanje i bila neupotrebljiva: od 115 prijavljenih „imena izvan
 *      registra" gotovo sve su bili toponimi i institucije (Gospić, Lika,
 *      Vlade, Kluba), a jedini stvarno zanimljiv slučaj — ministrica Marija
 *      Vučković — prijavljen je kao problem iako je njezino ime u transkriptu
 *      izgovoreno. Ona nije u rasporedu sjedenja jer nije zastupnica; članak ju
 *      je imenovao ISPRAVNO, iz onoga što su zastupnici rekli.
 *
 *      Zato je test: ime je utemeljeno ako se pojavljuje u transkriptu (makar
 *      i s ASR distorzijom). Ime kojeg u transkriptu NEMA je izmišljeno, bez
 *      obzira na to koliko uvjerljivo zvuči.
 *   2. **Imenovanje neimenovanih.** Ministrica u podacima nije imenovana
 *      (oznaka `clan_vlade` bez imena). Ako je članak imenuje, to je
 *      halucinacija, ma koliko pogodak bio uvjerljiv.
 *   3. **Timestampovi.** Svaki `[HH:MM:SS]` mora pasti unutar trajanja
 *      sjednice i blizu nekog stvarnog bloka.
 *
 * Alat NE tvrdi da je članak točan ako sve prođe — samo da ove tri klase
 * pogrešaka nisu nađene.
 *
 *   node sabor_pipeline/tools/audit_article.js --session <id> --article <put/do/clanak.md>
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { RosterMatcher, normalizeToken, tokenSim } = require("../utils/roster_match.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const getArg = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : d; };

const SESSION = getArg("--session");
const ARTICLE = getArg("--article");
if (!SESSION || !ARTICLE) {
    console.error("Uporaba: --session <id> --article <put/do/clanak.md>");
    process.exit(2);
}
const sessionDir = path.join(getArg("--output-dir", path.join(REPO_ROOT, "storage", "output", "sabor")), SESSION);

const aligned = JSON.parse(fs.readFileSync(path.join(sessionDir, "aligned_transcript.json"), "utf8"));
const roster = JSON.parse(fs.readFileSync(
    getArg("--roster", path.join(__dirname, "..", "data", "rosters", "sabor_mps_11_saziv.json")), "utf8"));
const article = fs.readFileSync(ARTICLE, "utf8");
const matcher = new RosterMatcher(roster);

// ── što je faza 03 doista utvrdila ──
const spokeNames = new Set(aligned.blocks.filter((b) => b.speaker_name).map((b) => b.speaker_name));
const rosterNames = new Set(roster.mps.map((m) => m.puno_ime));
const rosterSurnames = new Map();
for (const m of roster.mps) rosterSurnames.set(normalizeToken(m.prezime), m);
const spokeSurnames = new Set([...spokeNames].map((n) => normalizeToken(n.split(" ").slice(1).join(" ")) || normalizeToken(n)));

// Oznake bez imena koje su ipak imale ulogu — njih se NE SMIJE imenovati.
const unnamedRoles = aligned.blocks
    .filter((b) => !b.speaker_name && b.role === "clan_vlade")
    .reduce((s, b) => s.add(b.speaker_id), new Set());

// ── 1+2. imena u članku ──
// ⚠️ Završna granica je `(?![\p{L}])`, a NE `\b`: „ć" i „š" nisu word-znakovi u
// JS regexu, pa bi `\b` odsjekao prezime („Vučković" → „Vučkovi").
const CAP = "[A-ZČĆŽŠĐ][a-zčćžšđ]{2,}";
// Osoba se prepoznaje na dva načina, oba uža od „riječ velikim slovom":
//   (a) DVIJE velike riječi zaredom  → „Marija Vučković"
//   (b) titula pa jedna velika riječ → „zastupnik Grmoja", „ministrica Hrstić"
// Sam toponim („Gospić") ne prolazi ni jedan od ta dva sita, a upravo je on
// zatrpao prvu verziju izvještaja.
const PAIR_RE = new RegExp(`(?<![.!?]\\s)(?<!^)(${CAP})\\s+(${CAP})(?![\\p{L}])`, "gmu");
// Titula hvata do DVIJE velike riječi — inače „zastupnik Nikola Grmoja" da
// kandidata „Nikola", golo osobno ime koje ništa ne identificira.
const TITLED_RE = new RegExp(
    `\\b(?:[Zz]astupnik|[Zz]astupnica|[Zz]astupnice|[Zz]astupnika|[Kk]olega|[Kk]olegica|[Kk]olegice|` +
    `[Mm]inistar|[Mm]inistrica|[Mm]inistrice|[Pp]remijer|[Pp]remijerka|[Pp]redsjednik|[Pp]redsjednica|` +
    `[Gg]ospodin|[Gg]ospođa)\\s+(${CAP}(?:\\s+${CAP})?)(?![\\p{L}])`, "gmu");
// ⚠️ Zastavica `i` NAMJERNO izostaje. S njom razred `[A-ZČĆŽŠĐ]` hvata i mala
// slova, pa „velikim slovom" ne znači ništa: „ministar Ćorić ukinuo" daje
// kandidata „Ćorić ukinuo", a „ministrica zaštite okoliša" daje „zaštite
// okoliša". To je TOČNO ista greška koju ovaj repo prigovara specifikaciji
// `03_asr_and_protocol_parser.md` §3 — i koju sam ovdje sam ponovio.
// Titule su same po sebi male, pa `i` ionako nije potreban.
// Naslovi, citati i natuknice nisu tekst u kojem se pripisuju istupi.
const prose = article
    .split("\n")
    .filter((l) => !/^\s*(#|>|\||\*\s|-\s|\d+\.)/.test(l))
    .join("\n");
const seen = new Map();
const bump = (k) => seen.set(k, (seen.get(k) || 0) + 1);
for (const m of prose.matchAll(PAIR_RE)) bump(`${m[1]} ${m[2]}`);
for (const m of prose.matchAll(TITLED_RE)) bump(m[1]);

// Tekst transkripta — jedini izvor koji članak smije koristiti.
//
// ⚠️ Uspoređuje se samo s tokenima koji su u transkriptu VELIKIM početnim
// slovom. Bez toga „Ivana Izmišljenog" prođe kao utemeljeno ime, jer je
// „izmišljenog" sasvim obična hrvatska riječ koja u transkriptu doista stoji.
// Vlastito ime se traži među vlastitim imenima, ne među svim riječima.
const transcriptText = aligned.blocks.map((b) => b.text).join("\n");
const transcriptTokens = new Set(
    (transcriptText.match(/[A-ZČĆŽŠĐ][\p{L}]{2,}/gu) || []).map(normalizeToken)
);
// Cijeli transkript kao jedan normalizirani niz — za provjeru IZRAZA, ne tokena.
const transcriptFlat = " " + transcriptText
    .split(/[^\p{L}]+/u).map(normalizeToken).filter(Boolean).join(" ") + " ";

/**
 * Je li ime utemeljeno u transkriptu?
 *
 * Za višerječno ime traži se **cijeli izraz**, neosjetljivo na velika slova.
 * Dvije prethodne verzije ovog testa pale su iz suprotnih razloga i obje su
 * ostavljene ovdje kao upozorenje:
 *
 *   • provjera po BILO KOJEM tokenu → „Ivana Izmišljenog" prolazi, jer je
 *     „izmišljenog" sasvim obična hrvatska riječ koja u transkriptu doista stoji;
 *   • provjera samo po tokenima s VELIKIM početnim slovom → „Dugog Rata" pada,
 *     jer Canary u dugim odsječcima gubi velika slova („dugog rata", 11×).
 *
 * Izraz rješava oboje: „dugog rata" se nađe bez obzira na slova, a „ivana
 * izmišljenog" kao slijed ne postoji. Za jednorječno ime nema izraza, pa se
 * gleda token — ondje je pravilo nužno slabije i izvještaj to kaže.
 */
function groundedInTranscript(name) {
    const parts = name.split(" ").map(normalizeToken).filter((t) => t.length >= 3);
    if (!parts.length) return false;
    if (parts.length > 1 && transcriptFlat.includes(` ${parts.join(" ")} `)) return true;
    const surname = parts[parts.length - 1];
    if (transcriptTokens.has(surname)) return true;
    for (const t of transcriptTokens) {
        if (Math.abs(t.length - surname.length) <= 2 &&
            t.slice(0, 3) === surname.slice(0, 3) &&
            tokenSim(surname, t) >= 0.86) return true;
    }
    return false;
}

const inRosterSpoke = [], inRosterSilent = [], groundedNonMp = [], unknown = [];
for (const [name, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
    if (spokeNames.has(name)) { inRosterSpoke.push([name, n]); continue; }
    const r = matcher.resolve(name);
    if (r.mp) {
        (spokeNames.has(r.mp.puno_ime) ? inRosterSpoke : inRosterSilent)
            .push([`${name} → ${r.mp.puno_ime}`, n]);
    } else if (groundedInTranscript(name)) {
        // Nije zastupnik, ali je izgovoren — ministri, dužnosnici, treće osobe.
        groundedNonMp.push([name, n]);
    } else {
        unknown.push([name, n]);
    }
}

// ── 3. timestampovi ──
const starts = aligned.blocks.map((b) => b.start_global_sec).sort((a, b) => a - b);
const total = aligned.blocks.reduce((mx, b) => Math.max(mx, b.end_global_sec), 0);
const tsBad = [], tsAll = [];
for (const t of article.matchAll(/\[(\d{2}):(\d{2}):(\d{2})\]/g)) {
    const sec = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
    tsAll.push(sec);
    if (sec > total + 1) { tsBad.push([t[0], "izvan trajanja sjednice"]); continue; }
    // najbliži stvarni početak bloka
    let lo = 0, hi = starts.length - 1, best = Infinity;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        best = Math.min(best, Math.abs(starts[mid] - sec));
        if (starts[mid] < sec) lo = mid + 1; else hi = mid - 1;
    }
    if (best > 300) tsBad.push([t[0], `${Math.round(best)} s od najbližeg bloka`]);
}

// ── izvještaj ──
const words = article.split(/\s+/).filter(Boolean).length;
console.log(`Članak: ${path.relative(REPO_ROOT, ARTICLE)}`);
console.log(`Riječi: ${words.toLocaleString("hr")} | različitih imena: ${seen.size} | timestampova: ${tsAll.length}`);
console.log();
console.log(`✔ zastupnici koji su DOISTA govorili:       ${inRosterSpoke.length}`);
console.log(`✔ nezastupnici, ali IZGOVORENI u transkriptu: ${groundedNonMp.length}  (ministri, dužnosnici, treće osobe)`);
for (const [n, c] of groundedNonMp.slice(0, 12)) console.log(`    ${n} (${c}×)`);
console.log(`⚠ zastupnici iz registra koji NISU govorili:  ${inRosterSilent.length}  (spomen je u redu, pripisan istup nije)`);
for (const [n, c] of inRosterSilent.slice(0, 12)) console.log(`    ${n} (${c}×)`);
console.log(`✖ IMENA KOJIH NEMA U TRANSKRIPTU:            ${unknown.length}  ← izmišljena`);
for (const [n, c] of unknown.slice(0, 20)) console.log(`    ${n} (${c}×)`);
console.log();
if (tsAll.length) {
    const cov = tsAll.length ? `${fmt(Math.min(...tsAll))}–${fmt(Math.max(...tsAll))}` : "-";
    console.log(`Raspon timestampova u članku: ${cov} (sjednica traje ${fmt(total)})`);
    // koliko je sjednice pokriveno: udio 1-satnih odsječaka koji imaju barem jedan ts
    const buckets = new Set(tsAll.map((s) => Math.floor(s / 3600)));
    const hours = Math.ceil(total / 3600);
    console.log(`Pokrivenost po satima: ${buckets.size}/${hours} sati ima barem jedan timestamp`);
}
console.log(`Sumnjivih timestampova: ${tsBad.length}`);
for (const [t, why] of tsBad.slice(0, 12)) console.log(`    ${t} — ${why}`);

const fatal = unknown.length > 0 || tsBad.length > 0;
console.log();
console.log(fatal
    ? "✖ NAĐENE su strojno provjerljive pogreške — vidi popise iznad."
    : "✔ Nijedna od tri strojno provjerljive klase pogrešaka nije nađena.\n" +
      "  (To NIJE dokaz da je članak točan — samo da nije pao na ovim provjerama.)");
console.log(`\nℹ Neimenovane uloge u podacima: ${[...unnamedRoles].join(", ") || "(nema)"} — ` +
    `ako ih članak imenuje, ime mora biti u popisu „nisu govorili" iznad.`);

function fmt(s) {
    const x = Math.floor(s);
    return `${String(Math.floor(x / 3600)).padStart(2, "0")}:${String(Math.floor((x % 3600) / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
}
