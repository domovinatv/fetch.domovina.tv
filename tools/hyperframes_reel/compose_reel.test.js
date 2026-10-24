"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { scheduleCards, parseNumber, captions, splitName } = require("./compose_reel");

const ctx = { title: "Naslov epizode" };

test("kartice idu jedna po jedna: hook, lower-third, ostale po sidru, kraj zadnji", () => {
    const reel = { hook: "h", cards: [
        { type: "hook", at_sec: 0, text: "Udica" },
        { type: "lower_third", at_sec: 0, text: "Ime · uloga" },
        { type: "context", at_sec: 0, text: "Kontekst" },
        { type: "number", at_sec: 20, text: "km", value: "10 km" },
        { type: "end", at_sec: 50, text: "Kraj" },
    ] };
    const out = scheduleCards(reel, 60, ctx);
    assert.deepEqual(out.map((c) => c.type), ["hook", "lower_third", "context", "number", "end"]);
    for (let i = 1; i < out.length; i++) assert.ok(out[i].start >= out[i - 1].start + out[i - 1].dur, `${out[i].type} se preklapa`);
    assert.equal(out[0].start, 0);
    assert.equal(out.find((c) => c.type === "number").start, 20);
    const end = out[out.length - 1];
    assert.ok(Math.abs(end.start + end.dur - 60) < 0.05);
});

test("bez hook i end kartica: hook iz reel.hook, kraj iz naslova", () => {
    const out = scheduleCards({ hook: "Moja udica", cards: [] }, 40, ctx);
    assert.deepEqual(out.map((c) => [c.type, c.text]), [["hook", "Moja udica"], ["end", "Naslov epizode"]]);
});

test("kartica koja ne stane prije kraja otpada", () => {
    const out = scheduleCards({ cards: [{ type: "quote", at_sec: 37, text: "kasno" }] }, 40, ctx);
    assert.ok(!out.some((c) => c.type === "quote"));
});

test("parseNumber: brojač samo za prave količine", () => {
    assert.deepEqual(parseNumber("10 km"), { n: 10, rest: " km" });
    assert.deepEqual(parseNumber("900.000 kuna"), { n: 900000, rest: " kuna" });
    assert.equal(parseNumber("1918"), null);        // godina
    assert.equal(parseNumber("2/3"), null);
    assert.equal(parseNumber("Krašić"), null);
});

test("splitName dijeli ime i ulogu", () => {
    assert.deepEqual(splitName("Zlatko Krznarić · hodočasnik"), ["Zlatko Krznarić", "hodočasnik"]);
    assert.deepEqual(splitName("Zlatko Krznarić, autor knjige"), ["Zlatko Krznarić", "autor knjige"]);
    assert.deepEqual(splitName("Samo ime"), ["Samo ime", ""]);
});

test("titl: najviše 3 riječi, lom na interpunkciji", () => {
    const w = ["Jedan", "dva", "tri", "četiri.", "Pet"].map((t, i) => ({ text: t, start: i * 0.3, end: i * 0.3 + 0.25 }));
    const c = captions(w, 5);
    assert.equal(c.count, 3);   // „Jedan dva tri" | „četiri." | „Pet"
    assert.match(c.html, /Jedan.*dva.*tri<\/span><\/div>/);
});
