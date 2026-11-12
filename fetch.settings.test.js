// node --test fetch.settings.test.js — postavke kanala (S7) na ulazu obrade i u ASR koracima.
// Bez mreže i bez stvarnog storage/: gate iz snimke (gateFromSnapshot), registry i liste u tmp.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cs = require("./lib/channel_settings");
const { downloadDecision, filterListEntriesBySettings, filterAsrCandidates } = require("./lib/channel_settings_filter");
const { ChannelQueue } = require("./fetch");

const UC_A = "UCaaaaaaaaaaaaaaaaaaaaaa"; // povučen
const UC_B = "UCbbbbbbbbbbbbbbbbbbbbbb"; // processing off
const UC_E = "UCeeeeeeeeeeeeeeeeeeeeee"; // transcript_subtitles off
const UC_G = "UCgggggggggggggggggggggg"; // cdn_playback + transcript_subtitles off (odluka 108)
const UC_H = "UChhhhhhhhhhhhhhhhhhhhhh"; // samo cdn_playback off
const UC_F = "UCffffffffffffffffffffff"; // bez retka = sve uključeno

const SNAP = {
    ok: true, fetched_at: "2026-11-12T00:00:00Z",
    settings: {
        [UC_A]: { status: "withdrawn", off: ["channel_enabled"] },
        [UC_B]: { status: "active", off: ["processing"] },
        [UC_E]: { status: "active", off: ["transcript_subtitles"] },
        [UC_G]: { status: "active", off: ["cdn_playback", "transcript_subtitles"] },
        [UC_H]: { status: "active", off: ["cdn_playback"] },
    },
};
const UNAVAILABLE = { ok: false, error: "HTTP 503" };

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "fetch-settings-test-")); }

/** tmp registry: slug → UC */
function makeRegistry(dir) {
    const reg = path.join(dir, "registry.json");
    fs.writeFileSync(reg, JSON.stringify({ podcasts: [
        { slug: "kanal_a", youtube: { channel_id: UC_A } },
        { slug: "kanal_b", youtube: { channel_id: UC_B } },
        { slug: "kanal_e", youtube: { channel_id: UC_E } },
        { slug: "kanal_g", youtube: { channel_id: UC_G } },
        { slug: "kanal_h", youtube: { channel_id: UC_H } },
        { slug: "kanal_f", youtube: { channel_id: UC_F } },
    ] }));
    return reg;
}

function gateFor(snap, dir) {
    cs._resetForTests();
    return cs.gateFromSnapshot(snap, { registryPath: makeRegistry(dir) });
}

const ENTRIES = [{ videoId: "AAAAAAAAAAA" }, { videoId: "BBBBBBBBBBB" }];
const quiet = { log: null };

test("lista: isključena obrada → sve epizode kanala preskočene", () => {
    const g = gateFor(SNAP, tmpdir());
    const r = filterListEntriesBySettings(ENTRIES, "kanal_b", g, quiet);
    assert.equal(r.keep.length, 0);
    assert.equal(r.skipped.length, 2);
    assert.match(r.skipped[0].reason, /processing/);
});

test("lista: povučen kanal → preskočen", () => {
    const g = gateFor(SNAP, tmpdir());
    const r = filterListEntriesBySettings(ENTRIES, "kanal_a", g, quiet);
    assert.equal(r.keep.length, 0);
    assert.match(r.skipped[0].reason, /povukao/);
});

test("lista: nedostupan izvor → preskočeno sve, i kanal bez retka (fail-closed)", () => {
    const g = gateFor(UNAVAILABLE, tmpdir());
    for (const slug of ["kanal_f", "nepoznat_kanal"]) {
        const r = filterListEntriesBySettings(ENTRIES, slug, g, quiet);
        assert.equal(r.keep.length, 0, slug);
        assert.match(r.skipped[0].reason, /nedostupan/);
    }
});

test("lista: kanal bez retka (i kanal bez UC-a u registryju) → obrađuje se", () => {
    const g = gateFor(SNAP, tmpdir());
    assert.equal(filterListEntriesBySettings(ENTRIES, "kanal_f", g, quiet).keep.length, 2);
    assert.equal(filterListEntriesBySettings(ENTRIES, "nepoznat_kanal", g, quiet).keep.length, 2);
});

test("odluka 108: cdn_playback I transcript_subtitles off → ne skida; samo jedno off → skida", () => {
    const g = gateFor(SNAP, tmpdir());
    const both = downloadDecision(g, { slug: "kanal_g" });
    assert.equal(both.skip, true);
    assert.match(both.reason, /odluka 108/);
    assert.equal(downloadDecision(g, { slug: "kanal_h" }).skip, false, "samo cdn off: treba zvuk za transkript");
    assert.equal(downloadDecision(g, { slug: "kanal_e" }).skip, false, "samo transkript off: medij se objavljuje");
    // vlasnik sadržaja (UC) na listi drugog kanala
    assert.equal(downloadDecision(g, { slug: "kanal_f", uc: UC_B }).skip, true);
});

