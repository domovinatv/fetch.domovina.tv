const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSummaryMarkdown } = require("./summarize_gemini.js");

// Samo retci s linkovima — ostatak Markdowna nije predmet ovih testova.
function linkLines(source) {
    const md = buildSummaryMarkdown({
        model: "gemini-3.8-flash",
        source: { channel: "kanal", title: "Naslov", youtube_id: "abcdefghijk", ...source },
        summary: {},
    });
    return md.split("\n").filter((l) => /\*\*(Epizoda|Izvornik):\*\*/.test(l)).map((l) => l.trim());
}

test("stari summary.json bez platform polja → domovina.ai + YouTube kao dosad", () => {
    assert.deepEqual(linkLines({}), [
        "**Epizoda:** https://domovina.ai/v/abcdefghijk",
        "**Izvornik:** youtube.com/watch?v=abcdefghijk",
    ]);
});

test("X: izvornik je x.com URL, ne YouTube sa sintetičkim ID-em", () => {
    assert.deepEqual(linkLines({ platform: "x", source_url: "https://x.com/a/status/1" }), [
        "**Epizoda:** https://domovina.ai/v/abcdefghijk",
        "**Izvornik:** x.com/a/status/1",
    ]);
});

test("beamly bez YouTube para: nema lažnog YouTube linka", () => {
    assert.deepEqual(linkLines({ yt_matched: false }), ["**Epizoda:** https://domovina.ai/v/abcdefghijk"]);
});

test("lokalna snimka (_local_file): nema nijednog linka", () => {
    assert.deepEqual(linkLines({ platform: "local-audio", local_file: true }), []);
});
