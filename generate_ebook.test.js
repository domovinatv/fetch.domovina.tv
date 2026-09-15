"use strict";
/**
 * Testovi za generate_ebook.js — linkovi i dvojezičnost.
 *
 * Linkovi su ovdje jer knjiga putuje izvan našeg sustava: regresija koja bi
 * timestampove vratila na YouTube ne bi se vidjela ni u jednom logu, nego tek
 * kad je netko podijeli. Vidi docs/2026-09-15-linkovi-kroz-domovina-ai.md.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { episodeUrl, deepLinkUrl, pickLang, translateRole, timestampToSeconds, extractVideoId } = require("./generate_ebook.js");

test("linkovi vode na domovina.ai, nikad na YouTube", async (t) => {
    await t.test("epizoda: hrvatska i engleska ruta", () => {
        assert.equal(episodeUrl("rAAplrRelPM"), "https://domovina.ai/v/rAAplrRelPM");
        assert.equal(episodeUrl("rAAplrRelPM", "en"), "https://domovina.ai/v/rAAplrRelPM/en");
    });

    await t.test("deep link je /t/:sec, a ne YouTube &t=Ns", () => {
        const u = deepLinkUrl("rAAplrRelPM", 92);
        assert.equal(u, "https://domovina.ai/v/rAAplrRelPM/t/92");
        assert.ok(!/youtu/.test(u));
        assert.equal(deepLinkUrl("rAAplrRelPM", 92, "en"), "https://domovina.ai/v/rAAplrRelPM/t/92/en");
    });

    await t.test("sekunde su cijeli broj — /t/41.679 ruta ne postoji", () => {
        assert.equal(deepLinkUrl("x", timestampToSeconds("00:00:41,679")), "https://domovina.ai/v/x/t/41");
        assert.equal(deepLinkUrl("x", -5), "https://domovina.ai/v/x/t/0");
        assert.equal(deepLinkUrl("x", undefined), "https://domovina.ai/v/x/t/0");
    });
});

test("pickLang bira _en polje, uz fallback na hrvatsko", async (t) => {
    const sec = { subtitle: "Naslov", subtitle_en: "Title", content: "Tekst", keywords: ["a"], keywords_en: [] };

    await t.test("hr uzima original i kad prijevod postoji", () => {
        assert.equal(pickLang(sec, "subtitle", "hr"), "Naslov");
    });

    await t.test("en uzima prijevod", () => {
        assert.equal(pickLang(sec, "subtitle", "en"), "Title");
    });

    await t.test("en pada na hrvatsko kad prijevoda nema", () => {
        assert.equal(pickLang(sec, "content", "en"), "Tekst");
    });

    await t.test("prazan niz se NE smatra prijevodom", () => {
        // Inače bi sekcija s `keywords_en: []` izgubila ključne riječi koje ima.
        assert.deepEqual(pickLang(sec, "keywords", "en"), ["a"]);
    });

    await t.test("ne puca na null objektu", () => {
        assert.equal(pickLang(null, "subtitle", "en"), undefined);
    });
});

test("uloge govornika: rječnik s fallbackom", async (t) => {
    await t.test("hr ostaje netaknut", () => {
        assert.equal(translateRole("voditelj", "hr"), "voditelj");
    });

    await t.test("poznate uloge se prevode", () => {
        assert.equal(translateRole("gost", "en"), "guest");
        assert.equal(translateRole("Voditelj", "en"), "host");
    });

    await t.test("složena uloga se prevodi po dijelovima", () => {
        assert.equal(translateRole("voditelj/propovjednik", "en"), "host/preacher");
    });

    await t.test("nepoznata uloga ostaje u originalu", () => {
        assert.equal(translateRole("potpredsjednik stranke", "en"), "potpredsjednik stranke");
    });
});

test("extractVideoId uzima ZADNJI _yt_ (naslovi ga znaju sadržavati)", () => {
    assert.equal(extractVideoId("20260101_o_yt_kanalu_i_jos_nesto_yt_AAzm0ftoqsg"), "AAzm0ftoqsg");
    assert.equal(extractVideoId("20260101_obicna_epizoda_yt_rAAplrRelPM"), "rAAplrRelPM");
});
