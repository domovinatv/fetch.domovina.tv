// node --test automatic/enqueue_all_new.test.js — postavke kanala u Tier 2 (S7 točka 3).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cs = require("../lib/channel_settings");
const { applySettingsGate } = require("./enqueue_all_new");

const UC_DEL = "UCdddddddddddddddddddddd";
const UC_PROC = "UCbbbbbbbbbbbbbbbbbbbbbb";
const UC_OK = "UCffffffffffffffffffffff";

function registry() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "t2-reg-"));
    const p = path.join(d, "reg.json");
    fs.writeFileSync(p, JSON.stringify({ podcasts: [
        { slug: "obrisan", youtube: { channel_id: UC_DEL } },
        { slug: "bez-obrade", youtube: { channel_id: UC_PROC } },
        { slug: "normalan", youtube: { channel_id: UC_OK } },
    ] }));
    return p;
}
const SNAP = { ok: true, settings: {
    [UC_DEL]: { status: "deleted", off: [] },
    [UC_PROC]: { status: "active", off: ["processing"] },
} };
const ev = (id, slug, extra = {}) => ({ id, slug, cls: "original", date: "2026-11-12", ...extra });

test("(a) tombstone UC u Tier 2 → nijedan job", () => {
    const g = cs.gateFromSnapshot(SNAP, { registryPath: registry() });
    const r = applySettingsGate([ev("aaaaaaaaaaa", "obrisan"), ev("bbbbbbbbbbb", "nepoznat", { channel_id: UC_DEL })], g);
    assert.deepEqual(r.keep, []);
    assert.equal(r.skipped.length, 2);
    assert.match(r.skipped[0].reason, /tombstone/);
    assert.equal(r.unavailable, null);
});

test("(d) processing off u Tier 2 → preskočen, ostali prolaze", () => {
    const g = cs.gateFromSnapshot(SNAP, { registryPath: registry() });
    const r = applySettingsGate([ev("ccccccccccc", "bez-obrade"), ev("ddddddddddd", "normalan"), ev("eeeeeeeeeee", "bez-uc-a")], g);
    assert.deepEqual(r.keep.map((e) => e.id), ["ddddddddddd", "eeeeeeeeeee"]);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /processing/);
});

test("(e) nedostupan izvor u Tier 2 → 0 jobova, razlog za log/stanje", () => {
    const g = cs.gateFromSnapshot({ ok: false, error: "HTTP 503" }, { registryPath: registry() });
    const r = applySettingsGate([ev("ddddddddddd", "normalan"), ev("eeeeeeeeeee", "bez-uc-a")], g);
    assert.deepEqual(r.keep, []);
    assert.match(r.unavailable, /nedostupan.*HTTP 503/);
});
