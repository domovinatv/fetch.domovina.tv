#!/usr/bin/env node
'use strict';

/**
 * magisterium_mcp_assemble.js — HIBRIDNI MCP workflow, KORAK 3 (sastavljanje)
 *
 * Uzima job.json (iz magisterium_mcp_prep.js) + .results/holistic.raw.txt +
 * .results/batch_NN.raw.txt (sirovi MCP chat odgovori koje je Claude spremio) i
 * sastavlja finalni .article.magisterium.json u DOWNSTREAM-kompatibilnom obliku
 * (generate_channel_index.js čita root `overall_score`; vidi memory
 * magisterium_json_root_overall_score_required).
 *
 * Hibrid = SLOJ 1 (holistički, 1 chat) + SLOJ 2 (batch-of-N granularno) +
 *          SLOJ 3 (citati razriješeni u {document, ref}; URL se po želji dodaje
 *          naknadno preko Magisterium `search`).
 *
 * Output je SUPERSET batch-formata:
 *   - root: version, overall_score (= prosjek sekcija, radi konzistentnosti s
 *     postojećim datotekama), score_interpretation, score_breakdown, total_concerns
 *   - NOVO: `overall` (holistički blok: holistic_score, assessment, seeds_of_logos,
 *     concerns, theological_context, citations)
 *   - iterations[].sections[].magisterium: {score, assessment, concerns, enrichment, citations}
 *
 * Parsiranje sirovih odgovora je robusno (kao JSON-repair u generate_article_gemini.js):
 *   - izvuci ```json ... ``` blok ili prvi {...} balansiran
 *   - izvuci "References:" listu → mapu [^N] → {document, author, ref}
 *   - po sekciji: [^N] markeri u assessment/enrichment/concerns → citations[]
 */

const fs   = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const jobPath    = getArg('--job');
const resultsDir = getArg('--results-dir');
const outPath    = getArg('--out');           // per-section .article.magisterium.json
const outFull    = getArg('--out-full');      // holistički .article.magisterium_full.json
const urlMapPath = getArg('--url-map');       // {document_or_ref: url} eksplicitni override
const docRegPath = getArg('--doc-registry')   // keš document→UUID (default: magisterium_doc_urls.json)
    || path.join(__dirname, 'magisterium_doc_urls.json');

if (!jobPath || !resultsDir) {
    console.error('Uporaba: node magisterium_mcp_assemble.js --job <job.json> --results-dir <dir> [--out <p>] [--out-full <p>] [--url-map <p>] [--doc-registry <p>]');
    process.exit(1);
}

const MODEL = 'magisterium (MCP hibrid)';

// SLOJ 3: razrješavanje source_url.
//  1) eksplicitni --url-map (override), 2) doc-registry (substring→UUID, gradi /ref/ URL).
const urlMap = urlMapPath && fs.existsSync(urlMapPath)
    ? JSON.parse(fs.readFileSync(urlMapPath, 'utf-8')) : {};
const docReg = fs.existsSync(docRegPath)
    ? (JSON.parse(fs.readFileSync(docRegPath, 'utf-8')).docs || []) : [];
const unresolvedDocs = new Set();

function urlFromRegistry(document, ref) {
    const hit = docReg.find(d => document.includes(d.match));
    if (!hit) return null;
    const base = `https://www.magisterium.com/docs/${hit.uuid}`;
    return ref ? `${base}/ref/${encodeURIComponent(ref)}` : base;
}

// interni citat {n, document, author, ref, citation_text} → konzumirana Flutter shema
function toConsumedCitation(c) {
    const url = urlMap[`${c.document}|${c.ref}`] || urlMap[c.document]
        || urlFromRegistry(c.document || '', c.ref || '');
    if (!url && c.document) unresolvedDocs.add(c.document);
    return {
        cited_text: '',                       // MCP reference ne nose doslovni citat
        document_title: c.document || '',
        document_author: c.author || '',
        document_year: '',                    // nije dostupno iz MCP referenci
        document_reference: c.ref || '',
        source_url: url,                      // best-effort (SLOJ 3); null ako nerazriješeno
    };
}

function scoreInterpretation(score) {
    if (score >= 90) return 'Aktivno promiče katolički nauk';
    if (score >= 70) return 'Uglavnom usklađeno';
    if (score >= 50) return 'Djelomično usklađeno, nejasnoće';
    if (score >= 30) return 'Odstupanje od crkvenog nauka';
    return 'Proturječi katoličkom nauku ili Pismu';
}

