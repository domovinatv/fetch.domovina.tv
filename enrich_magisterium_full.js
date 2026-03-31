#!/usr/bin/env node

/**
 * enrich_magisterium_full.js
 *
 * Korak 8.5 pipeline-a (FULL varijanta): Holističko teološko obogaćivanje
 * cijeloga podcasta u JEDNOM API pozivu na Magisterium AI.
 *
 * Razlika od enrich_magisterium.js i enrich_magisterium_batch.js:
 *   - Šalje CIJELI podcast (article.json + outline.json) kao jedan prompt.
 *   - Magisterium AI vraća jednu sveobuhvatnu evaluaciju (score, procjena,
 *     pozitivni elementi, zabrinutosti, teološki kontekst, score po blokovima).
 *   - Prompt se sprema na disk kao .md datoteka — bilo tko može isti prompt
 *     kopirati u https://www.magisterium.com/ web chat i dobiti isti odgovor.
 *   - Odgovor je prirodni tekst (markdown), ne JSON — identičan web chatu.
 *
 * Input:
 *   - {basename}.article.json   — Gemini generirani članak (iteracije + sekcije)
 *   - {basename}.outline.json   — Gemini semantički outline (poglavlja + timestampovi)
 *   - {basename}.canary.summary.json — naslov podcasta (best-effort)
 *
 * Output:
 *   - {basename}.article.magisterium_full_prompt.md  — prompt poslan API-ju
 *   - {basename}.article.magisterium_full.json       — strukturirani output
 *
 * System prompt se čita iz:
 *   storage/meta/magisterium_prompts/system_prompt.md
 *   (fallback: embedded u skripti)
 *
 * Idempotentnost:
 *   - Ako output JSON postoji → preskači
 *   - Prompt .md se uvijek regenerira (jeftin, bez API poziva)
 *
 * Usage:
 *   node enrich_magisterium_full.js --input-dir storage/output
 *   node enrich_magisterium_full.js --input-dir storage/output --channel mladi_za_domovinu
 *   node enrich_magisterium_full.js --input-dir storage/output --video-id 33MwE_onSDY
 *   node enrich_magisterium_full.js --input-dir storage/output --dry-run
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
const MAX_RETRIES          = 3;

// Učitaj .env ako postoji
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
}

// --- Učitaj API ključeve (identično kao enrich_magisterium.js) ---

function loadApiKeys() {
    const keys = [];
    if (process.env.MAGISTERIUM_API_KEYS) {
        for (const k of process.env.MAGISTERIUM_API_KEYS.split(',')) {
            const t = k.trim();
            if (t) keys.push(t);
        }
    }
    for (let i = 1; i <= 20; i++) {
        const k = process.env[`MAGISTERIUM_API_KEY_${i}`];
        if (k) {
            const t = k.trim();
            if (t && !keys.includes(t)) keys.push(t);
        }
    }
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

const DELAY_MS = Math.max(500, Math.round(4500 / API_KEYS.length));

// --- Stanje rotacije ključeva ---

let keyRoundRobin = 0;
const keyDailyExhausted = new Set();
let quotaExhausted = false;

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

// --- Helpers ---

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readJson(filePath) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
    catch { return null; }
}

function scoreInterpretation(score) {
    if (score >= 90) return 'Aktivno promiče katolički nauk';
    if (score >= 70) return 'Uglavnom usklađeno';
    if (score >= 50) return 'Djelomično usklađeno, nejasnoće';
    if (score >= 30) return 'Odstupanje od crkvenog nauka';
    return 'Proturječi katoličkom nauku ili Pismu';
}

// --- System prompt ---
// Čita iz storage/meta/magisterium_prompts/system_prompt.md, s embedded fallbackom.

const SYSTEM_PROMPT_PATH = path.join(__dirname, 'storage', 'meta', 'magisterium_prompts', 'system_prompt.md');

const EMBEDDED_SYSTEM_PROMPT = `Ti si stručni teološki analitičar Katoličke Crkve. Tvoj je zadatak objektivno evaluirati priloženi tekst (sažetak podcasta) isključivo temeljem katoličkog nauka, socijalnog nauka Crkve i Svetog pisma.

VAŽNO PRAVILO: Analiziraj isključivo informacije koje su eksplicitno navedene u tekstu. Ne izmišljaj izjave gostiju i ne pretpostavljaj kontekst koji nije napisan. Tvoj izlaz mora biti strogo strukturiran u točno 6 numeriranih točaka. ZABRANJENO je korištenje tablica u odgovoru, koristi isključivo tekst i obične liste (bullet points).

Za cijeli tekst daj JEDNU sveobuhvatnu evaluaciju točno ovim redoslijedom:

1. **Ukupni score (0-100)** usklađenosti s katoličkim naukom i Svetim pismom. (Koristi skalu: 90-100 = aktivno promiče; 70-89 = uglavnom usklađeno; 50-69 = djelomično usklađeno/nejasnoće; 30-49 = značajno odstupanje; 0-29 = proturječi nauku).
2. **Teološka procjena** (3 do 5 rečenica) — Sažeta sinteza onoga što je u tekstu teološki relevantno, a što neutralno.
3. **Pozitivni elementi** — Konkretni primjeri iz teksta gdje se aktivno promiču kršćanske vrijednosti i dostojanstvo osobe.
4. **Zabrinutosti** — Eventualna teološka odstupanja, rizici ili nejasnoće u iznesenim stavovima.
5. **Teološki kontekst** — Relevantni crkveni dokumenti koji se izravno tiču tema.
   *UPOZORENJE:* Navodi isključivo temeljne enciklike, Katekizam Katoličke Crkve (KKC) i opće poznate dokumente (npr. Laudato Si', Gaudium et Spes, dokumenti ekumenskih sabora). STROGO ZABRANJENO: Ne navodi lokalne govore, obraćanja pojedinim političarima ili opskurne dokumente. Ako nisi 100% siguran u izravnu teološku poveznicu dokumenta i teme, izostavi ga!
6. **Score po tematskim blokovima** — Za svaki dostavljeni blok navedi njegov naziv, pripadajući score (0-100) i jednu rečenicu teološke procjene. (Ponavljam: koristi tekstualnu listu, NE tablicu).`;

function loadSystemPrompt() {
    try {
        if (fs.existsSync(SYSTEM_PROMPT_PATH)) {
            const content = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8').trim();
            if (content.length > 100) return content;
        }
    } catch {}
    return EMBEDDED_SYSTEM_PROMPT;
}

// --- Build full markdown prompt ---
//
// Spaja system prompt + article sadržaj + outline strukturu u jedan
// markdown dokument koji je identičan onome što bi se zalijepilo u
// Magisterium web chat.

function buildPrompt(systemPrompt, article, outline, podcastTitle) {
    const lines = [systemPrompt, '\n---\n', `# ${podcastTitle}\n`];

    const iterations = article.iterations || [];
    const outlineIterations = outline?.iterations || [];

    for (let itIdx = 0; itIdx < iterations.length; itIdx++) {
        const iteration = iterations[itIdx];
        const oit = itIdx < outlineIterations.length ? outlineIterations[itIdx] : null;

        lines.push(`\n## Blok ${itIdx + 1}: ${iteration.theme}\n`);

        if (oit) {
            lines.push(`*Vremenski raspon: ${oit.start_time || '?'} – ${oit.end_time || '?'}*\n`);
            const chapters = oit.chapters || [];
            if (chapters.length > 0) {
                lines.push('**Poglavlja:**');
                for (const ch of chapters) {
                    lines.push(`- [${ch.timestamp}] ${ch.topic}`);
                }
                lines.push('');
            }
        }

        for (const sec of (iteration.sections || [])) {
            lines.push(`### ${sec.subtitle}`);
            if (sec.keywords && sec.keywords.length > 0) {
                lines.push(`*Ključni pojmovi: ${sec.keywords.join(', ')}*`);
            }
            if (sec.entities && sec.entities.length > 0) {
                lines.push(`*Osobe/organizacije: ${sec.entities.join(', ')}*`);
            }
            lines.push(`\n${sec.content || ''}\n`);
        }
    }

    return lines.join('\n');
}

// --- Magisterium API call s rotacijom ključeva ---
// Identična strategija kao enrich_magisterium.js, ali BEZ response_format: json_object
// jer želimo prirodan markdown odgovor (identičan web chatu).

async function callMagisterium(prompt, triedKeys = new Set(), retries = 0) {
    if (DRY_RUN) {
        return {
            text: '1. **Ukupni score: 85/100**\n\n2. **Teološka procjena** — [dry-run] Simulirani rezultat.\n\n3. **Pozitivni elementi** — [dry-run]\n\n4. **Zabrinutosti** — Nema.\n\n5. **Teološki kontekst** — [dry-run]\n\n6. **Score po blokovima:**\n- Blok 1: 85 — [dry-run]',
            citations: [],
        };
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
                // BEZ response_format: json_object — želimo prirodan markdown odgovor
                safety_settings: {
                    CATEGORY_NON_CATHOLIC: { threshold: 'OFF', response: false },
                },
            }),
        });
    } catch (e) {
        if (retries < MAX_RETRIES) {
            console.log(`\n  ⚠️  Mrežna greška${keyLabel(keyIdx)} (${e.message}), pokušaj ${retries + 1}/${MAX_RETRIES}...`);
            await sleep(5000 * (retries + 1));
            return callMagisterium(prompt, triedKeys, retries + 1);
        }
        throw e;
    }

    if (response.status === 429) {
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
        throw new Error(`Prompt predugačak (400)${keyLabel(keyIdx)} — skrati članak ili koristi batch mode`);
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

    if (data.choices?.[0]?.finish_reason === 'content_filter') {
        return {
            text: '[content_filter] Magisterium AI je odbio evaluirati ovaj sadržaj.',
            citations: [],
            filtered: true,
        };
    }

    const text = data.choices?.[0]?.message?.content || '';

    const citations = (data.citations ?? []).map(c => ({
        cited_text:         c.cited_text,
        document_title:     c.document_title,
        document_author:    c.document_author,
        document_year:      c.document_year,
        document_reference: c.document_reference,
        source_url:         c.source_url,
    }));

    return { text, citations };
}

// --- Parse score iz markdown odgovora ---
// Traži "score: NN" ili "score (0-100): NN" ili "**NN/100**" paterne.

function parseScoreFromText(text) {
    // Pokušaj: "score: 85" ili "score (0-100): 85" ili "Score: 85/100"
    const patterns = [
        /score[:\s]*(\d{1,3})\s*\/?\s*100/i,
        /score[^:]*:\s*(\d{1,3})/i,
        /\*\*(\d{1,3})\/100\*\*/,
        /\*\*(\d{1,3})\*\*\s*\/\s*100/,
    ];
    for (const pat of patterns) {
        const m = text.match(pat);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n >= 0 && n <= 100) return n;
        }
    }
    return null;
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

    files.sort((a, b) => b.basename.localeCompare(a.basename));
    return files;
}

