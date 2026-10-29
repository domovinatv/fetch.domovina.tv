"use strict";
// Testovi bez mreže: provjera oblika batch odgovora + dry-run daje ista `_en` polja kao stari
// prijevod polje po polje (Flutter i generate_ebook.js čitaju baš ta imena).
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    batchShapeError, translateSummary, translateArticle, translateMagisterium, translateReels, BATCH_TRANSLATOR_PROMPT, __setLlmJson,
    reelsSourceSha, speakerNameMap, speakerRoleEn, planSegments, hmsToSec,
} = require("./translate_to_english.js");

test("batchShapeError: ispravan odgovor prolazi", () => {
    assert.equal(batchShapeError({ a: "x", b: ["y", "z"] }, { a: "X", b: ["Y", "Z"] }), null);
});

test("batchShapeError: nedostaje ključ, kriva duljina niza, prazan prijevod", () => {
    assert.match(batchShapeError({ a: "x", b: "y" }, { a: "X" }), /b: očekivan string/);
    assert.match(batchShapeError({ k: ["a", "b", "c"] }, { k: ["A", "B"] }), /2 umjesto 3/);
    assert.match(batchShapeError({ a: "tekst" }, { a: "" }), /prazan prijevod/);
    assert.match(batchShapeError({ k: ["a"] }, { k: "A" }), /očekivan niz/);
    assert.match(batchShapeError({ a: "x" }, ["X"]), /nije objekt/);
});

test("batchShapeError: prazan izvor smije ostati prazan", () => {
    assert.equal(batchShapeError({ a: "", k: ["", "b"] }, { a: "", k: ["", "B"] }), null);
});

