#!/usr/bin/env node

/**
 * transcribe_nvidia_canary.mjs
 *
 * Koristi remote NVIDIA Canary 1B v2 HuggingFace Space za transkripciju WAV datoteka.
 * Uploadira WAV datoteke na https://huggingface.co/spaces/nvidia/canary-1b-v2
 * i downloada generirane SRT i CSV transkripte.
 *
 * VAŽNO: Ova skripta NIKADA ne briše postojeće datoteke.
 *        Kreira samo nove s .canary.srt i .canary.csv sufiksima.
 *
 * Koristi isti --channel pattern kao transcribe.js i transcribe_diarized.js:
 *   - Iterira -lista.txt datoteke u automatic/podcasts/
 *   - Koristi state JSON za pronalaženje completed video zapisa
 *   - Traži WAV datoteke po videoId-u u per-channel output direktorijima
 *
 * PREDUVJETI:
 *   1. WAV datoteke (generirane s convert_to_wav.js)
 *   2. npm install @gradio/client
 *   3. HuggingFace token (preporučeno za veću GPU kvotu)
 *      - Free plan: 60s GPU/dan
 *      - PRO plan ($9/mj): 5x više GPU kvote
 *      - Token: https://huggingface.co/settings/tokens
 *
 * Primjer:
 *   node transcribe_nvidia_canary.mjs --channel domovina_tv --hf-token hf_xxx
 *   node transcribe_nvidia_canary.mjs --channel domovina_tv --hf-token hf_xxx --dry-run
 *   node transcribe_nvidia_canary.mjs --hf-token hf_xxx  (svi kanali)
 *   node transcribe_nvidia_canary.mjs --file /path/to/file.wav --hf-token hf_xxx
 */

import { Client, handle_file } from "@gradio/client";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- KONFIGURACIJA ---
const HF_SPACE = "nvidia/canary-1b-v2";
const API_ENDPOINT = "/transcribe_file";
const LISTS_DIR = path.join(__dirname, "automatic", "podcasts");
const DEFAULT_OUTPUT_DIR = "/Volumes/DOMOVINA1TB/fetch_domovina_tv_output";
const DEFAULT_SOURCE_LANG = "Croatian";
const DEFAULT_TARGET_LANG = "Croatian";

// Output sufiksi — potpuno odvojeni od postojećih .wav.srt datoteka
const CANARY_SRT_SUFFIX = ".canary.srt";
const CANARY_CSV_SUFFIX = ".canary.csv";

// --- POMOĆNE FUNKCIJE (iste kao u transcribe.js / transcribe_diarized.js) ---

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

/**
 * Parsira CLI argumente.
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        outputDir: DEFAULT_OUTPUT_DIR,
        sourceLang: DEFAULT_SOURCE_LANG,
        targetLang: DEFAULT_TARGET_LANG,
        dryRun: false,
        singleFile: null,
        channelFilter: null,
        hfToken: null,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--output-dir":
                config.outputDir = args[++i];
                break;
            case "--channel":
                config.channelFilter = args[++i];
                break;
            case "--source-lang":
                config.sourceLang = args[++i];
                break;
            case "--target-lang":
                config.targetLang = args[++i];
                break;
            case "--dry-run":
                config.dryRun = true;
                break;
            case "--file":
                config.singleFile = args[++i];
                break;
            case "--hf-token":
                config.hfToken = args[++i];
                break;
            case "--help":
            case "-h":
                console.log(`
Korištenje: node transcribe_nvidia_canary.mjs [opcije]

Opcije:
  --channel <name>      Kanal za transkripciju (npr. domovina_tv)
  --hf-token <token>    HuggingFace API token (preporučeno za veću GPU kvotu)
  --output-dir <path>   Output direktorij (default: ${DEFAULT_OUTPUT_DIR})
  --file <path>         Pojedinačna WAV datoteka za transkripciju
  --source-lang <lang>  Izvorni jezik (default: ${DEFAULT_SOURCE_LANG})
  --target-lang <lang>  Ciljni jezik (default: ${DEFAULT_TARGET_LANG})
  --dry-run             Samo prikaz, bez uploada
  --help, -h            Prikaži pomoć

GPU kvota (ZeroGPU):
  Bez tokena:   anonimna kvota (~60s GPU/dan)
  Free token:   veća kvota
  PRO plan:     5x veća kvota ($9/mj — https://huggingface.co/pro)

Primjeri:
  node transcribe_nvidia_canary.mjs --channel domovina_tv --hf-token hf_xxx
  node transcribe_nvidia_canary.mjs --channel domovina_tv --dry-run
  node transcribe_nvidia_canary.mjs --hf-token hf_xxx  (svi kanali)
  node transcribe_nvidia_canary.mjs --file /path/to/file.wav --hf-token hf_xxx
`);
                process.exit(0);
        }
    }

    return config;
}

/**
 * Downloada datoteku s URL-a i sprema je lokalno.
 * NIKADA ne prepisuje postojeće datoteke.
 */
