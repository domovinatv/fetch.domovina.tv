/**
 * protocol_parser.js — vađenje protokolarnih najava predsjedavajućeg.
 *
 * ═══ ⚠️ ISPRAVAK SPECIFIKACIJE `03_asr_and_protocol_parser.md` §3 ═══
 *
 * Specifikacija predlaže četiri regexa građena oko fraze **„riječ ima"** i oko
 * imena pisanog VELIKIM početnim slovom. Izmjereno nad stvarnim transkriptom
 * ove sjednice (20 h, 5513 redaka, `part_0N_16k.wav.canary.srt`):
 *
 *   „riječ ima"            →   **0 pogodaka**
 *   „sljedeći je na redu"  →   **0 pogodaka**
 *   „izvolite"             → 234 pogotka
 *   „kolega/kolegice/…"    → 514 pogodaka
 *
 * Predsjedavajući u praksi kaže **„Kolega Grmoja, izvolite."** — titula,
 * SAMO PREZIME, pa poziv. Specifikacijski regex traži dvije riječi velikim
 * slovom nakon „riječ ima" i ne bi uhvatio ništa.
 *
 * Druga greška specifikacije: zastavica `/iu` uz razred `[A-ZČĆŽŠĐ]`. Uz `i`
 * razred hvata i mala slova, pa „velikim slovom" ne znači ništa — regex bi
 * primao proizvoljne riječi.
 *
 * Zato ovaj parser NE oslanja se na velika slova (Canary ih u dugim,
 * nepunktuiranim odsječcima ionako gubi — mjereno: „kolega bulj izvolite
 * kolega kukavica…"). Postupak je:
 *
 *   1. nađi OKIDAČ (titula, „na redu je", „u ime Kluba", „povreda Poslovnika");
 *   2. uzmi 1–3 riječi iza njega, do zaustavne riječi ili interpunkcije;
 *   3. **registar je filtar** — kandidat prolazi samo ako ga `RosterMatcher`
 *      razriješi u zastupnika. Velika slova nisu dokaz, registar jest.
 */

"use strict";

/**
 * Rod koji nosi titula. „Kolegice/kolegica/zastupnica/zastupnice" su ženski
 * oblici; „kolega/kolegu/kolegi/zastupnik/zastupnika/zastupniku" muški.
 * (Muški vokativ je „zastupniče" s „č" — „zastupnice" je ženski.)
 * Služi samo za razbijanje izjednačenja u registru, vidi `roster_match.js`.
 */
function titleGender(word) {
    if (/^(kolegice|kolegica|zastupnice|zastupnica)$/u.test(word)) return "z";
    if (/^(kolega|kolegu|kolegi|zastupnik|zastupnika|zastupniku)$/u.test(word)) return "m";
    return null;
}

/** Riječi koje nikad nisu dio imena — zaustavljaju prikupljanje tokena. */
const STOPWORDS = new Set([
    "izvolite", "izvoli", "hvala", "zahvaljujem", "molim", "je", "su", "ste",
    "u", "i", "a", "ali", "za", "na", "sa", "s", "o", "od", "do", "kao", "pa",
    "će", "ćete", "govorit", "govoriti", "ima", "imate", "vi", "vas", "vam",
    "ovdje", "sada", "sad", "evo", "eto", "dakle", "to", "ta", "taj", "te",
    "ime", "kluba", "klub", "zastupnika", "nezavisnog", "poslovnika",
    "poslovnik", "replika", "repliku", "replike", "rasprava", "raspravu",
    "rasprave", "povreda", "povredu", "stanku", "stanka", "minuta", "minute",
    "prvi", "prva", "prvo", "drugi", "druga", "sljedeći", "sljedeća",
    "slijedeći", "slijedeća", "redu", "red", "kolega", "kolegica", "kolegice",
    "kolegu", "kolegi", "poštovani", "poštovana", "poštovane", "poštovanom",
    "uvaženi", "uvažena", "uvaženom", "gospodin", "gospođa", "gospodine",
    "gospođo", "predsjedniče", "predsjednik", "predsjedavajući", "ministrice",
    "ministar", "ministre", "ministrica", "nije", "ne", "da", "li", "jel",
    "opomenu", "opomena", "vrijeme", "vremena", "vaše", "vaš", "moja", "moj",
]);