test("batch prompt traži iste ključeve i nizove iste duljine", () => {
    assert.match(BATCH_TRANSLATOR_PROMPT, /EXACTLY the same keys/);
    assert.match(BATCH_TRANSLATOR_PROMPT, /same length and order/);
    assert.doesNotMatch(BATCH_TRANSLATOR_PROMPT, /\{"en":/);
});

const section = () => ({
    subtitle: "Naslov", screenshot_description: "Opis", content: "Sadržaj **bold**",
    keywords: ["brak", "vjera"], entities: ["Zagreb"],
});

test("article: ista _en polja kao prije", async () => {
    const out = await translateArticle({ iterations: [{ theme: "Tema", reason_for_cut: "Rez", sections: [section(), section()] }] }, true);
    const it = out.iterations[0];
    assert.ok(it.theme_en && it.reason_for_cut_en);
    for (const sec of it.sections) {
        for (const k of ["subtitle_en", "screenshot_description_en", "content_en"]) assert.equal(typeof sec[k], "string", k);
        assert.equal(sec.keywords_en.length, 2);
        assert.equal(sec.entities_en.length, 1);
    }
    assert.equal(out.translation.target_language, "en");
});

test("magisterium: zaglavlje, overall i sekcijska prosudba", async () => {
    const out = await translateMagisterium({
        score_interpretation: "Dobro",
        score_breakdown: [{ theme: "A" }, { theme: "B" }],
        overall: { assessment: "Ocjena", theological_context: "Kontekst", seeds_of_logos: ["s1"], concerns: ["c1", "c2"], citations: [{ document_title: "Gaudium et spes" }] },
        iterations: [{ theme: "T", sections: [{ ...section(), magisterium: { assessment: "a", enrichment: "e", concerns: ["x"] } }] }],
    }, true);
    assert.ok(out.score_interpretation_en);
    assert.ok(out.score_breakdown.every((sb) => sb.theme_en));
    assert.ok(out.overall.assessment_en && out.overall.theological_context_en);
    assert.equal(out.overall.seeds_of_logos_en.length, 1);
    assert.equal(out.overall.concerns_en.length, 2);
    assert.equal(out.overall.citations_en, undefined, "citati se ne prevode");
    const sec = out.iterations[0].sections[0];
    assert.ok(sec.content_en && sec.magisterium.assessment_en && sec.magisterium.enrichment_en);
    assert.equal(sec.magisterium.concerns_en.length, 1);
    assert.ok(out.iterations[0].theme_en);
});

test("summary: title_en/abstract_en (ne title_hr_en), nizovi i uloge govornika", async () => {
    const out = await translateSummary({
        summary: {
            title_hr: "Naslov", abstract_hr: "Sažetak", key_topics: ["t1"], key_points: ["p1", "p2"],
            mentioned_people: ["Ivan"], mentioned_places: [], mentioned_organizations: ["HBK"],
            speakers: [{ name: "A", role: "voditelj" }, { name: "B", role: "gost" }],
        },
    }, true);
    const s = out.summary;
    assert.ok(s.title_en && s.abstract_en);
    assert.equal(s.title_hr_en, undefined);
    assert.equal(s.key_points_en.length, 2);
    assert.deepEqual(s.mentioned_places_en, [], "prazan niz → prazan _en niz, bez poziva");
    assert.ok(s.speakers.every((sp) => sp.role_en));
    assert.equal(s.language, "hr");
});

test("magisterium: sekcije i teme preuzima iz article.en.json, prevodi samo prosudbu", async () => {
    const sec = { subtitle: "Naslov", screenshot_description: "Opis", content: "Tekst", keywords: ["a"], entities: ["B"] };
    const articleEn = { iterations: [{ theme: "Tema", theme_en: "Theme", sections: [{
        ...sec, subtitle_en: "Title", screenshot_description_en: "Desc", content_en: "Text", keywords_en: ["A"], entities_en: ["B"],
    }] }] };
    const out = await translateMagisterium({ iterations: [{ theme: "Tema", sections: [
        { ...sec, magisterium: { assessment: "Ocjena" } },
        { ...sec, content: "Drukčiji tekst", magisterium: { assessment: "Ocjena 2" } },
    ] }] }, true, articleEn);
    const [a, b] = out.iterations[0].sections;
    assert.equal(out.iterations[0].theme_en, "Theme");
    assert.equal(a.content_en, "Text");
    assert.deepEqual(a.keywords_en, ["A"]);
    assert.match(a.magisterium.assessment_en, /dry-run/, "prosudba se i dalje prevodi");
    assert.match(b.content_en, /dry-run/, "sekcija koja se ne poklapa prevodi se normalno");
});

test("article: cijeli dokument u jednom pozivu; kad ne prođe, greška bez fallbacka", async () => {
    const sec = (t) => ({ subtitle: `N ${t}`, content: `T ${t}`, keywords: [`k ${t}`] });
    const art = () => ({ iterations: [{ theme: "A", sections: [sec(1), sec(2)] }, { theme: "B", sections: [sec(3)] }] });
    const echo = (user) => Object.fromEntries(Object.entries(JSON.parse(user)).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => `EN ${x}`) : `EN ${v}`]));
    const calls = [];
    try {
        __setLlmJson(async (_sys, user) => { calls.push(Object.keys(JSON.parse(user)).length); return echo(user); });
        let out = await translateArticle(art(), false);
        assert.equal(calls.length, 1, "cijeli članak = 1 poziv");
        assert.equal(out.iterations[1].sections[0].content_en, "EN T 3");
        assert.deepEqual(out.iterations[0].sections[1].keywords_en, ["EN k 2"]);

        // Model izgubi ključ → isti poziv još jednom, pa greška (nema spuštanja na sekcije).
        calls.length = 0;
        __setLlmJson(async (_sys, user) => { calls.push(1); const o = echo(user); delete o.i1_theme; return o; });
        await assert.rejects(translateArticle(art(), false), /članak: prijevod u jednom pozivu nije uspio \(i1_theme: očekivan string\)/);
        assert.equal(calls.length, 2, "2 pokušaja cijelog dokumenta, bez poziva po sekciji");
    } finally {
        __setLlmJson(null);
    }
});

