#!/usr/bin/env node
/**
 * diarize_pyannote_ai.js — cloud diarizacija preko pyannoteAI API-ja (precision-3) i
 * hibrid s riječima iz cloud ASR-a (Soniox, inače Speechmatics).
 *
 * ZAŠTO: Soniox govornike SPAJA (26 → 6), Speechmatics ih RAZBIJA (5 → 17). Uz pyannoteAI
 * oba daju 98,2 % istih govornika po riječima (adria-analytics, 5,2 h, 19 snimki). Ovo je
 * cloud zamjena za lokalni pyannote (KORAK 6) — Mac više nije nužan za diarizaciju.
 * Port `e-satnica-sastanci/scripts/pyannote.sh` + `prep_kostur.py` (relabel_pyannote).
 *
 * Tok: POST /v1/media/input {url: media://…} → PUT na potpisani URL → POST /v1/diarize
 *      {model: precision-3, exclusive: true} → poll GET /v1/jobs/{id} (succeeded|failed|canceled).
 *      pyannoteAI briše izlaz 24 h nakon posla, pa ga spremamo odmah.
 *
 * ⚠️ ODVOJEN NAMESPACE — ništa ne promovira u kanonski .wav.canary.diarized.srt:
 *      {audio}.pyannote_ai.json                     (sirovi job: diarization + exclusiveDiarization)
 *      {audio}.pyannote_ai.meta.json                (job, model, trajanje, trošak)
 *      {audio}.{soniox|speechmatics}_pyannote.diarized.srt   (hibrid, isti format kao canary)
 *      {audio}.{soniox|speechmatics}_pyannote.words.json     (riječi s pyannote govornikom)
 *   Hibrid se piše samo kad postoji izvor riječi (.soniox.words.json ili .speechmatics.json);
 *   bez njega se samo diarizira, a hibrid se složi idući put (nula API poziva).
 *
 * Ključ: PYANNOTE_API_KEY u .env.
 *
 * Primjeri:
 *   node diarize_pyannote_ai.js --channel muzevni_budite --video-id f2HIRJPHHK4
 *   node diarize_pyannote_ai.js --file ep.mp3 --num-speakers 2
 *   node diarize_pyannote_ai.js --channel muzevni_budite --video-id f2HIRJPHHK4 --hybrid-only
 *   node diarize_pyannote_ai.js … --hybrid-only --words-from speechmatics   # Speechmatics+pyannote kostur
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { sonioxToWords, speechmaticsToWords, buildSegments, renderSrt } = require("./lib/asr/words");
const { pyannoteSegments, assignSpeakers } = require("./lib/asr/hybrid");
const { writeManifest, baseFromAudio } = require("./lib/processing_manifest");

function loadEnv() {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
}
loadEnv();

const args = process.argv.slice(2);
function getArg(name, def = null) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : def;
}
const hasFlag = (name) => args.includes(name);

const API = process.env.PYANNOTE_API_BASE || "https://api.pyannote.ai/v1";
const API_KEY = process.env.PYANNOTE_API_KEY;
const FILE = getArg("--file");
const INPUT_DIR = getArg("--input-dir", "storage/output");
const CHANNEL = getArg("--channel");
const VIDEO_ID = getArg("--video-id");
const LIMIT = parseInt(getArg("--limit", "1"), 10);
const MODEL = getArg("--model", "precision-3");
const NUM_SPEAKERS = getArg("--num-speakers");
const FRESH_DAYS = parseInt(getArg("--fresh-days", "0"), 10);
const TIMEOUT_MIN = parseInt(getArg("--timeout-minutes", "60"), 10);
const POLL_S = parseInt(getArg("--poll-seconds", "15"), 10);
const FORCE = hasFlag("--force");
const DRY_RUN = hasFlag("--dry-run");
const HYBRID_ONLY = hasFlag("--hybrid-only");
// Izvor riječi za hibrid: auto (Soniox pa Speechmatics) | soniox | speechmatics.
const WORDS_FROM = getArg("--words-from", "auto");
// pyannoteAI precision batch ≈ €0,11/h; samo za procjenu u logu.
const USD_PER_HOUR = parseFloat(process.env.PYANNOTE_USD_PER_HOUR || "0.13");

const SUFFIX_JSON = ".pyannote_ai.json";
const SUFFIX_META = ".pyannote_ai.meta.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
    let lastErr;
    for (let i = 0; i < 4; i++) {
        try {
            const res = await fetch(API + url, {
                method,
                headers: { Authorization: `Bearer ${API_KEY}`, ...(body ? { "Content-Type": "application/json" } : {}) },
                body: body ? JSON.stringify(body) : undefined,
            });
            if (res.status === 429 || res.status >= 500) {
                const wait = Math.min(60, 2 ** i * 5);
                console.log(`   ⏳ pyannoteAI HTTP ${res.status} — čekam ${wait}s…`);
                await sleep(wait * 1000);
                continue;
            }
            const text = await res.text();
            if (!res.ok) throw Object.assign(new Error(`pyannoteAI ${method} ${url}: HTTP ${res.status} — ${text.slice(0, 300)}`), { fatal: true });
            return JSON.parse(text);
        } catch (err) {
            if (err.fatal) throw err;
            lastErr = err;
            await sleep(Math.min(60, 2 ** i * 5) * 1000);
        }
    }
    throw lastErr || new Error("pyannoteAI nedostupan");
}

async function diarize(audioPath) {
    // media:// ključ je u prostoru našeg računa; ime datoteke je već sanitizirano.
    const key = `media://domovina/${path.basename(audioPath)}`;
    const { url: putUrl } = await api("POST", "/media/input", { url: key });
    const put = await fetch(putUrl, {
        method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: fs.readFileSync(audioPath),
    });
    if (!put.ok) throw new Error(`pyannoteAI upload: HTTP ${put.status}`);
    const body = { url: key, model: MODEL, exclusive: true };
    if (NUM_SPEAKERS) body.numSpeakers = parseInt(NUM_SPEAKERS, 10);
    const { jobId, warning } = await api("POST", "/diarize", body);
    console.log(`   ⬆️  pyannoteAI posao ${jobId}${warning ? ` (⚠️ ${warning})` : ""}`);
    const deadline = Date.now() + TIMEOUT_MIN * 60 * 1000;
    let last = "";
    for (;;) {
        const job = await api("GET", `/jobs/${jobId}`);
        if (job.status !== last) { console.log(`   📡 status: ${job.status}`); last = job.status; }
        if (job.status === "succeeded") return { job, body };
        if (job.status === "failed" || job.status === "canceled") throw new Error(`pyannoteAI posao ${jobId}: ${job.status}`);
        if (Date.now() > deadline) throw new Error(`pyannoteAI timeout nakon ${TIMEOUT_MIN} min (posao ${jobId})`);
        await sleep(POLL_S * 1000);
    }
}

/** Izvor riječi za hibrid: Soniox ima prednost (bolji tekst), inače Speechmatics. */
function wordSource(audioPath) {
    if (WORDS_FROM === "speechmatics") {
        const sm = audioPath + ".speechmatics.json";
        return fs.existsSync(sm) ? { name: "speechmatics", words: speechmaticsToWords(JSON.parse(fs.readFileSync(sm, "utf-8"))) } : null;
    }
    const sx = audioPath + ".soniox.words.json";
    if (fs.existsSync(sx)) return { name: "soniox", words: JSON.parse(fs.readFileSync(sx, "utf-8")).words };
    const sxRaw = audioPath + ".soniox.json";
    if (fs.existsSync(sxRaw)) return { name: "soniox", words: sonioxToWords(JSON.parse(fs.readFileSync(sxRaw, "utf-8"))) };
    const sm = audioPath + ".speechmatics.json";
    if (WORDS_FROM === "auto" && fs.existsSync(sm)) return { name: "speechmatics", words: speechmaticsToWords(JSON.parse(fs.readFileSync(sm, "utf-8"))) };
    return null;
}

