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
 *      node generate_article_gemini.js --input-dir /Volumes/DOMOVINA2TB/fetch_domovina_tv_output
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

// env > gemini.conf > default — isti uzorak kao VERTEX_PROJECT/CLAUDE_MODEL/cijene.
// Env override postoji da se A/B novog modela može pustiti bez diranja produkcijskog
// gemini.conf (u repou zna raditi druga sesija paralelno).
const GEMINI_MODEL = process.env.GEMINI_MODEL || GEMINI_CONF.GEMINI_MODEL || "gemini-2.5-flash";

// Backend: "vertex" (default), "cli" (gemini CLI non-interactive) ili "claude" (Claude Code CLI).
// Postavi preko env vara GEMINI_BACKEND=... (run_pipeline.sh --gemini-backend ...).
const GEMINI_BACKEND = (process.env.GEMINI_BACKEND || "vertex").toLowerCase();

// ─── CLAUDE CODE CLI BACKEND (GEMINI_BACKEND=claude) ──────────────
// Vidi opsežni komentar u summarize_gemini.js. Ukratko: `claude -p` pod Claude Code
// PRETPLATOM (OAuth), NE API key. `--tools ""` je kritičan (overhead 21k → 233 tok/poziv),
// cwd mora biti neutralan (inače se repo CLAUDE.md učitava u svaki poziv), NIKAD `--bare`.
//
// ⚠️ Članak je DVOFAZAN (outline + N iteracija) i svaka iteracija resenda transkript.
// Tipična epizoda = 5 poziva / ~430k input tokena. Na pretplati to je znatna kvota,
// zato je ovaj backend namijenjen prioritetnim/ad-hoc videima, ne nightly batchu.
const CLAUDE_MODEL     = process.env.CLAUDE_MODEL  || GEMINI_CONF.CLAUDE_MODEL  || "opus";
const CLAUDE_EFFORT    = process.env.CLAUDE_EFFORT || GEMINI_CONF.CLAUDE_EFFORT || "high";
const CLAUDE_PRICE_IN  = parseFloat(process.env.CLAUDE_PRICE_IN  || GEMINI_CONF.CLAUDE_PRICE_IN  || "5.00");
const CLAUDE_PRICE_OUT = parseFloat(process.env.CLAUDE_PRICE_OUT || GEMINI_CONF.CLAUDE_PRICE_OUT || "25.00");
const CLAUDE_MAX_RETRIES = parseInt(process.env.CLAUDE_MAX_RETRIES || "3", 10);
const CLAUDE_CWD = path.join(os.tmpdir(), "domovina_claude_cli");
const USING_CLAUDE = GEMINI_BACKEND === "claude";

const USING_AGY = GEMINI_BACKEND === "agy";
const AGY_MODEL = process.env.AGY_MODEL || "Gemini 3.1 Pro (High)";

// Slug koji ide u IMENA datoteka: {basename}_{date}_{MODEL_SLUG}.article.json
// ⚠️ Downstream (channel_index, CDN manifest) dedupa po LEKSIKOGRAFSKI NAJVEĆEM imenu.
// Zato slug za Claude namjerno ostaje goli alias ("opus"/"sonnet"/"haiku") — svi počinju
// slovom > 'g', pa uvijek pobjeđuju "gemini-*" pri istom datumu. Puna provenance
// ("claude-code:opus") ide u JSON metadata, ne u ime datoteke (dvotočka u imenu = problem).
const MODEL_SLUG = USING_CLAUDE ? CLAUDE_MODEL : (USING_AGY ? "agy" : GEMINI_MODEL);
// Puno ime modela za provenance polja unutar JSON-a.
const PROVENANCE_MODEL = USING_CLAUDE ? `claude-code:${CLAUDE_MODEL}` : (USING_AGY ? `agy:${AGY_MODEL}` : GEMINI_MODEL);
// Aliasi Claude modela — koristi ih hasCompleteArticle da gemini pass NE regenerira
// (i time efektivno ne degradira) članak koji je već podignut na Claude kvalitetu.
const CLAUDE_SLUGS = ["opus", "sonnet", "haiku", "fable"];

// Vertex AI endpoint s Bearer tokenom (koristi GCP kredite, ne naplaćuje karticu)
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || GEMINI_CONF.VERTEX_PROJECT || "project-a275a620-ef0c-45ae-99e";
// Pinani gcloud identitet (vidi gemini.conf). Sprječava 403 kad globalni aktivni
// account flipne na drugi SA. Prazno → fallback na aktivni account.
const VERTEX_ACCOUNT = process.env.VERTEX_ACCOUNT || GEMINI_CONF.VERTEX_ACCOUNT || "";

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
// Claude CLI usage (Anthropic format) → isti sessionUsage akumulator.
// prompt = svježi input + cache write + cache read (sve troši kvotu pretplate).
function recordClaudeUsage(u, costUsd) {
    if (!u) return;
    const p = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const o = u.output_tokens || 0;
    sessionUsage.calls++;
    sessionUsage.prompt += p;
    sessionUsage.output += o;
    sessionUsage.total  += p + o;
    // CLI-jev total_cost_usd uračunava cache-write (2×) / cache-read (0.1×) cijene.
    sessionUsage.usd += (typeof costUsd === "number" && isFinite(costUsd))
        ? costUsd
        : (p / 1e6 * CLAUDE_PRICE_IN + o / 1e6 * CLAUDE_PRICE_OUT);
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
        step,
        model: PROVENANCE_MODEL,
        project: USING_CLAUDE ? "claude-code-subscription" : VERTEX_PROJECT,
        prompt_tokens: ep.prompt, output_tokens: ep.output, total_tokens: ep.total, calls: ep.calls,
        est_usd: ep.usd,
        price_in_per_m: USING_CLAUDE ? CLAUDE_PRICE_IN  : PRICE_IN_PER_M,
        price_out_per_m: USING_CLAUDE ? CLAUDE_PRICE_OUT : PRICE_OUT_PER_M,
        at: new Date().toISOString(),
    };
    prevRuns = prevRuns.filter(r => r.step !== step).concat(rec);
    const totUsd = Math.round(prevRuns.reduce((s, r) => s + (r.est_usd || 0), 0) * 1e6) / 1e6;
    fs.writeFileSync(usagePath, JSON.stringify({ base: epBase, total_est_usd: totUsd, runs: prevRuns }, null, 2), "utf-8");
    console.log(`   💳 ${USING_CLAUDE ? "Claude" : "Gemini"} (${step}): ${ep.prompt}+${ep.output} tok u ${ep.calls} poziva ≈ $${ep.usd.toFixed(5)}${USING_CLAUDE ? " (ekvivalent; pretplata)" : ""}`);
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

