#!/usr/bin/env node
/**
 * refine_diarized_gemini.js — KORAK 2.8: Speechmatics kostur + Gemini sluh
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Portano iz `../../adria-analytics/adria-brainstormer/experiments/gemini-audio/studio_asr.py`
 * (`--engine skeleton --skeleton speechmatics`), uz jednu bitnu razliku: tamo se
 * ide na AI Studio / Vertex express s API ključem, ovdje na **project-scoped
 * Vertex s OAuth bearerom** — isti auth put koji koriste koraci 7+8, pa nema
 * drugog ključa ni drugog naplatnog kanala.
 *
 * ┌─ TRI PITANJA, TRI ALATA ────────────────────────────────────────────────┐
 * │  TKO govori i KADA  → Speechmatics (akustika, word-level vremena)       │
 * │  ŠTO je rekao       → Gemini 3.8 Flash (ČUJE zvuk unutar granica)       │
 * │  KAKO se zove       → ostaje na koracima 7+8 (kontekst iz sažetka)      │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Gemini NE popravlja tekst kao tekst. Dobije gotov kostur segmenata s već
 * određenim govornikom i intervalom, pa mu se preda zvuk TOG prozora i traži da
 * svaki segment ispuni onim što stvarno čuje. Segmente ne smije spajati,
 * dijeliti ni preimenovati — izlaz je JSON po `id`-u, uz `responseSchema`.
 *
 * ZAŠTO OVAKO, A NE "daj Geminiju transkript pa nek ga uljepša":
 * Prolaz nad samim tekstom nije čuo snimku, pa ne može popraviti krivo čutu
 * riječ — samo je zamijeni drugom krivom. Canaryjeva repeticija ("nije, nije,
 * nije" 30×) je ASR collapse: model je izgubio poravnanje i mljeo isti token.
 * Tekstualni prolaz vidi 30 "nije" i nema od čega zaključiti koliko ih je bilo.
 * Ovdje ih Gemini čuje unutar zadanih [od, do] granica, pa collapse nestaje.
 *
 * ⚠️ IZLAZ NE PREGAZI CANARY. Piše se u vlastiti namespace
 * `{audio}.speechmatics.gemini.diarized.srt`; tek `--promote` napravi
 * `{base}.wav.canary.diarized.srt` (kanonsko ime koje koraci 7-12 čitaju) i to
 * SAMO ako ga nema. Prepisivanje postojećeg traži `--force-promote`.
 *
 * KORIŠTENJE
 *   node refine_diarized_gemini.js --input-dir storage/output --limit 3
 *   node refine_diarized_gemini.js --video-id aue1GuuMsbA --promote
 *   node refine_diarized_gemini.js --file <put/do/audio.mp3> --dry-run
 *
 * ZAMKE
 *   • `responseMimeType: application/json` + `responseSchema` su OBAVEZNI —
 *     bez njih model vrati prozu oko JSON-a i parsiranje puca na dugim prozorima.
 *   • Prozor se reže NA GRANICI SEGMENTA, nikad na fiksnoj minuti; inače model
 *     dobije pola rečenice i "dopuni" je izmišljotinom.
 *   • Quality gate je obavezan, ne ukras: model zna vratiti prazne segmente kad
 *     mu pažnja padne pred kraj prozora. Bez poda bi to tiho obrisalo govor.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, execFileSync } = require("child_process");

// ─── .env (SPEECHMATICS se ne treba, ali VERTEX_* smije doći odavde) ───
function loadEnv() {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
}
loadEnv();

// ─── gemini.conf (isti loader kao summarize_gemini.js) ───
function loadGeminiConf() {
    const confPath = path.join(__dirname, "gemini.conf");
    const conf = {};
    if (!fs.existsSync(confPath)) return conf;
    for (const line of fs.readFileSync(confPath, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        conf[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return conf;
}
const GEMINI_CONF = loadGeminiConf();

// ─── CLI (Pattern B) ───
const args = process.argv.slice(2);
function getArg(name, def = null) {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : def;
}
const hasFlag = (n) => args.includes(n);

const FILE = getArg("--file");
const INPUT_DIR = getArg("--input-dir", "storage/output");
const CHANNEL = getArg("--channel");
const VIDEO_ID = getArg("--video-id");
const LIMIT = parseInt(getArg("--limit", "1"), 10);
const WINDOW_MIN = parseFloat(getArg("--window-min", "10"));
const MAX_SEGS_PER_WINDOW = parseInt(getArg("--max-segments", "35"), 10);
const COVERAGE_MIN = parseFloat(getArg("--coverage-min", "0.65"));
const MAX_REPAIRS = parseInt(getArg("--max-repairs", "40"), 10);
const FRESH_DAYS = parseInt(getArg("--fresh-days", "0"), 10);
// Samo za probu: obradi prvih N prozora pa stani (izlaz je tada KRNJI, ne promovira se).
const MAX_WINDOWS = parseInt(getArg("--max-windows", "0"), 10);
const LANGUAGE = getArg("--language", "hr");
const DRY_RUN = hasFlag("--dry-run");
const FORCE = hasFlag("--force");
const PROMOTE = hasFlag("--promote");
const FORCE_PROMOTE = hasFlag("--force-promote");

const GEMINI_MODEL = getArg("--model") || process.env.GEMINI_MODEL || GEMINI_CONF.GEMINI_MODEL || "gemini-3.8-flash";
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || GEMINI_CONF.VERTEX_PROJECT || "bimbo-sync-prod";
const VERTEX_ACCOUNT = process.env.VERTEX_ACCOUNT || GEMINI_CONF.VERTEX_ACCOUNT || "";
const PRICE_IN_PER_M = parseFloat(process.env.GEMINI_PRICE_IN || GEMINI_CONF.GEMINI_PRICE_IN || "0.75");
const PRICE_OUT_PER_M = parseFloat(process.env.GEMINI_PRICE_OUT || GEMINI_CONF.GEMINI_PRICE_OUT || "3.75");

const MAX_RETRIES = 7;
const RETRY_BASE_DELAY_MS = 4000;
// Kvadratni rast: 15s, 60s, 135s, 240s… ukupno ~10 min prije predaje.
const RATE_LIMIT_BASE_DELAY_MS = 15000;
const REQUEST_DELAY_MS = 1000;

// Sufiksi
const SPEECHMATICS_JSON = ".speechmatics.json";
const OUT_SRT = ".speechmatics.gemini.diarized.srt";
const OUT_META = ".speechmatics.gemini.meta.json";
const CANONICAL_SRT = ".wav.canary.diarized.srt";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Jezik po kanalu ───────────────────────────────────────────────
// ⚠️ Prompt NE smije hardkodirati hrvatski. Katalog ima engleske kanale
// (catholic_futurist, subclub, launched…), a model koji dobije uputu "podcast na
// hrvatskom" uz engleski zvuk počne PREVODITI umjesto prepisivati.
// Čita istu `automatic/channel_languages.conf` koju koristi KORAK 2.7, pa su
// transkripcija i prepisivanje uvijek na istom jeziku.
// (Kopija `languageForPath` iz transcribe_speechmatics.js — repo nema shared modul.)
let _langConf = null;
function languageForPath(audioPath) {
    if (args.includes("--language")) return LANGUAGE;
    if (_langConf === null) {
        _langConf = new Map();
        const conf = path.join(__dirname, "automatic", "channel_languages.conf");
        if (fs.existsSync(conf)) {
            for (const line of fs.readFileSync(conf, "utf-8").split("\n")) {
                const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*([a-z]{2})\s*$/);
                if (m) _langConf.set(m[1], m[2]);
            }
        }
    }
    return _langConf.get(path.basename(path.dirname(audioPath))) || LANGUAGE;
}

/**
 * Jezik kojim je kostur STVARNO transkribiran.
 *
 * Najpouzdaniji izvor nije naša konfiguracija nego Speechmaticsov vlastiti zapis
 * u `metadata.transcription_config.language` — jer on kaže što se doista
 * dogodilo, a ne što smo mislili da će se dogoditi. Bitno za `_unlisted` i
 * ad-hoc epizode, koje nemaju kanal u `channel_languages.conf` pa bi inače pale
 * na default `hr` bez obzira na stvarni jezik snimke.
 * Redoslijed: --language (eksplicitan) > Speechmatics zapis > kanal > default.
 */
