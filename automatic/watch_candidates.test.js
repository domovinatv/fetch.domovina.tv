const test = require("node:test");
const assert = require("node:assert/strict");
const { classify, adaptiveMinDuration, channelVideosUrl } = require("./watch_candidates.js");

const v = (duration, title = "Epizoda", live_status = null) => ({ id: "x".repeat(11), duration, title, live_status });

test("shorts i live/upcoming", () => {
    assert.equal(classify(v(58), {}, 901).cls, "short");
    assert.equal(classify(v(600, "Nešto #shorts"), {}, 901).cls, "short");
    assert.equal(classify(v(null, "Premijera", "is_upcoming"), {}, 901).cls, "pending");
    assert.equal(classify(v(null), {}, 901).cls, "pending");
});

test("prag trajanja odvaja isječke", () => {
    assert.equal(classify(v(540), {}, 901).cls, "derivative");
    assert.equal(classify(v(3600), {}, 901).cls, "original");
});

test("naslov isječka vrijedi samo za kraće od 2× praga", () => {
    assert.equal(classify(v(1200, "Najava nove sezone"), {}, 901).cls, "derivative");
    assert.equal(classify(v(5400, "Najava izbora — razgovor s gostom"), {}, 901).cls, "original");
});

test("pravila iz rules.json (Python (?i) stil)", () => {
    const rule = { exclude_title_regex: "(?i)Q&A", include_title_regex: "(?i)#\\d+" };
    assert.equal(classify(v(3600, "Podcast #12 Q&A"), rule, 901).cls, "derivative");
    assert.equal(classify(v(3600, "Gost bez broja"), rule, 901).cls, "derivative");
    assert.equal(classify(v(3600, "Podcast #12 - Gost"), rule, 901).cls, "original");
});

test("adaptivni prag: Inkubator-oblik (epizode 90 min, Q&A 25 min)", () => {
    const seen = {};
    for (let i = 0; i < 10; i++) seen["e" + i] = { duration: 5400 + i * 60 };
    for (let i = 0; i < 10; i++) seen["q" + i] = { duration: 1500 };
    for (let i = 0; i < 30; i++) seen["c" + i] = { duration: 500 };
    const min = adaptiveMinDuration(seen);
    assert.ok(min > 1500 && min < 5400, `prag ${min}`);
    assert.equal(adaptiveMinDuration({ a: { duration: 3000 } }), 901); // premalo uzoraka → pod
});

test("channelVideosUrl", () => {
    assert.equal(channelVideosUrl("https://www.youtube.com/@x"), "https://www.youtube.com/@x/videos");
    assert.equal(channelVideosUrl("https://www.youtube.com/@x/featured"), "https://www.youtube.com/@x/videos");
    assert.equal(channelVideosUrl("https://www.youtube.com/@x/streams"), "https://www.youtube.com/@x/streams");
    assert.equal(channelVideosUrl("https://www.youtube.com/playlist?list=PL1"), "https://www.youtube.com/playlist?list=PL1");
});
