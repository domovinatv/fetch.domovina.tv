#!/usr/bin/env node
// Faza 1a: cloud ASR + diarizacija (Speechmatics Enhanced, Deepgram Nova-3, AssemblyAI Universal-2)
// nad data/audio/{ID}.mp3 za epizode iz bases.tsv.
//
// Izlaz (TRAJAN, vidi README §Trajni izlaz), po epizodi i alatu:
//   data/output/<kanal>/<base>.exp-20261011.<alat>.dijariziran.srt   [SPEAKER_XX] segmenti
//   data/output/<kanal>/<base>.exp-20261011.<alat>.rijeci.json       vrijeme po riječi (normalizirano)
//   data/output/<kanal>/<base>.exp-20261011.<alat>.meta.json         wall, audio s, $, job id
//   data/output/<kanal>/<base>.exp-20261011_raw/<alat>.json          sirovi odgovor servisa
//
// Ključevi SAMO iz .env.experiments:
//   set -a; . ./.env.experiments; set +a
//   node experiments/2026-10-11-asr-llm/asr_cloud.js --provider deepgram [--id X] [--concurrency 3] [--dry-run]
//   node experiments/2026-10-11-asr-llm/asr_cloud.js --usage      # stanje potrošnje (prije/poslije)
//
// Speechmatics za 2 epizode koje pipeline već ima: preuzima se produkcijski
// .mp3.speechmatics.json (isti config: enhanced, hr, sensitivity 0.5) — nula novih poziva.
const fs = require("fs"), path = require("path");

const EXP = __dirname;
const REPO = path.resolve(EXP, "../..");
const OUT = path.join(EXP, "data/output");
const AUDIO = path.join(EXP, "data/audio");
const TAG = "exp-20261011";

const args = process.argv.slice(2);
function getArg(name, def = null) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : def;
}
const hasFlag = (n) => args.includes(n);

const PROVIDER = getArg("--provider");
const ONLY_ID = getArg("--id");
const CONCURRENCY = parseInt(getArg("--concurrency", "3"), 10);
const FORCE = hasFlag("--force");
const DRY_RUN = hasFlag("--dry-run");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Cjenik (USD po satu zvuka, za procjenu u meta; stvarni trošak = --usage prije/poslije) ───
const PROVIDERS = {
    speechmatics: { alat: "speechmatics-enhanced", usdPerHour: 0.80 },
    deepgram: { alat: "deepgram-nova3", usdPerHour: 0.26 },
    assemblyai: { alat: "assemblyai-universal2", usdPerHour: 0.17 + 0.02 },
};

