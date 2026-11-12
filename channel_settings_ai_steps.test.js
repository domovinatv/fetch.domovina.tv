// node --test channel_settings_ai_steps.test.js — ograda AI koraka po postavkama kanala.
// Bez mreže i bez stvarnog storage/: snimka postavki i epizode su u privremenom direktoriju,
// a podprocesi dobiju CHANNEL_SETTINGS_FILE pa gate ništa ne dohvaća.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const cs = require("./lib/channel_settings");
const steps = require("./lib/channel_settings_steps");

const UC_ART = "UCartartartartartartart1";   // article_summary off
const UC_TR = "UCtrtrtrtrtrtrtrtrtrtrt1";    // transcript_subtitles off
const UC_MAG = "UCmagmagmagmagmagmagmag1";   // magisterium off
const UC_CLIP = "UCclipclipclipclipclipcl";  // share_clips off
const UC_SP = "UCspspspspspspspspspspsp";    // sponsors_in_video off
const UC_FREE = "UCfreefreefreefreefreefr";  // bez retka = sve uključeno

const SNAP = {
    ok: true, fetched_at: "2026-11-12T00:00:00Z",
    settings: {
        [UC_ART]: { status: "active", off: ["article_summary"] },
        [UC_TR]: { status: "active", off: ["transcript_subtitles"] },
        [UC_MAG]: { status: "active", off: ["magisterium"] },
        [UC_CLIP]: { status: "active", off: ["share_clips"] },
        [UC_SP]: { status: "active", off: ["sponsors_in_video"] },
    },
};
const DOWN = { ok: false, fetched_at: "2026-11-12T00:00:00Z", error: "HTTP 502" };
const ALL_STEPS = Object.keys(steps.STEP_KEYS);
const BASE = "20261101_test_epizoda_yt_AAAAAAAAAAA";

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "cs-ai-steps-")); }

