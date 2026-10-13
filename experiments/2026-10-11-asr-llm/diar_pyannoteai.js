#!/usr/bin/env node
// Faza 1c: pyannoteAI hosted diarizacija (samo govornici, bez teksta) nad data/audio/{ID}.mp3.
//
// Tok: POST /v1/media/input (media://…) → PUT na presigned URL → POST /v1/diarize → poll /v1/jobs/{id}.
// Rezultat se briše 24 h nakon posla, pa se sirovi odgovor sprema odmah.
//
// Izlaz (TRAJAN), po epizodi:
//   <base>.exp-20261011.pyannoteai-<model>.govornici.json   {exclusive, full, speakers}
//   <base>.exp-20261011.pyannoteai-<model>.meta.json
//   <base>.exp-20261011_raw/pyannoteai-<model>.json
//   + ako postoji Speechmatics prijepis: <base>.exp-20261011.speechmatics-enhanced+pyannoteai-<model>.dijariziran.srt
//     (Speechmatics tekst/segmenti, govornik = najveći overlap — ista logika kao diarize_canary.py)
//
//   set -a; . ./.env.experiments; set +a
//   node experiments/2026-10-11-asr-llm/diar_pyannoteai.js [--model precision-3] [--id X] [--concurrency 3]
const fs = require("fs"), path = require("path");

const EXP = __dirname;
const OUT = path.join(EXP, "data/output");
const AUDIO = path.join(EXP, "data/audio");
const TAG = "exp-20261011";
const API = "https://api.pyannote.ai/v1";

