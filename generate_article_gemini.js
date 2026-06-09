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
 * Načini pokretanja:
 *   1. Pojedinačna datoteka:
 *      node generate_article_gemini.js --file /path/to/transcript.srt
 *
 *   2. Batch (round-robin po kanalima, najnoviji videi prvo):
 *      node generate_article_gemini.js --input-dir /Volumes/DOMOVINA1TB/fetch_domovina_tv_output
 *      node generate_article_gemini.js --input-dir ... --channel domovina_tv --limit 10
 *      node generate_article_gemini.js --input-dir ... --dry-run
 *
 * Round-robin logika: umjesto obrade svih videa jednog kanala pa drugog,
 * uzima najnoviji neobrađeni video iz svakog kanala, zatim drugi najnoviji,
 * itd. — tako svi kanali dobivaju članke za najsvježije epizode što prije.
 *
 * Koristi Vertex AI endpoint s OAuth Bearer tokenom (troši GCP kredite).
 * Autentikacija: gcloud CLI (`gcloud auth print-access-token`).
 * Konfig: VERTEX_PROJECT i VERTEX_REGION env varijable ili defaulti.
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

// ─── KONFIGURACIJA ───────────────────────────────────────────────

// Učitaj gemini.conf (key=value format, kao storage.conf)
function loadGeminiConf() {
    const confPath = path.join(__dirname, "gemini.conf");
    const conf = {};
    if (fs.existsSync(confPath)) {
        for (const line of fs.readFileSync(confPath, "utf-8").split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx === -1) continue;
            conf[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
    }
    return conf;
}

const GEMINI_CONF = loadGeminiConf();

const GEMINI_MODEL = GEMINI_CONF.GEMINI_MODEL || "gemini-2.5-flash";

// Backend: "vertex" (default) ili "cli" (gemini CLI non-interactive).
// Postavi preko env vara GEMINI_BACKEND=cli (run_pipeline.sh --gemini-backend cli).
const GEMINI_BACKEND = (process.env.GEMINI_BACKEND || "vertex").toLowerCase();

// Vertex AI endpoint s Bearer tokenom (koristi GCP kredite, ne naplaćuje karticu)
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || GEMINI_CONF.VERTEX_PROJECT || "project-a275a620-ef0c-45ae-99e";

// ─── GEMINI USAGE / TROŠAK TRACKING ───────────────────────────────
// Vertex vraća usageMetadata (token brojevi) po pozivu. Procjenjujemo trošak iz
// cjenika gemini-2.5-flash (USD/1M tokena; override u gemini.conf ili env).
// Članak je DVOFAZAN (outline + N iteracija) → po epizodi zbrajamo SVE pozive (snapshot-diff).
// "diff" → sidecar {base}.gemini_usage.json (step "article") + log. Radi samo za vertex backend.
const PRICE_IN_PER_M  = parseFloat(process.env.GEMINI_PRICE_IN  || GEMINI_CONF.GEMINI_PRICE_IN  || "0.30");
const PRICE_OUT_PER_M = parseFloat(process.env.GEMINI_PRICE_OUT || GEMINI_CONF.GEMINI_PRICE_OUT || "2.50");
const sessionUsage = { calls: 0, prompt: 0, output: 0, total: 0, usd: 0 };
function recordUsage(um) {
    if (!um) return;
    const p = um.promptTokenCount || 0;
    const o = (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0);
    sessionUsage.calls++;
    sessionUsage.prompt += p;
    sessionUsage.output += o;
    sessionUsage.total  += (um.totalTokenCount || (p + o));
    sessionUsage.usd    += p / 1e6 * PRICE_IN_PER_M + o / 1e6 * PRICE_OUT_PER_M;
}
function snapshotUsage() { return { ...sessionUsage }; }
function diffUsage(before) {
    const d = {
        calls:  sessionUsage.calls  - before.calls,
        prompt: sessionUsage.prompt - before.prompt,
        output: sessionUsage.output - before.output,
        total:  sessionUsage.total  - before.total,
        usd:    sessionUsage.usd    - before.usd,
    };
    d.usd = Math.round(d.usd * 1e6) / 1e6;
    return d;
}
// Zapiši per-epizodu trošak u {epBase}.gemini_usage.json (dijeli sidecar sa summary korakom).
function writeUsageDiff(baseDir, epBase, step, ep) {
    if (ep.calls <= 0) return;
    const usagePath = path.join(baseDir, epBase + ".gemini_usage.json");
    let prevRuns = [];
    try { prevRuns = JSON.parse(fs.readFileSync(usagePath, "utf-8")).runs || []; } catch (_) {}
    const rec = {
        step, model: GEMINI_MODEL, project: VERTEX_PROJECT,
        prompt_tokens: ep.prompt, output_tokens: ep.output, total_tokens: ep.total, calls: ep.calls,
        est_usd: ep.usd, price_in_per_m: PRICE_IN_PER_M, price_out_per_m: PRICE_OUT_PER_M,
        at: new Date().toISOString(),
    };
    prevRuns = prevRuns.filter(r => r.step !== step).concat(rec);
    const totUsd = Math.round(prevRuns.reduce((s, r) => s + (r.est_usd || 0), 0) * 1e6) / 1e6;
    fs.writeFileSync(usagePath, JSON.stringify({ base: epBase, total_est_usd: totUsd, runs: prevRuns }, null, 2), "utf-8");
    console.log(`   💳 Gemini (${step}): ${ep.prompt}+${ep.output} tok u ${ep.calls} poziva ≈ $${ep.usd.toFixed(5)}`);
}

// Multi-region rotacija: svaki region ima nezavisnu kvotu (per-project per-region).
// Rotacijom preko N regiona efektivno dobivamo N× throughput.
// Global endpoint koristi aiplatform.googleapis.com (bez region prefiksa) s locations/global.
const VERTEX_REGIONS = (process.env.VERTEX_REGIONS || "").split(",").filter(Boolean).length > 0
    ? process.env.VERTEX_REGIONS.split(",").map(r => r.trim())
    : (GEMINI_CONF.VERTEX_REGIONS || "").split(",").filter(Boolean).length > 0
        ? GEMINI_CONF.VERTEX_REGIONS.split(",").map(r => r.trim())
        : [
            "global",
            "us-central1",
            "us-east1",
            "us-east4",
            "us-west1",
            "us-west4",
            "us-south1",
            "europe-west1",
            "europe-west4",
        ];

let regionIndex = 0;

function getNextRegion() {
    const region = VERTEX_REGIONS[regionIndex % VERTEX_REGIONS.length];
    regionIndex++;
    return region;
}

function buildEndpointUrl(region) {
    if (region === "global") {
        return `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/global/publishers/google/models/${GEMINI_MODEL}:generateContent`;
    }
    return `https://${region}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${region}/publishers/google/models/${GEMINI_MODEL}:generateContent`;
}

const REQUEST_DELAY_MS = 2000; // Smanjeno jer multi-region raspoređuje opterećenje
const MAX_RETRIES = 10;
const RETRY_BASE_DELAY_MS = 5000; // Smanjeno jer rotiramo na drugi region umjesto čekanja
const GRACE_RETRY_HOURS = 24; // Ponovni pokušaj blokiranog sadržaja nakon X sati
const MAX_BLOCKED_RETRIES = 3;     // Maksimalan broj ponovnih pokušaja prije trajnog blokiranja

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
    const inputDir = getArg("--input-dir");
    const channel = getArg("--channel");
    // --video-id filter: u batch modu obradi samo jedan video po YouTube ID-u (11 znakova)
    const videoId = getArg("--video-id");
    const limit = getArg("--limit") ? parseInt(getArg("--limit"), 10) : null;
    const dryRun = args.includes("--dry-run");
    const rebuildState = args.includes("--rebuild-state");

    if (!file && !inputDir) {
        console.error("❌ Obavezan argument: --file <putanja> ili --input-dir <putanja>");
        console.error("");
        console.error("Primjeri:");
        console.error("  node generate_article_gemini.js --file /path/to/transcript.srt");
        console.error("  node generate_article_gemini.js --input-dir /Volumes/DOMOVINA1TB/fetch_domovina_tv_output");
        console.error("  node generate_article_gemini.js --input-dir ... --channel domovina_tv --limit 10");
        console.error("  node generate_article_gemini.js --input-dir ... --video-id dQw4w9WgXcQ");
        console.error("  node generate_article_gemini.js --input-dir ... --dry-run");
        console.error("  node generate_article_gemini.js --input-dir ... --rebuild-state");
        process.exit(1);
    }

    if (file) {
        if (!fs.existsSync(file)) {
            console.error(`❌ Datoteka ne postoji: ${file}`);
            process.exit(1);
        }
        return { mode: "single", file };
    }

    if (!fs.existsSync(inputDir)) {
        console.error(`❌ Input direktorij ne postoji: ${inputDir}`);
        process.exit(1);
    }

    return { mode: "batch", inputDir, channel, videoId, limit, dryRun, rebuildState };
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

// Pokušava popraviti skraćeni (truncated) JSON odgovor od Geminija.
// Gemini ponekad prekorači output token limit i prekine JSON u sredini stringa.
// Strategija: pronađi zadnji kompletni objekt u nizu i zatvori JSON strukturu.
function tryRepairTruncatedJson(text) {
    const trimmed = text.trimEnd();

    let inString = false;
    let escape = false;
    const stack = [];
    let arrayDepth = -1;
    let lastCompleteElementEnd = -1;
    let stackAtLastComplete = [];

    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (ch === '{') {
            stack.push('}');
        } else if (ch === '[') {
            if (arrayDepth === -1) arrayDepth = stack.length + 1;
            stack.push(']');
        } else if (ch === '}' || ch === ']') {
            if (stack.length > 0) stack.pop();
        }

        // Kad se zatvori '}' i stack.length padne na arrayDepth,
        // znači da smo upravo zatvorili kompletni objekt unutar glavnog niza
        if (ch === '}' && stack.length === arrayDepth) {
            lastCompleteElementEnd = i;
            stackAtLastComplete = [...stack];
        }
    }

    if (lastCompleteElementEnd === -1) return null;

    // Odreži na zadnjem kompletnom objektu i zatvori otvorene strukture
    let repaired = trimmed.substring(0, lastCompleteElementEnd + 1);
    repaired += '\n' + stackAtLastComplete.reverse().join('\n');

    try {
        return JSON.parse(repaired);
    } catch {
        return null;
    }
}