/** Titule iza kojih slijedi ime. Redoslijed nebitan — traži se svaka pojava. */
const TITLE_RE =
    /\b(kolegice|kolegica|kolegu|kolegi|kolega|zastupnice|zastupnica|zastupniku|zastupnika|zastupnik)\b/giu;

/** Kontekst koji određuje VRSTU istupa koji se najavljuje. */
const CONTEXT_PATTERNS = [
    { type: "klub_rasprava", re: /u\s+ime\s+kluba/iu },
    { type: "povreda_poslovnika", re: /povred[au]\s+poslovnika/iu },
    { type: "replika", re: /\brepli(ka|ku|ke)\b/iu },
    { type: "stanka", re: /\bstank[au]\b/iu },
    { type: "pojedinacna_rasprava", re: /\bra(sprav|zprav)[aeiu]\b/iu },
];

/** Fraze koje same po sebi najavljuju sljedećeg govornika (bez titule). */
const ORDINAL_RE =
    /\b(?:prvi|prva|prvo|sljedeć[iaeu]|slijedeć[iaeu])\b[^.?!]{0,40}?\bna\s+redu\b/iu;

/**
 * Fraze kojima predsjedavajući poziva na govor — jak signal predaje riječi.
 *
 * Popis je IZMJEREN nad ovim transkriptom, ne pretpostavljen. Zadnjih pet
 * dodano je nakon slijepe provjere modelom (`tools/blind_speaker_check.js`),
 * koja je našla govornike koje sidrenje nije uhvatilo. Najskuplji propust:
 *
 *   „…pa onda ćemo sad **dati riječ** poštovanom zastupniku Josipu Boriću."
 *
 * — 31 minuta govora u 12 blokova ostalo je bezimeno jer „dati riječ" nije
 * bilo na popisu. Fraza se u 20 h pojavljuje samo jednom, pa je nijedno
 * brojanje učestalosti ne bi izdvojilo; našla ju je tek provjera po ishodu.
 */
const HANDOVER_RE = new RegExp(
    /\bizvolite\b|\bna\s+redu\b|\bgovorit\s+će\b|\bprelazimo\s+na\b|/.source +
    /\bda(?:ti|je|jem|o)\s+riječ\b|\briječ\s+(?:poštovanom|uvaženom|zastupni|predstavnic)|/.source +
    /\b(?:se\s+javio|javio\s+se)\b|\breplikuje\b|\bidemo\s+(?:na|dalje)\b|\bkrećemo\b/.source, "iu");

/**
 * Razbij tekst na riječi zadržavajući podatak je li iza riječi interpunkcija
 * koja prekida ime (zarez, točka, upitnik…).
 */
