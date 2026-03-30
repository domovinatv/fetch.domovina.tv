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

const INPUT_DIR    = getArg('--input-dir') || path.join(__dirname, 'storage', 'output');
const CHANNEL_FILTER  = getArg('--channel');
const VIDEO_ID_FILTER = getArg('--video-id');
const DRY_RUN      = args.includes('--dry-run');

// --- Config ---
const MAGISTERIUM_API_KEY  = process.env.MAGISTERIUM_API_KEY;
const MAGISTERIUM_ENDPOINT = 'https://www.magisterium.com/api/v1/chat/completions';
const MODEL                = 'magisterium-1';
const DELAY_MS             = 4500;   // 15 req/min — sigurnosna margina
const MAX_RETRIES          = 3;
const MAX_CONTENT_WORDS    = 350;    // Token budget per sekciji (~700 input tokena)

// Učitaj .env ako postoji
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.+)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
}

if (!process.env.MAGISTERIUM_API_KEY && !DRY_RUN) {
    console.error('❌ MAGISTERIUM_API_KEY nije postavljen u .env ili environment varijablama');
    console.error('   Dodaj u .env: MAGISTERIUM_API_KEY=tvoj_kljuc');
    process.exit(1);
}

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

// --- Magisterium API call ---

async function callMagisterium(prompt, retries = 0) {
    if (DRY_RUN) {
        return {
            score: 85,
            assessment: '[dry-run] Simulirani rezultat.',
            concerns: [],
            enrichment: '[dry-run] Teološki kontekst bi bio ovdje.',
            citations: [],
        };
    }

    let response;
    try {
        response = await fetch(MAGISTERIUM_ENDPOINT, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.MAGISTERIUM_API_KEY}`,
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
        if (retries < MAX_RETRIES) {
            console.log(`\n  ⚠️  Mrežna greška (${e.message}), pokušaj ${retries + 1}/${MAX_RETRIES}...`);
            await sleep(5000 * (retries + 1));
            return callMagisterium(prompt, retries + 1);
        }
        throw e;
    }

    if (response.status === 429) {
        if (retries >= MAX_RETRIES) throw new Error('Rate limit — premašen broj pokušaja');
        const wait = 60_000 * (retries + 1);
        console.log(`\n  ⏳ Rate limit (429), čekam ${wait / 1000}s...`);
        await sleep(wait);
        return callMagisterium(prompt, retries + 1);
    }

    if (response.status === 401) {
        throw new Error('Autentifikacijska greška (401) — provjeri MAGISTERIUM_API_KEY i billing');
    }

    if (response.status === 400) {
        // Token limit exceeded — soft skip za ovu sekciju
        console.log(' ⚠️  400 (prompt predugačak), preskačem');
        return null;
    }

    if (response.status >= 500) {
        if (retries < MAX_RETRIES) {
            console.log(`\n  ⚠️  Server greška (${response.status}), pokušaj ${retries + 1}/${MAX_RETRIES}...`);
            await sleep(10_000 * (retries + 1));
            return callMagisterium(prompt, retries + 1);
        }
        throw new Error(`Server greška ${response.status} nakon ${MAX_RETRIES} pokušaja`);
    }

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Magisterium API ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();

    // Content filter (analogno Gemini PROHIBITED_CONTENT)
    if (data.choices?.[0]?.finish_reason === 'content_filter') {
        console.log(' ⚠️  content_filter, preskačem');
        return null;
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

    if (fs.existsSync(outputPath)) {
        console.log(`  ⏭️  Preskačem (već postoji): ${path.basename(outputPath)}`);
        return { skipped: true };
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

    let processedSections = 0;
    let totalScore = 0;
    let scoredCount = 0;

    const enrichedIterations = [];

    for (const iteration of iterations) {
        const enrichedSections = [];

        for (const section of (iteration.sections || [])) {
            processedSections++;
            const label = `${section.subtitle || ''}`.slice(0, 45).padEnd(46);
            process.stdout.write(`     [${processedSections}/${totalSections}] ${label}`);

            if (!DRY_RUN) await sleep(DELAY_MS);

            let result = null;
            try {
                result = await callMagisterium(buildPrompt(podcastTitle, iteration.theme, section));
            } catch (e) {
                if (e.message.includes('401')) throw e; // Abort
                process.stdout.write(`❌ ${e.message}\n`);
                result = null;
            }

            if (result) {
                const scoreStr = result.score !== null ? `score: ${result.score}` : 'score: ?';
                console.log(`✅  ${scoreStr} | ${result.citations.length} citata`);
                if (result.score !== null) { totalScore += result.score; scoredCount++; }
            } else {
                console.log('⚠️  preskočeno');
            }

            enrichedSections.push({
                subtitle:               section.subtitle,
                screenshot_timestamp:   section.screenshot_timestamp,
                screenshot_description: section.screenshot_description,
                content:                section.content,
                keywords:               section.keywords,
                entities:               section.entities,
                magisterium: result ? {
                    score:       result.score,
                    assessment:  result.assessment,
                    concerns:    result.concerns,
                    enrichment:  result.enrichment,
                    citations:   result.citations,
                } : null,
            });
        }

        // Prosječni score iteracije
        const itScores = enrichedSections
            .map(s => s.magisterium?.score)
            .filter(s => s !== null && s !== undefined);
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

    const output = {
        version:           '1.0',
        generated_at:      new Date().toISOString(),
        model:             MODEL,
        source_article:    basename,
        overall_score:     overallScore,
        score_interpretation: overallScore !== null ? scoreInterpretation(overallScore) : null,
        score_breakdown:   enrichedIterations.map(it => ({
            iteration: it.iteration_number,
            theme:     it.theme,
            score:     it.iteration_score,
        })),
        total_concerns:    totalConcerns,
        iterations:        enrichedIterations,
    };

    if (!DRY_RUN) {
        fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    }

    const interpretation = scoreInterpretation(overallScore ?? 0);
    console.log(`\n     ✅ Score: ${overallScore ?? 'N/A'}/100 — ${interpretation}`);
    console.log(`        Zabrinutosti: ${totalConcerns} | → ${path.basename(outputPath)}`);

    return { done: true, overallScore, totalConcerns };
}

// --- Main ---

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   ✝️  MAGISTERIUM AI — Teološko obogaćivanje     ║');
    console.log('╚══════════════════════════════════════════════════╝');
    if (DRY_RUN) console.log('   ⚠️  DRY RUN — nema stvarnih API poziva');

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

    let done = 0, skipped = 0, errors = 0;

    for (const file of files) {
        try {
            const result = await processArticle(file);
            if (result.skipped) skipped++;
            else if (result.error) errors++;
            else done++;
        } catch (e) {
            if (e.message.includes('401')) {
                console.error('\n❌ Autentifikacijska greška — zaustavljam pipeline.');
                console.error('   Provjeri MAGISTERIUM_API_KEY i billing na magisterium.com/developers/billing');
                break;
            }
            console.error(`  ❌ ${e.message}`);
            errors++;
        }
    }

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   ✅ OBOGAĆIVANJE ZAVRŠENO                       ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`   Obrađeno: ${done} | Preskočeno: ${skipped} | Greške: ${errors}\n`);
}

main().catch(e => {
    console.error('❌ Fatalna greška:', e.message);
    process.exit(1);
});
