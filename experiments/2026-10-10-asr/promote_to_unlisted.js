#!/usr/bin/env node
// Promocija eksperimenta u produkcijske datoteke, u dva načina.
//
// 1) POBJEDNIK → storage/output/_unlisted/ (default). Nightly ga dovrši (screenshotovi, EPUB,
//    words.json, sponzori, RAG, R2, episode.json) i vidi se na domovina.ai/v/<ID> (neindeksirano).
//    Default varijanta = pobjednik slijepe ocjene 15.10. (README §4. krug): prijepis Canary +
//    pyannote + Gemini sluh (agy), članak Opus 5.5. Epizode koje već postoje na produkciji
//    (kanalski dir ili _unlisted) se PRESKAČU — to je ponovna obrada (admin 🔁).
//
// 2) VARIJANTE (--variants) → VAR_DIR/_varijante/, izvan storage/output, pa ih nightly i RAG
//    nikad ne vide (inače bi ista epizoda ušla 4–5 puta u pretragu). Sintetički ID ima 11 znakova
//    kao i svaki drugi (regex {11} u ~20 skripti): prvih 9 znakova pravog ID-a + `_<n>`, npr.
//    OspwepfLObY → OspwepfLO_2. info.json nosi `_variant_of` (pravi ID: player, thumbnail i
//    screenshotovi idu iz izvornog videa) i `_variant`. Objava: run_variants.sh (screenshotovi,
//    words.json, upload_to_r2 → data/<ID_n>/ + episode.json).
//
//   node experiments/2026-10-10-asr/promote_to_unlisted.js [--commit] [--id X,Y]
//   node experiments/2026-10-10-asr/promote_to_unlisted.js --variants [--commit] [--only 2,3]
//
// Postojeće datoteke se nikad ne prepisuju; eksperiment se samo čita.
"use strict";
const fs = require("fs"), path = require("path");

const EXP = __dirname, REPO = path.resolve(EXP, "../..");
const OUT = path.join(EXP, "data/output"), PROD = path.join(REPO, "storage/output");
const UNLISTED = path.join(PROD, "_unlisted");
const VAR_DIR = path.join(fs.realpathSync(path.join(EXP, "data")), "varijante", "_varijante");
const TAG = "exp-20261010";
const args = process.argv.slice(2);
function getArg(name, def = null) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : def;
}
const COMMIT = args.includes("--commit");
const VARIANTS_MODE = args.includes("--variants");
const IDS = (getArg("--id") || "").split(",").filter(Boolean);
const ONLY = (getArg("--only") || "").split(",").filter(Boolean).map(Number);
const SLUH = "canary-1b-v2+pyannote-c1+agy-gemini-3-8-flash";

// Brojevi su STALNI po kombinaciji (isti broj = ista varijanta u svakoj epizodi), poredak po
// prosjeku slijepe ocjene. _1 postoji samo za epizode čiji izvorni ID drži produkcijski članak.
const VARIANTS = [
    { n: 1, srt: SLUH, art: SLUH, model: "opus-5-5", label: "Canary + pyannote + Gemini sluh → Opus", onlyIfPublished: true },
    { n: 2, srt: "canary-1b-v2+pyannote-c1", art: "canary-1b-v2+pyannote-c1", model: "opus-5-5", label: "Canary + pyannote → Opus" },
    { n: 3, srt: "speechmatics-enhanced", art: "speechmatics-enhanced", model: "opus-5-5", label: "Speechmatics → Opus" },
    { n: 4, srt: "deepgram-nova3", art: "deepgram-nova3", model: "opus-5-5", label: "Deepgram Nova-3 → Opus" },
    { n: 5, srt: SLUH, art: SLUH, model: "agy-gemini-3-8-flash", label: "Canary + pyannote + Gemini sluh → Gemini 3.8 Flash (agy)" },
];
// riječi po ASR-u (vremena za titl); sluh mijenja tekst, ne vremena → Canary riječi
const WORDS_OF = { [SLUH]: "canary-1b-v2", "canary-1b-v2+pyannote-c1": "canary-1b-v2",
                   "speechmatics-enhanced": "speechmatics-enhanced", "deepgram-nova3": "deepgram-nova3" };
// slug u imenu članka: goli alias kao u produkciji (dedup bira leksikografski najveći _{date}_{model})
const SLUG_OF = { "opus-5-5": "opus", "agy-gemini-3-8-flash": "agy" };