function resolveLanguage(audioPath, skeletonJson) {
    if (args.includes("--language")) return LANGUAGE;
    const fromSm = skeletonJson && skeletonJson.metadata
        && skeletonJson.metadata.transcription_config
        && skeletonJson.metadata.transcription_config.language;
    if (fromSm) return String(fromSm).toLowerCase();
    return languageForPath(audioPath);
}

const LANG_NAME = { hr: "hrvatskom", en: "engleskom", de: "njemačkom", it: "talijanskom", es: "španjolskom" };
function langPhrase(code) { return LANG_NAME[code] || code; }

// ─── Segmentacija (KOPIJA iz transcribe_speechmatics.js — repo nema shared modul;
//     kad mijenjaš ovdje, grepaj `buildSegments` i popravi u SVIM kopijama) ───
const SEG_SOFT_MAX_S = 12;
const SEG_HARD_MAX_S = 22;
const SEG_PAUSE_S = 1.2;
const SEG_MIN_S = 2.0;

function buildSegments(json) {
    const results = (json.results || []).filter((r) => r.type === "word" || r.type === "punctuation");
    const speakerMap = new Map();
    const mapSpeaker = (raw) => {
        if (!raw || raw === "UU") return "UNKNOWN";
        if (!speakerMap.has(raw)) speakerMap.set(raw, `SPEAKER_${String(speakerMap.size).padStart(2, "0")}`);
        return speakerMap.get(raw);
    };

    const segments = [];
    let cur = null;
    const flush = () => {
        if (!cur) return;
        const text = cur.tokens.join("").replace(/\s+/g, " ").trim();
        if (text) segments.push({ start: cur.start, end: cur.end, speaker: cur.speaker, text });
        cur = null;
    };

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const alt = (r.alternatives && r.alternatives[0]) || {};
        const content = alt.content || "";
        if (!content) continue;
        const speaker = mapSpeaker(alt.speaker);
        const isPunct = r.type === "punctuation";
        const attachPrev = isPunct && alt.attaches_to !== "next";

        if (cur && !attachPrev) {
            const gap = r.start_time - cur.end;
            const dur = cur.end - cur.start;
            const endsSentence = /[.!?…]$/.test(cur.tokens[cur.tokens.length - 1] || "");
            if (
                speaker !== cur.speaker ||
                dur >= SEG_HARD_MAX_S ||
                (dur >= SEG_SOFT_MAX_S && endsSentence) ||
                (gap >= SEG_PAUSE_S && dur >= SEG_MIN_S)
            ) flush();
        }
        if (!cur) cur = { start: r.start_time, end: r.end_time, speaker, tokens: [] };
        cur.tokens.push(cur.tokens.length === 0 || attachPrev ? content : " " + content);
        cur.end = Math.max(cur.end, r.end_time);
        if (!isPunct) cur.speaker = speaker;
    }
    flush();
    return { segments, speakerCount: speakerMap.size };
}