// Obavezni ključevi svake sekcije (vidi STRUKTURA JSON-a u SYSTEM_PROMPT_2).
// `keywords` i `entities` konzumira downstream (RAG chunking, channel index), pa se
// nedostatak tretira kao greška sheme, ne kao kozmetika.
const SECTION_REQUIRED_FIELDS = ["subtitle", "screenshot_timestamp", "content", "keywords", "entities"];

/** Vraća popis obaveznih polja koja nedostaju u BAR JEDNOJ sekciji (prazan niz = sve OK). */
function sectionsMissingFields(sections) {
    if (!Array.isArray(sections) || sections.length === 0) return [];
    const missing = new Set();
    for (const sec of sections) {
        for (const f of SECTION_REQUIRED_FIELDS) {
            const v = sec ? sec[f] : undefined;
            const empty = v === undefined || v === null
                || (Array.isArray(v) && v.length === 0)
                || (typeof v === "string" && v.trim() === "");
            if (empty) missing.add(f);
        }
    }
    return [...missing];
}

// ─── ATRIBUCIJA GOVORNIKA: chapter-mapa + strict-mode + name-audit ───────
// Rješava halucinaciju imena govornika u multi-speaker / highlights videima.
// Pozadina i poluge: docs/speaker_attribution_hallucination_2026-07.md.
//   Poluga 1 — inject izdavačeve chapter-liste (.info.json chapters ILI .description
//              "MM:SS Ime") kao AUTORITATIVNE mape govornik↔ime↔vrijeme u promptove.
//   Poluga 2 — strict constraint: model NE smije izmišljati imena; samo iz transkripta
//              ili priložene mape, inače neutralna uloga.
//   Poluga 3 — post-hoc name-audit: nepotvrđena imena → warning + `.article.name_audit.json`.
// Aktivacija je UVJETNA (da ne pokvari dobru podcast-atribuciju): uključi se samo kad
// postoji upotrebljiva chapter-mapa (>=3 unosa) ILI kad diarizacija vrati puno govornika.
const STRICT_SPEAKER_THRESHOLD = 8;   // > ovoga = highlights/panel režim → strict

const STRICT_NAMING_CLAUSE = `

⚠️ STROGO PRAVILO ATRIBUCIJE IMENA (obavezno — ova snimka ima službenu mapu govornika i/ili velik broj kratkih govornika; diarizacijske oznake [SPEAKER_XX] NE nose imena):
- NIKAD ne izmišljaj ni ne pogađaj osobno ime, ime izvođača ili naziv benda/sastava. Strogo je zabranjeno izvoditi imena iz općeg znanja o temi ili poznatih javnih osoba.
- Konkretno ime smiješ upotrijebiti ISKLJUČIVO ako se (a) doslovno pojavljuje u transkriptu, ILI (b) je navedeno u priloženoj SLUŽBENOJ MAPI GOVORNIKA, ILI (c) je navedeno u SLUŽBENOM KONTEKSTU EPIZODE. Ime pridijeli govorniku tako da uskladiš vrijeme njegova nastupa (iz vremenskih oznaka transkripta) s vremenskom oznakom iz mape.
- Transkript je automatski (ASR) i zna KRIVO ČUTI imena (npr. spojiti ili izobličiti prezime). Ako SLUŽBENI KONTEKST EPIZODE navodi govornika za neku diarizacijsku oznaku, taj podatak POBJEĐUJE svaki suprotan zaključak iz transkripta.
- ZAPIS IMENA JE DOSLOVAN: ime iz službenog konteksta ili naslova epizode prepiši TOČNO takvim zapisom u nominativu — bez pravopisne "korekcije" ili pohrvaćivanja (npr. "Lucia" NE postaje "Lucija"; "Mia" ostaje "Mia"). Padežne oblike tvori pravilno od tog izvornog zapisa.
- Ako ime NIJE potvrđeno ni transkriptom ni mapom ni službenim kontekstom, koristi NEUTRALNU ulogu ("izvođač", "izvođačica", "predstavnik udruge", "svećenik", "posjetiteljica", "sudionik", "gost") — nikad izmišljeno ime.
- Uloge i spol izvodi samo iz sadržaja; ne pretpostavljaj (npr. ne nazivaj pjevačicu "svećenikom", niti bend nasumičnim poznatim imenom).
- Stavke iz mape koje su nazivi pjesama (ne osobe) ne pridjeljuj kao imena govornika.`;

