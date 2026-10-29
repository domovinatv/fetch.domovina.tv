"use strict";
// Testovi bez mreže: provjera oblika batch odgovora + dry-run daje ista `_en` polja kao stari
// prijevod polje po polje (Flutter i generate_ebook.js čitaju baš ta imena).
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    batchShapeError, translateSummary, translateArticle, translateMagisterium, BATCH_TRANSLATOR_PROMPT, __setLlmJson,
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
        assert.equal(s.summary.speakers[0].role_en, "EN gost");
    } finally {
        __setLlmJson(null);
    }
});