test("fetch.js ChannelQueue: preskočena epizoda nije u pending ni upisana u state", () => {
    const d = tmpdir();
    const g = gateFor(SNAP, d);
    const lists = path.join(d, "podcasts");
    fs.mkdirSync(lists);
    const listFile = path.join(lists, "kanal_b-lista.txt");
    fs.writeFileSync(listFile, "20261101|Prva|https://youtu.be/AAAAAAAAAAA\n20261102|Druga|https://youtu.be/BBBBBBBBBBB\n");
    const stateFile = path.join(lists, "kanal_b-lista-state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ completed: [], failed: [], private: [], archived: [] }));
    const before = fs.readFileSync(stateFile, "utf8");

    const q = new ChannelQueue(listFile, path.join(d, "out"), null, { gate: g });
    assert.equal(q.channelName, "kanal_b");
    assert.equal(q.pendingVideos.length, 0);
    assert.equal(q.isExhausted, true);
    assert.equal(fs.readFileSync(stateFile, "utf8"), before, "state se ne dira");

    // isti popis za kanal bez retka → obje epizode čekaju skidanje
    const listF = path.join(lists, "kanal_f-lista.txt");
    fs.copyFileSync(listFile, listF);
    const qf = new ChannelQueue(listF, path.join(d, "out"), null, { gate: g });
    assert.deepEqual(qf.pendingVideos.map((e) => e.videoId), ["AAAAAAAAAAA", "BBBBBBBBBBB"]);
    assert.equal(fs.existsSync(listF.replace(".txt", "-state.json")), false);
    cs._resetForTests();
});

test("fetch.js ChannelQueue: nedostupan izvor → ništa na čekanju, ništa u stanju", () => {
    const d = tmpdir();
    const g = gateFor(UNAVAILABLE, d);
    const listFile = path.join(d, "kanal_f-lista.txt");
    fs.writeFileSync(listFile, "20261101|Prva|https://youtu.be/AAAAAAAAAAA\n");
    const q = new ChannelQueue(listFile, path.join(d, "out"), null, { gate: g });
    assert.equal(q.pendingVideos.length, 0);
    assert.equal(fs.existsSync(path.join(d, "kanal_f-lista-state.json")), false);
    cs._resetForTests();
});

test("fetch.js ad-hoc (--unlisted-url): vlasnik iz probe s isključenom obradom → bez skidanja i bez stanja", async () => {
    const d = tmpdir();
    const g = gateFor(SNAP, d);
    const stateFile = path.join(d, "_unlisted-state.json");
    let probed = 0;
    const q = new ChannelQueue(null, path.join(d, "out"), null, {
        gate: g, stateFile,
        probe: async () => { probed++; return UC_B; },
        unlistedUrl: "https://www.youtube.com/watch?v=CCCCCCCCCCC", unlistedTitle: "Test",
    });
    assert.equal(q.pendingVideos.length, 1);
    const n = await q.processBatch(2);
    assert.equal(probed, 1);
    assert.equal(n, 0);
    assert.equal(q.isExhausted, true);
    assert.equal(fs.existsSync(stateFile), false, "ni completed, ni failed, ni private");
    assert.equal(fs.existsSync(path.join(d, "out", "_unlisted")), false, "ništa skinuto");
    cs._resetForTests();
});

test("fetch.js ad-hoc: nedostupan izvor → preskočeno odmah, bez probe", () => {
    const d = tmpdir();
    const g = gateFor(UNAVAILABLE, d);
    const q = new ChannelQueue(null, path.join(d, "out"), null, {
        gate: g, stateFile: path.join(d, "_unlisted-state.json"),
        probe: async () => { throw new Error("ne smije se zvati"); },
        unlistedUrl: "https://youtu.be/CCCCCCCCCCC",
    });
    assert.equal(q.pendingVideos.length, 0);
    assert.equal(q.isExhausted, true);
    cs._resetForTests();
});

test("ASR: kandidat s transcript_subtitles off ispada (UC iz info.json); ostali ostaju", () => {
    const d = tmpdir();
    const g = gateFor(SNAP, d);
    const ch = path.join(d, "output", "neki_kanal");
    fs.mkdirSync(ch, { recursive: true });
    const mk = (id, uc) => {
        const base = `20261101_epizoda_yt_${id}`;
        fs.writeFileSync(path.join(ch, `${base}.info.json`), JSON.stringify({ channel_id: uc }));
        return path.join(ch, `${base}.mp3`);
    };
    const pE = mk("EEEEEEEEEEE", UC_E);
    const pB = mk("BBBBBBBBBBB", UC_B);
    const pF = mk("FFFFFFFFFFF", UC_F);
    const kept = filterAsrCandidates([pE, pB, pF], g, quiet);
    assert.deepEqual(kept, [pF]);

    // objekti kandidata (refine 2.8 / scan_modal_candidates) preko getPath
    const objs = [{ audioPath: pE }, { audioPath: pF }];
    assert.deepEqual(filterAsrCandidates(objs, g, { ...quiet, getPath: (c) => c.audioPath }), [objs[1]]);

    // kanal liste (registry slug) s isključenim transkriptom
    const chE = path.join(d, "output", "kanal_e");
    fs.mkdirSync(chE);
    assert.deepEqual(filterAsrCandidates([path.join(chE, "x_yt_XXXXXXXXXXX.wav")], g, quiet), []);

    // nedostupan izvor: nijedan ASR kandidat
    const gu = gateFor(UNAVAILABLE, d);
    assert.deepEqual(filterAsrCandidates([pF], gu, quiet), []);
    cs._resetForTests();
});
