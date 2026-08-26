#!/usr/bin/env node
/**
 * KORAK 1b — chartovi kao kvalitetniji izvor otkrivanja od full-text pretrage.
 *
 * `harvest_hr_corpus.js` gradi širinu (unija upita po čestim riječima), ali
 * povlači i sav dugi rep: mrtve feedove i kineske SEO farme krivo označene kao
 * `hr`. Chartovi rade suprotno — Apple/Spotify top liste za Hrvatsku daju
 * **rangirane, žive** showove. Za pitanje "koje podcaste bismo trebali imati"
 * to je bolji signal uz drastično manji trošak kvote:
 *
 *   /charts/countries/hr           → top 10 po kategoriji × platforma  ≈ 1 poziv
 *   /charts/countries/hr/trending  → novi i rastući showovi            ≈ 1 poziv
 *
 * Rezultat se ulijeva u ISTO zrcalo (data/podscan_hr_corpus.json) pod ključem
 * `podcast_id`, uz oznaku `_chart_rank` — pa `coverage_report.js` ne mora znati
 * odakle je koji feed došao.
 *
 *   node podscan/harvest_hr_charts.js
 *   node podscan/harvest_hr_charts.js --country hr --country ba
 */

const fs = require("fs");
const path = require("path");
const { call, budgetStatus, REPO_ROOT } = require("./podscan_client");

const CORPUS_FILE = path.join(REPO_ROOT, "data", "podscan_hr_corpus.json");

function countries() {
    const out = [];
    process.argv.forEach((a, i) => { if (a === "--country") out.push(process.argv[i + 1]); });
    return out.length ? out : ["hr"];
}

function loadCorpus() {
    try { return JSON.parse(fs.readFileSync(CORPUS_FILE, "utf8")); }
    catch (_) { return { generated_at: null, podcasts: {} }; }
}

/**
 * Chart odgovor gnijezdi showove nekoliko razina duboko i oblik se razlikuje
 * po platformi/kategoriji. Umjesto da pogađamo shemu, rekurzivno pokupimo
 * svaki objekt koji ima `podcast_id` — otporno na promjene u strukturi.
 */
function collectShows(node, out = [], ctx = {}) {
    if (Array.isArray(node)) {
        for (const n of node) collectShows(n, out, ctx);
        return out;
    }
    if (!node || typeof node !== "object") return out;
    if (node.podcast_id || (node.podcast && node.podcast.podcast_id)) {
        const p = node.podcast_id ? node : node.podcast;
        out.push({ podcast: p, rank: node.rank ?? null, ...ctx });
    }
    for (const [k, v] of Object.entries(node)) {
        if (v && typeof v === "object") {
            const nextCtx = { ...ctx };
            if (["spotify", "apple", "itunes"].includes(k)) nextCtx.platform = k;
            else if (typeof v === "object" && !Array.isArray(v) && !v.podcast_id) nextCtx.bucket = ctx.bucket || k;
            collectShows(v, out, nextCtx);
        }
    }
    return out;
}

async function main() {
    const corpus = loadCorpus();
    let added = 0, seen = 0;

    for (const cc of countries()) {
        for (const ep of [`/charts/countries/${cc}`, `/charts/countries/${cc}/trending`]) {
            let res;
            try {
                // Chartovi se mijenjaju dnevno — cache vrijedi 12 h, ne zauvijek.
                res = await call(ep, { maxAge: 12 * 3600 });
            } catch (e) {
                if (e.code === "BUDGET_EXHAUSTED") { console.log(`⏹  ${e.message}`); return; }
                console.warn(`⚠️  ${ep}: ${e.message.slice(0, 160)}`);
                continue;
            }
            const shows = collectShows(res.data);
            seen += shows.length;
            for (const s of shows) {
                const p = s.podcast;
                if (!p || !p.podcast_id) continue;
                const existing = corpus.podcasts[p.podcast_id];
                if (!existing) added++;
                corpus.podcasts[p.podcast_id] = {
                    ...(existing || {}),
                    ...p,
                    _chart_rank: s.rank,
                    _chart_source: `${cc}:${ep.endsWith("trending") ? "trending" : "top"}`,
                };
            }
            console.log(`${ep} → ${shows.length} showova (${res.cached ? "cache" : "api"}), korpus=${Object.keys(corpus.podcasts).length}`);
        }
    }

    corpus.generated_at = new Date().toISOString();
    fs.writeFileSync(CORPUS_FILE, JSON.stringify(corpus, null, 2));
    console.log(`\n✅ Chart unosa: ${seen}, novih u korpusu: ${added} | kvota: ${JSON.stringify(budgetStatus())}`);
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
