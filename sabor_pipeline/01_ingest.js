#!/usr/bin/env node

/**
 * 01_ingest.js — dohvat višedijelne saborske sjednice, konverzija u 16 kHz WAV,
 *                lossless spajanje i generiranje session_manifest.json
 *
 * Faza 01 pipelinea iz sabor_pipeline/01_ingest_and_stitch.md.
 *
 * Jedna saborska sjednica je JEDAN kontinuirani događaj razbijen na N YouTube live
 * streamova. Sve nizvodne faze (diarizacija, ASR, LLM strukturiranje) rade nad
 * GLOBALNOM vremenskom osi sjednice, a `session_manifest.json` je jedina tablica
 * koja tu os prevodi natrag u konkretan YouTube video + sekundu.
 *
 * Idempotentno: preskače već preuzete/konvertirane/spojene artefakte (uz provjeru
 * da nisu krnji), po uzoru na convert_to_wav.js.
 *
 * Primjeri:
 *   node sabor_pipeline/01_ingest.js --session sabor_11_izvanredna_11 --dry-run
 *   node sabor_pipeline/01_ingest.js --session sabor_11_izvanredna_11
 *   node sabor_pipeline/01_ingest.js --session sabor_11_izvanredna_11 --no-stitch
 *   node sabor_pipeline/01_ingest.js --session sabor_11_izvanredna_11 --only-part 3
 */

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { buildParts, totalDuration, secondsToHms, globalToYoutube } = require("./utils/time_mapper");

const REPO_ROOT = path.resolve(__dirname, "..");
const SESSIONS_DIR = path.join(__dirname, "data", "sessions");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "storage", "output", "sabor");
const COOKIES_FILE = path.join(REPO_ROOT, "cookies.txt");
const BROWSER_NAME = "brave";

// Isti UA kao fetch.js — YouTube je osjetljiv na nesklad UA/klijenta.
const MY_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

// 16 kHz mono PCM 16-bit — isto kao convert_to_wav.js (ulaz za pyannote i Canary).
const FFMPEG_WAV_ARGS = ["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"];
const WAV_BYTES_PER_SEC = 16000 * 2; // 32 kB/s

// Tolerancija razlike trajanja WAV-a i izvora prije nego što se WAV proglasi krnjim.
const DURATION_TOLERANCE_SEC = 2;
// Iznad ovoga se YouTube deep linkovi počinju vidljivo razilaziti s izgovorenim.
const DRIFT_WARN_SEC = 2;
const DELAY_BETWEEN_DOWNLOADS_MS = 3000;

// --- CLI (Pattern B) ---

const args = process.argv.slice(2);

function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
function hasFlag(name) {
    return args.includes(name);
}

const SESSION_ARG = getArg("--session");
const OUTPUT_DIR = getArg("--output-dir") || DEFAULT_OUTPUT_DIR;
const ONLY_PART = getArg("--only-part") ? Number(getArg("--only-part")) : null;
const SOURCE_ADDRESS = getArg("--source-address");
const DRY_RUN = hasFlag("--dry-run");
const NO_STITCH = hasFlag("--no-stitch");
const FORCE = hasFlag("--force");

if (!SESSION_ARG || hasFlag("--help") || hasFlag("-h")) {
    console.log(`
Uporaba: node sabor_pipeline/01_ingest.js --session <id|putanja> [opcije]

  --session <id>        ID sjednice (datoteka u ${path.relative(REPO_ROOT, SESSIONS_DIR)}/) ili putanja do JSON-a
  --output-dir <dir>    Izlazni direktorij (default: storage/output/sabor)
  --only-part <N>       Obradi samo taj dio (dijagnostika; manifest se tad NE piše)
  --source-address <ip> Proslijedi yt-dlp-u (npr. iPhone hotspot IP)
  --no-stitch           Preskoči spajanje u full_session_16k.wav
  --force               Ponovno preuzmi/konvertiraj i kad artefakti postoje
  --dry-run             Ispiši plan i izmjerena trajanja bez preuzimanja
`);
    process.exit(SESSION_ARG ? 0 : 1);
}

