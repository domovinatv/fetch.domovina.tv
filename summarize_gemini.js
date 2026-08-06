#!/usr/bin/env node

/**
 * summarize_gemini.js
 *
 * Generira sažetke diariziranih transkripata pomoću Google Gemini API-ja.
 *
 * ZA SVAKI .canary.diarized.srt generira:
 *   1. .canary.summary.json — strukturirani JSON za import u bazu podataka
 *   2. .canary.summary.md  — čitljivi Markdown sažetak
 *
 * PRINCIP RADA:
 *   1. Rekurzivno skenira --input-dir za .canary.diarized.srt datoteke
 *   2. Za svaku datoteku provjerava postoji li već .canary.summary.json → preskače
 *   3. Čita SRT transkript + .info.json metapodatke (naslov, opis, tagovi)
 *   4. Šalje Gemini API-ju s hrvatskim system promptom
 *   5. Parsira strukturirani JSON odgovor i sprema oba formata
 *
 * ZAŠTITA OD HALUCINACIJA:
 *   - System prompt eksplicitno zabranjuje izmišljanje informacija
 *   - Sažetak mora odgovarati isključivo sadržaju transkripta
 *   - Gemini prima CIJELI transkript (kontekst od 1M tokena to omogućuje)
 *
 * PREDUVJETI:
 *   - gcloud CLI instaliran i autentificiran (gcloud auth login)
 *   - GCP projekt s omogućenim Vertex AI API-jem
 *   - Node.js 18+ (za native fetch)
 *
 * Endpoint: Vertex AI (us-central1-aiplatform.googleapis.com) s OAuth Bearer tokenom.
 * Koristi GCP kredite (free trial / GenAI krediti), ne naplaćuje karticu direktno.
 *
 * Primjeri:
 *   node summarize_gemini.js --input-dir /Volumes/DOMOVINA1TB/fetch_domovina_tv_output
 *   node summarize_gemini.js --input-dir ... --channel bozanstvena_komedija --limit 5
 *   node summarize_gemini.js --input-dir ... --model gemini-2.5-flash
 *   node summarize_gemini.js --input-dir ... --dry-run
 */

const fs = require("fs");
const os = require("os");
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

let GEMINI_MODEL = GEMINI_CONF.GEMINI_MODEL || "gemini-2.5-flash";
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || GEMINI_CONF.VERTEX_PROJECT || "project-a275a620-ef0c-45ae-99e";
// Pinani gcloud identitet (vidi gemini.conf). Sprječava 403 kad globalni aktivni
// account flipne na drugi SA. Prazno → fallback na aktivni account.
const VERTEX_ACCOUNT = process.env.VERTEX_ACCOUNT || GEMINI_CONF.VERTEX_ACCOUNT || "";

// ─── GEMINI USAGE / TROŠAK TRACKING ───────────────────────────────
// Vertex vraća usageMetadata (token brojevi) po pozivu. Procjenjujemo trošak iz
// cjenika gemini-2.5-flash (USD/1M tokena; override u gemini.conf ili env).
// "diff" = koliko je SVAKA epizoda potrošila u OVOM runu → sidecar {base}.gemini_usage.json + log.
// NAPOMENA: radi samo za --gemini-backend vertex (CLI ne vraća token brojeve).
const PRICE_IN_PER_M  = parseFloat(process.env.GEMINI_PRICE_IN  || GEMINI_CONF.GEMINI_PRICE_IN  || "0.30");
const PRICE_OUT_PER_M = parseFloat(process.env.GEMINI_PRICE_OUT || GEMINI_CONF.GEMINI_PRICE_OUT || "2.50");
const sessionUsage = { calls: 0, prompt: 0, output: 0, total: 0, usd: 0 };
function recordUsage(um) {   // pozvati nakon SVAKOG API odgovora (data.usageMetadata)
    if (!um) return;
    const p = um.promptTokenCount || 0;
    const o = (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0);
    sessionUsage.calls++;
    sessionUsage.prompt += p;
    sessionUsage.output += o;
    sessionUsage.total  += (um.totalTokenCount || (p + o));
    sessionUsage.usd    += p / 1e6 * PRICE_IN_PER_M + o / 1e6 * PRICE_OUT_PER_M;
}
function snapshotUsage() { return { ...sessionUsage }; }   // za per-epizodu diff
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

// Backend: "vertex" (default, Vertex AI REST API + region rotacija), "cli" (gemini CLI, non-interactive)
// ili "claude" (Claude Code CLI pod pretplatom — vidi niže).
// Postavi preko env vara GEMINI_BACKEND=... (run_pipeline.sh --gemini-backend ...).
const GEMINI_BACKEND = (process.env.GEMINI_BACKEND || "vertex").toLowerCase();

// ─── CLAUDE CODE CLI BACKEND (GEMINI_BACKEND=claude) ──────────────
// Koristi lokalno prijavljeni `claude` CLI preko Claude Code PRETPLATE (OAuth), NE API keya.
// Namjena: kvalitetnija obrada aktualnih/prioritetnih videa. Batch backlog ostaje na Vertexu
// jer pretplata ima rate limit, a jedna epizoda troši ~50-400k input tokena.
//
// Kritični flagovi (empirijski izmjereno 2026-07-25):
//   --tools ""            → bez tool definicija u kontekstu: overhead 21k → 233 tokena po pozivu
//   --setting-sources ""  → ne učitava user/project settings, hookove ni pluginove
//   cwd = neutralni dir   → inače `claude` auto-discovera repo CLAUDE.md u SVAKI poziv
//   --output-format json  → daje `result` (tekst) + `usage` + `total_cost_usd` za sidecar
//   NIKAD --bare          → forsira ANTHROPIC_API_KEY, tj. per-token naplatu umjesto pretplate
const CLAUDE_MODEL     = process.env.CLAUDE_MODEL  || GEMINI_CONF.CLAUDE_MODEL  || "opus";
const CLAUDE_EFFORT    = process.env.CLAUDE_EFFORT || GEMINI_CONF.CLAUDE_EFFORT || "high";
// Opus 5 cjenik (USD/1M) — koristi se samo kao fallback ako CLI ne vrati total_cost_usd.
const CLAUDE_PRICE_IN  = parseFloat(process.env.CLAUDE_PRICE_IN  || GEMINI_CONF.CLAUDE_PRICE_IN  || "5.00");
const CLAUDE_PRICE_OUT = parseFloat(process.env.CLAUDE_PRICE_OUT || GEMINI_CONF.CLAUDE_PRICE_OUT || "25.00");
const CLAUDE_MAX_RETRIES = parseInt(process.env.CLAUDE_MAX_RETRIES || "3", 10);
const CLAUDE_CWD = path.join(os.tmpdir(), "domovina_claude_cli");

