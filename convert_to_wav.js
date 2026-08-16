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
const DEFAULT_OUTPUT_DIR = path.join(__dirname, "storage", "output");

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

// Indeks MP3-ova po direktoriju kanala — readdirSync JEDNOM po kanalu.
//
// Prije ovoga je findAudioFile radio readdir za SVAKI video. Na kanalu s 50k
// datoteka i 316 epizoda to je 15,8 milijuna pročitanih direktorijskih zapisa;
// preko svih 49 kanala 74,2 milijuna po nightly prolazu (izmjereno 2026-08-14).
// Na exFAT-u preko USB-a to je bilo ~0,2 s po videu — otud "Provjeravam… N/M"
// koji traje minutama iako se ništa ne konvertira.
//
// Cache je siguran jer ova skripta NE stvara .mp3 datoteke tijekom rada
// (proizvodi .wav); indeks se ne može ustajati unutar jednog prolaza.
const _mp3IndexCache = new Map();

function getMp3Index(outputDir) {
    let cached = _mp3IndexCache.get(outputDir);
    if (cached) return cached;

    let files;
    try {
        files = fs.readdirSync(outputDir);
    } catch {
        files = [];
    }
    // Ignoriraj macOS ._ resource fork datoteke i izvedene namespace-ove
    // (.loudnorm.mp3 = normalizirani audio, NIJE izvor za transkripciju —
    //  inače nastaje .loudnorm.wav koji Canary lažno transkribira).
    const candidates = files.filter(f =>
        !f.startsWith("._") && !f.includes(".loudnorm.") && f.endsWith(".mp3")
    );

    const byId = new Map();
    for (const f of candidates) {
        const i = f.lastIndexOf("_yt_");
        if (i === -1) continue;
        const id = f.slice(i + 4, f.length - 4); // između _yt_ i .mp3
        if (!byId.has(id)) byId.set(id, path.join(outputDir, f));
    }

    cached = { byId, candidates };
    _mp3IndexCache.set(outputDir, cached);
    return cached;
}

/**
 * Pronađe MP3 datoteku za dani videoId u outputDir.
 * Traži datoteke koje sadrže _yt_{videoId} u imenu.
 */
function findAudioFile(outputDir, videoId) {
    if (!fs.existsSync(outputDir)) return null;

    const { byId, candidates } = getMp3Index(outputDir);

    const exact = byId.get(videoId);
    if (exact) return exact;

    // Fallback na izvorno ponašanje (podniz bilo gdje u imenu) — za slučaj
    // nestandardnog imenovanja koje indeks po točnom ID-u ne pokrije.
    const match = candidates.find(f => f.includes(`_yt_${videoId}`));
    return match ? path.join(outputDir, match) : null;
}

/**
 * Trajanje WAV-a u sekundama, izvedeno iz veličine datoteke.
 * Vrijedi samo za naš fiksni format (16kHz mono s16 = 32000 B/s).
 */
function wavDurationSec(wavFile) {
    return (fs.statSync(wavFile).size - 44) / 32000;
}

/**
 * Očekivano trajanje iz yt-dlp .info.json (polje `duration`), ili null.
 */
function expectedDurationSec(mp3File) {
    const infoFile = mp3File.replace(/\.mp3$/, ".info.json");
    try {
        const dur = JSON.parse(fs.readFileSync(infoFile, "utf-8")).duration;
        return typeof dur === "number" && dur > 0 ? dur : null;
    } catch {
        return null;
    }
}

// Krnji WAV = kraći od videa za više od ovoga (mp3 vs video zna odstupiti <1s).
const DURATION_TOLERANCE_SEC = 15;

function isTruncated(wavFile, mp3File) {
    const expected = expectedDurationSec(mp3File);
    if (expected === null) return false; // bez info.json ne možemo suditi
    return wavDurationSec(wavFile) < expected - DURATION_TOLERANCE_SEC;
}

/**
 * Konvertira audio datoteku u WAV koristeći ffmpeg.
 * Vraća put do WAV datoteke ako je uspješno, ili null.
 */
