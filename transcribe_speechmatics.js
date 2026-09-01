#!/usr/bin/env node
/**
 * transcribe_speechmatics.js — EKSPERIMENTALNA cloud transkripcija + diarizacija
 * preko Speechmatics Batch API-ja (https://asr.api.speechmatics.com/v2).
 *
 * ZAŠTO POSTOJI: Canary (Colab/Modal GPU) + pyannote (lokalni Mac) su dva odvojena
 * koraka na dva stroja. Speechmatics oboje radi u jednom pozivu, u oblaku, iz .mp3
 * (bez WAV konverzije i bez 200 MB uploada). Ovo je mjerni instrument za odluku
 * "smijemo li cijelu transkripciju preseliti u oblak", NE produkcijski put.
 *
 * ⚠️ ODVOJEN NAMESPACE — kao i colab_sortformer, izlaz NIKAD ne kolidira s produkcijom:
 *      {audio}.speechmatics.srt            (bez oznaka govornika ≈ .canary.srt)
 *      {audio}.speechmatics.diarized.srt   ([SPEAKER_XX] ≈ .canary.diarized.srt)
 *      {audio}.speechmatics.json           (sirovi json-v2, za recovery i mjerenja)
 *      {audio}.speechmatics.meta.json      (trajanje, trošak, konfiguracija)
 *   run_pipeline.sh / count_progress.js / rclone filter ovo ne vide. Pokretanje
 *   ove skripte ne može pokvariti postojeći katalog.
 *
 * Ključ: SPEECHMATICS_API_KEY u .env (gitignored).
 *
 * Primjeri:
 *   node transcribe_speechmatics.js --file storage/output/kanal/ep.mp3
 *   node transcribe_speechmatics.js --file ep.mp3 --language hr --sensitivity 0.6
 *   node transcribe_speechmatics.js --input-dir storage/output --channel podcast_cuspajz --limit 2
 *   node transcribe_speechmatics.js --file ep.mp3 --translate en   # bonus: HR→EN prijevod
 */

const fs = require("fs");
const path = require("path");

// ─── .env loader (isti minimalni obrazac kao ostatak repoa — bez dotenv ovisnosti) ───
function loadEnv() {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        if (process.env[m[1]] === undefined) {
            process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
    }
}
loadEnv();

// ─── CLI (Pattern B) ───
const args = process.argv.slice(2);
function getArg(name, def = null) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : def;
}
const hasFlag = (name) => args.includes(name);

const API_BASE = process.env.SPEECHMATICS_API_BASE || "https://asr.api.speechmatics.com/v2";
const API_KEY = process.env.SPEECHMATICS_API_KEY;

const FILE = getArg("--file");
const INPUT_DIR = getArg("--input-dir", "storage/output");
const CHANNEL = getArg("--channel");
const LIMIT = parseInt(getArg("--limit", "1"), 10);
const LANGUAGE = getArg("--language", "hr");
const OPERATING_POINT = getArg("--operating-point", "enhanced");
const SENSITIVITY = parseFloat(getArg("--sensitivity", "0.5"));
const TRANSLATE = getArg("--translate");           // npr. "en"; bez flaga = bez prijevoda
const FORCE = hasFlag("--force");
const DRY_RUN = hasFlag("--dry-run");
const POLL_S = parseInt(getArg("--poll-seconds", "15"), 10);
// Prozor svježine u danima. 0 = bez ograničenja (ručni rad, ciljani backfill).
//
// ⚠️ NAMJERNO drukčije od KORAKA 2.6 (Modal), gdje je mtime prozor UKINUT jer je
// propuštena noć bila trajna — transkripcija MORA konvergirati nad cijelim katalogom.
// Ovdje je obrnuto: Speechmatics je evaluacijski sloj i NE SMIJE konvergirati, inače
// bi po 3 epizode po noći tiho progrizao svih 3 200 epizoda (≈ $2 500). Prozor je
// ovdje financijska ograda, ne optimizacija.
const FRESH_DAYS = parseInt(getArg("--fresh-days", "0"), 10);
const TIMEOUT_MIN = parseInt(getArg("--timeout-minutes", "90"), 10);

// Speechmatics naplaćuje po satu zvuka; koristi se samo za procjenu u logu.
const USD_PER_HOUR = parseFloat(process.env.SPEECHMATICS_USD_PER_HOUR || "0.80");

const SUFFIX_JSON = ".speechmatics.json";
const SUFFIX_SRT = ".speechmatics.srt";
const SUFFIX_DIARIZED = ".speechmatics.diarized.srt";
const SUFFIX_META = ".speechmatics.meta.json";

