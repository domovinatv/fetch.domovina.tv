"use strict";

/**
 * human_overrides.js — sloj LJUDSKIH ODLUKA o identitetu govornika.
 *
 * ⛔ Ljudska odluka se NIKAD ne piše preko `aligned_transcript.json`. Piše se u
 * zaseban `human_overrides.json`, a faza 03 ga pri svakom prolazu primijeni kao
 * sidro NAJVIŠEG prioriteta. Zbog toga run ostaje idempotentan: transkript se
 * uvijek može baciti i ponovno proizvesti, a ljudski rad preživi.
 *
 * Zašto ne upisati ime izravno u transkript:
 *   1. faza 03 se pokreće ponovno pri svakom popravku sidrenja — upis bi se
 *      izgubio, i to tiho;
 *   2. bez zasebnog sloja ne zna se ŠTO je stroj rekao a što čovjek, pa se
 *      kvaliteta protokolarnog imenovanja više ne može mjeriti;
 *   3. odluka bez `tko` i `kada` nije odluka nego anonimna izmjena podatka.
 *
 * ═══════════════════════ ODLUKE ═══════════════════════
 *
 *   imenuj    oznaci se pripisuje identitet (iz registra po `mp_id`, ili
 *             slobodnim imenom za osobe kojih u registru NEMA — predsjedatelj,
 *             članovi Vlade; §8 zaključka pilota)
 *   potvrdi   čovjek potvrđuje ono što je faza 03 već našla (bilježi se da je
 *             pregledano, pa oznaka ispada iz reda čekanja)
 *   odbaci    oznaka MORA ostati bezimena — protokolarno ime je promašaj, a
 *             točno se ne zna
 *   preskoci  pregledano, odluka odgođena; izlaz se ne mijenja
 *
 * ═══════════════════════ PRIORITET ═══════════════════════
 *
 * Ljudska odluka pobjeđuje glasove najava bez obzira na njihov broj. Pobjeđuje
 * i pravilo „jedan zastupnik = jedna oznaka" (03, pravilo 2): ako čovjek stavi
 * zastupnika X na oznaku A, a protokol ga je stavio na B, B ostaje bez imena.
 *
 * ⚠️ Dvije LJUDSKE odluke koje polažu pravo na istog zastupnika NE razrješavaju
 * se tiho. To je ili greška u pregledu ili tvrdnja da je faza 02b istu osobu
 * razdvojila na dvije oznake — a to je akustička tvrdnja koja se MJERI
 * (`tools/audit_merge_cohesion.py --cross A,B`), ne pretpostavlja. Zato takav
 * slučaj traži izričit `dopusti_dijeljenu_oznaku: true`; bez njega faza 03
 * pada s uputom umjesto da nasumice odabere pobjednika.
 */

const fs = require("fs");
const path = require("path");

const SCHEMA = 1;
const FILENAME = "human_overrides.json";
const ODLUKE = ["imenuj", "potvrdi", "odbaci", "preskoci"];
const ULOGE = ["zastupnik", "predsjedatelj", "clan_vlade", "govornik"];
/** Odluke koje mijenjaju izlaz faze 03 (ostale su samo trag pregleda). */
const ODLUKE_KOJE_MIJENJAJU = ["imenuj", "potvrdi", "odbaci"];

function overridesPath(sessionDir) {
    return path.join(sessionDir, FILENAME);
}

function emptyDoc(sessionId) {
    return { schema: SCHEMA, session_id: sessionId, overrides: {} };
}

/** Učitava sloj; nepostojanje datoteke je uredno stanje, ne greška. */
function load(sessionDir, sessionId = null) {
    const p = overridesPath(sessionDir);
    if (!fs.existsSync(p)) return emptyDoc(sessionId);
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    if (doc.schema !== SCHEMA) {
        throw new Error(`${FILENAME}: schema ${doc.schema}, očekivana ${SCHEMA}`);
    }
    if (!doc.overrides || typeof doc.overrides !== "object") {
        throw new Error(`${FILENAME}: nedostaje objekt "overrides"`);
    }
    return doc;
}

/** Atomičan upis — polupopunjen sloj bio bi gori od nikakvog. */
function save(sessionDir, doc) {
    const p = overridesPath(sessionDir);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, p);
    return p;
}

/**
 * Provjera jednog unosa. Vraća polje poruka o greškama (prazno = valjan).
 *
 * `mpById` je opcionalan: bez njega se `mp_id` ne provjerava protiv registra
 * (korisno u testovima), s njim nepostojeći `mp_id` pada odmah umjesto da
 * proizvede ime `undefined` tek u fazi 03.
 */
