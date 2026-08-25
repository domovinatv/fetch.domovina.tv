/**
 * roster_match.js — razrješavanje imena izgovorenog na sjednici u zastupnika
 * iz službenog registra (`data/rosters/sabor_mps_11_saziv.json`).
 *
 * Zašto ovo nije obično uspoređivanje nizova — dva neovisna izvora šuma:
 *
 *  1. **Hrvatska sklonidba.** Predsjedavajući ne govori nominativ:
 *     „kolegu Troskota", „riječima kolega Borića", „kolegice Puljak".
 *  2. **ASR distorzija.** Izmjereno u ovom transkriptu: `Troskut`, `Troskogl`
 *     (Troskot), `Kukavic` (Kukavica), `Sela Kraspudić` / `Sela Kraspodić`
 *     (Selak Raspudić), `Biljka` (Bileka).
 *
 * Oba pomaka najviše diraju KRAJ riječi, a čuvaju početak — zato je nosiva
 * mjera Jaro-Winkler (nagrađuje zajednički prefiks), a Levenshtein služi kao
 * druga, neovisna provjera da JW ne prolazi na kratkim riječima presložno.
 *
 * ⛔ Tvrdo pravilo: kad dva zastupnika ostanu preblizu (npr. tri dvosmislena
 *    prezimena u 11. sazivu — Borić, Marković, Miloš), vraća se `null` s
 *    razlogom. Nasumično razrješenje bi zalijepilo krivi identitet na
 *    govornika kroz svih 20 h sjednice.
 */

"use strict";

/** Hrvatski-svjesna normalizacija: Đ→D, skini dijakritike, VELIKA slova. */
function normalizeToken(s) {
    if (!s) return "";
    return String(s)
        .replace(/Đ/g, "D").replace(/đ/g, "d")
        .normalize("NFD").replace(/\p{Mn}/gu, "")
        .toUpperCase().trim().replace(/^-+|-+$/g, "");
}

/** Razbij na razmake/crtice, normaliziraj, zadrži tokene ≥3 znaka. */
function nameTokens(s) {
    return String(s || "")
        .split(/[\s\-]+/)
        .map(normalizeToken)
        .filter((t) => t.length >= 3);
}

// --- mjere sličnosti ---

function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        prev = cur;
    }
    return prev[b.length];
}

function levRatio(a, b) {
    const m = Math.max(a.length, b.length);
    return m === 0 ? 1 : 1 - levenshtein(a, b) / m;
}

function jaro(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    const win = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const aFlag = new Array(a.length).fill(false);
    const bFlag = new Array(b.length).fill(false);
    let matches = 0;
    for (let i = 0; i < a.length; i++) {
        const lo = Math.max(0, i - win);
        const hi = Math.min(i + win + 1, b.length);
        for (let j = lo; j < hi; j++) {
            if (bFlag[j] || a[i] !== b[j]) continue;
            aFlag[i] = true; bFlag[j] = true; matches++;
            break;
        }
    }
    if (matches === 0) return 0;
    let k = 0, transpositions = 0;
    for (let i = 0; i < a.length; i++) {
        if (!aFlag[i]) continue;
        while (!bFlag[k]) k++;
        if (a[i] !== b[k]) transpositions++;
        k++;
    }
    transpositions /= 2;
    return (matches / a.length + matches / b.length +
            (matches - transpositions) / matches) / 3;
}

/** Jaro-Winkler — prefiksni bonus je upravo ono što traži sklonidba. */
function jaroWinkler(a, b, p = 0.1, maxPrefix = 4) {
    const j = jaro(a, b);
    let l = 0;
    while (l < Math.min(maxPrefix, a.length, b.length) && a[l] === b[l]) l++;
    return j + l * p * (1 - j);
}

/**
 * Sličnost dvaju imenskih tokena. Blend JW (nosiva) i Levenshteina (kočnica).
 * Dodatna kočnica: prva DVA slova moraju se poklapati, inače je rezultat
 * prepolovljen — ni sklonidba ni ASR ne mijenjaju početak prezimena, a bez
 * toga se „Matić" i „Batić" vežu presložno.
 */
function tokenSim(a, b) {
    if (a === b) return 1;
    const base = 0.65 * jaroWinkler(a, b) + 0.35 * levRatio(a, b);
    return a.slice(0, 2) === b.slice(0, 2) ? base : base * 0.5;
}

// --- razrješavanje ---

const MIN_TOKEN_SIM = 0.86;   // prag po tokenu (kalibriran nad ovom sjednicom)
const MIN_SCORE = 0.86;       // prag ukupnog rezultata kandidata
const MIN_MARGIN = 0.06;      // razmak do drugoplasiranog; ispod → dvosmisleno

/**
 * Rezultat kandidata: koliko izgovorenih tokena nalazi partnera među tokenima
 * zastupnika. Ime iz najave je često SAMO prezime („Kolega Grmoja, izvolite"),
 * pa se traži pokrivenost IZGOVORENIH tokena, ne svih tokena zastupnika.
 */
function scoreCandidate(spokenTokens, mp) {
    if (!spokenTokens.length) return { score: 0, matched: 0 };
    const pool = mp.tokens.slice();
    let sum = 0, matched = 0;
    for (const t of spokenTokens) {
        let bestIdx = -1, best = 0;
        for (let i = 0; i < pool.length; i++) {
            const s = tokenSim(t, pool[i]);
            if (s > best) { best = s; bestIdx = i; }
        }
        if (best >= MIN_TOKEN_SIM) {
            matched++;
            sum += best;
            pool.splice(bestIdx, 1);          // token zastupnika troši se jednom
        }
    }
    if (matched === 0) return { score: 0, matched: 0 };
    // Nepodudarene izgovorene tokene kažnjavamo — „Ivan Matić" protiv zastupnika
    // koji je samo „Matić" mora biti slabiji od zastupnika „Ivan Matić".
    const coverage = matched / spokenTokens.length;
    return { score: (sum / matched) * (0.55 + 0.45 * coverage), matched };
}