const USING_CLAUDE = GEMINI_BACKEND === "claude";
// Oznake koje idu u {base}.gemini_usage.json sidecar (dijeli ga s korakom 8).
// GEMINI_MODEL se može prepisati preko --model, pa se čita lijeno (funkcija, ne const).
function usageModelName() { return USING_CLAUDE ? `claude-code:${CLAUDE_MODEL}` : GEMINI_MODEL; }
const USAGE_PRICE_IN  = USING_CLAUDE ? CLAUDE_PRICE_IN  : PRICE_IN_PER_M;
const USAGE_PRICE_OUT = USING_CLAUDE ? CLAUDE_PRICE_OUT : PRICE_OUT_PER_M;

// Claude CLI vraća usage u Anthropic formatu — mapiraj u isti sessionUsage akumulator.
// prompt = svježi input + cache write + cache read (sve troši kvotu pretplate).
function recordClaudeUsage(u, costUsd) {
    if (!u) return;
    const p = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const o = u.output_tokens || 0;
    sessionUsage.calls++;
    sessionUsage.prompt += p;
    sessionUsage.output += o;
    sessionUsage.total  += p + o;
    // CLI-jev total_cost_usd je točniji od flat in/out računice jer uračunava
    // cache-write (2×) i cache-read (0.1×) cijene. Na pretplati je to "ekvivalentni" trošak.
    sessionUsage.usd += (typeof costUsd === "number" && isFinite(costUsd))
        ? costUsd
        : (p / 1e6 * CLAUDE_PRICE_IN + o / 1e6 * CLAUDE_PRICE_OUT);
}

// Multi-region rotacija: svaki region ima nezavisnu kvotu (per-project per-region)
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

// Rate limiting
const REQUEST_DELAY_MS = 2000;     // 2 sekunde između zahtjeva
const MAX_RETRIES = 10;            // Broj pokušaja pri 429/5xx greškama
const RETRY_BASE_DELAY_MS = 5000;  // Bazno čekanje (smanjeno jer rotiramo regije)
const GRACE_RETRY_HOURS = 24;      // Ponovni pokušaj blokiranog sadržaja nakon X sati
const MAX_BLOCKED_RETRIES = 3;     // Maksimalan broj ponovnih pokušaja prije trajnog blokiranja

// Sufiksi datoteka
const DIARIZED_SRT_SUFFIX = ".canary.diarized.srt";
const SORTFORMER_DIARIZED_SRT_SUFFIX = ".sortformer.diarized.srt";

const HOMILY_SRT_SUFFIX = ".homily.srt";
const HOMILY_META_SUFFIX = ".homily.json";

// Razrješava koji se dijarizirani SRT stvarno čita za dani canary path.
// Prioritet: homily → sortformer → canary. Discovery i izlazna imena fajlova
// ostaju canary-anchored (count_progress, R2 putanje, downstream tooling se ne
// mijenja) — pomiče se samo izvor čitanja sadržaja transkripta.
//
// HOMILY: kod prijenosa svetih misa `extract_homily.js` izdvaja SAMO propovijed.
// Ostatak je Red mise — identičan u cijelom svijetu. Izmjereno na misi 24.7.2026:
// 83.7% RAG chunkova i 78.1% teksta članka otpada na liturgiju, a puni backfill
// od 426 misa unio bi ~15 300 near-duplicate chunkova. Uz to svaka misa počinje
// misnim nakanama koje imenuju privatne osobe (pokojnici i obitelji naručitelja),
// što u pretraživom korpusu nema što tražiti — rez ih izbacuje usput.
//
// Gate na confidence "high": LOW/medium znači da detekcija granica nije bila
// sigurna (npr. propovijed bez prepoznatljivog kraja evanđelja), a tada je puni
// transkript manje štetan od krivo odrezanog. Gasi se s DOMOVINA_IGNORE_HOMILY=1.
function resolveDiarizedSrt(canarySrtPath) {
    if (process.env.DOMOVINA_IGNORE_HOMILY !== "1") {
        const homilyPath = canarySrtPath.replace(/\.wav\.canary\.diarized\.srt$/, HOMILY_SRT_SUFFIX);
        const metaPath = canarySrtPath.replace(/\.wav\.canary\.diarized\.srt$/, HOMILY_META_SUFFIX);
        if (homilyPath !== canarySrtPath && fs.existsSync(homilyPath) && fs.existsSync(metaPath)) {
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
                if (meta && meta.detection && meta.detection.confidence === "high"
                    && meta.timestamps_preserved === true) {
                    return { path: homilyPath, source: "homily" };
                }
            } catch (_) { /* neispravan meta → padaj na puni transkript */ }
        }
    }
    const sortformerPath = canarySrtPath.replace(
        /\.canary\.diarized\.srt$/,
        SORTFORMER_DIARIZED_SRT_SUFFIX
    );
    if (fs.existsSync(sortformerPath)) {
        return { path: sortformerPath, source: "sortformer" };
    }
    return { path: canarySrtPath, source: "canary" };
}

const SUMMARY_JSON_SUFFIX = ".canary.summary.json";
const SUMMARY_MD_SUFFIX = ".canary.summary.md";
const SUMMARY_BLOCKED_SUFFIX = ".canary.summary.blocked.json";
const INFO_JSON_SUFFIX = ".info.json";

// Verzija output sheme — za backward compatibility kod budućih promjena
const SCHEMA_VERSION = "1.0";

// ─── SYSTEM PROMPT ───────────────────────────────────────────────
// Pažljivo konstruiran za:
//   1. Hrvatski jezik s ispravnom gramatikom i pravopisom
//   2. Nema halucinacija — sve mora biti iz transkripta
//   3. Strukturirani JSON output za strojnu obradu

