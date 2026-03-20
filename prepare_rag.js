#!/usr/bin/env node

/**
 * prepare_rag.js
 *
 * Priprema diariziranih transkripata za import u RAG (Retrieval-Augmented Generation)
 * vektorsku bazu podataka.
 *
 * PRINCIP RADA:
 *   1. Čita .canary.diarized.srt transkripte
 *   2. Čita .canary.summary.json sažetke (generirane s summarize_gemini.js)
 *   3. Primjenjuje SPEAKER-AWARE CHUNKING:
 *      - Grupira uzastopne segmente istog govornika
 *      - Spaja u chunkove od ~500 tokena (poštujući granice govornika)
 *      - Svaki chunk ima bogati metadata za filtrirano pretraživanje
 *   4. Zapisuje JSONL datoteke (jedan JSON objekt po liniji, jedna datoteka
 *      po YouTube videu) — univerzalan format koji svi vector DB-ovi mogu importati
 *
 * ZAŠTO SPEAKER-AWARE CHUNKING?
 *   - Fiksni chunking (npr. 500 znakova) prekida rečenice i govornikove izjave
 *   - Speaker-aware chunking čuva kontekst: "Tko je što rekao"
 *   - Svaki chunk nosi metadata (govornik, teme, naslov, kanal) → precizno
 *     filtrirano pretraživanje u vector DB-u
 *   - Kod dohvata, LLM dobiva koherentan tekst umjesto nasumičnih fragmenata
 *
 * CHUNKING STRATEGIJA:
 *   1. Parsiraj SRT → lista segmenata sa [SPEAKER_XX] + tekst + timestampovi
 *   2. Grupira uzastopne segmente istog govornika u "govorne blokove"
 *   3. Iz svakog govornog bloka gradi chunkove:
 *      - Target veličina: ~500 tokena (~2000 znakova za hrvatski tekst)
 *      - Minimalna veličina: 100 tokena (izbgava mikro-chunkove)
 *      - Nikada ne prekida govornika → chunk kraj = kraj govornog bloka
 *   4. Zamjenjuje SPEAKER_XX s prepoznatim imenima iz summary.json
 *
 * OUTPUT FORMAT (JSONL):
 *   Svaka linija je JSON objekt:
 *   {
 *     "id": "RA4bHbq2MkE_chunk_001",
 *     "text": "[Voditelj] U prvoj epizodi...",
 *     "metadata": { ... }
 *   }
 *
 *   JSONL je odabran jer:
 *   - Streamable (ne zahtijeva cijelu datoteku u memoriji)
 *   - Podržan od svih vector DB-ova (Pinecone, Qdrant, ChromaDB, Weaviate...)
 *   - Lako procesuirati s `jq`, Python, Node.js
 *
 * PREDUVJETI:
 *   - Pokrenuti summarize_gemini.js PRIJE ovog koraka
 *     (chunking radi i bez summary.json, ali metapodaci su siromašniji)
 *
 * Primjeri:
 *   node prepare_rag.js --input-dir /Volumes/DOMOVINA1TB/fetch_domovina_tv_output
 *   node prepare_rag.js --input-dir ... --channel bozanstvena_komedija
 *   node prepare_rag.js --input-dir ... --dry-run
 *   node prepare_rag.js --input-dir ... --output-dir ./rag_export
 *   node prepare_rag.js --input-dir ... --chunk-size 300
 */

const fs = require("fs");
const path = require("path");

// ─── KONFIGURACIJA ───────────────────────────────────────────────

// Chunking parametri
const DEFAULT_CHUNK_TARGET_CHARS = 2000;  // ~500 tokena za hr tekst (1 token ≈ 4 znaka)
const MIN_CHUNK_CHARS = 400;              // ~100 tokena — manji chunkovi se spajaju s prethodnim
const MAX_CHUNK_CHARS = 5000;             // ~1250 tokena — sigurnosni limit za embedding modele

// Sufiksi datoteka
const DIARIZED_SRT_SUFFIX = ".canary.diarized.srt";
const SUMMARY_JSON_SUFFIX = ".canary.summary.json";

// ─── SRT PARSING ─────────────────────────────────────────────────

