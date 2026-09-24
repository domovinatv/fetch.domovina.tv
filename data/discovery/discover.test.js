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