const SYSTEM_PROMPT = `Ti si AI asistent specijaliziran za analizu i sažimanje diariziranih transkripata na hrvatskom jeziku.

TVOJ ZADATAK:
Analiziraj priloženi diarizirani transkript podcasta/emisije i generiraj strukturirani sažetak.

STROGA PRAVILA:
1. PIŠI ISKLJUČIVO NA HRVATSKOM JEZIKU s ispravnom gramatikom i pravopisom.
2. ZABRANJENO JE HALUCINIRATI — svaka informacija u sažetku MORA se temeljiti isključivo na sadržaju transkripta. Ako nešto nije jasno iz transkripta, napiši "nije navedeno" umjesto da izmišljaš.
3. Za identifikaciju govornika: koristi kontekstualne tragove iz razgovora (npr. "ja sam voditelj", obraćanje imenom). Ako ne možeš pouzdano identificirati govornika, koristi generične oznake ("Voditelj", "Gost 1", "Gost 2"). NIKADA ne izmišljaj imena govornika.
3b. ZAPIS IMENA JE DOSLOVAN: ako je ime navedeno u naslovu ili opisu epizode (metapodaci), prepiši ga TOČNO takvim zapisom — bez pravopisne "korekcije" ili pohrvaćivanja (npr. ako u naslovu piše "Lucia", NE piši "Lucija"; "Mia" ostaje "Mia"). Metapodaci izdavača su autoritativniji izvor zapisa imena od ASR transkripta, koji imena često krivo čuje.
4. Ključni zaključci moraju biti PARAFRAZE stvarnih izjava iz transkripta, ne tvoje interpretacije.

VRATI ISKLJUČIVO VALJAN JSON OBJEKT (bez markdown formatiranja, bez \`\`\`json blokova) u ovom formatu:
{
  "title_hr": "Naslov epizode na hrvatskom (iz metapodataka ili iz konteksta razgovora)",
  "abstract_hr": "Sažetak od 3-5 rečenica koji opisuje temu, kontekst i glavne zaključke razgovora.",
  "key_topics": ["tema1", "tema2", "tema3"],
  "speakers": [
    {"id": "SPEAKER_XX", "suggested_name": "Ime ako je identificirano, inače Voditelj/Gost N", "role": "voditelj/gost/sugovornik"}
  ],
  "key_points": [
    "Ključni zaključak ili izjava 1",
    "Ključni zaključak ili izjava 2",
    "Ključni zaključak ili izjava 3"
  ],
  "mentioned_people": ["Ime i prezime osobe koja se spominje u razgovoru"],
  "mentioned_places": ["Naziv mjesta/države koja se spominje"],
  "mentioned_organizations": ["Naziv organizacije/tvrtke/institucije"],
  "language": "hr",
  "content_type": "podcast",
  "sentiment": "positive/negative/neutral/mixed"
}

NAPOMENE:
- key_topics: 3-8 tema, na hrvatskom, malim slovima
- key_points: 3-7 ključnih zaključaka, svaki 1-2 rečenice
- mentioned_people/places/organizations: samo ono što se EKSPLICITNO spominje u transkriptu
- sentiment: ukupni ton razgovora
- Ako je transkript na engleskom, i dalje piši sažetak na HRVATSKOM`;

// ─── POMOĆNE FUNKCIJE ────────────────────────────────────────────

/**
 * Pauzira izvršavanje za zadani broj milisekundi.
 * Koristi se za rate limiting između Gemini API poziva.
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Formatira trajanje u sekudama u čitljiv format (Xh Ym Zs).
 */
function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
}

/**
 * Izvlači YouTube video ID iz naziva datoteke.
 * Očekuje format: ..._yt_XXXXXXXXXXX.wav.canary.diarized.srt
 * Vraća 11-znakovni YouTube ID ili null.
 */
function extractVideoIdFromFilename(filename) {
    // Last-match (fix 2026-06-06): greedy `.*` forsira ZADNJI _yt_ jer naslov SAM može
    // sadržavati "_yt_" (npr. ..._yt_kanala_crypto_hrvatska_yt_7OospmYpHRU → bez ovoga
    // bi uhvatilo "kanala_cryp"). Boundary `(?:[._]|$)` pokriva bare base I filename sa sufiksom.
    const match = filename.match(/.*_yt_([a-zA-Z0-9_-]{11})(?:[._]|$)/);
    return match ? match[1] : null;
}

/**
 * Izvlači datum iz naziva datoteke.
 * Očekuje format: 20241212_naslov_... → "2024-12-12"
 */
function extractDateFromFilename(filename) {
    const match = filename.match(/^(\d{4})(\d{2})(\d{2})_/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/**
 * Izvlači naziv kanala iz putanje datoteke.
 * Putanja: /base/output/dir/KANAL/datoteka.srt → "KANAL"
 */
function extractChannelFromPath(filePath, inputDir) {
    const relative = path.relative(inputDir, filePath);
    const parts = relative.split(path.sep);
    return parts.length >= 2 ? parts[0] : "unknown";
}

/**
 * Čita .info.json metapodatke za dati SRT fajl.
 * Traži .info.json u istom direktoriju, s istim baznim imenom (bez .wav.canary...).
 *
 * @returns {Object|null} Parsirani JSON s naslovom, opisom, tagovima, trajanjem
 */
function loadInfoJson(srtFilePath) {
    const dir = path.dirname(srtFilePath);
    const basename = path.basename(srtFilePath);

    // Odrežemo .wav.canary.diarized.srt da dobijemo bazu
    // npr: "20241212_bk_podcast_1_..._yt_XXX.wav.canary.diarized.srt"
    //  → "20241212_bk_podcast_1_..._yt_XXX"
    const base = basename.replace(/\.wav\.canary\.diarized\.srt$/, "");

    // info.json ima sufiks .info.json direktno na bazi
    const infoPath = path.join(dir, base + INFO_JSON_SUFFIX);

    if (!fs.existsSync(infoPath)) return null;

    try {
        return JSON.parse(fs.readFileSync(infoPath, "utf-8"));
    } catch (e) {
        console.error(`   ⚠️  Neispravan .info.json: ${infoPath}`);
        return null;
    }
}

/**
 * Čita diarizirani SRT i pretvara u čisti tekst za Gemini.
 * Zadržava oznake govornika [SPEAKER_XX] za kontekst, ali uklanja
 * SRT formatiranje (indekse, timestampove, prazne linije).
 *
 * Ulaz (SRT):
 *   1
 *   00:00:00,720 --> 00:00:11,599
 *   [SPEAKER_03] To u kombinaciji sa demokracijom...
 *
 * Izlaz (tekst):
 *   [SPEAKER_03] To u kombinaciji sa demokracijom...
 */
function srtToText(srtContent) {
    const lines = srtContent.split("\n");
    const textLines = [];

    for (const line of lines) {
        const trimmed = line.trim();
        // Preskoči prazne linije, indeksne linije (samo broj), i timestamp linije
        if (!trimmed) continue;
        if (/^\d+$/.test(trimmed)) continue;
        if (/^\d{2}:\d{2}:\d{2}[,.]/.test(trimmed)) continue;

        textLines.push(trimmed);
    }

    return textLines.join("\n");
}

// ─── OAUTH TOKEN (iz generate_article_gemini.js) ───────────────

function getAccessToken() {
    try {
        const acct = VERTEX_ACCOUNT ? ` --account=${VERTEX_ACCOUNT}` : "";
        return execSync(`gcloud auth print-access-token${acct}`, { encoding: "utf-8" }).trim();
    } catch (err) {
        console.error("❌ Ne mogu dohvatiti access token. Pokreni: gcloud auth login");
        process.exit(1);
    }
}

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

// ─── GEMINI CLI (non-interactive, koristi user-level google auth) ───

/**
 * Poziva `gemini` CLI u headless modu. Cijeli sustav-prompt + user-message ide
 * preko stdina, a `-p` služi samo kao bridge direktiva. Ovo zaobilazi ARG_MAX
 * limit (transkripti znaju biti 100-200KB).
 *
 * CLI nema separaciju system/user — koristimo dogovorenu strukturu s razdjelnikom.
 * Output je raw text (model.response), bez metadata wrappera (`-o text` je default).
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

// ─── CLAUDE CODE CLI (non-interactive, koristi subscription OAuth) ───

/**
 * Poziva `claude -p` u headless modu. System prompt ide preko --system-prompt,
 * korisnička poruka (metapodaci + transkript) preko stdina — izbjegava ARG_MAX
 * za transkripte od 100-500 KB.
 *
 * @returns {Promise<{text: string, usage: Object|null, costUsd: number|null}>}
 */
function callClaudeCli(systemPrompt, userMessage) {
    return new Promise((resolve, reject) => {
        try { fs.mkdirSync(CLAUDE_CWD, { recursive: true }); } catch (_) {}

        const args = [
            "-p",
            "--model", CLAUDE_MODEL,
            "--effort", CLAUDE_EFFORT,
            "--output-format", "json",
            "--setting-sources", "",
            "--strict-mcp-config",
            "--max-turns", "1",
            "--tools", "",            // variadic: MORA biti praćen sljedećim flagom
            "--system-prompt", systemPrompt,
        ];

        const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], cwd: CLAUDE_CWD });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => { stdout += d; });
        proc.stderr.on("data", (d) => { stderr += d; });
        proc.on("error", (err) => reject(new Error(`claude CLI spawn failed: ${err.message}`)));
        proc.stdin.on("error", (err) => reject(new Error(`claude CLI stdin: ${err.message}`)));

        proc.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`claude CLI exit ${code}: ${(stderr || stdout).substring(0, 400) || "(bez outputa)"}`));
                return;
            }
            let env;
            try {
                env = JSON.parse(stdout);
            } catch (_) {
                reject(new Error(`claude CLI nije vratio JSON envelope. Prvih 300: ${stdout.substring(0, 300)}`));
                return;
            }
            if (env.is_error || env.subtype !== "success") {
                reject(new Error(`claude CLI greška (subtype=${env.subtype}, api_status=${env.api_error_status}): ${String(env.result || "").substring(0, 300)}`));
                return;
            }
            resolve({
                text: env.result || "",
                usage: env.usage || null,
                costUsd: typeof env.total_cost_usd === "number" ? env.total_cost_usd : null,
            });
        });

        proc.stdin.write(userMessage);
        proc.stdin.end();
    });
}

