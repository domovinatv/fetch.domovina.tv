#!/usr/bin/env node
/**
 * KORAK 2 — dva pitanja, jedan izvještaj, NULA API poziva.
 *
 *  A) POKRIVENOST: koliki dio našeg registra (data/podcasts_registry.json)
 *     Podscan uopće ima? Marketinška tvrdnja je "4M+ podcasta, u bazi unutar
 *     10 min od objave" — ovo je provjerava na stvarnom, uskom, ne-engleskom skupu.
 *
 *  B) OTKRIVANJE (zanimljiviji smjer): koje hrvatske podcaste Podscan ima,
 *     a mi ih NEMAMO u registru? To su kandidati za širenje kataloga.
 *
 * Sve se računa iz lokalnog zrcala (data/podscan_hr_corpus.json), pa se
 * izvještaj smije vrtjeti koliko god puta bez trošenja kvote.
 *
 * VAŽNA OGRADA koju izvještaj ispisuje i sam: naš registar je YouTube-centričan,
 * a Podscan indeksira RSS feedove. Kanal koji postoji SAMO na YouTubeu nije
 * "rupa u Podscanu" — on po definiciji nije RSS podcast. Zato se pokrivenost
 * uvijek prikazuje dvostruko: nad cijelim registrom i nad podskupom koji
 * uopće ima šanse biti u RSS indeksu.
 *
 *   node podscan/coverage_report.js
 *   node podscan/coverage_report.js --json out.json --min-sim 0.72
 */

const fs = require("fs");
const path = require("path");
const M = require("./match_lib");

const REPO_ROOT = path.resolve(__dirname, "..");
const REGISTRY = path.join(REPO_ROOT, "data", "podcasts_registry.json");
const CORPUS = path.join(REPO_ROOT, "data", "podscan_hr_corpus.json");

