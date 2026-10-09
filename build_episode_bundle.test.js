const test = require("node:test");
const assert = require("node:assert/strict");
const { groupListing, listedFiles, fingerprint, buildBody, withTimestamp, sameContent } = require("./build_episode_bundle.js");

const listing = [
    { key: "data/abc/article.json", etag: '"a1"', size: 10 },
    { key: "data/abc/info.json", etag: '"i1"', size: 5 },
    { key: "data/abc/video_h264.mp4", etag: '"v1-3"', size: 999 },
    { key: "data/abc/book.epub", etag: '"b1"', size: 50 },
    { key: "data/abc/episode.json", etag: '"e1"', size: 7 },
    { key: "data/xyz/summary.json", etag: '"s1"', size: 3 },
    { key: "channels/data/index.json", etag: '"x"', size: 1 },
];

test("groupListing grupira po ID-u i ignorira ključeve izvan data/", () => {
    const g = groupListing(listing);
    assert.deepEqual([...g.keys()].sort(), ["abc", "xyz"]);
    assert.equal(g.get("abc").get("article.json").etag, "a1");
});

test("files je sortiran i ne sadrži sam bundle", () => {
    const g = groupListing(listing);
    assert.deepEqual(listedFiles(g.get("abc")), ["article.json", "book.epub", "info.json", "video_h264.mp4"]);
});

test("otisak: prepis e-knjige ga ne mijenja, novi članak i nova datoteka da", () => {
    const base = groupListing(listing).get("abc");
    const fp = fingerprint(base);

    const epub = new Map(base); epub.set("book.epub", { etag: "b2", size: 51 });
    assert.equal(fingerprint(epub), fp);

    const art = new Map(base); art.set("article.json", { etag: "a2", size: 11 });
    assert.notEqual(fingerprint(art), fp);

    const words = new Map(base); words.set("words.json", { etag: "w1", size: 1 });
    assert.notEqual(fingerprint(words), fp);

    const bundle = new Map(base); bundle.set("episode.json", { etag: "e2", size: 8 });
    assert.equal(fingerprint(bundle), fp);
});

test("inline nosi samo pet datoteka za prvi prikaz, u stalnom redoslijedu", () => {
    const body = buildBody(["a"], {
        "article.json": { t: 1 },
        "info.json": { id: "abc" },
        "words.json": { w: [] },
        "article.en.json": { t: 2 },
    });
    assert.deepEqual(Object.keys(body.inline), ["info.json", "article.json"]);
});

test("sameContent ignorira generated_at", () => {
    const body = buildBody(["info.json"], { "info.json": { id: "abc" } });
    const a = withTimestamp(body, "2026-10-09T10:00:00Z");
    assert.ok(sameContent(a, body));
    assert.ok(!sameContent(a, buildBody(["info.json", "words.json"], { "info.json": { id: "abc" } })));
    assert.ok(!sameContent(null, body));
    assert.deepEqual(Object.keys(a), ["version", "generated_at", "files", "inline"]);
});