// ─── Pomoćne ───
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function secondsToSrtTimestamp(seconds) {
    const ms = Math.round(seconds * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const rest = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:` +
           `${String(s).padStart(2, "0")},${String(rest).padStart(3, "0")}`;
}

function fmtDur(seconds) {
    const s = Math.round(seconds);
    return `${String(Math.floor(s / 3600)).padStart(2, "0")}:` +
           `${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:` +
           `${String(s % 60).padStart(2, "0")}`;
}

async function apiFetch(url, opts = {}, tries = 4) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url, {
                ...opts,
                headers: { Authorization: `Bearer ${API_KEY}`, ...(opts.headers || {}) },
            });
            // 429/5xx → eksponencijalni backoff; 4xx (osim 429) je trajna greška.
            if (res.status === 429 || res.status >= 500) {
                const wait = Math.min(60, 2 ** i * 5);
                console.log(`   ⏳ HTTP ${res.status} — čekam ${wait}s pa ponavljam…`);
                await sleep(wait * 1000);
                continue;
            }
            return res;
        } catch (err) {
            lastErr = err;
            const wait = Math.min(60, 2 ** i * 5);
            console.log(`   ⏳ Mrežna greška (${err.message}) — čekam ${wait}s…`);
            await sleep(wait * 1000);
        }
    }
    throw lastErr || new Error("Speechmatics API nedostupan nakon svih pokušaja");
}

// ─── json-v2 → segmenti ───
//
// Speechmatics vraća results[] na razini RIJEČI (type: word|punctuation), a govornik
// je u alternatives[0].speaker ("S1", "S2", "UU" = nepoznato). Downstream (članci, RAG,
// screenshotovi) očekuju SRT segmente od ~10 s s [SPEAKER_XX] prefiksom, pa riječi
// grupiramo natrag u segmente po istim pravilima po kojima izgleda canary izlaz.
const SEG_SOFT_MAX_S = 12;   // iznad ovoga zatvori na prvoj rečeničnoj granici
const SEG_HARD_MAX_S = 22;   // apsolutni strop — bolje prelomiti nego imati blok od minute
const SEG_PAUSE_S = 1.2;     // tišina duža od ovoga je granica ako segment već ima sadržaja
const SEG_MIN_S = 2.0;

function buildSegments(json) {
    const results = (json.results || []).filter(
        (r) => r.type === "word" || r.type === "punctuation"
    );

    // Mapiranje S1/S2/... → SPEAKER_00/01/... po redoslijedu PRVOG pojavljivanja.
    // (Speechmatics već numerira tim redom, ali ne oslanjamo se na to.)
    const speakerMap = new Map();
    const mapSpeaker = (raw) => {
        if (!raw || raw === "UU") return "UNKNOWN";
        if (!speakerMap.has(raw)) {
            speakerMap.set(raw, `SPEAKER_${String(speakerMap.size).padStart(2, "0")}`);
        }
        return speakerMap.get(raw);
    };

    const segments = [];
    let cur = null;

    const flush = () => {
        if (!cur) return;
        const text = cur.tokens.join("").replace(/\s+/g, " ").trim();
        if (text) {
            segments.push({ start: cur.start, end: cur.end, speaker: cur.speaker, text });
        }
        cur = null;
    };

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const alt = (r.alternatives && r.alternatives[0]) || {};
        const content = alt.content || "";
        if (!content) continue;
        const speaker = mapSpeaker(alt.speaker);
        const isPunct = r.type === "punctuation";
        // Interpunkcija se lijepi na prethodnu riječ (attaches_to: "previous" je default).
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
            ) {
                flush();
            }
        }

        if (!cur) {
            cur = { start: r.start_time, end: r.end_time, speaker, tokens: [] };
        }
        cur.tokens.push(cur.tokens.length === 0 || attachPrev ? content : " " + content);
        cur.end = Math.max(cur.end, r.end_time);
        // Interpunkcija ne smije "posuditi" govornika iz sljedećeg bloka.
        if (!isPunct) cur.speaker = speaker;
    }
    flush();

    return { segments, speakerCount: speakerMap.size };
}

function renderSrt(segments, withSpeakers) {
    const out = [];
    segments.forEach((seg, i) => {
        const prefix = withSpeakers ? `[${seg.speaker}] ` : "";
        out.push(
            `${i + 1}`,
            `${secondsToSrtTimestamp(seg.start)} --> ${secondsToSrtTimestamp(seg.end)}`,
            `${prefix}${seg.text}`,
            ""
        );
    });
    return out.join("\n");
}

// ─── Batch job ───
async function submitJob(audioPath) {
    const config = {
        type: "transcription",
        transcription_config: {
            language: languageForPath(audioPath),
            operating_point: OPERATING_POINT,
            diarization: "speaker",
            speaker_diarization_config: { speaker_sensitivity: SENSITIVITY },
        },
    };
    if (TRANSLATE) {
        config.type = "transcription";
        config.translation_config = { target_languages: [TRANSLATE] };
    }

    const form = new FormData();
    form.append("config", JSON.stringify(config));
    const buf = fs.readFileSync(audioPath);
    form.append("data_file", new Blob([buf]), path.basename(audioPath));

    const res = await apiFetch(`${API_BASE}/jobs`, { method: "POST", body: form });
    const body = await res.text();
    if (!res.ok) throw new Error(`Slanje posla nije uspjelo: HTTP ${res.status} — ${body.slice(0, 400)}`);
    const parsed = JSON.parse(body);
    if (!parsed.id) throw new Error(`Odgovor bez job id: ${body.slice(0, 400)}`);
    return { id: parsed.id, config };
}

async function waitForJob(jobId) {
    const deadline = Date.now() + TIMEOUT_MIN * 60 * 1000;
    let last = "";
    while (Date.now() < deadline) {
        const res = await apiFetch(`${API_BASE}/jobs/${jobId}`);
        const body = await res.json();
        const status = (body.job && body.job.status) || "unknown";
        if (status !== last) {
            console.log(`   📡 status: ${status}`);
            last = status;
        }
        if (status === "done") return body.job;
        if (status === "rejected" || status === "expired" || status === "deleted") {
            const why = (body.job && body.job.errors) ? JSON.stringify(body.job.errors) : status;
            throw new Error(`Posao odbijen (${status}): ${why}`);
        }
        await sleep(POLL_S * 1000);
    }
    throw new Error(`Timeout nakon ${TIMEOUT_MIN} min — posao ${jobId} nije završio (nije obrisan, provjeri ručno).`);
}

async function fetchTranscript(jobId, format) {
    const url = `${API_BASE}/jobs/${jobId}/transcript?format=${encodeURIComponent(format)}`;
    const res = await apiFetch(url);
    const body = await res.text();
    if (!res.ok) throw new Error(`Dohvat transkripta (${format}) nije uspio: HTTP ${res.status} — ${body.slice(0, 300)}`);
    return body;
}

async function processFile(audioPath) {
    const outJson = audioPath + SUFFIX_JSON;
    const outSrt = audioPath + SUFFIX_SRT;
    const outDia = audioPath + SUFFIX_DIARIZED;
    const outMeta = audioPath + SUFFIX_META;

    if (fs.existsSync(outDia) && !FORCE) {
        console.log(`⏭️  Već postoji ${path.basename(outDia)} (--force za ponavljanje).`);
        return { skipped: true };
    }

    const sizeMb = fs.statSync(audioPath).size / 1048576;
    console.log(`\n🎙️  ${path.basename(audioPath)}  (${sizeMb.toFixed(1)} MB, ${languageForPath(audioPath)}, ${OPERATING_POINT})`);

    if (DRY_RUN) {
        console.log("   ⚠️ DRY RUN — ne šaljem ništa na Speechmatics.");
        return { skipped: true };
    }

    const t0 = Date.now();
    const { id: jobId, config } = await submitJob(audioPath);
    console.log(`   ⬆️  poslano, job ${jobId}`);

    const job = await waitForJob(jobId);
    const raw = await fetchTranscript(jobId, "json-v2");
    fs.writeFileSync(outJson, raw, "utf-8");

    const json = JSON.parse(raw);
    const { segments, speakerCount } = buildSegments(json);
    fs.writeFileSync(outSrt, renderSrt(segments, false), "utf-8");
    fs.writeFileSync(outDia, renderSrt(segments, true), "utf-8");

    const audioSec = (job.duration != null)
        ? job.duration
        : (segments.length ? segments[segments.length - 1].end : 0);
    const wallSec = (Date.now() - t0) / 1000;
    const meta = {
        provider: "speechmatics",
        api_base: API_BASE,
        job_id: jobId,
        submitted_config: config,
        audio_file: path.basename(audioPath),
        audio_seconds: audioSec,
        wall_seconds: +wallSec.toFixed(1),
        realtime_factor: audioSec ? +(audioSec / wallSec).toFixed(2) : null,
        segments: segments.length,
        speakers: speakerCount,
        estimated_usd: +((audioSec / 3600) * USD_PER_HOUR).toFixed(4),
        generated_at: new Date().toISOString(),
    };
    fs.writeFileSync(outMeta, JSON.stringify(meta, null, 2), "utf-8");

    console.log(
        `   ✅ ${segments.length} segmenata, ${speakerCount} govornika | ` +
        `zvuk ${fmtDur(audioSec)}, obrada ${fmtDur(wallSec)} (${meta.realtime_factor}× realtime) | ` +
        `~$${meta.estimated_usd}`
    );
    console.log(`      → ${path.basename(outDia)}`);
    return { ok: true, meta };
}

// ─── Izvorni jezik po kanalu ───
// Isti izvor istine koji koristi KORAK 2.6 (automatic/channel_languages.conf).
// Bez ovoga bi engleski kanali (launched, subclub, catholic_futurist) išli kao "hr".
let _langConf = null;
function languageForPath(audioPath) {
    if (args.includes("--language")) return LANGUAGE;   // eksplicitni override pobjeđuje
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
    const channel = path.basename(path.dirname(audioPath));
    return _langConf.get(channel) || LANGUAGE;
}

// ─── Odabir datoteka ───
//
// Prioritet formata po epizodi: mp3 > m4a > opus > wav. mp3 je ~10× manji od WAV-a
// uz istu ASR kvalitetu, pa upload traje sekunde umjesto minuta.
//
// ⚠️ ORPHAN FRAGMENTI: yt-dlp za sobom ostavlja `<base>.f396.mp4` / `.f251.webm` —
// pojedinačne streamove (često video-only, bez ijednog zvučnog uzorka). Slanje takvog
// fajla je čist gubitak novca i vremena, a naziv izgleda kao normalna epizoda.
// Vidi memory `ytdlp_orphan_fragment_files`.
const FORMAT_RANK = { ".mp3": 0, ".m4a": 1, ".opus": 2, ".ogg": 3, ".flac": 4, ".wav": 5 };
const ORPHAN_FRAGMENT = /\.f\d{2,4}\.[a-z0-9]+$/i;

function collectCandidates() {
    if (FILE) return [FILE];
    const root = path.resolve(INPUT_DIR);
    const channels = CHANNEL
        ? [CHANNEL]
        : fs.readdirSync(root, { withFileTypes: true })
            // Symlinkani kanali: isDirectory() je false na symlinku — vidi CLAUDE.md.
            .filter((e) => e.isDirectory() || e.isSymbolicLink())
            .map((e) => e.name);

    const byEpisode = new Map();   // basename bez ekstenzije → najbolji audio kandidat
    const done = new Set();        // epizode koje već imaju izlaz (kroz BILO KOJI format)
    for (const ch of channels) {
        const dir = path.join(root, ch);
        let files;
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
            if (ORPHAN_FRAGMENT.test(f)) continue;
            const ext = path.extname(f).toLowerCase();
            const rank = FORMAT_RANK[ext];
            if (rank === undefined) continue;
            const key = path.join(ch, f.slice(0, -ext.length));
            // "Gotovo" je svojstvo EPIZODE, ne datoteke: epizoda obrađena preko .mp3
            // ne smije se ponovno ponuditi kao .wav (isti zvuk, dvostruki račun).
            if (fs.existsSync(path.join(dir, f + SUFFIX_DIARIZED))) { done.add(key); continue; }
            const prev = byEpisode.get(key);
            if (prev && prev.rank <= rank) continue;
            const p = path.join(dir, f);
            let st;
            try { st = fs.statSync(p); } catch { continue; }
            byEpisode.set(key, { p, rank, mtime: st.mtimeMs });
        }
    }
    if (!FORCE) for (const k of done) byEpisode.delete(k);

    let pool = [...byEpisode.values()];
    if (FRESH_DAYS > 0) {
        const cutoff = Date.now() - FRESH_DAYS * 86400 * 1000;
        const before = pool.length;
        pool = pool.filter((x) => x.mtime >= cutoff);
        console.log(`   🗓️  Prozor svježine ${FRESH_DAYS}d: ${before} → ${pool.length} kandidata`);
    }

    return pool
        .sort((a, b) => b.mtime - a.mtime)   // najnovije prvo
        .slice(0, LIMIT)
        .map((x) => x.p);
}

(async () => {
    if (!API_KEY) {
        console.error("❌ Nema SPEECHMATICS_API_KEY (.env). Izlazim.");
        process.exit(1);
    }
    const targets = collectCandidates();
    if (targets.length === 0) {
        console.log("✅ Nema kandidata za Speechmatics transkripciju.");
        return;
    }
    console.log(`📋 Kandidata: ${targets.length}`);
    let ok = 0, fail = 0;
    for (const t of targets) {
        try {
            const r = await processFile(t);
            if (r.ok) ok++;
        } catch (err) {
            fail++;
            console.error(`   ❌ ${path.basename(t)}: ${err.message}`);
        }
    }
    console.log(`\n📊 Uspješnih: ${ok} | Neuspjelih: ${fail}`);
    if (fail > 0) process.exit(1);
})();
