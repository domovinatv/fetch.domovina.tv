"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

// Izoliran cache potrošenih ključeva (HOME → tmp) prije učitavanja modula.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "smkeys-"));
process.env.HOME = HOME;
const sm = require("./speechmatics");

test("apiKeys: lista, pa glavni, pa numerirani, bez duplikata", () => {
    const keys = sm.apiKeys({
        SPEECHMATICS_API_KEYS: "a, b",
        SPEECHMATICS_API_KEY: "b",
        SPEECHMATICS_API_KEY_10: "z",
        SPEECHMATICS_API_KEY_2: "c",
    });
    assert.deepEqual(keys, ["a", "b", "c", "z"]);
});

test("isAccountError: 401/402/403 i poruke o kreditu, ne 400", () => {
    assert.equal(sm.isAccountError(Object.assign(new Error("x"), { status: 403 })), true);
    assert.equal(sm.isAccountError(new Error("HTTP 400 — insufficient credit")), true);
    assert.equal(sm.isAccountError(Object.assign(new Error("bad config"), { status: 400 })), false);
});

function fakeClient(behaviour, calls) {
    return (key) => ({
        async transcribeFile() {
            calls.push(key);
            const b = behaviour[key];
            if (b === "ok") return { raw: "{}", json: {}, job: {}, config: {}, jobId: "j-" + key };
            throw Object.assign(new Error(b.msg), b.err);
        },
    });
}

test("multiClient: potrošen ključ → idući; idući job preskače potrošeni", async () => {
    const calls = [];
    const client = fakeClient({
        k1: { msg: "HTTP 403 — Forbidden", err: { status: 403, submit: true } },
        k2: "ok",
    }, calls);
    const mc = sm.multiClient(["k1", "k2"], { log: () => {} });
    const r = await mc.transcribeFile("x.mp3", { client });
    assert.equal(r.jobId, "j-k2");
    assert.equal(r.keyIndex, 2);
    await mc.transcribeFile("y.mp3", { client });
    assert.deepEqual(calls, ["k1", "k2", "k2"]);
});

test("multiClient: greška nakon prihvaćenog posla se ne ponavlja na drugom računu", async () => {
    const calls = [];
    const client = fakeClient({
        k3: { msg: "Speechmatics timeout", err: {} },
        k4: "ok",
    }, calls);
    await assert.rejects(sm.multiClient(["k3", "k4"], { log: () => {} }).transcribeFile("x.mp3", { client }), /timeout/);
    assert.deepEqual(calls, ["k3"]);
});

test("multiClient: svi potrošeni → jasna greška", async () => {
    const calls = [];
    const client = fakeClient({
        k5: { msg: "HTTP 402", err: { status: 402, submit: true } },
        k6: { msg: "HTTP 401", err: { status: 401, submit: true } },
    }, calls);
    await assert.rejects(sm.multiClient(["k5", "k6"], { log: () => {} }).transcribeFile("x.mp3", { client }), /svi ključevi \(2\)/);
});
