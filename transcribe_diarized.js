#!/usr/bin/env node

/**
 * transcribe_diarized.js
 *
 * Pokreće whisperx za transkripciju i diarizaciju (raspoznavanje govornika).
 * 
 * IZLAZ:
 *   Neće pregaziti postojeće .wav.srt datoteke generirane s whisper.cpp.
 *   Umjesto toga, rezultat sprema kao: .wav.diarized.srt
 *
 * PREDUVJETI:
 *   1. Instaliran whisperx (dostupan u PATH-u, npr. iz conda environmenta)
 *   2. HuggingFace Token s pristupom pyannote modelima (za diarizaciju)
 *   3. Konvertirane .wav datoteke u output direktorijima
 *
 * Primjer:
 *   node transcribe_diarized.js --channel domovina_tv --hf-token TVOJ_TOKEN
 *   node transcribe_diarized.js --channel domovina_tv --hf-token TVOJ_TOKEN --dry-run
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- KONFIGURACIJA ---
const LISTS_DIR = path.join(__dirname, "automatic", "podcasts");
const DEFAULT_OUTPUT_DIR = "/Volumes/DOMOVINA1TB/fetch_domovina_tv_output";
const WHISPERX_BIN = "whisperx";
const WHISPER_MODEL = "large-v3";
const WHISPER_LANGUAGE = "hr";

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

// --- WHISPERX IZVRŠAVANJE ---

/**
 * Pokreće whisperx, a zatim preimenuje generirani SRT 
 * da ne bi prebrisao onaj od originalnog whisper.cpp.
 */
function runWhisperX(wavFile, hfToken, outputDir) {
    return new Promise((resolve, reject) => {
        // WhisperX briše ekstenziju pa za file.wav generira file.srt (ili sl.) u outputDir-u
        // Zato moramo znati točno ime fajla koje očekujemo dobiti nazad.
        const baseName = path.basename(wavFile, ".wav");
        const expectedSrtPath = path.join(outputDir, baseName + ".srt");
        const finalSrtPath = path.join(outputDir, baseName + ".wav.diarized.srt");

        // Da bismo izbjegli da WhisperX pregazi već postojeći file.srt (od recimo whisper.cpp),
        // privremeno ćemo sakriti postojeći file.srt ako postoji.
        const backupSrtPath = expectedSrtPath + ".backup.tmp";
        let backupCreated = false;

        if (fs.existsSync(expectedSrtPath)) {
            fs.renameSync(expectedSrtPath, backupSrtPath);
            backupCreated = true;
        }

        const args = [
            wavFile,
            "--model", WHISPER_MODEL,
            "--language", WHISPER_LANGUAGE,
            "--diarize",
            "--hf_token", hfToken,
            "--output_dir", outputDir,
            "--output_format", "srt",
            "--compute_type", "int8",  // CPU/Mac MPS ne podržava efikasno float16 u ovom backendu
            // whisperx ne prima --prompt parametar nažalost (bez kompliciranijeg setupa)
        ];

        const startTime = Date.now();
        const proc = spawn(WHISPERX_BIN, args, { stdio: "inherit" });

        proc.on("close", (code) => {
            const elapsed = (Date.now() - startTime) / 1000;

            // Sad WhisperX završi - naš output bi trebao biti u expectedSrtPath (file.srt)
            // Preimenujmo to u naš finalni oblik (file.wav.diarized.srt)
            let success = false;
            if (fs.existsSync(expectedSrtPath)) {
                fs.renameSync(expectedSrtPath, finalSrtPath);
                success = true;
            }

            // Vrati backup na originalno mjesto (čak i ako je ovo failed)
            if (backupCreated) {
                if (fs.existsSync(backupSrtPath)) {
                    // preimenuj file.srt.backup.tmp nazad u file.srt
                    fs.renameSync(backupSrtPath, expectedSrtPath);
                }
            }

            if (code === 0 && success) {
                resolve({ elapsed });
            } else if (code === 0 && !success) {
                reject(new Error(`whisperx je uspješno završio, ali SRT fajl nije kreiran na očekivanoj putanji: ${expectedSrtPath}`));
            } else {
                reject(new Error(`whisperx exit code: ${code} (trajalo: ${formatDuration(elapsed)})`));
            }
        });

        proc.on("error", (err) => {
            if (backupCreated && fs.existsSync(backupSrtPath)) {
                fs.renameSync(backupSrtPath, expectedSrtPath);
            }
            reject(new Error(`Nije possible pokrenuti whisperx: ${err.message}. Je li command line alat instaliran i u PATH-u?`));
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

    // Dohvati HF token
    const tokenIdx = args.indexOf("--hf-token");
    const hfToken = tokenIdx !== -1 ? args[tokenIdx + 1] : null;

    if (!hfToken && !dryRun) {
        console.error("❌ Greška: HuggingFace token je OBAVEZAN za diarizaciju.");
        console.error("   Dodaj parametar: --hf-token TVOJ_TOKEN");
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
            process.exit(1);
        }
    }

    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   🗣️  WHISPER-X DIARIZACIJA (Prepoznavanje govornika)║");
    console.log("╚══════════════════════════════════════════════════╝");
    if (channelFilter) console.log(`   🎯 Kanal: ${channelFilter}`);
    console.log(`   🧠 Model: ${WHISPER_MODEL}`);
    if (dryRun) console.log("   ⚠️  DRY RUN - samo prikaz, bez izvršavanja");
    console.log("");

    let totalTranscribed = 0;
    let totalSkipped = 0;
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

            // Izbjegni prebrisavanje - traži onaj s extenzijom .diarized.srt
            const baseName = path.basename(wavFile, ".wav");
            const finalSrtPath = path.join(outputDir, baseName + ".wav.diarized.srt");

            if (fs.existsSync(finalSrtPath)) {
                console.log(`   ⏭️  [POSTOJI] ${path.basename(finalSrtPath)}`);
                totalSkipped++;
                continue;
            }

            if (dryRun) {
                console.log(`   🔄 [DIARIZIRAO BI] ${baseName}`);
                console.log(`      📄 Izlaz će biti: ${path.basename(finalSrtPath)}`);
                totalTranscribed++;
                continue;
            }

            try {
                console.log(`\n   🗣️  [DIARIZIRAM] ${baseName}`);
                console.log(`      ⏳ Pokrećem whisperx, ovo može potrajati...`);

                const result = await runWhisperX(wavFile, hfToken, outputDir);
                totalElapsed += result.elapsed;

                console.log(`   ✅ [GOTOVO] ${path.basename(finalSrtPath)} (${formatDuration(result.elapsed)})`);
                totalTranscribed++;
            } catch (err) {
                console.error(`   ❌ [GREŠKA] ${baseName}: ${err.message}`);
                totalErrors++;
            }
        }
    }

    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║   📊 SAŽETAK DIARIZACIJE                        ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   ✅ Završeno:       ${totalTranscribed}`);
    console.log(`   ⏭️  Preskočeno:      ${totalSkipped}`);
    console.log(`   ⚠️  Nedostaje WAV:   ${totalMissingWav}`);
    console.log(`   ❌ Grešaka:          ${totalErrors}`);
    if (totalElapsed > 0) {
        console.log(`   ⏱️  Ukupno vrijeme:  ${formatDuration(totalElapsed)}`);
    }
}

main().catch((err) => console.error("Fatal error:", err));
