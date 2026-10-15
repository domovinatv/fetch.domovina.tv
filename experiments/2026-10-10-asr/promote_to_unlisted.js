#!/usr/bin/env node
// Promocija pobjedničke varijante eksperimenta u produkcijski dataset (storage/output/_unlisted/),
// da je nightly dovrši (screenshotovi, EPUB, words.json, sponzori, RAG, R2, episode.json) i da se
// vidi na domovina.ai/v/<ID>. _unlisted = neindeksirano (nema na naslovnici ni stranici kanala).
//
//   node experiments/2026-10-10-asr/promote_to_unlisted.js              # suho: što bi napravio
//   node experiments/2026-10-10-asr/promote_to_unlisted.js --commit     # zapiši
//   ... --id X,Y   --article-input <ulaz> --article-model opus-5-5 --slug opus
//
// Default varijanta = pobjednik slijepe ocjene 15.10. (README §4. krug): prijepis Canary + pyannote
// + Gemini sluh (agy), članak Opus 5.5. Epizode koje već postoje na produkciji (u kanalskom diru ili
// u _unlisted) se PRESKAČU — to je ponovna obrada objavljene epizode i ide kroz admin 🔁
// (docs/2026-10-09-ponovna-obrada-epizode.md), ne kroz ovu skriptu. Postojeće datoteke se nikad
// ne prepisuju; eksperiment se samo čita.
"use strict";
const fs = require("fs"), path = require("path");

const EXP = __dirname, REPO = path.resolve(EXP, "../..");
const OUT = path.join(EXP, "data/output"), PROD = path.join(REPO, "storage/output");
const DST = path.join(PROD, "_unlisted");
const TAG = "exp-20261010";
const args = process.argv.slice(2);
function getArg(name, def = null) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : def;
}
const COMMIT = args.includes("--commit");
const IDS = (getArg("--id") || "").split(",").filter(Boolean);
const SRT_INPUT = getArg("--srt-input", "canary-1b-v2+pyannote-c1+agy-gemini-3-8-flash");
const ART_INPUT = getArg("--article-input", SRT_INPUT);
const ART_MODEL = getArg("--article-model", "opus-5-5");
// goli alias kao u produkciji: dedup bira leksikografski najveći _{date}_{model} ('o' > 'g')
const SLUG = getArg("--slug", "opus");

const rows = fs.readFileSync(path.join(EXP, "bases.tsv"), "utf-8").trim().split("\n").slice(1).map(l => l.split("\t"));
const plan = [];
let skipped = 0;
for (const [id, kanal, base] of rows) {
    if (IDS.length && !IDS.includes(id)) continue;
    const src = path.join(OUT, kanal);
    const f = (suffix) => path.join(src, `${base}.${suffix}`);

    // već na produkciji? (kanalski dir ili _unlisted, bilo koji basename s tim ID-om)
    const hits = [];
    for (const d of [path.join(PROD, kanal), DST]) {
        if (!fs.existsSync(d)) continue;
        if (fs.readdirSync(d).some(n => n.includes(`_yt_${id}.`))) hits.push(path.relative(PROD, d));
    }
    if (hits.length) { console.log(`⏭  ${id} (${kanal}): već postoji u ${hits.join(", ")} — preskačem (ponovna obrada = admin 🔁)`); skipped++; continue; }

    const sum = f(`${TAG}.${ART_INPUT}.${ART_MODEL}.sazetak.json`), art = f(`${TAG}.${ART_INPUT}.${ART_MODEL}.clanak.json`);
    const srt = f(`${TAG}.${SRT_INPUT}.dijariziran.srt`), info = f("info.json");
    const missing = [sum, art, srt, info].filter(p => !fs.existsSync(p));
    if (missing.length) { console.log(`⚠️  ${id}: nedostaje ${missing.map(p => path.basename(p)).join(", ")} — preskačem`); skipped++; continue; }
    const a = JSON.parse(fs.readFileSync(art, "utf-8"));
    if (!a.metadata.complete) { console.log(`⚠️  ${id}: članak nije kompletan — preskačem`); skipped++; continue; }
    plan.push({ id, kanal, base, src, f, sum, art, srt, info, a });
}