// ─── Pomoćne ───
function secondsToSrtTimestamp(seconds) {
    const ms = Math.round(seconds * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const rest = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:` +
           `${String(s).padStart(2, "0")},${String(rest).padStart(3, "0")}`;
}

async function httpRetry(url, opts = {}, tries = 4) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url, opts);
            if (res.status === 429 || res.status >= 500) {
                const wait = Math.min(60, 2 ** i * 5);
                console.log(`   ⏳ HTTP ${res.status} (${url.split("?")[0]}) — čekam ${wait}s…`);
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
    throw lastErr || new Error(`${url} nedostupan nakon ${tries} pokušaja`);
}

async function okJson(res, what) {
    const body = await res.text();
    if (!res.ok) throw new Error(`${what}: HTTP ${res.status} — ${body.slice(0, 400)}`);
    return JSON.parse(body);
}

// ─── Normalizirane riječi → segmenti ───
//
// Svaki servis se svodi na [{start, end, text, speaker, punct}], gdje je punct=true samo za
// Speechmaticsovu zasebnu interpunkciju (lijepi se na prethodnu riječ). Deepgram/AssemblyAI
// interpunkciju već nose u riječi. Pravila segmentiranja = transcribe_speechmatics.js, da
// SRT-ovi svih alata budu usporedivi s produkcijskim izlazom.
const SEG_SOFT_MAX_S = 12;
const SEG_HARD_MAX_S = 22;
const SEG_PAUSE_S = 1.2;
const SEG_MIN_S = 2.0;

function buildSegments(words) {
    const speakerMap = new Map();
    const mapSpeaker = (raw) => {
        if (raw == null || raw === "UU") return "UNKNOWN";
        const k = String(raw);
        if (!speakerMap.has(k)) speakerMap.set(k, `SPEAKER_${String(speakerMap.size).padStart(2, "0")}`);
        return speakerMap.get(k);
    };
    const segments = [];
    let cur = null;
    const flush = () => {
        if (!cur) return;
        const text = cur.tokens.join("").replace(/\s+/g, " ").trim();
        if (text) segments.push({ start: cur.start, end: cur.end, speaker: cur.speaker, text });
        cur = null;
    };
    for (const w of words) {
        if (!w.text) continue;
        const speaker = w.punct ? (cur ? cur.speaker : mapSpeaker(w.speaker)) : mapSpeaker(w.speaker);
        if (cur && !w.punct) {
            const gap = w.start - cur.end;
            const dur = cur.end - cur.start;
            const endsSentence = /[.!?…]$/.test(cur.tokens[cur.tokens.length - 1] || "");
            if (speaker !== cur.speaker || dur >= SEG_HARD_MAX_S ||
                (dur >= SEG_SOFT_MAX_S && endsSentence) || (gap >= SEG_PAUSE_S && dur >= SEG_MIN_S)) {
                flush();
            }
        }
        if (!cur) cur = { start: w.start, end: w.end, speaker, tokens: [] };
        cur.tokens.push(cur.tokens.length === 0 || w.punct ? w.text : " " + w.text);
        cur.end = Math.max(cur.end, w.end);
    }
    flush();
    return { segments, speakerCount: speakerMap.size, speakerMap: Object.fromEntries(speakerMap) };
}

function renderSrt(segments) {
    const out = [];
    segments.forEach((seg, i) => {
        out.push(`${i + 1}`,
            `${secondsToSrtTimestamp(seg.start)} --> ${secondsToSrtTimestamp(seg.end)}`,
            `[${seg.speaker}] ${seg.text}`, "");
    });
    return out.join("\n");
}

// ─── Speechmatics ───
const SM_BASE = "https://asr.api.speechmatics.com/v2";
const smAuth = () => ({ Authorization: `Bearer ${process.env.SPEECHMATICS_API_KEY_EXPERIMENT}` });
const SM_CONFIG = {
    type: "transcription",
    transcription_config: {
        language: "hr", operating_point: "enhanced", diarization: "speaker",
        speaker_diarization_config: { speaker_sensitivity: 0.5 },
    },
};

function smWords(json) {
    return (json.results || []).filter((r) => r.type === "word" || r.type === "punctuation").map((r) => {
        const a = (r.alternatives && r.alternatives[0]) || {};
        return {
            start: r.start_time, end: r.end_time, text: a.content || "", speaker: a.speaker,
            punct: r.type === "punctuation" && a.attaches_to !== "next",
        };
    });
}

function findProductionSpeechmatics(id) {
    // Samo 2 referentne epizode; kanal/base iz bases.tsv su produkcijski.
    const ep = EPISODES.find((e) => e.id === id);
    const p = path.join(REPO, "storage/output", ep.kanal, `${ep.base}.mp3.speechmatics.json`);
    return fs.existsSync(p) ? p : null;
}

async function runSpeechmatics(ep, mp3) {
    const prod = findProductionSpeechmatics(ep.id);
    if (prod) {
        const raw = fs.readFileSync(prod, "utf-8");
        const meta = JSON.parse(fs.readFileSync(prod.replace(/\.json$/, ".meta.json"), "utf-8"));
        return {
            raw, words: smWords(JSON.parse(raw)), audioSec: meta.audio_seconds, jobId: meta.job_id,
            note: `preuzeto iz produkcije (${path.relative(REPO, prod)}), izvorni MP3 punog bitratea; nula novih poziva`,
            billed: false, config: meta.submitted_config,
        };
    }
    const form = new FormData();
    form.append("config", JSON.stringify(SM_CONFIG));
    form.append("data_file", new Blob([fs.readFileSync(mp3)]), path.basename(mp3));
    const job = await okJson(await httpRetry(`${SM_BASE}/jobs`, { method: "POST", headers: smAuth(), body: form }), "Speechmatics submit");
    console.log(`   [speechmatics] ${ep.id} job ${job.id}`);
    const deadline = Date.now() + 120 * 60 * 1000;
    let info;
    while (Date.now() < deadline) {
        info = (await okJson(await httpRetry(`${SM_BASE}/jobs/${job.id}`, { headers: smAuth() }), "Speechmatics status")).job;
        if (info.status === "done") break;
        if (["rejected", "expired", "deleted"].includes(info.status)) throw new Error(`Speechmatics ${info.status}: ${JSON.stringify(info.errors || "")}`);
        await sleep(20000);
    }
    if (!info || info.status !== "done") throw new Error(`Speechmatics timeout (job ${job.id})`);
    const res = await httpRetry(`${SM_BASE}/jobs/${job.id}/transcript?format=json-v2`, { headers: smAuth() });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Speechmatics transcript HTTP ${res.status}: ${raw.slice(0, 300)}`);
    return { raw, words: smWords(JSON.parse(raw)), audioSec: info.duration, jobId: job.id, billed: true, config: SM_CONFIG };
}

