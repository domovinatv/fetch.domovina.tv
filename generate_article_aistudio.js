#!/usr/bin/env node

/**
 * generate_article_aistudio.js
 *
 * AI Studio varijanta — koristi API key autentikaciju i gemini-3-flash-preview.
 * Za usporedbu kvalitete s generate_article_gemini.js (Vertex AI, gemini-2.5-flash).
 *
 * Primjer pokretanja:
 *   node generate_article_aistudio.js --file /path/to/transcript.srt --gemini-key TVOJ_KLJUC
 *
 * NAPOMENA: Ovo koristi AI Studio endpoint (generativelanguage.googleapis.com)
 * i naplaćuje se direktno na karticu, NE troši GCP kredite!
 */

const fs = require("fs");
const path = require("path");

// ─── KONFIGURACIJA ───────────────────────────────────────────────

const GEMINI_MODEL = "gemini-3-flash-preview";

// AI Studio endpoint (API key auth, naplaćuje karticu!)
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const REQUEST_DELAY_MS = 5000;
const MAX_RETRIES = 10;
const RETRY_BASE_DELAY_MS = 10000;

// ─── SYSTEM PROMPTOVI ────────────────────────────────────────────

const SYSTEM_PROMPT_1 = `Uloga: Ti si glavni urednik i arhitekt sadržaja. Tvoj jedini zadatak je analizirati sirovi diarizirani SRT transkript dugačkog podcasta i napraviti detaljan semantički nacrt (outline). U OVOM KORAKU NE PIŠEŠ ČLANAK. Tvoj izlaz mora biti isključivo validan JSON format.

Tvoj zadatak: Pročitaj cijeli tekst i podijeli ga u logične tematske cjeline (iteracije).

Stroga pravila za podjelu:
VELIČINA BLOKA: Svaka iteracija treba obuhvaćati otprilike 35 do 45 minuta razgovora.
PAMETNI REZOVI: Strogi vremenski rezovi (npr. točno na 40:00) su strogo zabranjeni. Rez (kraj jedne i početak druge iteracije) moraš napraviti ISKLJUČIVO na prirodnoj promjeni velike teme. Nikada ne smiješ prerezati misao, rečenicu ili anegdotu na pola.
IDENTIFIKACIJA GOVORNIKA: Transkript koristi oznake poput SPEAKER_00, SPEAKER_01. Iz konteksta (uvod, oslovljavanje) shvati tko su stvarni ljudi, ali u ovom koraku to koristi samo da bi bolje razumio tijek razgovora.

STRUKTURA JSON-a: Odgovor mora biti JSON objekt koji sadrži niz "iterations". Svaki objekt unutar niza predstavlja jednu tematsku cjelinu i mora sadržavati sljedeće ključeve:
- "iteration_number": Redni broj iteracije (1, 2, 3...).
- "start_time": Točno početno vrijeme iteracije u formatu HH:MM:SS.
- "end_time": Točno završno vrijeme iteracije u formatu HH:MM:SS.
- "theme": Glavni naziv/tema ovog bloka razgovora.
- "reason_for_cut": Kratko objašnjenje (jedna rečenica) zašto si napravio rez točno na tom vremenu (npr. "Završava točno prije prelaska na temu o nekretninama").
- "chapters": Niz (array) manjih poglavlja unutar ove iteracije. Svako poglavlje mora imati "timestamp" (HH:MM:SS) i "topic" (kratki naziv teme).`;


