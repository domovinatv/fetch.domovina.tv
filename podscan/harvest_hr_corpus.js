#!/usr/bin/env node
/**
 * KORAK 1 — izgradi LOKALNO zrcalo hrvatskog dijela Podscan baze.
 *
 * Zašto zrcalo, a ne 291 pojedinačnih upita: trial plan daje 100 zahtjeva/dan.
 * Provjera "je li ovaj kanal u Podscanu?" jedan-po-jedan potrošila bi tri dana
 * kvote i ne bi odgovorila na drugo, zanimljivije pitanje — koje hrvatske
 * podcaste Podscan ima, a MI nemamo. Zato jednom povučemo cijeli hr korpus
 * (~2-4k feedova, 50 po zahtjevu), a onda se sva analiza vrti lokalno i besplatno.
 *
 * Podscanov search NE prima prazan/wildcard upit ("*" se strippa), pa se korpus
 * gradi preko liste čestih hrvatskih riječi koje pogađaju naslov+opis. Svaki
 * termin je zaseban upit; unija je korpus. Skripta je RESUMABLE — pamti koje je
 * termine i stranice već obradila, pa se sutra nastavlja gdje je stala.
 *
 *   node podscan/harvest_hr_corpus.js                 # nastavi harvest
 *   node podscan/harvest_hr_corpus.js --max-requests 40
 *   node podscan/harvest_hr_corpus.js --status        # bez ijednog API poziva
 */

const fs = require("fs");
const path = require("path");
const { call, budgetStatus, REPO_ROOT } = require("./podscan_client");

const CORPUS_FILE = path.join(REPO_ROOT, "data", "podscan_hr_corpus.json");
const STATE_FILE = path.join(REPO_ROOT, "data", "podscan_harvest_state.json");
const PER_PAGE = 50;

// Termini poredani po očekivanom prinosu. Prvo generički (najveći zahvat),
// zatim tematski (repovi koje generički promaše).
const TERMS = [
    "podcast", "o", "se", "je", "u", "na", "za", "i", "s", "sve",
    "zivot", "svijet", "ljudi", "price", "razgovor", "emisija", "tema", "gost",
    "hrvatska", "zagreb", "split", "rijeka", "osijek", "domovina",
    "novi", "prvi", "kako", "sto", "vise", "godina", "tjedan", "dan",
    "vijesti", "politika", "sport", "glazba", "film", "knjiga", "kultura",
    "vjera", "bog", "crkva", "katolicki", "molitva", "evandelje",
    "biznis", "novac", "posao", "poduzetnik", "marketing", "tehnologija",
    "zdravlje", "obitelj", "ljubav", "psihologija", "mozak", "hrana",
    "povijest", "znanost", "obrazovanje", "putovanje", "priroda", "auto",
];

// Dvije osi: jezik i regija. Kanal može biti language=hr/region=ba,
// ili region=hr/language=en (npr. engleski showovi iz Hrvatske) — oboje nas zanima.
const AXES = [{ language: "hr" }, { region: "hr" }];

function getArg(name, def = null) {
    const i = process.argv.indexOf(name);
    return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const hasFlag = (n) => process.argv.includes(n);

function loadJson(p, def) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return def; }
}

function saveJson(p, obj) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

async function main() {
    const corpus = loadJson(CORPUS_FILE, { generated_at: null, podcasts: {} });
    const state = loadJson(STATE_FILE, { done: {}, totals: {} });

    if (hasFlag("--status")) {
        const n = Object.keys(corpus.podcasts).length;
        const jobs = [];
        for (const axis of AXES) for (const t of TERMS) jobs.push(`${JSON.stringify(axis)}|${t}`);
        const doneJobs = jobs.filter((k) => state.done[k] === "complete").length;
        console.log(`Korpus: ${n} podcasta`);
        console.log(`Termini: ${doneJobs}/${jobs.length} dovršeno`);
        console.log(`Kvota danas: ${JSON.stringify(budgetStatus())}`);
        return;
    }

    const maxRequests = parseInt(getArg("--max-requests", "0"), 10) || Infinity;
    let spent = 0;
    let added = 0;

    outer:
    for (const axis of AXES) {
        for (const term of TERMS) {
            const jobKey = `${JSON.stringify(axis)}|${term}`;
            if (state.done[jobKey] === "complete") continue;
            let page = state.done[jobKey] ? state.done[jobKey].nextPage : 1;

            while (true) {
                if (spent >= maxRequests) { console.log(`\n⏹  Dosegnut --max-requests (${maxRequests}).`); break outer; }
                let res;
                try {
                    res = await call("/podcasts/search", {
                        params: { query: term, per_page: PER_PAGE, page, ...axis },
                    });
                } catch (e) {
                    if (e.code === "BUDGET_EXHAUSTED") { console.log(`\n⏹  ${e.message}`); break outer; }
                    console.warn(`   ⚠️  ${term} str.${page}: ${e.message.slice(0, 140)}`);
                    state.done[jobKey] = "complete"; // ne zaglavi na trajno lošem terminu
                    break;
                }
                if (!res.cached) spent++;

                const list = res.data.podcasts || [];
                const pg = res.data.pagination || {};
                let newHere = 0;
                for (const p of list) {
                    if (!corpus.podcasts[p.podcast_id]) newHere++;
                    // _search_highlight je per-upit smeće, ne dio identiteta podcasta
                    delete p._search_highlight;
                    corpus.podcasts[p.podcast_id] = p;
                }
                added += newHere;
                state.totals[jobKey] = pg.total ?? null;

                const flag = res.cached ? "cache" : "api";
                console.log(
                    `${JSON.stringify(axis)} "${term}" str.${page}/${pg.last_page ?? "?"} ` +
                    `→ ${list.length} rez, +${newHere} novih (${flag}) | korpus=${Object.keys(corpus.podcasts).length}`
                );

                const last = pg.last_page || 1;
                if (page >= last || list.length === 0) { state.done[jobKey] = "complete"; break; }
                page++;
                state.done[jobKey] = { nextPage: page };

                // Snimaj usput — prekid (Ctrl+C, kvota) ne smije baciti posao.
                corpus.generated_at = new Date().toISOString();
                saveJson(CORPUS_FILE, corpus);
                saveJson(STATE_FILE, state);
            }
            corpus.generated_at = new Date().toISOString();
            saveJson(CORPUS_FILE, corpus);
            saveJson(STATE_FILE, state);
        }
    }

    corpus.generated_at = new Date().toISOString();
    saveJson(CORPUS_FILE, corpus);
    saveJson(STATE_FILE, state);

    console.log(`\n✅ Korpus: ${Object.keys(corpus.podcasts).length} podcasta (+${added} u ovom prolazu)`);
    console.log(`   API zahtjeva potrošeno: ${spent} | kvota: ${JSON.stringify(budgetStatus())}`);
    console.log(`   → ${path.relative(REPO_ROOT, CORPUS_FILE)}`);
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