// Uklanja ilegalne kontrolne znakove iz JSON stringa.
// JSON spec dozvoljava \n, \r, \t samo kao escape sekvence (\\n, \\r, \\t),
// ali Gemini ponekad ubaci sirove control characters unutar string vrijednosti.
function sanitizeJsonControlChars(text) {
    // Zamijeni sirove kontrolne znakove (0x00-0x1F) unutar JSON stringova
    // s njihovim escape sekvencama ili ukloni ih.
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")  // ukloni opskurne kontrolne znakove
               .replace(/\t/g, "\\t")                            // tab → \t escape
               .replace(/(?<!\\)\n(?=([^"]*"[^"]*")*[^"]*"[^"]*$)/g, "\\n"); // goli newline unutar stringa → \n
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
        // Pokušaj sanitizirati kontrolne znakove pa ponovo parsirati
        if (firstErr.message.includes("control character") || firstErr.message.includes("Bad control")) {
            try {
                const sanitized = sanitizeJsonControlChars(clean);
                const result = JSON.parse(sanitized);
                console.error(`      🔧 JSON automatski popravljen (uklonjeni kontrolni znakovi).`);
                return result;
            } catch { /* nastavi s ostalim popravcima */ }
        }

        // Pokušaj automatski popraviti česte Gemini malformacije
        const repaired = tryRepairMalformedJson(clean);
        if (repaired !== null) {
            console.error(`      🔧 JSON automatski popravljen (malformirani niz objekata).`);
            return repaired;
        }

        // Zadnji pokušaj: sanitizacija + repair kombinirano
        try {
            const sanitized = sanitizeJsonControlChars(clean);
            const repairedSanitized = tryRepairMalformedJson(sanitized);
            if (repairedSanitized !== null) {
                console.error(`      🔧 JSON automatski popravljen (sanitizacija + repair).`);
                return repairedSanitized;
            }
        } catch { /* odustani */ }

        // Pokušaj popraviti skraćeni (truncated) JSON — Gemini prekoračio output token limit
        {
            const truncRepaired = tryRepairTruncatedJson(clean);
            if (truncRepaired !== null) {
                const items = Array.isArray(truncRepaired) ? truncRepaired :
                    (truncRepaired.sections || truncRepaired.iterations || []);
                console.error(`      🔧 JSON automatski popravljen (skraćeni odgovor — spašeno ${items.length} kompletnih elemenata).`);
                return truncRepaired;
            }

            // Sanitizacija + truncation repair kombinirano
            try {
                const sanitized = sanitizeJsonControlChars(clean);
                const truncRepairedSan = tryRepairTruncatedJson(sanitized);
                if (truncRepairedSan !== null) {
                    const items = Array.isArray(truncRepairedSan) ? truncRepairedSan :
                        (truncRepairedSan.sections || truncRepairedSan.iterations || []);
                    console.error(`      🔧 JSON automatski popravljen (sanitizacija + truncation repair — spašeno ${items.length} kompletnih elemenata).`);
                    return truncRepairedSan;
                }
            } catch { /* odustani */ }
        }

        console.error(`      ⚠️  JSON parse error: ${firstErr.message}`);
        console.error(`      ⚠️  Raw response (first 500 chars): ${text.substring(0, 500)}`);
        throw firstErr;
    }
}

// ─── DISCOVERY & ROUND-ROBIN ─────────────────────────────────

const DIARIZED_SRT_SUFFIX = ".canary.diarized.srt";
const SORTFORMER_DIARIZED_SRT_SUFFIX = ".sortformer.diarized.srt";

// Razrješava koji se dijarizirani SRT stvarno čita za dani canary path.
// Ako uz canary postoji i .sortformer.diarized.srt (eksperimentalna pipeline),
// preferira sortformer. Discovery i izlazna imena fajlova ostaju canary-anchored.
function resolveDiarizedSrt(canarySrtPath) {
    const sortformerPath = canarySrtPath.replace(
        /\.canary\.diarized\.srt$/,
        SORTFORMER_DIARIZED_SRT_SUFFIX
    );
    if (fs.existsSync(sortformerPath)) {
        return { path: sortformerPath, source: "sortformer" };
    }
    return { path: canarySrtPath, source: "canary" };
}

const BLOCKED_SUFFIX = ".canary.diarized.blocked.json";

/**
 * Sprema marker datoteku za blokirani sadržaj tako da se u budućim pokretanjima preskače.
 */
function saveBlockedMarker(srtPath, err) {
    const baseDir = path.dirname(srtPath);
    const base = path.basename(srtPath).replace(/\.srt$/, "");
    const blockedPath = path.join(baseDir, `${base}.blocked.json`);
    let prevRetryCount = 0;
    try {
        const prev = JSON.parse(fs.readFileSync(blockedPath, "utf-8"));
        prevRetryCount = (prev.retry_count || 0) + 1;
    } catch (_) { /* prvi put blokirano */ }
    const blockedData = {
        blocked_at: new Date().toISOString(),
        model: GEMINI_MODEL,
        reason: err.blockReason,
        retry_count: prevRetryCount,
        source_file: path.basename(srtPath),
        raw_response: err.rawResponse
    };
    fs.writeFileSync(blockedPath, JSON.stringify(blockedData, null, 2), "utf-8");
    return { blockedPath, retryCount: prevRetryCount };
}

/**
 * Pronalazi najnoviju datoteku za dani basename i tip (outline, article) — bilo koji datum.
 * @returns {string|null} Puni put do datoteke ili null
 */
function findLatestFile(dir, basename, type) {
    const prefix = `${basename}_`;
    const suffix = `_${GEMINI_MODEL}.${type}.json`;
    try {
        const matches = fs.readdirSync(dir)
            .filter(f => f.startsWith(prefix) && f.endsWith(suffix) && !f.startsWith("._"))
            .sort();
        return matches.length > 0 ? path.join(dir, matches[matches.length - 1]) : null;
    } catch {
        return null;
    }
}

/**
 * Provjerava ima li video kompletiran članak (bilo koji datum, isti model).
 * Članak je kompletiran ako article.json postoji I ima sve iteracije s nepraznim sections.
 */
function hasCompleteArticle(channelDir, srtFilename) {
    const basename = srtFilename.replace(/\.(srt|txt)$/i, "");

    const articlePath = findLatestFile(channelDir, basename, "article");
    if (!articlePath) return false;

    try {
        const article = JSON.parse(fs.readFileSync(articlePath, "utf-8"));
        if (!article.iterations || article.iterations.length === 0) return false;

        // Provjeri postoji li outline za usporedbu broja iteracija
        const outlinePath = findLatestFile(channelDir, basename, "outline");
        if (outlinePath) {
            const outline = JSON.parse(fs.readFileSync(outlinePath, "utf-8"));
            const expectedCount = Array.isArray(outline) ? outline.length : (outline.iterations?.length || 0);
            if (article.iterations.length < expectedCount) return false;
        }

        // Sve iteracije moraju imati neprazne sections
        return article.iterations.every(it => it.sections && it.sections.length > 0);
    } catch {
        return false;
    }
}

// ─── DONE CACHE ─────────────────────────────────────────────────

const DONE_STATE_FILENAME = "articles-done.json";

function loadDoneState(inputDir) {
    const statePath = path.join(inputDir, DONE_STATE_FILENAME);
    try {
        if (fs.existsSync(statePath)) {
            const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
            return new Set(Array.isArray(data.completed) ? data.completed : []);
        }
    } catch (e) {
        console.error(`   ⚠️  Neispravan done-state: ${statePath} — rebuildam cache`);
    }
    return new Set();
}

function saveDoneState(inputDir, doneSet) {
    const statePath = path.join(inputDir, DONE_STATE_FILENAME);
    const tempPath = statePath + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify({ completed: [...doneSet] }, null, 2));
    fs.renameSync(tempPath, statePath);
}

/**
 * Pronalazi sve .canary.diarized.srt datoteke kojima nedostaje kompletiran članak.
 * Grupira po kanalu, unutar kanala sortira po datumu silazno (najnoviji prvo).
 * Koristi doneSet za O(1) skip već kompletiranih datoteka.
 *
 * @returns {{ byChannel: Map<string, string[]>, cachedSkipped: number, fsSkipped: number }}
 */
function discoverPendingFiles(inputDir, channelFilter, doneSet, videoIdFilter) {
    const byChannel = new Map();
    let cachedSkipped = 0;
    let fsSkipped = 0;

    const entries = fs.readdirSync(inputDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!(entry.isDirectory() || entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;
        if (channelFilter && entry.name !== channelFilter) continue;

        const channelName = entry.name;
        const channelDir = path.join(inputDir, channelName);
        const pending = [];

        const files = fs.readdirSync(channelDir);
        for (const file of files) {
            if (!file.endsWith(DIARIZED_SRT_SUFFIX)) continue;
            if (file.startsWith("._")) continue;
            // Filtriraj po YouTube video ID-u (u imenu kao _yt_VIDEOID)
            if (videoIdFilter && !file.includes(`_yt_${videoIdFilter}`)) continue;

            const baseKey = file.replace(/\.wav\.canary\.diarized\.srt$/, "");

            // O(1) cache provjera
            if (doneSet.has(baseKey)) {
                cachedSkipped++;
                continue;
            }

            // Provjeri postoji li blocked marker (PROHIBITED_CONTENT itd.)
            const base = file.replace(/\.srt$/, "");
            const blockedPath = path.join(channelDir, `${base}.blocked.json`);
            if (fs.existsSync(blockedPath)) {
                try {
                    const blockData = JSON.parse(fs.readFileSync(blockedPath, "utf-8"));
                    const retryCount = blockData.retry_count || 0;
                    const hoursSince = (Date.now() - new Date(blockData.blocked_at).getTime()) / (1000 * 60 * 60);
                    if (retryCount >= MAX_BLOCKED_RETRIES) {
                        continue;
                    } else if (hoursSince > GRACE_RETRY_HOURS) {
                        console.log(`   🔄 [RETRY] ${file}: blokiran prije ${Math.round(hoursSince)}h — pokušaj ${retryCount + 1}/${MAX_BLOCKED_RETRIES}`);
                        fs.unlinkSync(blockedPath);
                    } else {
                        continue;
                    }
                } catch(e) {
                    continue;
                }
            }

            if (!hasCompleteArticle(channelDir, file)) {
                pending.push(path.join(channelDir, file));
            } else {
                // Cache warming: kompletiran, ali nije bio u cacheu
                doneSet.add(baseKey);
                fsSkipped++;
            }
        }

        // Sortiranje silazno po imenu (YYYYMMDD prefiks → najnoviji prvi)
        pending.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));

        if (pending.length > 0) {
            byChannel.set(channelName, pending);
        }
    }

    return { byChannel, cachedSkipped, fsSkipped };
}

/**
 * Gradi round-robin red iz datoteka grupiranih po kanalima.
 * Uzima prvi (najnoviji) iz svakog kanala, zatim drugi, itd.
 *
 * @param {Map<string, string[]>} byChannel - channel → [srtPath, ...] sortirani najnoviji prvo
 * @returns {Array<{srtPath: string, channel: string}>}
 */
function buildRoundRobinQueue(byChannel) {
    const queue = [];
    const channels = [...byChannel.keys()].sort();
    let hasMore = true;
    let roundIndex = 0;

    while (hasMore) {
        hasMore = false;
        for (const ch of channels) {
            const files = byChannel.get(ch);
            if (roundIndex < files.length) {
                queue.push({ srtPath: files[roundIndex], channel: ch });
                hasMore = true;
            }
        }
        roundIndex++;
    }

    return queue;
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

/**
 * Poziva `gemini` CLI u headless modu. System + user prompt idu preko stdina
 * (izbjegava ARG_MAX limit), `-p` služi kao bridge direktiva za JSON output.
 */
function callGeminiCli(systemPrompt, userMessage) {
    return new Promise((resolve, reject) => {
        const combinedInput =
            "=== SUSTAVSKE UPUTE ===\n" + systemPrompt +
            "\n\n=== KORISNIČKI INPUT ===\n" + userMessage;

        const args = [
            "-m", GEMINI_MODEL,
            "-o", "text",
            "--skip-trust",
            "-p", "Slijedi sustavske upute iz inputa iznad. Vrati ISKLJUČIVO valjan JSON, bez markdown code blokova.",
        ];

        const proc = spawn("gemini", args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => { stdout += d; });
        proc.stderr.on("data", (d) => { stderr += d; });
        proc.on("error", (err) => reject(new Error(`gemini CLI spawn failed: ${err.message}`)));
        proc.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`gemini CLI exit ${code}: ${stderr.substring(0, 300) || "(no stderr)"}`));
                return;
            }
            if (!stdout || !stdout.trim()) {
                reject(new Error(`gemini CLI vratio prazan stdout. stderr: ${stderr.substring(0, 200)}`));
                return;
            }
            resolve(stdout);
        });
        proc.stdin.write(combinedInput);
        proc.stdin.end();
    });
}

