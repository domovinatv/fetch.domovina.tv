#!/usr/bin/env node
/**
 * Testovi faze 03 — protokolarni parser, razrješavanje registra i sidrenje.
 *
 * Svi ulazni nizovi su **doslovni citati iz `part_0N_16k.wav.canary.srt`** ove
 * sjednice, uključujući ASR pogreške („Troskut", „Sela Kraspudić", odsječak bez
 * interpunkcije). Test koji izmisli lijep ulaz ne bi dokazao ništa — parser je
 * napisan upravo protiv ružnog.
 *
 *   node --test sabor_pipeline/tools/test_protocol_parser.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { RosterMatcher } = require("../utils/roster_match.js");
const { findAnnouncements, handoverSentence, handoverRole } =
    require("../utils/protocol_parser.js");
const { normalizeText } = require("../utils/asr_dictionary.js");
const { resolveIdentities } = require("../03_transcribe_and_align.js");

const ROSTER_PATH = path.join(__dirname, "..", "data", "rosters", "sabor_mps_11_saziv.json");
const hasRoster = fs.existsSync(ROSTER_PATH);
const roster = hasRoster ? JSON.parse(fs.readFileSync(ROSTER_PATH, "utf8")) : null;
const matcher = hasRoster ? new RosterMatcher(roster) : null;
const skip = hasRoster ? false : "nema registra — pokreni tools/fetch_sabor_roster.js";

function names(text, opts = { scopeToHandover: true }) {
    return findAnnouncements(normalizeText(text), matcher, opts).map((a) => a.mp.puno_ime);
}

test("registar je stvarni snimak sa sabor.hr, ne izmišljen", { skip }, () => {
    assert.match(roster.source_url, /^https:\/\/www\.sabor\.hr\/api\//);
    assert.ok(roster.mps.length >= 140 && roster.mps.length <= 151,
        `neočekivan broj zastupnika: ${roster.mps.length}`);
    for (const m of roster.mps.slice(0, 20)) {
        assert.ok(m.id && m.puno_ime && m.tokens.length >= 2);
    }
});

test("najava: titula + samo prezime (dominantni obrazac)", { skip }, () => {
    assert.deepEqual(names("Kolega Grmoja, izvolite."), ["Nikola Grmoja"]);
    assert.deepEqual(names("Kolegice Puljak, izvolite."), ["Marijana Puljak"]);
    assert.deepEqual(names("Izvolite kolega Matić."), ["Ivan Matić"]);
});

test("najava preživi ASR distorziju prezimena", { skip }, () => {
    assert.deepEqual(names("Prvi je na redu kolega Troskut."), ["Zvonimir Troskot"]);
    assert.deepEqual(names("Kolegice Sela Kraspudić, izvolite."), ["Marija Selak Raspudić"]);
});

test("najava preživi odsječak bez interpunkcije i velikih slova", { skip }, () => {
    // Canary u dugim odsječcima gubi i jedno i drugo — regex vezan uz velika
    // slova (kako traži specifikacija) ovdje ne bi uhvatio ništa.
    const out = names("kolega bulj izvolite", { scopeToHandover: true });
    assert.deepEqual(out, ["Miro Bulj"]);
});

test('golo „Izvolite." uzima ime iz prethodne rečenice', { skip }, () => {
    assert.deepEqual(
        names("Prelazimo na treću raspravu. Klub nezavisnih zastupnika, govorit će kolega Nino Raspudić. Izvolite."),
        ["Nino Raspudić"]);
});

test("naziv kluba nije najava govornika", { skip }, () => {
    // „…i nezavisnog zastupnika Josipa Jurčevića" je DIO IMENA KLUBA.
    assert.deepEqual(
        names("Sljedeći na redu u ime Kluba zastupnika MOST-a i nezavisnog zastupnika Josip Jurčevića je kolega Miro Bulj."),
        ["Miro Bulj"]);
});

test("ukor usred bloka NE postaje sidro (regresija: Štromar/ministrica)", { skip }, () => {
    // Ovaj blok je bez ograde zalijepio „Predrag Štromar" na 87 minuta govora
    // ministrice. Rečenica predaje riječi ne sadrži ime zastupnika.
    const blok = "Kolega Marković, molim vas sjednite, iskoristite to ako imate s čime ste " +
        "nezadovoljni iz rasprava drugih zastupnika kroz svoje pojedinačne rasprave, replike " +
        "ali nemojte kroz povrede Poslovnika i nemojte razbijati raspravu. Ministrica odgovara, " +
        "imamo još jako, jako puno zastupnika, tako da vas molim da to ne činite. Kolega Štromar, " +
        "molim i vas isto tako. Nemojte, pustite ljude zanima ono o čemu se sada vodi rasprava i " +
        "sad s proceduralnim ili nekim manje važnim upadicama samo narušavamo kvalitetu rasprave. " +
        "Izvolite odgovor, ministricaice?";
    assert.equal(handoverSentence(blok), "Izvolite odgovor, ministricaice?");
    assert.deepEqual(names(blok), []);
    assert.equal(handoverRole(blok), "clan_vlade");
});

test("dug ukor s imenom nije najava, kratak proceduralni jest", { skip }, () => {
    assert.deepEqual(names("Kolega Miletić, povreda Poslovnika."), ["Marin Miletić"]);
    assert.deepEqual(
        names("Kolegice Orešković, onda ne možete govoriti, vi ovo govorite sada kao nezavisna " +
              "zastupnica, dakle nemojte me ispravljati kao takva, imate pravo na slobodni govor."),
        []);
});

test("dvosmisleno prezime ostaje NERAZRIJEŠENO", { skip }, () => {
    // U 11. sazivu su dva Borića, dva Markovića i dva Miloša. Nasumično
    // razrješenje zalijepilo bi krivi identitet kroz cijelu sjednicu.
    assert.equal(matcher.resolve("Borić").mp, null);
    assert.equal(matcher.resolve("Marković").mp, null);
    assert.ok(matcher.resolve("Josip Borić").mp, "puno ime mora proći");
    assert.equal(matcher.resolve("Josip Borić").mp.puno_ime, "Josip Borić");
});

test("osoba izvan registra se ne izmišlja", { skip }, () => {
    // Ministrica nije zastupnica u rasporedu — matcher NE smije naći „najbližeg".
    assert.equal(matcher.resolve("Vučković").mp, null);
});

test("vrsta istupa se čita iz cijelog bloka", { skip }, () => {
    const a = findAnnouncements("Povreda Poslovnika, kolegice Benčić, izvolite.", matcher,
        { scopeToHandover: true });
    assert.equal(a[0].speech_type, "povreda_poslovnika");
    const b = findAnnouncements("Sljedeći na redu za repliku je kolega Marko Pavić.", matcher,
        { scopeToHandover: true });
    assert.equal(b[0].speech_type, "replika");
});

test("jedan zastupnik ne može biti dvije oznake", () => {
    const mpById = new Map([["A", { puno_ime: "Ana Anić", stranka: "X", klub: "K" }]]);
    const votes = new Map([
        ["SPEAKER_01", new Map([["A", 3]])],
        ["SPEAKER_02", new Map([["A", 1]])],
    ]);
    const out = resolveIdentities(votes, new Map(), mpById);
    assert.equal(out.SPEAKER_01.puno_ime, "Ana Anić");
    assert.equal(out.SPEAKER_02.puno_ime, null);
    assert.match(out.SPEAKER_02.dropped_reason, /SPEAKER_01/);
});

test("neslaganje najava pada ispod praga većine", () => {
    const mpById = new Map([
        ["A", { puno_ime: "Ana Anić", stranka: "X", klub: "K" }],
        ["B", { puno_ime: "Bore Borić", stranka: "Y", klub: "L" }],
    ]);
    const out = resolveIdentities(new Map([["S", new Map([["A", 1], ["B", 1]])]]),
        new Map(), mpById);
    assert.equal(out.S.resolved, false);
    assert.equal(out.S.confidence_tier, "nerazriješeno");
});

test("razina pouzdanosti razlikuje jednu najavu od više njih", () => {
    const mpById = new Map([["A", { puno_ime: "Ana Anić", stranka: "X", klub: "K" }]]);
    const one = resolveIdentities(new Map([["S", new Map([["A", 1]])]]), new Map(), mpById);
    const many = resolveIdentities(new Map([["S", new Map([["A", 4]])]]), new Map(), mpById);
    assert.equal(one.S.confidence_tier, "srednja");
    assert.equal(many.S.confidence_tier, "visoka");
});

test("rječnik ispravlja izgovorene kratice s hrvatskim nastavkom", () => {
    assert.equal(normalizeText("u ime kluba hadezea"), "u ime kluba HDZ-a");
    assert.equal(normalizeText("stavka dva ustava erha"), "stavka dva ustava RH");
    assert.equal(normalizeText("koncentracije pefasa"), "koncentracije PFAS-a");
    assert.equal(normalizeText("prijava dorhu i uskoku"), "prijava DORH-u i USKOK-u");
});

test("rod titule razrješava dvosmisleno prezime", { skip }, () => {
    // Sva tri dvosmislena prezimena 11. saziva su rodovno raznorodni parovi.
    assert.deepEqual(names("Kolegice Miloš, izvolite."), ["Jelena Miloš"]);
    assert.deepEqual(names("Kolega Borić, izvolite."), ["Josip Borić"]);
    assert.deepEqual(names("Kolegice Marković, izvolite."), ["Ivana Marković"]);
    // Bez titule (npr. „na redu je …") izjednačenje OSTAJE nerazriješeno.
    assert.equal(matcher.resolve("Miloš").mp, null);
});

test("rod se ne izvodi iz rodovno dvoznačnog imena", () => {
    const { inferGender } = require("../utils/roster_match.js");
    assert.equal(inferGender("Vanja"), null);
    assert.equal(inferGender("Saša"), null);
    assert.equal(inferGender("Nikola"), "m", "muško ime na -a");
    assert.equal(inferGender("Ines"), "z", "žensko ime na suglasnik");
    assert.equal(inferGender("Jelena"), "z");
    assert.equal(inferGender("Josip"), "m");
});
