const test = require("node:test");
const assert = require("node:assert/strict");
const {
    splitTrailingPunctuation, sonioxTokensToRawWords, sonioxToWords, speechmaticsToWords, buildSegments, renderSrt,
} = require("./words");

// Soniox tokeni: dijelovi riječi, nova riječ počinje razmakom.
function tok(text, start_ms, end_ms, speaker = "1", extra = {}) {
    return { text, start_ms, end_ms, speaker, confidence: 0.9, ...extra };
}

test("interpunkcija na kraju riječi se odvaja, unutar riječi ostaje", () => {
    assert.deepEqual(splitTrailingPunctuation("listopada,"), ["listopada", ","]);
    assert.deepEqual(splitTrailingPunctuation("5.5"), ["5.5", ""]);
    assert.deepEqual(splitTrailingPunctuation("kraj?!"), ["kraj", "?!"]);
    assert.deepEqual(splitTrailingPunctuation("-"), ["", "-"]);
    assert.deepEqual(splitTrailingPunctuation("„rekao”."), ["„rekao", "”."]);
});

test("Soniox dijelovi riječi se spajaju, razmak otvara novu riječ", () => {
    const raw = sonioxTokensToRawWords([
        tok("Dob", 0, 100), tok("ar", 100, 200), tok(" dan", 300, 500), tok(" ", 500, 500), tok("svima", 600, 900),
    ]);
    assert.deepEqual(raw.map((w) => w.text), ["Dobar", "dan", "svima"]);
    assert.equal(raw[0].end_ms, 200);
});

test("tokeni prijevoda se preskaču", () => {
    const raw = sonioxTokensToRawWords([tok("Bok", 0, 100), tok(" Hi", 0, 100, "1", { translation_status: "translation" })]);
    assert.deepEqual(raw.map((w) => w.text), ["Bok"]);
});

test("Soniox: interpunkcija je zasebna stavka, kraj rečenice označen", () => {
    const w = sonioxToWords({ tokens: [tok("Dobar", 0, 200), tok(" dan.", 300, 500), tok(" Kako", 900, 1100)] });
    assert.deepEqual(w.map((x) => x.w), ["Dobar", "dan", ".", "Kako"]);
    assert.equal(w[2].punct, true);
    assert.equal(w[2].eos, true);
    assert.equal(w[1].punct, undefined);
    assert.equal(w[0].start, 0);
    assert.equal(w[1].end, 0.5);
});

test("„23. listopada” ostaje jedna rečenica", () => {
    const w = sonioxToWords({ tokens: [
        tok("Bilo", 0, 200), tok(" je", 200, 300), tok(" 23.", 300, 600), tok(" listopada.", 600, 1000),
    ] });
    const stops = w.filter((x) => x.eos);
    assert.equal(stops.length, 1);
    assert.equal(w[w.length - 1].eos, true);
    const { segments } = buildSegments(w);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, "Bilo je 23. listopada.");
});

test("točka ispred malog slova DRUGOG govornika ostaje kraj rečenice", () => {
    const w = sonioxToWords({ tokens: [tok("Gotovo.", 0, 400, "1"), tok(" da", 500, 700, "2")] });
    assert.equal(w[1].eos, true);
});

test("govor nakon zadnje točke se zatvara", () => {
    const w = sonioxToWords({ tokens: [tok("Dobro.", 0, 400), tok(" i", 500, 600), tok(" onda,", 600, 900)] });
    assert.equal(w[w.length - 1].eos, true);
});

test("Speechmatics json-v2 → isti format", () => {
    const w = speechmaticsToWords({ results: [
        { type: "word", start_time: 0, end_time: 0.4, alternatives: [{ content: "Dobar", speaker: "S1", confidence: 0.9 }] },
        { type: "word", start_time: 0.5, end_time: 0.8, alternatives: [{ content: "dan", speaker: "S1" }] },
        { type: "punctuation", start_time: 0.8, end_time: 0.8, is_eos: true, attaches_to: "previous", alternatives: [{ content: ".", speaker: "S1" }] },
        { type: "word", start_time: 1, end_time: 1.2, alternatives: [{ content: "Hm", speaker: "UU" }] },
    ] });
    assert.deepEqual(w.map((x) => [x.w, x.speaker, !!x.punct]), [
        ["Dobar", "S1", false], ["dan", "S1", false], [".", "S1", true], ["Hm", null, false],
    ]);
});

test("segmenti: promjena govornika lomi, interpunkcija ne posuđuje govornika", () => {
    const w = sonioxToWords({ tokens: [
        tok("Pitanje?", 0, 500, "1"), tok(" Odgovor", 600, 1200, "2"), tok(" je", 1200, 1400, "2"), tok(" da.", 1400, 1700, "2"),
    ] });
    const { segments, speakerCount } = buildSegments(w);
    assert.equal(speakerCount, 2);
    assert.deepEqual(segments.map((s) => [s.speaker, s.text]), [
        ["SPEAKER_00", "Pitanje?"], ["SPEAKER_01", "Odgovor je da."],
    ]);
    const srt = renderSrt(segments, true);
    assert.match(srt, /^1\n00:00:00,000 --> 00:00:00,500\n\[SPEAKER_00\] Pitanje\?\n/);
});

test("segmenti: duga pauza lomi samo kad segment ima ≥ 2 s", () => {
    const w = sonioxToWords({ tokens: [
        tok("A", 0, 2500), tok(" b", 5000, 5200), tok(" c", 9000, 9200),
    ] });
    const { segments } = buildSegments(w);
    assert.deepEqual(segments.map((s) => s.text), ["A", "b c"]);
});