function validateEntry(speakerId, e, mpById = null) {
    const err = [];
    if (!/^SPEAKER_\d+$/.test(speakerId)) err.push(`oznaka "${speakerId}" nije oblika SPEAKER_NNN`);
    if (!e || typeof e !== "object") return [`${speakerId}: unos nije objekt`];
    if (!ODLUKE.includes(e.odluka)) {
        err.push(`${speakerId}: odluka "${e.odluka}" nije jedna od ${ODLUKE.join("|")}`);
    }
    if (e.odluka === "imenuj" || e.odluka === "potvrdi") {
        const imaMp = e.mp_id != null && e.mp_id !== "";
        const imaIme = typeof e.puno_ime === "string" && e.puno_ime.trim().length > 1;
        if (!imaMp && !imaIme) {
            err.push(`${speakerId}: "${e.odluka}" traži mp_id (iz registra) ili puno_ime (osoba izvan registra)`);
        }
        if (!imaMp && imaIme && !ULOGE.includes(e.uloga)) {
            // Osoba izvan registra nema ni stranku ni klub; jedino što je
            // nizvodno tipizira je uloga, pa bez nje unos nije upotrebljiv.
            err.push(`${speakerId}: ime izvan registra traži ulogu (${ULOGE.join("|")})`);
        }
        if (imaMp && mpById && !mpById.has(String(e.mp_id))) {
            err.push(`${speakerId}: mp_id ${e.mp_id} ne postoji u registru`);
        }
    }
    if (e.uloga != null && !ULOGE.includes(e.uloga)) {
        err.push(`${speakerId}: uloga "${e.uloga}" nije jedna od ${ULOGE.join("|")}`);
    }
    if (!e.odlucio || typeof e.odlucio !== "string") {
        err.push(`${speakerId}: nedostaje "odlucio" — odluka bez potpisa nije odluka`);
    }
    if (!e.odluceno_at || Number.isNaN(Date.parse(e.odluceno_at))) {
        err.push(`${speakerId}: "odluceno_at" nije valjan ISO datum`);
    }
    return err;
}

function validateDoc(doc, mpById = null) {
    const err = [];
    for (const [sid, e] of Object.entries(doc.overrides || {})) {
        err.push(...validateEntry(sid, e, mpById));
    }
    return err;
}

/**
 * Primjena sloja na mapu identiteta iz faze 03.
 *
 * `map` je izlaz `resolveIdentities()` — mijenja se NA MJESTU, jer faza 03 iz
 * njega odmah gradi blokove. Vraća izvještaj koji faza 03 ispisuje i zapisuje
 * u `speaker_map.json`, da se poslije zna što je odlučio čovjek a što stroj.
 *
 * Redoslijed je bitan:
 *   1. upisati sve ljudske odluke (pobjeđuju glasove);
 *   2. TEK ONDA skinuti ime protokolarnim oznakama koje polažu pravo na istog
 *      zastupnika — obrnutim redoslijedom čovjek bi izgubio od stroja.
 */