const rows = fs.readFileSync(path.join(EXP, "bases.tsv"), "utf-8").trim().split("\n").slice(1).map(l => l.split("\t"));
const onProd = (id, kanal) => [path.join(PROD, kanal), UNLISTED]
    .filter(d => fs.existsSync(d) && fs.readdirSync(d).some(n => n.includes(`_yt_${id}.`)))
    .map(d => path.relative(PROD, d));

const write = (p, data) => { if (fs.existsSync(p)) throw new Error(`postoji, ne prepisujem: ${p}`); if (COMMIT) fs.writeFileSync(p, data); };
const copy = (from, to) => { if (fs.existsSync(to)) throw new Error(`postoji, ne prepisujem: ${to}`); if (COMMIT) fs.copyFileSync(from, to); };

// Zapiše jednu epizodu u produkcijskom obliku. Vraća popis datoteka ili null (s razlogom u logu).
function emit({ id, kanal, base }, v, dstDir, outId, variant) {
    const src = path.join(OUT, kanal);
    const f = (suffix) => path.join(src, `${base}.${suffix}`);
    // 2 referentne epizode imaju metapodatke samo u produkcijskom kanalskom diru (samo čitanje)
    const meta = (suffix) => [f(suffix), path.join(PROD, kanal, `${base}.${suffix}`)].find(p => fs.existsSync(p)) || f(suffix);
    const sumP = f(`${TAG}.${v.art}.${v.model}.sazetak.json`), artP = f(`${TAG}.${v.art}.${v.model}.clanak.json`);
    const srtP = f(`${TAG}.${v.srt}.dijariziran.srt`), infoP = meta("info.json"), descP = meta("description");
    const missing = [sumP, artP, srtP, infoP].filter(p => !fs.existsSync(p));
    if (missing.length) return console.log(`⚠️  ${outId}: nedostaje ${missing.map(p => path.basename(p).replace(base + ".", "")).join(", ")}`), null;
    const a = JSON.parse(fs.readFileSync(artP, "utf-8"));
    if (!a.metadata.complete) return console.log(`⚠️  ${outId}: članak nije kompletan`), null;

    const outBase = outId === id ? base : base.replace(new RegExp(`_yt_${id.replace(/[-]/g, "\\-")}$`), `_yt_${outId}`);
    if (fs.existsSync(path.join(dstDir, `${outBase}.info.json`))) return console.log(`⏭  ${outId}: već postoji`), null;
    const info = JSON.parse(fs.readFileSync(infoP, "utf-8"));
    const slug = SLUG_OF[v.model];
    const date = a.metadata.generated_at.slice(0, 10);
    const artBase = `${outBase}.wav.canary.diarized_${date}_${slug}`;
    const prov = { experiment: TAG, srt_input: v.srt, article_input: v.art, article_model: v.model,
                   note: "promovirano iz experiments/2026-10-10-asr (slijepa ocjena 15.10.2026.)" };
    const out = [];

    // 1. metapodaci (varijanta: sintetički id + _variant_of; naslov nosi oznaku varijante)
    if (variant) {
        Object.assign(info, { id: outId, title: `${info.title} · varijanta ${v.n}: ${v.label}`,
                              _variant_of: id, _variant: { n: v.n, label: v.label, ...prov } });
        write(path.join(dstDir, `${outBase}.info.json`), JSON.stringify(info, null, 2));
    } else copy(infoP, path.join(dstDir, `${outBase}.info.json`));
    out.push("info");
    if (fs.existsSync(descP)) { copy(descP, path.join(dstDir, `${outBase}.description`)); out.push("description"); }
    copy(srtP, path.join(dstDir, `${outBase}.wav.canary.diarized.srt`)); out.push(`srt:${v.srt}`);
    if (!variant && fs.existsSync(f(`${TAG}.canary-1b-v2.prijepis.srt`))) {
        copy(f(`${TAG}.canary-1b-v2.prijepis.srt`), path.join(dstDir, `${outBase}.wav.canary.srt`)); out.push("canary.srt");
    }
    // vremena riječi (KORAK 9.87): eksperiment [s, s, tekst(, govornik, lijepi_na_prethodnu)] → produkcija {v:1, words:[ms, ms, tekst]}
    const wts = f(`${TAG}.${WORDS_OF[v.srt]}.rijeci.json`);
    if (fs.existsSync(wts)) {
        const words = [];
        for (const w of JSON.parse(fs.readFileSync(wts, "utf-8")).words) {
            if (w[4] && words.length) { words[words.length - 1][2] += w[2]; words[words.length - 1][1] = Math.round(w[1] * 1000); continue; }
            words.push([Math.round(w[0] * 1000), Math.round(w[1] * 1000), w[2]]);
        }
        write(path.join(dstDir, `${outBase}.wav.canary.word_ts.json`), JSON.stringify({ v: 1, source: WORDS_OF[v.srt].split("-")[0], words }));
        out.push(`riječi:${WORDS_OF[v.srt]}`);
    }

    // 2. sažetak u produkcijskom omotu (summarize_gemini.js)
    const s = JSON.parse(fs.readFileSync(sumP, "utf-8"));
    const summary = variant ? { ...s.summary, title_hr: `${s.summary.title_hr} · varijanta ${v.n}` } : s.summary;
    write(path.join(dstDir, `${outBase}.wav.canary.summary.json`), JSON.stringify({
        version: "1.0", generated_at: s.metadata.generated_at, model: slug,
        source: { filename: `${outBase}.wav.canary.diarized.srt`, channel: path.basename(dstDir), youtube_id: outId, title: info.title,
                  upload_date: info.upload_date, duration_seconds: info.duration, platform: "youtube",
                  source_url: info.webpage_url || `https://www.youtube.com/watch?v=${id}` },
        provenance: prov, summary }, null, 2));
    out.push("sažetak");

    // 3. outline + članak (generate_article_gemini.js: outline je zasebna datoteka)
    write(path.join(dstDir, `${artBase}.outline.json`), JSON.stringify(a.metadata.outline, null, 2));
    write(path.join(dstDir, `${artBase}.article.json`), JSON.stringify({
        metadata: { source_file: `${outBase}.wav.canary.diarized.srt`, generated_at: a.metadata.generated_at, model: slug,
                    model_id: a.metadata.model_id, strict_attribution: a.metadata.strict_attribution,
                    iterations_expected: a.metadata.iterations_expected, complete: true, provenance: prov },
        iterations: a.iterations.map(({ iteration_number, start_time, end_time, theme, sections }) =>
            ({ iteration_number, start_time, end_time, theme, sections })) }, null, 2));
    out.push(`članak:${v.model}`);
    return out;
}