async function callGemini(systemPrompt, userMessage, label = "Gemini API poziv", rawSavePath = null) {
    // ── CLI backend grana ──
    // Kad je GEMINI_BACKEND=cli, koristi gemini CLI umjesto Vertex API-ja.
    // Nema region rotacije ni retry petlje — CLI ima vlastiti auth/retry.
    if (GEMINI_BACKEND === "cli") {
        const timer = startElapsedTimer(`${label} (gemini CLI)`);
        try {
            const responseText = await callGeminiCli(systemPrompt, userMessage);
            timer.stop();
            if (rawSavePath) {
                fs.writeFileSync(rawSavePath, responseText, "utf-8");
            }
            const parsed = extractJsonFromText(responseText);
            return { parsed, raw: responseText };
        } catch (err) {
            timer.stop();
            throw err;
        }
    }

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
            maxOutputTokens: 65536,
            responseMimeType: "application/json"
        }
    };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const region = getNextRegion();
        const url = buildEndpointUrl(region);
        const token = getOrRefreshAccessToken();

        const timer = startElapsedTimer(`${label} (${region}, pokušaj ${attempt}/${MAX_RETRIES})`);
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

                // Token istekao — refresh i retry (isti region OK)
                if (response.status === 401) {
                    console.error(`      ⚠️  Access token istekao — refresham...`);
                    cachedAccessToken = null;
                    tokenExpiry = 0;
                    continue;
                }

                // 429 Rate Limit — rotiramo na sljedeći region s kraćim čekanjem
                if (response.status === 429) {
                    const waitMs = Math.min(RETRY_BASE_DELAY_MS * attempt, 30000);
                    console.error(`      ⏳ HTTP 429 na ${region} — rotiram na sljedeći region, čekam ${waitMs / 1000}s (pokušaj ${attempt}/${MAX_RETRIES})`);
                    await sleep(waitMs);
                    continue;
                }

                // 500+ Server greška — retry s eksponencijalnim backoffom
                if (response.status >= 500) {
                    const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                    const errorDetail = errorBody ? errorBody.substring(0, 200) : "Nema detalja";
                    console.error(`      ⏳ HTTP ${response.status} na ${region}: ${errorDetail}`);
                    console.error(`      ⏳ Čekam ${waitMs / 1000}s pa pokušavam ponovno... (pokušaj ${attempt}/${MAX_RETRIES})`);
                    await sleep(waitMs);
                    continue;
                }

                // Sve ostale nepoznate greške prekidaju izvođenje
                throw new Error(`Gemini API HTTP ${response.status} (${region}): ${errorBody.substring(0, 300)}`);
            }

            const data = await response.json();
            recordUsage(data.usageMetadata);   // token brojevi za trošak po epizodi

            // Provjeri je li sadržaj blokiran (PROHIBITED_CONTENT, SAFETY, itd.)
            if (data.promptFeedback && data.promptFeedback.blockReason) {
                const err = new Error(`Gemini blokirao sadržaj: ${data.promptFeedback.blockReason} — ${data.promptFeedback.blockReasonMessage || 'bez objašnjenja'}`);
                err.blocked = true;
                err.blockReason = data.promptFeedback.blockReason;
                err.rawResponse = data;
                throw err;
            }

            if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
                throw new Error(`Neočekivan Gemini odgovor: ${JSON.stringify(data).substring(0, 300)}`);
            }

            const responseText = data.candidates[0].content.parts[0].text;
            const finishReason = data.candidates[0].finishReason || "UNKNOWN";

            // Upozori ako je Gemini prekinuo odgovor zbog token limita
            if (finishReason === "MAX_TOKENS" || finishReason === "LENGTH") {
                console.error(`      ⚠️  Gemini prekinuo odgovor (finishReason: ${finishReason}) — pokušat ću spasiti parcijalni JSON.`);
            }

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
            // Blokirani sadržaj — nema smisla retryati
            if (err.blocked) throw err;

            if (attempt === MAX_RETRIES) throw err;

            if (err.name === "TypeError" || err.code === "ECONNRESET") {
                const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                console.error(`      ⏳ Network error (${region}) — rotiram region, čekam ${waitMs / 1000}s (pokušaj ${attempt}/${MAX_RETRIES})`);
                await sleep(waitMs);
                continue;
            }

            throw err;
        }
    }
}