function writeHybrid(audioPath) {
    const src = wordSource(audioPath);
    if (!src) { console.log("   ⏭️  Nema izvora riječi (.soniox.* / .speechmatics.json) — hibrid preskočen."); return null; }
    const job = JSON.parse(fs.readFileSync(audioPath + SUFFIX_JSON, "utf-8"));
    const segs = pyannoteSegments(job);
    const words = assignSpeakers(src.words, segs);
    const { segments, speakerCount } = buildSegments(words);
    const prefix = `${audioPath}.${src.name}_pyannote`;
    fs.writeFileSync(prefix + ".diarized.srt", renderSrt(segments, true), "utf-8");
    fs.writeFileSync(prefix + ".words.json", JSON.stringify({ v: 1, source: `${src.name}+pyannote_ai`, words }), "utf-8");
    console.log(`   🧩 hibrid ${src.name}+pyannote: ${segments.length} segmenata, ${speakerCount} govornika → ${path.basename(prefix)}.diarized.srt`);
    return { source: src.name, segments: segments.length, speakers: speakerCount };
}

async function processFile(audioPath) {
    const have = fs.existsSync(audioPath + SUFFIX_JSON);
    console.log(`\n🗣️  ${path.basename(audioPath)}`);
    if (have && !FORCE) {
        console.log(`   ⏭️  ${path.basename(audioPath + SUFFIX_JSON)} već postoji — samo hibrid.`);
    } else if (HYBRID_ONLY) {
        console.log("   ⏭️  --hybrid-only, a nema pyannote izlaza — preskačem.");
        return { skipped: true };
    } else if (DRY_RUN) {
        console.log("   ⚠️ DRY RUN — ne šaljem ništa na pyannoteAI.");
        return { skipped: true };
    } else {
        const t0 = Date.now();
        const { job, body } = await diarize(audioPath);
        fs.writeFileSync(audioPath + SUFFIX_JSON, JSON.stringify(job), "utf-8");
        const segs = pyannoteSegments(job);
        const audioSec = segs.length ? Math.max(...segs.map((s) => s.end)) : 0;
        const meta = {
            provider: "pyannote_ai", model: MODEL, job_id: job.jobId || null, submitted: body,
            audio_file: path.basename(audioPath), speech_end_seconds: +audioSec.toFixed(1),
            segments: segs.length, speakers: new Set(segs.map((s) => s.speaker)).size,
            wall_seconds: +((Date.now() - t0) / 1000).toFixed(1),
            est_usd: +((audioSec / 3600) * USD_PER_HOUR).toFixed(4),
            generated_at: new Date().toISOString(),
        };
        fs.writeFileSync(audioPath + SUFFIX_META, JSON.stringify(meta, null, 2), "utf-8");
        console.log(`   ✅ pyannoteAI ${MODEL}: ${meta.segments} segmenata, ${meta.speakers} govornika | ~$${meta.est_usd}`);
    }
    if (DRY_RUN) return { skipped: true };
    writeHybrid(audioPath);
    return { ok: true };
}