async function downloadFile(url, outputPath) {
    // Sigurnosna provjera — nikada ne prepiši postojeću datoteku
    if (fs.existsSync(outputPath)) {
        console.log(`      ⚠️  Datoteka već postoji, preskačem: ${path.basename(outputPath)}`);
        return false;
    }

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} pri downloadu: ${url}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);
    return true;
}

/**
 * Transkribira jednu WAV datoteku koristeći NVIDIA Canary HF Space.
 */
async function transcribeFile(client, wavFile, sourceLang, targetLang) {
    const startTime = Date.now();

    const fileSize = fs.statSync(wavFile).size;
    const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    console.log(`      ⏳ Uploadiram WAV (${fileSizeMB} MB)...`);

    // Pročitaj WAV datoteku i pošalji kao Blob
    const wavBuffer = fs.readFileSync(wavFile);
    const wavBlob = new Blob([wavBuffer], { type: "audio/wav" });

    let result;
    try {
        result = await client.predict(API_ENDPOINT, {
            audio_path: handle_file(wavBlob),
            source_lang: sourceLang,
            target_lang: targetLang,
        });
    } catch (err) {
        // Verbose error logging — prikaži puni server response
        console.error(`      🔴 GREŠKA od servera:`);
        console.error(`         Poruka:  ${err.message}`);
        if (err.response) {
            console.error(`         Status:  ${err.response.status} ${err.response.statusText}`);
            try {
                const body = await err.response.text();
                console.error(`         Body:    ${body.substring(0, 500)}`);
            } catch (_) { }
        }
        if (err.name) console.error(`         Tip:     ${err.name}`);
        if (err.code) console.error(`         Kod:     ${err.code}`);
        // Dump svih nestandardnih propertyja errora
        const knownKeys = new Set(['message', 'stack', 'name', 'code', 'response']);
        for (const key of Object.keys(err)) {
            if (!knownKeys.has(key)) {
                try {
                    const val = typeof err[key] === 'object' ? JSON.stringify(err[key], null, 2) : String(err[key]);
                    console.error(`         ${key}: ${val.substring(0, 300)}`);
                } catch (_) { }
            }
        }
        throw err; // Re-throw za processEntry handler
    }

    const elapsed = (Date.now() - startTime) / 1000;

    // result.data = [segmentsDataframe, csvFileInfo, srtFileInfo]
    const csvFileInfo = result.data[1];
    const srtFileInfo = result.data[2];

    return { csvFileInfo, srtFileInfo, elapsed };
}

/**
 * Obradi jedan WAV zapis: upload + download rezultata.
 * Vraća true ako je transkribiran, false ako preskočen.
 */
