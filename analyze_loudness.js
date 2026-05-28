#!/usr/bin/env node
/**
 * analyze_loudness.js
 *
 * FAZA 1 analize glasnoće: jednostruki, paralelni, idempotentni prolaz kroz
 * sve epizode. Mjeri integrated loudness (LUFS), true peak (dBTP) i loudness
 * range (LRA) po epizodi pomoću ffmpeg `loudnorm print_format=json`.
 *
 * Izmjerene vrijednosti (input_i / input_tp / input_lra / input_thresh) spremaju
 * se u sidecar `{basename}.loudness.json` pored izvora — isti brojevi kasnije
 * služe kao measured_* za two-pass loudnorm normalizaciju (ništa se ne baca).
 *
 * Na kraju ispisuje strukturirani izvještaj o stvarnom rasponu glasnoće
 * (cross-epizoda + per-kanal) i sprema ga u --report-out.
 *
 * Usage:
 *   node analyze_loudness.js                          # cijeli storage/output
 *   node analyze_loudness.js --channel domovina_tv    # samo jedan kanal
 *   node analyze_loudness.js --limit 5                # sanity uzorak
 *   node analyze_loudness.js --concurrency 8 --force
 *   node analyze_loudness.js --report-out loudness_report.json
 *
 * FAZA 1 mjeri .wav (16kHz mono) preko `ebur128` filtera — ~1270x realtime,
 * 14x brže od loudnorm-a. Vrijednosti su ~3 LU offset niže od full-band stereo
 * izvora (K-weighting odsječen na 8kHz Nyquistu + mono summing), ali OFFSET JE
 * SUSTAVAN pa je RASPON između epizoda potpuno valjan. Apsolutni target za
 * normalizaciju .mp4 se ionako re-mjeri u trenutku primjene (two-pass loudnorm),
 * pa pre-analiza ne mora biti apsolutno točna — služi da vidimo problem i
 * odlučimo strategiju. True peak se NE mjeri ovdje (peak=none = brzina).
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
const LIMIT = parseInt(getArg("--limit", "0"), 10);
const FORCE = hasFlag("--force");
const TARGET_I = parseFloat(getArg("--target", "-16"));
const REPORT_OUT = getArg("--report-out", "loudness_report.json");
const DATA_OUT = getArg("--data-out", "loudness_data.json");
const CONCURRENCY = parseInt(
    getArg("--concurrency", String(Math.max(2, os.cpus().length - 2))),
    10
);
const SOURCE_PREF = (getArg("--source-pref", "wav")).split(",");

// Resolvaj apsolutnu putanju ffmpeg-a (spawn iz node-a ne nasljeđuje uvijek
// interaktivni PATH, npr. /opt/homebrew/bin nedostaje u nekim shell kontekstima).
function resolveFfmpeg() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    const argp = getArg("--ffmpeg", null);
    if (argp) return argp;
    for (const c of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
        if (fs.existsSync(c)) return c;
    }
    return "ffmpeg";
}
const FFMPEG = resolveFfmpeg();

const VIDEO_ID_RE = /_yt_([A-Za-z0-9_-]{11})(?:\.|$)/;

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

// Vrati mapu basename -> { dir, sources: {mp3,mp4,...} } za jedan kanal.
function collectEpisodes(channelDir) {
    let files;
    try {
        files = fs.readdirSync(channelDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const byBase = new Map();
    for (const f of files) {
        if (!f.isFile()) continue;
        const name = f.name;
        if (name.startsWith("._") || name.startsWith(".")) continue; // macOS AppleDouble / dotfiles
        let ext = null;
        if (name.endsWith(".wav")) ext = "wav";
        else if (name.endsWith(".mp3")) ext = "mp3";
        else if (name.endsWith(".mp4") && !/\.f\d+\.mp4$/.test(name)) ext = "mp4";
        else continue;
        const base = name.slice(0, -(ext.length + 1));
        if (!byBase.has(base)) byBase.set(base, { base, dir: channelDir, sources: {} });
        byBase.get(base).sources[ext] = path.join(channelDir, name);
    }
    return [...byBase.values()];
}

function pickSource(ep) {
    for (const pref of SOURCE_PREF) {
        if (ep.sources[pref]) return { file: ep.sources[pref], type: pref };
    }
    return null;
}

function videoIdOf(base) {
    const m = base.match(VIDEO_ID_RE);
    return m ? m[1] : null;
}

function durationToSec(str) {
    // "HH:MM:SS.ss"
    const m = str.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return null;
    return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

// Pokreni ffmpeg ebur128 metering nad jednim fajlom; vrati integrated LUFS + LRA.
// ebur128 spama per-frame linije na stderr (desetci tisuća po fajlu) — držimo
// samo rolling tail (zadnjih ~8KB) jer je Summary blok na samom kraju.
function measure(srcFile) {
    return new Promise((resolve) => {
        const args = [
            "-hide_banner", "-nostats",
            "-i", srcFile,
            "-af", "ebur128=peak=none",
            "-f", "null", "-",
        ];
        const proc = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
        let tail = "";
        let duration = null;
        proc.stderr.on("data", (c) => {
            tail = (tail + c.toString()).slice(-8192);
            if (duration === null) {
                const d = tail.match(/Duration:\s*([\d:.]+)/);
                if (d) duration = durationToSec(d[1]);
            }
        });
        proc.on("error", () => resolve({ ok: false, error: "ffmpeg-spawn-failed" }));
        proc.on("close", (code) => {
            // Summary blok: "Integrated loudness:\n    I:    -26.0 LUFS" + "LRA:  6.7 LU"
            const summaryIdx = tail.lastIndexOf("Summary:");
            const scope = summaryIdx !== -1 ? tail.slice(summaryIdx) : tail;
            const iMatch = scope.match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
            const lraMatch = scope.match(/LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/);
            if (code !== 0 || !iMatch) {
                resolve({ ok: false, error: `ffmpeg-exit-${code}` });
                return;
            }
            resolve({
                ok: true,
                input_i: parseFloat(iMatch[1]),
                input_lra: lraMatch ? parseFloat(lraMatch[1]) : null,
                duration_sec: duration,
            });
        });
    });
}

// measuredByBase: konsolidirana data iz prethodnih runova (idempotencija).
const measuredByBase = new Map();

async function processEpisode(ep) {
    const src = pickSource(ep);
    if (!src) return { skip: "no-source" };
    if (!FORCE && measuredByBase.has(ep.base)) {
        return { cached: true, record: measuredByBase.get(ep.base) };
    }
    const m = await measure(src.file);
    if (!m.ok) return { error: m.error, base: ep.base };

    const record = {
        base: ep.base,
        video_id: videoIdOf(ep.base),
        channel: path.basename(ep.dir),
        source_type: src.type,
        method: "ebur128-integrated",
        target_i: TARGET_I,
        integrated_lufs: m.input_i,
        lra: m.input_lra,
        gain_to_target_db: +(TARGET_I - m.input_i).toFixed(2),
        duration_sec: m.duration_sec,
        measured_at: new Date().toISOString(),
    };
    measuredByBase.set(ep.base, record);
    return { measured: true, record };
}

function flushData() {
    const all = [...measuredByBase.values()];
    fs.writeFileSync(DATA_OUT, JSON.stringify(all, null, 2) + "\n");
}

// --- jednostavni worker-pool ---
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

// --- statistika za izvještaj ---
function stats(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
    return {
        n: s.length,
        min: +s[0].toFixed(2),
        p10: +q(0.10).toFixed(2),
        median: +q(0.50).toFixed(2),
        mean: +mean.toFixed(2),
        p90: +q(0.90).toFixed(2),
        max: +s[s.length - 1].toFixed(2),
        stddev: +sd.toFixed(2),
        spread: +(s[s.length - 1] - s[0]).toFixed(2),
    };
}

function histogram(nums, lo, hi, step) {
    const buckets = [];
    for (let b = lo; b < hi; b += step) buckets.push({ from: b, to: b + step, count: 0 });
    for (const v of nums) {
        const idx = Math.floor((v - lo) / step);
        if (idx < 0) buckets[0].count++;
        else if (idx >= buckets.length) buckets[buckets.length - 1].count++;
        else buckets[idx].count++;
    }
    return buckets;
}

function fmtBar(count, max, width = 30) {
    const n = max ? Math.round((count / max) * width) : 0;
    return "█".repeat(n) + "░".repeat(width - n);
}

async function main() {
    const t0 = Date.now();
    let channelDirs = listChannelDirs(INPUT_DIR);
    if (ONLY_CHANNEL) {
        channelDirs = channelDirs.filter((d) => path.basename(d) === ONLY_CHANNEL);
    }
    if (!channelDirs.length) {
        console.error(`Nema kanala u ${INPUT_DIR}${ONLY_CHANNEL ? ` (filter: ${ONLY_CHANNEL})` : ""}`);
        process.exit(1);
    }

    let episodes = [];
    for (const dir of channelDirs) episodes.push(...collectEpisodes(dir));
    episodes = episodes.filter((ep) => pickSource(ep));
    if (LIMIT > 0) episodes = episodes.slice(0, LIMIT);

    // Učitaj postojeću konsolidiranu data (idempotencija / resumability)
    if (!FORCE && fs.existsSync(DATA_OUT)) {
        try {
            for (const r of JSON.parse(fs.readFileSync(DATA_OUT, "utf8"))) {
                if (r && r.base) measuredByBase.set(r.base, r);
            }
            console.log(`Učitano iz ${DATA_OUT}: ${measuredByBase.size} prethodnih mjerenja`);
        } catch { /* ignore */ }
    }

    console.log(`Kanala: ${channelDirs.length} · epizoda: ${episodes.length} · concurrency: ${CONCURRENCY} · ffmpeg: ${FFMPEG}`);
    if (!episodes.length) { console.log("Ništa za mjeriti."); return; }

    let lastLog = 0, lastFlush = 0;
    const results = await runPool(episodes, processEpisode, CONCURRENCY, (done, total) => {
        const now = Date.now();
        if (now - lastLog > 2000 || done === total) {
            lastLog = now;
            const pct = ((done / total) * 100).toFixed(1);
            const rate = done / ((now - t0) / 1000);
            const eta = rate > 0 ? Math.round((total - done) / rate) : 0;
            process.stderr.write(`\r  ${done}/${total} (${pct}%) · ${rate.toFixed(1)}/s · ETA ${eta}s   `);
        }
        if (done - lastFlush >= 100) { lastFlush = done; flushData(); } // checkpoint
    });
    process.stderr.write("\n");
    flushData();

    const records = [];
    let nErr = 0, nCached = 0, nMeasured = 0, nNoSource = 0;
    for (const r of results) {
        if (!r) continue;
        if (r.error) { nErr++; if (nErr <= 5) console.error(`  greška: ${r.error} · ${r.base}`); continue; }
        if (r.skip === "no-source") { nNoSource++; continue; }
        if (r.cached) nCached++;
        if (r.measured) nMeasured++;
        if (r.record) records.push(r.record);
    }

    const attempted = nMeasured + nErr;
    if (attempted > 0 && nErr / attempted > 0.3) {
        console.error(`\nABORT: ${nErr}/${attempted} mjerenja palo (>30%). Vjerojatno ffmpeg nedostupan ili sandbox blokira exec. Pokreni u backgroundu / provjeri ffmpeg.`);
        process.exit(1);
    }

    // filtriraj sane vrijednosti (ebur128 vraća jako nizak I za tišinu)
    const valid = records.filter((r) => isFinite(r.integrated_lufs) && r.integrated_lufs > -70);
    const lufs = valid.map((r) => r.integrated_lufs);

    const overall = stats(lufs);

    // per-kanal
    const perChannel = {};
    for (const r of valid) (perChannel[r.channel] ||= []).push(r.integrated_lufs);
    const channelRows = Object.entries(perChannel)
        .map(([ch, arr]) => ({ channel: ch, ...stats(arr) }))
        .sort((a, b) => a.median - b.median);

    const sortedByLufs = [...valid].sort((a, b) => a.integrated_lufs - b.integrated_lufs);
    const quietest = sortedByLufs.slice(0, 10).map((r) => ({ ch: r.channel, lufs: r.integrated_lufs, gain: r.gain_to_target_db, base: r.base }));
    const loudest = sortedByLufs.slice(-10).reverse().map((r) => ({ ch: r.channel, lufs: r.integrated_lufs, gain: r.gain_to_target_db, base: r.base }));

    const within1 = lufs.filter((v) => Math.abs(v - TARGET_I) <= 1).length;
    const within2 = lufs.filter((v) => Math.abs(v - TARGET_I) <= 2).length;
    const off3 = lufs.filter((v) => Math.abs(v - TARGET_I) > 3).length;

    const report = {
        generated_at: new Date().toISOString(),
        input_dir: INPUT_DIR,
        target_i_lufs: TARGET_I,
        method: "ebur128 integrated na 16kHz mono .wav (~+3 LU offset vs full-band; raspon je valjan, apsolut nije)",
        counts: { measured: nMeasured, cached: nCached, errors: nErr, no_source: nNoSource, valid: valid.length },
        integrated_lufs: overall,
        distribution_vs_target: {
            within_1_lu: within1, within_2_lu: within2, off_more_than_3_lu: off3,
        },
        per_channel: channelRows,
        quietest_10: quietest,
        loudest_10: loudest,
    };
    fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2) + "\n");

    // --- konzolni sažetak ---
    console.log(`\n=== GLASNOĆA — sažetak (${valid.length} epizoda, cilj ${TARGET_I} LUFS) ===`);
    console.log(`Mjereno: ${nMeasured} · iz cachea: ${nCached} · greške: ${nErr} · bez izvora: ${nNoSource}`);
    if (overall) {
        console.log(`\nIntegrated LUFS:`);
        console.log(`  min ${overall.min} · p10 ${overall.p10} · median ${overall.median} · mean ${overall.mean} · p90 ${overall.p90} · max ${overall.max}`);
        console.log(`  RASPON (max-min): ${overall.spread} LU · stddev ${overall.stddev} LU`);
        console.log(`\nUdaljenost od cilja (${TARGET_I} LUFS):`);
        console.log(`  unutar ±1 LU: ${within1} (${(within1 / valid.length * 100).toFixed(0)}%) · ±2 LU: ${within2} (${(within2 / valid.length * 100).toFixed(0)}%) · >±3 LU: ${off3} (${(off3 / valid.length * 100).toFixed(0)}%)`);

        console.log(`\nHistogram integrated LUFS:`);
        const h = histogram(lufs, -40, -5, 2.5);
        const hmax = Math.max(...h.map((b) => b.count));
        for (const b of h) {
            if (b.count === 0) continue;
            console.log(`  ${b.from.toFixed(1).padStart(6)}..${b.to.toFixed(1).padStart(6)}  ${fmtBar(b.count, hmax)} ${b.count}`);
        }

        console.log(`\nPer-kanal (median LUFS, sortirano od najtišeg):`);
        for (const c of channelRows) {
            console.log(`  ${c.channel.padEnd(34)} med ${String(c.median).padStart(7)} · raspon ${String(c.spread).padStart(5)} LU · n ${c.n}`);
        }

        console.log(`\nNajtiših 5:`);
        for (const q of quietest.slice(0, 5)) console.log(`  ${String(q.lufs).padStart(7)} LUFS (gain ${q.gain >= 0 ? "+" : ""}${q.gain}) [${q.ch}] ${q.base.slice(0, 60)}`);
        console.log(`Najglasnijih 5:`);
        for (const q of loudest.slice(0, 5)) console.log(`  ${String(q.lufs).padStart(7)} LUFS (gain ${q.gain >= 0 ? "+" : ""}${q.gain}) [${q.ch}] ${q.base.slice(0, 60)}`);
    }
    console.log(`\nIzvještaj: ${REPORT_OUT} · per-epizoda data: ${DATA_OUT} · trajanje ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