// Deakcentiraj + normaliziraj za usporedbu tokena (č→c, ž→z, lowercase, samo alnum+razmak).
function normalizeNameTokens(s) {
    return (s || "").toLowerCase()
        .replace(/č/g, "c").replace(/ć/g, "c").replace(/đ/g, "d").replace(/š/g, "s").replace(/ž/g, "z")
        .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function secToHMS(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return [h, m, s].map(n => String(n).padStart(2, "0")).join(":");
}

// POLUGA 1 — izdavačeva mapa: .info.json `chapters` (strukturirano, pouzdanije) ili
// .description tekst ("MM:SS Naslov" / "HH:MM:SS Naslov"). Vraća [{seconds, label}].
function loadPublisherChapters(baseDir, epBase) {
    try {
        const infoPath = path.join(baseDir, `${epBase}.info.json`);
        if (fs.existsSync(infoPath)) {
            const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
            if (Array.isArray(info.chapters) && info.chapters.length) {
                return info.chapters
                    .filter(c => c && c.title != null && c.start_time != null)
                    .map(c => ({ seconds: Math.round(Number(c.start_time)), label: String(c.title).trim() }));
            }
        }
    } catch (_) { /* fallthrough na .description */ }
    try {
        const descPath = path.join(baseDir, `${epBase}.description`);
        if (fs.existsSync(descPath)) {
            const out = [];
            for (const line of fs.readFileSync(descPath, "utf-8").split("\n")) {
                const m = line.match(/^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(\S.*?)\s*$/);
                if (!m) continue;
                const hasH = m[3] != null;
                const h = hasH ? parseInt(m[1], 10) : 0;
                const mm = hasH ? parseInt(m[2], 10) : parseInt(m[1], 10);
                const ss = hasH ? parseInt(m[3], 10) : parseInt(m[2], 10);
                out.push({ seconds: h * 3600 + mm * 60 + ss, label: m[4].trim() });
            }
            return out;
        }
    } catch (_) { /* nema mape */ }
    return [];
}

function buildChapterMapBlock(chapters) {
    const lines = chapters.map(c => ` - ${secToHMS(c.seconds)}  ${c.label}`).join("\n");
    return `\n\nSLUŽBENA MAPA GOVORNIKA / POGLAVLJA (od izdavača — AUTORITATIVNO za imena; poravnaj vrijeme nastupa govornika s ovim oznakama; stavke koje su nazivi pjesama ne odnose se na osobe):\n${lines}\n`;
}

// Zadnji cue u SRT-u = stvarni kraj transkripta. Sve iznad toga je izvan snimke.
// Bez ovoga FAZA 1 dobiva pravilo "iteracija traje 35-45 min" bez ijednog podatka o
// stvarnom trajanju, pa za kratke epizode izmišlja sadržaj da popuni blok (incident
// iG2G9tLSyzs: 14-minutni transkript → outline do 01:01:20, 18 nepostojećih sekcija).
function lastCueSeconds(srt) {
    let last = 0;
    const re = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g;
    let m;
    while ((m = re.exec(srt)) !== null) {
        const end = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]);
        if (end > last) last = end;
    }
    return last;
}

function buildDurationBlock(lastSec) {
    const hms = secToHMS(lastSec);
    return `\n\nSTVARNO TRAJANJE TRANSKRIPTA: zadnji cue završava na ${hms}. ` +
        `Transkript NEMA sadržaja nakon tog vremena.\n` +
        `- Nijedan "start_time", "end_time" ni "timestamp" ne smije biti veći od ${hms}.\n` +
        `- Pravilo o 35-45 minuta vrijedi NEPROMIJENJENO za snimke dulje od 45 minuta: ` +
        `dugu snimku i dalje dijeli na blokove od cca 35-45 minuta (4 sata ≈ 6 iteracija).\n` +
        `- Ono NIJE kvota koju treba popuniti kad je snimka kraća od jednog bloka. Tada vrati ` +
        `onoliko iteracija koliko sadržaj stvarno pokriva (za transkript kraći od 35 minuta ` +
        `to je TOČNO JEDNA iteracija).\n` +
        `- Strogo je zabranjeno izmišljati teme, poglavlja ili nastavak razgovora kojih nema u transkriptu.\n`;
}

// Obrana ako model ipak prekorači: režemo poglavlja i iteracije izvan snimke.
function clampOutlineToTranscript(outlineJson, lastSec) {
    const hms = secToHMS(lastSec);
    const toSec = (t) => {
        const m = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(String(t || ""));
        return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
    };
    let droppedChapters = 0, droppedIters = 0;
    const kept = [];
    for (const iter of outlineJson.iterations || []) {
        const start = toSec(iter.start_time);
        if (start !== null && start > lastSec) { droppedIters++; continue; }
        const chapters = (iter.chapters || []).filter(c => {
            const t = toSec(c.timestamp);
            if (t !== null && t > lastSec) { droppedChapters++; return false; }
            return true;
        });
        if (chapters.length === 0 && (iter.chapters || []).length > 0) { droppedIters++; continue; }
        iter.chapters = chapters;
        if (toSec(iter.end_time) > lastSec) iter.end_time = hms;
        kept.push(iter);
    }
    if (droppedChapters || droppedIters) {
        console.warn(`   ⚠️  [FAZA 1] Outline je prelazio kraj transkripta (${hms}) — odbačeno ${droppedChapters} poglavlja i ${droppedIters} iteracija.`);
        // NAMJERNO ne renumeriramo. FAZA 2 resume mapira već napisane iteracije iz
        // postojećeg article.json po `iteration_number` (`completedIterations`), a raw
        // fajlovi se zovu `faza2_iteracija_N.raw.txt`. Da pomaknemo numeraciju nakon
        // ispuštanja iteracije, djelomični run bi tiho zalijepio sadržaj stare
        // iteracije N+1 na novu N — točan JSON s krivim vremenskim okvirom.
        // Downstream (screenshot_youtube.js, magisterium_*) broj koristi samo kao
        // oznaku, pa rupa u nizu (1, 2, 4) ne smeta.
        outlineJson.iterations = kept;
    }
    return outlineJson;
}