// --- Robusno izvlačenje JSON bloka iz sirovog MCP odgovora ---

function extractJson(raw) {
    // 1) ```json ... ``` fenced blok
    const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
    if (fenced) {
        try { return JSON.parse(fenced[1].trim()); } catch (_) { /* fallthrough */ }
    }
    // 2) prvi balansirani {...} (do "References:" markera)
    const beforeRefs = raw.split(/\nReferences:/i)[0];
    const start = beforeRefs.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < beforeRefs.length; i++) {
        const c = beforeRefs[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
        } else {
            if (c === '"') inStr = true;
            else if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) {
                try { return JSON.parse(beforeRefs.slice(start, i + 1)); } catch (_) { return null; }
            } }
        }
    }
    return null;
}

// --- Parsiranje "References:" liste → { N: {document, author, ref, citation_text} } ---

function parseReferences(raw) {
    const refs = {};
    const idx = raw.search(/\nReferences:/i);
    if (idx === -1) return refs;
    const block = raw.slice(idx);
    const re = /\[\^(\d+)\]\.\s*(.+?)\s*$/gm;
    let m;
    while ((m = re.exec(block)) !== null) {
        const n = parseInt(m[1], 10);
        const text = m[2].trim();
        // "Document Title (Author), refLocator"  — author u zadnjim zagradama, ref opcionalno iza
        let document = text, author = '', ref = '';
        const am = text.match(/^(.*)\(([^()]*)\)\s*(?:,\s*(.+))?$/);
        if (am) {
            document = am[1].trim();
            author   = (am[2] || '').trim();
            ref      = (am[3] || '').trim();
        } else {
            // Bez (Author): pokušaj odvojiti SAMO trailing numerički ref
            // (npr. "Catechism of the Catholic Church, 2293" / ", para-97" / ", Art. 73").
            const rm = text.match(/^(.*),\s*((?:para-)?\d+[a-z]?|Art\.?\s*\d+|page\s*\d+|\d+\.\d+)\s*$/i);
            if (rm) { document = rm[1].trim(); ref = rm[2].trim(); }
        }
        refs[n] = { n, document, author, ref, citation_text: text };
    }
    return refs;
}

// markeri [^N] u tekstovima → poredani jedinstveni citati
function collectCitations(texts, refMap) {
    const found = [];
    const seen = new Set();
    const re = /\[\^(\d+)\]/g;
    for (const t of texts) {
        if (!t) continue;
        let m;
        while ((m = re.exec(t)) !== null) {
            const n = parseInt(m[1], 10);
            if (seen.has(n)) continue;
            seen.add(n);
            if (refMap[n]) found.push(refMap[n]);
        }
    }
    return found;
}