function secondsToSrtTimestamp(seconds) {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const milli = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(milli).padStart(3, "0")}`;
}

function renderSrt(segments) {
    const out = [];
    segments.forEach((seg, i) => {
        out.push(
            `${i + 1}`,
            `${secondsToSrtTimestamp(seg.start)} --> ${secondsToSrtTimestamp(seg.end)}`,
            `[${seg.speaker}] ${seg.text}`,
            ""
        );
    });
    return out.join("\n");
}

const wordCount = (s) => (String(s || "").trim().match(/\S+/g) || []).length;

// ─── Prozoriranje: rez UVIJEK na granici segmenta ───
function buildWindows(segments, stepSeconds) {
    const wins = [];
    let i = 0;
    while (i < segments.length) {
        const start = segments[i].start;
        const idx = [];
        let j = i;
        while (
            j < segments.length &&
            idx.length < MAX_SEGS_PER_WINDOW &&
            (idx.length === 0 || segments[j].end - start <= stepSeconds)
        ) {
            idx.push(j);
            j++;
        }
        wins.push({ od: start, do: segments[idx[idx.length - 1]].end, idx });
        i = j;
    }
    return wins;
}

// ─── OAuth (isti pin kao summarize_gemini.js) ───
let cachedToken = null;
let tokenExpiry = 0;
function getAccessToken() {
    const now = Date.now();
    if (cachedToken && now < tokenExpiry) return cachedToken;
    try {
        const acct = VERTEX_ACCOUNT ? ` --account=${VERTEX_ACCOUNT}` : "";
        cachedToken = execSync(`gcloud auth print-access-token${acct}`, { encoding: "utf-8" }).trim();
        tokenExpiry = now + 50 * 60 * 1000;
        return cachedToken;
    } catch (err) {
        console.error("❌ Ne mogu dohvatiti access token. Pokreni: gcloud auth login");
        process.exit(1);
    }
}

// gemini-3.x flash je GLOBAL-ONLY (regionalni endpointi 404-aju) — vidi gemini.conf.
const ENDPOINT = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/global/publishers/google/models/${GEMINI_MODEL}:generateContent`;

const SAFETY_OFF = [
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_HARASSMENT",
].map((category) => ({ category, threshold: "BLOCK_NONE" }));

const SEGMENT_SCHEMA = {
    type: "ARRAY",
    items: {
        type: "OBJECT",
        properties: { id: { type: "INTEGER" }, text: { type: "STRING" } },
        required: ["id", "text"],
    },
};