// --- Process one article ---

async function processArticle({ channel, articlePath, basename }) {
    const outputPath = articlePath.replace(/\.article\.json$/, '.article.magisterium_full.json');
    const promptPath = articlePath.replace(/\.article\.json$/, '.article.magisterium_full_prompt.md');

    // Idempotentnost: preskači ako output JSON postoji
    if (fs.existsSync(outputPath)) {
        console.log(`  ⏭️  Preskačem (već postoji): ${path.basename(outputPath)}`);
        return { skipped: true };
    }

    // Učitaj article.json
    const article = readJson(articlePath);
    if (!article) {
        console.error(`  ❌ Ne mogu pročitati ${basename}`);
        return { error: true };
    }

    // Učitaj outline.json (isti basename, .outline.json umjesto .article.json)
    const outlinePath = articlePath.replace(/\.article\.json$/, '.outline.json');
    const outline = readJson(outlinePath); // null je OK — radi i bez outlinea

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
    console.log(`     Iteracije: ${iterations.length} | Sekcije: ${totalSections} | Outline: ${outline ? 'da' : 'ne'}`);

    // Izgradi prompt
    const systemPrompt = loadSystemPrompt();
    const prompt = buildPrompt(systemPrompt, article, outline, podcastTitle);

    console.log(`     Prompt: ${prompt.length} znakova (${prompt.split(/\s+/).length} riječi)`);

    // Zapiši prompt na disk (uvijek, neovisno o API pozivu)
    if (!DRY_RUN) {
        fs.writeFileSync(promptPath, prompt, 'utf-8');
        console.log(`     → ${path.basename(promptPath)}`);
    }

    // Pozovi Magisterium AI
    process.stdout.write('     🔄 Magisterium AI... ');

    if (!DRY_RUN) await sleep(DELAY_MS);

    let result;
    try {
        result = await callMagisterium(prompt);
    } catch (e) {
        console.log(`❌ ${e.message}`);
        return { error: true };
    }

    // Parsiraj score iz teksta
    const overallScore = parseScoreFromText(result.text);

    if (result.filtered) {
        console.log('⚠️  content_filter');
    } else {
        const scoreStr = overallScore !== null ? `score: ${overallScore}/100` : 'score: N/A';
        console.log(`✅  ${scoreStr} | ${result.citations.length} citata | ${result.text.length} znakova odgovora`);
    }

    // Spremi output
    const output = {
        version:              '1.0',
        generated_at:         new Date().toISOString(),
        model:                MODEL,
        source_article:       basename,
        prompt_file:          path.basename(promptPath),
        prompt_length_chars:  prompt.length,
        overall_score:        overallScore,
        score_interpretation: overallScore !== null ? scoreInterpretation(overallScore) : null,
        evaluation:           result.text,
        citations:            result.citations,
    };

    if (!DRY_RUN) {
        fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
        console.log(`     → ${path.basename(outputPath)}`);
    }

    return { done: true, overallScore };
}

