"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cs = require("./canary_skeleton");
const { canaryToWords, buildSegments } = require("./words");

function episode(files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-skel-"));
    const wav = path.join(dir, "20261113_ep_yt_ABCDEFGHIJK.wav");
    fs.writeFileSync(wav, "");
    fs.writeFileSync(wav + cs.WORD_TS, JSON.stringify({ v: 1, source: "canary",
        words: [[0, 400, "Dobar"], [400, 800, "dan."], [5000, 5400, "Hvala,"], [5400, 5800, "lijepo."]] }));
    for (const [suffix, body] of Object.entries(files)) {
        fs.writeFileSync(wav.replace(/\.wav$/, "") + suffix, typeof body === "string" ? body : JSON.stringify(body));
    }
    return wav;
}

test("canaryToWords odvaja interpunkciju i označava kraj rečenice", () => {
    const w = canaryToWords({ words: [[0, 500, "dan."], [500, 900, "Hvala,"], [900, 1200, "lijepo"]] });
    assert.deepEqual(w.map((x) => x.w), ["dan", ".", "Hvala", ",", "lijepo"]);
    assert.equal(w[1].punct, true);
    assert.equal(w[1].eos, true);
    assert.equal(w[3].eos, undefined);
    assert.equal(w[0].speaker, null);
});

test("svježa epizoda bez markera čeka cloud ASR", () => {
    const st = cs.fallbackStatus(episode());
    assert.equal(st.eligible, false);
    assert.match(st.reason, /čeka cloud ASR/);
});

test("marker .asr_failed.json pušta Canary odmah", () => {
    const st = cs.fallbackStatus(episode({ ".asr_failed.json": { reason: "organization_balance_exhausted" } }));
    assert.equal(st.eligible, true);
    assert.match(st.reason, /balance_exhausted/);
});

test("cloud kostur ili kanonski SRT blokiraju Canary", () => {
    const failed = { ".asr_failed.json": { reason: "x" } };
    assert.equal(cs.fallbackStatus(episode({ ...failed, ".mp3.soniox.words.json": { words: [] } })).eligible, false);
    assert.equal(cs.fallbackStatus(episode({ ...failed, ".wav.canary.diarized.srt": "1\n" })).eligible, false);
    assert.equal(cs.fallbackStatus(episode({ ...failed, ".silent.json": {} })).eligible, false);
});

test("stara epizoda (24 h+) bez cloud kostura ide na Canary", () => {
    const wav = episode();
    const t = (Date.now() - 30 * 3600000) / 1000;
    fs.utimesSync(wav, t, t);
    assert.equal(cs.fallbackStatus(wav).eligible, true);
});

test("buildSkeleton: s pyannote izlazom → canary_pyannote, dva govornika", () => {
    const wav = episode();
    fs.writeFileSync(wav + cs.PYANNOTE, JSON.stringify({ model: "pyannote/speaker-diarization-community-1",
        segments: [{ start: 0, end: 1, speaker: "SPEAKER_00" }, { start: 4.9, end: 6, speaker: "SPEAKER_01" }] }));
    const r = cs.buildSkeleton(wav);
    assert.equal(r.name, "canary_pyannote");
    const j = JSON.parse(fs.readFileSync(r.input, "utf-8"));
    const { segments, speakerCount } = buildSegments(j.words);
    assert.equal(speakerCount, 2);
    assert.equal(segments[0].text, "Dobar dan.");
    assert.equal(segments[1].text, "Hvala, lijepo.");
});

test("buildSkeleton: bez pyannotea → canary_solo, jedan govornik; kasniji pyannote briše solo", () => {
    const wav = episode();
    const solo = cs.buildSkeleton(wav);
    assert.equal(solo.name, "canary_solo");
    assert.equal(buildSegments(JSON.parse(fs.readFileSync(solo.input, "utf-8")).words).speakerCount, 1);
    fs.writeFileSync(wav + cs.PYANNOTE, JSON.stringify({ segments: [{ start: 0, end: 6, speaker: "A" }] }));
    const pa = cs.buildSkeleton(wav);
    assert.equal(pa.name, "canary_pyannote");
    assert.equal(fs.existsSync(solo.input), false);
});