const SKELETON_PROMPT = `Ti si ASR sustav za preciznu transkripciju i poravnanje. Priložen je
zvučni isječak podcasta na %JEZIK% i popis SEGMENATA s vremenskim intervalima.
Vremena \`od\` i \`do\` su sekunde od početka OVOG isječka.

Za SVAKI segment napiši točno ono što u tom intervalu govori ZADANI GOVORNIK (\`govornik\`).

PRAVILA
1. ZADANI GOVORNIK I GRANICE: Piši ISKLJUČIVO riječi koje govori osoba navedena pod \`govornik\`.
   Ako na samom rubu isječka (tik prije \`od\` ili tik nakon \`do\`) čuješ upadicu, prekid ili
   govor DRUGE osobe, taj dio NE pripada ovom segmentu i NEMOJ ga uključivati.
2. POTPUNOST I ZABRANA SKRAĆIVANJA (ANTI-COLLAPSE):
   - STROGO JE ZABRANJENO sav govor iz više uzastopnih segmenata istog govornika prepisati
     u jedan segment (npr. spojiti monolog u prvi segment, a iduće ostaviti prazne).
     Svaki segment MORA sadržavati govor koji pripada njegovom intervalu.
   - NIKADA NE PREKIDAJ PRIJEPIS NA MEĐUPAUZI: govornik unutar \`[od, do]\` često zastane
     pola sekunde pa nastavi. Prijepis MORA obuhvatiti sav njegov govor od prve do zadnje
     sekunde intervala.
3. ZVUK JE ISTINA, NATUKNICA JE SIDRO: polje \`speechmatics\` pokazuje okvirni sadržaj.
   Zvuk je vrhovni autoritet za točnost i formulaciju, ali natuknica pomaže odrediti
   granice misli — NE prelijevaj sadržaj iz susjednih segmenata.
   - Natuknice često fonetski izobliče strane pojmove i imena. Vjeruj zvuku i napiši
     stvarne riječi, nipošto nemoj odbaciti rečenicu.
4. PONAVLJANJA: ako natuknica sadrži istu riječ ponovljenu mnogo puta ("nije, nije, nije…"),
   to je najčešće greška prethodnog ASR-a, a ne stvaran govor. Napiši ONOLIKO ponavljanja
   koliko ih STVARNO čuješ u zvuku, ni jedno više.
5. Segmente ne spajaš, ne dijeliš, ne preskačeš i ne mijenjaš im \`id\`.
6. Prazan segment (tišina, šum ili samo govor druge osobe) je "". No ako zadani govornik
   govori u tom intervalu, segment NIPOŠTO ne smije biti prazan.
7. Ne dopunjavaš, ne prepričavaš, ne cenzuriraš. Doslovno, s poštapalicama.
8. Strane pojmove i imena piši ispravno, ne fonetski. Piši standardnim pravopisom jezika
   izvornika, osim kad govornik očito govori dijalektom — tada zadrži dijalekt.
   NE PREVODI: jezik prijepisa mora biti isti kao jezik govora.
9. Govornika NE određuješ i NE mijenjaš; on je već zadan oznakom \`govornik\`.
10. SAMO IZGOVORENE RIJEČI: ne dodaješ crtice, zagrade, zvjezdice, emotikone ni bilo kakve
    tipografske oznake kojih u govoru nema. Ako govornik radi igru riječi ili rimu, napiši je
    kao običan tekst — NE isticati je crticama (npr. "skriva", ne "skr-iva-").
    Nema oznaka tipa [smijeh], [pauza], [glazba].

IZLAZ: JSON niz objekata {"id": <id segmenta>, "text": "<govor zadanog govornika>"}, po jedan
za svaki segment iz popisa, istim redoslijedom. Ništa drugo.

SEGMENTI:
`;

const REPAIR_PROMPT = `Priložen je KRATAK zvučni isječak podcasta na %JEZIK% koji sadrži točno
jednu izjavu govornika. Napiši doslovno što govornik kaže, bez uvoda i komentara.
Ako se u zvuku neka riječ stvarno ponavlja, napiši je onoliko puta koliko je čuješ.
Kao orijentaciju imaš raniji, moguće netočan prijepis: "%HINT%"

IZLAZ: JSON niz s jednim objektom {"id": %ID%, "text": "<doslovan govor>"}. Ništa drugo.
`;

const usage = { calls: 0, prompt: 0, output: 0, usd: 0, blocked: 0 };
function recordUsage(um) {
    if (!um) return;
    const p = um.promptTokenCount || 0;
    const o = um.candidatesTokenCount || 0;
    usage.calls++;
    usage.prompt += p;
    usage.output += o;
    usage.usd += (p / 1e6) * PRICE_IN_PER_M + (o / 1e6) * PRICE_OUT_PER_M;
}

/**
 * Jedan Vertex poziv s audio isječkom. Vraća parsirani JSON niz ili null.
 *
 * Blokada (`promptFeedback.blockReason`) se NE tretira kao greška nego kao
 * signal: prvi ponovni pokušaj ide sa `safetySettings` na BLOCK_NONE. Mjereno
 * u izvornoj implementaciji: 3/6 prozora blokirano nedeterministično, s istim
 * zvukom koji je drugdje prošao.
 */
