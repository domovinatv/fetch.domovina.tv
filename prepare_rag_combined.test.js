"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseSrt, buildSegmentsJsonl, speakerNameFor } = require("./prepare_rag_combined.js");

const SRT = `1
00:00:05,000 --> 00:00:07,250
[SPEAKER_01] Drugi po vremenu.

2
00:00:01,123 --> 00:00:03,000
[SPEAKER_00] Matija, hoćeš ti za djecu svoju?

3
00:00:08,000 --> 00:00:09,000
[SPEAKER_02]

4
00:00:10,000 --> 00:00:11,500
bez oznake govornika
`;

const META = {
    youtubeId: "35Oq01CmGWE", channel: "40_dana_za_zivot", uploadDate: "2026-10-02",
    srtSource: "canary", speakerMap: { SPEAKER_00: "Ante Čaljkušić", SPEAKER_01: "SPEAKER_01" }
};

test("segments: seq po start_sec, prazni cue van, polja po §14", () => {
    const rows = buildSegmentsJsonl(parseSrt(SRT), META).trimEnd().split("\n").map(JSON.parse);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], {
        id: "35Oq01CmGWE_1", youtube_id: "35Oq01CmGWE", channel: "40_dana_za_zivot",
        upload_date: "2026-10-02", seq: 1, start_sec: 1.123, end_sec: 3,
        speaker_id: "SPEAKER_00", speaker: "Ante Čaljkušić", srt_source: "canary",
        text: "Matija, hoćeš ti za djecu svoju?"
    });
    assert.equal(rows[1].speaker, null);          // placeholder nije ime
    assert.equal(rows[2].speaker_id, null);       // cue bez taga
    assert.equal(rows[2].text, "bez oznake govornika");
});

test("segments: deterministički izlaz", () => {
    assert.equal(buildSegmentsJsonl(parseSrt(SRT), META), buildSegmentsJsonl(parseSrt(SRT), META));
});

test("speakerNameFor: null za nepoznato, prazno i SPEAKER_XX", () => {
    assert.equal(speakerNameFor(null, {}), null);
    assert.equal(speakerNameFor("SPEAKER_00", { SPEAKER_00: "  " }), null);
    assert.equal(speakerNameFor("SPEAKER_00", { SPEAKER_00: "speaker_00" }), null);
    assert.equal(speakerNameFor("SPEAKER_00", { SPEAKER_00: " Ana " }), "Ana");
});
