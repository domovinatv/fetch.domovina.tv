// tools/reprocess_episode.js stash — što ponovna obrada sklanja. `node --test tools/`
// Nula mreže: radi nad privremenim direktorijem.
//
// Zašto test: ad-hoc fast-path od 24.10.2026. ide Soniox (2.7b) + pyannoteAI (2.7c) +
// Gemini sluh (2.8, promote). Ako `--scope derived` ne skloni i te artefakte, re-run
// tiho zadrži stari kostur: 2.7b/2.7c preskoče epizodu (izlaz postoji), 2.8 nađe stari
// `.soniox_pyannote.gemini.diarized.srt` i ne radi ništa — novi prijepis nikad ne nastane.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "reprocess_episode.js");
const ID = "6e1MW97dv10";
const BASE = `20261024_naslov_yt_${ID}`;

// Izvor: ne smije se dirati ni u jednom scopeu.
const SOURCE = [".mp3", ".wav", ".info.json", ".description", ".loudnorm.json", ".jpg"];
// Novi transkripcijski flow (transcribe_soniox.js, diarize_pyannote_ai.js,
// refine_diarized_gemini.js, lib/processing_manifest.js) + stari kanonski prijepis.
const TRANSCRIPT_DERIVED = [
    ".mp3.soniox.json", ".mp3.soniox.meta.json", ".mp3.soniox.srt",
    ".mp3.soniox.diarized.srt", ".mp3.soniox.words.json",
    ".mp3.speechmatics.json", ".mp3.speechmatics.meta.json", ".mp3.speechmatics.srt",
    ".mp3.speechmatics.diarized.srt",
    ".mp3.pyannote_ai.json", ".mp3.pyannote_ai.meta.json",
    ".mp3.soniox_pyannote.diarized.srt", ".mp3.soniox_pyannote.words.json",
    ".mp3.speechmatics_pyannote.diarized.srt", ".mp3.speechmatics_pyannote.words.json",
    ".mp3.soniox_pyannote.gemini.diarized.srt", ".mp3.soniox_pyannote.gemini.meta.json",
    ".mp3.speechmatics_pyannote.gemini.diarized.srt", ".mp3.speechmatics_pyannote.gemini.meta.json",
    ".mp3.speechmatics.gemini.diarized.srt", ".mp3.speechmatics.gemini.meta.json",
    ".wav.canary.srt", ".wav.canary.word_ts.json", ".wav.canary.diarized.srt",
    ".processing.json", ".words.json", ".segments.jsonl",
];
const ARTICLE_DERIVED = [
    ".canary.summary.json", "_2026-10-24_opus.article.json", "_2026-10-24_opus.outline.json",
];

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reprocess-test-"));
    const dir = path.join(root, "_unlisted");
    fs.mkdirSync(dir);
    for (const s of [...SOURCE, ...TRANSCRIPT_DERIVED, ...ARTICLE_DERIVED]) {
        fs.writeFileSync(path.join(dir, BASE + s), "x");
    }
    // Druga epizoda u istom diru — ne smije se dirati.
    fs.writeFileSync(path.join(dir, "20260101_drugi_yt_AAAAAAAAAAA.mp3.soniox.words.json"), "x");
    return { root, dir };
}

function stash(root, scope) {
    const r = spawnSync("node", [SCRIPT, "stash", "--input-dir", root, "--dir", "_unlisted",
        "--video-id", ID, "--scope", scope], { encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
}

test("--scope derived sklanja Soniox/pyannoteAI/Gemini sluh artefakte, izvor ostaje", () => {
    const { root, dir } = setup();
    stash(root, "derived");
    const left = new Set(fs.readdirSync(dir));
    for (const s of SOURCE) assert.ok(left.has(BASE + s), `izvor ${s} mora ostati`);
    for (const s of [...TRANSCRIPT_DERIVED, ...ARTICLE_DERIVED]) {
        assert.ok(!left.has(BASE + s), `${s} je trebao otići u .reprocess_bak`);
    }
    assert.ok(left.has("20260101_drugi_yt_AAAAAAAAAAA.mp3.soniox.words.json"), "tuđa epizoda ostaje");
    const bak = path.join(root, ".reprocess_bak", "_unlisted");
    const [run] = fs.readdirSync(bak);
    assert.equal(fs.readdirSync(path.join(bak, run)).length, TRANSCRIPT_DERIVED.length + ARTICLE_DERIVED.length);
    fs.rmSync(root, { recursive: true, force: true });
});

test("--scope article ne dira prijepis ni kostur novog flowa", () => {
    const { root, dir } = setup();
    stash(root, "article");
    const left = new Set(fs.readdirSync(dir));
    for (const s of TRANSCRIPT_DERIVED) assert.ok(left.has(BASE + s), `${s} mora ostati uz --scope article`);
    for (const s of ARTICLE_DERIVED) assert.ok(!left.has(BASE + s), `${s} je trebao otići`);
    fs.rmSync(root, { recursive: true, force: true });
});