/**
 * Rod osobnog imena — IZVEDEN, ne iz izvora. `sabor.hr` ga ne objavljuje.
 *
 * Koristi se ISKLJUČIVO kao razbijač neriješenog izjednačenja između dva već
 * pronađena kandidata (vidi `resolve`), nikad za samo pronalaženje. Zato je
 * pogrešna procjena bezopasna u smjeru u kojem je vjerojatna: ako rod nije
 * siguran, vraća `null` i izjednačenje ostaje nerazriješeno kao i prije.
 *
 * Hrvatska su imena rodovno jaka („-a" → žensko), ali s poznatim iznimkama
 * koje su ovdje nabrojane, a ne pogođene.
 */
const MALE_A_ENDING = new Set([
    "NIKOLA", "LUKA", "MATIJA", "ANDRIJA", "ILIJA", "SASA", "MISA", "NIKSA",
    "KRSTO", "JAKSA", "VANJA", "BORNA", "JURICA", "IVICA", "PERICA", "MARICA",
    "STIPICA", "ANTICA", "MILA", "KRESIMIRA",
]);
const FEMALE_CONSONANT = new Set([
    "INES", "DORIS", "NIVES", "KARMEN", "INGRID", "JASMIN", "MERI", "NADA",
]);
/** Imena koja su i muška i ženska — nikad ne razbijaju izjednačenje. */
const GENDER_AMBIGUOUS = new Set(["VANJA", "SASA", "MISA", "MATIJA", "BORNA"]);

function inferGender(firstName) {
    const n = normalizeToken(String(firstName || "").split(/\s+/)[0]);
    if (!n || GENDER_AMBIGUOUS.has(n)) return null;
    if (FEMALE_CONSONANT.has(n)) return "z";
    if (MALE_A_ENDING.has(n)) return "m";
    if (/A$/.test(n)) return "z";
    if (/[BCDFGHJKLMNPQRSTVWXZEIOU]$/.test(n)) return "m";
    return null;
}

class RosterMatcher {
    constructor(roster) {
        this.roster = roster;
        this.mps = roster.mps || [];
        this.cache = new Map();
        this.ambiguousSurnames = new Set(
            (roster.ambiguous_surnames || []).map((a) => a.prezime)
        );
    }

    /**
     * @param {string} spokenName sirovo ime iz najave, npr. „Sela Kraspudić"
     * @param {{titleGender?:"m"|"z"|null}} [opts] rod iz titule („kolegice" → ž)
     * @returns {{mp:object|null, score:number, runnerUp:object|null, reason:string}}
     */
    resolve(spokenName, opts = {}) {
        const key = `${normalizeToken(spokenName)}|${opts.titleGender || ""}`;
        if (this.cache.has(key)) return this.cache.get(key);
        const out = this._resolve(spokenName, opts);
        this.cache.set(key, out);
        return out;
    }

    _resolve(spokenName, opts = {}) {
        const tokens = nameTokens(spokenName);
        if (!tokens.length) {
            return { mp: null, score: 0, runnerUp: null, reason: "prazno ime" };
        }
        const scored = this.mps
            .map((mp) => ({ mp, ...scoreCandidate(tokens, mp) }))
            .filter((c) => c.score > 0)
            .sort((a, b) => b.score - a.score || b.matched - a.matched);

        if (!scored.length) {
            return { mp: null, score: 0, runnerUp: null, reason: "nema kandidata" };
        }
        const top = scored[0];
        const second = scored[1] || null;
        if (top.score < MIN_SCORE) {
            return {
                mp: null, score: round4(top.score), runnerUp: null,
                reason: `ispod praga (${round4(top.score)} < ${MIN_SCORE}), najbliži ${top.mp.puno_ime}`,
            };
        }
        if (second && top.score - second.score < MIN_MARGIN) {
            // Titula nosi rod („Kolegice Miloš" → ženski). U 11. sazivu su SVA
            // tri dvosmislena prezimena (Borić, Marković, Miloš) rodovno
            // raznorodni parovi, pa ih titula razrješava bez pogađanja.
            const tg = opts.titleGender;
            if (tg) {
                const tied = scored.filter((c) => top.score - c.score < MIN_MARGIN);
                const fits = tied.filter((c) => inferGender(c.mp.ime) === tg);
                const genders = new Set(tied.map((c) => inferGender(c.mp.ime)));
                if (fits.length === 1 && !genders.has(null)) {
                    return {
                        mp: fits[0].mp, score: round4(fits[0].score),
                        runnerUp: top.mp === fits[0].mp ? (second ? second.mp : null) : top.mp,
                        reason: `razriješeno rodom titule (${tg})`,
                    };
                }
            }
            return {
                mp: null, score: round4(top.score), runnerUp: second.mp,
                reason: `dvosmisleno: ${top.mp.puno_ime} (${round4(top.score)}) vs ` +
                        `${second.mp.puno_ime} (${round4(second.score)})`,
            };
        }
        return {
            mp: top.mp, score: round4(top.score),
            runnerUp: second ? second.mp : null, reason: "ok",
        };
    }
}

function round4(v) { return Math.round(v * 10000) / 10000; }

module.exports = {
    RosterMatcher,
    inferGender,
    normalizeToken,
    nameTokens,
    tokenSim,
    jaroWinkler,
    levRatio,
    MIN_TOKEN_SIM,
    MIN_SCORE,
    MIN_MARGIN,
};