/** Kanal s jednom epizodom: `<root>/<slug>/<BASE>.info.json` s danim UC-om. */
function episode(root, slug, uc) {
    const dir = path.join(root, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${BASE}.info.json`), JSON.stringify({ id: "AAAAAAAAAAA", channel_id: uc, duration: 600, title: "Test" }));
    return path.join(dir, `${BASE}.wav.canary.diarized.srt`);
}

/** Koji koraci za epizodu kanala `uc` ispadaju. */
function skippedSteps(snap, uc) {
    const g = cs.gateFromSnapshot(snap);
    const file = episode(tmpdir(), "kanal_test", uc);
    return ALL_STEPS.filter((s) => steps.checkStepFor(s, file, { gate: g }).skip);
}

test("article_summary off → ni sažetak ni članak ni ebook ni EN ni Magisterium", () => {
    const off = skippedSteps(SNAP, UC_ART);
    for (const s of ["summary", "article", "ebook", "english", "reels_en", "magisterium", "magisterium_en", "og_sections", "reels_render"]) {
        assert.ok(off.includes(s), s);
    }
    for (const s of ["words", "segments", "reels", "sponsors"]) assert.ok(!off.includes(s), s);
});

test("transcript_subtitles off → words.json, segments i reelsi ispadaju (i svi AI koraci)", () => {
    const off = skippedSteps(SNAP, UC_TR);
    for (const s of ["words", "segments", "reels", "reels_render", "summary", "article", "english", "magisterium", "ebook"]) {
        assert.ok(off.includes(s), s);
    }
    assert.ok(!off.includes("sponsors"), "sponzori u snimci nisu AI ključ");
});

test("magisterium off → samo Magisterium (HR i EN)", () => {
    assert.deepEqual(skippedSteps(SNAP, UC_MAG).sort(), ["magisterium", "magisterium_en"]);
});

test("share_clips off → og-sections i 9:16 renderi; sponsors_in_video off → samo detektor", () => {
    assert.deepEqual(skippedSteps(SNAP, UC_CLIP).sort(), ["og_sections", "reels_render"]);
    assert.deepEqual(skippedSteps(SNAP, UC_SP), ["sponsors"]);
});

test("nedostupan izvor → svi koraci ispadaju (fail-closed)", () => {
    assert.deepEqual(skippedSteps(DOWN, UC_FREE), ALL_STEPS);
});

test("kanal bez retka → ništa ne ispada", () => {
    assert.deepEqual(skippedSteps(SNAP, UC_FREE), []);
});

test("filterStep: jedna log linija po preskočenoj epizodi, redoslijed sačuvan, prazna lista ne dira gate", () => {
    const root = tmpdir();
    const a = episode(root, "kanal_a", UC_ART);
    const b = episode(root, "kanal_b", UC_FREE);
    const lines = [];
    const g = cs.gateFromSnapshot(SNAP);
    const kept = steps.filterStep("article", [{ p: a }, { p: b }], { gate: g, whoOf: (x) => x.p, log: (l) => lines.push(l) });
    assert.deepEqual(kept, [{ p: b }]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^⏭️ postavke kanala: vlasnik je isključio „article_summary” \(UCart/);
    const boom = { checkStep() { throw new Error("gate se ne smije dirati"); } };
    assert.deepEqual(steps.filterStep("article", [], { gate: boom }), []);
});

test("enqueue_magisterium_backfill: kanal po slugu (registry) → nema Magisterium joba", () => {
    const dir = tmpdir();
    const reg = path.join(dir, "registry.json");
    fs.writeFileSync(reg, JSON.stringify({ channels: [{ slug: "mag_kanal", youtube: { channel_id: UC_MAG } }] }));
    cs._resetForTests();
    const g = cs.gateFromSnapshot(SNAP, { registryPath: reg });
    assert.equal(steps.skipStep("magisterium", { slug: "mag_kanal" }, { gate: g, log: null }), true);
    assert.equal(steps.skipStep("magisterium_en", { slug: "mag_kanal" }, { gate: g, log: null }), true);
    assert.equal(steps.skipStep("magisterium", { slug: "drugi_kanal" }, { gate: g, log: null }), false);
    cs._resetForTests();
});

// ── Podprocesi: stvarne skripte nad privremenim direktorijem (nula API poziva) ──

function snapFile(snap) {
    const f = path.join(tmpdir(), "settings.json");
    fs.writeFileSync(f, JSON.stringify(snap));
    return f;
}
function runNode(argv, snap, input) {
    return spawnSync(process.execPath, argv, {
        cwd: __dirname, input, encoding: "utf8", timeout: 60000,
        env: { ...process.env, CHANNEL_SETTINGS_FILE: snapFile(snap) },
    });
}

const SRT = "1\n00:00:00,000 --> 00:00:02,000\n[SPEAKER_00] dobar dan svima\n\n2\n00:00:02,000 --> 00:00:04,000\n[SPEAKER_01] hvala na pozivu\n";
const SM = {
    results: ["dobar", "dan", "svima", "hvala", "na", "pozivu"].map((w, i) => ({
        type: "word", start_time: i * 0.6, end_time: i * 0.6 + 0.5, alternatives: [{ content: w }],
    })),
};

function wordsEpisode(uc) {
    const root = tmpdir();
    const srt = episode(root, "kanal_w", uc);
    fs.writeFileSync(srt, SRT);
    fs.writeFileSync(path.join(path.dirname(srt), `${BASE}.mp3.speechmatics.json`), JSON.stringify(SM));
    return { root, dir: path.dirname(srt) };
}

test("generate_words_json.js: transkript off → ni words.json ni .words.skipped.json; bez retka → zapisano", () => {
    const off = wordsEpisode(UC_TR);
    const r = runNode(["generate_words_json.js", "--input-dir", off.root], SNAP);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /⏭️ postavke kanala: vlasnik je isključio „transcript_subtitles”/);
    assert.ok(!fs.existsSync(path.join(off.dir, `${BASE}.words.json`)));
    assert.ok(!fs.existsSync(path.join(off.dir, `${BASE}.words.skipped.json`)));

    const on = wordsEpisode(UC_FREE);
    const r2 = runNode(["generate_words_json.js", "--input-dir", on.root], SNAP);
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(fs.existsSync(path.join(on.dir, `${BASE}.words.json`)) || fs.existsSync(path.join(on.dir, `${BASE}.words.skipped.json`)));
});

test("prepare_rag_combined.js --only-segments: transkript off → nema .segments.jsonl", () => {
    const off = wordsEpisode(UC_TR);
    const r = runNode(["prepare_rag_combined.js", "--input-dir", off.root, "--only-segments"], SNAP);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /⏭️ postavke kanala/);
    assert.ok(!fs.existsSync(path.join(off.dir, `${BASE}.segments.jsonl`)));

    const on = wordsEpisode(UC_FREE);
    const r2 = runNode(["prepare_rag_combined.js", "--input-dir", on.root, "--only-segments"], SNAP);
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(fs.existsSync(path.join(on.dir, `${BASE}.segments.jsonl`)));
});

test("detect_sponsors.js: sponsors_in_video off ili nedostupan izvor → nema datoteke; bez retka → zapisana", () => {
    const off = wordsEpisode(UC_SP);
    const r = runNode(["detect_sponsors.js", "--input-dir", off.root], SNAP);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /⏭️ postavke kanala: .*sponsors_in_video.* — kanal_w: 1 epizoda/);
    assert.ok(!fs.existsSync(path.join(off.dir, `${BASE}.sponsors_in_video.json`)));

    const down = wordsEpisode(UC_FREE);
    const r2 = runNode(["detect_sponsors.js", "--input-dir", down.root], DOWN);
    assert.match(r2.stdout, /izvor postavki nedostupan/);
    assert.ok(!fs.existsSync(path.join(down.dir, `${BASE}.sponsors_in_video.json`)));

    const on = wordsEpisode(UC_FREE);
    const r3 = runNode(["detect_sponsors.js", "--input-dir", on.root], SNAP);
    assert.equal(r3.status, 0, r3.stderr);
    assert.ok(fs.existsSync(path.join(on.dir, `${BASE}.sponsors_in_video.json`)));
});

test("batch CLI (generate_og_sections.py): share_clips off → putanja u skipped, slobodan kanal nije", () => {
    const root = tmpdir();
    const a = episode(root, "kanal_c", UC_CLIP).replace(/\.wav\.canary\.diarized\.srt$/, ".wav.canary.diarized_2026-11-01_opus.article.json");
    const b = episode(root, "kanal_f", UC_FREE);
    const r = runNode(["lib/channel_settings_steps.js", "filter", "--step", "og_sections"], SNAP, `${a}\n${b}\n`);
    assert.equal(r.status, 0, r.stderr);
    const { skipped } = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(skipped), [a]);
    assert.match(skipped[a], /share_clips/);
});