// --- yt-dlp bazni argumenti (podskup fetch.js — ovdje treba samo audio) ---

function ytDlpBaseArgs() {
    const base = [
        "--no-playlist",
        "--user-agent", MY_USER_AGENT,
        "--remote-components", "ejs:github",
        "--no-check-certificate",
        "--no-progress",
    ];
    if (fs.existsSync(COOKIES_FILE)) {
        base.push("--cookies", COOKIES_FILE);
    } else {
        base.push("--cookies-from-browser", BROWSER_NAME);
    }
    if (SOURCE_ADDRESS) base.push("--source-address", SOURCE_ADDRESS);
    return base;
}

// --- Pomoćne ---

function loadSession(arg) {
    const candidates = [
        arg,
        path.join(SESSIONS_DIR, arg),
        path.join(SESSIONS_DIR, `${arg}.json`),
    ];
    const found = candidates.find((p) => p && fs.existsSync(p) && fs.statSync(p).isFile());
    if (!found) throw new Error(`Konfiguracija sjednice nije pronađena: ${arg}`);

    const cfg = JSON.parse(fs.readFileSync(found, "utf8"));
    if (!cfg.session_id) throw new Error(`${found}: nedostaje session_id`);
    if (!Array.isArray(cfg.videos) || cfg.videos.length === 0) {
        throw new Error(`${found}: nedostaje videos[]`);
    }
    cfg._path = found;

    const seenParts = new Set();
    for (const v of cfg.videos) {
        if (!v.video_id) v.video_id = extractVideoId(v.url);
        if (!v.video_id) throw new Error(`Dio ${v.part}: ne mogu odrediti video_id iz ${v.url}`);
        if (!Number.isInteger(v.part)) throw new Error(`Video ${v.video_id}: 'part' mora biti cijeli broj`);
        if (seenParts.has(v.part)) throw new Error(`Duplicirani part broj: ${v.part}`);
        seenParts.add(v.part);
    }
    return cfg;
}

/** 11-znakovni YouTube ID iz watch/youtu.be/live URL-a. */
function extractVideoId(url) {
    if (!url) return null;
    const m = String(url).match(/(?:v=|youtu\.be\/|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

function run(cmd, cmdArgs, { capture = false } = {}) {
    const res = spawnSync(cmd, cmdArgs, {
        encoding: "utf8",
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
        maxBuffer: 32 * 1024 * 1024,
    });
    if (res.error) throw res.error;
    return res;
}

function runAsync(cmd, cmdArgs) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, cmdArgs, { stdio: "inherit" });
        proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
        proc.on("error", reject);
    });
}

/**
 * Broj uzoraka iz WAV `data` chunka — egzaktno, bez float zaokruživanja ffprobea.
 *
 * Ne pretpostavlja 44-bajtno zaglavlje: ffmpeg umeće LIST/JUNK chunkove, pa se lanac
 * chunkova mora prošetati. Vraća null ako datoteka nije čitljiv PCM WAV.
 */