const args = process.argv.slice(2);
function getArg(name, def = null) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : def;
}
const MODEL = getArg("--model", "precision-3");
const ONLY_ID = getArg("--id");
const CONCURRENCY = parseInt(getArg("--concurrency", "3"), 10);
const FORCE = args.includes("--force");
const ALAT = `pyannoteai-${MODEL}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = { Authorization: `Bearer ${process.env.PYANNOTEAI_API_KEY}` };

async function call(url, opts = {}, tries = 5) {
    for (let i = 0; ; i++) {
        const res = await fetch(url, { ...opts, headers: { ...auth, "Content-Type": "application/json", ...(opts.headers || {}) } });
        const body = await res.text();
        if ((res.status === 429 || res.status >= 500) && i < tries - 1) {
            await sleep(Math.min(60, 2 ** i * 5) * 1000);
            continue;
        }
        if (!res.ok) throw new Error(`${url.replace(API, "")}: HTTP ${res.status} — ${body.slice(0, 400)}`);
        return body ? JSON.parse(body) : {};
    }
}

function secondsToSrtTimestamp(seconds) {
    const ms = Math.round(seconds * 1000);
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

function parseSrt(text) {
    return text.trim().split(/\n\n+/).map((b) => {
        const lines = b.split("\n");
        const m = (lines[1] || "").match(/(\d+):(\d+):(\d+)[,.](\d+) --> (\d+):(\d+):(\d+)[,.](\d+)/);
        if (!m) return null;
        const t = (h, mi, s, ms) => +h * 3600 + +mi * 60 + +s + +ms / 1000;
        return { start: t(m[1], m[2], m[3], m[4]), end: t(m[5], m[6], m[7], m[8]),
                 text: lines.slice(2).join(" ").replace(/^\[\w+\]\s*/, "") };
    }).filter(Boolean);
}

function assignSpeakers(segs, turns) {
    return segs.map((seg) => {
        let best = "UNKNOWN", bestOv = 0;
        for (const t of turns) {
            const ov = Math.min(seg.end, t.end) - Math.max(seg.start, t.start);
            if (ov > bestOv) { bestOv = ov; best = t.speaker; }
        }
        return { ...seg, speaker: best };
    });
}

async function processEpisode(ep) {
    const dir = path.join(OUT, ep.kanal);
    const stem = path.join(dir, `${ep.base}.${TAG}.${ALAT}`);
    if (fs.existsSync(`${stem}.govornici.json`) && !FORCE) { console.log(`⏭️  ${ep.id} već postoji`); return null; }
    const mp3 = path.join(AUDIO, `${ep.id}.mp3`);
    const t0 = Date.now();

    const mediaUrl = `media://exp20261011-${ep.id.replace(/[^A-Za-z0-9]/g, "")}`;
    const { url: putUrl } = await call(`${API}/media/input`, { method: "POST", body: JSON.stringify({ url: mediaUrl }) });
    const put = await fetch(putUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: fs.readFileSync(mp3) });
    if (!put.ok) throw new Error(`upload HTTP ${put.status}: ${(await put.text()).slice(0, 300)}`);
    const tUp = (Date.now() - t0) / 1000;

    const req = { url: mediaUrl, model: MODEL, exclusive: true };
    const job = await call(`${API}/diarize`, { method: "POST", body: JSON.stringify(req) });
    console.log(`   [pyannoteai] ${ep.id} job ${job.jobId}${job.warning ? " ⚠️ " + job.warning : ""}`);
    let r;
    const deadline = Date.now() + 90 * 60 * 1000;
    while (Date.now() < deadline) {
        r = await call(`${API}/jobs/${job.jobId}`);
        if (r.status === "succeeded") break;
        if (r.status === "failed" || r.status === "canceled") throw new Error(`job ${r.status}: ${JSON.stringify(r).slice(0, 400)}`);
        await sleep(10000);
    }
    if (!r || r.status !== "succeeded") throw new Error(`timeout (job ${job.jobId})`);
    const wallSec = (Date.now() - t0) / 1000;

    fs.mkdirSync(path.join(dir, `${ep.base}.${TAG}_raw`), { recursive: true });
    fs.writeFileSync(path.join(dir, `${ep.base}.${TAG}_raw`, `${ALAT}.json`), JSON.stringify(r), "utf-8");
    const o = r.output || {};
    const norm = (arr) => (arr || []).map((x) => ({ start: x.start, end: x.end, speaker: x.speaker }));
    const exclusive = norm(o.exclusiveDiarization), full = norm(o.diarization);
    const speakers = new Set((exclusive.length ? exclusive : full).map((x) => x.speaker)).size;
    fs.writeFileSync(`${stem}.govornici.json`, JSON.stringify({ alat: ALAT, exclusive, full, speakers }), "utf-8");

    // Speechmatics tekst + pyannoteAI govornici → usporediv dijariziran.srt
    const smSrt = path.join(dir, `${ep.base}.${TAG}.speechmatics-enhanced.dijariziran.srt`);
    let merged = false;
    if (fs.existsSync(smSrt) && (exclusive.length || full.length)) {
        const segs = assignSpeakers(parseSrt(fs.readFileSync(smSrt, "utf-8")), exclusive.length ? exclusive : full);
        fs.writeFileSync(`${dir}/${ep.base}.${TAG}.speechmatics-enhanced+${ALAT}.dijariziran.srt`,
            segs.map((s, i) => `${i + 1}\n${secondsToSrtTimestamp(s.start)} --> ${secondsToSrtTimestamp(s.end)}\n[${s.speaker}] ${s.text}\n`).join("\n"), "utf-8");
        merged = true;
    }
    const audioEnd = Math.max(0, ...full.map((x) => x.end), ...exclusive.map((x) => x.end));
    const meta = { alat: ALAT, video_id: ep.id, job_id: job.jobId, request: req, upload_s: +tUp.toFixed(1),
        wall_seconds: +wallSec.toFixed(1), last_turn_end_s: +audioEnd.toFixed(1), turns_exclusive: exclusive.length,
        turns_full: full.length, speakers, merged_with_speechmatics: merged, warning: job.warning || null,
        generated_at: new Date().toISOString() };
    fs.writeFileSync(`${stem}.meta.json`, JSON.stringify(meta, null, 2), "utf-8");
    console.log(`✅ [pyannoteai] ${ep.id} ${speakers} govornika, ${exclusive.length} okreta, ${wallSec.toFixed(0)} s (upload ${tUp.toFixed(0)} s)`);
    return meta;
}

async function main() {
    const eps = fs.readFileSync(path.join(EXP, "bases.tsv"), "utf8").trim().split("\n").slice(1)
        .map((l) => { const [id, kanal, base] = l.split("\t"); return { id, kanal, base }; })
        .filter((e) => !ONLY_ID || e.id === ONLY_ID);
    const queue = [...eps], failed = [];
    let ok = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
            const ep = queue.shift();
            try { if (await processEpisode(ep)) ok++; }
            catch (err) { failed.push(ep.id); console.error(`❌ [pyannoteai] ${ep.id}: ${err.message}`); }
        }
    }));
    console.log(`\n[pyannoteai ${MODEL}] gotovo: ${ok} | neuspjelih: ${failed.length} ${failed.join(" ")}`);
    if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