// ─── PROCESS FILE ─────────────────────────────────────────────

/**
 * Obrađuje jednu SRT datoteku: generira outline (Faza 1) i članak (Faza 2).
 * Vraća true ako je uspješno završeno, false ako je došlo do greške.
 * U batch modu ne radi process.exit() nego vraća false.
 */
async function processFile(file, { exitOnError = true } = {}) {
    const { path: _actualSrtPath, source: _diarSource } = resolveDiarizedSrt(file);
    if (_diarSource === "sortformer") console.log(`   🎭 Dijarizacija: sortformer (override canary)`);
    const srtContent = fs.readFileSync(_actualSrtPath, "utf-8");
    const baseDir = path.dirname(file);
    const basename = path.basename(file).replace(/\.(srt|txt)$/i, "");

    // Episode-base (bez .wav.{canary,sortformer}.diarized infixa) → isti gemini_usage.json kao summary korak.
    const epBase = basename.replace(/\.wav\.(canary|sortformer)\.diarized$/, "");
    const _usage0 = snapshotUsage();   // za per-epizodu trošak diff (zbroj svih poziva ove epizode)

    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];

    // Traži postojeće datoteke od bilo kojeg datuma (ne samo danas)
    const existingOutline = findLatestFile(baseDir, basename, "outline");
    const existingArticle = findLatestFile(baseDir, basename, "article");

    // Koristi datum iz postojećeg outlinea/artikla za konzistentnost, inače danas
    let effectiveDateStr = dateStr;
    if (existingOutline) {
        const m = path.basename(existingOutline).match(/_(\d{4}-\d{2}-\d{2})_/);
        if (m) effectiveDateStr = m[1];
    } else if (existingArticle) {
        const m = path.basename(existingArticle).match(/_(\d{4}-\d{2}-\d{2})_/);
        if (m) effectiveDateStr = m[1];
    }

    const outlinePath = existingOutline || path.join(baseDir, `${basename}_${effectiveDateStr}_${GEMINI_MODEL}.outline.json`);
    const articlePath = existingArticle || path.join(baseDir, `${basename}_${effectiveDateStr}_${GEMINI_MODEL}.article.json`);
    const rawDir = path.join(baseDir, `${basename}_${effectiveDateStr}_${GEMINI_MODEL}_raw`);
    if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });

    // --- FAZA 1: OUTLINE ---
    let outlineJson = null;

    if (fs.existsSync(outlinePath)) {
        console.log(`   ✅ [FAZA 1] Pronađen postojeći outline: ${path.basename(outlinePath)}`);
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
                const result1 = await callGemini(SYSTEM_PROMPT_1, userMessage1, "FAZA 1 — Outline", rawPath1);
                outlineJson = result1.parsed;
                if (Array.isArray(outlineJson)) {
                    console.log(`   ℹ️  [FAZA 1] Gemini vratio goli JSON niz (${outlineJson.length} elemenata) — omotavam u {iterations: [...]}.`);
                    outlineJson = { iterations: outlineJson };
                }
                fs.writeFileSync(outlinePath, JSON.stringify(outlineJson, null, 2), "utf-8");
                const elapsed = ((Date.now() - startTime1) / 1000).toFixed(1);
                console.log(`   ✅ [FAZA 1] Outline spremljen. Pronađeno ${outlineJson.iterations?.length || 0} iteracija. (${elapsed}s)`);
            } catch (err) {
                if (err.blocked) {
                    const { blockedPath: bp, retryCount } = saveBlockedMarker(file, err);
                    const permanent = retryCount >= MAX_BLOCKED_RETRIES ? " (TRAJNO)" : "";
                    console.error(`   🚫 [FAZA 1] Blokirano: ${err.blockReason} — pokušaj ${retryCount}/${MAX_BLOCKED_RETRIES}${permanent}`);
                    return false;
                }
                console.error(`   ❌ [FAZA 1] Greška: ${err.message}`);
                if (exitOnError) process.exit(1);
                return false;
            }
        }

        await sleep(REQUEST_DELAY_MS);
    }

    if (Array.isArray(outlineJson)) {
        outlineJson = { iterations: outlineJson };
    }

    if (!outlineJson || !outlineJson.iterations || outlineJson.iterations.length === 0) {
        console.error("   ❌ Outline ne sadrži validne iteracije. Prekidam.");
        if (exitOnError) process.exit(1);
        return false;
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
            console.log(`\n   ✅ [FAZA 2] Članak već postoji i kompletiran je (${finalArticle.iterations.length} iteracija)`);
            return true;
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
            const result2 = await callGemini(SYSTEM_PROMPT_2, iterDetails, `FAZA 2 — Iteracija ${iter.iteration_number}`, rawPath2);
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
            if (err.blocked) {
                const { blockedPath: bp, retryCount } = saveBlockedMarker(file, err);
                const permanent = retryCount >= MAX_BLOCKED_RETRIES ? " (TRAJNO)" : "";
                console.error(`      🚫 [FAZA 2] Blokirano u iteraciji ${iter.iteration_number}: ${err.blockReason} — pokušaj ${retryCount}/${MAX_BLOCKED_RETRIES}${permanent}`);
                // Spremi dosadašnji progress članka
                if (finalArticle.iterations.length > 0) {
                    fs.writeFileSync(articlePath, JSON.stringify(finalArticle, null, 2), "utf-8");
                }
                return false;
            }
            console.error(`      ❌ Greška u iteraciji ${iter.iteration_number}: ${err.message}`);
            console.log("   Spremam dosadašnji progress...");
            fs.writeFileSync(articlePath, JSON.stringify(finalArticle, null, 2), "utf-8");
            if (exitOnError) process.exit(1);
            return false;
        }
    }

    writeUsageDiff(baseDir, epBase, "article", diffUsage(_usage0));   // per-epizodu Gemini trošak
    console.log(`\n   🎉 [GOTOVO] Kompletan članak: ${path.basename(articlePath)}`);
    return true;
}