function wavSampleCount(file) {
    let fd;
    try {
        fd = fs.openSync(file, "r");
        const head = Buffer.alloc(12);
        if (fs.readSync(fd, head, 0, 12, 0) < 12) return null;
        if (head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") return null;

        let pos = 12;
        const hdr = Buffer.alloc(8);
        const fileSize = fs.fstatSync(fd).size;
        while (pos + 8 <= fileSize) {
            if (fs.readSync(fd, hdr, 0, 8, pos) < 8) return null;
            const id = hdr.toString("latin1", 0, 4);
            const size = hdr.readUInt32LE(4);
            if (id === "data") {
                // Zadnji chunk zna imati deklariranu veličinu veću od stvarne (prekinut zapis).
                const actual = Math.min(size, fileSize - (pos + 8));
                return Math.floor(actual / 2); // 16-bit mono
            }
            pos += 8 + size + (size % 2);
        }
        return null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

/** Trajanje medijske datoteke u sekundama (ffprobe), ili null. */
function probeDuration(file) {
    if (!fs.existsSync(file)) return null;
    const res = run("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        file,
    ], { capture: true });
    const val = parseFloat((res.stdout || "").trim());
    return Number.isFinite(val) ? val : null;
}

/** Trajanje i naslov s YouTubea (bez preuzimanja) — izvor za provjeru drifta. */
function probeYoutube(videoId) {
    const res = run("yt-dlp", [
        ...ytDlpBaseArgs(),
        "--skip-download",
        "--print", "%(duration)s\t%(title)s\t%(upload_date)s",
        `https://www.youtube.com/watch?v=${videoId}`,
    ], { capture: true });

    if (res.status !== 0) {
        const err = (res.stderr || "").trim().split("\n").slice(-3).join(" | ");
        throw new Error(`yt-dlp metapodaci padaju za ${videoId}: ${err}`);
    }
    const line = (res.stdout || "").trim().split("\n").pop() || "";
    const [dur, title, uploadDate] = line.split("\t");
    return {
        duration_sec: Number.isFinite(parseFloat(dur)) ? parseFloat(dur) : null,
        title: title || null,
        upload_date: uploadDate || null,
    };
}

function findExisting(dir, stem) {
    if (!fs.existsSync(dir)) return null;
    const hit = fs.readdirSync(dir).find((f) => f.startsWith(`${stem}.`) && !f.endsWith(".part"));
    return hit ? path.join(dir, hit) : null;
}

function humanBytes(n) {
    const units = ["B", "kB", "MB", "GB", "TB"];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
}

/** Slobodan prostor na disku na kojem je (ili će biti) `dir`. */
function freeBytes(dir) {
    let probe = dir;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    const st = fs.statfsSync(probe);
    return st.bavail * st.bsize;
}

// --- Koraci ---

/** 1. Dohvat audija (yt-dlp) → raw/part_NN.<ext> */
async function downloadPart(part, rawDir) {
    const stem = `part_${String(part.part).padStart(2, "0")}`;
    const existing = findExisting(rawDir, stem);

    if (existing && !FORCE) {
        const dur = probeDuration(existing);
        if (dur !== null && Math.abs(dur - part.yt_duration_sec) <= DURATION_TOLERANCE_SEC) {
            console.log(`   ⏭️  ${stem}: već preuzet (${secondsToHms(dur)})`);
            return existing;
        }
        console.warn(`   ⚠️  ${stem}: krnji izvor (${dur === null ? "nečitljiv" : secondsToHms(dur)} vs ${secondsToHms(part.yt_duration_sec)}) — preuzimam ponovno`);
        fs.unlinkSync(existing);
    } else if (existing && FORCE) {
        fs.unlinkSync(existing);
    }

    console.log(`   ⬇️  ${stem}: ${part.video_id} (${secondsToHms(part.yt_duration_sec)})`);
    await runAsync("yt-dlp", [
        ...ytDlpBaseArgs(),
        "-f", "bestaudio[ext=m4a]/bestaudio/best",
        "-o", path.join(rawDir, `${stem}.%(ext)s`),
        `https://www.youtube.com/watch?v=${part.video_id}`,
    ]);

    const downloaded = findExisting(rawDir, stem);
    if (!downloaded) throw new Error(`${stem}: yt-dlp je završio bez greške, ali datoteka ne postoji`);

    // yt-dlp zna izaći s 0 i na krnjem preuzimanju (prekinuta veza) — trajanje je jedini dokaz.
    const dur = probeDuration(downloaded);
    if (dur === null || Math.abs(dur - part.yt_duration_sec) > DURATION_TOLERANCE_SEC) {
        fs.unlinkSync(downloaded);
        throw new Error(`${stem}: preuzeti audio je krnji (${dur === null ? "nečitljiv" : Math.round(dur) + "s"} vs ${Math.round(part.yt_duration_sec)}s) — obrisan`);
    }
    return downloaded;
}

/** 2. Konverzija u 16 kHz mono PCM WAV → audio/part_NN_16k.wav */
async function convertPart(part, srcFile, audioDir) {
    const stem = `part_${String(part.part).padStart(2, "0")}`;
    const wavFile = path.join(audioDir, `${stem}_16k.wav`);
    const srcDur = probeDuration(srcFile);

    if (fs.existsSync(wavFile) && !FORCE) {
        const dur = probeDuration(wavFile);
        if (dur !== null && Math.abs(dur - srcDur) <= DURATION_TOLERANCE_SEC) {
            console.log(`   ⏭️  ${stem}_16k.wav: već konvertiran (${secondsToHms(dur)})`);
            return { wavFile, ...exactDuration(wavFile, dur) };
        }
        console.warn(`   ⚠️  ${stem}_16k.wav: krnji — konvertiram ponovno`);
        fs.unlinkSync(wavFile);
    } else if (fs.existsSync(wavFile) && FORCE) {
        fs.unlinkSync(wavFile);
    }

    console.log(`   🎚️  ${stem} → 16 kHz mono WAV`);
    try {
        await runAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", srcFile, ...FFMPEG_WAV_ARGS, "-y", wavFile]);
    } catch (err) {
        if (fs.existsSync(wavFile)) fs.unlinkSync(wavFile);
        throw err;
    }

    const dur = probeDuration(wavFile);
    if (dur === null || Math.abs(dur - srcDur) > DURATION_TOLERANCE_SEC) {
        fs.unlinkSync(wavFile);
        throw new Error(`${stem}_16k.wav kraći od izvora (${dur === null ? "nečitljiv" : Math.round(dur) + "s"} vs ${Math.round(srcDur)}s) — obrisan`);
    }
    return { wavFile, ...exactDuration(wavFile, dur) };
}

/**
 * Egzaktno trajanje WAV-a iz broja uzoraka; fallback na ffprobe float ako header ne valja.
 * Broj uzoraka je ono čime faza 02 reže spojeni audio, pa mora biti cjelobrojan.
 */
function exactDuration(wavFile, probedSec) {
    const samples = wavSampleCount(wavFile);
    if (samples === null) return { duration_sec: probedSec, duration_samples: null };
    return { duration_sec: samples / 16000, duration_samples: samples };
}

/**
 * 3. Lossless spajanje (concat demuxer + -c copy).
 *
 * Svi dijelovi su već identičnog formata (16 kHz mono s16le), pa `-c copy` kopira
 * uzorke bit-točno — spojena os je zbroj trajanja dijelova, bez resamplinga.
 * `-rf64 auto` je osigurač: klasični WAV header puca na 4 GB (≈ 37 h ovog formata),
 * a saborske sjednice znaju biti dvodnevne.
 */
async function stitch(parts, audioDir) {
    const outFile = path.join(audioDir, "full_session_16k.wav");
    const expected = parts.reduce((s, p) => s + p.duration_sec, 0);

    if (fs.existsSync(outFile) && !FORCE) {
        const dur = probeDuration(outFile);
        if (dur !== null && Math.abs(dur - expected) <= DURATION_TOLERANCE_SEC) {
            console.log(`   ⏭️  full_session_16k.wav: već spojen (${secondsToHms(dur)})`);
            return { file: outFile, duration_sec: dur };
        }
        console.warn(`   ⚠️  full_session_16k.wav: trajanje ne odgovara zbroju dijelova — spajam ponovno`);
    }

    const listFile = path.join(audioDir, ".concat_list.txt");
    fs.writeFileSync(
        listFile,
        parts.map((p) => `file '${path.resolve(audioDir, path.basename(p.wav_file)).replace(/'/g, "'\\''")}'`).join("\n") + "\n"
    );

    console.log(`   🧵 Spajam ${parts.length} dijela → full_session_16k.wav (${secondsToHms(expected)}, ~${humanBytes(expected * WAV_BYTES_PER_SEC)})`);
    try {
        await runAsync("ffmpeg", [
            "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", listFile,
            "-c", "copy", "-rf64", "auto",
            "-y", outFile,
        ]);
    } catch (err) {
        if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
        throw err;
    } finally {
        if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
    }

    const dur = probeDuration(outFile);
    if (dur === null || Math.abs(dur - expected) > DURATION_TOLERANCE_SEC) {
        fs.unlinkSync(outFile);
        throw new Error(`Spojeni WAV ima krivo trajanje (${dur === null ? "nečitljiv" : Math.round(dur) + "s"} vs očekivanih ${Math.round(expected)}s) — obrisan`);
    }
    return { file: outFile, duration_sec: dur };
}

// --- Glavni program ---

async function main() {
    const cfg = loadSession(SESSION_ARG);
    const sessionDir = path.join(OUTPUT_DIR, cfg.session_id);
    const rawDir = path.join(sessionDir, "raw");
    const audioDir = path.join(sessionDir, "audio");

    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   🏛️  SABOR — FAZA 01: INGEST & STITCH           ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log("");
    console.log(`   📄 Sjednica: ${cfg.title || cfg.session_id}`);
    console.log(`   🆔 ${cfg.session_id}  (${cfg.date || "bez datuma"})`);
    console.log(`   📂 ${sessionDir}`);
    console.log(`   🎬 Dijelova: ${cfg.videos.length}${ONLY_PART ? `  (obrađujem samo dio ${ONLY_PART})` : ""}`);
    console.log("");

    // --- Metapodaci sa YouTubea (izvor istine za provjeru krnjih preuzimanja) ---
    console.log("🔍 Dohvaćam metapodatke...");
    const probed = [];
    for (const v of cfg.videos) {
        const meta = probeYoutube(v.video_id);
        if (meta.duration_sec === null) {
            throw new Error(`Dio ${v.part} (${v.video_id}): YouTube ne vraća trajanje (live stream još traje?)`);
        }
        probed.push({ ...v, yt_duration_sec: meta.duration_sec, yt_title: meta.title, upload_date: meta.upload_date });
        console.log(`   ${String(v.part).padStart(2)}. ${v.video_id}  ${secondsToHms(meta.duration_sec)}  ${meta.title || ""}`);
    }
    const totalYt = probed.reduce((s, p) => s + p.yt_duration_sec, 0);
    console.log(`   ─── ukupno: ${secondsToHms(totalYt)} (${(totalYt / 3600).toFixed(2)} h)`);
    console.log("");

    // --- Provjera prostora PRIJE preuzimanja (raw + po dijelu WAV + spojeni WAV) ---
    const needBytes = totalYt * WAV_BYTES_PER_SEC * (NO_STITCH ? 1 : 2) + totalYt * 16 * 1024;
    const avail = freeBytes(sessionDir);
    console.log(`   💾 Potrebno ~${humanBytes(needBytes)}, slobodno ${humanBytes(avail)}`);
    if (avail < needBytes * 1.1) {
        throw new Error(`Nedovoljno prostora na ${sessionDir} — potrebno ~${humanBytes(needBytes)}, slobodno ${humanBytes(avail)}`);
    }
    console.log("");

    if (DRY_RUN) {
        const preview = { parts: buildParts(probed.map((p) => ({ ...p, duration_sec: p.yt_duration_sec }))) };
        console.log("🧪 DRY RUN — planirana globalna vremenska os (prema YouTube trajanjima):");
        for (const p of preview.parts) {
            console.log(`   Dio ${p.part}: ${secondsToHms(p.start_global_sec)} → ${secondsToHms(p.end_global_sec)}  (offset ${p.offset_global_sec}s, ${p.video_id})`);
        }
        const probeSec = Math.floor(totalDuration(preview) / 2);
        const link = globalToYoutube(preview, probeSec);
        console.log(`   🔗 Primjer: globalna ${secondsToHms(probeSec)} → ${link.url}`);
        console.log("\n   (ništa nije preuzeto)\n");
        return;
    }

    fs.mkdirSync(rawDir, { recursive: true });
    fs.mkdirSync(audioDir, { recursive: true });

    // --- Preuzimanje + konverzija ---
    const measured = [];
    let idx = 0;
    for (const part of probed) {
        if (ONLY_PART !== null && part.part !== ONLY_PART) continue;
        if (idx++ > 0) await new Promise((r) => setTimeout(r, DELAY_BETWEEN_DOWNLOADS_MS));

        console.log(`▶️  Dio ${part.part}/${probed.length} — ${part.label || part.title || ""}`);
        const rawFile = await downloadPart(part, rawDir);
        const { wavFile, duration_sec, duration_samples } = await convertPart(part, rawFile, audioDir);

        // Drift = razlika izmjerenog WAV-a i YouTubeove osi. Deep link se računa iz
        // WAV osi, pa drift izravno pomiče svaki link u tom (i svakom sljedećem) dijelu.
        const drift = duration_sec - part.yt_duration_sec;
        if (Math.abs(drift) > DRIFT_WARN_SEC) {
            console.warn(`   ⚠️  DRIFT ${drift.toFixed(2)}s u dijelu ${part.part} — deep linkovi nizvodno će biti pomaknuti za toliko`);
        }

        measured.push({
            part: part.part,
            video_id: part.video_id,
            url: `https://www.youtube.com/watch?v=${part.video_id}`,
            title: part.title || part.yt_title || null,
            label: part.label || null,
            upload_date: part.upload_date || null,
            raw_file: path.relative(sessionDir, rawFile),
            wav_file: path.relative(sessionDir, wavFile),
            duration_sec,
            duration_samples,
            yt_duration_sec: part.yt_duration_sec,
            drift_sec: Math.round(drift * 1000) / 1000,
        });
        console.log("");
    }

    if (ONLY_PART !== null) {
        console.log(`✅ Dio ${ONLY_PART} obrađen. Manifest se NE piše za djelomičnu obradu — pokreni bez --only-part.\n`);
        return;
    }

    // --- Spajanje ---
    const parts = buildParts(measured);
    let stitched = null;
    if (!NO_STITCH) {
        console.log("🧵 Spajanje...");
        stitched = await stitch(parts, audioDir);
        console.log("");
    }

    // --- Manifest ---
    const manifest = {
        session_id: cfg.session_id,
        title: cfg.title || null,
        date: cfg.date || null,
        topic: cfg.topic || null,
        channel: cfg.channel || null,
        source_config: path.relative(REPO_ROOT, cfg._path),
        generated_at: new Date().toISOString(),
        audio: {
            sample_rate: 16000,
            channels: 1,
            encoding: "pcm_s16le",
            stitched: Boolean(stitched),
            full_session_wav: stitched ? path.relative(sessionDir, stitched.file) : null,
        },
        total_duration_sec: totalDuration({ parts }),
        total_duration_samples: parts.every((p) => Number.isInteger(p.duration_samples))
            ? parts.reduce((s, p) => s + p.duration_samples, 0)
            : null,
        total_duration_hms: secondsToHms(totalDuration({ parts })),
        total_drift_sec: Math.round(parts.reduce((s, p) => s + p.drift_sec, 0) * 1000) / 1000,
        parts,
    };

    const manifestPath = path.join(sessionDir, "session_manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`   ✅ FAZA 01 gotova — ${secondsToHms(manifest.total_duration_sec)} (${(manifest.total_duration_sec / 3600).toFixed(2)} h)`);
    for (const p of parts) {
        console.log(`      Dio ${p.part}: ${secondsToHms(p.start_global_sec)} → ${secondsToHms(p.end_global_sec)}  ${p.video_id}  drift ${p.drift_sec >= 0 ? "+" : ""}${p.drift_sec}s`);
    }
    console.log(`   📄 ${path.relative(REPO_ROOT, manifestPath)}`);
    if (stitched) console.log(`   🎧 ${path.relative(REPO_ROOT, stitched.file)} (${humanBytes(fs.statSync(stitched.file).size)})`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");
}

main().catch((err) => {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
});