/**
 * Skida markdown fenceove i sanitizira kontrolne znakove prije JSON.parse.
 * Claude ne podržava responseMimeType kao Vertex, pa se oslanjamo na prompt + ovaj repair.
 */
function parseJsonLoose(responseText, sourceLabel) {
    let cleaned = String(responseText).trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    // Ako model doda uvodnu rečenicu, izvuci od prve { do zadnje }
    if (!cleaned.startsWith("{")) {
        const first = cleaned.indexOf("{");
        const last = cleaned.lastIndexOf("}");
        if (first !== -1 && last > first) cleaned = cleaned.slice(first, last + 1);
    }
    try {
        return JSON.parse(cleaned);
    } catch (parseErr) {
        if (parseErr.message.includes("control character") || parseErr.message.includes("Bad control")) {
            const sanitized = cleaned
                .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
                .replace(/\t/g, "\\t");
            const result = JSON.parse(sanitized);
            console.error(`      🔧 JSON automatski popravljen (uklonjeni kontrolni znakovi).`);
            return result;
        }
        throw new Error(`${sourceLabel} vratio neispravan JSON: ${parseErr.message}. Prvih 200 znakova: ${cleaned.substring(0, 200)}`);
    }
}

// ─── GEMINI API (Vertex AI — OAuth Bearer token) ────────────────

/**
 * Poziva Gemini API putem Vertex AI endpointa s OAuth Bearer tokenom.
 * Koristi gcloud CLI za autentikaciju — troši GCP kredite, ne naplaćuje karticu.
 *
 * @param {string} transcript - Čisti tekst transkripta s [SPEAKER_XX] oznakama
 * @param {Object|null} metadata - Podaci iz .info.json (naslov, opis, tagovi)
 * @returns {Object} Parsirani JSON sažetak
 */