const SYSTEM_PROMPT_2 = `Uloga: Ti si vrhunski novinar i web urednik. Pišeš jedan dio (long-read) članka na temelju priloženog diariziranog transkripta podcasta. Tvoj izlaz mora biti isključivo validan JSON format.

Tvoj zadatak: Napiši tekst ISKLJUČIVO za zadanu Iteraciju i strukturiraj ga kao niz logičnih sekcija (odlomaka s podnaslovima i vizualima).

Stroga pravila:
IDENTIFIKACIJA GOVORNIKA: Transkript koristi oznake poput SPEAKER_00, SPEAKER_01, itd. Tvoj prvi zadatak je iz samog teksta (uvod, oslovljavanje) prepoznati stvarna imena i uloge govornika te u tekstu koristiti isključivo njihova stvarna imena.
DUBINA: Detaljno obradi sve ključne poante, primjere i anegdote iz zadanog vremenskog okvira. Tekst mora biti bogat informacijama.
PERSPEKTIVA: Piši isključivo u trećem licu (npr. "Voditelj pita...", "Gost objašnjava...", "[Ime] ističe..."). Strogo izbjegavaj prvo lice ("ja", "mi").
STIL: Novinarski, tečan hrvatski jezik. U polju "content" slobodno koristi Markdown za formatiranje (npr. **bold** ili - bullet liste ako gost nešto nabraja). Nema halucinacija – koristi samo informacije iz transkripta.

STRUKTURA JSON-a: Odgovor mora biti JSON objekt koji sadrži niz "sections". Svaka sekcija predstavlja jednu tematsku cjelinu unutar ove iteracije i mora sadržavati sljedeće ključeve:
- "subtitle": Atraktivni novinarski podnaslov za ovu temu.
- "screenshot_timestamp": Točno vrijeme iz videa (u formatu HH:MM:SS) koje je idealno za screenshot vezan uz ovu temu.
- "screenshot_description": Kratki opis onoga što bi se trebalo nalaziti na tom screenshotu (npr. "Gost objašnjava apsurd odljeva kapitala").
- "content": Bogat, detaljan novinarski tekst koji obrađuje tu temu (više paragrafa, dozvoljen Markdown).
- "keywords": Niz (array) od 3 do 5 ključnih pojmova ili koncepata koji se spominju u ovom odlomku (npr. ["radna terapija", "nasilje u obitelji", "molitva"]).
- "entities": Niz (array) vlastitih imenica, lokacija ili ustanova koje se spominju (npr. ["Međugorje", "Sveti Ante", "Mostar"]).`;

// ─── POMOĆNE FUNKCIJE ────────────────────────────────────────────

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function startElapsedTimer(prefix) {
    const start = Date.now();
    const timer = setInterval(() => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        process.stderr.write(`\r      ⏱  ${prefix} ${elapsed}s...`);
    }, 1000);
    return {
        stop() {
            clearInterval(timer);
            process.stderr.write("\r" + " ".repeat(60) + "\r");
        }
    };
}

function parseArgs() {
    const args = process.argv.slice(2);
    function getArg(name) {
        const idx = args.indexOf(name);
        return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
    }

    const file = getArg("--file");
    const geminiKeyArg = getArg("--gemini-key") || process.env.GEMINI_API_KEY || null;

    if (!file) {
        console.error("❌ Obavezan argument: --file <putanja_do_srt_datoteke>");
        process.exit(1);
    }

    if (!fs.existsSync(file)) {
        console.error(`❌ Datoteka ne postoji: ${file}`);
        process.exit(1);
    }

    if (!geminiKeyArg) {
        console.error("❌ Gemini API ključ nije pronađen (--gemini-key ili GEMINI_API_KEY env)!");
        process.exit(1);
    }

    const geminiKeys = geminiKeyArg.split(",").map(k => k.trim()).filter(k => k.length > 0);
    if (geminiKeys.length === 0) {
        console.error("❌ Nevažeći format Gemini ključeva!");
        process.exit(1);
    }

    return { file, geminiKeys };
}

function tryRepairMalformedJson(text) {
    let repaired = text;
    const MAX_FIXES = 100;

    for (let i = 0; i < MAX_FIXES; i++) {
        try {
            return JSON.parse(repaired);
        } catch (e) {
            const posMatch = e.message.match(/position (\d+)/);
            if (!posMatch) return null;
            const pos = parseInt(posMatch[1]);

            if (e.message.includes("Expected ','") && repaired[pos] === ':') {
                let k = pos - 1;
                while (k >= 0 && /\s/.test(repaired[k])) k--;
                if (k >= 0 && repaired[k] === '"') {
                    k--;
                    while (k >= 0 && repaired[k] !== '"') k--;
                    if (k >= 0) {
                        repaired = repaired.slice(0, k) + '{ ' + repaired.slice(k);
                        continue;
                    }
                }
            }

            if (e.message.includes("Expected ','") && repaired[pos] === ']') {
                repaired = repaired.slice(0, pos) + ' }' + repaired.slice(pos);
                continue;
            }

            if (e.message.includes("Expected ','") && repaired[pos] === '{') {
                repaired = repaired.slice(0, pos) + '}, ' + repaired.slice(pos);
                continue;
            }

            return null;
        }
    }
    return null;
}

