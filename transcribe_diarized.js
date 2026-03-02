#!/usr/bin/env node

/**
 * transcribe_diarized.js
 *
 * HIBRIDNI PRISTUP za diarizaciju:
 *   1. whisper.cpp (Metal GPU) → brza transkripcija → .wav.srt
 *   2. pyannote (MPS/Metal GPU) → samo diarizacija govornika
 *   3. Spajanje: dodaje oznake govornika u postojeći SRT → .wav.diarized.srt
 *
 * Ovo je PUNO brže od čistog WhisperX-a na Apple Silicon jer:
 *   - whisper.cpp koristi Metal GPU za transkripciju (već gotovo iz pipeline-a)
 *   - pyannote koristi MPS (PyTorch Metal) za diarizaciju
 *   - Izbjegava se CTranslate2 koji radi samo na CPU
 *
 * PREDUVJETI:
 *   1. Postojeći .wav.srt datoteke (generirane s transcribe.js / whisper.cpp)
 *   2. Python 3 s instaliranim pyannote.audio i torch
 *   3. HuggingFace token s pristupom pyannote modelima
 *
 * Primjer:
 *   node transcribe_diarized.js --channel domovina_tv --hf-token TVOJ_TOKEN
 *   node transcribe_diarized.js --channel domovina_tv --hf-token TVOJ_TOKEN --dry-run
 *   node transcribe_diarized.js --hf-token TVOJ_TOKEN  (svi kanali)
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- KONFIGURACIJA ---
const LISTS_DIR = path.join(__dirname, "automatic", "podcasts");
const DEFAULT_OUTPUT_DIR = "/Volumes/DOMOVINA1TB/fetch_domovina_tv_output";
const DIARIZE_SCRIPT = path.join(__dirname, "diarize.py");

// --- POMOĆNE FUNKCIJE ---

function sanitizeDescription(str) {
    if (!str) return "nepoznat_naslov";
    str = str.toLowerCase();
    const map = {
        'č': 'c', 'ć': 'c', 'ž': 'z', 'š': 's', 'đ': 'd',
        'Č': 'c', 'Ć': 'c', 'Ž': 'z', 'Š': 's', 'Đ': 'd'
    };
    str = str.replace(/[čćžšđČĆŽŠĐ]/g, (char) => map[char] || char);
    str = str.replace(/[^a-z0-9]/g, '_');
    str = str.replace(/_+/g, '_').replace(/^_|_$/g, '');
    return str || "nepoznat_naslov";
}

function extractVideoId(url) {
    url = url.trim();
    if (!url) return null;
    const m = url.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

function extractDataFromLine(line) {
    line = line.trim();
    if (!line || line.startsWith("#")) return null;
    if (line.includes("|")) {
        const parts = line.split("|");
        const url = parts[parts.length - 1].trim();
        let title = "nepoznat_naslov";
        let date = "NA";
        if (parts.length >= 3) {
            date = parts[0].trim();
            title = parts.slice(1, parts.length - 1).join(" ").trim();
        } else if (parts.length === 2) {
            title = parts[0].trim();
        }
        return { url, title, date };
    }
    return { url: line, title: "nepoznat_naslov", date: "NA" };
}

function loadState(stateFile) {
    if (fs.existsSync(stateFile)) {
        try {
            return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        } catch (e) {
            console.error(`[GREŠKA] Neispravan JSON stanja: ${stateFile}`);
        }
    }
    return { completed: [], failed: [] };
}

function findFile(outputDir, videoId, suffix) {
    if (!fs.existsSync(outputDir)) return null;
    const files = fs.readdirSync(outputDir);
    const match = files.find(f =>
        !f.startsWith("._") && f.includes(`_yt_${videoId}`) && f.endsWith(suffix)
    );
    return match ? path.join(outputDir, match) : null;
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
}

// --- DIARIZACIJA (poziva Python skriptu) ---

/**
 * Pokreće diarize.py koji:
 *   1. Učita pyannote model na MPS (Metal GPU)
 *   2. Odradi samo diarizaciju (prepoznavanje govornika)
 *   3. Spoji oznake govornika s postojećim whisper.cpp SRT-om
 *   4. Spremi kao .wav.diarized.srt
 */
