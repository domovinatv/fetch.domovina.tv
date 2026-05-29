#!/usr/bin/env node
'use strict';

/**
 * magisterium_mcp_prep.js — HIBRIDNI MCP workflow, KORAK 1 (priprema promptova)
 *
 * Magisterium MCP (chat/search/fetch) dostupan je SAMO unutar Claude Code chata,
 * ne iz standalone Node skripte. Zato je MCP-driven obogaćivanje "Claude-in-the-loop":
 *
 *   1) magisterium_mcp_prep.js      → iz article.json (+outline.json) generira
 *                                      holistički prompt + batch-of-N promptove + manifest
 *   2) Claude izvrši MCP pozive     → 1× holistički chat + ⌈sekcija/N⌉ batch chatova
 *                                      (sekvencijalno, ≤15 req/min) + search za citate
 *   3) magisterium_mcp_assemble.js  → sastavi finalni .article.magisterium.json
 *
 * EMPIRIJSKI: batch-of-4 stvarnog sadržaja prolazi pouzdano; batch-of-6 time-outa
 * (usko grlo je dubina generacije po sekciji, ne broj sekcija). Default BATCH_SIZE=4.
 *
 * Promptovi se i SPREMAJU na disk (kao .magisterium_full_*_prompt.md) radi
 * reproducibilnosti i kako bi se isti prompt mogao zalijepiti u web chat.
 */

const fs   = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const articlePath = getArg('--article');
const BATCH_SIZE  = parseInt(getArg('--batch-size') || '4', 10);
// Default 60 rij./sekciji: empirijski timeout-safe. Pune ~100-rij. sekcije u batch-of-4
// znaju time-outati `chat` (usko grlo je dubina generacije po sekciji). Diže se preko
// --max-words kad treba više konteksta, ali tada očekuj povremene timeoute → retry kraće.
const MAX_CONTENT_WORDS = parseInt(getArg('--max-words') || '60', 10);
const outDir      = getArg('--out-dir') || '/tmp/mag_hybrid';

if (!articlePath) {
    console.error('Uporaba: node magisterium_mcp_prep.js --article <path.article.json> [--batch-size 4] [--out-dir /tmp/mag_hybrid]');
    process.exit(1);
}

// --- Helpers (copy-paste konvencija, vidi CLAUDE.md) ---

function trimToWords(text, maxWords) {
    if (!text) return '';
    const words = text.split(/\s+/);
    if (words.length <= maxWords) return text;
    return words.slice(0, maxWords).join(' ') + '...';
}

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// outline.json živi pored article.json: isti basename, .outline.json umjesto .article.json
function findOutlinePath(articleP) {
    const cand = articleP.replace(/\.article\.json$/, '.outline.json');
    return fs.existsSync(cand) ? cand : null;
}

// --- SLOJ 1: holistički prompt (iz outline tema + iteration sažetaka) ---

function buildHolisticPrompt(podcastTitle, iterations, outline) {
    // Preferiraj outline (teme + opisi); fallback na iteration teme + prvih par sekcija
    const blocks = iterations.map((it, i) => {
        const oIt = outline && (outline.iterations || outline.iteracije || [])[i];
        const summary = oIt && (oIt.summary || oIt.sazetak || oIt.description || oIt.opis);
        const subtitles = (it.sections || []).map(s => `  - ${s.subtitle || ''}`).join('\n');
        return [
            `=== BLOK ${i}: ${it.theme || '(bez teme)'} ===`,
            summary ? `Sažetak: ${summary}` : null,
            `Podteme:\n${subtitles}`,
        ].filter(Boolean).join('\n');
    }).join('\n\n');

    return `Ti si stručni teološki analitičar Katoličke Crkve. Na temelju strukture cijelog podcasta (tematski blokovi i njihove podteme) daj JEDNU sveobuhvatnu (holističku) evaluaciju u svjetlu katoličkog nauka, socijalnog nauka Crkve i Svetog pisma.

Podcast: ${podcastTitle}

${blocks}

Vrati ISKLJUČIVO JSON točno ovog oblika (bez teksta izvan JSON-a):
{
  "overall_score": <cijeli broj 0-100>,
  "assessment": "<3-5 rečenica sveobuhvatne teološke i antropološke procjene cijelog podcasta>",
  "seeds_of_logos": ["<konkretni pozitivni elementi: kršćanske vrijednosti, dostojanstvo osobe, kultura susreta>"],
  "concerns": ["<cross-cutting teološki rizici/odstupanja koja se protežu kroz cijeli podcast; prazna lista ako nema>"],
  "theological_context": "<2-4 rečenice s relevantnim crkvenim dokumentima (KKC, enciklike, koncili) koji uokviruju glavne teme>"
}

Skala overall_score:
90-100 = aktivno promiče Evanđelje i kulturu susreta
70-89  = uglavnom usklađeno; poštuje dostojanstvo osobe
50-69  = djelomično usklađeno, nejasnoće ili redukcionizam
30-49  = značajno odstupanje od kršćanske antropologije
0-29   = proturječi nauku; relativizam, redukcionizam ili kultura odbacivanja`;
}

// --- SLOJ 2: batch prompt (kao enrich_magisterium_batch.js:buildBatchPrompt) ---

