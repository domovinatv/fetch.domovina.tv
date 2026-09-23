"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    parseDescriptionSponsors,
    parseSrt,
    textHasAlias,
    norm,
    buildSponsorsDoc,
} = require("./detect_sponsors.js");

const srtBlock = (i, a, b, spk, text) => `${i}\n${a} --> ${b}\n[${spk}] ${text}\n`;

test("opis: blok „Sponzori podcasta:\" s imenom i reklamnim tekstom", () => {
    const d = [
        "Sponzori podcasta:",
        "",
        "HiPP: https://www.hipp.hr/njega/hipp-babysanft/ ",
        "Pjena za pranje - s ekstraktom badema iz BIO uzgoja.",
        "",
        "Plazma: https://www.plazma.rs/ ",
        "#rastucisdjecom #hipp",
    ].join("\n");
    const s = parseDescriptionSponsors(d);
    assert.deepEqual(s.map((x) => [x.name, x.url]), [
        ["HiPP", "https://www.hipp.hr/njega/hipp-babysanft/"],
        ["Plazma", "https://www.plazma.rs/"],
    ]);
    assert.match(s[0].blurb, /badema/);
});

test("opis: ime bez dvotočke („Lasta, since 1952 URL\")", () => {
    const s = parseDescriptionSponsors("Sponzor podcasta:\n\nLasta, since 1952 https://lasta.com/ ");
    assert.equal(s[0].name, "Lasta");
    assert.equal(s[0].url, "https://lasta.com/");
});

test("opis: ime i URL u dva retka se spajaju (Cafe Brazil)", () => {
    const d = [
        " Cafe Brazil, partner našeg podcasta, omogućio nam je da uz šalicu njihove fine kave…",
        "Hvala partneru podcasta: https://eurovip-brazil-kava.com/ ❤️ zapratite ih i na instagramu: https://www.instagram.com/cafebrazil.ba?",
        "Hvala i sponzoru ove epizode, aplikaciji e-Duhovne vježbe, na podršci! https://eduhovnevjezbe.hr/ ",
    ].join("\n\n");
    const s = parseDescriptionSponsors(d);
    assert.deepEqual(s.map((x) => [x.name, x.role, x.url]), [
        ["Cafe Brazil", "partner", "https://eurovip-brazil-kava.com/"],
        ["e-Duhovne vježbe", "sponsor", "https://eduhovnevjezbe.hr/"],
    ]);
});

test("opis: popis poglavlja, Patreon i vlastita trgovina NISU sponzori", () => {
    const d = [
        "00:56:00 - 01:00:29 | Produkcija, sponzori i priprema epizoda",
        "Podržite moj rad na Patreonu, hvala sponzorima: https://patreon.com/IvaKraljevic",
        "Sponzor ove epizode je moj planer: https://www.ivakraljevic.com/product-page/planer",
    ].join("\n");
    assert.deepEqual(parseDescriptionSponsors(d, "iva_kraljevic"), []);
});

test("opis: naslov bloka nije ime sponzora; garderoba i studio imaju svoju ulogu", () => {
    const d = [
        "HVALA NAŠIM PATRONIMA I SPONZORIMA:",
        "Angellum https://instagram.com/angellum_hr/ ",
        "Inovapro https://solarnakarta.hr ",
        "",
        "Voditeljicu odijeva: Unique Concept Store, zaprati na Instagramu https://www.instagram.com/unique_concept_store_/",
        "",
        "Opremanje studija pomogli:",
        "Namještaj Gojan https://www.instagram.com/gojan.namjestaj",
    ].join("\n");
    const s = parseDescriptionSponsors(d);
    assert.deepEqual(s.map((x) => [x.name, x.role]), [
        ["Angellum", "sponsor"],
        ["Inovapro", "sponsor"],
        ["Unique Concept Store", "wardrobe"],
        ["Namještaj Gojan", "studio"],
    ]);
});

test("opis: generalni pokrovitelj viče velikim slovima", () => {
    const s = parseDescriptionSponsors("🌟GENERALNI POKROVITELJ PODCASTA: ANGELLUM \nhttps://angellum.hr/?gclid=abc");
    assert.equal(s[0].name, "Angellum");
    assert.equal(s[0].role, "partner");
});

