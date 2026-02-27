#!/usr/bin/env node

/**
 * transcribe.js
 *
 * Pokreće lokalni whisper.cpp CLI za transkripciju WAV datoteka.
 * Koristi whisper_prompt.txt (generiran s generate_whisper_prompt.js)
 * za poboljšanu prepoznavanje hrvatskih imena, pojmova i tech termina.
 *
 * Generira .srt datoteke (titlove) pored izvornih WAV-ova.
 *
 * PREDUVJETI:
 *   1. WAV datoteke (generirane s convert_to_wav.js)
 *   2. whisper_prompt.txt datoteke (generirane s generate_whisper_prompt.js)
 *   3. whisper.cpp buildani CLI binary
 *   4. whisper model (npr. ggml-large-v3-turbo.bin)
 *
 * Primjer:
 *   node transcribe.js --channel domovina_tv
 *   node transcribe.js --channel domovina_tv --dry-run
 *   node transcribe.js  (svi kanali)
 *   node transcribe.js --threads 8
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- KONFIGURACIJA ---
const LISTS_DIR = path.join(__dirname, "automatic", "podcasts");
const DEFAULT_OUTPUT_DIR = "/Volumes/DOMOVINA1TB/fetch_domovina_tv_output";

// Whisper.cpp konfiguracija
const WHISPER_CLI = "/Users/ms/git/ggml-org/whisper.cpp/build/bin/whisper-cli";
const WHISPER_MODEL = "/Users/ms/git/ggml-org/whisper.cpp/models/ggml-large-v3-turbo.bin";
const WHISPER_LANGUAGE = "hr";
const DEFAULT_THREADS = 4;

// --- POMOĆNE FUNKCIJE (isto kao u fetch.js / convert_to_wav.js) ---

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

// --- PRONAĐI DATOTEKE ZA VIDEO ID ---

function findFile(outputDir, videoId, suffix) {
    if (!fs.existsSync(outputDir)) return null;
    const files = fs.readdirSync(outputDir);
    const match = files.find(f =>
        !f.startsWith("._") && f.includes(`_yt_${videoId}`) && f.endsWith(suffix)
    );
    return match ? path.join(outputDir, match) : null;
}

// --- WHISPER TRANSKRIPCIJA ---

/**
 * Formatira trajanje u sekunde u HH:MM:SS format.
 */
function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
}

/**
 * Pokreće whisper-cli za jednu WAV datoteku.
 * Vraća Promise koji se resolve-a kad transkripcija završi.
 */
function runWhisper(wavFile, promptFile, threads) {
    const args = [
        "-m", WHISPER_MODEL,
        "-f", wavFile,
        "-l", WHISPER_LANGUAGE,
        "-osrt",                    // Output u SRT formatu
        "-t", String(threads),      // Broj threadova
    ];

    // Dodaj prompt ako postoji
    if (promptFile && fs.existsSync(promptFile)) {
        const promptContent = fs.readFileSync(promptFile, "utf-8").trim();
        if (promptContent.length > 0) {
            args.push("--prompt", promptContent);
        }
    }

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
        const proc = spawn(WHISPER_CLI, args, { stdio: "inherit" });

        proc.on("close", (code) => {
            const elapsed = (Date.now() - startTime) / 1000;
            if (code === 0) {
                resolve({ elapsed });
            } else {
                reject(new Error(`whisper-cli exit code: ${code} (trajalo: ${formatDuration(elapsed)})`));
            }
        });

        proc.on("error", (err) => {
            reject(new Error(`Nije moguće pokrenuti whisper-cli: ${err.message}. Postoji li binary na: ${WHISPER_CLI}?`));
        });
    });
}

// --- GLAVNI PROGRAM ---