function getArg(name, def = null) {
    const i = process.argv.indexOf(name);
    return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const MIN_SIM = parseFloat(getArg("--min-sim", "0.72"));

function loadJson(p) {
    if (!fs.existsSync(p)) {
        console.error(`❌ Nedostaje ${p}. Pokreni prvo: node podscan/harvest_hr_corpus.js`);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Indeks Podscan korpusa po normaliziranom imenu, core imenu i YouTube identitetu. */
function buildIndex(podcasts) {
    const byNorm = new Map(), byCore = new Map(), byYt = new Map();
    const push = (map, key, val) => {
        if (!key) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(val);
    };
    for (const p of podcasts) {
        push(byNorm, M.normalizeName(p.podcast_name), p);
        push(byCore, M.coreName(p.podcast_name), p);
        for (const u of M.podscanUrls(p)) {
            const id = M.ytIdentity(u);
            if (id) push(byYt, `${id.kind}:${id.value}`, p);
        }
    }
    return { byNorm, byCore, byYt };
}

function matchEntry(entry, idx, podcasts) {
    const name = entry.display_name || entry.slug;

    // 1. YouTube identitet — najjači dokaz: Podscan sam navodi naš kanal.
    const ytKeys = [];
    if (entry.youtube && entry.youtube.channel_id) ytKeys.push(`channel_id:${entry.youtube.channel_id}`);
    if (entry.youtube && entry.youtube.handle) ytKeys.push(`handle:${String(entry.youtube.handle).toLowerCase()}`);
    if (entry.youtube && entry.youtube.url) {
        const id = M.ytIdentity(entry.youtube.url);
        if (id) ytKeys.push(`${id.kind}:${id.value}`);
    }
    for (const k of ytKeys) {
        const hit = idx.byYt.get(k);
        if (hit && hit.length) return { confidence: "exact-youtube", via: k, podcast: hit[0], score: 1 };
    }

    // 2. Identično normalizirano ime.
    const hitN = idx.byNorm.get(M.normalizeName(name));
    if (hitN && hitN.length) return { confidence: "exact-name", via: "name", podcast: hitN[0], score: 1 };

    // 3. Identično core ime ("Bujica" ↔ "Bujica Podcast").
    const core = M.coreName(name);
    if (core && core.length >= 4) {
        const hitC = idx.byCore.get(core);
        if (hitC && hitC.length) return { confidence: "core-name", via: "core", podcast: hitC[0], score: 0.95 };
    }

    // 4. Fuzzy — najbolji trigram/token skor iznad praga, uvijek "za pregled".
    let best = null;
    for (const p of podcasts) {
        const s = Math.max(M.trigramSim(name, p.podcast_name), M.tokenJaccard(name, p.podcast_name));
        if (!best || s > best.score) best = { score: s, podcast: p };
    }
    if (best && best.score >= MIN_SIM) {
        return { confidence: "fuzzy", via: `sim=${best.score.toFixed(2)}`, podcast: best.podcast, score: best.score };
    }
    return { confidence: "none", via: null, podcast: null, score: best ? best.score : 0, nearest: best && best.podcast };
}

function main() {
    const registry = loadJson(REGISTRY);
    const corpusRaw = loadJson(CORPUS);
    const podcasts = Object.values(corpusRaw.podcasts || {}).map(M.normalizePodcast);
    const entries = registry.podcasts;

    console.log("═".repeat(78));
    console.log("PODSCAN.FM — POKRIVENOST REGISTRA I OTKRIVANJE NOVIH PODCASTA");
    console.log("═".repeat(78));
    console.log(`Registar : ${entries.length} kanala (v${registry.version})`);
    console.log(`Korpus   : ${podcasts.length} hrvatskih podcasta iz Podscana (zrcalo od ${corpusRaw.generated_at})`);
    console.log();

    const idx = buildIndex(podcasts);
    const matched = [];
    const unmatched = [];
    const usedPodscanIds = new Set();

    for (const e of entries) {
        const r = matchEntry(e, idx, podcasts);
        if (r.podcast) {
            usedPodscanIds.add(r.podcast.podcast_id);
            matched.push({ entry: e, ...r });
        } else {
            unmatched.push({ entry: e, ...r });
        }
    }

    // ── A) POKRIVENOST ────────────────────────────────────────────────────
    const byConf = {};
    for (const m of matched) byConf[m.confidence] = (byConf[m.confidence] || 0) + 1;
    const strong = matched.filter((m) => m.confidence !== "fuzzy").length;

    console.log("── A) POKRIVENOST REGISTRA ".padEnd(78, "─"));
    const pct = (n, d) => d ? ((n / d) * 100).toFixed(1) + "%" : "—";
    console.log(`Upareno (sve razine)      : ${matched.length}/${entries.length}  (${pct(matched.length, entries.length)})`);
    console.log(`  └ pouzdano (bez fuzzy)  : ${strong}/${entries.length}  (${pct(strong, entries.length)})`);
    for (const [k, v] of Object.entries(byConf)) console.log(`     • ${k.padEnd(16)} ${v}`);
    console.log(`Bez para                  : ${unmatched.length}`);
    console.log();

    console.log("   Ograda: registar je YouTube-katalog, Podscan je RSS-indeks.");
    console.log("   Kanal bez RSS feeda NIJE rupa u Podscanu — on nije audio-podcast.");
    console.log();

    // ── B) OTKRIVANJE ─────────────────────────────────────────────────────
    const known = new Set(entries.map((e) => M.coreName(e.display_name || e.slug)).filter(Boolean));
    const unknownToUs = podcasts
        .filter((p) => !usedPodscanIds.has(p.podcast_id))
        .filter((p) => !known.has(M.coreName(p.podcast_name)))
        .filter((p) => !p.is_duplicate);
    const spam = unknownToUs.filter((p) => M.isLikelySpam(p));
    const discoveries = unknownToUs
        .filter((p) => !M.isLikelySpam(p))
        .map((p) => ({
            name: p.podcast_name,
            podcast_id: p.podcast_id,
            rss_url: p.rss_url || null,
            language: p.language || null,
            region: p.region || null,
            episodes: p.episode_count || 0,
            last_posted_at: p.last_posted_at || null,
            // Chart unosi nemaju `is_active`; chartanje samo po sebi znači da je
            // show živ, pa se svježina izvodi iz datuma zadnje epizode.
            is_active: p.is_active !== undefined
                ? p.is_active
                : (p.last_posted_at ? (Date.now() - Date.parse(p.last_posted_at)) < 90 * 864e5 : false),
            audience: (p.reach && p.reach.audience_size) || p.audience_size || 0,
            url: p.podcast_url || null,
            source: p._source,
            chart_rank: p._chart_rank ?? null,
            description: (p.podcast_description || "").replace(/\s+/g, " ").slice(0, 160),
        }));

    // Rangiranje: aktivni prije mrtvih, pa po veličini publike i katalogu.
    const rank = (d) => (d.is_active ? 1e9 : 0) + (d.audience || 0) * 10 + Math.min(d.episodes || 0, 500);
    discoveries.sort((a, b) => rank(b) - rank(a));

    // Podscan ima duple feedove istog showa pod različitim podcast_id
    // (npr. isti podcast na dva hostinga). `is_duplicate` ih ne hvata sve, pa
    // dodatno stišćemo po normaliziranom imenu — zadržava se najbolje rangiran.
    const seenNames = new Set();
    const deduped = [];
    for (const d of discoveries) {
        const key = M.normalizeName(d.name);
        if (!key || seenNames.has(key)) continue;
        seenNames.add(key);
        deduped.push(d);
    }
    discoveries.length = 0;
    discoveries.push(...deduped);

    const active = discoveries.filter((d) => d.is_active);
    console.log("── B) PODCASTI KOJE PODSCAN IMA, A MI NEMAMO ".padEnd(78, "─"));
    console.log(`Ukupno kandidata: ${discoveries.length}   (aktivnih u zadnjih 90 dana: ${active.length})`);
    console.log(`Odbačeno kao smeće: ${spam.length} feedova označenih hr, a nisu hrvatski`);
    console.log(`   (kineske SEO/engagement farme — vidi match_lib.isLikelySpam)`);
    console.log();
    // Dva izvora, dvije razine povjerenja:
    //  • search  — filtriran po language/region=hr, dakle stvarno hrvatski
    //  • chart   — top lista ZA Hrvatsku, uključuje i strane showove
    const fromSearch = active.filter((d) => d.source !== "chart");
    const fromChart = active.filter((d) => d.source === "chart");

    console.log(`   TOP 25 HRVATSKIH (iz pretrage, jezik/regija = hr) — ${fromSearch.length} aktivnih:`);
    for (const d of fromSearch.slice(0, 25)) {
        console.log(`   • ${d.name}`);
        console.log(`     ${d.episodes || 0} ep | publika ~${d.audience} | zadnja ${String(d.last_posted_at).slice(0, 10)} | ${d.language}/${d.region}`);
        if (d.description) console.log(`     ${d.description}`);
    }
    console.log();
    console.log(`   TOP 25 S HRVATSKIH CHART LISTA — ${fromChart.length} aktivnih:`);
    console.log("   ⚠️  Chart = 'sluša se u Hrvatskoj', NE 'hrvatski podcast'.");
    console.log("      Jezik nije poznat iz chart odgovora — treba ručna trijaža.");
    for (const d of fromChart.slice(0, 25)) {
        console.log(`   • [#${d.chart_rank ?? "?"}] ${d.name} — ${d.episodes || 0} ep, zadnja ${String(d.last_posted_at).slice(0, 10)}`);
    }
    console.log();

    // ── D) PROVJERA MARKETINŠKE TVRDNJE ───────────────────────────────────
    // Podscan tvrdi: 4M+ podcasta, epizoda u bazi "unutar 10 minuta od objave".
    // Prvi dio je lako provjeriti (/stats), drugi nije — ali postoji dobar
    // posrednik: koliko epizoda podcasta Podscan STVARNO ima u bazi
    // (`episodes_in_database`) naspram koliko ih feed prijavljuje
    // (`episode_count`). Feed koji je "u bazi" s 0 obrađenih epizoda je
    // katalogiziran, ali ne i indeksiran — a to je razlika koju marketing briše.
    const withCounts = matched.filter((m) => typeof m.podcast.episode_count === "number");
    const zeroIngested = withCounts.filter((m) => !m.podcast.episodes_in_database);
    const fullyIngested = withCounts.filter(
        (m) => m.podcast.episodes_in_database >= m.podcast.episode_count && m.podcast.episode_count > 0
    );
    const totalDeclared = withCounts.reduce((a, m) => a + (m.podcast.episode_count || 0), 0);
    const totalIngested = withCounts.reduce((a, m) => a + (m.podcast.episodes_in_database || 0), 0);
    // Aktivnost mjerimo SAMO nad feedovima iz pretrage — chart odgovor ne nosi
    // `is_active`, pa bi ih ubrajanje sve proglasilo mrtvima i napuhalo brojku.
    const searchSourced = podcasts.filter((p) => p.is_active !== undefined);
    const staleCorpus = searchSourced.filter((p) => !p.is_active).length;

    console.log("── D) 'U BAZI UNUTAR 10 MIN' — PROVJERA ".padEnd(78, "─"));
    console.log(`Naši upareni podcasti          : ${withCounts.length}`);
    console.log(`  └ s 0 obrađenih epizoda      : ${zeroIngested.length}  (${pct(zeroIngested.length, withCounts.length)})`);
    console.log(`  └ potpuno obrađenih          : ${fullyIngested.length}  (${pct(fullyIngested.length, withCounts.length)})`);
    console.log(`Epizoda: feed prijavljuje ${totalDeclared}, Podscan obradio ${totalIngested}  (${pct(totalIngested, totalDeclared)})`);
    console.log(`hr feedovi iz pretrage: ${staleCorpus}/${searchSourced.length} neaktivno (${pct(staleCorpus, searchSourced.length)})`);
    console.log();
    if (zeroIngested.length) {
        console.log("   Katalogizirani, ali bez ijedne obrađene epizode:");
        for (const m of zeroIngested.slice(0, 15)) {
            console.log(`   • ${m.entry.display_name} → \"${m.podcast.podcast_name}\" (feed kaže ${m.podcast.episode_count} ep, zadnja ${String(m.podcast.last_posted_at).slice(0, 10)})`);
        }
        console.log();
    }

    // ── Nedostaju u Podscanu, a IMAJU feed ────────────────────────────────
    const suggestable = unmatched
        .filter((u) => u.entry.platforms || u.entry.source)
        .map((u) => u.entry.slug);
    console.log("── C) NAŠI KANALI BEZ PARA U PODSCANU ".padEnd(78, "─"));
    console.log(`   ${unmatched.length} kanala. Podskup s poznatim ne-YouTube feedom: ${suggestable.length}`);
    console.log("   (Prijedlog Podscanu traži RSS URL — vidi podscan/suggest_missing.js)");
    console.log();

    // Trijažni popis — NE ubacuje se automatski u registar. Registar je
    // trosloj s ljudskom odlukom; ovo je samo ulaz za tu odluku.
    const candPath = getArg("--candidates");
    if (candPath) {
        const lines = [
            "# Podscan kandidati za registar — za ručnu trijažu",
            "",
            `Generirano: ${new Date().toISOString().slice(0, 10)} · izvor: data/podscan_hr_corpus.json`,
            "",
            "Filtar: `language`/`region` = hr, aktivan u zadnjih 90 dana, nije u registru,",
            "nije prepoznat kao spam feed. **Ne ubacuj automatski** — provjeri svaki red.",
            "",
            "| # | Naziv | Ep. | Zadnja | Publika | RSS |",
            "|---|---|-----|--------|---------|-----|",
        ];
        fromSearch.forEach((d, i) => {
            // Ime se smije skratiti, RSS NE — skraćen feed URL je neupotrebljiv
            // i tiho pokvari suggest_missing.js koji čita ovaj popis.
            const esc = (t) => String(t || "").replace(/\|/g, "\\|");
            lines.push(`| ${i + 1} | ${esc(d.name).slice(0, 70)} | ${d.episodes} | ${String(d.last_posted_at).slice(0, 10)} | ${d.audience} | ${esc(d.rss_url)} |`);
        });
        lines.push("", "## Chart lista (sluša se u Hrvatskoj — uključuje strane showove)", "");
        lines.push("| Rang | Naziv | Ep. | Zadnja |", "|---|---|---|---|");
        fromChart.slice(0, 60).forEach((d) => {
            lines.push(`| ${d.chart_rank ?? "?"} | ${String(d.name).replace(/\|/g, "\\|")} | ${d.episodes} | ${String(d.last_posted_at).slice(0, 10)} |`);
        });
        fs.writeFileSync(candPath, lines.join("\n") + "\n");
        console.log(`📄 Trijažni popis → ${candPath}`);
    }

    const outPath = getArg("--json");
    const payload = {
        generated_at: new Date().toISOString(),
        corpus_generated_at: corpusRaw.generated_at,
        registry_count: entries.length,
        corpus_count: podcasts.length,
        coverage: {
            matched: matched.length,
            matched_strong: strong,
            unmatched: unmatched.length,
            by_confidence: byConf,
        },
        matched: matched.map((m) => ({
            slug: m.entry.slug,
            display_name: m.entry.display_name,
            confidence: m.confidence,
            via: m.via,
            podscan_id: m.podcast.podcast_id,
            podscan_name: m.podcast.podcast_name,
            rss_url: m.podcast.rss_url,
            last_posted_at: m.podcast.last_posted_at,
            episodes_in_database: m.podcast.episodes_in_database,
            episode_count: m.podcast.episode_count,
        })),
        unmatched: unmatched.map((u) => ({
            slug: u.entry.slug,
            display_name: u.entry.display_name,
            youtube_url: u.entry.youtube && u.entry.youtube.url,
            tracking_enabled: u.entry.tracking && u.entry.tracking.enabled,
            nearest_podscan: u.nearest ? u.nearest.podcast_name : null,
            nearest_score: Number(u.score.toFixed(3)),
        })),
        discoveries,
        spam_feeds: spam.map((p) => ({ name: p.podcast_name, podcast_id: p.podcast_id, reason: M.isLikelySpam(p) })),
        ingestion_check: {
            matched_with_counts: withCounts.length,
            zero_ingested: zeroIngested.length,
            fully_ingested: fullyIngested.length,
            episodes_declared: totalDeclared,
            episodes_ingested: totalIngested,
            corpus_inactive: staleCorpus,
            corpus_search_sourced: searchSourced.length,
            corpus_total: podcasts.length,
        },
    };
    if (outPath) {
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
        console.log(`📄 JSON izvještaj → ${outPath}`);
    }
}

main();