/**
 * Parsira SRT datoteku u listu strukturiranih segmenata.
 *
 * Svaki segment ima:
 *   - index: redni broj u SRT-u
 *   - startTime: početak u "HH:MM:SS" formatu (bez milisekundi, za metadata)
 *   - endTime: kraj u "HH:MM:SS" formatu
 *   - startSec: početak u sekundama (za precizno sortiranje)
 *   - endSec: kraj u sekundama
 *   - speaker: ID govornika (npr. "SPEAKER_00")
 *   - text: čisti tekst bez oznake govornika
 *
 * @param {string} srtContent - Sadržaj .canary.diarized.srt datoteke
 * @returns {Array<Object>} Lista segmenata
 */
function parseSrt(srtContent) {
    const segments = [];
    const blocks = srtContent.split(/\n\n+/);

    for (const block of blocks) {
        const lines = block.trim().split("\n");
        if (lines.length < 3) continue;

        // Linija 1: indeks
        const index = parseInt(lines[0], 10);
        if (isNaN(index)) continue;

        // Linija 2: timestamp (00:00:33,280 --> 00:00:35,679)
        const timeMatch = lines[1].match(
            /(\d{2}:\d{2}:\d{2})[,.](\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2})[,.](\d{3})/
        );
        if (!timeMatch) continue;

        const startTime = timeMatch[1];
        const endTime = timeMatch[3];
        const startSec = timestampToSeconds(timeMatch[1], timeMatch[2]);
        const endSec = timestampToSeconds(timeMatch[3], timeMatch[4]);

        // Linija 3+: tekst s oznakom govornika
        const textLines = lines.slice(2).join(" ");
        const speakerMatch = textLines.match(/^\[(\w+)\]\s*/);

        const speaker = speakerMatch ? speakerMatch[1] : "UNKNOWN";
        const text = speakerMatch
            ? textLines.replace(/^\[\w+\]\s*/, "").trim()
            : textLines.trim();

        if (!text) continue;

        segments.push({
            index, startTime, endTime, startSec, endSec, speaker, text
        });
    }

    return segments;
}

/**
 * Konvertira HH:MM:SS i milisekunde u ukupne sekunde.
 */
function timestampToSeconds(hms, ms) {
    const [h, m, s] = hms.split(":").map(Number);
    return h * 3600 + m * 60 + s + parseInt(ms, 10) / 1000;
}

// ─── SPEAKER-AWARE CHUNKING ─────────────────────────────────────

/**
 * Grupira uzastopne SRT segmente istog govornika u "govorne blokove".
 *
 * Primjer:
 *   [SPEAKER_00] seg1, [SPEAKER_00] seg2, [SPEAKER_01] seg3, [SPEAKER_00] seg4
 *   → Blok 1: SPEAKER_00 [seg1, seg2]
 *   → Blok 2: SPEAKER_01 [seg3]
 *   → Blok 3: SPEAKER_00 [seg4]
 *
 * Ovo je ključno jer:
 *   - Govornik koji govori 5 segmenata zaredom čini jedan koherentan blok
 *   - Kada se govornik promijeni, to je prirodna granica za chunk
 *
 * @param {Array<Object>} segments - SRT segmenti
 * @returns {Array<Object>} Govorni blokovi
 */
function groupBySpeaker(segments) {
    if (segments.length === 0) return [];

    const blocks = [];
    let currentBlock = {
        speaker: segments[0].speaker,
        segments: [segments[0]],
        startTime: segments[0].startTime,
        startSec: segments[0].startSec,
        endTime: segments[0].endTime,
        endSec: segments[0].endSec
    };

    for (let i = 1; i < segments.length; i++) {
        const seg = segments[i];

        if (seg.speaker === currentBlock.speaker) {
            // Isti govornik → dodaj u trenutni blok
            currentBlock.segments.push(seg);
            currentBlock.endTime = seg.endTime;
            currentBlock.endSec = seg.endSec;
        } else {
            // Novi govornik → zatvori prethodni blok, započni novi
            blocks.push(currentBlock);
            currentBlock = {
                speaker: seg.speaker,
                segments: [seg],
                startTime: seg.startTime,
                startSec: seg.startSec,
                endTime: seg.endTime,
                endSec: seg.endSec
            };
        }
    }

    blocks.push(currentBlock);
    return blocks;
}

