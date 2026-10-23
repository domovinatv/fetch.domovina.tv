const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildManifest, writeManifest, baseFromAudio } = require("./processing_manifest");

const BASE = "20261017_naslov_s_yt_u_imenu_yt_DOfcONrRyDY";

function fixture(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "procman-"));
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
    }
    return dir;
}

test("kanonski SRT se prepoznaje po SADRŽAJU (Speechmatics+Gemini promocija)", () => {
    const srt = "1\n00:00:00,000 --> 00:00:01,000\n[SPEAKER_00] Bok\n";
    const dir = fixture({
        [`${BASE}.wav.canary.srt`]: "x",
        [`${BASE}.wav.canary.diarized.srt`]: srt,
        [`${BASE}.mp3.speechmatics.gemini.diarized.srt`]: srt,
        [`${BASE}.mp3.speechmatics.gemini.meta.json`]: { model: "gemini-3.8-flash", at: "2026-10-18T01:16:27Z" },
    });
    const m = buildManifest(dir, BASE);
    assert.equal(m.video_id, "DOfcONrRyDY");
    assert.equal(m.canonical_srt.origin, "speechmatics+gemini");
    assert.equal(m.gemini_ear.model, "gemini-3.8-flash");
    assert.ok(!m.diarization.some((d) => d.provider === "pyannote_local"));
});

test("canary + lokalni pyannote kad kanonski ne odgovara nijednom cloud izlazu", () => {
    const dir = fixture({
        [`${BASE}.wav.canary.srt`]: "x",
        [`${BASE}.wav.canary.diarized.srt`]: "kanonski",
        [`${BASE}.mp3.soniox_pyannote.diarized.srt`]: "drukčiji",
    });
    const m = buildManifest(dir, BASE);
    assert.equal(m.canonical_srt.origin, "canary+pyannote_local");
    assert.deepEqual(m.diarization, [{ provider: "pyannote_local", voice_embeddings: false }]);
});

test("servirani članak = leksikografski najveći (isti datum: opus > gemini-*), slug s točkama", () => {
    const dir = fixture({
        [`${BASE}.wav.canary.diarized.srt`]: "s",
        [`${BASE}.wav.canary.diarized_2026-10-18_gemini-3.8-flash.article.json`]: { metadata: { model: "gemini-3.8-flash" } },
        [`${BASE}.wav.canary.diarized_2026-10-18_opus.article.json`]: { metadata: { model: "claude-code:opus", complete: true } },
    });
    const m = buildManifest(dir, BASE);
    assert.equal(m.article.all.length, 2);
    assert.match(m.article.served, /_opus\.article\.json$/);
    assert.equal(m.article.all.find((a) => a.slug === "gemini-3.8-flash").model, "gemini-3.8-flash");
});

test("writeManifest ne prepisuje datoteku kad se sadržaj nije promijenio", () => {
    const dir = fixture({ [`${BASE}.wav.canary.diarized.srt`]: "s" });
    const a = writeManifest(dir, BASE);
    assert.equal(a.changed, true);
    const b = writeManifest(dir, BASE);
    assert.equal(b.changed, false);
    assert.equal(b.doc.generated_at, a.doc.generated_at);
});

test("baseFromAudio skida samo audio ekstenziju", () => {
    assert.equal(baseFromAudio(`/x/${BASE}.mp3`), BASE);
    assert.equal(baseFromAudio(`/x/${BASE}.wav`), BASE);
});
