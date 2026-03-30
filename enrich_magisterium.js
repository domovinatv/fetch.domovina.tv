#!/usr/bin/env node

/**
 * enrich_magisterium.js
 *
 * Korak 8.5 pipeline-a: Teološko obogaćivanje Gemini članaka citatima iz
 * katoličkih izvora i quantitativnom procjenom usklađenosti s katoličkim
 * naukom i Svetim pismom putem Magisterium AI API-ja.
 *
 * Za svaku sekciju article.json generira:
 *   - score (0-100): usklađenost s katoličkim naukom i Svetim pismom
 *   - assessment: kratka teološka procjena
 *   - concerns: eventualni teološki problemi
 *   - enrichment: teološki kontekst iz crkvenih dokumenata
 *   - citations: relevantni citati (Katekizam, enciklike, papinski govori...)
 *
 * Output: {basename}_{date}_{model}.article.magisterium.json
 *
 * Idempotentnost:
 *   - Ako output postoji i NIJE parcijalan → preskači
 *   - Ako output postoji i JEST parcijalan (partial: true) → nastavi od null sekcija
 *   - Kad su sve API kvote iscrpljene → zaustavi se, spremi parcijalni output, nastavi sutra
 *
 * Konfiguracija API ključeva (.env):
 *   Jedan ključ:    MAGISTERIUM_API_KEY=key1
 *   Više ključeva:  MAGISTERIUM_API_KEY_1=key1
 *                   MAGISTERIUM_API_KEY_2=key2
 *                   MAGISTERIUM_API_KEY_3=key3
 *   Ili inline:     MAGISTERIUM_API_KEYS=key1,key2,key3
 *
 * Usage:
 *   node enrich_magisterium.js --input-dir storage/output
 *   node enrich_magisterium.js --input-dir storage/output --channel mladi_za_domovinu
 *   node enrich_magisterium.js --input-dir storage/output --video-id H-p2Hl6x7I0
 *   node enrich_magisterium.js --input-dir storage/output --dry-run
 */

'use strict';

const fs = require('fs');
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
const MAX_RETRIES          = 3;    // Pokušaji kad su SVI ključevi u rate limitu
const MAX_CONTENT_WORDS    = 350;  // Token budget per sekciji (~700 input tokena)

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

    // Format 1: MAGISTERIUM_API_KEYS=key1,key2,key3 (inline, comma-separated)
    if (process.env.MAGISTERIUM_API_KEYS) {
        for (const k of process.env.MAGISTERIUM_API_KEYS.split(',')) {
            const trimmed = k.trim();
            if (trimmed) keys.push(trimmed);
        }
    }

    // Format 2: MAGISTERIUM_API_KEY_1, _2, _3 ... (numbered)
    for (let i = 1; i <= 20; i++) {
        const k = process.env[`MAGISTERIUM_API_KEY_${i}`];
        if (k) {
            const trimmed = k.trim();
            if (trimmed && !keys.includes(trimmed)) keys.push(trimmed);
        }
    }

    // Format 3: MAGISTERIUM_API_KEY (single, backwards compat)
    if (process.env.MAGISTERIUM_API_KEY) {
        const trimmed = process.env.MAGISTERIUM_API_KEY.trim();
        if (trimmed && !keys.includes(trimmed)) keys.push(trimmed);
    }

    return keys;
}

const API_KEYS = DRY_RUN ? ['dry-run'] : loadApiKeys();

if (API_KEYS.length === 0 && !DRY_RUN) {
    console.error('❌ Nije pronađen nijedan Magisterium API ključ.');
    console.error('   Dodaj u .env jedan od:');
    console.error('     MAGISTERIUM_API_KEY=key1');
    console.error('     MAGISTERIUM_API_KEY_1=key1');
    console.error('     MAGISTERIUM_API_KEY_2=key2');
    console.error('     MAGISTERIUM_API_KEYS=key1,key2,key3');
    process.exit(1);
}

// Delay po zahtjevu: 4500ms za 1 ključ, proporcionalno manji s više ključeva.
// Minimum 500ms da ne bombardiramo API. Svaki ključ prima efektivno 4500ms pauze
// između svojih vlastitih zahtjeva jer se ključevi rotiraju round-robin.
const DELAY_MS = Math.max(500, Math.round(4500 / API_KEYS.length));

// --- Stanje rotacije ključeva ---

let keyRoundRobin = 0;              // Sljedeći ključ u redu
const keyDailyExhausted = new Set(); // Ključevi s iscrpljenom dnevnom kvotom

// Vraća indeks sljedećeg dostupnog ključa (round-robin, preskači iscrpljene).
// Ako su svi iscrpljeni, vraća -1.
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