async function callGemini(transcript, metadata) {
    // Konstruiraj korisnički prompt s metapodacima + transkriptom
    let userMessage = "";

    if (metadata) {
        userMessage += "=== METAPODACI ===\n";
        if (metadata.title) userMessage += `Naslov: ${metadata.title}\n`;
        if (metadata.description) userMessage += `Opis: ${metadata.description}\n`;
        if (metadata.tags && metadata.tags.length > 0) {
            userMessage += `Tagovi: ${metadata.tags.slice(0, 20).join(", ")}\n`;
        }
        if (metadata.duration) {
            const mins = Math.floor(metadata.duration / 60);
            userMessage += `Trajanje: ${mins} minuta\n`;
        }
        if (metadata.channel) userMessage += `Kanal: ${metadata.channel}\n`;
        userMessage += "\n";
    }

    userMessage += "=== DIARIZIRANI TRANSKRIPT ===\n";
    userMessage += transcript;

    // ── CLAUDE CODE backend grana ──
    // Kvalitetnija obrada preko `claude -p` (Opus, subscription OAuth).
    // Nema region rotacije; retry s backoffom jer pretplata zna vratiti rate-limit.
    if (USING_CLAUDE) {
        let lastErr = null;
        for (let attempt = 1; attempt <= CLAUDE_MAX_RETRIES; attempt++) {
            try {
                const t0 = Date.now();
                const res = await callClaudeCli(SYSTEM_PROMPT, userMessage);
                recordClaudeUsage(res.usage, res.costUsd);
                const secs = ((Date.now() - t0) / 1000).toFixed(1);
                const u = res.usage || {};
                const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
                console.error(`      🧠 Claude (${CLAUDE_MODEL}/${CLAUDE_EFFORT}): ${inTok}→${u.output_tokens || 0} tok, ${secs}s`);
                return parseJsonLoose(res.text, "claude CLI");
            } catch (err) {
                lastErr = err;
                if (attempt < CLAUDE_MAX_RETRIES) {
                    const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                    console.error(`      ⏳ claude CLI pokušaj ${attempt}/${CLAUDE_MAX_RETRIES} pao (${err.message.substring(0, 160)}) — čekam ${waitMs / 1000}s`);
                    await sleep(waitMs);
                }
            }
        }
        throw lastErr;
    }

    // ── CLI backend grana ──
    // Kad je GEMINI_BACKEND=cli, koristi gemini CLI umjesto Vertex API-ja.
    // Nema region rotacije ni retry petlje — CLI ima vlastiti auth/retry.
    if (GEMINI_BACKEND === "cli") {
        const responseText = await callGeminiCli(SYSTEM_PROMPT, userMessage);
        let cleanedJson = responseText.trim();
        cleanedJson = cleanedJson.replace(/^```json\s*\n?/, "").replace(/\n?```\s*$/, "");
        try {
            return JSON.parse(cleanedJson);
        } catch (parseErr) {
            if (parseErr.message.includes("control character") || parseErr.message.includes("Bad control")) {
                const sanitized = cleanedJson
                    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
                    .replace(/\t/g, "\\t");
                const result = JSON.parse(sanitized);
                console.error(`      🔧 JSON automatski popravljen (uklonjeni kontrolni znakovi).`);
                return result;
            }
            throw new Error(`gemini CLI vratio neispravan JSON: ${parseErr.message}. Prvih 200 znakova: ${cleanedJson.substring(0, 200)}`);
        }
    }

    // Vertex AI payload — systemInstruction odvojen od contents
    const payload = {
        contents: [
            {
                role: "user",
                parts: [{ text: userMessage }]
            }
        ],
        systemInstruction: {
            role: "system",
            parts: [{ text: SYSTEM_PROMPT }]
        },
        generationConfig: {
            temperature: 0.2,   // Niska temperatura za konzistentne, faktične sažetke
            responseMimeType: "application/json"  // Forsiraj JSON output
        }
    };

    // Exponential backoff za rate limiting (429) i server greške (5xx)
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const region = getNextRegion();
        const url = buildEndpointUrl(region);
        const token = getOrRefreshAccessToken();

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorBody = await response.text();

                // Token istekao → refresh i retry
                if (response.status === 401) {
                    console.error(`      ⚠️  Access token istekao — refresham...`);
                    cachedAccessToken = null;
                    tokenExpiry = 0;
                    continue;
                }

                // 429 Rate Limit — rotiramo na sljedeći region
                if (response.status === 429) {
                    const waitMs = Math.min(RETRY_BASE_DELAY_MS * attempt, 30000);
                    console.error(`      ⏳ HTTP 429 na ${region} — rotiram region, čekam ${waitMs / 1000}s (pokušaj ${attempt}/${MAX_RETRIES})`);
                    await sleep(waitMs);
                    continue;
                }

                // 500+ Server greška
                if (response.status >= 500) {
                    const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                    console.error(`      ⏳ HTTP ${response.status} na ${region} — čekam ${waitMs / 1000}s (pokušaj ${attempt}/${MAX_RETRIES})`);
                    await sleep(waitMs);
                    continue;
                }

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

            // Izvuci tekst odgovora iz Gemini response strukture
            if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
                throw new Error(`Neočekivan Gemini odgovor: ${JSON.stringify(data).substring(0, 300)}`);
            }

            const responseText = data.candidates[0].content.parts[0].text;

            // Parsiraj JSON iz odgovora
            let cleanedJson = responseText.trim();
            cleanedJson = cleanedJson.replace(/^```json\s*\n?/, "").replace(/\n?```\s*$/, "");

            try {
                return JSON.parse(cleanedJson);
            } catch (parseErr) {
                // Sanitiziraj kontrolne znakove koje Gemini ponekad ubaci u JSON stringove
                if (parseErr.message.includes("control character") || parseErr.message.includes("Bad control")) {
                    const sanitized = cleanedJson
                        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
                        .replace(/\t/g, "\\t");
                    const result = JSON.parse(sanitized);
                    console.error(`      🔧 JSON automatski popravljen (uklonjeni kontrolni znakovi).`);
                    return result;
                }
                throw parseErr;
            }

        } catch (err) {
            // Blokirani sadržaj — nema smisla retryati, odmah propagiraj
            if (err.blocked) throw err;

            if (attempt === MAX_RETRIES) throw err;

            // Network error → retry s rotacijom regije
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

// ─── OUTPUT GENERIRANJE ──────────────────────────────────────────

/**
 * Gradi kompletni JSON objekt za .canary.summary.json.
 * Kombinira Gemini sažetak s metapodacima iz .info.json i datoteke.
 *
 * @param {Object} geminiResult - Parsirani JSON od Gemini-ja
 * @param {string} srtFilename - Naziv izvorne SRT datoteke
 * @param {string} channel - Naziv kanala
 * @param {Object|null} metadata - .info.json metapodaci
 * @returns {Object} Kompletni JSON za spremanje
 */
function buildSummaryJson(geminiResult, srtFilename, channel, metadata) {
    const base = path.basename(srtFilename).replace(/\.wav\.canary\.diarized\.srt$/, "");
    const youtubeId = extractVideoIdFromFilename(base);
    const uploadDate = extractDateFromFilename(base);

    return {
        version: SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        model: usageModelName(),   // "gemini-3.5-flash" ili "claude-code:opus" — provenance ide downstream

        // Izvorni podaci o datoteci
        source: {
            filename: base,
            channel: channel,
            youtube_id: youtubeId,
            title: metadata?.title || geminiResult.title_hr || base,
            upload_date: uploadDate,
            duration_seconds: metadata?.duration || null
        },

        // Gemini generirani sažetak
        summary: {
            title_hr: geminiResult.title_hr || "",
            abstract_hr: geminiResult.abstract_hr || "",
            key_topics: geminiResult.key_topics || [],
            speakers: geminiResult.speakers || [],
            key_points: geminiResult.key_points || [],
            mentioned_people: geminiResult.mentioned_people || [],
            mentioned_places: geminiResult.mentioned_places || [],
            mentioned_organizations: geminiResult.mentioned_organizations || [],
            language: geminiResult.language || "hr",
            content_type: geminiResult.content_type || "podcast",
            sentiment: geminiResult.sentiment || "neutral"
        }
    };
}

/**
 * Generira čitljivi Markdown sažetak iz JSON podataka.
 * Ovaj format je namijenjen za ljudsko čitanje i pregled.
 *
 * @param {Object} summaryJson - Kompletni JSON objekt iz buildSummaryJson()
 * @returns {string} Markdown tekst
 */
function buildSummaryMarkdown(summaryJson) {
    const s = summaryJson.summary;
    const src = summaryJson.source;

    let md = "";

    // Naslov
    md += `# ${s.title_hr || src.title}\n\n`;

    // Metapodaci
    md += `**Kanal:** ${src.channel}  \n`;
    if (src.upload_date) md += `**Datum:** ${src.upload_date}  \n`;
    if (src.duration_seconds) {
        const mins = Math.floor(src.duration_seconds / 60);
        md += `**Trajanje:** ${mins} min  \n`;
    }
    if (src.youtube_id) md += `**YouTube:** https://youtu.be/${src.youtube_id}  \n`;
    md += `**Model:** ${summaryJson.model}  \n`;
    md += "\n";

    // Sažetak
    if (s.abstract_hr) {
        md += `## Sažetak\n\n${s.abstract_hr}\n\n`;
    }

    // Ključne teme
    if (s.key_topics && s.key_topics.length > 0) {
        md += `## Ključne teme\n\n`;
        s.key_topics.forEach((t) => { md += `- ${t}\n`; });
        md += "\n";
    }

    // Govornici
    if (s.speakers && s.speakers.length > 0) {
        md += `## Govornici\n\n`;
        md += `| ID | Ime | Uloga |\n`;
        md += `|----|-----|-------|\n`;
        s.speakers.forEach((sp) => {
            md += `| ${sp.id} | ${sp.suggested_name} | ${sp.role} |\n`;
        });
        md += "\n";
    }

    // Ključni zaključci
    if (s.key_points && s.key_points.length > 0) {
        md += `## Ključni zaključci\n\n`;
        s.key_points.forEach((p, i) => { md += `${i + 1}. ${p}\n`; });
        md += "\n";
    }

    // Spomenute osobe
    if (s.mentioned_people && s.mentioned_people.length > 0) {
        md += `## Spomenute osobe\n\n`;
        s.mentioned_people.forEach((p) => { md += `- ${p}\n`; });
        md += "\n";
    }

    // Spomenuta mjesta
    if (s.mentioned_places && s.mentioned_places.length > 0) {
        md += `## Spomenuta mjesta\n\n`;
        s.mentioned_places.forEach((p) => { md += `- ${p}\n`; });
        md += "\n";
    }

    // Spomenute organizacije
    if (s.mentioned_organizations && s.mentioned_organizations.length > 0) {
        md += `## Spomenute organizacije\n\n`;
        s.mentioned_organizations.forEach((o) => { md += `- ${o}\n`; });
        md += "\n";
    }

    // Sentiment
    md += `---\n*Sentiment: ${s.sentiment} | Generirano: ${summaryJson.generated_at}*\n`;

    return md;
}

// ─── CLI PARSIRANJE ──────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);

    function getArg(name) {
        const idx = args.indexOf(name);
        return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
    }

    const inputDir = getArg("--input-dir");
    const channel = getArg("--channel");
    // --video-id filter: sumariziraj samo jedan video po YouTube ID-u (11 znakova)
    const videoId = getArg("--video-id");
    const limit = getArg("--limit") ? parseInt(getArg("--limit"), 10) : null;
    const dryRun = args.includes("--dry-run");
    const rebuildState = args.includes("--rebuild-state");

    // --model flag za override modela
    const model = getArg("--model");
    if (model) {
        GEMINI_MODEL = model;
    }

    if (!inputDir) {
        console.error("❌ Obavezan argument: --input-dir <putanja>");
        console.error("");
        console.error("Primjeri:");
        console.error("  node summarize_gemini.js --input-dir /Volumes/DOMOVINA1TB/fetch_domovina_tv_output");
        console.error("  node summarize_gemini.js --input-dir ... --channel bozanstvena_komedija --limit 5");
        console.error("  node summarize_gemini.js --input-dir ... --video-id dQw4w9WgXcQ");
        console.error("  node summarize_gemini.js --input-dir ... --model gemini-2.5-flash");
        console.error("  node summarize_gemini.js --input-dir ... --dry-run");
        console.error("  node summarize_gemini.js --input-dir ... --rebuild-state");
        console.error("");
        console.error("Autentikacija: gcloud auth login (OAuth Bearer token)");
        process.exit(1);
    }

    return { inputDir, channel, videoId, limit, dryRun, rebuildState };
}

