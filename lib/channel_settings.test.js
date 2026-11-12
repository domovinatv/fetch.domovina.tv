// node --test lib/channel_settings.test.js — S7 lanca „postavke kanala”, točke 1, 2 i 4.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cs = require("./channel_settings");

const UC_A = "UCaaaaaaaaaaaaaaaaaaaaaa"; // povučen
const UC_B = "UCbbbbbbbbbbbbbbbbbbbbbb"; // processing off
const UC_C = "UCcccccccccccccccccccccc"; // article_summary off
const UC_D = "UCdddddddddddddddddddddd"; // tombstone
const UC_E = "UCeeeeeeeeeeeeeeeeeeeeee"; // transcript off
const UC_F = "UCffffffffffffffffffffff"; // bez retka = sve uključeno

const SNAP = {
    ok: true, fetched_at: "2026-11-12T00:00:00Z",
    settings: {
        [UC_A]: { status: "withdrawn", off: ["channel_enabled"] },
        [UC_B]: { status: "active", off: ["processing"] },
        [UC_C]: { status: "active", off: ["article_summary"] },
        [UC_D]: { status: "deleted", off: cs.KEYS, deleted_at: "2026-11-01T10:00:00Z" },
        [UC_E]: { status: "active", off: ["transcript_subtitles"] },
    },
};

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "cs-test-")); }

test("KEYS: točno 20 ključeva iz odluke 1", () => {
    assert.equal(cs.KEYS.length, 20);
    assert.equal(new Set(cs.KEYS).size, 20);
});

test("closeOff: master gasi sve, transkript gasi AI, članak gasi ovisne (odluka 108)", () => {
    assert.equal(cs.closeOff(["channel_enabled"], "active").size, 20);
    assert.equal(cs.closeOff([], "withdrawn").size, 20);
    assert.equal(cs.closeOff([], "deleted").size, 20);
    const t = cs.closeOff(["transcript_subtitles"], "active");
    for (const k of cs.AI_KEYS) assert.ok(t.has(k), k);
    assert.ok(t.has("ebook"), "transkript → članak → ebook");
    assert.ok(!t.has("processing"));
    const a = cs.closeOff(["article_summary"], "active");
    for (const k of cs.ARTICLE_DEPENDENTS) assert.ok(a.has(k), k);
    assert.ok(!a.has("highlights_reels"));
    assert.ok(!a.has("transcript_subtitles"));
    assert.deepEqual([...cs.closeOff(["nepoznat_kljuc"], "active")], []);
});

test("parseCatalogResponse: oblik iz odluke 312, neispravni UC-ovi ispadaju", () => {
    const m = cs.parseCatalogResponse(JSON.stringify({ version: "1", settings: { [UC_A]: { status: "withdrawn", off: ["channel_enabled"] }, "nije-uc": { status: "deleted" } } }));
    assert.deepEqual(Object.keys(m), [UC_A]);
    assert.throws(() => cs.parseCatalogResponse("{}"));
    assert.throws(() => cs.parseCatalogResponse("<html>"));
});

test("točka 1: isključena obrada ili master → epizoda preskočena", () => {
    const g = cs.gateFromSnapshot(SNAP);
    assert.equal(g.checkProcessing({ uc: UC_B }).skip, true);
    assert.equal(g.checkProcessing({ uc: UC_A }).skip, true);
    assert.match(g.checkProcessing({ uc: UC_A }).reason, /povukao/);
    assert.equal(g.checkProcessing({ uc: UC_C }).skip, false);
    assert.equal(g.checkProcessing({ uc: UC_F }).skip, false, "bez retka = uključeno");
    assert.equal(g.checkProcessing({}).skip, false, "kanal bez UC-a radi kao danas (odluka 102)");
    // checkStep: processing off zaustavlja i korake čiji je ključ uključen
    assert.equal(g.checkStep({ uc: UC_B, key: "ebook" }).skip, true);
});

test("točka 2: isključen AI ključ preskače samo svoj korak (i ovisne)", () => {
    const g = cs.gateFromSnapshot(SNAP);
    assert.equal(g.checkStep({ uc: UC_C, key: "article_summary" }).skip, true);
    assert.equal(g.checkStep({ uc: UC_C, key: "ebook" }).skip, true, "ovisan o članku");
    assert.equal(g.checkStep({ uc: UC_C, key: "highlights_reels" }).skip, false);
    assert.equal(g.checkStep({ uc: UC_C, key: "transcript_subtitles" }).skip, false);
    assert.equal(g.checkStep({ uc: UC_E, key: "highlights_reels" }).skip, true, "reelovi traže transkript");
    assert.equal(g.checkStep({ uc: UC_E, key: "sponsors_in_video" }).skip, false);
    assert.throws(() => g.check({ uc: UC_C, key: "krivi_kljuc" }));
});

test("točka 3 (ugovor): tombstone je trajan i blokira svaki ključ", () => {
    const g = cs.gateFromSnapshot(SNAP);
    assert.equal(g.isTombstoned(UC_D), true);
    assert.equal(g.isTombstoned(UC_A), false);
    assert.equal(g.isWithdrawn(UC_A), true);
    assert.equal(g.isWithdrawn(UC_D), true);
    const r = g.checkProcessing({ uc: UC_D });
    assert.equal(r.skip, true);
    assert.match(r.reason, /tombstone/);
});