let done = 0, skipped = 0;
if (VARIANTS_MODE && COMMIT) fs.mkdirSync(VAR_DIR, { recursive: true });
for (const row of rows) {
    const [id, kanal] = row;
    if (IDS.length && !IDS.includes(id)) continue;
    const ep = { id, kanal, base: row[2] };
    if (!VARIANTS_MODE) {
        const hits = onProd(id, kanal);
        if (hits.length) { console.log(`⏭  ${id} (${kanal}): već postoji u ${hits.join(", ")} — preskačem (ponovna obrada = admin 🔁)`); skipped++; continue; }
        const out = emit(ep, VARIANTS[0], UNLISTED, id, false);
        if (out) { done++; console.log(`${COMMIT ? "✅" : "▶ "} ${id} (${kanal}) → _unlisted  [${out.join(", ")}]`); } else skipped++;
        continue;
    }
    // izvorni ID drži produkcijski članak (objavljen prije eksperimenta) → pobjednik ide kao _1
    const published = onProd(id, kanal).some(d => d !== "_unlisted");
    for (const v of VARIANTS) {
        if (ONLY.length && !ONLY.includes(v.n)) continue;
        if (v.onlyIfPublished && !published) continue;
        const outId = `${id.slice(0, 9)}_${v.n}`;
        const out = emit(ep, v, VAR_DIR, outId, true);
        if (out) { done++; console.log(`${COMMIT ? "✅" : "▶ "} ${outId} ← ${id} v${v.n}  [${out.join(", ")}]`); } else skipped++;
    }
}
console.log(`\n${COMMIT ? "zapisano" : "SUHO (bez --commit ništa nije zapisano)"}: ${done}, preskočeno ${skipped}` +
    (VARIANTS_MODE ? ` → ${VAR_DIR}` : ""));
if (done && COMMIT && !VARIANTS_MODE) console.log("Dovršava ih nightly (03:00): screenshotovi, EPUB, words.json, sponzori, RAG, R2, episode.json → domovina.ai/v/<ID>");
if (done && COMMIT && VARIANTS_MODE) console.log("Objava: experiments/2026-10-10-asr/run_variants.sh");