async function processEntry(client, wavFile, config) {
    const srtOutput = wavFile + CANARY_SRT_SUFFIX;
    const csvOutput = wavFile + CANARY_CSV_SUFFIX;

    // Već postoji canary transkript?
    if (fs.existsSync(srtOutput)) {
        return { status: "skipped" };
    }

    if (config.dryRun) {
        const size = (fs.statSync(wavFile).size / (1024 * 1024)).toFixed(1);
        console.log(`   🔄 [TRANSKRIBIRAO BI] ${path.basename(wavFile, ".wav")}`);
        console.log(`      📄 WAV: ${path.basename(wavFile)} (${size} MB)`);
        console.log(`         → ${path.basename(srtOutput)}`);
        console.log(`         → ${path.basename(csvOutput)}`);
        return { status: "dry-run" };
    }

    const baseName = path.basename(wavFile, ".wav");
    console.log(`\n   🎙️  [TRANSKRIBIRAM] ${baseName}`);

    const result = await transcribeFile(client, wavFile, config.sourceLang, config.targetLang);

    console.log(`      ⏱️  Transkripcija trajala: ${formatDuration(result.elapsed)}`);

    // Download SRT
    if (result.srtFileInfo && result.srtFileInfo.url) {
        const saved = await downloadFile(result.srtFileInfo.url, srtOutput);
        if (saved) {
            const size = (fs.statSync(srtOutput).size / 1024).toFixed(1);
            console.log(`      ✅ SRT spremljen: ${path.basename(srtOutput)} (${size} KB)`);
        }
    } else {
        console.log(`      ⚠️  SRT nije dostupan u odgovoru.`);
    }

    // Download CSV
    if (result.csvFileInfo && result.csvFileInfo.url) {
        const saved = await downloadFile(result.csvFileInfo.url, csvOutput);
        if (saved) {
            const size = (fs.statSync(csvOutput).size / 1024).toFixed(1);
            console.log(`      ✅ CSV spremljen: ${path.basename(csvOutput)} (${size} KB)`);
        }
    } else {
        console.log(`      ⚠️  CSV nije dostupan u odgovoru.`);
    }

    return { status: "transcribed", elapsed: result.elapsed };
}

// --- GLAVNI PROGRAM ---