function convertToWav(inputFile) {
    const wavFile = inputFile.replace(/\.mp3$/, ".wav");

    // Preskoči ako WAV već postoji — ali krnji WAV (npr. ffmpeg ubijen ili pun
    // disk usred konverzije) NE smije proći kao gotov: nizvodno bi nastao
    // odrezan transkript i article. Obriši ga i konvertiraj ispočetka.
    if (fs.existsSync(wavFile)) {
        if (!isTruncated(wavFile, inputFile)) {
            return { wavFile, skipped: true };
        }
        console.warn(`   ⚠️ Krnji WAV (${Math.round(wavDurationSec(wavFile))}s < video) — brišem i konvertiram ponovno: ${path.basename(wavFile)}`);
        fs.unlinkSync(wavFile);
    }

    const args = [
        "-i", inputFile,
        ...FFMPEG_WAV_ARGS,
        "-y",  // Overwrite bez pitanja
        wavFile
    ];

    // Na grešci obriši parcijalni output — ostatak pipelinea provjerava samo
    // postojanje WAV-a, pa bi ga krnji ostatak trajno trovao.
    const cleanupPartial = () => {
        try { if (fs.existsSync(wavFile)) fs.unlinkSync(wavFile); } catch {}
    };

    return new Promise((resolve, reject) => {
        const proc = spawn("ffmpeg", args, { stdio: "inherit" });
        proc.on("close", (code) => {
            if (code !== 0) {
                cleanupPartial();
                return reject(new Error(`ffmpeg exit code: ${code} za ${inputFile}`));
            }
            // ffmpeg zna izaći s 0 iako je izlaz kraći (npr. oštećen izvor) —
            // trajanje mora odgovarati videu prije nego što ide na transkripciju.
            if (isTruncated(wavFile, inputFile)) {
                const got = Math.round(wavDurationSec(wavFile));
                cleanupPartial();
                return reject(new Error(`WAV kraći od videa (${got}s) — obrisan, provjeri disk/izvor: ${inputFile}`));
            }
            resolve({ wavFile, skipped: false });
        });
        proc.on("error", (err) => {
            cleanupPartial();
            reject(err);
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
    // --video-id filter: konvertiraj samo jedan video po YouTube ID-u (11 znakova)
    const videoIdIdx = args.indexOf("--video-id");
    const videoIdFilter = videoIdIdx !== -1 ? args[videoIdIdx + 1] : null;

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

    // Sastavi poslove po kanalu. Normalni kanali dolaze iz *-lista.txt.
    // "_"-prefiksani kanali (npr. _unlisted iz `fetch.js --unlisted-url`) NEMAJU
    // listu — videi se čitaju direktno iz {channel}-state.json (completed[]). Time
    // ad-hoc/unlisted ulaz prolazi kroz konverziju identično, a ostaje neindeksiran.
    let channelJobs;
    if (channelFilter && channelFilter.startsWith("_")) {
        const stateFile = path.join(LISTS_DIR, `${channelFilter}-state.json`);
        if (!fs.existsSync(stateFile)) {
            console.error(`❌ Unlisted kanal "${channelFilter}" nema state datoteku: ${stateFile}`);
            process.exit(1);
        }
        channelJobs = [{ channelName: channelFilter, listFile: null, stateFile }];
    } else {
        if (channelFilter) {
            listFiles = listFiles.filter(f => {
                const filename = path.basename(f).replace("-lista.txt", "").replace(".txt", "");
                return sanitizeDescription(filename) === channelFilter;
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
        channelJobs = listFiles.map(f => ({
            channelName: sanitizeDescription(path.basename(f).replace("-lista.txt", "").replace(".txt", "")),
            listFile: f,
            stateFile: f.replace(".txt", "-state.json"),
        }));

        // Bez --channel (puni nightly/manualni run): pokupi i "_"-prefiksane kanale
        // (npr. _unlisted iz studio.domovina.ai queuea) koji nemaju listu nego samo
        // {channel}-state.json. Tako svaki puni run obradi unlisted videe bez da
        // bridge mora eksplicitno zvati konverziju. (Eksplicitan --channel ih ne dira.)
        if (!channelFilter && fs.existsSync(baseOutputDir)) {
            for (const entry of fs.readdirSync(baseOutputDir)) {
                if (!entry.startsWith("_")) continue;
                const sf = path.join(LISTS_DIR, `${entry}-state.json`);
                if (fs.existsSync(sf)) channelJobs.push({ channelName: entry, listFile: null, stateFile: sf });
            }
        }
    }

    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   🎵 KONVERZIJA AUDIO → WAV (za Whisper)        ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📂 Liste: ${LISTS_DIR}`);
    console.log(`   💾 Output: ${baseOutputDir}`);
    if (channelFilter) console.log(`   🎯 Kanal: ${channelFilter}`);
    if (videoIdFilter) console.log(`   🎯 Video ID: ${videoIdFilter}`);
    console.log(`   📋 Kanala za obradu: ${channelJobs.length}`);
    if (dryRun) console.log("   ⚠️  DRY RUN - samo prikaz, bez konverzije");
    console.log("");

    let totalConverted = 0;
    let totalSkipped = 0;
    let totalMissing = 0;
    let totalErrors = 0;

    for (const job of channelJobs) {
        const { channelName, listFile, stateFile } = job;
        const outputDir = path.join(baseOutputDir, channelName);
        const state = loadState(stateFile);

        // Video podaci: iz liste (normalni kanal) ili iz state.completed (_unlisted).
        let entries;
        if (listFile) {
            const rawLines = fs.readFileSync(listFile, "utf-8").split("\n");
            entries = rawLines
                .map(line => {
                    const data = extractDataFromLine(line);
                    if (!data) return null;
                    const videoId = extractVideoId(data.url);
                    if (!videoId) return null;
                    return { videoId, title: data.title };
                })
                .filter(e => e && e.videoId);
        } else {
            entries = state.completed.map(videoId => ({ videoId, title: "unlisted" }));
        }

        // Samo completed video ID-ovi
        let completedEntries = entries.filter(e => state.completed.includes(e.videoId));

        // --video-id filter: zadrži samo zadani video
        if (videoIdFilter) {
            completedEntries = completedEntries.filter(e => e.videoId === videoIdFilter);
        }

        if (completedEntries.length === 0) continue;

        console.log(`\n🔵 [${channelName.toUpperCase()}] — ${completedEntries.length} completed audio zapisa`);

        let channelSkipped = 0;
        const channelStart = Date.now();

        for (const entry of completedEntries) {
            const mp3File = findAudioFile(outputDir, entry.videoId);

            if (!mp3File) {
                totalMissing++;
                continue;
            }

            const wavFile = mp3File.replace(/\.mp3$/, ".wav");

            if (dryRun) {
                if (fs.existsSync(wavFile)) {
                    channelSkipped++;
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
                    channelSkipped++;
                    totalSkipped++;
                    const elapsed = ((Date.now() - channelStart) / 1000).toFixed(1);
                    process.stdout.write(`   ⏭️  Provjeravam... ${channelSkipped}/${completedEntries.length} (${elapsed}s)\r`);
                } else {
                    if (channelSkipped > 0) process.stdout.write("\r\x1b[K");
                    console.log(`   ✅ [KONVERTIRANO] ${path.basename(result.wavFile)}`);
                    totalConverted++;
                }
            } catch (err) {
                if (channelSkipped > 0) process.stdout.write("\r\x1b[K");
                console.error(`   ❌ [GREŠKA] ${path.basename(mp3File)}: ${err.message}`);
                totalErrors++;
            }
        }

        // Završni ispis za kanal (prepiši progress liniju)
        if (channelSkipped > 0) {
            const elapsed = ((Date.now() - channelStart) / 1000).toFixed(1);
            process.stdout.write("\r\x1b[K");
            console.log(`   ⏭️  ${channelSkipped} već konvertiranih (${elapsed}s)`);
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

    // Exit kod ≠ 0 da pozivatelji (run_pipeline*.sh) mogu fatalno reagirati
    // u single-video fast-pathu umjesto da nastave bez WAV-a.
    if (totalErrors > 0) process.exit(1);
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
