#!/usr/bin/env node

/**
 * generate_article_gemini.js
 *
 * Dvofazna skripta za generiranje dugog kronološkog članka (long-read)
 * iz diariziranog SRT transkripta podcasta koristeći najnovije Gemini modele.
 *
 * FAZA 1: Generiranje semantičkog nacrta (Outline).
 *   Dijeli cijeli podcast u tematske iteracije (blokove) od cca 35-45 minuta.
 *   Izlaz formatira kao JSON (iterations).
 *
 * FAZA 2: Iterativno pisanje članka (Sections).
 *   Za svaku iteraciju iz Faze 1, zovemo Gemini kako bi napisao bogat novinarski tekst,
 *   identificirao govornike pravim imenima i predložio screenshotove.
 *   Izlaz svake iteracije su "sections" koji se spajaju u konačni članak.
 *
 * Primjer pokretanja:
 *   node generate_article_gemini.js --file /path/to/transcript.srt
 *
 * Koristi Vertex AI endpoint s OAuth Bearer tokenom (troši GCP kredite).
 * Autentikacija: gcloud CLI (`gcloud auth print-access-token`).
 * Konfig: VERTEX_PROJECT i VERTEX_REGION env varijable ili defaulti.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ─── KONFIGURACIJA ───────────────────────────────────────────────

const GEMINI_MODEL = "gemini-2.5-flash"; // Jedini model dostupan na Vertex AI za ovaj projekt

// Vertex AI endpoint s Bearer tokenom (koristi GCP kredite, ne naplaćuje karticu)
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || "za-inventuru-spremni-prod";
const VERTEX_REGION = process.env.VERTEX_REGION || "us-central1";
const GEMINI_API_BASE = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models`;

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
- "content": Bogat, detaljan novinarski tekst koji obrađuje tu temu (više paragrafa, dozvoljen Markdown).`;

// ─── POMOĆNE FUNKCIJE ────────────────────────────────────────────

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pokreće interval timer koji ispisuje protekle sekunde na istu liniju
function startElapsedTimer(prefix) {
    const start = Date.now();
    const timer = setInterval(() => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        process.stderr.write(`\r      ⏱  ${prefix} ${elapsed}s...`);
    }, 1000);
    return {
        stop() {
            clearInterval(timer);
            process.stderr.write("\r" + " ".repeat(60) + "\r"); // očisti liniju
        }
    };
}

// Dohvaća OAuth2 access token koristeći gcloud CLI
function getAccessToken() {
    try {
        return execSync("gcloud auth print-access-token", { encoding: "utf-8" }).trim();
    } catch (err) {
        console.error("❌ Ne mogu dohvatiti access token. Pokreni: gcloud auth login");
        process.exit(1);
    }
}

function parseArgs() {
    const args = process.argv.slice(2);
    function getArg(name) {
        const idx = args.indexOf(name);
        return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
    }

    const file = getArg("--file");

    if (!file) {
        console.error("❌ Obavezan argument: --file <putanja_do_srt_datoteke>");
        process.exit(1);
    }

    if (!fs.existsSync(file)) {
        console.error(`❌ Datoteka ne postoji: ${file}`);
        process.exit(1);
    }

    return { file };
}

// Iterativno pokušava popraviti česte Gemini JSON malformacije
// (npr. niz objekata bez vitičastih zagrada: ["key": val] umjesto [{"key": val}])
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

            // Slučaj 1: Očekivano ',' ili ']' a na poziciji je ':'
            // → goli key-value par u nizu, nedostaje '{' oko objekta
            if (e.message.includes("Expected ','") && repaired[pos] === ':') {
                // Pronađi otvarajući " imena ključa (preskoči whitespace i zatvarajući ")
                let k = pos - 1;
                while (k >= 0 && /\s/.test(repaired[k])) k--; // preskoči razmake između ključa i :
                if (k >= 0 && repaired[k] === '"') {
                    k--; // preskoči zatvarajući "
                    while (k >= 0 && repaired[k] !== '"') k--; // pronađi otvarajući "
                    if (k >= 0) {
                        repaired = repaired.slice(0, k) + '{ ' + repaired.slice(k);
                        continue;
                    }
                }
            }

            // Slučaj 2: Očekivano ',' ili '}' a pronađen ']' — nedostaje '}' prije ']'
            if (e.message.includes("Expected ','") && repaired[pos] === ']') {
                repaired = repaired.slice(0, pos) + ' }' + repaired.slice(pos);
                continue;
            }

            // Slučaj 3: Očekivano ',' ili '}' a pronađen '{' — nedostaje '},' prije novog objekta
            if (e.message.includes("Expected ','") && repaired[pos] === '{') {
                repaired = repaired.slice(0, pos) + '}, ' + repaired.slice(pos);
                continue;
            }

            return null; // ne znamo popraviti ovu grešku
        }
    }
    return null;
}

// Čisti JSON string od markdown blockova (```json ... ```) i drugih wrappera
function extractJsonFromText(text) {
    let clean = text.trim();
    // Ukloni sve markdown code block wrappere (```json, ```, ili samo ```)
    clean = clean.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    clean = clean.trim();
    try {
        return JSON.parse(clean);
    } catch (firstErr) {
        // Pokušaj automatski popraviti česte Gemini malformacije
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

// ─── GEMINI API ──────────────────────────────────────────────────

let cachedAccessToken = null;
let tokenExpiry = 0;

// Access token traje ~60min, refreshamo svako ~50min
function getOrRefreshAccessToken() {
    const now = Date.now();
    if (cachedAccessToken && now < tokenExpiry) {
        return cachedAccessToken;
    }
    cachedAccessToken = getAccessToken();
    tokenExpiry = now + 50 * 60 * 1000;
    return cachedAccessToken;
}

async function callGemini(systemPrompt, userMessage, label = "Gemini API poziv", rawSavePath = null) {
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

    const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent`;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const token = getOrRefreshAccessToken();

        const timer = startElapsedTimer(`${label} (Vertex AI, pokušaj ${attempt}/${MAX_RETRIES})`);
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });
            timer.stop();

            if (!response.ok) {
                const errorBody = await response.text();

                // Token istekao — refresh i retry
                if (response.status === 401) {
                    console.error(`      ⚠️  Access token istekao — refresham...`);
                    cachedAccessToken = null;
                    tokenExpiry = 0;
                    continue;
                }

                // 429 Rate Limit ili 500+ Server greška — čekamo i pokušavamo ponovno
                if (response.status === 429 || response.status >= 500) {
                    const errorDetail = errorBody ? errorBody.substring(0, 300) : "Nema detalja od servera";
                    const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                    console.error(`      ⏳ HTTP ${response.status} — server vratio: ${errorDetail}`);
                    console.error(`      ⏳ Čekam ${waitMs / 1000}s pa pokušavam ponovno... (pokušaj ${attempt}/${MAX_RETRIES})`);
                    await sleep(waitMs);
                    continue;
                }

                // Sve ostale nepoznate greške prekidaju izvođenje
                throw new Error(`Gemini API HTTP ${response.status}: ${errorBody.substring(0, 300)}`);
            }

            const data = await response.json();

            if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
                throw new Error(`Neočekivan Gemini odgovor: ${JSON.stringify(data).substring(0, 300)}`);
            }

            const responseText = data.candidates[0].content.parts[0].text;

            // Ponekad Gemini vrati prazan tekst ili samo whitespace
            if (!responseText || !responseText.trim()) {
                console.error(`      ⚠️  Gemini vratio prazan odgovor. finishReason: ${data.candidates[0].finishReason || 'N/A'}`);
                throw new Error("Gemini vratio prazan odgovor");
            }

            // Spremi sirovi odgovor PRIJE parsiranja (omogućava oporavak ako parse padne)
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
    const { file } = parseArgs();

    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📰 GEMINI ARTICLE GENERATOR (2 FAZE)          ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📂 Datoteka: ${file}`);
    console.log(`   🤖 Model:    ${GEMINI_MODEL}`);
    console.log(`   🌐 Vertex AI: ${VERTEX_PROJECT} (${VERTEX_REGION})`);
    console.log("");

    const srtContent = fs.readFileSync(file, "utf-8");
    const baseDir = path.dirname(file);
    const basename = path.basename(file).replace(/\.(srt|txt)$/i, "");

    // YYYY-MM-DD format
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

        // Pokušaj oporavak iz raw datoteke (ako postoji od prethodnog neuspjelog pokušaja)
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

            // Šaljemo cijeli transkript kao kontekst
            const userMessage1 = `Evo cijelog diariziranog transkripta:\n\n${srtContent}`;

            try {
                const result1 = await callGemini(SYSTEM_PROMPT_1, userMessage1, "FAZA 1 — Outline", rawPath1);
                outlineJson = result1.parsed;
                // Normaliziraj: ako Gemini vrati goli niz, omotaj u {iterations: [...]}
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

        // Zbog rate limita pauziraj prije Faze 2
        await sleep(REQUEST_DELAY_MS);
    }

    // Normaliziraj i kod učitavanja iz keša (cached outline mogao biti goli niz)
    if (Array.isArray(outlineJson)) {
        outlineJson = { iterations: outlineJson };
    }

    if (!outlineJson || !outlineJson.iterations || outlineJson.iterations.length === 0) {
        console.error("   ❌ Outline ne sadrži validne iteracije. Prekidam.");
        process.exit(1);
    }

    // --- FAZA 2: ARTICLE GENERATION PO ITERACIJAMA ---

    // Učitaj postojeći article.json ako postoji (za nastavak prekinutog rada)
    let finalArticle = null;
    if (fs.existsSync(articlePath)) {
        try {
            finalArticle = JSON.parse(fs.readFileSync(articlePath, "utf-8"));
        } catch (e) {
            finalArticle = null;
        }
    }

    // Provjeri je li članak već kompletiran (sve iteracije imaju neprazne sections)
    if (finalArticle && finalArticle.iterations && finalArticle.iterations.length === outlineJson.iterations.length) {
        const allComplete = finalArticle.iterations.every(it => it.sections && it.sections.length > 0);
        if (allComplete) {
            console.log(`\n   ✅ [FAZA 2] Članak već postoji i kompletiran je (${finalArticle.iterations.length} iteracija): ${articlePath}`);
            console.log("");
            return;
        }
    }

    // Odredi koje iteracije već imaju sadržaj (za nastavak)
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
        // Preskoči već generirane iteracije
        if (completedIterations.has(iter.iteration_number)) {
            console.log(`      ⏭️  Iteracija ${iter.iteration_number} već postoji — preskačem.`);
            continue;
        }

        console.log(`      🔄 Generiram iteraciju ${iter.iteration_number} (${iter.start_time} - ${iter.end_time}): ${iter.theme}`);
        const startTime2 = Date.now();

        // Šaljemo CIJELI transkript za kontekst, ali s posebnim napomenom da piše samo za ovu iteraciju.
        // Alternativa bi bila slati samo dio transkripta, ali LLM gubi širi kontekst (imena govornika prije).
        // S obzirom na Gemini-jev veliki context window, šaljemo cijeli transkript, no napominjemo granice.

        const iterDetails = `Fokusiraj se ISKLJUČIVO na iteraciju broj ${iter.iteration_number}.\n` +
            `Vremenski okvir: od ${iter.start_time} do ${iter.end_time}.\n` +
            `Tema: ${iter.theme}\n` +
            `Poglavlja u ovoj iteraciji:\n` +
            `${iter.chapters.map(c => ` - ${c.timestamp}: ${c.topic}`).join("\n")}\n\n` +
            `Transkript cijelog razgovora (iskoristi za kontekst i prepoznavanje imena, ali PIŠI SAMO O VREMENSKOM OKVIRU ${iter.start_time} - ${iter.end_time}):\n\n${srtContent}`;

        try {
            const rawPath2 = path.join(rawDir, `faza2_iteracija_${iter.iteration_number}.raw.txt`);
            const result2 = await callGemini(SYSTEM_PROMPT_2, iterDetails, `FAZA 2 — Iteracija ${iter.iteration_number}`, rawPath2);
            const sectionResult = result2.parsed;

            // Provjeri je li Gemini vratio sections pod očekivanim ključem
            let sections;
            if (Array.isArray(sectionResult)) {
                // Gemini vratio goli niz umjesto {sections: [...]}
                console.log(`      ℹ️  Iteracija ${iter.iteration_number}: Gemini vratio goli JSON niz (${sectionResult.length} elemenata) — koristim direktno kao sections.`);
                sections = sectionResult;
            } else {
                sections = sectionResult.sections;
                if (!sections || !Array.isArray(sections) || sections.length === 0) {
                    const keys = Object.keys(sectionResult);
                    console.error(`      ⚠️  Iteracija ${iter.iteration_number}: 'sections' prazan ili nedostaje. Ključevi u odgovoru: [${keys.join(", ")}]`);
                    console.error(`      ⚠️  Raw struktura: ${JSON.stringify(sectionResult).substring(0, 500)}`);
                    // Pokušaj pronaći sections pod drugim imenom
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

            // Spremi napredak (u slučaju pucanja veze)
            fs.writeFileSync(articlePath, JSON.stringify(finalArticle, null, 2), "utf-8");

            // Rate limit pauza
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
