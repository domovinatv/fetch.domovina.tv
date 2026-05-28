#!/usr/bin/env node
/**
 * normalize_loudness.js
 *
 * FAZA 2 obrade glasnoće: two-pass EBU R128 `loudnorm` normalizacija na ciljni
 * integrated LUFS. Radi nad PRAVIM full-band izvorom, ne nad 16kHz mono .wav-om
 * (taj je samo transkripcijski intermediate; ovdje je apsolutni target točan).
 *
 * PRODUKCIJSKI DIZAJN — SINGLE-PASS dynamic loudnorm + fanout u jednom ffmpeg-u:
 *   - Audio izvor = NAJBOLJI dostupni (mkv = originalni Opus passthrough > mp4 aac
 *     > mp3), da se izbjegne dvostruki generacijski gubitak.
 *   - JEDAN ffmpeg s `loudnorm,asplit` normalizira i fanout-a ISTI normalizirani
 *     audio u sve tražene isporučne formate odjednom:
 *        - {basename}.loudnorm.mp3   (libmp3lame, bitrate usklađen s originalom)
 *        - {basename}.loudnorm.mp4   (VIDEO kopiran -c:v copy, audio aac; +faststart)
 *   - Dinamički mod (linear=false, default) ima ugrađen TRUE-PEAK limiter — pouzdano
 *     pogađa I (±~0.5 LU) i TP, siguran od klipanja kod velikih pojačanja (+10..+26
 *     dB) koja naš pretihi katalog traži. `--linear` forsira transparentni konstantni
 *     gain BEZ limitera (samo za već glasan materijal — inače klipa).
 *
 * NAPOMENA: two-pass measured_* put je namjerno ODBAČEN — loudnorm tada primijeni
 * linearni gain i ignorira TP limiter pa klipa (empirijski potvrđeno: TP +0.4 dBTP
 * na tihom izvoru). Single-pass dynamic to rješava i upola je brži.
 *
 * IZLAZ SU NOVE DATOTEKE uz original — original se NIKAD ne prepisuje, pa se
 * original i popravljena verzija mogu A/B preslušati prije usvajanja.
 * Sidecar {basename}.loudnorm.json drži before/after mjerenja + parametre.
 *
 * Idempotentno: preskače format čiji izlaz već postoji (osim --force).
 *
 * Usage:
 *   node normalize_loudness.js                                   # cijeli storage/output, mp3
 *   node normalize_loudness.js --formats mp3,mp4 --channel domovina_tv
 *   node normalize_loudness.js --base 20260326_002_zadruge --formats mp3,mp4 --verify
 *   node normalize_loudness.js --audio-source mkv --concurrency 4
 *   node normalize_loudness.js --target -16 --tp -1.5 --lra 11
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

function getArg(name, def = null) {
    const idx = process.argv.indexOf(name);
    return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : def;
}
const hasFlag = (name) => process.argv.includes(name);

const INPUT_DIR = getArg("--input-dir", "storage/output");
const ONLY_CHANNEL = getArg("--channel", null);
const ONLY_BASE = getArg("--base", null);
const LIMIT = parseInt(getArg("--limit", "0"), 10);
const FORCE = hasFlag("--force");
const VERIFY = hasFlag("--verify");
const TARGET_I = parseFloat(getArg("--target", "-16"));
// -2 dBTP (ne -1) jer lossy enkoderi (osobito nizak-bitrate mp3) podižu true peak
// ~0.4–1.6 dB nakon loudnorm-a → ostavljamo headroom da izlaz ne klipa.
const TARGET_TP = parseFloat(getArg("--tp", "-2"));
const TARGET_LRA = parseFloat(getArg("--lra", "11"));
// linear=true = transparentan konstantni gain ALI bez true-peak limitera → klipa
// kod velikih pojačanja (naš katalog je pretih, treba +10..+26 dB). Default je
// dinamički mod (linear=false) koji ima TP limiter i pouzdano pogađa I i TP.
const LINEAR = hasFlag("--linear");
const FORMATS = (getArg("--formats", "mp3")).split(",").map((s) => s.trim()).filter(Boolean);
// Prioritet audio izvora za loudnorm (najbolja kvaliteta prvo). auto = mkv>mp4>mp3.
const AUDIO_SOURCE = getArg("--audio-source", "auto");
const SUFFIX = getArg("--suffix", "loudnorm");
// mp3 bitrate: matchamo izvor ali s podom (izvor je Opus iz mkv-a — bolji od
// originalnog lossy mp3-a, pa ne podbacujemo) i stropom (da ne napuhujemo).
const MP3_MIN_KBPS = parseInt(getArg("--mp3-min-kbps", "128"), 10);
const MP3_MAX_KBPS = parseInt(getArg("--mp3-max-kbps", "256"), 10);
const MP3_FALLBACK_KBPS = parseInt(getArg("--mp3-bitrate", "128"), 10);
const AAC_FALLBACK_KBPS = parseInt(getArg("--aac-bitrate", "192"), 10);
const CONCURRENCY = parseInt(
    getArg("--concurrency", String(Math.max(2, Math.floor(os.cpus().length / 2)))),
    10
);

function resolveBin(envVar, argName, names) {
    if (process.env[envVar]) return process.env[envVar];
    const argp = getArg(argName, null);
    if (argp) return argp;
    for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
        for (const n of names) {
            const c = path.join(dir, n);
            if (fs.existsSync(c)) return c;
        }
    }
    return names[0];
}
const FFMPEG = resolveBin("FFMPEG_PATH", "--ffmpeg", ["ffmpeg"]);
const FFPROBE = resolveBin("FFPROBE_PATH", "--ffprobe", ["ffprobe"]);

// --- nalaženje epizoda (symlink-aware: kanali su symlinkovi) ---
function listChannelDirs(root) {
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => path.join(root, e.name))
        .filter((p) => {
            try { return fs.statSync(p).isDirectory(); } catch { return false; }
        });
}

// Mapa base -> { dir, exts: {mkv, mp4, mp3} (apsolutne putanje) }.
// f-fragmenti (.f243.mp4 / .f251.webm) se ignoriraju — to su yt-dlp međufajlovi.
function collectEpisodes(channelDir) {
    let files;
    try {
        files = fs.readdirSync(channelDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const byBase = new Map();
    const put = (base, ext, full) => {
        if (!byBase.has(base)) byBase.set(base, { base, dir: channelDir, exts: {} });
        byBase.get(base).exts[ext] = full;
    };
    for (const f of files) {
        if (!f.isFile()) continue;
        const name = f.name;
        if (name.startsWith("._") || name.startsWith(".")) continue;
        if (name.includes(`.${SUFFIX}.`)) continue;          // preskoči vlastite izlaze
        if (/\.f\d+\.(mp4|webm|m4a)$/.test(name)) continue;   // yt-dlp fragmenti
        let ext = null;
        if (name.endsWith(".mkv")) ext = "mkv";
        else if (name.endsWith(".mp3")) ext = "mp3";
        else if (name.endsWith(".mp4")) ext = "mp4";
        else continue;
        put(name.slice(0, -(ext.length + 1)), ext, path.join(channelDir, name));
    }
    return [...byBase.values()];
}

// Najbolji audio izvor za loudnorm.
function pickAudioSource(ep) {
    if (AUDIO_SOURCE !== "auto") {
        return ep.exts[AUDIO_SOURCE] ? { file: ep.exts[AUDIO_SOURCE], type: AUDIO_SOURCE } : null;
    }
    for (const t of ["mkv", "mp4", "mp3"]) {
        if (ep.exts[t]) return { file: ep.exts[t], type: t };
    }
    return null;
}

// ffprobe audio bitrate izvora -> kbps (broj); null ako nečitljiv.
function probeAudioBitrate(file) {
    return new Promise((resolve) => {
        const args = ["-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=bit_rate", "-of", "default=nw=1:nk=1", file];
        const proc = spawn(FFPROBE, args, { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        proc.stdout.on("data", (c) => { out += c.toString(); });
        proc.on("error", () => resolve(null));
        proc.on("close", () => {
            const bps = parseInt(out.trim(), 10);
            if (!Number.isFinite(bps) || bps <= 0) return resolve(null);
            resolve(Math.round(bps / 1000));
        });
    });
}

// Single-pass dinamička normalizacija s ugrađenim true-peak limiterom.
// Two-pass measured_* put je ODBAČEN: loudnorm tada primijeni linearni gain i
// IGNORIRA TP limiter → klipa kod velikih pojačanja. Single-pass dynamic pouzdano
// pogađa i I (±~0.5 LU) i TP, i upola je brži (jedan prolaz).
function loudnormFilter() {
    return `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:linear=${LINEAR}:print_format=summary`;
}

function parseLoudnormSummary(buf) {
    const num = (re) => { const m = buf.match(re); return m ? parseFloat(m[1]) : null; };
    return {
        input_i: num(/Input Integrated:\s*(-?\d+(?:\.\d+)?)/i),
        input_tp: num(/Input True Peak:\s*(-?\d+(?:\.\d+)?)/i),
        input_lra: num(/Input LRA:\s*(-?\d+(?:\.\d+)?)/i),
        input_thresh: num(/Input Threshold:\s*(-?\d+(?:\.\d+)?)/i),
        output_i: num(/Output Integrated:\s*(-?\d+(?:\.\d+)?)/i),
        output_tp: num(/Output True Peak:\s*(-?\d+(?:\.\d+)?)/i),
        norm_type: (buf.match(/Normalization Type:\s*(\w+)/i) || [])[1] || null,
    };
}

// JEDAN ffmpeg prolaz: loudnorm + asplit fanout u sve tražene formate.
// plan: { mp3?: {tmp, out, br}, mp4?: {tmp, out, br} }, videoSrc = mux izvor ili null
function loudnormApply(audioSrc, videoSrc, plan) {
    return new Promise((resolve) => {
        const wantMp3 = !!plan.mp3, wantMp4 = !!plan.mp4 && !!videoSrc;
        const lf = loudnormFilter();
        const args = ["-hide_banner", "-nostats", "-y", "-i", audioSrc];
        if (wantMp4) args.push("-i", videoSrc);

        if (wantMp3 && wantMp4) {
            args.push("-filter_complex", `[0:a]${lf},asplit=2[am][av]`);
            args.push("-map", "[am]", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", plan.mp3.br, plan.mp3.tmp);
            args.push("-map", "[av]", "-map", "1:v:0", "-c:v", "copy", "-c:a", "aac", "-b:a", plan.mp4.br,
                "-movflags", "+faststart", plan.mp4.tmp);
        } else if (wantMp3) {
            args.push("-af", lf, "-ar", "44100", "-c:a", "libmp3lame", "-b:a", plan.mp3.br, plan.mp3.tmp);
        } else if (wantMp4) {
            args.push("-filter_complex", `[0:a]${lf}[am]`);
            args.push("-map", "[am]", "-map", "1:v:0", "-c:v", "copy", "-c:a", "aac", "-b:a", plan.mp4.br,
                "-movflags", "+faststart", plan.mp4.tmp);
        } else {
            return resolve({ ok: false, error: "no-output-planned" });
        }

        const proc = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
        let buf = "";
        proc.stderr.on("data", (c) => { buf += c.toString(); });   // -nostats → stderr je malen; treba nam loudnorm summary
        proc.on("error", () => resolve({ ok: false, error: "ffmpeg-apply-spawn-failed" }));
        proc.on("close", (code) => {
            const tmps = [plan.mp3, plan.mp4].filter(Boolean).map((p) => p.tmp);
            if (code !== 0) {
                for (const t of tmps) { try { fs.unlinkSync(t); } catch {} }
                return resolve({ ok: false, error: `ffmpeg-apply-exit-${code}`, tail: buf.slice(-300) });
            }
            try {
                if (wantMp3) fs.renameSync(plan.mp3.tmp, plan.mp3.out);
                if (wantMp4) fs.renameSync(plan.mp4.tmp, plan.mp4.out);
            } catch (e) {
                return resolve({ ok: false, error: "rename-failed:" + (e.code || e.message) });
            }
            resolve({ ok: true, produced: { mp3: wantMp3, mp4: wantMp4 }, summary: parseLoudnormSummary(buf) });
        });
    });
}

// --- verifikacija: re-mjeri integrated + true peak izlaza ---
function measureIntegrated(srcFile) {
    return new Promise((resolve) => {
        const args = ["-hide_banner", "-nostats", "-i", srcFile, "-af", "ebur128=peak=true", "-f", "null", "-"];
        const proc = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
        let tail = "";
        proc.stderr.on("data", (c) => { tail = (tail + c.toString()).slice(-8192); });
        proc.on("error", () => resolve(null));
        proc.on("close", () => {
            const idx = tail.lastIndexOf("Summary:");
            const scope = idx !== -1 ? tail.slice(idx) : tail;
            const i = scope.match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
            const tp = scope.match(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/);
            resolve({ i: i ? parseFloat(i[1]) : null, tp: tp ? parseFloat(tp[1]) : null });
        });
    });
}

function readSidecar(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

async function processEpisode(ep) {
    const out = { base: ep.base, channel: path.basename(ep.dir), formats: {} };
    const audio = pickAudioSource(ep);
    if (!audio) { out.formats._ = "no-audio-source"; return out; }

    // Što treba proizvesti (idempotencija po formatu)
    const plan = {};
    let videoSrc = null;
    for (const fmt of FORMATS) {
        const outFile = path.join(ep.dir, `${ep.base}.${SUFFIX}.${fmt}`);
        if (!FORCE && fs.existsSync(outFile)) { out.formats[fmt] = "exists"; continue; }
        if (fmt === "mp4") {
            if (!ep.exts.mp4) { out.formats[fmt] = "no-video-source"; continue; }
            videoSrc = ep.exts.mp4;  // video stream se kopira iz postojećeg .mp4
        }
        plan[fmt] = { out: outFile, tmp: `${outFile}.part.${fmt}` };  // .part.<ext> da ffmpeg pogodi muxer
    }
    if (!Object.keys(plan).length) return out;  // sve već postoji

    // Bitrate: mp3 = match izvora s podom/stropom; aac (mp4) = match izvora.
    if (plan.mp3) {
        const k = (ep.exts.mp3 && await probeAudioBitrate(ep.exts.mp3)) || MP3_FALLBACK_KBPS;
        plan.mp3.br = `${Math.min(MP3_MAX_KBPS, Math.max(MP3_MIN_KBPS, k))}k`;
    }
    if (plan.mp4) {
        const k = (ep.exts.mp4 && await probeAudioBitrate(ep.exts.mp4)) || AAC_FALLBACK_KBPS;
        plan.mp4.br = `${k}k`;
    }

    const app = await loudnormApply(audio.file, videoSrc, plan);
    if (!app.ok) { for (const f of Object.keys(plan)) out.formats[f] = "apply-error:" + app.error; return out; }

    // Sidecar
    const s = app.summary || {};
    const sidecarPath = path.join(ep.dir, `${ep.base}.${SUFFIX}.json`);
    const sidecar = readSidecar(sidecarPath);
    sidecar.base = ep.base;
    sidecar.channel = out.channel;
    sidecar.target = { I: TARGET_I, TP: TARGET_TP, LRA: TARGET_LRA };
    sidecar.method = `loudnorm single-pass ${LINEAR ? "linear" : "dynamic"} (${s.norm_type || "?"})`;
    sidecar.audio_source = { file: path.basename(audio.file), type: audio.type };
    sidecar.input = { integrated_lufs: s.input_i, true_peak_dbtp: s.input_tp, lra: s.input_lra };
    sidecar.output = { integrated_lufs: s.output_i, true_peak_dbtp: s.output_tp };
    sidecar.formats = sidecar.formats || {};
    for (const fmt of Object.keys(plan)) {
        const entry = { output: path.basename(plan[fmt].out), bitrate: plan[fmt].br, normalized_at: new Date().toISOString() };
        if (VERIFY) {
            const v = await measureIntegrated(plan[fmt].out);
            if (v) entry.verified = { integrated_lufs: v.i, true_peak_dbtp: v.tp };
        }
        sidecar.formats[fmt] = entry;
        out.formats[fmt] = VERIFY && entry.verified
            ? `ok (${s.input_i}→${entry.verified.integrated_lufs} LUFS, TP ${entry.verified.true_peak_dbtp}, ${entry.bitrate})`
            : `ok (${s.input_i}→${s.output_i} LUFS, ${entry.bitrate})`;
    }
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n");
    return out;
}

async function runPool(items, worker, concurrency, onTick) {
    let i = 0, done = 0;
    const results = [];
    async function next() {
        while (i < items.length) {
            const myIdx = i++;
            results[myIdx] = await worker(items[myIdx]);
            done++;
            onTick(done, items.length, results[myIdx]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
    return results;
}

async function main() {
    const t0 = Date.now();
    let channelDirs = listChannelDirs(INPUT_DIR);
    if (ONLY_CHANNEL) channelDirs = channelDirs.filter((d) => path.basename(d) === ONLY_CHANNEL);
    if (!channelDirs.length) {
        console.error(`Nema kanala u ${INPUT_DIR}${ONLY_CHANNEL ? ` (filter: ${ONLY_CHANNEL})` : ""}`);
        process.exit(1);
    }

    let episodes = [];
    for (const dir of channelDirs) episodes.push(...collectEpisodes(dir));
    if (ONLY_BASE) episodes = episodes.filter((ep) => ep.base.includes(ONLY_BASE));
    episodes = episodes.filter((ep) => pickAudioSource(ep));
    if (LIMIT > 0) episodes = episodes.slice(0, LIMIT);

    console.log(`Kanala: ${channelDirs.length} · epizoda: ${episodes.length} · formati: ${FORMATS.join(",")} · audio-izvor: ${AUDIO_SOURCE}`);
    console.log(`Cilj: ${TARGET_I} LUFS / ${TARGET_TP} dBTP / LRA ${TARGET_LRA} · concurrency: ${CONCURRENCY} · ffmpeg: ${FFMPEG}`);
    console.log(`Izlaz: {basename}.${SUFFIX}.{${FORMATS.join("|")}} (original se ne dira)${VERIFY ? " · verifikacija UKLJUČENA" : ""}`);
    if (!episodes.length) { console.log("Ništa za normalizirati."); return; }

    let lastLog = 0;
    const results = await runPool(episodes, processEpisode, CONCURRENCY, (done, total, r) => {
        const now = Date.now();
        if (now - lastLog > 2000 || done === total) {
            lastLog = now;
            const pct = ((done / total) * 100).toFixed(1);
            const rate = done / ((now - t0) / 1000);
            const eta = rate > 0 ? Math.round((total - done) / rate) : 0;
            process.stderr.write(`\r  ${done}/${total} (${pct}%) · ${rate.toFixed(2)}/s · ETA ${eta}s   `);
        }
        if (r && VERIFY) {
            const ok = Object.entries(r.formats).find(([, v]) => v.startsWith("ok ("));
            if (ok) process.stderr.write(`\n  ✓ [${r.channel}] ${r.base.slice(0, 50)} · ${ok[0]} ${ok[1]}\n`);
        }
    });
    process.stderr.write("\n");

    let nOk = 0, nExists = 0, nSkip = 0, nErr = 0;
    for (const r of results) {
        for (const [fmt, v] of Object.entries(r.formats)) {
            if (v.startsWith("ok")) nOk++;
            else if (v === "exists") nExists++;
            else if (v.startsWith("no-")) nSkip++;
            else { nErr++; if (nErr <= 10) console.error(`  greška [${r.channel}] ${r.base.slice(0, 50)} (${fmt}): ${v}`); }
        }
    }

    console.log(`\n=== NORMALIZACIJA gotova ===`);
    console.log(`Proizvedeno: ${nOk} · već postojalo: ${nExists} · preskočeno (bez izvora): ${nSkip} · greške: ${nErr}`);
    console.log(`Trajanje: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
