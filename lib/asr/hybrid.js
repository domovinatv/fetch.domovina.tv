/**
 * lib/asr/hybrid.js — hibrid „ASR daje riječi, pyannote daje govornike”.
 *
 * Govornik svake riječi je pyannoteova oznaka s NAJVEĆIM vremenskim preklapanjem; riječ
 * izvan svih segmenata dobiva najbliži segment (po sredini). Port `relabel_pyannote()`
 * iz e-satnica-sastanci/scripts/speechmatics_to_md.py, samo s dva pokazivača umjesto
 * O(riječi × segmenti) — epizoda od 3 h ima ~25 000 riječi i ~3 000 segmenata.
 *
 * Interpunkcija nasljeđuje govornika prethodne riječi (lijepi se na nju).
 */
"use strict";

/** pyannoteAI job JSON → [{start, end, speaker}] sortirano po startu. */
function pyannoteSegments(job) {
    const out = (job && job.output) || {};
    const segs = out.exclusiveDiarization || out.diarization || [];
    return segs
        .map((s) => ({ start: +s.start, end: +s.end, speaker: String(s.speaker) }))
        .filter((s) => s.end > s.start)
        .sort((a, b) => a.start - b.start);
}

/** Vraća NOVI niz riječi s `speaker` iz pyannotea. Ulaz se ne mijenja. */
function assignSpeakers(words, segs) {
    if (!segs.length) return words.map((w) => ({ ...w }));
    // Segmenti se preklapaju samo u ne-exclusive izlazu; prozor kandidata pokrivamo
    // pokazivačem na prvi segment koji bi mogao preklapati riječ (end > w.start).
    const maxLen = Math.max(...segs.map((s) => s.end - s.start));
    let lo = 0;
    let lastSpeaker = null;
    return words.map((w) => {
        if (w.punct) return { ...w, speaker: lastSpeaker ?? w.speaker };
        while (lo < segs.length && segs[lo].start + maxLen < w.start) lo++;
        let best = 0, spk = null;
        for (let i = lo; i < segs.length && segs[i].start < w.end; i++) {
            const o = Math.min(w.end, segs[i].end) - Math.max(w.start, segs[i].start);
            if (o > best) { best = o; spk = segs[i].speaker; }
        }
        if (spk === null) spk = nearest(segs, w.start).speaker;
        lastSpeaker = spk;
        return { ...w, speaker: spk };
    });
}

function nearest(segs, t) {
    // Binarno: prvi segment sa startom >= t, pa usporedi njega i prethodnika po sredini.
    let a = 0, b = segs.length;
    while (a < b) { const m = (a + b) >> 1; if (segs[m].start < t) a = m + 1; else b = m; }
    const cand = [segs[a - 1], segs[a], segs[a - 2], segs[a + 1]].filter(Boolean);
    return cand.reduce((x, y) => (Math.abs((y.start + y.end) / 2 - t) < Math.abs((x.start + x.end) / 2 - t) ? y : x));
}

/** Koliko se dva označavanja slažu po riječima, uz najbolje 1:1 mapiranje oznaka (pohlepno). */
function speakerAgreement(wordsA, wordsB) {
    const n = Math.min(wordsA.length, wordsB.length);
    const pair = new Map();
    for (let i = 0; i < n; i++) {
        if (wordsA[i].punct) continue;
        const k = `${wordsA[i].speaker}\u0000${wordsB[i].speaker}`;
        pair.set(k, (pair.get(k) || 0) + 1);
    }
    const usedA = new Set(), usedB = new Set();
    let agree = 0, total = 0;
    for (const v of pair.values()) total += v;
    for (const [k, v] of [...pair.entries()].sort((x, y) => y[1] - x[1])) {
        const [a, b] = k.split("\u0000");
        if (usedA.has(a) || usedB.has(b)) continue;
        usedA.add(a); usedB.add(b); agree += v;
    }
    return total ? agree / total : 0;
}

module.exports = { pyannoteSegments, assignSpeakers, speakerAgreement };