/**
 * Iz govornih blokova gradi chunkove optimizirane za embedding.
 *
 * STRATEGIJA:
 *   - Akumulira blokove dok ne dosegne target veličinu (~500 tokena)
 *   - Zatvara chunk na granici govornog bloka (nikada ne prekida govornika)
 *   - Dodaje oznaku govornika na početak svakog bloka unutar chunka
 *   - Zamjenjuje SPEAKER_XX s imenima iz summary.json (ako su dostupna)
 *
 * @param {Array<Object>} speakerBlocks - Govorni blokovi
 * @param {Object|null} speakerMap - Mapa SPEAKER_XX → ime (iz summary.json)
 * @param {number} targetChars - Ciljna veličina chunka u znakovima
 * @returns {Array<Object>} Chunkovi spremni za embedding
 */
function buildChunks(speakerBlocks, speakerMap, targetChars) {
    const chunks = [];
    let currentChunkParts = [];
    let currentChunkChars = 0;
    let chunkStartTime = null;
    let chunkStartSec = null;
    let chunkEndTime = null;
    let chunkEndSec = null;
    let chunkSpeakers = new Set();

    for (const block of speakerBlocks) {
        // Tekst bloka: sve segmente govornika spojiš u paragraf
        const speakerName = speakerMap?.[block.speaker] || block.speaker;
        const blockText = `[${speakerName}] ${block.segments.map(s => s.text).join(" ")}`;

        // Inicijaliziraj vremena za prvi blok u chunku
        if (chunkStartTime === null) {
            chunkStartTime = block.startTime;
            chunkStartSec = block.startSec;
        }

        currentChunkParts.push(blockText);
        currentChunkChars += blockText.length;
        chunkEndTime = block.endTime;
        chunkEndSec = block.endSec;
        chunkSpeakers.add(speakerName);

        // Provjeri treba li zatvoriti chunk
        if (currentChunkChars >= targetChars) {
            chunks.push({
                text: currentChunkParts.join("\n\n"),
                startTime: chunkStartTime,
                endTime: chunkEndTime,
                startSec: chunkStartSec,
                endSec: chunkEndSec,
                speakers: Array.from(chunkSpeakers)
            });

            // Reset za novi chunk
            currentChunkParts = [];
            currentChunkChars = 0;
            chunkStartTime = null;
            chunkStartSec = null;
            chunkEndTime = null;
            chunkEndSec = null;
            chunkSpeakers = new Set();
        }
    }

    // Ostatak → zadnji chunk
    if (currentChunkParts.length > 0) {
        const lastChunkText = currentChunkParts.join("\n\n");

        // Ako je zadnji chunk premali, spoji s prethodnim
        if (lastChunkText.length < MIN_CHUNK_CHARS && chunks.length > 0) {
            const prev = chunks[chunks.length - 1];
            prev.text += "\n\n" + lastChunkText;
            prev.endTime = chunkEndTime;
            prev.endSec = chunkEndSec;
            prev.speakers = Array.from(new Set([...prev.speakers, ...chunkSpeakers]));
        } else {
            chunks.push({
                text: lastChunkText,
                startTime: chunkStartTime,
                endTime: chunkEndTime,
                startSec: chunkStartSec,
                endSec: chunkEndSec,
                speakers: Array.from(chunkSpeakers)
            });
        }
    }

    return chunks;
}

// ─── METADATA LOADING ────────────────────────────────────────────

/**
 * Čita .canary.summary.json i izvlači speaker mapu i teme.
 *
 * Speaker mapa omogućuje zamjenu "SPEAKER_00" → "Voditelj" u chunkovima,
 * čime embeddingi postaju semantički bogatiji.
 *
 * @returns {Object} { speakerMap, topics, title, ... }
 */
function loadSummary(srtFilePath) {
    const dir = path.dirname(srtFilePath);
    const base = path.basename(srtFilePath).replace(/\.canary\.diarized\.srt$/, "");
    const summaryPath = path.join(dir, base + SUMMARY_JSON_SUFFIX);

    if (!fs.existsSync(summaryPath)) return null;

    try {
        const data = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));

        // Gradi speaker mapu: SPEAKER_00 → "Voditelj"
        const speakerMap = {};
        if (data.summary?.speakers) {
            for (const sp of data.summary.speakers) {
                if (sp.id && sp.suggested_name) {
                    speakerMap[sp.id] = sp.suggested_name;
                }
            }
        }

        return {
            speakerMap,
            topics: data.summary?.key_topics || [],
            title: data.summary?.title_hr || data.source?.title || "",
            channel: data.source?.channel || "",
            youtubeId: data.source?.youtube_id || "",
            uploadDate: data.source?.upload_date || "",
            durationSeconds: data.source?.duration_seconds || null
        };

    } catch (e) {
        console.error(`   ⚠️  Neispravan summary.json: ${summaryPath}`);
        return null;
    }
}