// ─── Deepgram ───
const DG_PARAMS = {
    model: "nova-3", language: "hr", diarize: "true", punctuate: "true",
    smart_format: "true", utterances: "true",
};

async function runDeepgram(ep, mp3) {
    const qs = new URLSearchParams(DG_PARAMS).toString();
    const res = await httpRetry(`https://api.deepgram.com/v1/listen?${qs}`, {
        method: "POST",
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": "audio/mpeg" },
        body: fs.readFileSync(mp3),
    }, 2);
    const raw = await res.text();
    if (!res.ok) throw new Error(`Deepgram HTTP ${res.status}: ${raw.slice(0, 400)}`);
    const json = JSON.parse(raw);
    const alt = json.results.channels[0].alternatives[0];
    const words = (alt.words || []).map((w) => ({
        start: w.start, end: w.end, text: w.punctuated_word || w.word, speaker: w.speaker, punct: false,
    }));
    return { raw, words, audioSec: json.metadata.duration, jobId: json.metadata.request_id, billed: true, config: DG_PARAMS };
}

// ─── AssemblyAI ───
const AAI_BASE = "https://api.assemblyai.com/v2";
const aaiAuth = () => ({ Authorization: process.env.ASSEMBLYAI_API_KEY });
const AAI_CONFIG = { language_code: "hr", speech_models: ["universal-2"], speaker_labels: true, punctuate: true, format_text: true };

async function runAssemblyAI(ep, mp3) {
    const up = await okJson(await httpRetry(`${AAI_BASE}/upload`, {
        method: "POST", headers: { ...aaiAuth(), "Content-Type": "application/octet-stream" }, body: fs.readFileSync(mp3),
    }), "AssemblyAI upload");
    const job = await okJson(await httpRetry(`${AAI_BASE}/transcript`, {
        method: "POST", headers: { ...aaiAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ audio_url: up.upload_url, ...AAI_CONFIG }),
    }), "AssemblyAI submit");
    console.log(`   [assemblyai] ${ep.id} job ${job.id}`);
    const deadline = Date.now() + 120 * 60 * 1000;
    let t;
    while (Date.now() < deadline) {
        t = await okJson(await httpRetry(`${AAI_BASE}/transcript/${job.id}`, { headers: aaiAuth() }), "AssemblyAI status");
        if (t.status === "completed") break;
        if (t.status === "error") throw new Error(`AssemblyAI error: ${t.error}`);
        await sleep(15000);
    }
    if (!t || t.status !== "completed") throw new Error(`AssemblyAI timeout (job ${job.id})`);
    const words = (t.words || []).map((w) => ({
        start: w.start / 1000, end: w.end / 1000, text: w.text, speaker: w.speaker, punct: false,
    }));
    return { raw: JSON.stringify(t), words, audioSec: t.audio_duration, jobId: job.id, billed: true, config: AAI_CONFIG };
}

const RUNNERS = { speechmatics: runSpeechmatics, deepgram: runDeepgram, assemblyai: runAssemblyAI };

// ─── Epizode ───
const EPISODES = fs.readFileSync(path.join(EXP, "bases.tsv"), "utf8").trim().split("\n").slice(1)
    .map((l) => { const [id, kanal, base] = l.split("\t"); return { id, kanal, base }; });