function tokenizeWithBreaks(text) {
    const out = [];
    const re = /([\p{L}][\p{L}\-']*)([^\p{L}]*)/gu;
    let m;
    while ((m = re.exec(text)) !== null) {
        out.push({ word: m[1], breaks: /[.,;:!?()]/.test(m[2] || "") });
    }
    return out;
}

/** Skupi do `maxWords` uzastopnih riječi koje mogu biti ime. */
function collectNameWords(tokens, startIdx, maxWords = 3) {
    const words = [];
    for (let i = startIdx; i < tokens.length && words.length < maxWords; i++) {
        const t = tokens[i];
        const lower = t.word.toLowerCase();
        if (STOPWORDS.has(lower)) break;
        if (t.word.length < 2) break;
        words.push(t.word);
        if (t.breaks) break;
    }
    return words;
}

/**
 * Razbij tekst na rečenice. Canary u dugim odsječcima gubi interpunkciju, pa
 * rečenica zna biti i cijeli blok — to je prihvatljivo, samo slabije suzuje.
 */
function splitSentences(text) {
    return String(text || "")
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Rečenica u kojoj predsjedavajući DOISTA predaje riječ — posljednja koja
 * sadrži poziv („izvolite", „na redu", „govorit će").
 *
 * ⚠️ Ovo je ograda koja je u mjerenju spasila najveću pogrešnu atribuciju.
 * Blok predsjedavajućeg zna biti dug i spominjati imena koja NISU primatelj
 * riječi:
 *
 *   „Kolega Marković, molim vas sjednite… Kolega Štromar, molim i vas isto
 *    tako… **Izvolite odgovor, ministrice.**"
 *
 * Bez ograde bi „Kolega Štromar" (posljednje ime u bloku) preuzeo identitet
 * ministričinog odgovora — i, jer je to bio jedini glas za tu oznaku, zalijepio
 * krivo ime na **87 minuta** govora kroz cijelu sjednicu. Sa ogradom rečenica
 * predaje ne sadrži ime i blok ispravno ostaje bez sidra.
 */
function handoverSentence(text) {
    const sentences = splitSentences(text);
    for (let i = sentences.length - 1; i >= 0; i--) {
        HANDOVER_RE.lastIndex = 0;
        if (HANDOVER_RE.test(sentences[i])) return sentences[i];
    }
    return null;
}

/** Uloge koje NISU u registru zastupnika (članovi Vlade, predstavnici). */
// `ministr\w*` namjerno hvata i ASR kvarove („ministricaice", izmjereno);
// „ministarstv…" je institucija, ne osoba, pa je izuzeto.
const NON_MP_ROLE_RE =
    /\bministar\b|\bministr(?!astv)\w*|\bpredstavnic\w*\s+vlade\b|\bpotpredsjednic\w*\s+vlade\b/iu;

/**
 * Blok predsjedavajućeg kraći od ovoga tretira se kao najava i onda kad nema
 * poziva („Kolega Miletić, povreda Poslovnika." — 4 riječi). Duži blok bez
 * poziva je ukor ili obrazloženje i ime u njemu NIJE primatelj riječi
 * („Kolegice Orešković, onda ne možete govoriti…" — 25 riječi).
 */
const MAX_SHORT_ANNOUNCEMENT_WORDS = 20;

/**
 * Nađi najavljena imena u jednom komadu teksta.
 *
 * @param {string} text
 * @param {{resolve:(s:string)=>{mp:object|null,score:number,reason:string}}} matcher
 * @param {{scopeToHandover?:boolean}} [opts] suzi na rečenicu predaje riječi
 * @returns {Array<{name:string, mp:object, score:number, speech_type:string, trigger:string}>}
 */
function findAnnouncements(text, matcher, opts = {}) {
    if (!text) return [];
    if (opts.scopeToHandover) {
        // Vrsta istupa uvijek se čita iz CIJELOG bloka („povreda Poslovnika"
        // često padne u prethodnu rečenicu), a ime samo iz rečenice predaje.
        const retype = (arr) => arr.map((a) => ({ ...a, speech_type: classify(text) }));
        const sentences = splitSentences(text);
        let k = -1;
        for (let i = sentences.length - 1; i >= 0; i--) {
            HANDOVER_RE.lastIndex = 0;
            if (HANDOVER_RE.test(sentences[i])) { k = i; break; }
        }
        if (k === -1) {
            // Nema poziva — prihvati samo kratki blok (vidi konstantu gore).
            const words = text.split(/\s+/).filter(Boolean).length;
            return words <= MAX_SHORT_ANNOUNCEMENT_WORDS ? retype(findAnnouncements(text, matcher)) : [];
        }
        const inHandover = findAnnouncements(sentences[k], matcher);
        if (inHandover.length) return retype(inHandover);
        // Riječ je predana ulozi izvan registra („Izvolite odgovor, ministrice.")
        // → sidra namjerno NEMA; ime iz ranije rečenice bilo bi krivo.
        if (NON_MP_ROLE_RE.test(sentences[k])) return [];
        // Golo „Izvolite." — ime je u rečenici NEPOSREDNO prije. Korak natrag
        // je točno jedan: dva bi već hvatala imena iz drugog konteksta.
        if (k > 0) return retype(findAnnouncements(sentences[k - 1], matcher));
        return [];
    }
    const tokens = tokenizeWithBreaks(text);
    if (!tokens.length) return [];
    const lower = tokens.map((t) => t.word.toLowerCase());

    // Pozicije okidača: titula, ili „…na redu" (rednim brojem).
    const triggers = [];
    for (let i = 0; i < lower.length; i++) {
        if (/^(kolegice|kolegica|kolegu|kolegi|kolega|zastupnice|zastupnica|zastupniku|zastupnika|zastupnik)$/u.test(lower[i])) {
            // „…Kluba zastupnika MOST-a i **nezavisnog zastupnika Josipa
            // Jurčevića**…" je NAZIV KLUBA, ne najava govornika. Bez ove
            // ograde svaki spomen tog kluba glasa za Jurčevića.
            if (i > 0 && /^nezavisn(og|e|ih|im)$/u.test(lower[i - 1])) continue;
            triggers.push({ idx: i + 1, trigger: lower[i], gender: titleGender(lower[i]) });
        }
    }
    if (ORDINAL_RE.test(text)) {
        const at = lower.findIndex((w, i) => w === "redu" && lower[i - 1] === "na");
        if (at >= 0) triggers.push({ idx: at + 1, trigger: "na redu", gender: null });
    }
    if (!triggers.length) return [];

    const speechType = classify(text);
    const seen = new Set();
    const found = [];
    for (const { idx, trigger, gender } of triggers) {
        const words = collectNameWords(tokens, idx);
        if (!words.length) continue;
        // Od najdužeg prozora prema kraćem, i uzima se PRVI koji se razriješi —
        // ne onaj s najvišim rezultatom. Kraći prozor je uvijek manje podataka,
        // pa mu viši rezultat ne znači veću sigurnost nego manju provjerljivost.
        let best = null;
        for (let n = words.length; n >= 1; n--) {
            const cand = words.slice(0, n).join(" ");
            const r = matcher.resolve(cand, { titleGender: gender });
            if (r.mp) { best = { name: cand, mp: r.mp, score: r.score }; break; }
        }
        if (!best) continue;
        if (seen.has(best.mp.id)) continue;
        seen.add(best.mp.id);
        found.push({ ...best, speech_type: speechType, trigger });
    }
    return found;
}

/** Vrsta istupa koja se najavljuje — prvi kontekst koji pogodi. */
function classify(text) {
    for (const { type, re } of CONTEXT_PATTERNS) {
        if (re.test(text)) return type;
    }
    return "rasprava";
}

/** Sadrži li tekst poziv na govor (predaja riječi)? */
function hasHandover(text) {
    HANDOVER_RE.lastIndex = 0;
    return HANDOVER_RE.test(text || "");
}

/**
 * Kad predsjedavajući preda riječ ULOZI koja nije u registru zastupnika
 * („Izvolite odgovor, ministrice."), vraća oznaku te uloge. Time govornik koji
 * je odgovarao 87 minuta ne ostaje bezimen NEPOZNAT nego bezimen ČLAN VLADE —
 * razlika koja se dalje može provjeriti, dok „null" ne može.
 */
function handoverRole(text) {
    const sent = handoverSentence(text);
    if (!sent) return null;
    return NON_MP_ROLE_RE.test(sent) ? "clan_vlade" : null;
}

module.exports = {
    findAnnouncements,
    titleGender,
    handoverSentence,
    handoverRole,
    splitSentences,
    hasHandover,
    classify,
    tokenizeWithBreaks,
    collectNameWords,
    STOPWORDS,
    TITLE_RE,
};