function countSpeakers(srt) {
    const set = new Set();
    const re = /\[SPEAKER_(\d+)\]/g;
    let m;
    while ((m = re.exec(srt)) !== null) set.add(m[1]);
    return set.size;
}

// mentioned_people / speakers[].suggested_name iz summary sidecar-a (pomoćni signal za audit).
// NB: stvarna struktura sidecar-a gnijezdi polja pod `summary` ({version, model, summary:{...}}) —
// čitanje samo s vrha je do 2026-07-29 tiho vraćalo prazno (incident Ivan Voras / cb4CsFDCDho).
function loadSummaryMentioned(baseDir, epBase) {
    const names = [];
    try {
        const p = path.join(baseDir, `${epBase}.wav.canary.summary.json`);
        if (fs.existsSync(p)) {
            const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
            const s = (raw && typeof raw.summary === "object" && raw.summary) ? raw.summary : raw;
            const push = v => { if (typeof v === "string") names.push(v); };
            (s.mentioned_people || s.people || []).forEach(push);
            (s.speakers || []).forEach(sp => push(sp && (sp.suggested_name || sp.name)));
        }
    } catch (_) { /* best-effort */ }
    return names;
}

// POLUGA 4 — SLUŽBENI KONTEKST EPIZODE za prompt: summary korak (koji vidi opis epizode)
// već proizvodi mapu govornika po diarizacijskim oznakama ({id, suggested_name, role});
// uz naslov i kanal iz .info.json to je autoritativan identitet koji article korak do
// 2026-07-29 uopće nije dobivao — pa je model imena voditelja pogađao iz transkripta
// (incident Ivan Voras: ASR krivo čuo "moj i Vorasov podcast" → model imenovao voditelja
// tuđim imenom iz općeg znanja). Ovaj blok POBJEĐUJE zaključke iz transkripta.
function buildOfficialContextBlock(baseDir, epBase) {
    let title = null, channel = null, speakers = [];
    try {
        const infoPath = path.join(baseDir, `${epBase}.info.json`);
        if (fs.existsSync(infoPath)) {
            const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
            title = info.title || info.fulltitle || null;
            channel = info.channel || info.uploader || null;
        }
    } catch (_) { /* best-effort */ }
    try {
        const p = path.join(baseDir, `${epBase}.wav.canary.summary.json`);
        if (fs.existsSync(p)) {
            const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
            const s = (raw && typeof raw.summary === "object" && raw.summary) ? raw.summary : raw;
            speakers = (s.speakers || []).filter(sp => sp && (sp.suggested_name || sp.name));
        }
    } catch (_) { /* best-effort */ }
    if (!title && !channel && !speakers.length) return "";
    const lines = [];
    if (title) lines.push(` - Naslov epizode: ${title}`);
    if (channel) lines.push(` - Kanal/emisija: ${channel}`);
    if (speakers.length) {
        const sp = speakers
            .map(x => ` - ${x.id ? `[${x.id}] = ` : ""}${x.suggested_name || x.name}${x.role ? ` (${x.role})` : ""}`)
            .join("\n");
        lines.push(` - Govornici (mapirani na diarizacijske oznake, izvedeno iz službenog opisa epizode):\n${sp}`);
    }
    return `\n\nSLUŽBENI KONTEKST EPIZODE (autoritativno — iz metapodataka izdavača i službenog opisa; POBJEĐUJE suprotne zaključke iz ASR transkripta. Zapis imena preuzmi DOSLOVNO — bez pravopisne korekcije; ako se zapis u naslovu epizode i mapi razlikuje, mjerodavan je NASLOV):\n${lines.join("\n")}\n`;
}

// POLUGA 3 — allowlist tokena (deakcentirano): sve riječi transkripta + imena iz chaptera + summary.
function buildNameTokenSet(chapters, srt, summaryNames) {
    const set = new Set();
    const add = str => normalizeNameTokens(str).split(" ").forEach(t => { if (t.length >= 3) set.add(t); });
    add(srt);
    chapters.forEach(c => add(c.label));
    summaryNames.forEach(add);
    return set;
}

// Uvijek-OK (religijski/geografski pojmovi, ne osobna imena) — ne flag-aj.
const NAME_AUDIT_STOP = new Set(
    ["bog", "isus", "krist", "gospodin", "duh sveti", "sveti duh", "hrvatska", "crkva", "evandelje", "biblija", "marko perkovic thompson"]
        .map(normalizeNameTokens)
);

// Kandidati PERSON/ORG imena iz izlaza: bolded **X**, subtitle, screenshot_description, entities.
// Heuristika: >=2 uzastopne Velike riječi ILI titula (mons./fra/dr./sv.). Time se izbjegavaju
// jednorječni religijski/geografski pojmovi (Bog, Isus, Hrvatska), a hvataju "Tiho Orlić",
// "Opća Opasnost", "Marija Husar Rimac" itd.
function extractNameCandidates(article) {
    const cands = new Set();
    const titleRe = /\b(?:mons\.?|fra|dr\.?|sv\.?|pater|o\.)\s+[A-ZČĆĐŠŽ][\wčćđšž]+/g;
    const multiCapRe = /\b[A-ZČĆĐŠŽ][a-zčćđšž]+(?:\s+[A-ZČĆĐŠŽ][a-zčćđšž]+)+\b/g;
    const scan = txt => {
        if (!txt) return;
        (String(txt).match(multiCapRe) || []).forEach(x => cands.add(x.trim()));
        (String(txt).match(titleRe) || []).forEach(x => cands.add(x.trim()));
    };
    for (const it of (article.iterations || [])) {
        for (const sec of (it.sections || [])) {
            scan(sec.subtitle);
            scan(sec.screenshot_description);
            (String(sec.content || "").match(/\*\*([^*]+)\*\*/g) || []).forEach(b => scan(b.replace(/\*\*/g, "")));
            (sec.entities || []).forEach(scan);
        }
    }
    return [...cands];
}