function buildBatchPrompt(podcastTitle, batch) {
    const sectionBlocks = batch.map((item, i) => {
        const content  = trimToWords(item.section.content || '', MAX_CONTENT_WORDS);
        const keywords = (item.section.keywords || []).join(', ');
        const entities = (item.section.entities || []).join(', ');
        return [
            `=== SEKCIJA ${i} ===`,
            `Blok: ${item.iterationTheme}`,
            `Tema: ${item.section.subtitle || '(bez naslova)'}`,
            keywords ? `Ključni pojmovi: ${keywords}` : null,
            entities ? `Osobe/organizacije: ${entities}` : null,
            `Sadržaj:\n${content}`,
        ].filter(Boolean).join('\n');
    }).join('\n\n');

    return `Ti si teološki analitičar. Evaluiraj usklađenost sljedećih ${batch.length} odlomaka iz katoličkog podcasta s katoličkim naukom i Svetim pismom. Vrati ISKLJUČIVO JSON bez komentara.

Podcast: ${podcastTitle}

${sectionBlocks}

Za svaku sekciju (indeksi 0–${batch.length - 1}) vrati JSON točno ovog oblika:
{
  "results": [
    {
      "index": 0,
      "score": <cijeli broj 0-100>,
      "assessment": "<1-2 rečenice teološke procjene na hrvatskom>",
      "concerns": ["<eventualni teološki problemi; prazna lista ako nema>"],
      "enrichment": "<2-3 rečenice teološkog konteksta koji obogaćuje razumijevanje>"
    }
  ]
}

Skala usklađenosti:
90-100 = aktivno promiče i produbljuje katolički nauk
70-89  = uglavnom usklađeno, bez bitnih problema
50-69  = djelomično usklađeno, postoje nejasnoće
30-49  = značajno odstupanje od crkvenog nauka
0-29   = proturječi katoličkom nauku ili Svetom pismu`;
}

// --- Main ---

const article = readJson(articlePath);
const basename = path.basename(articlePath).replace(/\.article\.json$/, '');
const podcastTitle = (article.metadata && (article.metadata.title || article.metadata.naslov)) || basename;
const iterations = article.iterations || article.iteracije || [];

const outlinePath = findOutlinePath(articlePath);
const outline = outlinePath ? readJson(outlinePath) : null;

// Flatten sekcije s globalnim indeksom + (itIdx, secIdx) za assembly
const flat = [];
iterations.forEach((it, itIdx) => {
    (it.sections || []).forEach((section, secIdx) => {
        flat.push({
            globalIndex: flat.length,
            itIdx, secIdx,
            iterationTheme: it.theme || '',
            section,
        });
    });
});

// Grupiraj u batcheve
const batches = [];
for (let i = 0; i < flat.length; i += BATCH_SIZE) {
    const chunk = flat.slice(i, i + BATCH_SIZE);
    batches.push({
        batchIndex: batches.length,
        // localIndex u promptu == redoslijed u chunku; mapiramo na globalni i (itIdx,secIdx)
        sectionRefs: chunk.map((item, localIndex) => ({
            localIndex,
            globalIndex: item.globalIndex,
            itIdx: item.itIdx,
            secIdx: item.secIdx,
            subtitle: item.section.subtitle || '',
        })),
        prompt: buildBatchPrompt(podcastTitle, chunk.map(c => ({
            iterationTheme: c.iterationTheme,
            section: c.section,
        }))),
    });
}

const holisticPrompt = buildHolisticPrompt(podcastTitle, iterations, outline);

fs.mkdirSync(outDir, { recursive: true });
const jobPath = path.join(outDir, `${basename}.job.json`);
const job = {
    basename,
    articlePath: path.resolve(articlePath),
    outlinePath: outlinePath ? path.resolve(outlinePath) : null,
    podcastTitle,
    batchSize: BATCH_SIZE,
    maxContentWords: MAX_CONTENT_WORDS,
    sectionCount: flat.length,
    iterationMeta: iterations.map(it => ({
        iteration_number: it.iteration_number,
        start_time: it.start_time,
        end_time: it.end_time,
        theme: it.theme,
        sectionCount: (it.sections || []).length,
    })),
    holisticPrompt,
    batches,
};
fs.writeFileSync(jobPath, JSON.stringify(job, null, 2), 'utf-8');

// Spremi i čitljive .txt promptove (transparentnost / web-chat copy-paste)
const promptDir = path.join(outDir, `${basename}.prompts`);
fs.mkdirSync(promptDir, { recursive: true });
fs.writeFileSync(path.join(promptDir, 'holistic.txt'), holisticPrompt, 'utf-8');
batches.forEach(b => {
    fs.writeFileSync(path.join(promptDir, `batch_${String(b.batchIndex).padStart(2, '0')}.txt`), b.prompt, 'utf-8');
});

console.log(`✝️  Magisterium MCP hibrid — priprema`);
console.log(`   Podcast: ${podcastTitle}`);
console.log(`   Sekcija: ${flat.length} | batch-size: ${BATCH_SIZE} | batchova: ${batches.length}`);
console.log(`   chat poziva (procjena): 1 holistički + ${batches.length} batch = ${1 + batches.length}`);
console.log(`   Job: ${jobPath}`);
console.log(`   Promptovi: ${promptDir}/`);
