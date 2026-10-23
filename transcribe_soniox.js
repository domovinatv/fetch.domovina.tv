#!/usr/bin/env node
/**
 * transcribe_soniox.js — cloud transkripcija + diarizacija preko Soniox async API-ja
 * (stt-async-v5), uz Speechmatics kao fallback. Varijanta KORAKA 2.7.
 *
 * ZAŠTO: u adria-analytics (NEWS-1034) Soniox je na hrvatskom pobijedio Speechmatics u
 * 86 % slijepo preslušanih mjesta razlike, a stoji ~$0,12/h prema $0,45–0,80/h.
 * Govornike Soniox SPAJA (26 → 6), pa se za govornike koristi pyannoteAI
 * (diarize_pyannote_ai.js), a Sonioxove oznake su samo pomoćne.
 * Plan i mjerenja: docs/2026-10-24-soniox-pyannote-roadmap.md.
 *
 * ⚠️ ODVOJEN NAMESPACE — izlaz NIKAD ne kolidira s produkcijom:
 *      {audio}.soniox.json           (sirovi transkript, tokeni — za recovery i mjerenja)
 *      {audio}.soniox.words.json     (normalizirane riječi, lib/asr/words.js format)
 *      {audio}.soniox.srt            (bez oznaka govornika ≈ .canary.srt)
 *      {audio}.soniox.diarized.srt   ([SPEAKER_XX] po Sonioxu — NE kanonski)
 *      {audio}.soniox.meta.json      (job, trajanje, trošak; postoji i kad je radio fallback)
 *   Kad Soniox padne, isti zvuk ide na Speechmatics i piše se .speechmatics.* (isti oblik
 *   kao transcribe_speechmatics.js), a .soniox.meta.json bilježi `provider: "speechmatics"`
 *   i razlog — da idući run ne plati isto dvaput.
 *
 * Ključevi: SONIOX_API_KEY, (fallback) SPEECHMATICS_API_KEY u .env.
 *
 * Primjeri:
 *   node transcribe_soniox.js --file storage/output/kanal/ep.mp3
 *   node transcribe_soniox.js --channel muzevni_budite --video-id f2HIRJPHHK4
 *   node transcribe_soniox.js --input-dir storage/output --fresh-days 3 --limit 5
 *   node transcribe_soniox.js --file ep.mp3 --no-fallback
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const soniox = require("./lib/asr/soniox");
const speechmatics = require("./lib/asr/speechmatics");
const { sonioxToWords, speechmaticsToWords, buildSegments, renderSrt } = require("./lib/asr/words");
const { writeManifest, baseFromAudio } = require("./lib/processing_manifest");

// ─── .env loader (isti minimalni obrazac kao ostatak repoa) ───
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

// ─── CLI (Pattern B) ───
const args = process.argv.slice(2);
function getArg(name, def = null) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : def;
}
const hasFlag = (name) => args.includes(name);

const FILE = getArg("--file");
const INPUT_DIR = getArg("--input-dir", "storage/output");
const CHANNEL = getArg("--channel");
const VIDEO_ID = getArg("--video-id");
const LIMIT = parseInt(getArg("--limit", "1"), 10);
const LANGUAGE = getArg("--language", "hr");
const FORCE = hasFlag("--force");
const DRY_RUN = hasFlag("--dry-run");
const NO_FALLBACK = hasFlag("--no-fallback");
const POLL_S = parseInt(getArg("--poll-seconds", "10"), 10);
// Prozor svježine u danima; 0 = bez ograničenja. Financijska ograda kao u 2.7.
const FRESH_DAYS = parseInt(getArg("--fresh-days", "0"), 10);
const TIMEOUT_MIN = parseInt(getArg("--timeout-minutes", "90"), 10);

const SONIOX_USD_PER_HOUR = parseFloat(process.env.SONIOX_USD_PER_HOUR || "0.12");
const SM_USD_PER_HOUR = parseFloat(process.env.SPEECHMATICS_USD_PER_HOUR || "0.80");

const SX = { json: ".soniox.json", words: ".soniox.words.json", srt: ".soniox.srt", dia: ".soniox.diarized.srt", meta: ".soniox.meta.json" };
const SM = { json: ".speechmatics.json", srt: ".speechmatics.srt", dia: ".speechmatics.diarized.srt", meta: ".speechmatics.meta.json" };

function fmtDur(seconds) {
    const s = Math.round(seconds);
    return `${String(Math.floor(s / 3600)).padStart(2, "0")}:` +
           `${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:` +
           `${String(s % 60).padStart(2, "0")}`;
}

function probeSeconds(audioPath) {
    try {
        const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audioPath],
            { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
        const s = parseFloat(out.trim());
        return Number.isFinite(s) ? s : null;
    } catch { return null; }
}

// ─── Izvorni jezik po kanalu (automatic/channel_languages.conf, kao KORAK 2.6/2.7) ───
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

function writeOutputs(audioPath, names, words) {
    const { segments, speakerCount } = buildSegments(words);
    fs.writeFileSync(audioPath + names.srt, renderSrt(segments, false), "utf-8");
    fs.writeFileSync(audioPath + names.dia, renderSrt(segments, true), "utf-8");
    return { segments, speakerCount };
}

async function runSpeechmatics(audioPath, language, reason) {
    const sm = speechmatics.client(process.env.SPEECHMATICS_API_KEY);
    const t0 = Date.now();
    const { raw, json, job, config, jobId } = await sm.transcribeFile(audioPath, { language, timeoutMinutes: TIMEOUT_MIN });
    fs.writeFileSync(audioPath + SM.json, raw, "utf-8");
    const words = speechmaticsToWords(json);
    const { segments, speakerCount } = writeOutputs(audioPath, SM, words);
    const audioSec = job.duration != null ? job.duration : (segments.length ? segments[segments.length - 1].end : 0);
    const wallSec = (Date.now() - t0) / 1000;
    const meta = {
        provider: "speechmatics", fallback_from: "soniox", fallback_reason: reason,
        job_id: jobId, submitted_config: config, audio_file: path.basename(audioPath),
        audio_seconds: audioSec, wall_seconds: +wallSec.toFixed(1),
        realtime_factor: audioSec ? +(audioSec / wallSec).toFixed(2) : null,
        segments: segments.length, speakers: speakerCount,
        estimated_usd: +((audioSec / 3600) * SM_USD_PER_HOUR).toFixed(4),
        generated_at: new Date().toISOString(),
    };
    fs.writeFileSync(audioPath + SM.meta, JSON.stringify(meta, null, 2), "utf-8");
    return meta;
}

async function processFile(audioPath) {
    if (fs.existsSync(audioPath + SX.meta) && !FORCE) {
        console.log(`⏭️  Već postoji ${path.basename(audioPath + SX.meta)} (--force za ponavljanje).`);
        return { skipped: true };
    }
    const language = languageForPath(audioPath);
    const probed = probeSeconds(audioPath);
    const sizeMb = fs.statSync(audioPath).size / 1048576;
    console.log(`\n🎙️  ${path.basename(audioPath)}  (${sizeMb.toFixed(1)} MB, ${probed ? fmtDur(probed) : "?"}, ${language})`);
    if (DRY_RUN) {
        const est = probed ? ` ~$${((probed / 3600) * SONIOX_USD_PER_HOUR).toFixed(3)}` : "";
        console.log(`   ⚠️ DRY RUN — ne šaljem ništa.${est}`);
        return { skipped: true };
    }

    const t0 = Date.now();
    let reason = null;
    if (probed && probed > soniox.MAX_AUDIO_SECONDS) {
        reason = `zvuk ${fmtDur(probed)} > Soniox limit 300 min`;
    } else {
        try {
            const sx = soniox.client(process.env.SONIOX_API_KEY);
            const { transcript, job, config, transcriptionId } = await sx.transcribeFile(audioPath, {
                language, pollSeconds: POLL_S, timeoutMinutes: TIMEOUT_MIN,
            });
            fs.writeFileSync(audioPath + SX.json, JSON.stringify(transcript), "utf-8");
            const words = sonioxToWords(transcript);
            fs.writeFileSync(audioPath + SX.words, JSON.stringify({ v: 1, source: "soniox", model: soniox.MODEL, words }), "utf-8");
            const { segments, speakerCount } = writeOutputs(audioPath, SX, words);
            const audioSec = job.audio_duration_ms != null ? job.audio_duration_ms / 1000 : (probed || 0);
            const wallSec = (Date.now() - t0) / 1000;
            const meta = {
                provider: "soniox", model: soniox.MODEL, job_id: transcriptionId, submitted_config: config,
                audio_file: path.basename(audioPath), audio_seconds: audioSec,
                wall_seconds: +wallSec.toFixed(1), realtime_factor: audioSec ? +(audioSec / wallSec).toFixed(2) : null,
                words: words.filter((w) => !w.punct).length, segments: segments.length, speakers: speakerCount,
                est_usd: +((audioSec / 3600) * SONIOX_USD_PER_HOUR).toFixed(4),
                remote_deleted: true,
                generated_at: new Date().toISOString(),
            };
            fs.writeFileSync(audioPath + SX.meta, JSON.stringify(meta, null, 2), "utf-8");
            console.log(`   ✅ Soniox: ${meta.words} riječi, ${segments.length} segmenata, ${speakerCount} govornika | ` +
                `zvuk ${fmtDur(audioSec)}, obrada ${fmtDur(wallSec)} (${meta.realtime_factor}×) | ~$${meta.est_usd}`);
            return { ok: true, meta };
        } catch (err) {
            reason = err.message;
            console.log(`   ⚠️ Soniox nije uspio: ${reason}`);
        }
    }

    if (NO_FALLBACK || !process.env.SPEECHMATICS_API_KEY) {
        throw new Error(`Soniox: ${reason} (fallback ${NO_FALLBACK ? "isključen" : "nema SPEECHMATICS_API_KEY"})`);
    }
    console.log(`   ↪️  Fallback na Speechmatics (${reason})`);
    const sm = await runSpeechmatics(audioPath, language, reason);
    fs.writeFileSync(audioPath + SX.meta, JSON.stringify({
        provider: "speechmatics", fallback_reason: reason, speechmatics_job_id: sm.job_id,
        audio_file: path.basename(audioPath), audio_seconds: sm.audio_seconds,
        est_usd: sm.estimated_usd, generated_at: sm.generated_at,
    }, null, 2), "utf-8");
    console.log(`   ✅ Speechmatics: ${sm.segments} segmenata, ${sm.speakers} govornika | ~$${sm.estimated_usd}`);
    return { ok: true, meta: sm };
}

// ─── Odabir datoteka (isti kao transcribe_speechmatics.js: mp3 > m4a > … > wav) ───
const FORMAT_RANK = { ".mp3": 0, ".m4a": 1, ".opus": 2, ".ogg": 3, ".flac": 4, ".wav": 5 };
const ORPHAN_FRAGMENT = /\.f\d{2,4}\.[a-z0-9]+$/i;   // yt-dlp .f396.mp4 ostaci

function collectCandidates() {
    if (FILE) return [FILE];
    const root = path.resolve(INPUT_DIR);
    const channels = CHANNEL
        ? [CHANNEL]
        : fs.readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory() || e.isSymbolicLink())
            .map((e) => e.name);

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
            // „Gotovo” je svojstvo EPIZODE: obrađena preko .mp3 ne smije se ponuditi kao .wav.
            if (fs.existsSync(path.join(dir, f + SX.meta))) { done.add(key); continue; }
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
    return pool.sort((a, b) => b.mtime - a.mtime).slice(0, LIMIT).map((x) => x.p);
}

(async () => {
    if (!process.env.SONIOX_API_KEY) {
        console.error("❌ Nema SONIOX_API_KEY (.env). Izlazim.");
        process.exit(1);
    }
    const targets = collectCandidates();
    if (targets.length === 0) {
        console.log("✅ Nema kandidata za Soniox transkripciju.");
        return;
    }
    console.log(`📋 Kandidata: ${targets.length}`);
    let ok = 0, fail = 0;
    for (const t of targets) {
        try {
            const r = await processFile(t);
            if (r.ok) {
                ok++;
                writeManifest(path.dirname(t), baseFromAudio(t));
            }
        } catch (err) {
            fail++;
            console.error(`   ❌ ${path.basename(t)}: ${err.message}`);
        }
    }
    console.log(`\n📊 Uspješnih: ${ok} | Neuspjelih: ${fail}`);
    if (fail > 0) process.exit(1);
})();