// --- Global quota state ---
// Postavljeno kad su SVI ključevi dnevno iscrpljeni.
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

// --- Magisterium API call s rotacijom ključeva ---
//
// Strategija:
//   1. Uzmi sljedeći dostupan ključ (round-robin, preskoči iscrpljene i već pokušane)
//   2. Na 429: ključ je rate limited → dodaj ga u triedKeys, odmah probaj sljedeći ključ
//   3. Kad su svi raspoloživi ključevi u triedKeys (svi 429 u ovom pozivu):
//      → čekaj 60s × retries, resetiraj triedKeys, pokušaj ponovo
//   4. Nakon MAX_RETRIES rundi "svi ključevi 429":
//      → postavi quotaExhausted = true, baci grešku
//   Dnevno iscrpljeni ključevi (persistent 429 bez napretka) → dodaju se u keyDailyExhausted

async function callMagisterium(prompt, triedKeys = new Set(), retries = 0) {
    if (DRY_RUN) {
        return {
            score: 85,
            assessment: '[dry-run] Simulirani rezultat.',
            concerns: [],
            enrichment: '[dry-run] Teološki kontekst bi bio ovdje.',
            citations: [],
        };
    }

    const keyIdx = getNextKeyIdx(triedKeys);

    if (keyIdx === -1) {
        // Svi ključevi su ili dnevno iscrpljeni ili su već pokušani u ovom pozivu
        if (keyDailyExhausted.size === API_KEYS.length) {
            // Sve kvote iscrpljene — nema čekanja, gotovo za danas
            quotaExhausted = true;
            throw new Error('Rate limit — sve API kvote iscrpljene za danas');
        }
        // Svi preostali ključevi su rate-limited u ovom pozivu → čekaj i pokušaj ponovo
        if (retries >= MAX_RETRIES) {
            quotaExhausted = true;
            throw new Error('Rate limit — premašen broj pokušaja na svim ključevima');
        }
        const wait = 60_000 * (retries + 1);
        console.log(`\n  ⏳ Svi ključevi rate limited, čekam ${wait / 1000}s (pokušaj ${retries + 1}/${MAX_RETRIES})...`);
        await sleep(wait);
        return callMagisterium(prompt, new Set(), retries + 1);
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
                    // Domovina TV sadržaj je katolički — isključi filter da rubne
                    // teme (politika, kultura) ne budu lažno blokirane
                    CATEGORY_NON_CATHOLIC: { threshold: 'OFF', response: false },
                },
            }),
        });
    } catch (e) {
        // Mrežna greška — pokušaj isti ključ ponovo (ne rotira)
        if (retries < MAX_RETRIES) {
            console.log(`\n  ⚠️  Mrežna greška${keyLabel(keyIdx)} (${e.message}), pokušaj ${retries + 1}/${MAX_RETRIES}...`);
            await sleep(5000 * (retries + 1));
            return callMagisterium(prompt, triedKeys, retries + 1);
        }
        throw e;
    }

    if (response.status === 429) {
        // Ovaj ključ je rate limited → dodaj u pokušane, odmah probaj sljedeći
        triedKeys.add(keyIdx);
        const remaining = API_KEYS.length - keyDailyExhausted.size - triedKeys.size;
        if (remaining > 0) {
            console.log(`\n  🔄 Rate limit${keyLabel(keyIdx)}, prelazim na sljedeći ključ (${remaining} preostalo)...`);
        }
        return callMagisterium(prompt, triedKeys, retries);
    }

    if (response.status === 401) {
        throw new Error(`Autentifikacijska greška (401)${keyLabel(keyIdx)} — provjeri API ključ i billing`);
    }

    if (response.status === 400) {
        // Token limit exceeded — trajna preskočena sekcija (ne retryaj)
        console.log(` ⚠️  400 (prompt predugačak)${keyLabel(keyIdx)}, preskačem`);
        return { skipped: true, skip_reason: '400_too_long', score: null, assessment: '', concerns: [], enrichment: '', citations: [] };
    }

    if (response.status >= 500) {
        if (retries < MAX_RETRIES) {
            console.log(`\n  ⚠️  Server greška (${response.status})${keyLabel(keyIdx)}, pokušaj ${retries + 1}/${MAX_RETRIES}...`);
            await sleep(10_000 * (retries + 1));
            return callMagisterium(prompt, triedKeys, retries + 1);
        }
        throw new Error(`Server greška ${response.status} nakon ${MAX_RETRIES} pokušaja`);
    }

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Magisterium API ${response.status}${keyLabel(keyIdx)}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();

    // Content filter (analogno Gemini PROHIBITED_CONTENT) — trajna preskočena sekcija
    if (data.choices?.[0]?.finish_reason === 'content_filter') {
        console.log(` ⚠️  content_filter${keyLabel(keyIdx)}, preskačem`);
        return { skipped: true, skip_reason: 'content_filter', score: null, assessment: 'content_filter', concerns: [], enrichment: '', citations: [] };
    }

    // Parse JSON iz odgovora — strippi markdown code fence ako model doda ```json ... ```
    let parsed = {};
    try {
        let raw = data.choices[0].message.content;
        raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        parsed = JSON.parse(raw);
    } catch {
        // Model nije vratio validan JSON unatoč response_format — spasi što možemo
        parsed = { assessment: data.choices[0].message.content, score: null, concerns: [] };
    }

    const rawScore = parsed.score;
    const score = (typeof rawScore === 'number')
        ? Math.round(Math.min(100, Math.max(0, rawScore)))
        : null;

    return {
        score,
        assessment:  parsed.assessment  || '',
        concerns:    Array.isArray(parsed.concerns) ? parsed.concerns : [],
        enrichment:  parsed.enrichment  || '',
        citations:   (data.citations ?? []).map(c => ({
            cited_text:         c.cited_text,
            document_title:     c.document_title,
            document_author:    c.document_author,
            document_year:      c.document_year,
            document_reference: c.document_reference,
            source_url:         c.source_url,
        })),
    };
}