function runDiarization(wavFile, srtFile, outputFile, hfToken) {
    const args = [
        DIARIZE_SCRIPT,
        "--wav", wavFile,
        "--srt", srtFile,
        "--output", outputFile,
        "--hf-token", hfToken,
    ];

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
        const proc = spawn("python3", args, { stdio: "inherit" });

        proc.on("close", (code) => {
            const elapsed = (Date.now() - startTime) / 1000;
            if (code === 0) {
                resolve({ elapsed });
            } else {
                reject(new Error(`diarize.py exit code: ${code} (trajalo: ${formatDuration(elapsed)})`));
            }
        });

        proc.on("error", (err) => {
            reject(new Error(`Nije moguće pokrenuti python3: ${err.message}. Je li Python 3 instaliran?`));
        });
    });
}

// --- GLAVNI TOK ---

async function main() {
    const args = process.argv.slice(2);
    const outputDirIdx = args.indexOf("--output-dir");
    const baseOutputDir = outputDirIdx !== -1 ? args[outputDirIdx + 1] : DEFAULT_OUTPUT_DIR;
    const dryRun = args.includes("--dry-run");
    const channelIdx = args.indexOf("--channel");
    const channelFilter = channelIdx !== -1 ? args[channelIdx + 1] : null;

    // HF token
    const tokenIdx = args.indexOf("--hf-token");
    const hfToken = tokenIdx !== -1 ? args[tokenIdx + 1] : null;

    if (!hfToken && !dryRun) {
        console.error("❌ HuggingFace token je OBAVEZAN za diarizaciju.");
        console.error("   Dodaj: --hf-token TVOJ_TOKEN");
        process.exit(1);
    }

    // Provjera preduvjeta
    if (!fs.existsSync(DIARIZE_SCRIPT)) {
        console.error(`❌ Python skripta ne postoji: ${DIARIZE_SCRIPT}`);
        process.exit(1);
    }
    if (!fs.existsSync(LISTS_DIR)) {
        console.error(`❌ Nema direktorija s listama: ${LISTS_DIR}`);
        process.exit(1);
    }
    if (!fs.existsSync(baseOutputDir)) {
        console.error(`❌ Output direktorij ne postoji: ${baseOutputDir}`);
        process.exit(1);
    }

    let listFiles = fs.readdirSync(LISTS_DIR)
        .filter(f => f.endsWith("-lista.txt"))
        .map(f => path.join(LISTS_DIR, f));

    if (channelFilter) {
        listFiles = listFiles.filter(f => {
            const filename = path.basename(f).replace("-lista.txt", "").replace(".txt", "");
            return sanitizeDescription(filename) === channelFilter;
        });
        if (listFiles.length === 0) {
            console.error(`❌ Kanal "${channelFilter}" nije pronađen.`);
            fs.readdirSync(LISTS_DIR)
                .filter(f => f.endsWith("-lista.txt"))
                .forEach(f => {
                    const name = sanitizeDescription(path.basename(f).replace("-lista.txt", ""));
                    console.error(`     - ${name}`);
                });
            process.exit(1);
        }
    }

    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   🗣️  HIBRIDNA DIARIZACIJA                      ║");
    console.log("║   whisper.cpp (Metal) + pyannote (MPS)          ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📂 Liste: ${LISTS_DIR}`);
    console.log(`   💾 Output: ${baseOutputDir}`);
    if (channelFilter) console.log(`   🎯 Kanal: ${channelFilter}`);
    console.log(`   📋 Lista datoteka: ${listFiles.length}`);
    if (dryRun) console.log("   ⚠️  DRY RUN - samo prikaz");
    console.log("");

    let totalDiarized = 0;
    let totalSkipped = 0;
    let totalMissingSrt = 0;
    let totalMissingWav = 0;
    let totalErrors = 0;
    let totalElapsed = 0;

    for (const listFile of listFiles) {
        const filename = path.basename(listFile).replace("-lista.txt", "").replace(".txt", "");
        const channelName = sanitizeDescription(filename);
        const outputDir = path.join(baseOutputDir, channelName);
        const stateFile = listFile.replace(".txt", "-state.json");
        const state = loadState(stateFile);

        const rawLines = fs.readFileSync(listFile, "utf-8").split("\n");
        const entries = rawLines
            .map(line => {
                const data = extractDataFromLine(line);
                if (!data) return null;
                const videoId = extractVideoId(data.url);
                return videoId ? { videoId, title: data.title } : null;
            })
            .filter(e => e !== null);

        const completedEntries = entries.filter(e => state.completed.includes(e.videoId));
        if (completedEntries.length === 0) continue;

        console.log(`\n🔵 [${channelName.toUpperCase()}] — ${completedEntries.length} video zapisa`);

        for (const entry of completedEntries) {
            const wavFile = findFile(outputDir, entry.videoId, ".wav");
            if (!wavFile) {
                console.log(`   ⚠️  WAV nije pronađen za: ${entry.videoId}`);
                totalMissingWav++;
                continue;
            }

            // Provjeri postoji li whisper.cpp SRT (preduvjet!)
            const srtFile = wavFile + ".srt";
            if (!fs.existsSync(srtFile)) {
                console.log(`   ⏭️  [NEMA SRT] ${path.basename(wavFile)} — najprije pokreni transcribe.js`);
                totalMissingSrt++;
                continue;
            }

            // Provjeri je li diarized SRT već generiran
            const diarizedSrtFile = wavFile + ".diarized.srt";
            if (fs.existsSync(diarizedSrtFile)) {
                console.log(`   ⏭️  [POSTOJI] ${path.basename(diarizedSrtFile)}`);
                totalSkipped++;
                continue;
            }

            const baseName = path.basename(wavFile, ".wav");

            if (dryRun) {
                console.log(`   🔄 [DIARIZIRAO BI] ${baseName}`);
                console.log(`      📄 SRT ulaz: ${path.basename(srtFile)}`);
                console.log(`      📄 Izlaz:    ${path.basename(diarizedSrtFile)}`);
                totalDiarized++;
                continue;
            }

            try {
                console.log(`\n   🗣️  [DIARIZIRAM] ${baseName}`);
                console.log(`      📄 SRT: ${path.basename(srtFile)}`);

                const result = await runDiarization(wavFile, srtFile, diarizedSrtFile, hfToken);
                totalElapsed += result.elapsed;

                console.log(`   ✅ [GOTOVO] ${path.basename(diarizedSrtFile)} (${formatDuration(result.elapsed)})`);
                totalDiarized++;
            } catch (err) {
                console.error(`   ❌ [GREŠKA] ${baseName}: ${err.message}`);
                totalErrors++;
            }
        }
    }

    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║   📊 SAŽETAK DIARIZACIJE                        ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   ✅ Diarizirano:     ${totalDiarized}`);
    console.log(`   ⏭️  Preskočeno:      ${totalSkipped} (već postoji)`);
    console.log(`   📝 Nema SRT-a:      ${totalMissingSrt} (treba transcribe.js)`);
    console.log(`   ⚠️  Nedostaje WAV:   ${totalMissingWav}`);
    console.log(`   ❌ Grešaka:          ${totalErrors}`);
    if (totalElapsed > 0) {
        console.log(`   ⏱️  Ukupno vrijeme:  ${formatDuration(totalElapsed)}`);
    }
    console.log("");
}

main().catch((err) => console.error("Fatal error:", err));