// Token je "poznat" ako je u allowlisti ili dijeli osnovu (prefiks ≥4) s nekim tokenom —
// hrvatski jako sklanja imena (Marko→Marka→Markom, Thompson→Thompsona), pa exact-match
// daje lažne pozitive. Prefiks ≥4 + ograničena razlika duljine hvata deklinaciju bez
// da spaja nepovezane riječi.
function tokenKnown(t, set) {
    if (set.has(t)) return true;
    if (t.length < 4) return false;
    const tp = t.slice(0, 4);
    for (const a of set) {
        if (a.length >= 4 && a.slice(0, 4) === tp && Math.abs(a.length - t.length) <= 3) return true;
    }
    return false;
}

function auditNames(article, tokenSet) {
    const flagged = [];
    for (const name of extractNameCandidates(article)) {
        const norm = normalizeNameTokens(name);
        if (NAME_AUDIT_STOP.has(norm)) continue;
        const toks = norm.split(" ").filter(t => t.length >= 3);
        if (!toks.length) continue;
        const known = toks.filter(t => tokenKnown(t, tokenSet)).length;
        // SVI značajni tokeni moraju biti u allowlisti. Ranije pravilo "bar polovica"
        // je propustilo "Ivan Voras" (cb4CsFDCDho): "voras" je stem-matchao krivo čuti
        // "VORASO" iz transkripta, a dopisani "Ivan" nije postojao nigdje u ulazima —
        // 1/2 tokena je prolazilo. Audit samo upozorava (ne blokira objavu), pa je
        // trošak strožeg pravila pokoji lažni pozitiv više, a hvata dopisana imena.
        if (known < toks.length) flagged.push(name);
    }
    return [...new Set(flagged)];
}

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
        const acct = VERTEX_ACCOUNT ? ` --account=${VERTEX_ACCOUNT}` : "";
        return execSync(`gcloud auth print-access-token${acct}`, { encoding: "utf-8" }).trim();
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
        console.error("  node generate_article_gemini.js --input-dir /Volumes/DOMOVINA2TB/fetch_domovina_tv_output");
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

const HOMILY_SRT_SUFFIX = ".homily.srt";
const HOMILY_META_SUFFIX = ".homily.json";

// Razrješava koji se dijarizirani SRT stvarno čita za dani canary path.
// Prioritet: homily → sortformer → canary. Discovery i izlazna imena fajlova
// ostaju canary-anchored.
//
// HOMILY: kod prijenosa svetih misa `extract_homily.js` izdvaja SAMO propovijed.
// Ostatak je Red mise — identičan u cijelom svijetu (izmjereno: 78.1% teksta
// članka na misi 24.7.2026.). Gate na confidence "high"; gasi se s
// DOMOVINA_IGNORE_HOMILY=1. Isti helper postoji u summarize_gemini.js i
// prepare_rag_combined.js — mijenjaj u SVE TRI kopije.
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
        model: PROVENANCE_MODEL,
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
    const suffix = `_${MODEL_SLUG}.${type}.json`;
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

    let articlePath = findLatestFile(channelDir, basename, "article");

    // Ne-degradiraj: ako smo na gemini backendu, a epizoda već ima kompletan članak
    // generiran Claudeom (ručni quality upgrade), tretiraj je kao gotovu i preskoči.
    // Bez ovoga bi nightly gemini pass svaki put uzalud regenerirao takve epizode.
    if (!articlePath && !USING_CLAUDE) {
        for (const slug of CLAUDE_SLUGS) {
            const suffix = `_${slug}.article.json`;
            try {
                const m = fs.readdirSync(channelDir)
                    .filter(f => f.startsWith(`${basename}_`) && f.endsWith(suffix) && !f.startsWith("._"))
                    .sort();
                if (m.length > 0) { articlePath = path.join(channelDir, m[m.length - 1]); break; }
            } catch { /* dir nedostupan */ }
        }
    }

    // SIMETRIČNA ZAŠTITA (2026-07-31) — obrnuti smjer od gornje "ne-degradiraj":
    // na Claude backendu prihvati POSTOJEĆI kompletan članak bilo kojeg modela.
    // Bez ovoga findLatestFile traži samo `_<claude_slug>.article.json`, pa cijeli
    // korpus s `gemini-*` člancima izgleda neobrađeno i nightly ga krene regenerirati.
    // To se stvarno dogodilo 2026-07-31: done-cache je bio jedina brana, a kad je
    // pao (rebuild scope-an na kanal prepisao je globalni articles-done.json),
    // article korak je javio 3097 videa za obradu na Opusu. Vidi
    // docs/operativne_zamke_2026-07-31.md §6.
    // Namjerni re-run boljim modelom i dalje je moguć preko --video-id / --channel
    // scopea uz brisanje odgovarajućeg zapisa iz articles-done.json.
    if (!articlePath && USING_CLAUDE) {
        try {
            const m = fs.readdirSync(channelDir)
                .filter(f => f.startsWith(`${basename}_`) && f.endsWith(".article.json") && !f.startsWith("._"))
                .sort();
            if (m.length > 0) articlePath = path.join(channelDir, m[m.length - 1]);
        } catch { /* dir nedostupan */ }
    }
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