const genDate = (iso) => iso.slice(0, 10);
const write = (p, data) => {
    if (fs.existsSync(p)) throw new Error(`postoji, ne prepisujem: ${p}`);
    if (COMMIT) fs.writeFileSync(p, data);
};
const copy = (from, to) => {
    if (fs.existsSync(to)) throw new Error(`postoji, ne prepisujem: ${to}`);
    if (COMMIT) fs.copyFileSync(from, to);
};

for (const ep of plan) {
    const { id, base, f, a } = ep;
    const info = JSON.parse(fs.readFileSync(ep.info, "utf-8"));
    const date = genDate(a.metadata.generated_at);
    const artBase = `${base}.wav.canary.diarized_${date}_${SLUG}`;
    const prov = { experiment: TAG, srt_input: SRT_INPUT, article_input: ART_INPUT, article_model: ART_MODEL,
                   note: "promovirano iz experiments/2026-10-10-asr (pobjednik slijepe ocjene 15.10.2026.)" };
    const out = [];

    // 1. metapodaci + prijepisi
    copy(ep.info, path.join(DST, `${base}.info.json`)); out.push("info.json");
    if (fs.existsSync(f("description"))) { copy(f("description"), path.join(DST, `${base}.description`)); out.push("description"); }
    copy(ep.srt, path.join(DST, `${base}.wav.canary.diarized.srt`)); out.push("wav.canary.diarized.srt");
    if (fs.existsSync(f(`${TAG}.canary-1b-v2.prijepis.srt`))) {
        copy(f(`${TAG}.canary-1b-v2.prijepis.srt`), path.join(DST, `${base}.wav.canary.srt`)); out.push("wav.canary.srt");
    }
    // vremena riječi za titl (KORAK 9.87): eksperiment ima [s, s, tekst], produkcija {v:1, words:[ms, ms, tekst]}
    const wts = f(`${TAG}.canary-1b-v2.rijeci.json`);
    if (fs.existsSync(wts)) {
        const w = JSON.parse(fs.readFileSync(wts, "utf-8"));
        write(path.join(DST, `${base}.wav.canary.word_ts.json`), JSON.stringify({ v: 1, source: "canary",
            words: w.words.map(([s, e, t]) => [Math.round(s * 1000), Math.round(e * 1000), t]) }));
        out.push("wav.canary.word_ts.json");
    }

    // 2. sažetak u produkcijskom omotu (summarize_gemini.js)
    const s = JSON.parse(fs.readFileSync(ep.sum, "utf-8"));
    write(path.join(DST, `${base}.wav.canary.summary.json`), JSON.stringify({
        version: "1.0", generated_at: s.metadata.generated_at, model: SLUG,
        source: { filename: `${base}.wav.canary.diarized.srt`, channel: "_unlisted", youtube_id: id, title: info.title,
                  upload_date: info.upload_date, duration_seconds: info.duration, platform: "youtube",
                  source_url: info.webpage_url || `https://www.youtube.com/watch?v=${id}` },
        provenance: prov, summary: s.summary }, null, 2));
    out.push("wav.canary.summary.json");

    // 3. outline + članak (generate_article_gemini.js: outline je zasebna datoteka)
    write(path.join(DST, `${artBase}.outline.json`), JSON.stringify(a.metadata.outline, null, 2));
    write(path.join(DST, `${artBase}.article.json`), JSON.stringify({
        metadata: { source_file: `${base}.wav.canary.diarized.srt`, generated_at: a.metadata.generated_at, model: SLUG,
                    model_id: `claude-code:${a.metadata.model_id}`, strict_attribution: a.metadata.strict_attribution,
                    iterations_expected: a.metadata.iterations_expected, complete: true, provenance: prov },
        iterations: a.iterations.map(({ iteration_number, start_time, end_time, theme, sections }) =>
            ({ iteration_number, start_time, end_time, theme, sections })) }, null, 2));
    out.push(`…_${date}_${SLUG}.outline.json`, `…_${date}_${SLUG}.article.json`);

    console.log(`${COMMIT ? "✅" : "▶ "} ${id} (${ep.kanal}) → _unlisted/${base}.*  [${out.join(", ")}]`);
}
console.log(`\n${COMMIT ? "zapisano" : "SUHO (bez --commit ništa nije zapisano)"}: ${plan.length} epizoda, preskočeno ${skipped}`);
if (plan.length && COMMIT) console.log("Dovršava ih nightly (03:00): screenshotovi, EPUB, words.json, sponzori, RAG, R2, episode.json → domovina.ai/v/<ID>");