// ─── DONE CACHE ─────────────────────────────────────────────────

const DONE_STATE_FILENAME = "summarize-done.json";

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

// ─── DISCOVERY: PRONAĐI SVE DATOTEKE ZA OBRADU ──────────────────

/**
 * Rekurzivno pronalazi sve .canary.diarized.srt datoteke u direktoriju.
 * Filtrira prema kanalu ako je naveden.
 * Preskače datoteke koje već imaju .canary.summary.json.
 *
 * @param {string} inputDir - Bazni direktorij s output datotekama
 * @param {string|null} channelFilter - Opcijski filter po kanalu
 * @param {string|null} videoIdFilter - Opcijski filter po YouTube video ID-u (11 znakova)
 * @returns {Array<{srtPath, channel, hasSummary}>} Lista datoteka
 */
function discoverFiles(inputDir, channelFilter, videoIdFilter) {
    const results = [];

    if (!fs.existsSync(inputDir)) {
        console.error(`❌ Input direktorij ne postoji: ${inputDir}`);
        process.exit(1);
    }

    // Skeniramo podirektorije (svaki je kanal)
    const entries = fs.readdirSync(inputDir, { withFileTypes: true });

    for (const entry of entries) {
        if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
        if (entry.name.startsWith(".")) continue;

        const channelName = entry.name;

        // Filtriraj po kanalu ako je navedeno
        if (channelFilter && channelName !== channelFilter) continue;

        const channelDir = path.join(inputDir, channelName);
        const files = fs.readdirSync(channelDir);

        for (const file of files) {
            if (!file.endsWith(DIARIZED_SRT_SUFFIX)) continue;
            if (file.startsWith("._")) continue;  // macOS resource forks
            // Filtriraj po YouTube video ID-u (u imenu kao _yt_VIDEOID)
            if (videoIdFilter && !file.includes(`_yt_${videoIdFilter}`)) continue;

            const srtPath = path.join(channelDir, file);
            const base = file.replace(/\.wav\.canary\.diarized\.srt$/, "");
            const summaryJsonPath = path.join(channelDir, base + ".wav" + SUMMARY_JSON_SUFFIX);
            const blockedJsonPath = path.join(channelDir, base + ".wav" + SUMMARY_BLOCKED_SUFFIX);
            const hasSummary = fs.existsSync(summaryJsonPath);
            
            let isBlocked = false;
            if (fs.existsSync(blockedJsonPath)) {
                try {
                    const blockData = JSON.parse(fs.readFileSync(blockedJsonPath, "utf-8"));
                    const retryCount = blockData.retry_count || 0;
                    const hoursSince = (Date.now() - new Date(blockData.blocked_at).getTime()) / (1000 * 60 * 60);
                    if (retryCount >= MAX_BLOCKED_RETRIES) {
                        isBlocked = true;
                    } else if (hoursSince > GRACE_RETRY_HOURS) {
                        console.log(`   🔄 [RETRY] ${base}: blokiran prije ${Math.round(hoursSince)}h — pokušaj ${retryCount + 1}/${MAX_BLOCKED_RETRIES}`);
                        fs.unlinkSync(blockedJsonPath);
                    } else {
                        isBlocked = true;
                    }
                } catch(e) {
                    isBlocked = true;
                }
            }

            results.push({ srtPath, channel: channelName, hasSummary, isBlocked });
        }
    }

    // Sortiraj po kanalu pa po imenu datoteke
    results.sort((a, b) => {
        if (a.channel !== b.channel) return a.channel.localeCompare(b.channel);
        return a.srtPath.localeCompare(b.srtPath);
    });

    return results;
}