// --- Build prompt ---

function buildPrompt(podcastTitle, iterationTheme, section) {
    const content  = trimToWords(section.content || '', MAX_CONTENT_WORDS);
    const keywords = (section.keywords || []).join(', ');
    const entities = (section.entities || []).join(', ');

    return `Ti si teološki analitičar. Evaluiraj usklađenost sljedećeg odlomka iz katoličkog podcasta s katoličkim naukom i Svetim pismom. Vrati ISKLJUČIVO JSON bez komentara.

Podcast: ${podcastTitle}
Tema bloka: ${iterationTheme}
Tema sekcije: ${section.subtitle}
Ključni pojmovi: ${keywords}${entities ? `\nSpomenute osobe/organizacije: ${entities}` : ''}

Sadržaj:
${content}

Vrati JSON točno ovog oblika:
{
  "score": <cijeli broj 0-100>,
  "assessment": "<1-2 rečenice teološke procjene na hrvatskom>",
  "concerns": ["<eventualni teološki problemi ili nejasnoće, prazna lista ako nema>"],
  "enrichment": "<2-3 rečenice teološkog konteksta koji obogaćuje razumijevanje sadržaja>"
}

Skala usklađenosti s katoličkim naukom i Svetim pismom:
90-100 = aktivno promiče i produbljuje katolički nauk
70-89  = uglavnom usklađeno, bez bitnih problema
50-69  = djelomično usklađeno, postoje nejasnoće ili izostavljanja
30-49  = značajno odstupanje od crkvenog nauka
0-29   = proturječi katoličkom nauku ili Svetom pismu`;
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

    // Najnoviji first (po datumu u imenu fajla _YYYY-MM-DD_)
    files.sort((a, b) => b.basename.localeCompare(a.basename));
    return files;
}

// --- Process one article.json ---

