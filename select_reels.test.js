"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeReels, parseJsonLoose, anchorSec, extractVideoId } = require("./select_reels");

// 6 cue-ova po 20 s; svaki ima 4 riječi po 5 s
const segs = Array.from({ length: 6 }, (_, i) => ({
    seq: i + 1, start_sec: i * 20, end_sec: i * 20 + 20, speaker: i % 2 ? "Voditelj" : "Gost",
    text: `Riječ${i + 1} išla je Čakovec`,
}));
const words = {
    source: "soniox",
    cues: segs.map(s => ({ s: s.start_sec * 1000, e: s.end_sec * 1000, w: [0, 1, 2, 3].flatMap(k => [(s.start_sec + 5 * k) * 1000, (s.start_sec + 5 * k + 4) * 1000]) })),
};

test("granice dolaze iz cue-ova, ne iz modela", () => {
    const { reels } = normalizeReels({ reels: [{ start_seq: 2, end_seq: 4, title: "A", score: 8 }] }, segs);
    assert.equal(reels.length, 1);
    assert.equal(reels[0].start_sec, 20);
    assert.equal(reels[0].end_sec, 80);
    assert.deepEqual(reels[0].speakers, ["Voditelj", "Gost"]);
});

test("odbacuje prekratke, preduge i nepostojeće seq-ove", () => {
    const { reels, rejected } = normalizeReels({ reels: [
        { start_seq: 1, end_seq: 1, title: "kratko" },
        { start_seq: 1, end_seq: 6, title: "dugo" },
        { start_seq: 9, end_seq: 10, title: "nema" },
    ] }, segs);
    assert.equal(reels.length, 0);
    assert.equal(rejected.length, 3);
});

test("od preklopljenih ostaje bolje ocijenjen, rang ide po ocjeni", () => {
    const { reels, rejected } = normalizeReels({ reels: [
        { start_seq: 1, end_seq: 2, title: "slabiji", score: 5 },
        { start_seq: 2, end_seq: 3, title: "bolji", score: 9 },
        { start_seq: 5, end_seq: 6, title: "treći", score: 7 },
    ] }, segs);
    assert.deepEqual(reels.map(r => [r.rank, r.title]), [[1, "bolji"], [2, "treći"]]);
    assert.match(rejected[0].reason, /preklapa/);
});

test("kartica se sidri na riječ iz words.json, bez dijakritika i interpunkcije", () => {
    assert.equal(anchorSec(words, segs, 3, "čakovec"), 55);
    assert.equal(anchorSec(words, segs, 3, "išla je,"), 45);
    assert.equal(anchorSec(words, segs, 3, "nepostojeće"), null);
    assert.equal(anchorSec(null, segs, 3, "je"), null);

    const { reels } = normalizeReels({ reels: [{ start_seq: 2, end_seq: 4, title: "A", cards: [
        { type: "pin", at_seq: 3, anchor: "Čakovec", text: "Čakovec" },
        { type: "hook", at_seq: 2, text: "udica" },
    ] }] }, segs, words);
    assert.deepEqual(reels[0].cards.map(c => [c.type, c.at_sec, c.anchored]), [["hook", 0, false], ["pin", 35, true]]);
});

test("parseJsonLoose skida markdown ogradu", () => {
    assert.deepEqual(parseJsonLoose('```json\n{"reels":[]}\n```'), { reels: [] });
    assert.throws(() => parseJsonLoose("nema json"));
});

test("extractVideoId uzima zadnji _yt_", () => {
    assert.equal(extractVideoId("x_yt_naslov_yt_f2HIRJPHHK4.segments.jsonl"), "f2HIRJPHHK4");
});

test("_unlisted kopija ne dobiva poziv kad je epizoda i u kanalu", () => {
    const { dropUnlistedDuplicates } = require("./select_reels");
    const eps = [{ channel: "_unlisted", vid: "A" }, { channel: "kanal", vid: "A" }, { channel: "_unlisted", vid: "B" }];
    assert.deepEqual(dropUnlistedDuplicates(eps).map(e => `${e.channel}/${e.vid}`), ["kanal/A", "_unlisted/B"]);
});
