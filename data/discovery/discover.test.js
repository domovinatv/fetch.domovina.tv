const test = require("node:test");
const assert = require("node:assert/strict");
const { autoVerdict, metricsFor, slugify, ledgerBlocks, parseJsonArray } = require("./discover.js");

const vids = (spec) => spec.flatMap(([n, dur], k) => Array.from({ length: n }, (_, i) => ({ id: `v${k}_${i}`.padEnd(11, "x"), title: `Ep ${i}`, duration: dur, upload_date: "20260901" })));

test("podcast kanal s isječcima je candidate", () => {
    const m = metricsFor(vids([[10, 5400], [40, 500]]));
    assert.equal(m.originals_30min, 10);
    assert.equal(autoVerdict(m), "candidate");
    assert.ok(m.derivative_ratio > 0.7);
});

test("kanal samo s kratkim videima nije podcast", () => {
    assert.equal(autoVerdict(metricsFor(vids([[50, 400]]))), "not_podcast");
});

test("mlad kanal s par epizoda ide LLM-u", () => {
    assert.equal(autoVerdict(metricsFor(vids([[3, 3600]]))), "maybe");
});

test("slugify skida dijakritike", () => {
    assert.equal(slugify("Đir po Hrvatskoj — Podcast!"), "dir-po-hrvatskoj-podcast");
});

test("ledger: trajna vs vremenska presuda", () => {
    assert.equal(ledgerBlocks({ verdict: "not_hr", judged_at: "2020-01-01" }), true);
    assert.equal(ledgerBlocks({ verdict: "not_podcast", judged_at: "2020-01-01" }), false);
    assert.equal(ledgerBlocks({ verdict: "not_podcast", judged_at: new Date().toISOString() }), true);
    assert.equal(ledgerBlocks(undefined), false);
});

test("parseJsonArray podnosi tekst oko JSON-a", () => {
    assert.deepEqual(parseJsonArray('Evo:\n```json\n[{"key":"a"}]\n```'), [{ key: "a" }]);
});

test("verdictFromReason", () => {
    const { verdictFromReason } = require("./discover.js");
    assert.equal(verdictFromReason("srpski"), "not_hr");
    assert.equal(verdictFromReason("strani jezik (EN/ostali) — van HR scopea"), "not_hr");
    assert.equal(verdictFromReason("TV/radio/medijska kuća, ne podcast"), "institutional");
    assert.equal(verdictFromReason("ne prolazi triage: 2/60 ≥30 min"), "not_podcast");
    assert.equal(verdictFromReason("nešto treće"), "uncertain");
});

// ─── postavke kanala: tombstone (S7 točka 3) ──────────────────────
const cs = require("../../lib/channel_settings");
const { filterTombstoned, tombstonedUc, gateHasNoSnapshot } = require("./discover.js");

test("(c) tombstone UC ne ide u apply (ni kanal ni njegova playlista)", () => {
    const UC_DEL = "UCdddddddddddddddddddddd", UC_OK = "UCffffffffffffffffffffff";
    const g = cs.gateFromSnapshot({ ok: true, fetched_at: "x", settings: { [UC_DEL]: { status: "deleted", off: [] } } },
        { registryPath: "/nepostojeci/registry.json" });
    const triage = [
        { key: UC_DEL, type: "channel", channel_id: UC_DEL, name: "Obrisan", auto: "candidate" },
        { key: "PLxxxxxxxx", type: "playlist", channel_id: UC_DEL, name: "Obrisan — playlista", auto: "candidate" },
        { key: UC_OK, type: "channel", channel_id: UC_OK, name: "Normalan", auto: "candidate" },
    ];
    const { kept, dropped } = filterTombstoned(triage, g);
    assert.deepEqual(kept.map((r) => r.key), [UC_OK]);
    assert.deepEqual(dropped.map((d) => d.uc), [UC_DEL, UC_DEL]);
    assert.equal(tombstonedUc(triage[2], g), null);
    // povučen (withdrawn), ali ne obrisan, NIJE trajna presuda discoveryja
    const g2 = cs.gateFromSnapshot({ ok: true, settings: { [UC_OK]: { status: "withdrawn", off: [] } } });
    assert.equal(filterTombstoned(triage, g2).kept.length, 3);
});

test("apply bez ijedne snimke postavki se odbija (readerGate bez filtra)", () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "disc-"));
    process.env.CHANNEL_SETTINGS_FILE = path.join(d, "nema.json");
    try {
        cs._resetForTests();
        const g = cs.readerGate({ lastOkFile: path.join(d, "nema_last.json") });
        assert.ok(gateHasNoSnapshot(g));
        assert.equal(gateHasNoSnapshot(cs.gateFromSnapshot({ ok: true, fetched_at: "x", settings: {} })), false);
    } finally { delete process.env.CHANNEL_SETTINGS_FILE; cs._resetForTests(); }
});
