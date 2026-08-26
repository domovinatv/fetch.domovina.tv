"use strict";

/**
 * Testovi sloja ljudskih odluka.
 *
 * Težište nije na „radi li upis" nego na tri mjesta gdje bi tiha greška bila
 * skupa: (1) da ljudska odluka doista pobjeđuje glasove, (2) da protokolarna
 * oznaka izgubi ime kad čovjek istog zastupnika pripiše drugoj oznaci, i
 * (3) da se dvije ljudske odluke o istoj osobi NE razriješe nasumice.
 *
 *   node --test sabor_pipeline/utils/human_overrides.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateEntry, apply, ODLUKE } = require("./human_overrides.js");

const NOW = "2026-08-26T09:00:00Z";
const MPS = new Map([
    ["1", { id: "1", puno_ime: "Ana Anić", stranka: "HDZ", klub: "Klub HDZ" }],
    ["2", { id: "2", puno_ime: "Bruno Brnić", stranka: "SDP", klub: "Klub SDP" }],
]);

function ovr(extra) {
    return { odluka: "imenuj", mp_id: "1", odlucio: "ms", odluceno_at: NOW, ...extra };
}

// ───────────────────────────── validacija ─────────────────────────────

test("valjan unos prolazi", () => {
    assert.deepEqual(validateEntry("SPEAKER_001", ovr(), MPS), []);
});

test("odluka mora biti iz zatvorenog skupa", () => {
    const err = validateEntry("SPEAKER_001", ovr({ odluka: "mozda" }), MPS);
    assert.ok(err.some((e) => e.includes("odluka")));
    assert.ok(ODLUKE.includes("imenuj"));
});

test("nepostojeći mp_id pada odmah, ne tek u fazi 03", () => {
    const err = validateEntry("SPEAKER_001", ovr({ mp_id: "999" }), MPS);
    assert.ok(err.some((e) => e.includes("ne postoji u registru")));
});

test("ime izvan registra traži ulogu", () => {
    const bez = validateEntry("SPEAKER_001",
        ovr({ mp_id: null, puno_ime: "Gordan Jandroković" }), MPS);
    assert.ok(bez.some((e) => e.includes("traži ulogu")));
    const s = validateEntry("SPEAKER_001",
        ovr({ mp_id: null, puno_ime: "Gordan Jandroković", uloga: "predsjedatelj" }), MPS);
    assert.deepEqual(s, []);
});

test("odluka bez potpisa i datuma nije odluka", () => {
    const err = validateEntry("SPEAKER_001",
        { odluka: "imenuj", mp_id: "1" }, MPS);
    assert.ok(err.some((e) => e.includes("odlucio")));
    assert.ok(err.some((e) => e.includes("odluceno_at")));
});

test("odbaci ne traži ime — oznaka namjerno ostaje bezimena", () => {
    assert.deepEqual(
        validateEntry("SPEAKER_001", { odluka: "odbaci", odlucio: "ms", odluceno_at: NOW, razlog: "krivo" }, MPS),
        []);
});

// ───────────────────────────── primjena ─────────────────────────────

test("ljudska odluka nadjačava većinu glasova", () => {
    const map = {
        SPEAKER_005: {
            mp_id: "2", puno_ime: "Bruno Brnić", stranka: "SDP", klub: "Klub SDP",
            votes: 3, votes_total: 4, confidence: 0.75, confidence_tier: "visoka", resolved: true,
        },
    };
    const r = apply(map, { overrides: { SPEAKER_005: ovr() } }, MPS);
    assert.equal(r.errors.length, 0);
    assert.equal(map.SPEAKER_005.puno_ime, "Ana Anić");
    assert.equal(map.SPEAKER_005.identity_source, "covjek");
    assert.equal(map.SPEAKER_005.confidence_tier, "ljudska_odluka");
    // Glasovi se NE brišu — trag zašto je stroj mislio drugačije mora ostati.
    assert.equal(map.SPEAKER_005.votes, 3);
    assert.equal(r.applied[0].prije, "Bruno Brnić");
});

test("protokolarna oznaka gubi ime kad ga čovjek dade drugoj", () => {
    const map = {
        SPEAKER_010: {
            mp_id: "1", puno_ime: "Ana Anić", stranka: "HDZ", klub: "Klub HDZ",
            votes: 2, votes_total: 2, confidence: 1, confidence_tier: "visoka", resolved: true,
        },
        SPEAKER_020: { resolved: false, confidence_tier: "nerazriješeno", votes: 0, votes_total: 0 },
    };
    const r = apply(map, { overrides: { SPEAKER_020: ovr() } }, MPS);
    assert.equal(r.errors.length, 0);
    assert.equal(map.SPEAKER_020.puno_ime, "Ana Anić");
    assert.equal(map.SPEAKER_010.resolved, false);
    assert.equal(map.SPEAKER_010.puno_ime, null);
    assert.match(map.SPEAKER_010.dropped_reason, /SPEAKER_020/);
    assert.deepEqual(r.dropped.map((d) => d.speaker), ["SPEAKER_010"]);
});

test("dvije ljudske odluke o istoj osobi NE razrješavaju se nasumice", () => {
    const map = { SPEAKER_010: { resolved: false }, SPEAKER_020: { resolved: false } };
    const r = apply(map, { overrides: { SPEAKER_010: ovr(), SPEAKER_020: ovr() } }, MPS);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /audit_merge_cohesion\.py/);
    assert.equal(r.shared.length, 0);
});

test("dijeljena oznaka prolazi tek uz izričito dopuštenje", () => {
    const map = { SPEAKER_010: { resolved: false }, SPEAKER_020: { resolved: false } };
    const doc = {
        overrides: {
            SPEAKER_010: ovr({ dopusti_dijeljenu_oznaku: true }),
            SPEAKER_020: ovr({ dopusti_dijeljenu_oznaku: true }),
        },
    };
    const r = apply(map, doc, MPS);
    assert.equal(r.errors.length, 0);
    assert.deepEqual(r.shared, [{ osoba: "Ana Anić", oznake: ["SPEAKER_010", "SPEAKER_020"] }]);
    assert.equal(map.SPEAKER_010.resolved, true);
    assert.equal(map.SPEAKER_020.resolved, true);
});

test("odbaci ostavlja oznaku bezimenom unatoč glasovima", () => {
    const map = {
        SPEAKER_030: {
            mp_id: "2", puno_ime: "Bruno Brnić", resolved: true,
            votes: 5, votes_total: 5, confidence: 1, confidence_tier: "visoka",
        },
    };
    const r = apply(map, {
        overrides: {
            SPEAKER_030: { odluka: "odbaci", odlucio: "ms", odluceno_at: NOW, razlog: "spomen, ne istup" },
        },
    }, MPS);
    assert.equal(r.errors.length, 0);
    assert.equal(map.SPEAKER_030.resolved, false);
    assert.equal(map.SPEAKER_030.puno_ime, null);
    assert.match(map.SPEAKER_030.dropped_reason, /spomen, ne istup/);
});

test("preskoci ne mijenja izlaz", () => {
    const map = { SPEAKER_040: { resolved: false, confidence_tier: "nerazriješeno" } };
    const r = apply(map, {
        overrides: { SPEAKER_040: { odluka: "preskoci", odlucio: "ms", odluceno_at: NOW } },
    }, MPS);
    assert.deepEqual(r.applied, []);
    assert.equal(map.SPEAKER_040.confidence_tier, "nerazriješeno");
    assert.equal(map.SPEAKER_040.identity_source, "protokol");
});

test("osoba izvan registra dobiva ime i ulogu, bez mp_id", () => {
    const map = { SPEAKER_001: { resolved: false, role_hint: "clan_vlade", role_votes: 5 } };
    const r = apply(map, {
        overrides: {
            SPEAKER_001: {
                odluka: "imenuj", mp_id: null, puno_ime: "Marija Vučković",
                uloga: "clan_vlade", odlucio: "ms", odluceno_at: NOW,
            },
        },
    }, MPS);
    assert.equal(r.errors.length, 0);
    assert.equal(map.SPEAKER_001.mp_id, null);
    assert.equal(map.SPEAKER_001.puno_ime, "Marija Vučković");
    assert.equal(map.SPEAKER_001.role_hint, "clan_vlade");
    assert.equal(r.applied[0].izvan_registra, true);
});

test("dvije osobe izvan registra istog imena sudaraju se kao i zastupnici", () => {
    // Ključ identiteta za osobu bez `mp_id` je normalizirano ime; „Đakić" i
    // „Dakic" moraju pasti na isti ključ, inače isti čovjek prođe kao dvoje.
    const map = { SPEAKER_001: { resolved: false }, SPEAKER_002: { resolved: false } };
    const e = { odluka: "imenuj", mp_id: null, uloga: "clan_vlade", odlucio: "ms", odluceno_at: NOW };
    const r = apply(map, {
        overrides: {
            SPEAKER_001: { ...e, puno_ime: "Josip Đakić" },
            SPEAKER_002: { ...e, puno_ime: "Josip Dakic" },
        },
    }, MPS);
    assert.equal(r.errors.length, 1);
});

// ─────────────── autorstvo vs provjerenost ───────────────
//
// Ovo je zasebna skupina jer je upravo tu prva verzija tiho pala: potvrda
// imena koje je protokol sam našao pripisivala je to ime ČOVJEKU, pa je nakon
// 64 potvrde protokolarni udio imenovanog vremena pao sa 66 % na 6 %.

test("potvrda protokolarnog imena NE prepisuje autorstvo na čovjeka", () => {
    const map = {
        SPEAKER_009: {
            mp_id: "1", puno_ime: "Ana Anić", stranka: "HDZ", klub: "Klub HDZ",
            votes: 1, votes_total: 1, confidence: 1, confidence_tier: "srednja", resolved: true,
        },
    };
    const r = apply(map, {
        overrides: { SPEAKER_009: { ...ovr(), odluka: "potvrdi" } },
    }, MPS);
    assert.equal(r.errors.length, 0);
    assert.equal(map.SPEAKER_009.identity_source, "protokol");
    assert.equal(map.SPEAKER_009.verified_by_human, true);
    assert.equal(map.SPEAKER_009.puno_ime, "Ana Anić");
    assert.equal(r.applied[0].novo_ime, false);
});

test("ime kojega protokol NIJE imao pripisuje se čovjeku", () => {
    const map = { SPEAKER_050: { resolved: false, confidence_tier: "nerazriješeno" } };
    const r = apply(map, { overrides: { SPEAKER_050: ovr() } }, MPS);
    assert.equal(map.SPEAKER_050.identity_source, "covjek");
    assert.equal(map.SPEAKER_050.confidence_tier, "ljudska_odluka");
    assert.equal(r.applied[0].novo_ime, true);
});

test("ispravak protokolarnog imena pripisuje se čovjeku", () => {
    const map = {
        SPEAKER_060: {
            mp_id: "2", puno_ime: "Bruno Brnić", resolved: true,
            votes: 1, votes_total: 1, confidence: 1, confidence_tier: "srednja",
        },
    };
    const r = apply(map, { overrides: { SPEAKER_060: ovr() } }, MPS);
    assert.equal(map.SPEAKER_060.identity_source, "covjek");
    assert.equal(r.applied[0].novo_ime, true);
});

test("potvrđena oznaka i dalje pobjeđuje protokolarnu u sukobu oko iste osobe", () => {
    // Potvrda ne mijenja autorstvo, ali JEST ljudska odluka — oznaka koju je
    // čovjek potvrdio ne smije izgubiti ime od oznake koju nitko nije gledao.
    const map = {
        SPEAKER_070: {
            mp_id: "1", puno_ime: "Ana Anić", resolved: true,
            votes: 1, votes_total: 1, confidence: 1, confidence_tier: "srednja",
        },
        SPEAKER_071: {
            mp_id: "1", puno_ime: "Ana Anić", resolved: true,
            votes: 3, votes_total: 3, confidence: 1, confidence_tier: "visoka",
        },
    };
    const r = apply(map, {
        overrides: { SPEAKER_070: { ...ovr(), odluka: "potvrdi" } },
    }, MPS);
    assert.equal(r.errors.length, 0);
    assert.equal(map.SPEAKER_070.resolved, true);
    assert.equal(map.SPEAKER_071.resolved, false);
    assert.deepEqual(r.dropped.map((d) => d.speaker), ["SPEAKER_071"]);
});