function apply(map, doc, mpById) {
    const applied = [];
    const dropped = [];
    const shared = [];
    const errors = [];

    const entries = Object.entries(doc.overrides || {})
        .filter(([, e]) => ODLUKE_KOJE_MIJENJAJU.includes(e.odluka));

    // ── 1. ljudske odluke ────────────────────────────────────────────────
    for (const [sid, e] of entries) {
        const prev = map[sid] || null;
        const base = prev || {
            votes: 0, votes_total: 0, confidence: null, competitors: [],
        };

        if (e.odluka === "odbaci") {
            map[sid] = {
                ...base,
                mp_id: null, puno_ime: null, stranka: null, klub: null,
                resolved: false,
                confidence_tier: "ljudska_odluka",
                identity_source: "covjek",
                human: humanTrail(e),
                dropped_reason: `ljudska odluka: ${e.razlog || "ime odbačeno bez zamjene"}`,
            };
            applied.push({ speaker: sid, odluka: e.odluka, ime: null, prije: prev && prev.puno_ime });
            continue;
        }

        const mp = e.mp_id != null && e.mp_id !== "" ? mpById.get(String(e.mp_id)) : null;
        const ime = mp ? mp.puno_ime : e.puno_ime;

        // ⚠️ AUTORSTVO NIJE ISTO ŠTO I PROVJERENOST.
        //
        // Prva verzija je svakoj ljudskoj odluci upisivala `identity_source:
        // "covjek"`. Nakon 64 POTVRDE imena koja je protokol već sam našao,
        // protokolarni udio imenovanog vremena pao je sa 66 % na 6 %, a
        // ljudski skočio na 73 % — mjera uvedena da razdvoji stroj i čovjeka
        // sama je sebe uništila prvim skupnim pregledom.
        //
        // Zato: ČOVJEK je izvor imena samo ako se identitet RAZLIKUJE od onoga
        // što je protokol razriješio za tu oznaku (uključujući slučaj kad
        // protokol nije razriješio ništa). Inače ime ostaje protokolarno, a
        // ljudski rad se bilježi kao `verified_by_human`.
        const istiKaoProtokol = !!(prev && prev.resolved) &&
            (mp ? prev.mp_id === mp.id : normIme(prev.puno_ime) === normIme(ime));

        map[sid] = {
            ...base,
            mp_id: mp ? mp.id : null,
            puno_ime: ime,
            stranka: mp ? mp.stranka : (e.stranka || null),
            klub: mp ? mp.klub : (e.klub || null),
            resolved: true,
            confidence: 1,
            confidence_tier: istiKaoProtokol ? (prev.confidence_tier || "visoka") : "ljudska_odluka",
            identity_source: istiKaoProtokol ? "protokol" : "covjek",
            verified_by_human: true,
            role_hint: e.uloga || (prev && prev.role_hint) || null,
            human: humanTrail(e),
        };
        delete map[sid].dropped_reason;
        applied.push({
            speaker: sid, odluka: e.odluka,
            ime: map[sid].puno_ime,
            prije: prev && prev.resolved ? prev.puno_ime : null,
            izvan_registra: !mp,
            // Je li odluka donijela NOVO ime ili potvrdila postojeće.
            novo_ime: map[sid].identity_source === "covjek",
        });
    }

    // ── 2. sukobi oko iste osobe ─────────────────────────────────────────
    const byPerson = new Map();   // ključ identiteta → [oznake]
    for (const [sid, v] of Object.entries(map)) {
        if (!v.resolved) continue;
        const key = v.mp_id != null ? `mp:${v.mp_id}` : `ime:${normIme(v.puno_ime)}`;
        if (!byPerson.has(key)) byPerson.set(key, []);
        byPerson.get(key).push(sid);
    }
    for (const [key, sids] of byPerson) {
        if (sids.length < 2) continue;
        // Za sukob je mjerodavno je li o oznaci ODLUČIO čovjek, a ne je li on
        // izvor imena — potvrđena oznaka i dalje nosi ljudsku odluku.
        const human = sids.filter((s) => map[s].human);
        if (human.length === 0) continue;   // čist protokolarni sukob — riješen u fazi 03

        if (human.length > 1) {
            const dopusteno = human.every((s) => doc.overrides[s].dopusti_dijeljenu_oznaku === true);
            if (!dopusteno) {
                errors.push(
                    `dvije ljudske odluke pripisuju istu osobu (${map[human[0]].puno_ime}) ` +
                    `oznakama ${human.join(" i ")}. Ako je faza 02b istu osobu RAZDVOJILA, ` +
                    `to je akustička tvrdnja i mjeri se:\n` +
                    `    python3 sabor_pipeline/tools/audit_merge_cohesion.py --session <id> ` +
                    `--cross ${human[0]},${human[1]}\n` +
                    `  pa oba unosa dobiju "dopusti_dijeljenu_oznaku": true. ` +
                    `Bez toga faza 03 ne bira nasumice.`
                );
                continue;
            }
            shared.push({ osoba: map[human[0]].puno_ime, oznake: human.slice() });
        }

        // Protokolarne oznake koje polažu pravo na istu osobu gube ime.
        for (const s of sids) {
            if (map[s].human) continue;   // ljudska odluka se ne skida
            dropped.push({ speaker: s, ime: map[s].puno_ime, u_korist: human[0] });
            map[s] = {
                ...map[s],
                mp_id: null, puno_ime: null, stranka: null, klub: null,
                resolved: false, confidence_tier: "nerazriješeno",
                dropped_reason: `ljudska odluka pripisala je ${key.startsWith("mp:") ? "tog zastupnika" : "tu osobu"} ` +
                                `oznaci ${human[0]}`,
            };
        }
    }

    // Sve što nije ljudsko nosi izričit trag da dolazi iz protokola.
    for (const v of Object.values(map)) {
        if (!v.identity_source) v.identity_source = "protokol";
    }

    return { applied, dropped, shared, errors };
}

function humanTrail(e) {
    return {
        odluka: e.odluka,
        odlucio: e.odlucio,
        odluceno_at: e.odluceno_at,
        razlog: e.razlog || null,
        dokaz: e.dokaz || null,
        izvor_prijedloga: e.izvor_prijedloga || null,
        dopusti_dijeljenu_oznaku: e.dopusti_dijeljenu_oznaku === true || undefined,
    };
}

function normIme(s) {
    // `đ` se NFD-om ne rastavlja, pa ide zasebno — inače „Đakić" i „Dakić"
    // ostaju različiti ključevi i isti čovjek prođe kao dvije osobe.
    return String(s || "").replace(/[đĐ]/g, "D")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toUpperCase().replace(/[^A-Z]+/g, " ").trim();
}

module.exports = {
    SCHEMA, FILENAME, ODLUKE, ULOGE, ODLUKE_KOJE_MIJENJAJU,
    overridesPath, emptyDoc, load, save,
    validateEntry, validateDoc, apply,
};