/**
 * Izvlači YouTube video ID iz naziva datoteke.
 */
function extractVideoIdFromFilename(filename) {
    const match = filename.match(/_yt_([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
}

/**
 * Izvlači datum iz naziva datoteke.
 */
function extractDateFromFilename(filename) {
    const match = filename.match(/^(\d{4})(\d{2})(\d{2})_/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

// ─── CLI ─────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);

    function getArg(name) {
        const idx = args.indexOf(name);
        return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
    }

    const inputDir = getArg("--input-dir");
    const outputDir = getArg("--output-dir");  // Opcijski: ako nije naveden, koristi inputDir
    const channel = getArg("--channel");
    const limit = getArg("--limit") ? parseInt(getArg("--limit"), 10) : null;
    const chunkSize = getArg("--chunk-size")
        ? parseInt(getArg("--chunk-size"), 10)
        : DEFAULT_CHUNK_TARGET_CHARS;
    const dryRun = args.includes("--dry-run");

    if (!inputDir) {
        console.error("❌ Obavezan argument: --input-dir <putanja>");
        console.error("");
        console.error("Primjeri:");
        console.error("  node prepare_rag.js --input-dir /Volumes/DOMOVINA1TB/fetch_domovina_tv_output");
        console.error("  node prepare_rag.js --input-dir ... --output-dir ./rag_export");
        console.error("  node prepare_rag.js --input-dir ... --channel bozanstvena_komedija");
        console.error("  node prepare_rag.js --input-dir ... --chunk-size 300");
        console.error("  node prepare_rag.js --input-dir ... --dry-run");
        process.exit(1);
    }

    return { inputDir, outputDir, channel, limit, chunkSize, dryRun };
}

// ─── DISCOVERY ───────────────────────────────────────────────────

/**
 * Pronalazi sve .canary.diarized.srt datoteke, grupirane po kanalu.
 */
function discoverFiles(inputDir, channelFilter) {
    const results = [];

    if (!fs.existsSync(inputDir)) {
        console.error(`❌ Input direktorij ne postoji: ${inputDir}`);
        process.exit(1);
    }

    const entries = fs.readdirSync(inputDir, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;

        const channelName = entry.name;
        if (channelFilter && channelName !== channelFilter) continue;

        const channelDir = path.join(inputDir, channelName);
        const files = fs.readdirSync(channelDir);

        for (const file of files) {
            if (!file.endsWith(DIARIZED_SRT_SUFFIX)) continue;
            if (file.startsWith("._")) continue;

            results.push({
                srtPath: path.join(channelDir, file),
                channel: channelName
            });
        }
    }

    results.sort((a, b) => {
        if (a.channel !== b.channel) return a.channel.localeCompare(b.channel);
        return a.srtPath.localeCompare(b.srtPath);
    });

    return results;
}

// ─── MAIN ────────────────────────────────────────────────────────

async function main() {
    const { inputDir, outputDir, channel, limit, chunkSize, dryRun } = parseArgs();

    // Ako nije naveden outputDir, JSONL se sprema u inputDir
    const finalOutputDir = outputDir || inputDir;

    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   🧩 RAG PRIPREMA — SPEAKER-AWARE CHUNKING     ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📂 Input:      ${inputDir}`);
    console.log(`   💾 Output:     ${finalOutputDir}`);
    console.log(`   📏 Chunk size: ~${chunkSize} znakova (~${Math.round(chunkSize / 4)} tokena)`);
    if (channel) console.log(`   🎯 Kanal:      ${channel}`);
    if (limit) console.log(`   🔢 Limit:      ${limit}`);
    if (dryRun) console.log("   ⚠️  DRY RUN — samo prikaz statistike");
    console.log("");

    // Pronađi datoteke
    const allFiles = discoverFiles(inputDir, channel);
    const finalList = limit ? allFiles.slice(0, limit) : allFiles;

    console.log(`   📊 Ukupno .canary.diarized.srt: ${allFiles.length}`);
    console.log(`   🔄 Za obradu: ${finalList.length}`);
    console.log("");

    if (finalList.length === 0) {
        console.log("   ✨ Nema datoteka za obradu!");
        return;
    }

    // Grupiraj po kanalu
    const byChannel = {};
    for (const f of finalList) {
        if (!byChannel[f.channel]) byChannel[f.channel] = [];
        byChannel[f.channel].push(f);
    }

    // Statistika
    let totalFiles = 0;
    let totalChunks = 0;
    let totalWithSummary = 0;
    let totalWithoutSummary = 0;

    const allJsonlPaths = [];

    // ── Obrada po kanalu ──
    for (const [ch, files] of Object.entries(byChannel)) {
        console.log(`\n🔵 [${ch.toUpperCase()}] — ${files.length} datoteka`);

        for (const { srtPath } of files) {
            const basename = path.basename(srtPath);
            const base = basename.replace(/\.wav\.canary\.diarized\.srt$/, "");
            const youtubeId = extractVideoIdFromFilename(base);
            const uploadDate = extractDateFromFilename(base);

            // ── Čitaj SRT ──
            const srtContent = fs.readFileSync(srtPath, "utf-8");
            const segments = parseSrt(srtContent);

            if (segments.length === 0) {
                console.log(`   ⚠️  [PRAZAN] ${base}`);
                continue;
            }

            // ── Čitaj summary (opcijski) ──
            const summary = loadSummary(srtPath);
            const speakerMap = summary?.speakerMap || {};
            const hasSummary = !!summary;

            if (hasSummary) totalWithSummary++;
            else totalWithoutSummary++;

            // ── Speaker-aware chunking ──
            const speakerBlocks = groupBySpeaker(segments);
            const chunks = buildChunks(speakerBlocks, speakerMap, chunkSize);

            // ── Generiraj JSONL linije ──
            const jsonlLines = [];
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const chunkId = `${youtubeId || base}_chunk_${String(i + 1).padStart(3, "0")}`;

                const record = {
                    id: chunkId,
                    text: chunk.text,
                    metadata: {
                        channel: ch,
                        title: summary?.title || base,
                        youtube_id: youtubeId,
                        upload_date: uploadDate,
                        speakers: chunk.speakers,
                        start_time: chunk.startTime,
                        end_time: chunk.endTime,
                        topics: summary?.topics || [],
                        chunk_index: i + 1,
                        total_chunks: chunks.length,
                        has_summary: hasSummary
                    }
                };

                jsonlLines.push(JSON.stringify(record));
            }

            totalChunks += chunks.length;
            totalFiles++;

            // ── Zapiši JSONL po videu (u isti direktorij kao SRT) ──
            if (!dryRun && jsonlLines.length > 0) {
                const jsonlPath = path.join(path.dirname(srtPath), `${base}.rag_chunks.jsonl`);
                fs.writeFileSync(jsonlPath, jsonlLines.join("\n") + "\n", "utf-8");
                const sizeKb = (Buffer.byteLength(jsonlLines.join("\n")) / 1024).toFixed(0);
                console.log(`   ✅ ${base}: ${chunks.length} chunkova → ${path.basename(jsonlPath)} (${sizeKb} KB)`);
                allJsonlPaths.push(jsonlPath);
            } else if (dryRun) {
                console.log(`   📄 ${base}: ${segments.length} seg → ${speakerBlocks.length} blokova → ${chunks.length} chunkova` +
                    `${hasSummary ? " ✅ summary" : " ⚠️ no summary"}`);
            }
        }
    }

    // ── SAŽETAK ──
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║   📊 SAŽETAK RAG PRIPREME                      ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📄 Obrađenih datoteka:  ${totalFiles}`);
    console.log(`   🧩 Ukupno chunkova:     ${totalChunks}`);
    console.log(`   📏 Prosjek chunk/file:  ${totalFiles > 0 ? (totalChunks / totalFiles).toFixed(1) : 0}`);
    console.log(`   ✅ Sa summary.json:     ${totalWithSummary}`);
    console.log(`   ⚠️  Bez summary.json:   ${totalWithoutSummary}`);

    if (!dryRun && allJsonlPaths.length > 0) {
        console.log("");
        console.log("   📁 JSONL datoteke spremne za import u vector DB:");
        for (const p of allJsonlPaths) {
            console.log(`      ${p}`);
        }
    }

    console.log("");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