async function main() {
    const config = parseArgs();

    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   🐤 NVIDIA CANARY 1B v2 — REMOTE TRANSKRIPCIJA ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   🌐 HF Space: ${HF_SPACE}`);
    console.log(`   � HF Token: ${config.hfToken ? '✅ (proslijeđen)' : '❌ (anonimna kvota — dodaj --hf-token za više GPU vremena)'}`);
    console.log(`   �🗣️  Izvorni jezik: ${config.sourceLang}`);
    console.log(`   💬 Ciljni jezik: ${config.targetLang}`);

    // --- NAČIN 1: Pojedinačna datoteka (--file) ---
    if (config.singleFile) {
        if (!fs.existsSync(config.singleFile)) {
            console.error(`❌ Datoteka ne postoji: ${config.singleFile}`);
            process.exit(1);
        }
        if (!config.singleFile.endsWith(".wav")) {
            console.error(`❌ Datoteka nije WAV: ${config.singleFile}`);
            process.exit(1);
        }

        console.log(`   📄 Pojedinačna datoteka: ${path.basename(config.singleFile)}`);
        if (config.dryRun) console.log("   ⚠️  DRY RUN — samo prikaz, bez uploada");
        console.log("");

        let client = null;
        if (!config.dryRun) {
            console.log("   🔗 Spajam se na HF Space...");
            const connectOpts = config.hfToken ? { hf_token: config.hfToken } : {};
            client = await Client.connect(HF_SPACE, connectOpts);
            console.log("   ✅ Spojeno na NVIDIA Canary 1B v2\n");
        }

        try {
            const result = await processEntry(client, config.singleFile, config);
            if (result.status === "transcribed") {
                console.log(`\n   ✅ Gotovo! (${formatDuration(result.elapsed)})`);
            }
        } catch (err) {
            console.error(`   ❌ Greška: ${err.message}`);
            process.exit(1);
        }
        return;
    }

    // --- NAČIN 2: Po kanalima (--channel ili svi) ---

    // Provjere preduvjeta
    if (!fs.existsSync(LISTS_DIR)) {
        console.error(`❌ Nema direktorija s listama: ${LISTS_DIR}`);
        process.exit(1);
    }
    if (!fs.existsSync(config.outputDir)) {
        console.error(`❌ Output direktorij ne postoji: ${config.outputDir}`);
        console.error(`   Je li disk DOMOVINA1TB mountan?`);
        process.exit(1);
    }

    // Pronađi liste
    let listFiles = fs.readdirSync(LISTS_DIR)
        .filter(f => f.endsWith("-lista.txt"))
        .map(f => path.join(LISTS_DIR, f));

    // Filtriraj po kanalu
    if (config.channelFilter) {
        listFiles = listFiles.filter(f => {
            const filename = path.basename(f).replace("-lista.txt", "").replace(".txt", "");
            return sanitizeDescription(filename) === config.channelFilter;
        });
        if (listFiles.length === 0) {
            console.error(`❌ Kanal "${config.channelFilter}" nije pronađen.`);
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

    console.log(`   📂 Liste: ${LISTS_DIR}`);
    console.log(`   💾 Output: ${config.outputDir}`);
    if (config.channelFilter) console.log(`   🎯 Kanal: ${config.channelFilter}`);
    console.log(`   📋 Pronađeno lista: ${listFiles.length}`);
    if (config.dryRun) console.log("   ⚠️  DRY RUN — samo prikaz, bez uploada");
    console.log("");

    let totalTranscribed = 0;
    let totalSkipped = 0;
    let totalMissingWav = 0;
    let totalDryRun = 0;
    let totalErrors = 0;
    let totalElapsed = 0;

    // Spoji se na HF Space (samo ako nije dry-run)
    let client = null;
    if (!config.dryRun) {
        console.log("   🔗 Spajam se na HF Space...");
        try {
            const connectOpts = config.hfToken ? { hf_token: config.hfToken } : {};
            client = await Client.connect(HF_SPACE, connectOpts);
            console.log("   ✅ Spojeno na NVIDIA Canary 1B v2");
        } catch (err) {
            console.error(`   ❌ Greška pri spajanju: ${err.message}`);
            process.exit(1);
        }
        console.log("");
    }

    for (const listFile of listFiles) {
        const filename = path.basename(listFile).replace("-lista.txt", "").replace(".txt", "");
        const channelName = sanitizeDescription(filename);
        const outputDir = path.join(config.outputDir, channelName);
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
            // Pronađi WAV
            const wavFile = findFile(outputDir, entry.videoId, ".wav");
            if (!wavFile) {
                console.log(`   ⚠️  WAV nije pronađen za: ${entry.videoId} (${entry.title.substring(0, 40)}...)`);
                console.log(`      💡 Pokreni najprije: node convert_to_wav.js --channel ${channelName}`);
                totalMissingWav++;
                continue;
            }

            // Provjeri postoji li canary transkript
            const srtOutput = wavFile + CANARY_SRT_SUFFIX;
            if (fs.existsSync(srtOutput)) {
                console.log(`   ⏭️  [POSTOJI] ${path.basename(srtOutput)}`);
                totalSkipped++;
                continue;
            }

            try {
                const result = await processEntry(client, wavFile, config);
                if (result.status === "transcribed") {
                    totalTranscribed++;
                    totalElapsed += result.elapsed;
                } else if (result.status === "dry-run") {
                    totalDryRun++;
                } else if (result.status === "skipped") {
                    totalSkipped++;
                }
            } catch (err) {
                console.error(`   ❌ [GREŠKA] ${path.basename(wavFile)}: ${err.message}`);
                totalErrors++;

                // Ako je GPU kvota potrošena, nema smisla nastaviti
                if (err.message && (err.message.includes('GPU quota') || err.message.includes('exceeded'))) {
                    console.error(`\n   🛑 GPU kvota potrošena — prekidam obradu.`);
                    console.error(`      💡 Opcije:`);
                    console.error(`         1. Čekaj reset kvote (obično 24h)`);
                    console.error(`         2. Dodaj --hf-token za veću kvotu`);
                    console.error(`         3. Nadogradi na HF PRO ($9/mj) za 5x veću kvotu`);
                    console.error(`            https://huggingface.co/pro`);
                    break;
                }
            }
        }
    }

    // --- SAŽETAK ---
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║   📊 SAŽETAK                                    ║");
    console.log("╚══════════════════════════════════════════════════╝");
    if (config.dryRun) {
        console.log(`   🔄 Za obradu:        ${totalDryRun}`);
    } else {
        console.log(`   ✅ Transkribirano:   ${totalTranscribed}`);
    }
    console.log(`   ⏭️  Preskočeno:      ${totalSkipped} (canary transkript već postoji)`);
    console.log(`   ⚠️  Nedostaje WAV:   ${totalMissingWav}`);
    console.log(`   ❌ Grešaka:          ${totalErrors}`);
    if (totalElapsed > 0) {
        console.log(`   ⏱️  Ukupno vrijeme:  ${formatDuration(totalElapsed)}`);
    }
    console.log("");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