test("magisterium i sažetak: po jedan poziv", async () => {
    const calls = [];
    const echo = (user) => Object.fromEntries(Object.entries(JSON.parse(user)).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => `EN ${x}`) : `EN ${v}`]));
    try {
        __setLlmJson(async (_sys, user) => { calls.push(1); return echo(user); });
        const m = await translateMagisterium({ score_interpretation: "Dobro", overall: { assessment: "O" }, iterations: [
            { theme: "T", sections: [{ subtitle: "S", content: "C", magisterium: { assessment: "A1" } }, { subtitle: "S2", content: "C2", magisterium: { assessment: "A2" } }] },
        ] }, false);
        assert.equal(calls.length, 1);
        assert.equal(m.iterations[0].sections[1].magisterium.assessment_en, "EN A2");
        assert.equal(m.overall.assessment_en, "EN O");
        const s = await translateSummary({ summary: { title_hr: "Naslov", key_points: ["a", "b"], speakers: [{ role: "gost" }] } }, false);
        assert.equal(calls.length, 2);
        assert.equal(s.summary.title_en, "EN Naslov");
        assert.equal(s.summary.speakers[0].role_en, "guest", "poznata uloga ne ovisi o modelu");
    } finally {
        __setLlmJson(null);
    }
});

const echoEn = (user) => Object.fromEntries(Object.entries(JSON.parse(user)).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => `EN ${x}`) : `EN ${v}`]));

test("summary: suggested_name_en i role_en za publiku (ne „interlocutor“)", async () => {
    try {
        __setLlmJson(async (_sys, user) => echoEn(user));
        const s = await translateSummary({ summary: { title_hr: "N", speakers: [
            { suggested_name: "Matija Stepanić", role: "gost" },
            { suggested_name: "Sudionica iz publike", role: "sugovornik" },
            { suggested_name: "Ana", role: "sugovornica" },
        ] } }, false);
        const [a, b, c] = s.summary.speakers;
        assert.equal(a.suggested_name_en, "EN Matija Stepanić", "ime ide modelu (vlastito vraća neprevedeno)");
        assert.equal(a.role_en, "guest");
        assert.equal(b.role_en, "audience member");
        assert.equal(c.role_en, "participant");
    } finally {
        __setLlmJson(null);
    }
    assert.equal(speakerRoleEn("prof", "X"), null, "nepoznata uloga ostaje prijevodu modela");
});

const reelsDoc = () => ({
    version: 1, video_id: "QkcpHsj43rE", title: "AI u praksi",
    rejected: [{ reason: "prekratko" }],
    reels: [{
        rank: 1, start_sec: 3342.33, end_sec: 3429.15, start_seq: 279, end_seq: 285, kind: "story", score: 9,
        title: "Kauč stigao", hook: "Tri mjeseca", why: "Zato", quote: "Napiši mail",
        speaker: "Sudionica iz publike", speakers: ["Sudionica iz publike", "Matija Stepanić"],
        render: { url: "https://cdn/x.mp4" },
        cards: [
            { type: "lower_third", at_sec: 0, text: "Sudionica iz publike · StartupVG", anchor: null, anchored: false },
            { type: "number", at_sec: 9.96, text: "Kauč kasni", anchor: "Tri mjeseca ga već", anchored: true, value: "3 mjeseca" },
        ],
    }],
});

test("reels: ista shema, prevedene vrijednosti, anchor/at_sec netaknuti, 1 poziv", async () => {
    const calls = [];
    try {
        __setLlmJson(async (_sys, user) => { calls.push(JSON.parse(user)); return echoEn(user); });
        const nameMap = new Map([["Sudionica iz publike", "Audience member"]]);
        const out = await translateReels(reelsDoc(), false, { nameMap });
        assert.equal(calls.length, 1, "cijeli reels.json = 1 poziv");
        assert.ok(!Object.keys(calls[0]).some((k) => k.endsWith("_speaker")), "ime iz mape ne ide modelu");
        const r = out.reels[0];
        assert.equal(out.title, "EN AI u praksi");
        assert.equal(r.title, "EN Kauč stigao");
        assert.equal(r.title_en, undefined, "EN fajl nosi prijevod pod izvornim ključem");
        assert.equal(r.speaker, "Audience member");
        assert.deepEqual(r.speakers, ["Audience member", "EN Matija Stepanić"]);
        assert.equal(r.cards[1].value, "EN 3 mjeseca");
        assert.equal(r.cards[1].anchor, "Tri mjeseca ga već", "anchor ostaje HR (sidro na words.json)");
        assert.equal(r.cards[1].at_sec, 9.96);
        assert.deepEqual([r.rank, r.start_sec, r.end_seq, r.kind, r.score], [1, 3342.33, 285, "story", 9]);
        assert.equal(r.render, undefined, "video reela se čita iz reels.json");
        assert.equal(out.rejected, undefined);
        assert.equal(out.language, "en");
        assert.equal(out.translation.source_sha256, reelsSourceSha(reelsDoc()));
    } finally {
        __setLlmJson(null);
    }
});

