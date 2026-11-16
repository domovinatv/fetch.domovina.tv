"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    parseSrt, formatSrt, chunkCues, buildUserMessage, parseLines, parseAgy, validateChunk, diffStats, originNeedsFix,
} = require("./fix_transcript_opus");

const SRT = `1
00:00:00,000 --> 00:00:04,000
[SPEAKER_00] Ja svima njima kažem

2
00:00:04,000 --> 00:00:05,000
[SPEAKER_00] Hvala

3
00:00:05,000 --> 00:00:09,500
[SPEAKER_01] vam, Marija i Sveti Josip, dobrodošli u podcast Defin.
`;

test("parseSrt + formatSrt: vremena, idx i govornici ostaju", () => {
    const cues = parseSrt(SRT);
    assert.equal(cues.length, 3);
    assert.deepEqual(cues[1], { seq: 2, idx: "2", time: "00:00:04,000 --> 00:00:05,000", speaker: "SPEAKER_00", text: "Hvala" });
    assert.equal(formatSrt(cues), SRT);
});

test("chunkCues: mrvica na kraju ide u prethodni komad", () => {
    assert.deepEqual(chunkCues(new Array(405), 100), [{ from: 0, to: 100 }, { from: 100, to: 200 }, { from: 200, to: 300 }, { from: 300, to: 405 }]);
    assert.deepEqual(chunkCues(new Array(250), 100), [{ from: 0, to: 100 }, { from: 100, to: 200 }, { from: 200, to: 250 }]);
    assert.deepEqual(chunkCues(new Array(10), 100), [{ from: 0, to: 10 }]);
});

test("buildUserMessage: kontekst prije/poslije nije u komadu za ispravak", () => {
    const cues = parseSrt(SRT);
    const msg = buildUserMessage({ title: "T" }, cues, { from: 1, to: 2 });
    assert.match(msg, /KONTEKST PRIJE \(ne vraćaj\):\n1 \[SPEAKER_00\] Ja svima/);
    assert.match(msg, /CUE-OVI ZA ISPRAVAK \(seq 2–2, ukupno 1\):\n2 \[SPEAKER_00\] Hvala/);
    assert.match(msg, /KONTEKST POSLIJE \(ne vraćaj\):\n3 \[SPEAKER_01\]/);
});

test("parseLines: ignorira prozu i ograđivače, prvi seq pobjeđuje", () => {
    const m = parseLines("Evo ispravka:\n```\n2 [SPEAKER_01] Hvaljen\n3 [SPEAKER_01] Isus i Marija\n2 [SPEAKER_00] duplikat\n```");
    assert.deepEqual([...m.keys()], [2, 3]);
    assert.deepEqual(m.get(2), { speaker: "SPEAKER_01", text: "Hvaljen" });
});

test("parseAgy: JSON oblik", () => {
    const m = parseAgy({ cues: [{ seq: 2, speaker: "[SPEAKER_01]", text: " Hvaljen " }] });
    assert.deepEqual(m.get(2), { speaker: "SPEAKER_01", text: "Hvaljen" });
});

test("validateChunk: nedostaje seq → odbij", () => {
    const cues = parseSrt(SRT);
    const r = validateChunk(cues, parseLines("1 [SPEAKER_00] Ja svima njima kažem\n3 [SPEAKER_01] x"), new Set(["SPEAKER_00", "SPEAKER_01"]));
    assert.equal(r.ok, false);
    assert.match(r.reason, /nedostaju seq 2/);
});

test("validateChunk: govornik se mijenja samo na mrvici i samo na poznatu oznaku; prazan tekst = izvorni", () => {
    const cues = parseSrt(SRT);
    const out = "1 [SPEAKER_01] Ja svima njima kažem\n2 [SPEAKER_01] Hvaljen\n3 [SPEAKER_07] Isus i Marija i sveti Josip, dobrodošli u podcast re:DEFINICIJA.";
    const r = validateChunk(cues, parseLines(out), new Set(["SPEAKER_00", "SPEAKER_01"]));
    assert.equal(r.ok, true);
    assert.equal(r.cues[0].speaker, "SPEAKER_00");   // 4 riječi → ne smije
    assert.equal(r.cues[1].speaker, "SPEAKER_01");   // 1 riječ → smije
    assert.equal(r.cues[2].speaker, "SPEAKER_01");   // nepoznata oznaka → izvorna
    assert.equal(r.cues[1].time, cues[1].time);
    const r2 = validateChunk(cues.slice(1, 2), parseLines("2 [SPEAKER_00]"), new Set(["SPEAKER_00"]));
    assert.equal(r2.cues[0].text, "Hvala");
    const d = diffStats(cues, r.cues);
    assert.deepEqual(d, { changed: 2, speakers: 1 });
});

test("validateChunk: prekratak izlaz (sažimanje) → odbij", () => {
    const long = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, idx: String(i + 1), time: "t", speaker: "SPEAKER_00", text: "riječ ".repeat(10).trim() }));
    const out = long.map((c) => `${c.seq} [SPEAKER_00] kratko`).join("\n");
    const r = validateChunk(long, parseLines(out), new Set(["SPEAKER_00"]));
    assert.equal(r.ok, false);
    assert.match(r.reason, /duljina/);
});

test("originNeedsFix: Canary i Speechmatics da, Soniox i nepoznato ne", () => {
    for (const o of ["canary+pyannote_modal", "canary", "canary+pyannote_local", "speechmatics", "speechmatics+pyannote_ai"]) assert.equal(originNeedsFix(o), true, o);
    for (const o of ["soniox", "soniox+pyannote_ai", "nepoznato", null]) assert.equal(originNeedsFix(o), false, String(o));
});

test("processing_manifest: nakon ispravka origin dolazi iz .diarized.asr.srt", () => {
    const { buildManifest } = require("./lib/processing_manifest");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfix-"));
    const base = "20261116_x_yt_AAAAAAAAAAA";
    fs.writeFileSync(path.join(dir, `${base}.mp3.canary_pyannote.gemini.diarized.srt`), SRT);
    fs.writeFileSync(path.join(dir, `${base}.mp3.canary_pyannote.gemini.meta.json`), JSON.stringify({ gemini_ear: false }));
    fs.writeFileSync(path.join(dir, `${base}.diarized.asr.srt`), SRT);
    fs.writeFileSync(path.join(dir, `${base}.wav.canary.diarized.srt`), SRT.replace("Defin", "re:DEFINICIJA"));
    fs.writeFileSync(path.join(dir, `${base}.transcript_fix.json`), JSON.stringify({ backend: "claude:opus", model: "opus", changed_cues: 1, cues: 3, at: "2026-11-16T00:00:00Z" }));
    const m = buildManifest(dir, base);
    assert.equal(m.canonical_srt.origin, "canary+pyannote_modal");
    assert.equal(m.canonical_srt.transcript_fix.backend, "claude:opus");
    fs.rmSync(dir, { recursive: true, force: true });
});