// ─── MAIN ────────────────────────────────────────────────────────

async function main() {
    const opts = parseArgs();

    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📰 GEMINI ARTICLE GENERATOR (2 FAZE)          ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   🤖 Model:    ${GEMINI_MODEL}`);
    console.log(`   🌐 Vertex AI: ${VERTEX_PROJECT}`);
    const gcloudProject = (() => { try { return execSync("gcloud config get-value project 2>/dev/null", { encoding: "utf-8" }).trim(); } catch { return "N/A"; } })();
    if (gcloudProject !== VERTEX_PROJECT) {
        console.log(`   ⚠️  gcloud projekt: ${gcloudProject} (RAZLIKUJE SE OD VERTEX_PROJECT!)`);
    } else {
        console.log(`   ✅ gcloud projekt: ${gcloudProject}`);
    }
    console.log(`   🔄 Regije (${VERTEX_REGIONS.length}): ${VERTEX_REGIONS.join(", ")}`);

    // ── Način 1: Pojedinačna datoteka ──
    if (opts.mode === "single") {
        console.log(`   📂 Datoteka: ${opts.file}`);
        console.log("");
        await processFile(opts.file, { exitOnError: true });
        console.log("");
        return;
    }

    // ── Način 2: Batch s round-robin rasporedom ──
    const { inputDir, channel, videoId, limit, dryRun, rebuildState } = opts;
    console.log(`   📂 Input:    ${inputDir}`);
    if (channel) console.log(`   🎯 Kanal:    ${channel}`);
    if (videoId) console.log(`   🎯 Video ID: ${videoId}`);
    if (limit) console.log(`   🔢 Limit:    ${limit}`);
    if (dryRun) console.log("   ⚠️  DRY RUN — samo prikaz, bez API poziva");
    if (rebuildState) console.log("   🔄 REBUILD STATE — ignoriram done cache");
    console.log("");

    // Done cache: O(1) skip za već kompletne članke
    const doneSet = rebuildState ? new Set() : loadDoneState(inputDir);
    if (doneSet.size > 0) {
        console.log(`   💾 Done cache: ${doneSet.size} već kompletiranih članaka`);
    }

    // Pronađi datoteke kojima nedostaje članak
    console.log("   Skeniram direktorije...");
    const { byChannel, cachedSkipped, fsSkipped } = discoverPendingFiles(inputDir, channel, doneSet, videoId);

    let totalPending = 0;
    for (const files of byChannel.values()) totalPending += files.length;

    console.log(`   ✅ Preskočeno (cache):            ${cachedSkipped}`);
    if (fsSkipped > 0) console.log(`   ✅ Preskočeno (FS check):         ${fsSkipped} (dodano u cache)`);
    console.log(`   📊 Kanala s neobrađenim videima:  ${byChannel.size}`);
    console.log(`   📊 Ukupno videa za obradu:        ${totalPending}`);
    console.log("");

    if (totalPending === 0) {
        // Spremi cache warming rezultate
        if (fsSkipped > 0 && !dryRun) saveDoneState(inputDir, doneSet);
        console.log("   ✅ Svi videi već imaju kompletiran članak.");
        return;
    }

    // Gradi round-robin red
    const queue = buildRoundRobinQueue(byChannel);
    const finalQueue = limit ? queue.slice(0, limit) : queue;

    if (dryRun) {
        console.log(`   📋 Round-robin red (${finalQueue.length} videa):`);
        for (let i = 0; i < finalQueue.length; i++) {
            const item = finalQueue[i];
            console.log(`      ${String(i + 1).padStart(4)}. [${item.channel}] ${path.basename(item.srtPath)}`);
        }
        console.log("");
        return;
    }

    // Obradi redom
    let success = 0;
    let failed = 0;

    for (let i = 0; i < finalQueue.length; i++) {
        const item = finalQueue[i];
        console.log("");
        console.log(`   ━━━ [${i + 1}/${finalQueue.length}] [${item.channel}] ${path.basename(item.srtPath)} ━━━`);

        const ok = await processFile(item.srtPath, { exitOnError: false });
        if (ok) {
            success++;
            const baseKey = path.basename(item.srtPath).replace(/\.wav\.canary\.diarized\.srt$/, "");
            doneSet.add(baseKey);
            // Periodično spremanje cachea (svaki 10. uspjeh)
            if (success % 10 === 0) saveDoneState(inputDir, doneSet);
        } else {
            failed++;
            console.error(`   ⚠️  Greška za ${path.basename(item.srtPath)}, nastavljam s idućim...`);
        }
    }

    // Spremi done cache
    if (!dryRun) {
        saveDoneState(inputDir, doneSet);
    }

    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📊 BATCH ZAVRŠEN                              ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   ✅ Uspješno: ${success}`);
    if (failed > 0) console.log(`   ❌ Neuspješno: ${failed}`);
    console.log(`   💾 Done cache: ${doneSet.size} epizoda`);
    if (sessionUsage.calls > 0) {
        console.log(`   💳 Gemini ovaj run: ${sessionUsage.prompt}+${sessionUsage.output} tok u ${sessionUsage.calls} poziva ≈ $${sessionUsage.usd.toFixed(4)} (${VERTEX_PROJECT})`);
    }
    console.log("");
}

// Pokreni main samo kad se izvršava direktno (ne kad se require-a kao modul)
if (require.main === module) {
    main().catch((err) => {
        console.error("Fatal error:", err);
        process.exit(1);
    });
}

// Eksportiraj funkcije za testiranje
module.exports = {
    extractJsonFromText,
    tryRepairMalformedJson,
    tryRepairTruncatedJson,
    sanitizeJsonControlChars,
    buildRoundRobinQueue,
    findLatestFile,
    hasCompleteArticle,
    discoverPendingFiles,
    processFile,
    callGemini,
    DIARIZED_SRT_SUFFIX,
    // Za testiranje: postavi cached token da se izbjegne poziv gcloud auth
    _setTestToken(token) {
        cachedAccessToken = token;
        tokenExpiry = Date.now() + 999_999_999;
    },
};
