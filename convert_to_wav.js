#!/usr/bin/env node

/**
 * convert_to_wav.js
 * 
 * Prolazi kroz sve audio datoteke (MP3) preuzete s fetch.js
 * i konvertira ih u WAV format (16kHz, mono, PCM 16-bit LE).
 * 
 * WAV je preduvjet za transkripciju s Whisperom.
 * TODO: Dodati Whisper transkripciju nakon konverzije u WAV.
 * 
 * Koristi iste state JSON datoteke i liste kao fetch.js
 * da bi pronašao sve completed video ID-ove i njihove odgovarajuće
 * audio datoteke na disku.
 * 
 * Primjer:
 *   node convert_to_wav.js
 *   node convert_to_wav.js --output-dir /putanja/do/izlaza
 *   node convert_to_wav.js --dry-run
 *   node convert_to_wav.js --channel domovina_tv
 *   node convert_to_wav.js --channel domovina_tv --dry-run
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- KONFIGURACIJA ---
const LISTS_DIR = path.join(__dirname, "automatic", "podcasts");
const DEFAULT_OUTPUT_DIR = "/Volumes/DOMOVINA1TB/fetch_domovina_tv_output";

// FFmpeg parametri za Whisper-kompatibilni WAV
const FFMPEG_WAV_ARGS = [
    "-ar", "16000",    // Sample rate: 16kHz (Whisper standard)
    "-ac", "1",        // Mono kanal
    "-c:a", "pcm_s16le" // 16-bit PCM Little Endian
];

// --- POMOĆNE FUNKCIJE (isto kao u fetch.js) ---

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

// --- KONVERZIJA ---

/**
 * Pronađe MP3 datoteku za dani videoId u outputDir.
 * Traži datoteke koje sadrže _yt_{videoId} u imenu.
 */
function findAudioFile(outputDir, videoId) {
    if (!fs.existsSync(outputDir)) return null;

    const files = fs.readdirSync(outputDir);
    // Tražimo datoteku koja sadrži _yt_{videoId} i završava na .mp3
    // Ignoriraj macOS ._ resource fork datoteke
    const match = files.find(f =>
        !f.startsWith("._") && f.includes(`_yt_${videoId}`) && f.endsWith(".mp3")
    );

    return match ? path.join(outputDir, match) : null;
}

/**
 * Konvertira audio datoteku u WAV koristeći ffmpeg.
 * Vraća put do WAV datoteke ako je uspješno, ili null.
 */
function convertToWav(inputFile) {
    const wavFile = inputFile.replace(/\.mp3$/, ".wav");

    // Preskoči ako WAV već postoji
    if (fs.existsSync(wavFile)) {
        return { wavFile, skipped: true };
    }

    const args = [
        "-i", inputFile,
        ...FFMPEG_WAV_ARGS,
        "-y",  // Overwrite bez pitanja
        wavFile
    ];

    return new Promise((resolve, reject) => {
        const proc = spawn("ffmpeg", args, { stdio: "inherit" });
        proc.on("close", (code) => {
            if (code === 0) resolve({ wavFile, skipped: false });
            else reject(new Error(`ffmpeg exit code: ${code} za ${inputFile}`));
        });
        proc.on("error", reject);
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

    if (!fs.existsSync(LISTS_DIR)) {
        console.error(`❌ Nema direktorija s listama: ${LISTS_DIR}`);
        process.exit(1);
    }

    if (!fs.existsSync(baseOutputDir)) {
        console.error(`❌ Output direktorij ne postoji: ${baseOutputDir}`);
        console.error(`   Je li disk DOMOVINA1TB mountan?`);
        process.exit(1);
    }

    // Pronađi sve liste
    let listFiles = fs.readdirSync(LISTS_DIR)
        .filter(f => f.endsWith("-lista.txt"))
        .map(f => path.join(LISTS_DIR, f));

    // Filtriraj po kanalu ako je zadan --channel
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
    console.log("║   🎵 KONVERZIJA AUDIO → WAV (za Whisper)        ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📂 Liste: ${LISTS_DIR}`);
    console.log(`   💾 Output: ${baseOutputDir}`);
    if (channelFilter) console.log(`   🎯 Kanal: ${channelFilter}`);
    console.log(`   📋 Pronađeno lista: ${listFiles.length}`);
    if (dryRun) console.log("   ⚠️  DRY RUN - samo prikaz, bez konverzije");
    console.log("");

    let totalConverted = 0;
    let totalSkipped = 0;
    let totalMissing = 0;
    let totalErrors = 0;

    for (const listFile of listFiles) {
        const filename = path.basename(listFile).replace("-lista.txt", "").replace(".txt", "");
        const channelName = sanitizeDescription(filename);
        const outputDir = path.join(baseOutputDir, channelName);
        const stateFile = listFile.replace(".txt", "-state.json");
        const state = loadState(stateFile);

        // Čitaj listu da dobiješ sve video podatke
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

        // Samo completed video ID-ovi
        const completedEntries = entries.filter(e => state.completed.includes(e.videoId));

        if (completedEntries.length === 0) continue;

        console.log(`\n🔵 [${channelName.toUpperCase()}] — ${completedEntries.length} completed audio zapisa`);

        for (const entry of completedEntries) {
            const mp3File = findAudioFile(outputDir, entry.videoId);

            if (!mp3File) {
                console.log(`   ⚠️  MP3 nije pronađen za: ${entry.videoId} (${entry.title.substring(0, 40)}...)`);
                totalMissing++;
                continue;
            }

            const wavFile = mp3File.replace(/\.mp3$/, ".wav");

            if (dryRun) {
                if (fs.existsSync(wavFile)) {
                    console.log(`   ⏭️  [POSTOJI] ${path.basename(wavFile)}`);
                    totalSkipped++;
                } else {
                    console.log(`   🔄 [KONVERTIRAO BI] ${path.basename(mp3File)} → .wav`);
                    totalConverted++;
                }
                continue;
            }

            try {
                const result = await convertToWav(mp3File);
                if (result.skipped) {
                    console.log(`   ⏭️  [POSTOJI] ${path.basename(result.wavFile)}`);
                    totalSkipped++;
                } else {
                    console.log(`   ✅ [KONVERTIRANO] ${path.basename(result.wavFile)}`);
                    totalConverted++;
                }
            } catch (err) {
                console.error(`   ❌ [GREŠKA] ${path.basename(mp3File)}: ${err.message}`);
                totalErrors++;
            }
        }
    }

    // --- SAŽETAK ---
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║   📊 SAŽETAK                                    ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   ✅ Konvertirano:  ${totalConverted}`);
    console.log(`   ⏭️  Preskočeno:   ${totalSkipped} (WAV već postoji)`);
    console.log(`   ⚠️  Nedostaje MP3: ${totalMissing}`);
    console.log(`   ❌ Grešaka:       ${totalErrors}`);
    console.log("");

    // TODO: Ovdje dodati Whisper transkripciju
    // Npr. za svaki .wav -> pokreni whisper i spremi .txt/.srt
    // whisper <file.wav> --model large-v3 --language hr --output_format txt
}

main().catch((err) => console.error("Fatal error:", err));