test("točka 4: nedostupan izvor = fail-closed za obradu, i za kanal bez retka", () => {
    const g = cs.gateFromSnapshot({ ok: false, error: "HTTP 503" });
    for (const uc of [UC_F, undefined]) {
        const r = g.checkProcessing({ uc });
        assert.equal(r.skip, true);
        assert.equal(r.unavailable, true);
        assert.match(r.reason, /nedostupan.*503/);
    }
    assert.match(g.summary(), /NEDOSTUPNE/);
});

test("točka 4: fetchSnapshot nikad ne baca; HTTP greška, timeout i smeće → ok:false", async () => {
    const http500 = async () => ({ ok: false, status: 500, text: async () => "" });
    let s = await cs.fetchSnapshot({ fetchImpl: http500, retries: 2, sleepMs: 0 });
    assert.equal(s.ok, false);
    assert.match(s.error, /HTTP 500/);
    const garbage = async () => ({ ok: true, status: 200, text: async () => "<html>" });
    s = await cs.fetchSnapshot({ fetchImpl: garbage, retries: 1, sleepMs: 0 });
    assert.equal(s.ok, false);
    const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" }))));
    s = await cs.fetchSnapshot({ fetchImpl: hang, retries: 1, timeoutMs: 20, sleepMs: 0 });
    assert.equal(s.ok, false);
    assert.match(s.error, /timeout/);
    let n = 0;
    const flaky = async () => (++n < 2 ? { ok: false, status: 502 } : { ok: true, status: 200, text: async () => JSON.stringify({ settings: SNAP.settings }) });
    s = await cs.fetchSnapshot({ fetchImpl: flaky, retries: 3, sleepMs: 0 });
    assert.equal(s.ok, true);
    assert.equal(Object.keys(s.settings).length, 5);
});

test("snimka na disku: CHANNEL_SETTINGS_FILE se čita bez obzira na starost; nečitljiva = nedostupno", () => {
    const d = tmpdir();
    const f = path.join(d, "s.json");
    cs.writeSnapshot(f, SNAP);
    fs.utimesSync(f, new Date(0), new Date(0));
    const prev = process.env.CHANNEL_SETTINGS_FILE;
    process.env.CHANNEL_SETTINGS_FILE = f;
    try {
        cs._resetForTests();
        assert.equal(cs.gate().available, true);
        assert.equal(cs.gate().checkProcessing({ uc: UC_B }).skip, true);
        fs.writeFileSync(f, "{pokvareno");
        cs._resetForTests();
        assert.equal(cs.gate().available, false);
        assert.equal(cs.gate().checkProcessing({ uc: UC_F }).skip, true);
    } finally {
        if (prev === undefined) delete process.env.CHANNEL_SETTINGS_FILE; else process.env.CHANNEL_SETTINGS_FILE = prev;
        cs._resetForTests();
    }
});

test("readerGate: nedostupan izvor → zadnja dobra snimka; bez nje bez filtra (stale)", () => {
    const d = tmpdir();
    const bad = path.join(d, "bad.json");
    cs.writeSnapshot(bad, { ok: false, error: "HTTP 503" });
    const last = path.join(d, "last.json");
    cs.writeSnapshot(last, SNAP);
    const prev = process.env.CHANNEL_SETTINGS_FILE;
    process.env.CHANNEL_SETTINGS_FILE = bad;
    try {
        cs._resetForTests();
        let g = cs.readerGate({ lastOkFile: last });
        assert.equal(g.available, true);
        assert.match(g.stale, /zadnja uspješna/);
        assert.equal(g.check({ uc: UC_A, key: "home_featured" }).skip, true);
        cs._resetForTests();
        g = cs.readerGate({ lastOkFile: path.join(d, "nema.json") });
        assert.equal(g.check({ uc: UC_A, key: "home_featured" }).skip, false);
        assert.match(g.stale, /bez filtra/);
    } finally {
        if (prev === undefined) delete process.env.CHANNEL_SETTINGS_FILE; else process.env.CHANNEL_SETTINGS_FILE = prev;
        cs._resetForTests();
    }
});

test("UC iz info.json i iz registryja (slug); epizoda iz putanje, i iz _screenshots/_raw", () => {
    const d = tmpdir();
    const ch = path.join(d, "neki_kanal");
    fs.mkdirSync(ch);
    const base = "20261101_naslov_s_yt_u_imenu_yt_ABCDEFGHIJK";
    fs.writeFileSync(path.join(ch, `${base}.info.json`), JSON.stringify({ channel_id: UC_B }));
    const reg = path.join(d, "reg.json");
    fs.writeFileSync(reg, JSON.stringify({ channels: [{ slug: "neki_kanal", youtube: { channel_id: UC_C } }] }));
    cs._resetForTests();
    const g = cs.gateFromSnapshot(SNAP, { registryPath: reg });
    for (const fp of [
        path.join(ch, `${base}.wav.canary.diarized.srt`),
        path.join(ch, `${base}_screenshots`, `${base}_00-01-02.png`),
        path.join(ch, `${base}_20261102_opus_raw`, "faza1_outline.raw.txt"),
    ]) {
        assert.deepEqual(g.ucsFor({ filePath: fp }).sort(), [UC_B, UC_C].sort(), fp);
    }
    // epizoda tuđeg kanala na listi: blokira i vlasnik sadržaja (info.json) i kanal liste (slug)
    assert.equal(g.checkStep({ filePath: path.join(ch, `${base}.wav`), key: "ebook" }).skip, true);
    cs._resetForTests();
});