async function processArticle({ channel, articlePath, basename }) {
    const outputPath = articlePath.replace(/\.article\.json$/, '.article.magisterium.json');

    // Provjeri postoji li output — i je li kompletan ili parcijalan.
    // Parcijalnost detektiramo SADRŽAJEM (null sekcije), ne po partial flagu,
    // jer starije datoteke nemaju flag ali mogu imati null sekcije.
    let existingOutput = null;
    if (fs.existsSync(outputPath)) {
        try {
            existingOutput = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
        } catch {
            existingOutput = null; // Koruptirana datoteka — re-obradi
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

    // Dohvati naslov podcasta iz summary.json (best-effort)
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
    if (existingOutput?.partial) {
        const existingDone = (existingOutput.iterations || [])
            .flatMap(it => it.sections)
            .filter(s => s.magisterium !== null).length;
        console.log(`     Nastavljam od sekcije ~${existingDone + 1}...`);
    }

    // Izgradi lookup mapu iz postojećeg parcijalnog outputa:
    //   ključ = "{iterationIndex}:{sectionIndex}" → existing magisterium result (ili null)
    const existingMagisterium = new Map();
    if (existingOutput?.iterations) {
        existingOutput.iterations.forEach((it, itIdx) => {
            (it.sections || []).forEach((sec, secIdx) => {
                // null = nije obrađeno (treba retry)
                // objekt = obrađeno (čak i ako je { skipped: true })
                existingMagisterium.set(`${itIdx}:${secIdx}`, sec.magisterium ?? null);
            });
        });
    }

    let processedSections = 0;
    let totalScore = 0;
    let scoredCount = 0;
    let newNullCount = 0; // Sekcije koje su ostale null jer je kvota iscrpljena

    const enrichedIterations = [];

    for (let itIdx = 0; itIdx < iterations.length; itIdx++) {
        const iteration = iterations[itIdx];
        const enrichedSections = [];

        for (let secIdx = 0; secIdx < (iteration.sections || []).length; secIdx++) {
            const section = iteration.sections[secIdx];
            processedSections++;
            const label = `${section.subtitle || ''}`.slice(0, 45).padEnd(46);
            process.stdout.write(`     [${processedSections}/${totalSections}] ${label}`);

            const existingResult = existingMagisterium.get(`${itIdx}:${secIdx}`);

            let result;

            if (existingResult !== undefined && existingResult !== null) {
                // Sekcija već obrađena u parcijalnom outputu — zadrži
                result = existingResult;
                const scoreStr = result.score !== null ? `score: ${result.score}` : 'score: ?';
                const citCount = result.citations?.length ?? 0;
                console.log(`♻️  ${scoreStr} | ${citCount} citata (parcijalni output)`);
            } else if (quotaExhausted) {
                // Kvota iscrpljena — preskači bez API poziva
                console.log('⏭️  (kvota iscrpljena — nastavi sutra)');
                result = null;
                newNullCount++;
            } else {
                // Nova sekcija — pozovi API
                if (!DRY_RUN) await sleep(DELAY_MS);

                try {
                    result = await callMagisterium(buildPrompt(podcastTitle, iteration.theme, section));
                } catch (e) {
                    if (e.message.includes('401')) throw e; // Abort
                    process.stdout.write(`❌ ${e.message}\n`);
                    result = null;
                    newNullCount++;
                }

                if (result !== null) {
                    if (result.skipped) {
                        console.log(`⚠️  preskočeno (${result.skip_reason})`);
                    } else {
                        const scoreStr = result.score !== null ? `score: ${result.score}` : 'score: ?';
                        console.log(`✅  ${scoreStr} | ${result.citations.length} citata`);
                    }
                } else if (!quotaExhausted) {
                    console.log('⚠️  preskočeno');
                }
            }

            if (result && !result.skipped && result.score !== null) {
                totalScore += result.score;
                scoredCount++;
            }

            enrichedSections.push({
                subtitle:               section.subtitle,
                screenshot_timestamp:   section.screenshot_timestamp,
                screenshot_description: section.screenshot_description,
                content:                section.content,
                keywords:               section.keywords,
                entities:               section.entities,
                magisterium: result,  // null = nije obrađeno; objekt = obrađeno (ili skipped)
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

    // partial: true ako ima sekcija koje nisu obrađene (null) — re-pokretanje će nastaviti
    const isPartial = newNullCount > 0;

    const output = {
        version:             '1.0',
        generated_at:        new Date().toISOString(),
        model:               MODEL,
        source_article:      basename,
        overall_score:       overallScore,
        score_interpretation: overallScore !== null ? scoreInterpretation(overallScore) : null,
        score_breakdown:     enrichedIterations.map(it => ({
            iteration: it.iteration_number,
            theme:     it.theme,
            score:     it.iteration_score,
        })),
        total_concerns:      totalConcerns,
        iterations:          enrichedIterations,
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
    console.log('╚══════════════════════════════════════════════════╝');
    if (DRY_RUN) console.log('   ⚠️  DRY RUN — nema stvarnih API poziva');

    if (!DRY_RUN) {
        if (API_KEYS.length === 1) {
            console.log(`   API ključ: 1 ključ | delay: ${DELAY_MS}ms`);
        } else {
            console.log(`   API ključevi: ${API_KEYS.length} ključa | delay: ${DELAY_MS}ms po zahtjevu`);
            console.log(`   Efektivni throughput: ~${Math.round(60000 / DELAY_MS)} req/min ukupno`);
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
        // Ako su sve kvote iscrpljene, ne pokušavaj više novih videa
        if (quotaExhausted) {
            console.log(`\n  ⏹️  Sve API kvote iscrpljene — preskačem preostale videe.`);
            console.log(`     Pokreni ponovno sutra za nastavak.\n`);
            break;
        }

        try {
            const result = await processArticle(file);
            if (result.skipped) skipped++;
            else if (result.error) errors++;
            else if (result.partial) partial++;
            else done++;
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
