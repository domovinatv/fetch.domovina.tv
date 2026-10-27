const { test } = require("node:test");
const assert = require("node:assert/strict");
const { detectDrift, coverage, tokens } = require("./refine_drift");

// 30 rečenica kostura: 2 zajedničke riječi + 7 vlastitih (kao stvaran govor).
const SK = Array.from({ length: 30 }, (_, i) =>
    "[SPEAKER_00] i je " + Array.from({ length: 7 }, (_, j) => `r${i}w${j}`).join(" "));

test("tokens: skida oznaku govornika, interpunkciju i velika slova", () => {
    assert.deepEqual(tokens("[SPEAKER_01] Da, ajmo — je!"), ["da", "ajmo", "je"]);
});

test("coverage: udio riječi prvog niza u drugom", () => {
    assert.equal(coverage(["a", "b"], ["b", "c"]), 0.5);
    assert.equal(coverage([], ["a"]), 0);
});

test("prijepis na mjestu (sitne ispravke) — nema niza", () => {
    const refined = SK.map((t) => t.replace("w3", "w3x"));
    const r = detectDrift(refined, SK);
    assert.equal(r.runs.length, 0);
    assert.equal(r.suspect.size, 0);
});

test("rastući zaostatak (ja70p_gJWZA) — jedan niz, pokriva sve pomaknute", () => {
    // od 10. segmenta tekst kasni 1, pa 2, pa 3 segmenta; od 20. opet na mjestu
    const refined = SK.map((t, i) => {
        if (i < 10 || i >= 20) return t;
        const lag = 1 + Math.floor((i - 10) / 4);
        return SK[i - lag];
    });
    const r = detectDrift(refined, SK);
    assert.equal(r.runs.length, 1);
    assert.equal(r.runs[0].from, 10);
    assert.equal(r.runs[0].to, 19);
    assert.ok(r.runs[0].maxShift >= 3);
    for (let i = 10; i < 20; i++) assert.ok(r.suspect.has(i), `seg ${i}`);
    assert.ok(!r.suspect.has(9) && !r.suspect.has(20));
});

test("ASR collapse u kosturu — Gemini popravak NIJE pomak", () => {
    const skel = SK.slice();
    for (let i = 5; i < 12; i++) skel[i] = "[SPEAKER_00] ono ono ono ono ono ono ono ono";
    const r = detectDrift(SK, skel);   // Gemini je napisao pravi govor
    assert.equal(r.runs.length, 0);
});

test("izolirani pomak na rubu segmenta nije niz", () => {
    const refined = SK.slice();
    refined[7] = SK[8];
    assert.equal(detectDrift(refined, SK).runs.length, 0);
});

test("segment bez para unutar niza je dio niza", () => {
    const refined = SK.map((t, i) => (i >= 10 && i < 16 ? SK[i - 1] : t));
    refined[13] = "[SPEAKER_00] potpuno drugačiji tekst kojeg nema nigdje u kosturu";
    const r = detectDrift(refined, SK);
    assert.equal(r.runs.length, 1);
    assert.ok(r.suspect.has(13));
});
