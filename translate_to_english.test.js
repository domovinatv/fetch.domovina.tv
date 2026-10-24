"use strict";
// Testovi bez mreže: provjera oblika batch odgovora + dry-run daje ista `_en` polja kao stari
// prijevod polje po polje (Flutter i generate_ebook.js čitaju baš ta imena).
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    batchShapeError, translateSummary, translateArticle, translateMagisterium, BATCH_TRANSLATOR_PROMPT,
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
