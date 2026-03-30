#!/usr/bin/env node

/**
 * enrich_magisterium_batch.js
 *
 * Korak 8.5 pipeline-a (BATCH varijanta): Teološko obogaćivanje Gemini članaka.
 *
 * Razlika od enrich_magisterium.js:
 *   - Šalje do BATCH_SIZE sekcija po API pozivu umjesto jednu po jednu.
 *   - Magisterium AI naplaćuje veliki system prompt za svaki zahtjev —
 *     batch smanjuje broj API poziva za ~4× i proporcionalno smanjuje troškove.
 *   - Output format je identičan: isti .article.magisterium_batch.json fajlovi,
 *     kompatibilni s pipeline koracima koji ih konzumiraju.
 *
 * Za svaku sekciju generira (isto kao single mode):
 *   - score (0-100): usklađenost s katoličkim naukom i Svetim pismom
 *   - assessment: kratka teološka procjena
 *   - concerns: eventualni teološki problemi
 *   - enrichment: teološki kontekst iz crkvenih dokumenata
 *   - citations: globalne citacije batcha (Katekizam, enciklike, papinski govori...)
 *
 * Output: {basename}_{date}_{model}.article.magisterium_batch.json
 *
 * Idempotentnost:
 *   - Ako output postoji i NIJE parcijalan → preskači
 *   - Ako output postoji i JEST parcijalan → nastavi od null sekcija (u batchevima)
 *   - Kad su sve API kvote iscrpljene → zaustavi se, spremi parcijalni output, nastavi sutra
 *
 * Konfiguracija API ključeva (.env):
 *   Jedan ključ:    MAGISTERIUM_API_KEY=key1
 *   Više ključeva:  MAGISTERIUM_API_KEY_1=key1
 *                   MAGISTERIUM_API_KEY_2=key2
 *   Ili inline:     MAGISTERIUM_API_KEYS=key1,key2,key3
 *
 * Usage:
 *   node enrich_magisterium_batch.js --input-dir storage/output
 *   node enrich_magisterium_batch.js --input-dir storage/output --channel mladi_za_domovinu
 *   node enrich_magisterium_batch.js --input-dir storage/output --video-id H-p2Hl6x7I0
 *   node enrich_magisterium_batch.js --input-dir storage/output --dry-run
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// --- CLI args (Pattern B) ---
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const INPUT_DIR       = getArg('--input-dir') || path.join(__dirname, 'storage', 'output');
const CHANNEL_FILTER  = getArg('--channel');
const VIDEO_ID_FILTER = getArg('--video-id');
const DRY_RUN         = args.includes('--dry-run');

// --- Config ---
const MAGISTERIUM_ENDPOINT = 'https://www.magisterium.com/api/v1/chat/completions';
const MODEL                = 'magisterium-1';
const BATCH_SIZE           = 4;    // Sekcija po API pozivu (4 = optimalni balans troška i latencije)
const MAX_RETRIES          = 3;    // Pokušaji kad su SVI ključevi u rate limitu
const MAX_CONTENT_WORDS    = 300;  // Token budget per sekciji u batchu (manji nego single zbog akumulacije)

// Učitaj .env ako postoji
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
}

// --- Učitaj API ključeve (podržava više formata) ---

function loadApiKeys() {
    const keys = [];

    // Format 1: MAGISTERIUM_API_KEYS=key1,key2,key3
    if (process.env.MAGISTERIUM_API_KEYS) {
        for (const k of process.env.MAGISTERIUM_API_KEYS.split(',')) {
            const t = k.trim();
            if (t) keys.push(t);
        }
    }

    // Format 2: MAGISTERIUM_API_KEY_1, _2, _3 ...
    for (let i = 1; i <= 20; i++) {
        const k = process.env[`MAGISTERIUM_API_KEY_${i}`];
        if (k) {
            const t = k.trim();
            if (t && !keys.includes(t)) keys.push(t);
        }
    }

    // Format 3: MAGISTERIUM_API_KEY (single, backwards compat)
    if (process.env.MAGISTERIUM_API_KEY) {
        const t = process.env.MAGISTERIUM_API_KEY.trim();
        if (t && !keys.includes(t)) keys.push(t);
    }

    return keys;
}

const API_KEYS = DRY_RUN ? ['dry-run'] : loadApiKeys();

if (API_KEYS.length === 0 && !DRY_RUN) {
    console.error('❌ Nije pronađen nijedan Magisterium API ključ.');
    console.error('   Dodaj u .env: MAGISTERIUM_API_KEY=key ili MAGISTERIUM_API_KEY_1=key1 ...');
    process.exit(1);
}

// Delay: 4500ms za 1 ključ, skalira s više ključeva (min 500ms).
// Svaki ključ dobiva efektivno 4500ms pauzu između vlastitih zahtjeva.
const DELAY_MS = Math.max(500, Math.round(4500 / API_KEYS.length));

// --- Stanje rotacije ključeva ---

let keyRoundRobin = 0;
const keyDailyExhausted = new Set();

// Vraća indeks sljedećeg dostupnog ključa (round-robin, preskači iscrpljene).
function getNextKeyIdx(excluding = new Set()) {
    for (let i = 0; i < API_KEYS.length; i++) {
        const idx = (keyRoundRobin + i) % API_KEYS.length;
        if (!keyDailyExhausted.has(idx) && !excluding.has(idx)) {
            keyRoundRobin = (idx + 1) % API_KEYS.length;
            return idx;
        }
    }
    return -1;
}

function keyLabel(idx) {
    return API_KEYS.length > 1 ? ` [ključ ${idx + 1}/${API_KEYS.length}]` : '';
}

// Globalni flag: postavljeno kad su SVI ključevi dnevno iscrpljeni.
let quotaExhausted = false;

// --- Helpers ---

function trimToWords(text, maxWords) {
    if (!text) return '';
    const words = text.split(/\s+/);
    if (words.length <= maxWords) return text;
    return words.slice(0, maxWords).join(' ') + '...';
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function scoreInterpretation(score) {
    if (score >= 90) return 'Aktivno promiče katolički nauk';
    if (score >= 70) return 'Uglavnom usklađeno';
    if (score >= 50) return 'Djelomično usklađeno, nejasnoće';
    if (score >= 30) return 'Odstupanje od crkvenog nauka';
    return 'Proturječi katoličkom nauku ili Pismu';
}

// --- Batch prompt builder ---
//
// batch = [{ iterationTheme: string, section: { subtitle, content, keywords, entities } }]
//
// Gradi jedan prompt koji traži evaluaciju svih sekcija u batchu.
// Model vraća: { "results": [{ "index": 0, "score": 85, "assessment": "...", ... }] }

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
      "concerns": ["<eventualni teološki problemi ili nejasnoće, prazna lista ako nema>"],
      "enrichment": "<2-3 rečenice teološkog konteksta koji obogaćuje razumijevanje sadržaja>"
    }
  ]
}

Skala usklađenosti s katoličkim naukom i Svetim pismom:
90-100 = aktivno promiče i produbljuje katolički nauk
70-89  = uglavnom usklađeno, bez bitnih problema
50-69  = djelomično usklađeno, postoje nejasnoće ili izostavljanja
30-49  = značajno odstupanje od crkvenog nauka
0-29   = proturječi katoličkom nauku ili Svetom pismu`;
}

// --- Batch API call s rotacijom ključeva ---
//
// Ista strategija rotacije kao enrich_magisterium.js:
//   429 → odmah rotira na sljedeći ključ (bez čekanja)
//   svi ključevi 429 u ovom pozivu → čekaj 60s × retries, resetiraj, pokušaj ponovo
//   MAX_RETRIES iscrpljeni → quotaExhausted = true
//
// Vraća:
//   { results: Map<index, {score, assessment, concerns, enrichment}>, citations: [...] }
//   { skipped: true, skip_reason: 'content_filter' | '400_too_long' }

async function callMagisteriumBatch(prompt, triedKeys = new Set(), retries = 0) {
    if (DRY_RUN) {
        const count = (prompt.match(/=== SEKCIJA \d+ ===/g) || []).length || 1;
        const results = new Map();
        for (let i = 0; i < count; i++) {
            results.set(i, {
                score:      85,
                assessment: '[dry-run] Simulirani rezultat.',
                concerns:   [],
                enrichment: '[dry-run] Teološki kontekst bi bio ovdje.',
            });
        }
        return { results, citations: [] };
    }

    const keyIdx = getNextKeyIdx(triedKeys);

    if (keyIdx === -1) {
        if (keyDailyExhausted.size === API_KEYS.length) {
            quotaExhausted = true;
            throw new Error('Rate limit — sve API kvote iscrpljene za danas');
        }
        if (retries >= MAX_RETRIES) {
            quotaExhausted = true;
            throw new Error('Rate limit — premašen broj pokušaja na svim ključevima');
        }
        const wait = 60_000 * (retries + 1);
        console.log(`\n  ⏳ Svi ključevi rate limited, čekam ${wait / 1000}s (pokušaj ${retries + 1}/${MAX_RETRIES})...`);
        await sleep(wait);
        return callMagisteriumBatch(prompt, new Set(), retries + 1);
    }

    const apiKey = API_KEYS[keyIdx];
    let response;
    try {
        response = await fetch(MAGISTERIUM_ENDPOINT, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: 'json_object' },
                safety_settings: {
                    // Domovina TV sadržaj je katolički — isključi filter za rubne teme
                    CATEGORY_NON_CATHOLIC: { threshold: 'OFF', response: false },
                },
            }),
        });
    } catch (e) {
        // Mrežna greška — isti ključ, inkrementiraj retries
        if (retries < MAX_RETRIES) {
            console.log(`\n  ⚠️  Mrežna greška${keyLabel(keyIdx)} (${e.message}), pokušaj ${retries + 1}/${MAX_RETRIES}...`);
            await sleep(5000 * (retries + 1));
            return callMagisteriumBatch(prompt, triedKeys, retries + 1);
        }
        throw e;
    }

    if (response.status === 429) {
        // Ovaj ključ rate limited → dodaj u pokušane, odmah probaj sljedeći
        triedKeys.add(keyIdx);
        const remaining = API_KEYS.length - keyDailyExhausted.size - triedKeys.size;
        if (remaining > 0) {
            console.log(`\n  🔄 Rate limit${keyLabel(keyIdx)}, prelazim na sljedeći ključ (${remaining} preostalo)...`);
        }
        return callMagisteriumBatch(prompt, triedKeys, retries);
    }

    if (response.status === 401) {
        throw new Error(`Autentifikacijska greška (401)${keyLabel(keyIdx)} — provjeri API ključ i billing`);
    }

    if (response.status === 400) {
        // Prompt predugačak — trajno preskači cijeli batch
        console.log(` ⚠️  400 (prompt predugačak)${keyLabel(keyIdx)}`);
        return { skipped: true, skip_reason: '400_too_long' };
    }

    if (response.status >= 500) {
        if (retries < MAX_RETRIES) {
            console.log(`\n  ⚠️  Server greška (${response.status})${keyLabel(keyIdx)}, pokušaj ${retries + 1}/${MAX_RETRIES}...`);
            await sleep(10_000 * (retries + 1));
            return callMagisteriumBatch(prompt, triedKeys, retries + 1);
        }
        throw new Error(`Server greška ${response.status} nakon ${MAX_RETRIES} pokušaja`);
    }

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Magisterium API ${response.status}${keyLabel(keyIdx)}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();

    if (data.choices?.[0]?.finish_reason === 'content_filter') {
        console.log(` ⚠️  content_filter${keyLabel(keyIdx)}`);
        return { skipped: true, skip_reason: 'content_filter' };
    }

    // Parse JSON — strip markdown code fences ako ih model doda
    let parsed = {};
    try {
        let raw = data.choices[0].message.content;
        raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        parsed = JSON.parse(raw);
    } catch {
        parsed = { results: [] };
    }

    // Gradi Map: batchIndex → {score, assessment, concerns, enrichment}
    const resultsMap = new Map();
    for (const r of (Array.isArray(parsed.results) ? parsed.results : [])) {
        if (typeof r.index !== 'number') continue;
        resultsMap.set(r.index, {
            score:      typeof r.score === 'number'
                ? Math.round(Math.min(100, Math.max(0, r.score)))
                : null,
            assessment: r.assessment || '',
            concerns:   Array.isArray(r.concerns) ? r.concerns : [],
            enrichment: r.enrichment || '',
        });
    }

    // Globalne citacije za cijeli batch (iste za sve sekcije u batchu)
    const citations = (data.citations ?? []).map(c => ({
        cited_text:         c.cited_text,
        document_title:     c.document_title,
        document_author:    c.document_author,
        document_year:      c.document_year,
        document_reference: c.document_reference,
        source_url:         c.source_url,
    }));

    return { results: resultsMap, citations };
}

// --- Find article.json files ---

function findArticleFiles() {
    if (!fs.existsSync(INPUT_DIR)) {
        console.error(`❌ Input direktorij ne postoji: ${INPUT_DIR}`);
        process.exit(1);
    }

    const channels = fs.readdirSync(INPUT_DIR).filter(f => {
        if (CHANNEL_FILTER && f !== CHANNEL_FILTER) return false;
        try { return fs.statSync(path.join(INPUT_DIR, f)).isDirectory() && !f.startsWith('.'); }
        catch { return false; }
    });

    const files = [];
    for (const channel of channels) {
        const channelPath = path.join(INPUT_DIR, channel);
        let entries;
        try { entries = fs.readdirSync(channelPath); } catch { continue; }

        for (const file of entries) {
            if (file.startsWith('._')) continue;
            if (!file.endsWith('.article.json')) continue;
            if (VIDEO_ID_FILTER && !file.includes(`_yt_${VIDEO_ID_FILTER}`)) continue;
            files.push({ channel, articlePath: path.join(channelPath, file), basename: file });
        }
    }

    // Najnoviji first (po datumu u imenu)
    files.sort((a, b) => b.basename.localeCompare(a.basename));
    return files;
}

// --- Process one article.json ---

async function processArticle({ channel, articlePath, basename }) {
    const outputPath = articlePath.replace(/\.article\.json$/, '.article.magisterium_batch.json');

    // Provjeri postoji li output i je li parcijalan (null sekcije).
    // Detektiramo sadržajem, ne po partial flagu, jer stariji fajlovi nemaju flag.
    let existingOutput = null;
    if (fs.existsSync(outputPath)) {
        try {
            existingOutput = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
        } catch {
            existingOutput = null; // Koruptiran — re-obradi
        }

        if (existingOutput) {
            const nullSections = (existingOutput.iterations || [])
                .flatMap(it => it.sections || [])
                .filter(s => s.magisterium === null);

            if (nullSections.length === 0) {
                console.log(`  ⏭️  Preskačem (već postoji): ${path.basename(outputPath)}`);
                return { skipped: true };
            }

            console.log(`  🔄 Nastavljam parcijalni output (${nullSections.length} null sekcija): ${path.basename(outputPath)}`);
        }
    }

    // Učitaj article.json
    let article;
    try {
        article = JSON.parse(fs.readFileSync(articlePath, 'utf-8'));
    } catch (e) {
        console.error(`  ❌ Ne mogu pročitati ${basename}: ${e.message}`);
        return { error: true };
    }

    // Naslov podcasta iz summary.json (best-effort)
    let podcastTitle = article.metadata?.source_file || basename;
    const summaryPath = articlePath.replace(
        /\.wav\.canary\.diarized_[\d-]+_[^.]+\.article\.json$/,
        '.canary.summary.json'
    );
    if (fs.existsSync(summaryPath)) {
        try {
            const s = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
            podcastTitle = s.summary?.title_hr || podcastTitle;
        } catch {}
    }

    const iterations    = article.iterations || [];
    const totalSections = iterations.reduce((sum, it) => sum + (it.sections?.length || 0), 0);

    console.log(`\n  📖 [${channel}] ${podcastTitle}`);
    console.log(`     ${basename}`);
    console.log(`     Iteracije: ${iterations.length} | Sekcije: ${totalSections}`);

    // Lookup mapa iz parcijalnog outputa:
    //   "{itIdx}:{secIdx}" → magisterium objekt (ili null = treba obraditi)
    const existingMagisterium = new Map();
    if (existingOutput?.iterations) {
        existingOutput.iterations.forEach((it, itIdx) => {
            (it.sections || []).forEach((sec, secIdx) => {
                existingMagisterium.set(`${itIdx}:${secIdx}`, sec.magisterium ?? null);
            });
        });
    }

    // ── Korak 1: Prikupi pending taskove ─────────────────────────
    // Pending = sekcije bez obrađenog magisterium podatka (null ili ne postoji u mapi)

    const pendingTasks = [];
    for (let itIdx = 0; itIdx < iterations.length; itIdx++) {
        const iteration = iterations[itIdx];
        for (let secIdx = 0; secIdx < (iteration.sections || []).length; secIdx++) {
            const key      = `${itIdx}:${secIdx}`;
            const existing = existingMagisterium.get(key);
            if (existing === null || existing === undefined) {
                pendingTasks.push({
                    key,
                    itIdx,
                    secIdx,
                    iterationTheme: iteration.theme,
                    section:        iteration.sections[secIdx],
                });
            }
        }
    }

    const totalPending = pendingTasks.length;
    const totalBatches = Math.ceil(totalPending / BATCH_SIZE);
    const alreadyDone  = totalSections - totalPending;

    if (alreadyDone > 0) {
        console.log(`     Iz cachea: ${alreadyDone} | Pending: ${totalPending} → ${totalBatches} batch${totalBatches !== 1 ? 'eva' : ''} od max ${BATCH_SIZE}`);
    } else {
        console.log(`     Ukupno pending: ${totalPending} sekcija → ${totalBatches} batch${totalBatches !== 1 ? 'eva' : ''} od max ${BATCH_SIZE}`);
    }

    // ── Korak 2: Obradi pending taskove u batchevima ─────────────

    // Mapa za nove rezultate: key → magisterium objekt (ili null ako nije uspjelo)
    const newResults = new Map();
    let newNullCount  = 0;

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        if (quotaExhausted) {
            // Označi sve preostale taskove kao null (nastavi sutra)
            for (const t of pendingTasks.slice(batchIdx * BATCH_SIZE)) {
                newResults.set(t.key, null);
                newNullCount++;
            }
            console.log(`     ⏭️  Batch ${batchIdx + 1}–${totalBatches}: preskočeno (kvota iscrpljena — nastavi sutra)`);
            break;
        }

        const chunk = pendingTasks.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);

        process.stdout.write(
            `     → Batch ${batchIdx + 1}/${totalBatches} (${chunk.length} sekcija)... `
        );

        if (!DRY_RUN) await sleep(DELAY_MS);

        let batchResult;
        try {
            batchResult = await callMagisteriumBatch(buildBatchPrompt(podcastTitle, chunk));
        } catch (e) {
            if (e.message.includes('401')) throw e; // Abort — nema smisla nastavljati
            console.log(`❌ ${e.message}`);
            for (const t of chunk) { newResults.set(t.key, null); newNullCount++; }
            continue;
        }

        // ── Korak 3: Batch skinut — primijeni rezultate ──────────

        if (batchResult.skipped) {
            // Trajni skip (content_filter ili 400_too_long): spremi skip objekt
            console.log(`⚠️  ${batchResult.skip_reason}`);
            const skipObj = {
                skipped:     true,
                skip_reason: batchResult.skip_reason,
                score:       null,
                assessment:  batchResult.skip_reason,
                concerns:    [],
                enrichment:  '',
                citations:   [],
            };
            for (const t of chunk) newResults.set(t.key, skipObj);
            continue;
        }

        // ── Korak 4: Primijeni globalne citacije na svaku sekciju ─

        const { results: batchResultsMap, citations } = batchResult;
        const scores = [];

        for (let i = 0; i < chunk.length; i++) {
            const t = chunk[i];
            const r = batchResultsMap.get(i);

            if (!r) {
                // Model nije vratio rezultat za ovaj indeks (neispravan JSON iz modela)
                // → null = retry pri sljedećem pokretanju
                newResults.set(t.key, null);
                newNullCount++;
            } else {
                // Globalne citacije batcha se primjenjuju na sve sekcije u batchu
                newResults.set(t.key, {
                    score:      r.score,
                    assessment: r.assessment,
                    concerns:   r.concerns,
                    enrichment: r.enrichment,
                    citations,
                });
                if (typeof r.score === 'number') scores.push(r.score);
            }
        }

        // Log batch sažetka
        const avgScore = scores.length > 0
            ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
            : null;
        const missingCount = chunk.length - batchResultsMap.size;
        const missingStr   = missingCount > 0 ? ` | ⚠️  ${missingCount} bez rezultata` : '';
        console.log(`✅  avg score: ${avgScore ?? '?'} | ${citations.length} citata${missingStr}`);
    }

    // ── Korak 5: Rekonstruiraj enrichedIterations ─────────────────
    // Spoji: cache (existingMagisterium) + novi batch rezultati (newResults)
    // Prioritet: newResults ima prednost (može biti i null ako je failed)

    let totalScore  = 0;
    let scoredCount = 0;
    const enrichedIterations = [];

    for (let itIdx = 0; itIdx < iterations.length; itIdx++) {
        const iteration     = iterations[itIdx];
        const enrichedSections = [];

        for (let secIdx = 0; secIdx < (iteration.sections || []).length; secIdx++) {
            const section = iteration.sections[secIdx];
            const key     = `${itIdx}:${secIdx}`;

            // newResults ima prednost (može overrideati parcijalni cache s novim podacima)
            const magisterium = newResults.has(key)
                ? newResults.get(key)
                : (existingMagisterium.get(key) ?? null);

            if (magisterium && !magisterium.skipped && typeof magisterium.score === 'number') {
                totalScore += magisterium.score;
                scoredCount++;
            }

            enrichedSections.push({
                subtitle:               section.subtitle,
                screenshot_timestamp:   section.screenshot_timestamp,
                screenshot_description: section.screenshot_description,
                content:                section.content,
                keywords:               section.keywords,
                entities:               section.entities,
                magisterium,
            });
        }

        // Prosječni score iteracije (ignoriraj skipped i null)
        const itScores = enrichedSections
            .map(s => s.magisterium?.score)
            .filter(s => typeof s === 'number');
        const itAvgScore = itScores.length > 0
            ? Math.round(itScores.reduce((a, b) => a + b, 0) / itScores.length)
            : null;

        enrichedIterations.push({
            iteration_number: iteration.iteration_number,
            start_time:       iteration.start_time,
            end_time:         iteration.end_time,
            theme:            iteration.theme,
            iteration_score:  itAvgScore,
            sections:         enrichedSections,
        });
    }

    const overallScore = scoredCount > 0 ? Math.round(totalScore / scoredCount) : null;
    const totalConcerns = enrichedIterations
        .flatMap(it => it.sections)
        .reduce((sum, sec) => sum + (sec.magisterium?.concerns?.length || 0), 0);
    const isPartial = newNullCount > 0;

    const output = {
        version:              '1.0',
        generated_at:         new Date().toISOString(),
        model:                MODEL,
        batch_size:           BATCH_SIZE,
        source_article:       basename,
        overall_score:        overallScore,
        score_interpretation: overallScore !== null ? scoreInterpretation(overallScore) : null,
        score_breakdown:      enrichedIterations.map(it => ({
            iteration: it.iteration_number,
            theme:     it.theme,
            score:     it.iteration_score,
        })),
        total_concerns:       totalConcerns,
        iterations:           enrichedIterations,
    };
    if (isPartial) output.partial = true;

    if (!DRY_RUN) {
        fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    }

    if (isPartial) {
        console.log(`\n     ⏸️  Parcijalno (${newNullCount} sekcija ostalo) — nastavi sutra`);
        console.log(`        Score (za sada): ${overallScore ?? 'N/A'}/100 | → ${path.basename(outputPath)}`);
    } else {
        const interpretation = scoreInterpretation(overallScore ?? 0);
        console.log(`\n     ✅ Score: ${overallScore ?? 'N/A'}/100 — ${interpretation}`);
        console.log(`        Zabrinutosti: ${totalConcerns} | → ${path.basename(outputPath)}`);
    }

    return { done: true, overallScore, totalConcerns, partial: isPartial };
}

// --- Main ---

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   ✝️  MAGISTERIUM AI — Teološko obogaćivanje     ║');
    console.log(`║   📦 BATCH MODE (${BATCH_SIZE} sekcija/poziv)               ║`);
    console.log('╚══════════════════════════════════════════════════╝');
    if (DRY_RUN) console.log('   ⚠️  DRY RUN — nema stvarnih API poziva');

    if (!DRY_RUN) {
        console.log(`   Batch: ${BATCH_SIZE} sekcija/poziv → ~${BATCH_SIZE}× manji trošak od single mode`);
        if (API_KEYS.length === 1) {
            console.log(`   API ključ: 1 | delay: ${DELAY_MS}ms/batch`);
        } else {
            console.log(`   API ključevi: ${API_KEYS.length} | delay: ${DELAY_MS}ms/batch | throughput: ~${Math.round(60000 / DELAY_MS)} batch/min`);
        }
    }

    const filters = [
        VIDEO_ID_FILTER ? `video: ${VIDEO_ID_FILTER}` : null,
        CHANNEL_FILTER  ? `kanal: ${CHANNEL_FILTER}`  : null,
    ].filter(Boolean).join(', ');
    if (filters) console.log(`   Filtar: ${filters}`);
    console.log('');

    const files = findArticleFiles();

    if (files.length === 0) {
        console.log('  ℹ️  Nema article.json fajlova za obradu.\n');
        return;
    }

    console.log(`  Pronađeno: ${files.length} article.json fajlova\n`);

    let done = 0, skipped = 0, errors = 0, partial = 0;

    for (const file of files) {
        if (quotaExhausted) {
            console.log(`\n  ⏹️  Sve API kvote iscrpljene — preskačem preostale videe.`);
            console.log(`     Pokreni ponovno sutra za nastavak.\n`);
            break;
        }

        try {
            const result = await processArticle(file);
            if (result.skipped)      skipped++;
            else if (result.error)   errors++;
            else if (result.partial) partial++;
            else                     done++;
        } catch (e) {
            if (e.message.includes('401')) {
                console.error('\n❌ Autentifikacijska greška — zaustavljam pipeline.');
                console.error('   Provjeri API ključeve i billing na magisterium.com/developers/billing');
                break;
            }
            console.error(`  ❌ ${e.message}`);
            errors++;
        }
    }

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   ✅ OBOGAĆIVANJE ZAVRŠENO                       ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`   Obrađeno: ${done} | Parcijalno: ${partial} | Preskočeno: ${skipped} | Greške: ${errors}`);
    if (quotaExhausted) {
        console.log(`   ⏸️  API kvota iscrpljena — pokreni sutra za nastavak`);
    }
    console.log();
}

main().catch(e => {
    console.error('❌ Fatalna greška:', e.message);
    process.exit(1);
});