// ukloni [^N] markere iz teksta za "čistu" prezentaciju (zadržavamo i original)
function stripMarkers(t) {
    return (t || '').replace(/\s*\[\^\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

// --- Učitaj job + rezultate ---

const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));
const article = JSON.parse(fs.readFileSync(job.articlePath, 'utf-8'));
const iterations = article.iterations || article.iteracije || [];

// holistic
let holistic = null, holisticCitations = [];
const holisticPath = path.join(resultsDir, 'holistic.raw.txt');
if (fs.existsSync(holisticPath)) {
    const raw = fs.readFileSync(holisticPath, 'utf-8');
    holistic = extractJson(raw);
    const refMap = parseReferences(raw);
    if (holistic) {
        holisticCitations = collectCitations([
            holistic.assessment, holistic.theological_context,
            ...(holistic.seeds_of_logos || []), ...(holistic.concerns || []),
        ], refMap);
        // Holistički JSON često nema inline [^N] markere (citati su samo u
        // trailing References listi) → fallback: priloži SVE parsirane reference
        // jer se sve tiču procjene cijelog podcasta.
        if (holisticCitations.length === 0) {
            holisticCitations = Object.values(refMap).sort((a, b) => a.n - b.n);
        }
    }
}

// batch rezultati → mapa "itIdx:secIdx" → magisterium objekt
const sectionMag = new Map();
let parsedBatches = 0, missingBatches = [];
for (const b of job.batches) {
    const fp = path.join(resultsDir, `batch_${String(b.batchIndex).padStart(2, '0')}.raw.txt`);
    if (!fs.existsSync(fp)) { missingBatches.push(b.batchIndex); continue; }
    const raw = fs.readFileSync(fp, 'utf-8');
    const parsed = extractJson(raw);
    const refMap = parseReferences(raw);
    if (!parsed || !Array.isArray(parsed.results)) { missingBatches.push(b.batchIndex); continue; }
    parsedBatches++;
    for (const r of parsed.results) {
        const ref = b.sectionRefs.find(s => s.localIndex === r.index);
        if (!ref) continue;
        const citations = collectCitations([r.assessment, r.enrichment, ...(r.concerns || [])], refMap);
        sectionMag.set(`${ref.itIdx}:${ref.secIdx}`, {
            score: typeof r.score === 'number' ? r.score : null,
            assessment: stripMarkers(r.assessment),
            concerns: (r.concerns || []).map(stripMarkers),
            enrichment: stripMarkers(r.enrichment),
            citations,
        });
    }
}

// --- Rekonstruiraj enriched iteracije (oblik kao enrich_magisterium_batch.js) ---

let totalScore = 0, scoredCount = 0;
const enrichedIterations = iterations.map(iteration => {
    const enrichedSections = (iteration.sections || []).map((section, secIdx) => {
        const itIdx = iterations.indexOf(iteration);
        const magisterium = sectionMag.get(`${itIdx}:${secIdx}`) || null;
        if (magisterium && typeof magisterium.score === 'number') {
            totalScore += magisterium.score; scoredCount++;
        }
        return {
            subtitle: section.subtitle,
            screenshot_timestamp: section.screenshot_timestamp,
            screenshot_description: section.screenshot_description,
            content: section.content,
            keywords: section.keywords,
            entities: section.entities,
            magisterium,
        };
    });
    const itScores = enrichedSections.map(s => s.magisterium?.score).filter(s => typeof s === 'number');
    const itAvg = itScores.length ? Math.round(itScores.reduce((a, b) => a + b, 0) / itScores.length) : null;
    return {
        iteration_number: iteration.iteration_number,
        start_time: iteration.start_time,
        end_time: iteration.end_time,
        theme: iteration.theme,
        iteration_score: itAvg,
        sections: enrichedSections,
    };
});

const sectionsAvg = scoredCount > 0 ? Math.round(totalScore / scoredCount) : null;
const totalConcerns = enrichedIterations
    .flatMap(it => it.sections)
    .reduce((sum, s) => sum + (s.magisterium?.concerns?.length || 0), 0);
const missingSections = enrichedIterations.flatMap(it => it.sections).filter(s => !s.magisterium).length;

const generatedAt = getArg('--generated-at') || new Date().toISOString();
const holisticScore = holistic && typeof holistic.overall_score === 'number' ? holistic.overall_score : null;

// Konvertiraj sve interne citate u konzumiranu Flutter shemu (i razriješi source_url).
const enrichedIterationsConsumed = enrichedIterations.map(it => ({
    ...it,
    sections: it.sections.map(s => ({
        ...s,
        magisterium: s.magisterium ? {
            ...s.magisterium,
            citations: (s.magisterium.citations || []).map(toConsumedCitation),
        } : null,
    })),
}));
const holisticCitationsConsumed = holisticCitations.map(toConsumedCitation);

// ── FILE 1: per-section .article.magisterium.json (MagisteriumData model) ──
// root overall_score = prosjek sekcija (konzistentno s postojećim datotekama →
// generate_channel_index.js agregacija ostaje apples-to-apples).
const output = {
    version: '2.0-mcp-hybrid',
    generated_at: generatedAt,
    model: MODEL,
    method: 'mcp_hybrid',
    batch_size: job.batchSize,
    source_article: job.basename,
    overall_score: sectionsAvg,
    score_interpretation: sectionsAvg !== null ? scoreInterpretation(sectionsAvg) : null,
    overall: holistic ? {
        holistic_score: holisticScore,
        assessment: stripMarkers(holistic.assessment),
        seeds_of_logos: (holistic.seeds_of_logos || []).map(stripMarkers),
        concerns: (holistic.concerns || []).map(stripMarkers),
        theological_context: stripMarkers(holistic.theological_context),
        citations: holisticCitationsConsumed,
    } : null,
    score_breakdown: enrichedIterations.map(it => ({
        iteration: it.iteration_number, theme: it.theme, score: it.iteration_score,
    })),
    total_concerns: totalConcerns,
    iterations: enrichedIterationsConsumed,
};
if (missingSections > 0) output.partial = true;
if (outPath) fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');

// ── FILE 2: holistički .article.magisterium_full.json (MagisteriumFullData model) ──
// `evaluation` (markdown) = holistika + per-section breakdown → sve vidljivo u
// "Evaluacija" tabu. overall_score = holistički score (headline cijele evaluacije).
if (outFull && holistic) {
    const md = [];
    md.push(stripMarkers(holistic.assessment), '');
    if ((holistic.seeds_of_logos || []).length) {
        md.push('## Sjeme Logosa (pozitivni elementi)', '');
        holistic.seeds_of_logos.forEach(x => md.push(`- ${stripMarkers(x)}`));
        md.push('');
    }
    if ((holistic.concerns || []).length) {
        md.push('## Zabrinutosti i rizici', '');
        holistic.concerns.forEach(x => md.push(`- ${stripMarkers(x)}`));
        md.push('');
    }
    if (holistic.theological_context) {
        md.push('## Teološki kontekst', '', stripMarkers(holistic.theological_context), '');
    }
    md.push('## Score po sekcijama', '');
    enrichedIterations.forEach(it => {
        md.push(`### ${it.theme} — ${it.iteration_score ?? '?'}/100`, '');
        it.sections.forEach(s => {
            const m = s.magisterium;
            if (!m) return;
            md.push(`- **${m.score ?? '?'}/100 — ${s.subtitle}**  `);
            md.push(`  ${m.assessment}`);
            (m.concerns || []).forEach(c => md.push(`  - ⚠️ ${c}`));
        });
        md.push('');
    });
    // Spoji jedinstvene citate (holistički + svi sekcijski) za full citations[].
    const seenCit = new Set();
    const mergedCit = [];
    [holisticCitationsConsumed, ...enrichedIterationsConsumed.flatMap(it =>
        it.sections.map(s => s.magisterium?.citations || []))].flat().forEach(c => {
        const k = `${c.document_title}|${c.document_reference}`;
        if (seenCit.has(k)) return;
        seenCit.add(k); mergedCit.push(c);
    });
    const fullOut = {
        version: '2.0-mcp-hybrid',
        generated_at: generatedAt,
        model: MODEL,
        source_article: job.basename,
        overall_score: holisticScore ?? sectionsAvg,
        score_interpretation: scoreInterpretation(holisticScore ?? sectionsAvg ?? 0),
        evaluation: md.join('\n'),
        citations: mergedCit,
    };
    fs.writeFileSync(outFull, JSON.stringify(fullOut, null, 2), 'utf-8');
}

// --- Sažetak ---
const resolvedUrls = enrichedIterationsConsumed.flatMap(it => it.sections)
    .flatMap(s => s.magisterium?.citations || []).filter(c => c.source_url).length
    + holisticCitationsConsumed.filter(c => c.source_url).length;
console.log(`✝️  Magisterium MCP hibrid — sastavljanje`);
console.log(`   Batchova parsirano: ${parsedBatches}/${job.batches.length}${missingBatches.length ? ` (nedostaju: ${missingBatches.join(',')})` : ''}`);
console.log(`   Holistički: ${holistic ? `score ${holisticScore}, ${holisticCitations.length} citata` : 'NEMA'}`);
console.log(`   Sekcija ocijenjeno: ${scoredCount}/${job.sectionCount}${missingSections ? ` (⚠️ ${missingSections} bez ocjene)` : ''}`);
console.log(`   Prosjek sekcija (root overall_score): ${sectionsAvg}/100 — ${sectionsAvg !== null ? scoreInterpretation(sectionsAvg) : 'N/A'}`);
console.log(`   Ukupno zabrinutosti: ${totalConcerns} | source_url razriješeno: ${resolvedUrls}`);
if (unresolvedDocs.size) {
    console.log(`   ⚠️  Nerazriješeni dokumenti (search → dodaj UUID u magisterium_doc_urls.json):`);
    [...unresolvedDocs].forEach(d => console.log(`        - ${d}`));
}
if (outPath) console.log(`   → per-section: ${outPath}`);
if (outFull) console.log(`   → full:        ${outFull}`);