/**
 * Poziva `claude -p` headless. System prompt kroz --system-prompt, user poruka
 * (transkript + outline kontekst) kroz stdin — izbjegava ARG_MAX.
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
 * Poziva `agy -p` headless uz preskakanje provjere dozvola.
 *
 * ⚠️ ISPRAVAK 2026-08-25 (agy 1.1.20): agy **NE čita prompt sa stdina**.
 * `-p` je string-zastavica i uzima SLJEDEĆI argument kao svoju vrijednost, pa
 * je raniji poziv (`-p` pa prompt kroz stdin) padao odmah, prije ijednog
 * tokena, s porukom:
 *
 *     -p took "--model" as its prompt, so the intended prompt was left as an
 *     argument and ignored.
 *
 * `--gemini-backend agy` je zbog toga bio potpuno neupotrebljiv. Prompt sada
 * ide kao vrijednost odmah iza `-p`.
 *
 * Posljedica koju treba znati: prompt putuje kroz **argv**, a `ARG_MAX` je na
 * macOS-u 1 048 576 B. Dvofazna generacija članka resenda cijeli transkript po
 * iteraciji, pa dulje epizode taj strop mogu probiti — zato se provjerava
 * unaprijed i puca s jasnom porukom umjesto s „Argument list too long".
 */
function callAgyCli(systemPrompt, userMessage) {
    return new Promise((resolve, reject) => {
        const combinedMessage = `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER INPUT]\n${userMessage}`;
        // ARG_MAX je zajednički za argv I okoliš — ostavljamo 15 % rezerve.
        const ARG_MAX_SAFE = 890000;
        const promptBytes = Buffer.byteLength(combinedMessage, "utf8");
        if (promptBytes > ARG_MAX_SAFE) {
            reject(new Error(
                `agy CLI: prompt je ${promptBytes} B, iznad sigurnog ARG_MAX-a (${ARG_MAX_SAFE} B). ` +
                `agy prima prompt samo kroz argv. Koristi --gemini-backend vertex ili claude.`));
            return;
        }
        const args = [
            "-p", combinedMessage,
            "--model", AGY_MODEL,
            "--output-format", "json",
            "--dangerously-skip-permissions"
        ];
        
        const proc = spawn("agy", args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => { stdout += d; });
        proc.stderr.on("data", (d) => { stderr += d; });
        proc.on("error", (err) => reject(new Error(`agy CLI spawn failed: ${err.message}`)));
        proc.stdin.on("error", (err) => reject(new Error(`agy CLI stdin: ${err.message}`)));

        proc.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`agy CLI exit ${code}: ${(stderr || stdout).substring(0, 400) || "(bez outputa)"}`));
                return;
            }
            let env;
            try {
                env = JSON.parse(stdout);
            } catch (_) {
                reject(new Error(`agy CLI nije vratio JSON envelope. Prvih 300: ${stdout.substring(0, 300)}`));
                return;
            }
            if (env.status !== "SUCCESS") {
                reject(new Error(`agy CLI greška (status=${env.status}): ${String(env.error || env.response || "").substring(0, 300)}`));
                return;
            }
            resolve({
                text: env.response || "",
                usage: env.usage || null,
                costUsd: null,
            });
        });

        proc.stdin.end();
    });
}