// ─── Odabir datoteka (mp3 > m4a > … > wav), kao transcribe_soniox.js ───
const FORMAT_RANK = { ".mp3": 0, ".m4a": 1, ".opus": 2, ".ogg": 3, ".flac": 4, ".wav": 5 };
const ORPHAN_FRAGMENT = /\.f\d{2,4}\.[a-z0-9]+$/i;

function collectCandidates() {
    if (FILE) return [FILE];
    const root = path.resolve(INPUT_DIR);
    const channels = CHANNEL
        ? [CHANNEL]
        : fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
    const byEpisode = new Map();
    const done = new Set();
    for (const ch of channels) {
        const dir = path.join(root, ch);
        let files;
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
            if (f.startsWith("._") || ORPHAN_FRAGMENT.test(f)) continue;
            if (VIDEO_ID && !f.includes(`_yt_${VIDEO_ID}`)) continue;
            const ext = path.extname(f).toLowerCase();
            const rank = FORMAT_RANK[ext];
            if (rank === undefined) continue;
            const key = path.join(ch, f.slice(0, -ext.length));
            // Uz --hybrid-only „gotovo” ne vrijedi — upravo tražimo epizode s pyannote izlazom.
            if (!HYBRID_ONLY && fs.existsSync(path.join(dir, f + SUFFIX_JSON))) { done.add(key); continue; }
            // Kao transcribe_soniox.js: epizoda s kanonskim prijepisom ne treba govornike (31.10.2026.).
            if (!VIDEO_ID && !HYBRID_ONLY && fs.existsSync(path.join(dir, f.slice(0, -ext.length) + ".wav.canary.diarized.srt"))) {
                done.add(key); continue;
            }
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
        pool = pool.filter((x) => x.mtime >= cutoff);
    }
    // Najstarije prvo, kao transcribe_soniox.js: ispala epizoda nema lokalnu diarizaciju kao rezervu.
    return pool.sort((a, b) => a.mtime - b.mtime).slice(0, LIMIT).map((x) => x.p);
}

(async () => {
    if (!API_KEY && !HYBRID_ONLY) {
        console.error("❌ Nema PYANNOTE_API_KEY (.env). Izlazim.");
        process.exit(1);
    }
    const targets = collectCandidates();
    if (!targets.length) { console.log("✅ Nema kandidata za pyannoteAI."); return; }
    console.log(`📋 Kandidata: ${targets.length} (model ${MODEL})`);
    let ok = 0, fail = 0;
    for (const t of targets) {
        try {
            if ((await processFile(t)).ok) {
                ok++;
                writeManifest(path.dirname(t), baseFromAudio(t));
            }
        } catch (err) { fail++; console.error(`   ❌ ${path.basename(t)}: ${err.message}`); }
    }
    console.log(`\n📊 Uspješnih: ${ok} | Neuspjelih: ${fail}`);
    if (fail > 0) process.exit(1);
})();