test("reels: otisak ovisi samo o tekstu, ne o render bloku", () => {
    const a = reelsDoc();
    const b = reelsDoc(); b.reels[0].render = { url: "https://cdn/y.mp4", poster_url: "p" };
    const c = reelsDoc(); c.reels[0].hook = "Drukčiji hook";
    assert.equal(reelsSourceSha(a), reelsSourceSha(b));
    assert.notEqual(reelsSourceSha(a), reelsSourceSha(c));
    assert.deepEqual([...speakerNameMap({ summary: { speakers: [
        { suggested_name: "Ana", suggested_name_en: "Ana" }, { suggested_name: "Sudionik iz publike 1", suggested_name_en: "Audience member 1" },
    ] } })], [["Sudionik iz publike 1", "Audience member 1"]]);
});

test("hmsToSec: HH:MM:SS i MM:SS, smeće = null", () => {
    assert.equal(hmsToSec("01:30:05"), 5405);
    assert.equal(hmsToSec("12:07"), 727);
    assert.equal(hmsToSec(""), null);
    assert.equal(hmsToSec(undefined), null);
});

test("planSegments: reže po 90 min i po veličini, sekciju nikad", () => {
    const sp = (unit, t, text) => ({ obj: { x: text }, key: "x", unit, t });
    // 4 sekcije po 40 min; svaka ima 2 polja koja moraju ostati zajedno.
    const specs = [];
    for (let i = 0; i < 4; i++) specs.push(sp(`s${i}`, i * 2400, "a"), sp(`s${i}`, i * 2400, "b"));
    const segs = planSegments([sp("hdr", null, "h"), ...specs], 90 * 60, 1e9);
    assert.deepEqual(segs.map((s) => s.length), [1 + 6, 2], "zaglavlje + 0/40/80 min, pa 120 min");
    // Veličina: 3 jedinice po ~1 KB uz granicu 2,5 KB → 2 + 1.
    const big = [0, 1, 2].map((i) => sp(`b${i}`, i * 60, "x".repeat(1000)));
    assert.deepEqual(planSegments(big, 90 * 60, 2500).map((s) => s.length), [2, 1]);
    // Jedinica veća od granice ide sama, ne puca.
    assert.deepEqual(planSegments([sp("u", 0, "x".repeat(5000))], 90 * 60, 1000).map((s) => s.length), [1]);
});

test("article: 3-satna epizoda = 2 poziva po ≤90 min, sva _en polja na mjestu", async () => {
    const sec = (ts, t) => ({ subtitle: `N ${t}`, screenshot_timestamp: ts, content: `T ${t}`, keywords: [`k ${t}`] });
    const art = { iterations: [
        { start_time: "00:00:00", theme: "A", sections: [sec("00:05:00", 1), sec("00:50:00", 2)] },
        { start_time: "01:20:00", theme: "B", sections: [sec("01:25:00", 3), sec("02:10:00", 4)] },
    ] };
    const echo = (user) => Object.fromEntries(Object.entries(JSON.parse(user)).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => `EN ${x}`) : `EN ${v}`]));
    const calls = [];
    try {
        __setLlmJson(async (_sys, user) => { calls.push(Object.keys(JSON.parse(user))); return echo(user); });
        const out = await translateArticle(art, false);
        assert.equal(calls.length, 2);
        // 0, 5, 50, 80 (zaglavlje 2. iteracije) i 85 min u prvom; 130 min otvara drugi.
        assert.deepEqual(calls[1], ["i1_s1_subtitle", "i1_s1_content", "i1_s1_keywords"]);
        assert.ok(calls[0].includes("i0_theme") && calls[0].includes("i1_theme") && calls[0].includes("i1_s0_content"));
        assert.equal(out.iterations[1].sections[1].content_en, "EN T 4");
        assert.equal(out.iterations[0].sections[0].content_en, "EN T 1");
    } finally {
        __setLlmJson(null);
    }
});
