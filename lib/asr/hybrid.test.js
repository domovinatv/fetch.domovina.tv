const test = require("node:test");
const assert = require("node:assert/strict");
const { pyannoteSegments, assignSpeakers, speakerAgreement } = require("./hybrid");

const W = (w, start, end, extra = {}) => ({ w, start, end, speaker: "1", ...extra });

test("exclusiveDiarization ima prednost, segmenti se sortiraju", () => {
    const segs = pyannoteSegments({ output: {
        diarization: [{ start: 0, end: 9, speaker: "X" }],
        exclusiveDiarization: [{ start: 5, end: 9, speaker: "SPEAKER_01" }, { start: 0, end: 5, speaker: "SPEAKER_00" }],
    } });
    assert.deepEqual(segs.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_01"]);
});

test("riječ dobiva govornika s najvećim preklapanjem", () => {
    const segs = [{ start: 0, end: 1.2, speaker: "A" }, { start: 1.2, end: 3, speaker: "B" }];
    const out = assignSpeakers([W("prva", 0.1, 0.5), W("granica", 1.0, 1.6), W("druga", 2, 2.5)], segs);
    assert.deepEqual(out.map((w) => w.speaker), ["A", "B", "B"]);
});

test("riječ izvan svih segmenata ide najbližem", () => {
    const segs = [{ start: 0, end: 1, speaker: "A" }, { start: 10, end: 11, speaker: "B" }];
    const out = assignSpeakers([W("x", 8.5, 8.8), W("y", 1.5, 1.7)], segs);
    assert.deepEqual(out.map((w) => w.speaker), ["B", "A"]);
});

test("interpunkcija nasljeđuje govornika prethodne riječi", () => {
    const segs = [{ start: 0, end: 1, speaker: "A" }, { start: 1, end: 2, speaker: "B" }];
    const out = assignSpeakers([W("kraj", 0.5, 0.99), W(".", 0.99, 1.5, { punct: true, eos: true })], segs);
    assert.deepEqual(out.map((w) => w.speaker), ["A", "A"]);
});

test("ulaz se ne mijenja", () => {
    const words = [W("a", 0, 1)];
    assignSpeakers(words, [{ start: 0, end: 1, speaker: "Z" }]);
    assert.equal(words[0].speaker, "1");
});

test("slaganje govornika ne ovisi o imenima oznaka", () => {
    const a = [W("a", 0, 1, { speaker: "1" }), W("b", 1, 2, { speaker: "2" }), W("c", 2, 3, { speaker: "2" })];
    const b = [W("a", 0, 1, { speaker: "S9" }), W("b", 1, 2, { speaker: "S3" }), W("c", 2, 3, { speaker: "S9" })];
    assert.equal(speakerAgreement(a, a), 1);
    assert.equal(Math.round(speakerAgreement(a, b) * 100), 67);
});