async function callGemini(systemPrompt, userMessage, label = "Gemini API poziv", rawSavePath = null) {
    // ── CLAUDE CODE backend grana ──
    // Kvalitetnija generacija preko `claude -p` (Opus, subscription OAuth).
    // Retry s backoffom; JSON ide kroz isti extractJsonFromText repair pipeline kao Vertex.
    if (USING_CLAUDE) {
        let lastErr = null;
        for (let attempt = 1; attempt <= CLAUDE_MAX_RETRIES; attempt++) {
            const timer = startElapsedTimer(`${label} (claude ${CLAUDE_MODEL}/${CLAUDE_EFFORT}, pokušaj ${attempt}/${CLAUDE_MAX_RETRIES})`);
            try {
                const res = await callClaudeCli(systemPrompt, userMessage);
                timer.stop();
                recordClaudeUsage(res.usage, res.costUsd);
                if (rawSavePath) {
                    try { fs.writeFileSync(rawSavePath, res.text, "utf-8"); } catch (_) {}
                }
                const u = res.usage || {};
                const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
                console.log(`      🧠 Claude: ${inTok}→${u.output_tokens || 0} tok`);
                const parsed = extractJsonFromText(res.text);
                return { parsed, raw: res.text };
            } catch (err) {
                timer.stop();
                lastErr = err;
                if (attempt < CLAUDE_MAX_RETRIES) {
                    const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                    console.error(`      ⏳ claude CLI pao (${err.message.substring(0, 160)}) — čekam ${waitMs / 1000}s`);
                    await sleep(waitMs);
                }
            }
        }
        throw new Error(`Claude backend propao nakon ${CLAUDE_MAX_RETRIES} pokušaja. Zadnja greška: ${lastErr.message}`);
    }

    if (USING_AGY) {
        let lastErr = null;
        for (let i = 1; i <= CLAUDE_MAX_RETRIES; i++) {
            try {
                const startMs = Date.now();
                const res = await callAgyCli(systemPrompt, userMessage);
                if (res.usage) {
                    sessionUsage.calls++;
                    sessionUsage.prompt += res.usage.input_tokens || 0;
                    sessionUsage.output += res.usage.output_tokens || 0;
                    sessionUsage.total += res.usage.total_tokens || 0;
                }
                const sec = ((Date.now() - startMs) / 1000).toFixed(1);
                console.log(`    ✓ [Agy ${i}/${CLAUDE_MAX_RETRIES}] (${sec}s) ${label}`);
                
                // Spremi sirovi odgovor ako je zadano
                if (rawSavePath) {
                    try { fs.writeFileSync(rawSavePath, res.text, "utf8"); } catch (e) {
                        console.error(`    ⚠️ Greška pri spremanju sirovog Agy odgovora: ${e.message}`);
                    }
                }
                
                return extractJsonFromText(res.text, label);
            } catch (err) {
                lastErr = err;
                console.log(`    ⚠️ [Agy ${i}/${CLAUDE_MAX_RETRIES}] Greška: ${err.message.split("\n")[0]}`);
                if (i < CLAUDE_MAX_RETRIES) {
                    const backoff = i * 4000;
                    console.log(`      ...čekam ${backoff}ms za retry...`);
                    await new Promise(r => setTimeout(r, backoff));
                }
            }
        }
        throw new Error(`Agy backend propao nakon ${CLAUDE_MAX_RETRIES} pokušaja. Zadnja greška: ${lastErr.message}`);
    }

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
    if (_diarSource === "homily") console.log(`   ⛪ Izvor: SAMO PROPOVIJED (.homily.srt) — liturgija izostavljena`);
    const srtContent = fs.readFileSync(_actualSrtPath, "utf-8");
    const baseDir = path.dirname(file);
    const basename = path.basename(file).replace(/\.(srt|txt)$/i, "");

    // Episode-base (bez .wav.{canary,sortformer}.diarized infixa) → isti gemini_usage.json kao summary korak.
    const epBase = basename.replace(/\.wav\.(canary|sortformer)\.diarized$/, "");
    const _usage0 = snapshotUsage();   // za per-epizodu trošak diff (zbroj svih poziva ove epizode)

    // ── ATRIBUCIJA GOVORNIKA: uvjetni strict-mode (vidi docs/speaker_attribution_hallucination_2026-07.md) ──
    const pubChapters = loadPublisherChapters(baseDir, epBase);
    const speakerCount = countSpeakers(srtContent);
    const hasChapterMap = pubChapters.length >= 3;
    const manySpeakers = speakerCount > STRICT_SPEAKER_THRESHOLD;
    const officialBlock = buildOfficialContextBlock(baseDir, epBase);
    const strictAttribution = hasChapterMap || manySpeakers || !!officialBlock;
    const chapterBlock = (hasChapterMap ? buildChapterMapBlock(pubChapters) : "") + officialBlock;
    const lastCueSec = lastCueSeconds(srtContent);
    const durationBlock = lastCueSec > 0 ? buildDurationBlock(lastCueSec) : "";
    const systemPrompt1 = SYSTEM_PROMPT_1 + (strictAttribution ? STRICT_NAMING_CLAUSE : "");
    const systemPrompt2 = SYSTEM_PROMPT_2 + (strictAttribution ? STRICT_NAMING_CLAUSE : "");
    if (strictAttribution) {
        console.log(`   🧭 Strict-atribucija AKTIVNA (govornika: ${speakerCount}, chapter-unosa: ${pubChapters.length}${hasChapterMap ? ", mapa injektirana" : ""}${officialBlock ? ", službeni kontekst injektiran" : ""}) — imena samo iz transkripta/mape/konteksta.`);
    }

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

    const outlinePath = existingOutline || path.join(baseDir, `${basename}_${effectiveDateStr}_${MODEL_SLUG}.outline.json`);
    const articlePath = existingArticle || path.join(baseDir, `${basename}_${effectiveDateStr}_${MODEL_SLUG}.article.json`);
    const rawDir = path.join(baseDir, `${basename}_${effectiveDateStr}_${MODEL_SLUG}_raw`);
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

            const userMessage1 = `Evo cijelog diariziranog transkripta:${chapterBlock}${durationBlock}\n\n${srtContent}`;

            try {
                const result1 = await callGemini(systemPrompt1, userMessage1, "FAZA 1 — Outline", rawPath1);
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

    if (outlineJson && Array.isArray(outlineJson.iterations) && lastCueSec > 0) {
        clampOutlineToTranscript(outlineJson, lastCueSec);
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
                model: PROVENANCE_MODEL
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
            `${iter.chapters.map(c => ` - ${c.timestamp}: ${c.topic}`).join("\n")}\n` +
            chapterBlock +
            `\nTranskript cijelog razgovora (iskoristi za kontekst i prepoznavanje imena, ali PIŠI SAMO O VREMENSKOM OKVIRU ${iter.start_time} - ${iter.end_time}):\n\n${srtContent}`;

        try {
            const rawPath2 = path.join(rawDir, `faza2_iteracija_${iter.iteration_number}.raw.txt`);
            const result2 = await callGemini(systemPrompt2, iterDetails, `FAZA 2 — Iteracija ${iter.iteration_number}`, rawPath2);
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

            // ── SCHEMA GUARD: keywords/entities su obavezni, ali ih model zna ispustiti ──
            // Vertex forsira samo JSON *sintaksu* (responseMimeType), ne i shemu; Opus je
            // 2026-07-25 u jednom runu izostavio oba polja, a downstream RAG/index ih koristi.
            // Jedan korektivni retry s eksplicitnim popisom; ako i dalje fali → glasan warning,
            // ne blokiramo objavu (sadržaj članka je i dalje ispravan).
            const missingFields = sectionsMissingFields(sections);
            if (missingFields.length > 0) {
                console.error(`      ⚠️  Iteracija ${iter.iteration_number}: nedostaju polja u sekcijama: ${missingFields.join(", ")} — 1 korektivni pokušaj...`);
                try {
                    const fixPrompt = systemPrompt2 +
                        `\n\nKRITIČNO: U prethodnom pokušaju izostavio si obavezna polja: ${missingFields.join(", ")}.` +
                        ` SVAKA sekcija u "sections" MORA sadržavati SVIH šest ključeva:` +
                        ` "subtitle", "screenshot_timestamp", "screenshot_description", "content", "keywords", "entities".` +
                        ` Nijedan ključ se ne smije izostaviti ni ostaviti prazan.`;
                    const retryRaw = path.join(rawDir, `faza2_iteracija_${iter.iteration_number}.schemafix.raw.txt`);
                    const fixed = await callGemini(fixPrompt, iterDetails, `FAZA 2 — Iteracija ${iter.iteration_number} (schema fix)`, retryRaw);
                    const fixedSections = Array.isArray(fixed.parsed) ? fixed.parsed : fixed.parsed.sections;
                    if (Array.isArray(fixedSections) && fixedSections.length > 0 && sectionsMissingFields(fixedSections).length === 0) {
                        console.log(`      🔧 Schema fix uspio (${fixedSections.length} sekcija, sva polja prisutna).`);
                        sections = fixedSections;
                    } else {
                        console.error(`      ⚠️  Schema fix nije popravio sva polja — zadržavam originalne sekcije.`);
                    }
                } catch (fixErr) {
                    console.error(`      ⚠️  Schema fix pao: ${fixErr.message.substring(0, 160)} — zadržavam originalne sekcije.`);
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

    // ── AUDIT VREMENA: sekcije izvan snimke (screenshot ih nikad ne može uhvatiti) ──
    if (lastCueSec > 0) {
        const over = [];
        for (const it of finalArticle.iterations || []) {
            for (const sec of it.sections || []) {
                const m = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(String(sec.screenshot_timestamp || ""));
                if (!m) continue;
                const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
                if (t > lastCueSec) over.push(sec.screenshot_timestamp);
            }
        }
        if (over.length) {
            console.warn(`   ⚠️  [AUDIT VREMENA] ${over.length} sekcija ima timestamp izvan transkripta (kraj ${secToHMS(lastCueSec)}): ${over.slice(0, 5).join(", ")}${over.length > 5 ? " …" : ""} — screenshotovi za njih NIKAD neće uspjeti.`);
        } else {
            console.log(`   ✅ [AUDIT VREMENA] svi timestampovi unutar snimke (kraj ${secToHMS(lastCueSec)}).`);
        }
    }

    // ── POLUGA 3: post-hoc name-audit (nepotvrđena imena → warning + sidecar, NE mutira članak) ──
    if (strictAttribution) {
        try {
            const tokenSet = buildNameTokenSet(pubChapters, srtContent, loadSummaryMentioned(baseDir, epBase));
            const flagged = auditNames(finalArticle, tokenSet);
            const auditPath = articlePath.replace(/\.article\.json$/, ".article.name_audit.json");
            fs.writeFileSync(auditPath, JSON.stringify({
                generated_at: new Date().toISOString(),
                speaker_count: speakerCount,
                chapters_count: pubChapters.length,
                strict_attribution: true,
                flagged_names: flagged,
                note: "Kandidati imena koji NISU potvrđeni transkriptom/chapter-mapom/summaryjem (moguća halucinacija). Ručno provjeriti. Vidi docs/speaker_attribution_hallucination_2026-07.md."
            }, null, 2), "utf-8");
            if (flagged.length) {
                console.warn(`   ⚠️  [AUDIT IMENA] ${flagged.length} nepotvrđenih imena: ${flagged.join(", ")} → ${path.basename(auditPath)}`);
            } else {
                console.log(`   ✅ [AUDIT IMENA] sva imena potvrđena transkriptom/mapom.`);
            }
        } catch (e) {
            console.warn(`   ⚠️  [AUDIT IMENA] preskočen: ${e.message}`);
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
    if (USING_CLAUDE) {
        console.log(`   🧠 Model:    ${CLAUDE_MODEL} (effort=${CLAUDE_EFFORT})`);
        console.log(`   🌐 Backend:  Claude Code CLI -p (subscription OAuth, bez API keya)`);
        console.log(`   📋 Kontekst: --tools "" --setting-sources "" cwd=${CLAUDE_CWD}`);
    } else {
        console.log(`   🤖 Model:    ${GEMINI_MODEL}`);
        console.log(`   🌐 Vertex AI: ${VERTEX_PROJECT}`);
        const gcloudProject = (() => { try { return execSync("gcloud config get-value project 2>/dev/null", { encoding: "utf-8" }).trim(); } catch { return "N/A"; } })();
        if (gcloudProject !== VERTEX_PROJECT) {
            console.log(`   ⚠️  gcloud projekt: ${gcloudProject} (RAZLIKUJE SE OD VERTEX_PROJECT!)`);
        } else {
            console.log(`   ✅ gcloud projekt: ${gcloudProject}`);
        }
        console.log(`   🔄 Regije (${VERTEX_REGIONS.length}): ${VERTEX_REGIONS.join(", ")}`);
    }

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
        console.log(`   💳 ${USING_CLAUDE ? "Claude" : "Gemini"} ovaj run: ${sessionUsage.prompt}+${sessionUsage.output} tok u ${sessionUsage.calls} poziva ≈ $${sessionUsage.usd.toFixed(4)} (${USING_CLAUDE ? `pretplata, ekvivalentni trošak, model=${CLAUDE_MODEL}` : VERTEX_PROJECT})`);
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
    // Slug koji ulazi u imena outline/article datoteka — testovi ga MORAJU koristiti
    // umjesto hardkodiranog imena modela (inače pucaju čim se promijeni GEMINI_MODEL).
    MODEL_SLUG,
    sectionsMissingFields,
    // Atribucija govornika (chapter-mapa + strict-mode + name-audit)
    loadPublisherChapters,
    buildChapterMapBlock,
    buildOfficialContextBlock,
    loadSummaryMentioned,
    countSpeakers,
    buildNameTokenSet,
    extractNameCandidates,
    auditNames,
    normalizeNameTokens,
    STRICT_SPEAKER_THRESHOLD,
    // Zaštita od outlinea koji prelazi kraj transkripta (halucinirane sekcije)
    lastCueSeconds,
    clampOutlineToTranscript,
    // Za testiranje: postavi cached token da se izbjegne poziv gcloud auth
    _setTestToken(token) {
        cachedAccessToken = token;
        tokenExpiry = Date.now() + 999_999_999;
    },
};
