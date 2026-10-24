"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pyRound, norm, matchingBlocks, parseCues, buildWords } = require("./generate_words_json.js");

const SRT = `1
00:00:01,000 --> 00:00:03,000
[SPEAKER_00] Dobar dan, dragi slušatelji.

2
00:00:03,000 --> 00:00:04,000
[SPEAKER_01] Hvala što ste tu danas

3
00:00:05,000 --> 00:00:06,000
bez oznake govornika se preskače
`;

test("parseCues: tekst bez [SPEAKER_XX], riječi po whitespaceu, cue bez oznake preskočen", () => {
    const c = parseCues(SRT);
    assert.equal(c.length, 2);
    assert.deepEqual(c[0], { s: 1000, e: 3000, toks: ["Dobar", "dan,", "dragi", "slušatelji."] });
});

test("norm: mala slova, bez dijakritika i interpunkcije", () => {
    assert.equal(norm("Slušatelji."), "slusatelji");
    assert.equal(norm("Đak,"), "đak");   // đ nema NFKD rastav — isto kao Python
});

test("matchingBlocks prati difflib (CPython) na ponavljanjima", () => {
    // python3 -c "import difflib;print(difflib.SequenceMatcher(None,'a b a c'.split(),'b a a c'.split(),autojunk=False).get_matching_blocks())"
    const got = matchingBlocks(["a", "b", "a", "c"], ["b", "a", "a", "c"]).sort((x, y) => x[0] - y[0]);
    assert.deepEqual(got, [[1, 0, 2], [3, 3, 1]]);
});

test("pyRound = Python round()", () => {
    assert.equal(pyRound(0.925, 2), 0.93);
    assert.equal(pyRound(0.125, 2), 0.12);
    assert.equal(pyRound(0.0625, 3), 0.062);
});

test("buildWords: broj parova = broj riječi, monotono, kratki rep upija sidra (MIN_MS)", () => {
    const W = [
        [1000, 1300, "Dobar"], [1300, 1500, "dan"], [1600, 1900, "dragi"], [1900, 2600, "slušatelji"],
        [3000, 3200, "Hvala"], [3200, 3400, "što"], [3400, 3550, "ste"], [3550, 3990, "tu"],
        // "danas" je Speechmatics stavio u sljedeći cue → bez upijanja bi dobio nulti raspon
        [4060, 4400, "danas"],
    ];
    const { doc, anch, tot } = buildWords(parseCues(SRT), W);
    assert.equal(tot, 9);
    assert.equal(anch, 8);
    assert.equal(doc.anchored, 0.889);
    for (const [k, c] of doc.cues.entries()) {
        assert.equal(c.w.length, parseCues(SRT)[k].toks.length * 2);
        for (let i = 2; i < c.w.length; i += 2) assert.ok(c.w[i] >= c.w[i - 2]);
    }
    const last = doc.cues[1].w.slice(-2);
    assert.ok(last[1] - last[0] >= 120, `zadnja riječ ${last} kraća od 120 ms`);
    assert.equal(last[1], 4000);
});

test("sonioxWords: interpunkcija nije riječ titla, vremena u ms", () => {
    const { sonioxWords } = require("./generate_words_json");
    const W = sonioxWords({ words: [
        { w: "Dobar", start: 0.12, end: 0.4 }, { w: "dan", start: 0.5, end: 0.81 },
        { w: ".", start: 0.5, end: 0.81, punct: true, eos: true },
    ] });
    assert.deepEqual(W, [[120, 400, "Dobar"], [500, 810, "dan"]]);
});

test("pickSource: prioritet Soniox → Speechmatics → Canary, ne najveći udio", () => {
    const { pickSource } = require("./generate_words_json");
    const r = (source, anchored, tot = 100) => ({ doc: { source, anchored }, anch: anchored * tot, tot });
    // Speechmatics ima više usidrenih, ali Soniox prolazi prag → Soniox (EN epizoda nuNw4qWs0r4: 91,3 vs 93,5)
    assert.equal(pickSource([r("speechmatics", 0.935), r("soniox", 0.913), r("canary", 0.03)], 0.6).doc.source, "soniox");
    // Soniox ispod praga → Speechmatics
    assert.equal(pickSource([r("canary", 0.9), r("soniox", 0.4), r("speechmatics", 0.7)], 0.6).doc.source, "speechmatics");
    // samo Canary prolazi → Canary
    assert.equal(pickSource([r("canary", 0.72), r("speechmatics", 0.5)], 0.6).doc.source, "canary");
    // nijedan ne prolazi → najviše usidrenih (za .words.skipped.json)
    assert.equal(pickSource([r("soniox", 0.3), r("canary", 0.5)], 0.6).doc.source, "canary");
});
