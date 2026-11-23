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

// ─── postavke kanala (S7 točka 3) ─────────────────────────────────
const cs = require("../lib/channel_settings");
const { loadCandidates, tombstonedUc } = require("./watch_candidates.js");

test("(b) tombstone UC nije kandidat za praćenje (ni po UC-u ni po slugu)", () => {
    const UC_DEL = "UCdddddddddddddddddddddd", UC_OK = "UCffffffffffffffffffffff";
    const reg = { podcasts: [
        { slug: "obrisan", youtube: { url: "https://www.youtube.com/@obrisan", channel_id: UC_DEL }, tracking: { enabled: false }, metadata: { status: "active" } },
        { slug: "normalan", youtube: { url: "https://www.youtube.com/@normalan", channel_id: UC_OK }, tracking: { enabled: false }, metadata: { status: "active" } },
    ] };
    const g = cs.gateFromSnapshot({ ok: true, settings: { [UC_DEL]: { status: "deleted", off: [] } } },
        { registryPath: "/nepostojeci/registry.json" });
    const slugs = loadCandidates({ scoped: false, registry: reg, gate: g }).map((c) => c.slug);
    assert.deepEqual(slugs, ["normalan"]);
    assert.equal(tombstonedUc(reg.podcasts[0], g), UC_DEL);
    // bez retka u postavkama (i bez gatea) — nepromijenjeno
    assert.deepEqual(loadCandidates({ scoped: false, registry: reg, gate: null }).map((c) => c.slug), ["obrisan", "normalan"]);
});

// ─── /streams (23.11.2026.) ─────────────────────────────────────────
// Prijenose uživo YouTube drži samo na kartici /streams. h8qR80bc5VY (hrt-nedjeljom-u-2,
// 16. 11.) i tW71sjw4Lr4 (digitalna-kultura, 19. 11., 6 h) zato nikad nisu ušli u red.
const { channelStreamsUrl, processChannel } = require("./watch_candidates.js");

const REG = { podcasts: [
    { slug: "hrt-nedjeljom-u-2", display_name: "Nedjeljom u 2", tracking: { enabled: false },
      youtube: { url: "https://www.youtube.com/@nedjeljomu2HRT/videos", type: "channel" },
      watch: { min_duration_sec: 1800 } },
    { slug: "digitalna-kultura", display_name: "Digitalna kultura", tracking: { enabled: false },
      youtube: { url: "https://www.youtube.com/channel/UC5G48syi8BJd0UqRkS08hVg/videos", type: "channel" } },
    { slug: "neka-playlista", tracking: { enabled: false },
      youtube: { url: "https://www.youtube.com/playlist?list=PLabc", type: "playlist" } },
] };

test("channelStreamsUrl: samo za /videos kanala", () => {
    assert.equal(channelStreamsUrl("https://www.youtube.com/@x/videos"), "https://www.youtube.com/@x/streams");
    assert.equal(channelStreamsUrl("https://www.youtube.com/playlist?list=PLabc"), null);
    assert.equal(channelStreamsUrl("https://www.youtube.com/@x/streams"), null);
});

test("loadCandidates dodaje /streams kao automatski izvor (i za oba propuštena kanala)", () => {
    const list = loadCandidates({ scoped: false, registry: REG, gate: null });
    const hrt = list.find((c) => c.slug === "hrt-nedjeljom-u-2");
    const dk = list.find((c) => c.slug === "digitalna-kultura");
    assert.deepEqual(hrt.autoSources, ["https://www.youtube.com/@nedjeljomu2HRT/streams"]);
    assert.ok(dk.sources.includes("https://www.youtube.com/channel/UC5G48syi8BJd0UqRkS08hVg/streams"));
    assert.deepEqual(list.find((c) => c.slug === "neka-playlista").autoSources, []);
});

function fakeLister(tabs) {
    return async (url) => {
        const k = url.endsWith("/streams") ? "streams" : "videos";
        if (tabs[k] instanceof Error) return { entries: [], error: tabs[k].message };
        return { entries: tabs[k] || [], error: null };
    };
}
const ep = (id, duration, title = "Nedjeljom u 2: gost") => ({ id, duration, title, upload_date: null, live_status: "was_live" });

test("prijenos s /streams postaje nova epizoda; prvo čitanje kartice je baseline", async () => {
    const [c] = loadCandidates({ scoped: false, registry: REG, gate: null });
    // Stanje prije 23.11.: kanal ima baseline samo iz /videos (ključ izvora = /videos).
    const state = { channels: { [c.slug]: { seen: { OLDvid00001: { duration: 3500, title: "stara", cls: "original" } },
        baseline_at: "2026-10-14T00:00:00Z", source: c.source } } };
    // 1. prolaz: kartica /streams prvi put → stari prijenosi su baseline, bez događaja.
    let r = await processChannel(c, state, fakeLister({ videos: [], streams: [ep("PErFoyR4RKg", 3650)] }));
    assert.equal(r.error, null);
    assert.equal(r.fresh.length, 0);
    assert.equal(state.channels[c.slug].seen.OLDvid00001.title, "stara", "baseline /videos ostaje");
    assert.ok(state.channels[c.slug].streams_baseline_at);
    // 2. prolaz: novi prijenos (h8qR80bc5VY) → događaj, original.
    r = await processChannel(c, state, fakeLister({ videos: [], streams: [ep("h8qR80bc5VY", 3550), ep("PErFoyR4RKg", 3650)] }));
    assert.deepEqual(r.fresh.map((e) => [e.id, e.cls]), [["h8qR80bc5VY", "original"]]);
    assert.equal(state.channels[c.slug].seen.h8qR80bc5VY.tab, "streams");
});

test("6-satni prijenos digitalna-kultura (tW71sjw4Lr4) je original", async () => {
    const c = loadCandidates({ scoped: false, registry: REG, gate: null }).find((x) => x.slug === "digitalna-kultura");
    const state = { channels: { [c.slug]: { seen: {}, baseline_at: "2026-09-24T00:00:00Z", source: c.source, streams_baseline_at: "2026-11-23T00:00:00Z" } } };
    const r = await processChannel(c, state, fakeLister({ videos: [], streams: [ep("tW71sjw4Lr4", 21697, "Je li ovo najbolja igra svih vremena?")] }));
    assert.deepEqual(r.fresh.map((e) => [e.id, e.cls]), [["tW71sjw4Lr4", "original"]]);
});

test("kanal bez kartice /streams: nije greška i ne čita se idućih 7 dana", async () => {
    const [c] = loadCandidates({ scoped: false, registry: REG, gate: null });
    const state = { channels: {} };
    let calls = 0;
    const lister = async (url) => {
        if (url.endsWith("/streams")) { calls++; return { entries: [], error: "ERROR: [youtube:tab] @x: This channel does not have a streams tab" }; }
        return { entries: [ep("AAAAAAAAAAA", 3600)], error: null };
    };
    let r = await processChannel(c, state, lister);
    assert.equal(r.error, null);
    assert.ok(state.channels[c.slug].no_streams_at);
    r = await processChannel(c, state, lister);
    assert.equal(calls, 1);
});