// ─── MAIN ────────────────────────────────────────────────────────

async function main() {
    const { inputDir, channel, videoId, limit, dryRun, rebuildState } = parseArgs();

    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📝 GEMINI SUMARIZACIJA TRANSKRIPATA           ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📂 Input:   ${inputDir}`);
    if (USING_CLAUDE) {
        console.log(`   🧠 Model:   ${CLAUDE_MODEL} (effort=${CLAUDE_EFFORT})`);
        console.log(`   🌐 Endpoint: Claude Code CLI -p (subscription OAuth, bez API keya)`);
        console.log(`   📋 Kontekst: --tools "" --setting-sources "" cwd=${CLAUDE_CWD}`);
    } else {
        console.log(`   🤖 Model:   ${GEMINI_MODEL}`);
        console.log(`   🌐 Endpoint: Vertex AI (OAuth Bearer)`);
        console.log(`   📋 Projekt:  ${VERTEX_PROJECT}`);
        const gcloudProject = (() => { try { return execSync("gcloud config get-value project 2>/dev/null", { encoding: "utf-8" }).trim(); } catch { return "N/A"; } })();
        if (gcloudProject !== VERTEX_PROJECT) {
            console.log(`   ⚠️  gcloud projekt: ${gcloudProject} (RAZLIKUJE SE OD VERTEX_PROJECT!)`);
        } else {
            console.log(`   ✅ gcloud projekt: ${gcloudProject}`);
        }
        console.log(`   🔄 Regije (${VERTEX_REGIONS.length}): ${VERTEX_REGIONS.join(", ")}`);
    }
    if (channel) console.log(`   🎯 Kanal:   ${channel}`);
    if (videoId) console.log(`   🎯 Video ID: ${videoId}`);
    if (limit) console.log(`   🔢 Limit:   ${limit}`);
    if (dryRun) console.log("   ⚠️  DRY RUN — samo prikaz, bez API poziva");
    if (rebuildState) console.log("   🔄 REBUILD STATE — ignoriram done cache");
    console.log("");

    // Done cache: O(1) skip za već obrađene datoteke
    const doneSet = rebuildState ? new Set() : loadDoneState(inputDir);
    if (doneSet.size > 0) {
        console.log(`   💾 Done cache: ${doneSet.size} već obrađenih epizoda`);
    }

    // ── Pronađi datoteke ──
    const allFiles = discoverFiles(inputDir, channel, videoId);
    const blocked = allFiles.filter((f) => f.isBlocked && !f.hasSummary);

    // Filtriraj: cache → FS check → pending
    let cachedSkipped = 0;
    let fsSkipped = 0;
    const toProcess = [];

    for (const f of allFiles) {
        if (f.isBlocked) continue;

        const base = path.basename(f.srtPath).replace(/\.wav\.canary\.diarized\.srt$/, "");

        // O(1) cache provjera
        if (doneSet.has(base)) {
            cachedSkipped++;
            continue;
        }

        // Filesystem fallback (originalna provjera)
        if (f.hasSummary) {
            doneSet.add(base); // Cache warming
            fsSkipped++;
            continue;
        }

        toProcess.push(f);
    }

    console.log(`   📊 Ukupno .canary.diarized.srt:  ${allFiles.length}`);
    console.log(`   ✅ Preskočeno (cache):            ${cachedSkipped}`);
    if (fsSkipped > 0) console.log(`   ✅ Preskočeno (FS check):         ${fsSkipped} (dodano u cache)`);
    if (blocked.length > 0) console.log(`   🚫 Blokiranih (preskačem):       ${blocked.length}`);

    // Primijeni limit
    const finalList = limit ? toProcess.slice(0, limit) : toProcess;
    console.log(`   🔄 Za obradu:                     ${finalList.length}`);
    console.log("");

    if (finalList.length === 0) {
        // Spremi cache warming rezultate
        if (fsSkipped > 0 && !dryRun) saveDoneState(inputDir, doneSet);
        console.log("   ✨ Nema novih datoteka za sumarizaciju!");
        return;
    }

    // ── Grupiraj po kanalu za pregledan ispis ──
    const byChannel = {};
    for (const f of finalList) {
        if (!byChannel[f.channel]) byChannel[f.channel] = [];
        byChannel[f.channel].push(f);
    }

    // ── Statistika ──
    let totalSummarized = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalElapsed = 0;

    // ── Obrada ──
    for (const [ch, files] of Object.entries(byChannel)) {
        console.log(`\n🔵 [${ch.toUpperCase()}] — ${files.length} datoteka`);

        for (let i = 0; i < files.length; i++) {
            const { srtPath } = files[i];
            const basename = path.basename(srtPath);
            const base = basename.replace(/\.wav\.canary\.diarized\.srt$/, "");

            // ── DRY RUN: samo prikaži ──
            if (dryRun) {
                console.log(`   🔄 [SUMARIZIRAO BI] ${base}`);
                totalSummarized++;
                continue;
            }

            const startTime = Date.now();

            try {
                // 1. Čitaj SRT transkript — sortformer ima prioritet ako postoji
                const { path: _actualSrtPath, source: _diarSource } = resolveDiarizedSrt(srtPath);
                if (_diarSource === "sortformer") console.log(`      🎭 Dijarizacija: sortformer (override canary)`);
                if (_diarSource === "homily") console.log(`      ⛪ Izvor: SAMO PROPOVIJED (.homily.srt, confidence=high) — liturgija izostavljena`);
                const srtContent = fs.readFileSync(_actualSrtPath, "utf-8");
                const transcriptText = srtToText(srtContent);

                if (!transcriptText || transcriptText.length < 50) {
                    console.log(`   ⚠️  [PREKRATAK] ${base} — transkript je prazan ili prekratak`);
                    totalSkipped++;
                    continue;
                }

                // 2. Čitaj .info.json metapodatke (opcijski)
                const metadata = loadInfoJson(srtPath);

                // 3. Pozovi Gemini API
                console.log(`   🤖 [GEMINI] ${base}`);
                console.log(`      📄 Transkript: ${(srtContent.length / 1024).toFixed(0)} KB, ${transcriptText.split("\n").length} linija`);

                const _usage0 = snapshotUsage();   // za per-epizodu trošak diff
                const geminiResult = await callGemini(transcriptText, metadata);

                // 4. Gradi output objekte
                const summaryJson = buildSummaryJson(geminiResult, basename, ch, metadata);
                const summaryMd = buildSummaryMarkdown(summaryJson);

                // 5. Spremi JSON
                const jsonOutputPath = path.join(
                    path.dirname(srtPath),
                    base + ".wav" + SUMMARY_JSON_SUFFIX
                );
                fs.writeFileSync(jsonOutputPath, JSON.stringify(summaryJson, null, 2), "utf-8");

                // 6. Spremi Markdown
                const mdOutputPath = path.join(
                    path.dirname(srtPath),
                    base + ".wav" + SUMMARY_MD_SUFFIX
                );
                fs.writeFileSync(mdOutputPath, summaryMd, "utf-8");

                // 6.5 Gemini trošak DIFF za ovu epizodu (samo vertex backend daje token brojeve)
                const _epUsage = diffUsage(_usage0);
                if (_epUsage.calls > 0) {
                    const usagePath = path.join(path.dirname(srtPath), base + ".gemini_usage.json");
                    let prevRuns = [];
                    try { prevRuns = JSON.parse(fs.readFileSync(usagePath, "utf-8")).runs || []; } catch (_) {}
                    const rec = {
                        step: "summary", model: usageModelName(),
                        project: USING_CLAUDE ? "claude-code-subscription" : VERTEX_PROJECT,
                        prompt_tokens: _epUsage.prompt, output_tokens: _epUsage.output,
                        total_tokens: _epUsage.total, calls: _epUsage.calls,
                        est_usd: _epUsage.usd,
                        price_in_per_m: USAGE_PRICE_IN, price_out_per_m: USAGE_PRICE_OUT,
                        at: new Date().toISOString(),
                    };
                    prevRuns = prevRuns.filter(r => r.step !== "summary").concat(rec);
                    const totUsd = Math.round(prevRuns.reduce((s, r) => s + (r.est_usd || 0), 0) * 1e6) / 1e6;
                    fs.writeFileSync(usagePath, JSON.stringify({ base, total_est_usd: totUsd, runs: prevRuns }, null, 2), "utf-8");
                    console.log(`      💳 ${USING_CLAUDE ? "Claude" : "Gemini"} (summary): ${_epUsage.prompt}+${_epUsage.output} tok ≈ $${_epUsage.usd.toFixed(5)}${USING_CLAUDE ? " (ekvivalent; pretplata)" : ""}`);
                }

                const elapsed = (Date.now() - startTime) / 1000;
                totalElapsed += elapsed;

                console.log(`   ✅ [GOTOVO] ${base} (${elapsed.toFixed(1)}s)`);
                console.log(`      📋 ${summaryJson.summary.title_hr?.substring(0, 80) || "(bez naslova)"}`);
                console.log(`      🏷️  ${summaryJson.summary.key_topics?.slice(0, 4).join(", ") || "(bez tema)"}`);
                totalSummarized++;
                doneSet.add(base);

                // Rate limiting — čekaj između zahtjeva
                if (i < files.length - 1) {
                    await sleep(REQUEST_DELAY_MS);
                }

            } catch (err) {
                const elapsed = (Date.now() - startTime) / 1000;

                if (err.blocked) {
                    // Spremi blokirani odgovor kao marker — neće se retryati u budućim pokretanjima
                    const blockedPath = path.join(
                        path.dirname(srtPath),
                        base + ".wav" + SUMMARY_BLOCKED_SUFFIX
                    );
                    let prevRetryCount = 0;
                    try {
                        const prev = JSON.parse(fs.readFileSync(blockedPath, "utf-8"));
                        prevRetryCount = (prev.retry_count || 0) + 1;
                    } catch (_) { /* prvi put blokirano */ }
                    const blockedData = {
                        blocked_at: new Date().toISOString(),
                        model: usageModelName(),
                        reason: err.blockReason,
                        retry_count: prevRetryCount,
                        source_file: basename,
                        raw_response: err.rawResponse
                    };
                    fs.writeFileSync(blockedPath, JSON.stringify(blockedData, null, 2), "utf-8");
                    const permanent = prevRetryCount >= MAX_BLOCKED_RETRIES ? " (TRAJNO)" : "";
                    console.error(`   🚫 [BLOKIRANO] ${base}: ${err.blockReason} — pokušaj ${prevRetryCount}/${MAX_BLOCKED_RETRIES}${permanent}`);
                } else {
                    console.error(`   ❌ [GREŠKA] ${base}: ${err.message} (${elapsed.toFixed(1)}s)`);
                }
                totalErrors++;
            }
        }
    }

    // Spremi done cache
    if (!dryRun) {
        saveDoneState(inputDir, doneSet);
    }

    // ── SAŽETAK ──
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║   📊 SAŽETAK SUMARIZACIJE                      ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   ✅ Sumariziranih:      ${totalSummarized}`);
    console.log(`   ⏭️  Preskočenih:       ${cachedSkipped + fsSkipped}${totalSkipped > 0 ? ` + ${totalSkipped} prekratkih` : ""}`);
    console.log(`   ❌ Grešaka:            ${totalErrors}`);
    console.log(`   💾 Done cache:         ${doneSet.size} epizoda`);
    if (totalElapsed > 0) {
        console.log(`   ⏱️  Ukupno vrijeme:    ${formatDuration(totalElapsed)}`);
        if (totalSummarized > 0) {
            console.log(`   ⚡ Prosjek po datoteci: ${(totalElapsed / totalSummarized).toFixed(1)}s`);
        }
    }
    if (sessionUsage.calls > 0) {
        console.log(`   💳 ${USING_CLAUDE ? "Claude" : "Gemini"} ovaj run: ${sessionUsage.prompt}+${sessionUsage.output} tok u ${sessionUsage.calls} poziva ≈ $${sessionUsage.usd.toFixed(4)} (${USING_CLAUDE ? `pretplata, ekvivalentni trošak, model=${CLAUDE_MODEL}` : VERTEX_PROJECT})`);
    }
    console.log("");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
