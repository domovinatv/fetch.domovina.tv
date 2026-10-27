/**
 * refine_drift.js — detektor POMAKA ID-a u Gemini sluhu (KORAK 2.8).
 *
 * Gemini dobije popis segmenata (id, od, do, natuknica) i za svaki vrati tekst.
 * Unutar dugog prozora zna „zaostati": točne riječi stavi pod id SLJEDEĆEG
 * segmenta, pa pod onaj iza njega, i zaostatak raste (ja70p_gJWZA, 26.10.2026.:
 * od 1 segmenta na 49:47 do 15 segmenata na 56 min, ~3 min govora izgubljeno).
 * Vremena ostaju točna, tekst nije — titl i words.json se razilaze sa zvukom.
 *
 * Quality gate u refineu broji samo RIJEČI po prozoru (65 %); pomaknut tekst ima
 * jednako riječi pa prolazi. Ovaj modul uspoređuje svaki segment s natuknicom
 * (kosturom) ISTOG id-a i susjednih id-ova:
 *
 *   - „pomaknut" = tekst se bitno bolje slaže s kosturom susjeda (k ≠ 0) nego sa
 *     svojim. Samo NIZAK sklad sa svojim kosturom NIJE dokaz — to je upravo slučaj
 *     koji refine popravlja (ASR collapse „ono ono ono…" → stvarni govor).
 *   - niz = barem MIN_SHIFTED pomaknutih segmenata; traje dok se OK_TO_CLOSE
 *     uzastopnih ocijenjenih segmenata ne poklopi sa svojim kosturom. Sve u nizu
 *     (i kratke upadice, i segmenti bez para) je sumnjivo.
 *
 * Nula API poziva, deterministički. Koriste ga refine_diarized_gemini.js (ograda
 * pri pisanju) i tools/fix_refine_drift.js (backfill postojećih prijepisa).
 * Vidi docs/2026-10-27-gemini-sluh-pomak-id.md.
 */

const DEFAULTS = {
    minWords: 6,       // kraći segmenti se ne ocjenjuju (premalo riječi za presudu)
    maxShift: 20,      // koliko susjeda lijevo/desno gledamo
    shiftMin: 0.6,     // susjed mora pokriti barem ovoliko riječi segmenta…
    shiftMargin: 0.3,  // …i to barem ovoliko bolje od vlastitog kostura
    okSim: 0.4,        // vlastiti kostur ovoliko pokriven = segment je na mjestu
    minShifted: 2,     // jedan izolirani pomak je rub segmenta, ne zaostatak
    okToClose: 2,      // toliko uzastopnih „na mjestu" zatvara niz
};

function tokens(text) {
    return String(text || "")
        .replace(/^\[[^\]]+\]\s*/, "")
        .toLowerCase()
        .normalize("NFC")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
}

// Udio riječi iz `a` koje postoje u `b` (skup). 0 kad je bilo koja strana prazna.
function coverage(a, b) {
    if (!a.length || !b.length) return 0;
    const set = new Set(b);
    let hit = 0;
    for (const w of a) if (set.has(w)) hit++;
    return hit / a.length;
}

/**
 * @param {string[]} refined  tekst po segmentu (Gemini); null/"" = nema ocjene
 * @param {string[]} skeleton tekst kostura po segmentu, ISTI indeksi
 * @returns {{ runs: Array<{from:number,to:number,shifted:number,maxShift:number}>,
 *             suspect: Set<number>, verdicts: Array<object|null> }}
 */
function detectDrift(refined, skeleton, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const R = refined.map(tokens);
    const S = skeleton.map(tokens);
    const n = R.length;

    const verdicts = R.map((r, i) => {
        if (r.length < o.minWords) return null;
        const own = coverage(r, S[i] || []);
        let bestK = 0, best = 0;
        for (let k = -o.maxShift; k <= o.maxShift; k++) {
            if (k === 0) continue;
            const j = i + k;
            if (j < 0 || j >= n) continue;
            const c = coverage(r, S[j]);
            if (c > best) { best = c; bestK = k; }
        }
        const shifted = best >= o.shiftMin && best - own >= o.shiftMargin;
        return { own, best, k: bestK, shifted, ok: !shifted && own >= o.okSim };
    });

    const runs = [];
    let cur = null, okStreak = 0, lastBad = -1;
    const close = () => {
        if (cur && cur.shifted >= o.minShifted) { cur.to = lastBad; runs.push(cur); }
        cur = null;
    };
    for (let i = 0; i < n; i++) {
        const v = verdicts[i];
        if (!v) continue;
        if (v.shifted) {
            if (!cur) cur = { from: i, to: i, shifted: 0, maxShift: 0 };
            cur.shifted++;
            cur.maxShift = Math.max(cur.maxShift, Math.abs(v.k));
            lastBad = i; okStreak = 0;
        } else if (cur) {
            if (v.ok) {
                if (++okStreak >= o.okToClose) close();
            } else {
                lastBad = i; okStreak = 0;  // bez para unutar niza = dio niza
            }
        }
    }
    close();

    const suspect = new Set();
    for (const r of runs) for (let i = r.from; i <= r.to; i++) suspect.add(i);
    return { runs, suspect, verdicts };
}

module.exports = { detectDrift, tokens, coverage, DEFAULTS };