async function processEpisode(provider, ep) {
    const { alat, usdPerHour } = PROVIDERS[provider];
    const dir = path.join(OUT, ep.kanal);
    const stem = path.join(dir, `${ep.base}.${TAG}.${alat}`);
    const srtPath = `${stem}.dijariziran.srt`;
    if (fs.existsSync(srtPath) && !FORCE) { console.log(`⏭️  [${provider}] ${ep.id} već postoji`); return null; }
    const mp3 = path.join(AUDIO, `${ep.id}.mp3`);
    if (!fs.existsSync(mp3)) throw new Error(`nema ${mp3}`);
    if (DRY_RUN) { console.log(`   [dry-run] ${provider} ${ep.id} → ${path.basename(srtPath)}`); return null; }

    const t0 = Date.now();
    const r = await RUNNERS[provider](ep, mp3);
    const wallSec = (Date.now() - t0) / 1000;
    const { segments, speakerCount, speakerMap } = buildSegments(r.words);

    fs.mkdirSync(path.join(dir, `${ep.base}.${TAG}_raw`), { recursive: true });
    fs.writeFileSync(path.join(dir, `${ep.base}.${TAG}_raw`, `${alat}.json`), r.raw, "utf-8");
    fs.writeFileSync(srtPath, renderSrt(segments), "utf-8");
    // Kompaktno: [start, end, tekst, govornik] — govornik već mapiran na SPEAKER_XX.
    const rijeci = r.words.map((w) => [+w.start.toFixed(3), +w.end.toFixed(3), w.text,
        w.speaker == null || w.speaker === "UU" ? null : speakerMap[String(w.speaker)] || null, w.punct ? 1 : 0]);
    fs.writeFileSync(`${stem}.rijeci.json`, JSON.stringify({
        format: "[start_s, end_s, tekst, govornik, interpunkcija_lijepi_na_prethodnu]", alat, words: rijeci,
    }), "utf-8");
    const meta = {
        alat, provider, video_id: ep.id, job_id: r.jobId, config: r.config, note: r.note || null,
        audio_file: path.relative(EXP, mp3), audio_seconds: r.audioSec,
        wall_seconds: r.billed ? +wallSec.toFixed(1) : null,
        realtime_factor: r.billed && r.audioSec ? +(r.audioSec / wallSec).toFixed(1) : null,
        words: r.words.filter((w) => !w.punct).length, segments: segments.length, speakers: speakerCount,
        billed: r.billed, estimated_usd: r.billed ? +((r.audioSec / 3600) * usdPerHour).toFixed(4) : 0,
        generated_at: new Date().toISOString(),
    };
    fs.writeFileSync(`${stem}.meta.json`, JSON.stringify(meta, null, 2), "utf-8");
    console.log(`✅ [${provider}] ${ep.id} ${(r.audioSec / 60).toFixed(0)} min → ${segments.length} seg, ${speakerCount} govornika, ` +
        `${wallSec.toFixed(0)} s (${meta.realtime_factor}×), ~$${meta.estimated_usd}`);
    return meta;
}

// ─── Potrošnja ───
async function usage() {
    const out = { at: new Date().toISOString() };
    const dgH = { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` };
    const projects = await okJson(await fetch("https://api.deepgram.com/v1/projects", { headers: dgH }), "DG projects");
    const pid = projects.projects[0].project_id;
    out.deepgram_balances = (await okJson(await fetch(`https://api.deepgram.com/v1/projects/${pid}/balances`, { headers: dgH }), "DG balances")).balances;
    out.speechmatics_usage = await okJson(await fetch(`${SM_BASE}/usage?since=2026-10-01&until=2026-12-31`, { headers: smAuth() }), "SM usage");
    const aai = await okJson(await fetch(`${AAI_BASE}/transcript?limit=200&status=completed`, { headers: aaiAuth() }), "AAI list");
    out.assemblyai_completed = aai.transcripts.length;
    console.log(JSON.stringify(out, null, 2));
}

async function main() {
    if (hasFlag("--usage")) return usage();
    if (!RUNNERS[PROVIDER]) { console.error(`--provider ${Object.keys(RUNNERS).join("|")} ili --usage`); process.exit(2); }
    const eps = EPISODES.filter((e) => !ONLY_ID || e.id === ONLY_ID);
    const queue = [...eps];
    const done = [], failed = [];
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
            const ep = queue.shift();
            try { const m = await processEpisode(PROVIDER, ep); if (m) done.push(m); }
            catch (err) { failed.push(ep.id); console.error(`❌ [${PROVIDER}] ${ep.id}: ${err.message}`); }
        }
    }));
    const h = done.reduce((s, m) => s + (m.audio_seconds || 0), 0) / 3600;
    const usd = done.reduce((s, m) => s + m.estimated_usd, 0);
    console.log(`\n[${PROVIDER}] gotovo: ${done.length} ep, ${h.toFixed(2)} h, ~$${usd.toFixed(2)} | neuspjelih: ${failed.length} ${failed.join(" ")}`);
    if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
