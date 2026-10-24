const test = require("node:test");
const assert = require("node:assert/strict");
const { trimToWords } = require("./magisterium_mcp_prep.js");

const words = (n, w = "riječ") => Array.from({ length: n }, () => w).join(" ");

test("trimToWords: sekcija ispod granice ide cijela", () => {
    const t = words(432) + ". Nitko ih nije ubijao, kažu, ali kontekst slijedi.";
    assert.equal(trimToWords(t, 600), t);
});

test("trimToWords: iznad granice reže na kraju rečenice", () => {
    const t = words(500) + ". " + words(200) + ".";
    const out = trimToWords(t, 600);
    assert.equal(out.split(/\s+/).length, 500);
    assert.ok(out.endsWith("riječ."));
});

test("trimToWords: kraj rečenice s navodnikom se priznaje", () => {
    const t = words(550) + " rekao je „dosta!”" + " " + words(100);
    assert.ok(trimToWords(t, 600).endsWith("„dosta!”"));
});

test("trimToWords: bez kraja rečenice u zadnjoj trećini → tvrdi rez s '...'", () => {
    const t = words(100) + ". " + words(700);
    const out = trimToWords(t, 600);
    assert.ok(out.endsWith("..."));
    assert.equal(out.replace(/\.\.\.$/, "").split(/\s+/).length, 600);
});

test("trimToWords: prazan ulaz", () => {
    assert.equal(trimToWords("", 600), "");
    assert.equal(trimToWords(undefined, 600), "");
});