// --- Main ---

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   ✝️  MAGISTERIUM AI — Holističko obogaćivanje   ║');
    console.log('║   📄 FULL MODE (cijeli podcast / 1 API poziv)   ║');
    console.log('╚══════════════════════════════════════════════════╝');
    if (DRY_RUN) console.log('   ⚠️  DRY RUN — nema stvarnih API poziva');

    if (!DRY_RUN) {
        if (API_KEYS.length === 1) {
            console.log(`   API ključ: 1 | delay: ${DELAY_MS}ms`);
        } else {
            console.log(`   API ključevi: ${API_KEYS.length} | delay: ${DELAY_MS}ms`);
        }
    }

    // System prompt info
    const spFromFile = fs.existsSync(SYSTEM_PROMPT_PATH);
    console.log(`   System prompt: ${spFromFile ? SYSTEM_PROMPT_PATH : 'embedded fallback'}`);

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
        if (quotaExhausted) {
            console.log(`\n  ⏹️  Sve API kvote iscrpljene — preskačem preostale videe.`);
            console.log(`     Pokreni ponovno sutra za nastavak.\n`);
            break;
        }

        try {
            const result = await processArticle(file);
            if (result.skipped)    skipped++;
            else if (result.error) errors++;
            else                   done++;
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
    console.log(`   Obrađeno: ${done} | Preskočeno: ${skipped} | Greške: ${errors}`);
    if (quotaExhausted) {
        console.log(`   ⏸️  API kvota iscrpljena — pokreni sutra za nastavak`);
    }
    console.log();
}

main().catch(e => {
    console.error('❌ Fatalna greška:', e.message);
    process.exit(1);
});