async function main() {
    const args = process.argv.slice(2);
    const outputDirIdx = args.indexOf("--output-dir");
    const baseOutputDir = outputDirIdx !== -1 ? args[outputDirIdx + 1] : DEFAULT_OUTPUT_DIR;
    const dryRun = args.includes("--dry-run");
    const channelIdx = args.indexOf("--channel");
    const channelFilter = channelIdx !== -1 ? args[channelIdx + 1] : null;
    const threadsIdx = args.indexOf("--threads");
    const threads = threadsIdx !== -1 ? parseInt(args[threadsIdx + 1], 10) : DEFAULT_THREADS;

    // Provjeri preduvjete
    if (!fs.existsSync(WHISPER_CLI)) {
        console.error(`❌ whisper-cli binary ne postoji: ${WHISPER_CLI}`);
        process.exit(1);
    }
    if (!fs.existsSync(WHISPER_MODEL)) {
        console.error(`❌ Whisper model ne postoji: ${WHISPER_MODEL}`);
        process.exit(1);
    }
    if (!fs.existsSync(LISTS_DIR)) {
        console.error(`❌ Nema direktorija s listama: ${LISTS_DIR}`);
        process.exit(1);
    }
    if (!fs.existsSync(baseOutputDir)) {
        console.error(`❌ Output direktorij ne postoji: ${baseOutputDir}`);
        console.error(`   Je li disk DOMOVINA1TB mountan?`);
        process.exit(1);
    }

    // Pronađi liste
    let listFiles = fs.readdirSync(LISTS_DIR)
        .filter(f => f.endsWith("-lista.txt"))
        .map(f => path.join(LISTS_DIR, f));

    // Filtriraj po kanalu
    if (channelFilter) {
        listFiles = listFiles.filter(f => {
            const filename = path.basename(f).replace("-lista.txt", "").replace(".txt", "");
            const channelName = sanitizeDescription(filename);
            return channelName === channelFilter;
        });
        if (listFiles.length === 0) {
            console.error(`❌ Kanal "${channelFilter}" nije pronađen.`);
            console.error(`   Dostupni kanali:`);
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
    console.log("║   🎙️  WHISPER TRANSKRIPCIJA                     ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📂 Liste: ${LISTS_DIR}`);
    console.log(`   💾 Output: ${baseOutputDir}`);
    console.log(`   🧠 Model: ${path.basename(WHISPER_MODEL)}`);
    console.log(`   🌍 Jezik: ${WHISPER_LANGUAGE}`);
    console.log(`   ⚙️  Threadovi: ${threads}`);
    if (channelFilter) console.log(`   🎯 Kanal: ${channelFilter}`);
    console.log(`   📋 Pronađeno lista: ${listFiles.length}`);
    if (dryRun) console.log("   ⚠️  DRY RUN - samo prikaz, bez transkripcije");
    console.log("");

    let totalTranscribed = 0;
    let totalSkipped = 0;
    let totalMissingWav = 0;
    let totalNoPrompt = 0;
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
                if (!videoId) return null;
                return { videoId, title: data.title };
            })
            .filter(e => e && e.videoId);

        const completedEntries = entries.filter(e => state.completed.includes(e.videoId));
        if (completedEntries.length === 0) continue;

        console.log(`\n🔵 [${channelName.toUpperCase()}] — ${completedEntries.length} video zapisa`);

        for (const entry of completedEntries) {
            // Pronađi WAV
            const wavFile = findFile(outputDir, entry.videoId, ".wav");
            if (!wavFile) {
                console.log(`   ⚠️  WAV nije pronađen za: ${entry.videoId} (${entry.title.substring(0, 40)}...)`);
                console.log(`      💡 Pokreni najprije: node convert_to_wav.js --channel ${channelName}`);
                totalMissingWav++;
                continue;
            }

            // Provjeri je li .srt već generiran
            // whisper-cli kreira output s imenom: {input}.srt (npr. file.wav.srt)
            const srtFile = wavFile + ".srt";
            if (fs.existsSync(srtFile)) {
                console.log(`   ⏭️  [POSTOJI] ${path.basename(srtFile)}`);
                totalSkipped++;
                continue;
            }

            // Pronađi whisper prompt (opcionalan ali preporučen)
            const promptFile = findFile(outputDir, entry.videoId, "_whisper_prompt.txt");
            if (!promptFile) {
                console.log(`   ℹ️  Nema whisper_prompt.txt za: ${entry.videoId} — koristim bez prompta`);
                totalNoPrompt++;
            }

            const baseName = path.basename(wavFile, ".wav");

            if (dryRun) {
                console.log(`   🔄 [TRANSKRIBIRAO BI] ${baseName}`);
                console.log(`      📄 WAV: ${path.basename(wavFile)}`);
                if (promptFile) console.log(`      📝 Prompt: ${path.basename(promptFile)}`);
                totalTranscribed++;
                continue;
            }

            try {
                console.log(`\n   🎙️  [TRANSKRIBIRAM] ${baseName}`);
                console.log(`      📄 WAV: ${path.basename(wavFile)}`);
                if (promptFile) console.log(`      📝 Prompt: ${path.basename(promptFile)}`);
                console.log(`      ⏳ Ovo može potrajati...`);

                const result = await runWhisper(wavFile, promptFile, threads);
                totalElapsed += result.elapsed;

                console.log(`   ✅ [GOTOVO] ${baseName}.srt (${formatDuration(result.elapsed)})`);
                totalTranscribed++;

            } catch (err) {
                console.error(`   ❌ [GREŠKA] ${baseName}: ${err.message}`);
                totalErrors++;
            }
        }
    }

    // --- SAŽETAK ---
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║   📊 SAŽETAK                                    ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   ✅ Transkribirano:   ${totalTranscribed}`);
    console.log(`   ⏭️  Preskočeno:      ${totalSkipped} (SRT već postoji)`);
    console.log(`   ⚠️  Nedostaje WAV:   ${totalMissingWav}`);
    console.log(`   ℹ️  Bez prompta:     ${totalNoPrompt}`);
    console.log(`   ❌ Grešaka:          ${totalErrors}`);
    if (totalElapsed > 0) {
        console.log(`   ⏱️  Ukupno vrijeme:  ${formatDuration(totalElapsed)}`);
    }
    console.log("");
}

main().catch((err) => console.error("Fatal error:", err));
