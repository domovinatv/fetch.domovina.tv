/**
 * channel_settings_steps.js — ograda koraka koji proizvode AI artefakte (lanac „postavke kanala”).
 *
 * Svaki korak pita `lib/channel_settings.js` smije li za epizodu generirati svoj artefakt.
 * Ovdje je samo zajednička mapa korak → ključevi i jedna log linija po preskočenoj epizodi,
 * da svaka skripta doda dva-tri retka umjesto vlastite kopije logike.
 *
 * Pravila (odluka 8): postojeće datoteke ostaju, ništa se ne briše; preskočena epizoda NE
 * dobiva marker ni state (done cache, `.skipped.json`, blocked…), pa je idući run obradi čim
 * vlasnik ponovno uključi ključ. Ovisnosti (odluka 108) i fail-closed (nedostupan izvor =
 * preskoči sve) rješava `checkStep()` u `lib/channel_settings.js`.
 *
 * Gate se dohvaća lijeno: korak bez kandidata ne čita snimku i ne dohvaća katalog.
 */
"use strict";

const path = require("path");

/** Korak → ključevi koji SVI moraju biti uključeni. */
const STEP_KEYS = Object.freeze({
    summary: ["article_summary"],             // KORAK 7 summarize_gemini.js
    article: ["article_summary"],             // KORAK 8 generate_article_gemini.js
    words: ["transcript_subtitles"],          // KORAK 9.87 generate_words_json.js
    segments: ["transcript_subtitles"],       // KORAK 9 segments prolaz (prepare_rag_combined.js)
    english: ["english_translation"],         // translate_to_english.js, enqueue_en_new.js
    reels_en: ["english_translation", "highlights_reels"], // zakašnjeli reels.en.json
    magisterium: ["magisterium"],             // tools/magisterium_mcp_episode.js, enqueue_magisterium_backfill.js
    magisterium_en: ["magisterium", "english_translation"],
    reels: ["highlights_reels"],              // KORAK 9.9 select_reels.js
    reels_render: ["highlights_reels", "share_clips"], // render_reels.js (9:16 renderi)
    og_sections: ["share_clips"],             // KORAK 9.6 generate_og_sections.py
    ebook: ["ebook"],                         // KORAK 9.8 generate_ebook.js, tools/force_upload_epubs.js
    sponsors: ["sponsors_in_video"],          // KORAK 9.85 detect_sponsors.js
});

function keysFor(step) {
    const keys = STEP_KEYS[step];
    if (!keys) throw new Error(`nepoznat korak postavki kanala: ${step}`);
    return keys;
}

function resolveGate(opts) {
    return opts.gate || require("./channel_settings").gate();
}

/** `who` za `checkStep`: string = putanja datoteke epizode, inače objekt `{filePath|slug|uc|infoPath}`. */
function toWho(x) {
    return typeof x === "string" ? { filePath: x } : (x || {});
}

/** Prvi isključen ključ koraka → `{skip:true, reason}`, inače `{skip:false}`. */
function checkStepFor(step, who, opts = {}) {
    const gate = resolveGate(opts);
    for (const key of keysFor(step)) {
        const r = gate.checkStep({ key, ...toWho(who) });
        if (r.skip) return r;
    }
    return { skip: false };
}

function skipLine(reason, label) {
    return `⏭️ postavke kanala: ${reason}${label ? ` — ${label}` : ""}`;
}

function defaultLabel(who) {
    const w = toWho(who);
    if (w.filePath) return path.basename(w.filePath);
    return w.label || w.slug || w.uc || "";
}

/**
 * Za petlje koje odlučuju epizodu po epizodu: true = preskoči (i ispiše jednu liniju).
 * opts: {gate, log (null = tiho), label}
 */
function skipStep(step, who, opts = {}) {
    const r = checkStepFor(step, who, opts);
    if (!r.skip) return false;
    const log = opts.log === undefined ? console.log : opts.log;
    if (log) log(skipLine(r.reason, opts.label !== undefined ? opts.label : defaultLabel(who)));
    return true;
}

/**
 * Filtriraj listu kandidata. `whoOf(item)` → putanja ili `{filePath|slug|uc}` (default: item sam).
 * Prazna lista ne dira gate. Vraća novu listu (redoslijed sačuvan).
 */
function filterStep(step, items, opts = {}) {
    if (!Array.isArray(items) || items.length === 0) return items || [];
    keysFor(step);
    const gate = resolveGate(opts);
    const whoOf = opts.whoOf || ((x) => x);
    const labelOf = opts.labelOf || null;
    return items.filter((it) => {
        const who = whoOf(it);
        return !skipStep(step, who, { ...opts, gate, label: labelOf ? labelOf(it) : undefined });
    });
}

/**
 * Batch provjera za skripte izvan Nodea (generate_og_sections.py): putanje na stdinu (jedna po
 * retku) → stdout `{"skipped": {"<putanja>": "<razlog>"}}`. Jedan proces po kanalu umjesto
 * jednog po epizodi. Putanja ostaje doslovno kako je poslana (ključ za pozivatelja).
 */
function batchSkips(step, paths, opts = {}) {
    const skipped = {};
    for (const p of paths) {
        if (!p) continue;
        const r = checkStepFor(step, path.resolve(p), opts);
        if (r.skip) skipped[p] = r.reason;
    }
    return skipped;
}

module.exports = { STEP_KEYS, keysFor, checkStepFor, skipStep, filterStep, skipLine, batchSkips };

if (require.main === module) {
    // node lib/channel_settings_steps.js filter --step <korak>  < putanje
    const argv = process.argv.slice(2);
    const i = argv.indexOf("--step");
    const step = i !== -1 ? argv[i + 1] : null;
    if (argv[0] !== "filter" || !step || !STEP_KEYS[step]) {
        console.error(`Upotreba: node lib/channel_settings_steps.js filter --step <${Object.keys(STEP_KEYS).join("|")}> < putanje`);
        process.exit(1);
    }
    const paths = require("fs").readFileSync(0, "utf8").split("\n").map((x) => x.trim()).filter(Boolean);
    process.stdout.write(JSON.stringify({ skipped: paths.length ? batchSkips(step, paths) : {} }) + "\n");
}