test("alias: ASR padeži i pogreške pogađaju, obične riječi ne", () => {
    assert.ok(textHasAlias(norm("hvala HIP-u koji nas podržava"), "hipp"));
    assert.ok(textHasAlias(norm("dobrodošli u plazmin trenutak"), "plazma"));
    assert.ok(textHasAlias(norm("ponovno podržava Plasma"), "plazma"));
    assert.ok(textHasAlias(norm("pokrovitelju podcasta Angelumu"), "angellum"));
    assert.ok(!textHasAlias(norm("Svestrani Goran"), "gojan", false));
    assert.ok(!textHasAlias(norm("hvala vam svima"), "hvalanasimpatronimaisponzorima"));
});

test("spot: kratak zaseban glas + najava pauze + ime u spotu (Iva ep. 50)", () => {
    const pad = [];
    // 25 min razgovora dva voditelja
    for (let i = 0; i < 50; i++) {
        const t = 60 + i * 30;
        const hh = (x) => new Date(x * 1000).toISOString().slice(11, 19) + ",000";
        pad.push(srtBlock(i + 1, hh(t), hh(t + 25), i % 2 ? "SPEAKER_00" : "SPEAKER_01", "Razgovaramo o obitelji i vjeri."));
    }
    const srt = [
        ...pad,
        srtBlock(100, "01:39:06,340", "01:39:24,740", "SPEAKER_01", "neka gledatelji ostanu i nakon ove promo pauze."),
        srtBlock(101, "01:39:24,770", "01:39:44,780", "SPEAKER_02", "Aplikacija e-Duhovne vježbe poziva te da svaki dan zastaneš."),
        srtBlock(102, "01:39:45,440", "01:40:00,110", "SPEAKER_02", "Svakodnevni susret s Božjom riječju."),
        srtBlock(103, "01:40:02,000", "01:40:06,380", "SPEAKER_02", "Počni već danas. Besplatno preuzmi aplikaciju e-Duhovne vježbe."),
        srtBlock(104, "01:40:08,570", "01:40:26,890", "SPEAKER_01", "Evo nas nazad. Razgovaramo dalje o vjeri."),
    ].join("\n");
    const doc = buildSponsorsDoc({
        videoId: "aue1GuuMsbA",
        description: "Hvala i sponzoru ove epizode, aplikaciji e-Duhovne vježbe, na podršci! https://eduhovnevjezbe.hr/",
        chapters: [{ start_time: 5940, end_time: 6000, title: "e-Duhovne vježbe" }],
        segs: parseSrt(srt),
        durationSec: 9678,
    });
    const spot = doc.sponsors[0].segments.find((g) => g.kind === "spot");
    assert.equal(doc.type, "sponsors_in_video");
    assert.equal(spot.start, 5963);
    assert.equal(spot.end, 6008);
    assert.equal(spot.playable, true);
    assert.equal(spot.url, "https://domovina.ai/v/aue1GuuMsbA/t/5963");
    assert.ok(spot.signals.includes("youtube_chapter"));
});

test("host_read: sponzor s drugih epizoda kanala se prepoznaje po izgovoru", () => {
    const srt = [
        srtBlock(1, "00:01:39,000", "00:01:45,000", "SPEAKER_00", "Ovu epizodu i dalje podržava hip ovoga puta uz jedan novi proizvod."),
        srtBlock(2, "00:01:46,000", "00:01:55,000", "SPEAKER_00", "Ovo je linija Baby Sanft proizvoda za njegu."),
        srtBlock(3, "00:01:56,000", "00:02:00,000", "SPEAKER_00", "A danas je moja gošća psihologinja."),
        srtBlock(4, "00:02:01,000", "00:02:05,000", "SPEAKER_00", "Dobrodošla."),
    ].join("\n");
    const channelSponsors = parseDescriptionSponsors("Sponzori podcasta:\nHiPP: https://www.hipp.hr/");
    const doc = buildSponsorsDoc({ videoId: "kdOTMHIqtUs", description: "", chapters: [], segs: parseSrt(srt), durationSec: 5000, channelSponsors });
    assert.equal(doc.sponsors.length, 1);
    assert.equal(doc.sponsors[0].name, "HiPP");
    assert.equal(doc.sponsors[0].source, "channel");
    const g = doc.sponsors[0].segments[0];
    assert.equal(g.kind, "host_read");
    assert.equal(g.start, 98);
    assert.equal(g.end, 116);
});

test("epizoda bez sponzora i dalje dobiva dokument s praznim nizom", () => {
    const doc = buildSponsorsDoc({ videoId: "x", description: "Zapratite nas na Instagramu https://instagram.com/x", chapters: [], segs: [], durationSec: 0 });
    assert.deepEqual(doc.sponsors, []);
    assert.equal(doc.schema_version, 1);
});
