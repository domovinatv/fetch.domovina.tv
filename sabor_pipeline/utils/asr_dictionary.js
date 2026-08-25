/**
 * asr_dictionary.js — post-ASR rječnička normalizacija saborskog transkripta.
 *
 * Canary 1B v2 nema `initial_prompt` (ni bilo kakav mehanizam usmjeravanja
 * rječnika), pa se terminologija ispravlja ISKLJUČIVO ovdje, nakon ASR-a.
 *
 * ⚠️ Svako pravilo ispod ima **izmjeren broj pojava** u ovoj sjednici
 * (20 h, `part_0N_16k.wav.canary.srt`, 5513 redaka). Pravila bez pogodaka se
 * ne dodaju — hipotetska zamjena je rizik bez koristi: tiho mijenja tekst koji
 * nitko nije provjerio. Brojke obnoviti `tools/audit_dictionary.js`.
 *
 * Dva razreda pravila, namjerno odvojena:
 *
 *   `TERMS`  — kratice, institucije, toponimi. Diraju SAMO prikazani tekst.
 *   `NAMES`  — prezimena zastupnika koja ASR sustavno lomi. Ova pravila utječu
 *              i na pridruživanje identiteta, pa su uža i konzervativnija:
 *              popravljaju samo distorzije koje `roster_match.js` NE uspije
 *              razriješiti sam (mjereno), da se ne bi maskiralo pravo ime.
 */

"use strict";

/** [regex, zamjena, komentar s izmjerenim brojem pojava] */
const TERMS = [
    // Kratice izgovorene kao riječ ("er-ha", "ha-de-ze"), s hrvatskom sklonidbom.
    [/\berha\b/giu, "RH", "169×"],
    [/\bha\s?deze([aeouim]*)\b/giu, (_m, s) => `HDZ${suffix(s)}`, "210×"],
    [/\bes\s?depe([aeouim]*)\b/giu, (_m, s) => `SDP${suffix(s)}`, "69×"],
    [/\bha\s?eses([aeouim]*)\b/giu, (_m, s) => `HSLS${suffix(s)}`, "2×"],
    [/\bpefas([aeouim]*)\b/giu, (_m, s) => `PFAS${suffix(s)}`, "21×"],
    [/\bdorh([aeouim]*)\b/gu, (_m, s) => `DORH${suffix(s)}`, "19× (mala slova)"],
    [/\buskok([aeouim]*)\b/gu, (_m, s) => `USKOK${suffix(s)}`, "24× (mala slova)"],
    // Institucije i toponimi.
    [/\bAndrija\s+štamp(a|e|u|om)\b/giu, "Andrija Štampar", "4×"],
    [/\bpoštovani\s+poslovnik\b/giu, "Poslovnik", "0× — zadržano radi čitljivosti"],
    [/\bgeotehničk(i|og|om)\s+fakultet/giu, (m) => m, "bez izmjene, samo bilježi"],
];

/**
 * Prezimena. Ključ je normaliziran oblik koji ASR proizvodi, vrijednost je
 * ispravno prezime iz registra. Popravlja se SAMO ono što matcher promaši.
 */
const NAMES = [
    // „Selak Raspudić" → ASR ubacuje granicu riječi krivo: „Sela Kraspudić".
    // Matcher pada na 0.70 jer se „Kraspudić" i „Raspudić" razlikuju u prva
    // dva slova (namjerna kočnica u `tokenSim`). Izmjereno 10×.
    // (`\b` iza „ć" ne radi — ć nije word-znak u JS regexu, pa granica ide na razmak)
    [/\bSel[ao]\s+Krasp(?:udić|odić|udic|odic)/giu, "Selak Raspudić", "10×"],
    // „Vladimira Biljka" → Vladimira Bileka (padež + distorzija), 1×.
    // Nastavak se ČUVA — zamjena golim nominativom razbila bi rečenicu.
    [/\bBiljk(a|u|om|e|om)\b/giu, (_m, s) => `Bilek${s === "a" ? "a" : s}`, "1×"],
];

/** Hrvatski nastavak uz kraticu piše se s crticom: HDZ-a, SDP-u. */
function suffix(s) {
    return s ? `-${s.toLowerCase()}` : "";
}

/**
 * @param {string} text
 * @param {{names?:boolean}} [opts] `names:false` isključuje razred NAMES
 * @returns {string}
 */
function normalizeText(text, opts = {}) {
    if (!text) return text;
    let out = String(text);
    for (const [re, rep] of TERMS) out = out.replace(re, rep);
    if (opts.names !== false) {
        for (const [re, rep] of NAMES) out = out.replace(re, rep);
    }
    return out;
}

/** Broj primjena po pravilu — za `tools/audit_dictionary.js`. */
function countHits(text) {
    const rows = [];
    for (const [re, , note] of [...TERMS, ...NAMES]) {
        const m = String(text).match(new RegExp(re.source, re.flags));
        rows.push({ rule: re.source, hits: m ? m.length : 0, note });
    }
    return rows;
}

module.exports = { normalizeText, countHits, TERMS, NAMES };