async function callGemini(audioBuf, promptText, maxOut) {
    let relaxSafety = false;
    let lastErr = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const body = {
            contents: [{
                role: "user",
                parts: [
                    { inlineData: { mimeType: "audio/mpeg", data: audioBuf.toString("base64") } },
                    { text: promptText },
                ],
            }],
            generationConfig: {
                temperature: 0.0,
                maxOutputTokens: maxOut,
                responseMimeType: "application/json",
                responseSchema: SEGMENT_SCHEMA,
            },
        };
        if (relaxSafety) body.safetySettings = SAFETY_OFF;

        try {
            const res = await fetch(ENDPOINT, {
                method: "POST",
                headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await res.json();

            if (!res.ok) {
                const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
                // 401 = token istekao usred dugog runa; osvježi pa odmah ponovi.
                if (res.status === 401) { cachedToken = null; tokenExpiry = 0; }
                if (res.status === 429 || res.status >= 500 || res.status === 401) {
                    lastErr = new Error(msg);
                    // 429 ("Resource exhausted") nije prolazni mrežni hipac nego zatvoren
                    // kvotni prozor — 4s×pokušaj ga ne dočeka. Mjereno 19.09.: dva
                    // paralelna runa su iscrpila svih 6 pokušaja u ~84 s i cijeli prozor
                    // (35 segmenata) pao na sigurnosni pod. Zato 429 dobiva svoj raspored.
                    const delay = res.status === 429
                        ? RATE_LIMIT_BASE_DELAY_MS * attempt * attempt
                        : RETRY_BASE_DELAY_MS * attempt;
                    await sleep(delay);
                    continue;
                }
                throw new Error(msg);
            }

            const block = data.promptFeedback && data.promptFeedback.blockReason;
            const cand = data.candidates && data.candidates[0];
            if (block || !cand) {
                usage.blocked++;
                if (!relaxSafety) { relaxSafety = true; continue; }
                return { parsed: null, blocked: block || "NO_CANDIDATE" };
            }

            recordUsage(data.usageMetadata);

            const text = (cand.content && cand.content.parts || []).map((p) => p.text || "").join("");
            if (cand.finishReason === "MAX_TOKENS") {
                lastErr = new Error("MAX_TOKENS");
                // Krnji JSON nema smisla parsirati; javi gore pa nek prozor raspolovi.
                return { parsed: null, truncated: true };
            }
            try {
                return { parsed: JSON.parse(text) };
            } catch (_) {
                // responseSchema to gotovo nikad ne dopusti, ali ako dopusti —
                // izvuci prvi JSON niz iz teksta.
                const m = text.match(/\[[\s\S]*\]/);
                if (m) { try { return { parsed: JSON.parse(m[0]) }; } catch (_) {} }
                lastErr = new Error("Neparsabilan JSON");
                await sleep(RETRY_BASE_DELAY_MS);
                continue;
            }
        } catch (err) {
            lastErr = err;
            if (attempt === MAX_RETRIES) break;
            await sleep(RETRY_BASE_DELAY_MS * attempt);
        }
    }
    throw new Error(`Vertex poziv propao nakon ${MAX_RETRIES} pokušaja: ${lastErr ? lastErr.message : "?"}`);
}

// ─── ffmpeg rezanje ───
// 16 kHz mono 48 kbit mp3: izmjereno 25 audio-tokena/s, tj. ~90k tokena za sat
// zvuka. Veći bitrate ne mijenja broj tokena (model ionako downsampla), samo
// napuhne base64 u tijelu zahtjeva.
function cutAudio(srcPath, outPath, startSec, durSec) {
    execFileSync("ffmpeg", [
        "-nostdin", "-loglevel", "error", "-y",
        "-ss", String(Math.max(0, startSec)),
        "-t", String(durSec),
        "-i", srcPath,
        "-c:a", "libmp3lame", "-b:a", "48k", "-ac", "1", "-ar", "16000",
        outPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    return fs.readFileSync(outPath);
}

// ─── Obrada jedne epizode ───
async function processFile(audioPath, work) {
    const jsonPath = audioPath + SPEECHMATICS_JSON;
    const outSrt = audioPath + OUT_SRT;
    const outMeta = audioPath + OUT_META;
    const baseNoExt = audioPath.replace(/\.[^.]+$/, "");
    const canonical = baseNoExt + CANONICAL_SRT;
    const baseName = path.basename(baseNoExt);

    console.log(`\n🎙️  ${baseName}`);

    if (fs.existsSync(outSrt) && !FORCE) {
        // Već obrađeno — ali promocija je zaseban korak od obrade. Epizoda može
        // imati gotov .speechmatics.gemini.diarized.srt iz ranijeg runa (ili iz
        // runa bez --promote) a nemati kanonsko ime. Tada NE zovi Gemini ponovno,
        // nego samo prepiši postojeći izlaz na kanonsko mjesto.
        if ((PROMOTE || FORCE_PROMOTE) && (!fs.existsSync(canonical) || FORCE_PROMOTE)) {
            if (fs.existsSync(canonical)) {
                fs.copyFileSync(canonical, canonical + ".bak");
                console.log(`   💾 Stari canary spremljen: ${path.basename(canonical)}.bak`);
            }
            fs.copyFileSync(outSrt, canonical);
            console.log(`   ⬆️  Već obrađeno — promovirano bez API poziva → ${path.basename(canonical)}`);
            return { promotedOnly: true };
        }
        console.log("   ⏭️  Već obrađeno (--force za ponovno).");
        return { skipped: true };
    }

    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const lang = resolveLanguage(audioPath, raw);
    const { segments, speakerCount } = buildSegments(raw);
    if (segments.length === 0) {
        console.log("   ⚠️  Speechmatics JSON nema segmenata — preskačem.");
        return { skipped: true };
    }

    const totalDur = segments[segments.length - 1].end;
    const windows = buildWindows(segments, WINDOW_MIN * 60);
    const baseWords = segments.reduce((s, x) => s + wordCount(x.text), 0);

    console.log(`   📐 [${lang}] ${segments.length} segmenata · ${speakerCount} govornika · ${(totalDur / 60).toFixed(1)} min · ${windows.length} prozora · ${baseWords} riječi (Speechmatics)`);

    if (DRY_RUN) {
        const estTokens = totalDur * 25;
        console.log(`   🧪 DRY RUN — procjena ~${Math.round(estTokens / 1000)}k audio tokena ≈ $${((estTokens / 1e6) * PRICE_IN_PER_M).toFixed(4)} ulaza`);
        return { dryRun: true };
    }

    const t0 = Date.now();
    const stats = { accepted: 0, repaired: 0, fallback: 0, emptied: 0, halved: 0 };
    let repairsLeft = MAX_REPAIRS;

    // Jedan prozor; vraća mapu id → tekst. Na blokadi/krnjem izlazu raspolovi.
    async function runWindow(win, depth = 0) {
        const lead = 0.5;
        const base = Math.max(0, win.od - lead);
        const dur = win.do - base + 1.0;
        const clip = path.join(work, `w-${Math.round(base)}-${depth}.mp3`);
        const buf = cutAudio(audioPath, clip, base, dur);

        const listing = win.idx.map((j) => ({
            id: j,
            od: Math.round((segments[j].start - base) * 10) / 10,
            do: Math.round((segments[j].end - base) * 10) / 10,
            govornik: segments[j].speaker,
            speechmatics: segments[j].text,
        }));

        // Izlaz je prijepis istog govora — strop vežemo uz duljinu natuknice,
        // s velikom rezervom, umjesto fiksnih 8192 (ta pretpostavka je u izvornom
        // eksperimentu bila kriva i skupo se platila).
        const hintTokens = listing.reduce((s, x) => s + wordCount(x.speechmatics), 0) * 3;
        const maxOut = Math.min(65536, Math.max(4096, hintTokens * 3));

        let res;
        try {
            res = await callGemini(buf, SKELETON_PROMPT.replace("%JEZIK%", langPhrase(lang)) + JSON.stringify(listing), maxOut);
        } finally {
            try { fs.unlinkSync(clip); } catch (_) {}
        }

        if ((!res.parsed || res.truncated || res.blocked) && win.idx.length > 1 && depth < 3) {
            stats.halved++;
            const mid = Math.ceil(win.idx.length / 2);
            const a = { od: segments[win.idx[0]].start, do: segments[win.idx[mid - 1]].end, idx: win.idx.slice(0, mid) };
            const b = { od: segments[win.idx[mid]].start, do: segments[win.idx[win.idx.length - 1]].end, idx: win.idx.slice(mid) };
            const ra = await runWindow(a, depth + 1);
            const rb = await runWindow(b, depth + 1);
            return new Map([...ra, ...rb]);
        }

        const byId = new Map();
        for (const x of res.parsed || []) {
            if (!x || typeof x.id === "undefined") continue;
            const id = parseInt(x.id, 10);
            if (!Number.isInteger(id)) continue;
            // Ponovljeni id (model podijeli segment u dva zapisa) se SPAJA, ne pregazi.
            byId.set(id, ((byId.get(id) || "") + " " + String(x.text || "")).trim());
        }
        return byId;
    }

    const winLimit = MAX_WINDOWS > 0 ? Math.min(MAX_WINDOWS, windows.length) : windows.length;
    for (let w = 0; w < winLimit; w++) {
        const win = windows[w];
        process.stdout.write(`   🔊 prozor ${w + 1}/${windows.length}  ${secondsToSrtTimestamp(win.od).slice(0, 8)}–${secondsToSrtTimestamp(win.do).slice(0, 8)}  ${win.idx.length} seg …`);

        let byId;
        try {
            byId = await runWindow(win);
        } catch (err) {
            console.log(` ❌ ${err.message} — Speechmatics tekst ostaje`);
            // NE broji fallback ovdje: sklapanje ispod prolazi kroz SVE segmente i
            // prebroji svaki `refined === null` kao fallback. Dvostruko brojanje je
            // 19.09. dalo 958+70=1028 za 993 segmenta.
            for (const j of win.idx) segments[j].refined = null;
            continue;
        }

        let gotWords = 0, baseWin = 0;
        for (const j of win.idx) {
            baseWin += wordCount(segments[j].text);
            const got = byId.get(j);
            if (typeof got === "undefined") {
                segments[j].refined = null;
            } else if (!got.trim() && segments[j].text.trim()) {
                // Model vratio prazno za segment koji u natuknici IMA tekst.
                // Bilo da je kratka upadica ili progutani monolog — natuknica spašava segment.
                segments[j].refined = null;
                stats.emptied++;
            } else {
                segments[j].refined = got.trim();
                gotWords += wordCount(got);
            }
        }

        const cov = baseWin > 0 ? gotWords / baseWin : 1;
        console.log(` ${(cov * 100).toFixed(0)}% pokrivenost`);

        // Quality gate: ispod poda ne vjeruj prozoru, nego popravljaj segment po segment.
        const suspect = win.idx.filter((j) => segments[j].refined === null && segments[j].text.trim());
        const needRepair = cov < COVERAGE_MIN ? win.idx.filter((j) => segments[j].text.trim()) : suspect;

        for (const j of needRepair) {
            if (repairsLeft <= 0) break;
            if (segments[j].refined && cov >= COVERAGE_MIN) continue;
            repairsLeft--;
            const s = segments[j];
            const b = Math.max(0, s.start - 0.4);
            const clip = path.join(work, `r-${j}.mp3`);
            try {
                const buf = cutAudio(audioPath, clip, b, s.end - b + 0.8);
                const prompt = REPAIR_PROMPT.replace("%JEZIK%", langPhrase(lang)).replace("%HINT%", s.text.replace(/"/g, "'")).replace("%ID%", String(j));
                const r = await callGemini(buf, prompt, Math.max(2048, wordCount(s.text) * 12));
                const got = (r.parsed || []).find((x) => x && String(x.id) === String(j));
                if (got && String(got.text || "").trim()) {
                    s.refined = String(got.text).trim();
                    stats.repaired++;
                }
            } catch (_) {
                // Popravak je dodatak, ne uvjet — segment pada na Speechmatics tekst.
            } finally {
                try { fs.unlinkSync(clip); } catch (_) {}
            }
            await sleep(REQUEST_DELAY_MS);
        }

        await sleep(REQUEST_DELAY_MS);
    }

    // ─── Sklapanje: sigurnosni pod je UVIJEK Speechmatics tekst ───
    const final = segments.map((s) => {
        if (s.refined && s.refined.trim()) { stats.accepted++; return { ...s, text: s.refined }; }
        stats.fallback++;
        return { ...s, text: s.text };
    });

    const refinedWords = final.reduce((acc, x) => acc + wordCount(x.text), 0);
    fs.writeFileSync(outSrt, renderSrt(final), "utf-8");

    const elapsed = (Date.now() - t0) / 1000;
    const meta = {
        base: baseName,
        source: "speechmatics+gemini",
        skeleton: path.basename(jsonPath),
        model: GEMINI_MODEL,
        project: VERTEX_PROJECT,
        language: lang,
        segments: segments.length,
        speakers: speakerCount,
        windows: windows.length,
        audio_seconds: Math.round(totalDur),
        words_speechmatics: baseWords,
        words_refined: refinedWords,
        stats,
        calls: usage.calls,
        prompt_tokens: usage.prompt,
        output_tokens: usage.output,
        est_usd: Math.round(usage.usd * 1e6) / 1e6,
        blocked_windows: usage.blocked,
        elapsed_seconds: Math.round(elapsed),
        at: new Date().toISOString(),
    };
    fs.writeFileSync(outMeta, JSON.stringify(meta, null, 2), "utf-8");

    console.log(`   ✅ ${stats.accepted} prihvaćeno · ${stats.repaired} popravljeno · ${stats.fallback} na Speechmaticsu · ${stats.halved} raspolavljanja`);
    console.log(`   📝 ${baseWords} → ${refinedWords} riječi · ${fmtDur(elapsed)} · ≈$${usage.usd.toFixed(4)}`);
    console.log(`      → ${path.basename(outSrt)}`);

    // ─── Promocija u kanonsko ime koje čitaju koraci 7-12 ───
    if (MAX_WINDOWS > 0) {
        console.log("   ⚠️  --max-windows: izlaz je KRNJI, promocija preskočena.");
    } else if (PROMOTE || FORCE_PROMOTE) {
        if (fs.existsSync(canonical) && !FORCE_PROMOTE) {
            console.log(`   ⏭️  ${path.basename(canonical)} već postoji — NE diram (--force-promote za prepis).`);
        } else {
            if (fs.existsSync(canonical)) {
                const bak = canonical + ".bak";
                fs.copyFileSync(canonical, bak);
                console.log(`   💾 Stari canary spremljen: ${path.basename(bak)}`);
            }
            fs.writeFileSync(canonical, renderSrt(final), "utf-8");
            console.log(`   ⬆️  Promovirano → ${path.basename(canonical)}`);
        }
    }

    // ─── Trošak u zajednički sidecar (dijeli ga s koracima 7+8) ───
    const usagePath = path.join(path.dirname(audioPath), baseName + ".gemini_usage.json");
    let prevRuns = [];
    try { prevRuns = JSON.parse(fs.readFileSync(usagePath, "utf-8")).runs || []; } catch (_) {}
    const rec = {
        step: "refine", model: GEMINI_MODEL, project: VERTEX_PROJECT,
        prompt_tokens: usage.prompt, output_tokens: usage.output,
        total_tokens: usage.prompt + usage.output, calls: usage.calls,
        est_usd: Math.round(usage.usd * 1e6) / 1e6,
        price_in_per_m: PRICE_IN_PER_M, price_out_per_m: PRICE_OUT_PER_M,
        at: new Date().toISOString(),
    };
    prevRuns = prevRuns.filter((r) => r.step !== "refine").concat(rec);
    const totUsd = Math.round(prevRuns.reduce((s, r) => s + (r.est_usd || 0), 0) * 1e6) / 1e6;
    fs.writeFileSync(usagePath, JSON.stringify({ base: baseName, total_est_usd: totUsd, runs: prevRuns }, null, 2), "utf-8");

    return { ok: true, meta };
}

function fmtDur(seconds) {
    const s = Math.round(seconds);
    return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ─── Pronalaženje kandidata ───
// ⚠️ Node, ne shell `find`: pod launchd-om shell nema pristup vanjskim volumenima
// na koje kanali pokazuju symlinkovima (macOS TCC) — vidi CLAUDE.md, KORAK 2.6.
function findCandidates(root) {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            // Symlinkani kanali: isDirectory() je false za symlink, mora i isSymbolicLink().
            if (e.isDirectory() || e.isSymbolicLink()) {
                let st;
                try { st = fs.statSync(p); } catch (_) { continue; }
                if (st.isDirectory()) walk(p);
                continue;
            }
            if (!e.name.endsWith(SPEECHMATICS_JSON)) continue;
            const audioPath = p.slice(0, -SPEECHMATICS_JSON.length);
            if (!fs.existsSync(audioPath)) continue;
            if (VIDEO_ID && !audioPath.includes(`_yt_${VIDEO_ID}`)) continue;
            // Već obrađena epizoda se preskače — OSIM ako je tražena promocija a
            // kanonsko ime još ne postoji: tada je kandidat za promote-only prolaz
            // (bez ijednog API poziva). Bez ovoga `--promote` nad ranijim runom
            // ne bi našao ništa i tiho ne bi napravio ništa.
            const canonicalPath = audioPath.replace(/\.[^.]+$/, "") + CANONICAL_SRT;
            const needsPromote = (PROMOTE && !fs.existsSync(canonicalPath)) || FORCE_PROMOTE;
            if (fs.existsSync(audioPath + OUT_SRT) && !FORCE && !needsPromote) continue;
            if (FRESH_DAYS > 0) {
                const age = (Date.now() - fs.statSync(p).mtimeMs) / 86400000;
                if (age > FRESH_DAYS) continue;
            }
            out.push(audioPath);
        }
    };
    walk(root);
    // Najnovije prvo — svjež priljev je vrjedniji od backloga.
    return out.sort((a, b) => fs.statSync(b + SPEECHMATICS_JSON).mtimeMs - fs.statSync(a + SPEECHMATICS_JSON).mtimeMs);
}

async function main() {
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║  SPEECHMATICS KOSTUR + GEMINI SLUH (KORAK 2.8)  ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   Model:   ${GEMINI_MODEL} @ ${VERTEX_PROJECT} (global)`);
    console.log(`   Prozor:  ${WINDOW_MIN} min / max ${MAX_SEGS_PER_WINDOW} seg · pod pokrivenosti ${(COVERAGE_MIN * 100).toFixed(0)}%`);

    try {
        execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    } catch (_) {
        console.error("❌ ffmpeg nije u PATH-u — potreban je za rezanje prozora.");
        process.exit(1);
    }

    let candidates;
    if (FILE) {
        const audioPath = FILE.endsWith(SPEECHMATICS_JSON) ? FILE.slice(0, -SPEECHMATICS_JSON.length) : FILE;
        if (!fs.existsSync(audioPath + SPEECHMATICS_JSON)) {
            console.error(`❌ Nema ${path.basename(audioPath)}${SPEECHMATICS_JSON} — pokreni prvo KORAK 2.7.`);
            process.exit(1);
        }
        candidates = [audioPath];
    } else {
        const root = CHANNEL ? path.join(INPUT_DIR, CHANNEL) : INPUT_DIR;
        candidates = findCandidates(root).slice(0, LIMIT);
    }

    if (candidates.length === 0) {
        console.log("\n   ⏭️  Nema kandidata (treba .speechmatics.json bez .speechmatics.gemini.diarized.srt).");
        return;
    }
    console.log(`   📋 Kandidata: ${candidates.length}\n`);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), "refine-gemini-"));
    let ok = 0, fail = 0;
    try {
        for (const audioPath of candidates) {
            try {
                const r = await processFile(audioPath, work);
                if (r && r.ok) ok++;
            } catch (err) {
                fail++;
                console.log(`   ❌ ${err.message}`);
            }
        }
    } finally {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
    }

    console.log(`\n📊 Uspješnih: ${ok} | Neuspjelih: ${fail} | Ukupno ≈$${usage.usd.toFixed(4)} u ${usage.calls} poziva`);
    if (fail > 0) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((err) => { console.error("❌", err); process.exit(1); });
}

module.exports = { buildSegments, buildWindows, renderSrt, wordCount };