function extractJsonFromText(text) {
    let clean = text.trim();
    clean = clean.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    clean = clean.trim();
    try {
        return JSON.parse(clean);
    } catch (firstErr) {
        const repaired = tryRepairMalformedJson(clean);
        if (repaired !== null) {
            console.error(`      🔧 JSON automatski popravljen (malformirani niz objekata).`);
            return repaired;
        }
        console.error(`      ⚠️  JSON parse error: ${firstErr.message}`);
        console.error(`      ⚠️  Raw response (first 500 chars): ${text.substring(0, 500)}`);
        throw firstErr;
    }
}

// ─── GEMINI API (AI Studio, API key) ────────────────────────────

let currentKeyIndex = 0;

async function callGemini(systemPrompt, userMessage, apiKeys, label = "Gemini API poziv", rawSavePath = null) {
    const payload = {
        contents: [
            {
                role: "user",
                parts: [{ text: userMessage }]
            }
        ],
        systemInstruction: {
            role: "system",
            parts: [{ text: systemPrompt }]
        },
        generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json"
        }
    };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const currentKey = apiKeys[currentKeyIndex];
        currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
        const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${currentKey}`;

        const timer = startElapsedTimer(`${label} (AI Studio, ključ ${currentKeyIndex === 0 ? apiKeys.length : currentKeyIndex}/${apiKeys.length}, pokušaj ${attempt}/${MAX_RETRIES})`);
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            timer.stop();

            if (!response.ok) {
                const errorBody = await response.text();

                if (response.status === 400 && (errorBody.includes("API_KEY") || errorBody.includes("expired"))) {
                    console.error(`      ⚠️  Ključ ...${currentKey.slice(-5)} je nevažeći ili istekao. Odmah prebacujem na idući...`);
                    continue;
                }

                if (response.status === 429 || response.status >= 500) {
                    const errorDetail = errorBody ? errorBody.substring(0, 300) : "Nema detalja od servera";
                    const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                    console.error(`      ⏳ HTTP ${response.status} — server vratio: ${errorDetail}`);
                    console.error(`      ⏳ Čekam ${waitMs / 1000}s pa pokušavam ponovno... (pokušaj ${attempt}/${MAX_RETRIES})`);
                    await sleep(waitMs);
                    continue;
                }

                throw new Error(`Gemini API HTTP ${response.status}: ${errorBody.substring(0, 300)}`);
            }

            const data = await response.json();

            if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
                throw new Error(`Neočekivan Gemini odgovor: ${JSON.stringify(data).substring(0, 300)}`);
            }

            const responseText = data.candidates[0].content.parts[0].text;

            if (!responseText || !responseText.trim()) {
                console.error(`      ⚠️  Gemini vratio prazan odgovor. finishReason: ${data.candidates[0].finishReason || 'N/A'}`);
                throw new Error("Gemini vratio prazan odgovor");
            }

            if (rawSavePath) {
                fs.writeFileSync(rawSavePath, responseText, "utf-8");
            }

            const parsed = extractJsonFromText(responseText);
            return { parsed, raw: responseText };

        } catch (err) {
            timer.stop();
            if (attempt === MAX_RETRIES) throw err;

            if (err.name === "TypeError" || err.code === "ECONNRESET") {
                const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                console.error(`      ⏳ Network error — čekam ${waitMs / 1000}s (pokušaj ${attempt}/${MAX_RETRIES})`);
                await sleep(waitMs);
                continue;
            }

            throw err;
        }
    }
}

// ─── MAIN ────────────────────────────────────────────────────────

async function main() {
    const { file, geminiKeys } = parseArgs();

    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📰 GEMINI ARTICLE GENERATOR — AI STUDIO       ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📂 Datoteka: ${file}`);
    console.log(`   🤖 Model:    ${GEMINI_MODEL}`);
    console.log(`   🌐 Endpoint: AI Studio (API key, naplaćuje karticu!)`);
    console.log(`   🔑 Ključevi: ${geminiKeys.length} aktivnih API ključa/eva`);
    console.log("");

    const srtContent = fs.readFileSync(file, "utf-8");
    const baseDir = path.dirname(file);
    const basename = path.basename(file).replace(/\.(srt|txt)$/i, "");

    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];

    const outlinePath = path.join(baseDir, `${basename}_${dateStr}_${GEMINI_MODEL}.outline.json`);
    const articlePath = path.join(baseDir, `${basename}_${dateStr}_${GEMINI_MODEL}.article.json`);
    const rawDir = path.join(baseDir, `${basename}_${dateStr}_${GEMINI_MODEL}_raw`);
    if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });

    // --- FAZA 1: OUTLINE ---
    let outlineJson = null;

    if (fs.existsSync(outlinePath)) {
        console.log(`   ✅ [FAZA 1] Pronađen postojeći outline: ${outlinePath}`);
        outlineJson = JSON.parse(fs.readFileSync(outlinePath, "utf-8"));
    } else {
        const rawPath1 = path.join(rawDir, "faza1_outline.raw.txt");

        if (fs.existsSync(rawPath1)) {
            console.log(`   🔧 [FAZA 1] Pronađen sirovi odgovor od prethodnog pokušaja — pokušavam parsirati...`);
            try {
                const rawText = fs.readFileSync(rawPath1, "utf-8");
                outlineJson = extractJsonFromText(rawText);
                if (Array.isArray(outlineJson)) {
                    outlineJson = { iterations: outlineJson };
                }
                fs.writeFileSync(outlinePath, JSON.stringify(outlineJson, null, 2), "utf-8");
                console.log(`   ✅ [FAZA 1] Outline uspješno obnovljen iz raw datoteke. Pronađeno ${outlineJson.iterations?.length || 0} iteracija.`);
            } catch (rawErr) {
                console.log(`   ⚠️  [FAZA 1] Oporavak iz raw datoteke neuspješan: ${rawErr.message}`);
                outlineJson = null;
            }
        }

        if (!outlineJson) {
            console.log(`   🚀 [FAZA 1] Generiram semantički outline...`);
            const startTime1 = Date.now();

            const userMessage1 = `Evo cijelog diariziranog transkripta:\n\n${srtContent}`;

            try {
                const result1 = await callGemini(SYSTEM_PROMPT_1, userMessage1, geminiKeys, "FAZA 1 — Outline", rawPath1);
                outlineJson = result1.parsed;
                if (Array.isArray(outlineJson)) {
                    console.log(`   ℹ️  [FAZA 1] Gemini vratio goli JSON niz (${outlineJson.length} elemenata) — omotavam u {iterations: [...]}.`);
                    outlineJson = { iterations: outlineJson };
                }
                fs.writeFileSync(outlinePath, JSON.stringify(outlineJson, null, 2), "utf-8");
                const elapsed = ((Date.now() - startTime1) / 1000).toFixed(1);
                console.log(`   ✅ [FAZA 1] Outline spremljen. Pronađeno ${outlineJson.iterations?.length || 0} iteracija. (${elapsed}s)`);
            } catch (err) {
                console.error(`   ❌ [FAZA 1] Greška: ${err.message}`);
                process.exit(1);
            }
        }

        await sleep(REQUEST_DELAY_MS);
    }

    if (Array.isArray(outlineJson)) {
        outlineJson = { iterations: outlineJson };
    }

    if (!outlineJson || !outlineJson.iterations || outlineJson.iterations.length === 0) {
        console.error("   ❌ Outline ne sadrži validne iteracije. Prekidam.");
        process.exit(1);
    }

    // --- FAZA 2: ARTICLE GENERATION PO ITERACIJAMA ---

    let finalArticle = null;
    if (fs.existsSync(articlePath)) {
        try {
            finalArticle = JSON.parse(fs.readFileSync(articlePath, "utf-8"));
        } catch (e) {
            finalArticle = null;
        }
    }

    if (finalArticle && finalArticle.iterations && finalArticle.iterations.length === outlineJson.iterations.length) {
        const allComplete = finalArticle.iterations.every(it => it.sections && it.sections.length > 0);
        if (allComplete) {
            console.log(`\n   ✅ [FAZA 2] Članak već postoji i kompletiran je (${finalArticle.iterations.length} iteracija): ${articlePath}`);
            console.log("");
            return;
        }
    }

    const completedIterations = new Set();
    if (finalArticle && finalArticle.iterations) {
        for (const it of finalArticle.iterations) {
            if (it.sections && it.sections.length > 0) {
                completedIterations.add(it.iteration_number);
            }
        }
    }

    if (!finalArticle) {
        finalArticle = {
            metadata: {
                source_file: path.basename(file),
                generated_at: new Date().toISOString(),
                model: GEMINI_MODEL
            },
            iterations: []
        };
    }

    const pendingCount = outlineJson.iterations.length - completedIterations.size;
    console.log(`\n   🚀 [FAZA 2] Generiranje članka po iteracijama (${pendingCount} preostalo od ${outlineJson.iterations.length})...`);

    for (const iter of outlineJson.iterations) {
        if (completedIterations.has(iter.iteration_number)) {
            console.log(`      ⏭️  Iteracija ${iter.iteration_number} već postoji — preskačem.`);
            continue;
        }

        console.log(`      🔄 Generiram iteraciju ${iter.iteration_number} (${iter.start_time} - ${iter.end_time}): ${iter.theme}`);
        const startTime2 = Date.now();

        const iterDetails = `Fokusiraj se ISKLJUČIVO na iteraciju broj ${iter.iteration_number}.\n` +
            `Vremenski okvir: od ${iter.start_time} do ${iter.end_time}.\n` +
            `Tema: ${iter.theme}\n` +
            `Poglavlja u ovoj iteraciji:\n` +
            `${iter.chapters.map(c => ` - ${c.timestamp}: ${c.topic}`).join("\n")}\n\n` +
            `Transkript cijelog razgovora (iskoristi za kontekst i prepoznavanje imena, ali PIŠI SAMO O VREMENSKOM OKVIRU ${iter.start_time} - ${iter.end_time}):\n\n${srtContent}`;

        try {
            const rawPath2 = path.join(rawDir, `faza2_iteracija_${iter.iteration_number}.raw.txt`);
            const result2 = await callGemini(SYSTEM_PROMPT_2, iterDetails, geminiKeys, `FAZA 2 — Iteracija ${iter.iteration_number}`, rawPath2);
            const sectionResult = result2.parsed;

            let sections;
            if (Array.isArray(sectionResult)) {
                console.log(`      ℹ️  Iteracija ${iter.iteration_number}: Gemini vratio goli JSON niz (${sectionResult.length} elemenata) — koristim direktno kao sections.`);
                sections = sectionResult;
            } else {
                sections = sectionResult.sections;
                if (!sections || !Array.isArray(sections) || sections.length === 0) {
                    const keys = Object.keys(sectionResult);
                    console.error(`      ⚠️  Iteracija ${iter.iteration_number}: 'sections' prazan ili nedostaje. Ključevi u odgovoru: [${keys.join(", ")}]`);
                    console.error(`      ⚠️  Raw struktura: ${JSON.stringify(sectionResult).substring(0, 500)}`);
                    const altKey = keys.find(k => Array.isArray(sectionResult[k]) && sectionResult[k].length > 0);
                    if (altKey) {
                        console.log(`      🔧 Koristim alternativni ključ: '${altKey}' (${sectionResult[altKey].length} elemenata)`);
                        sections = sectionResult[altKey];
                    } else {
                        sections = [];
                    }
                }
            }

            finalArticle.iterations.push({
                iteration_number: iter.iteration_number,
                start_time: iter.start_time,
                end_time: iter.end_time,
                theme: iter.theme,
                sections: sections
            });

            const elapsed = ((Date.now() - startTime2) / 1000).toFixed(1);
            console.log(`      ✅ Iteracija ${iter.iteration_number} završena (${elapsed}s)`);

            fs.writeFileSync(articlePath, JSON.stringify(finalArticle, null, 2), "utf-8");

            await sleep(REQUEST_DELAY_MS);

        } catch (err) {
            console.error(`      ❌ Greška u iteraciji ${iter.iteration_number}: ${err.message}`);
            console.log("   Spremam dosadašnji progress...");
            fs.writeFileSync(articlePath, JSON.stringify(finalArticle, null, 2), "utf-8");
            process.exit(1);
        }
    }

    console.log(`\n   🎉 [GOTOVO] Kompletan članak je spremljen u: ${articlePath}`);
    console.log("");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
