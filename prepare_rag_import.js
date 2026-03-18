#!/usr/bin/env node

/**
 * prepare_rag_import.js
 *
 * Priprema podataka za RAG (Retrieval-Augmented Generation) pipeline.
 * Cita tri vrste datoteka nastalih obradom podcasta i generira jednu
 * izlaznu datoteku spremnu za embedding i pohranu u Vector DB.
 *
 * Ulazne datoteke:
 *   1. *.canary.diarized.srt  — Diarizirani transkript s vremenskim oznakama i govornicima
 *   2. *.outline.json         — Semanticki nacrt s iteracijama i chapterima
 *   3. *.article.json         — Generirani novinarski clanak s sekcijama
 *
 * Primjeri pokretanja:
 *   # Auto-discovery: pronalazi sve triplete u folderu
 *   node prepare_rag_import.js --dir /path/to/output/channel/
 *
 *   # Eksplicitne putanje
 *   node prepare_rag_import.js --srt file.srt --outline file.outline.json --article file.article.json
 */

const fs = require("fs");
const path = require("path");

// ─── PARSIRANJE ARGUMENATA ──────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    function getArg(name) {
        const idx = args.indexOf(name);
        return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
    }

    const dir = getArg("--dir");
    const srt = getArg("--srt");
    const outline = getArg("--outline");
    const article = getArg("--article");

    if (!dir && !srt) {
        console.error("❌ Obavezan argument: --dir <folder> ili --srt <putanja>");
        console.error("   Primjeri:");
        console.error("     node prepare_rag_import.js --dir /path/to/channel/");
        console.error("     node prepare_rag_import.js --srt file.srt --outline file.outline.json --article file.article.json");
        process.exit(1);
    }

    return { dir, srt, outline, article };
}

// ─── SRT PARSER ─────────────────────────────────────────────────

/**
 * Parsira SRT datoteku u niz blokova.
 *
 * SRT format:
 *   1
 *   00:03:10,319 --> 00:03:10,879
 *   [SPEAKER_02] Tekst govornika.
 *
 * Svaki blok ima: index, startTime (sekunde), endTime (sekunde), speaker, text
 */
function parseSrt(content) {
    const blocks = [];
    // SRT blokovi su odvojeni praznim linijama
    const rawBlocks = content.trim().split(/\n\s*\n/);

    for (const raw of rawBlocks) {
        const lines = raw.trim().split("\n");
        if (lines.length < 3) continue;

        // Linija 1: redni broj
        const index = parseInt(lines[0].trim());
        if (isNaN(index)) continue;

        // Linija 2: vremenski raspon "HH:MM:SS,mmm --> HH:MM:SS,mmm"
        const timeMatch = lines[1].match(
            /(\d{2}:\d{2}:\d{2}),\d{3}\s*-->\s*(\d{2}:\d{2}:\d{2}),\d{3}/
        );
        if (!timeMatch) continue;

        const startTime = timeToSeconds(timeMatch[1]);
        const endTime = timeToSeconds(timeMatch[2]);

        // Linija 3+: tekst govornika, moze imati [SPEAKER_XX] prefix
        const textLines = lines.slice(2).join(" ").trim();
        const speakerMatch = textLines.match(/^\[?(SPEAKER_\d+)\]?\s*(.*)/);

        let speaker = "UNKNOWN";
        let text = textLines;
        if (speakerMatch) {
            speaker = speakerMatch[1];
            text = speakerMatch[2];
        }

        blocks.push({ index, startTime, endTime, speaker, text });
    }

    return blocks;
}

/**
 * Pretvara HH:MM:SS string u sekunde.
 * Outline timestamps koriste HH:MM:SS format (bez milisekundi).
 * SRT timestamps koriste HH:MM:SS,mmm ali mi parsiramo samo HH:MM:SS dio.
 */
function timeToSeconds(hhmmss) {
    const parts = hhmmss.split(":");
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
}

/**
 * Pretvara sekunde natrag u HH:MM:SS format.
 */
function secondsToTime(sec) {
    const h = Math.floor(sec / 3600).toString().padStart(2, "0");
    const m = Math.floor((sec % 3600) / 60).toString().padStart(2, "0");
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${h}:${m}:${s}`;
}

// ─── KORAK 1: RAW TRANSCRIPT CHUNKS ────────────────────────────

/**
 * Grupira SRT blokove u chunkove na temelju outline chapter timestampova.
 *
 * Logika: Izvucemo sve chapter timestamps iz svih iteracija outlinea,
 * sortiramo ih kronoloski. Svaki chunk pocinje na timestampu jednog
 * poglavlja i traje do timestampa sljedeceg poglavlja.
 * SRT blokovi se mapiraju u chunk ciji timestamp <= blok.startTime < sljedeci timestamp.
 */
function buildRawChunks(srtBlocks, outlineJson, sourceName) {
    // Izvuci sve chaptere iz svih iteracija, sortirane po vremenu
    const chapters = [];
    for (const iter of outlineJson.iterations) {
        if (!iter.chapters) continue;
        for (const ch of iter.chapters) {
            chapters.push({
                timestamp: ch.timestamp,
                seconds: timeToSeconds(ch.timestamp),
                topic: ch.topic
            });
        }
    }
    chapters.sort((a, b) => a.seconds - b.seconds);

    if (chapters.length === 0) {
        console.error("   ⚠️  Outline nema chaptera, preskačem raw chunks.");
        return [];
    }

    // Kreiraj chunk granice: [start, end) za svaki chapter
    const boundaries = chapters.map((ch, i) => ({
        topic: ch.topic,
        startSeconds: ch.seconds,
        startTime: ch.timestamp,
        // Kraj je pocetak sljedeceg chaptera, ili Infinity za zadnji
        endSeconds: i + 1 < chapters.length ? chapters[i + 1].seconds : Infinity,
        endTime: i + 1 < chapters.length ? chapters[i + 1].timestamp : null,
        blocks: []
    }));

    // Mapiraj svaki SRT blok u odgovarajuci chunk
    // Blok pripada chunku ciji startSeconds <= blok.startTime < chunk.endSeconds
    for (const block of srtBlocks) {
        for (let i = boundaries.length - 1; i >= 0; i--) {
            if (block.startTime >= boundaries[i].startSeconds) {
                boundaries[i].blocks.push(block);
                break;
            }
        }
    }

    // Kreiraj izlazne objekte
    const chunks = [];
    for (let i = 0; i < boundaries.length; i++) {
        const b = boundaries[i];
        if (b.blocks.length === 0) continue;

        // Tekst: tema + svi SRT blokovi s govornicima
        const transcriptText = b.blocks
            .map(bl => `[${bl.speaker}] ${bl.text}`)
            .join("\n");

        const actualEnd = b.endTime || secondsToTime(b.blocks[b.blocks.length - 1].endTime);

        chunks.push({
            id: `${sourceName}_raw_chunk_${i + 1}`,
            text: `Tema: ${b.topic}\n\n${transcriptText}`,
            metadata: {
                source: sourceName,
                type: "raw_transcript",
                topic: b.topic,
                start_time: b.startTime,
                end_time: actualEnd
            }
        });
    }

    return chunks;
}

// ─── KORAK 2: ARTICLE SUMMARY CHUNKS ───────────────────────────

/**
 * Pretvara article sections u summary chunkove.
 * Svaka sekcija iz article.json postaje zasebni chunk.
 */
function buildSummaryChunks(articleJson, sourceName) {
    const chunks = [];
    let counter = 0;

    for (const iter of articleJson.iterations) {
        if (!iter.sections) continue;
        for (const section of iter.sections) {
            counter++;
            chunks.push({
                id: `${sourceName}_summary_${counter}`,
                text: `Naslov: ${section.subtitle}\n\nSažetak: ${section.content}`,
                metadata: {
                    source: sourceName,
                    type: "article_summary",
                    subtitle: section.subtitle
                }
            });
        }
    }

    return chunks;
}

// ─── AUTO-DISCOVERY ─────────────────────────────────────────────

/**
 * Pronalazi triplete (srt + outline + article) u folderu.
 *
 * Naming konvencija:
 *   SRT:     {base}.wav.canary.diarized.srt
 *   Outline: {base}.wav.canary.diarized_{date}_{model}.outline.json
 *   Article: {base}.wav.canary.diarized_{date}_{model}.article.json
 *
 * Za svaki SRT trazi najnoviji outline i article (sortirano po datumu).
 */
function discoverTriplets(dir) {
    const files = fs.readdirSync(dir);

    // Pronadi sve .canary.diarized.srt datoteke (iskljuci macOS resource forkove)
    const srtFiles = files.filter(f =>
        f.endsWith(".canary.diarized.srt") && !f.startsWith("._")
    );

    const triplets = [];

    for (const srtFile of srtFiles) {
        // Basename je dio prije .canary.diarized.srt, ali ukljucujuci .wav.canary.diarized
        // jer outline/article koriste taj prefix
        const srtBase = srtFile.replace(/\.srt$/, ""); // npr. "xxx.wav.canary.diarized"

        // Trazi outline i article koji pocinje s istim baseom
        const outlines = files
            .filter(f => f.startsWith(srtBase + "_") && f.endsWith(".outline.json"))
            .sort()
            .reverse(); // najnoviji prvi (datum je u imenu)

        const articles = files
            .filter(f => f.startsWith(srtBase + "_") && f.endsWith(".article.json"))
            .sort()
            .reverse();

        if (outlines.length === 0 || articles.length === 0) {
            console.log(`   ⏭️  ${srtFile}: nedostaje outline ili article, preskačem.`);
            continue;
        }

        // Koristi najnoviji outline i article
        triplets.push({
            srt: path.join(dir, srtFile),
            outline: path.join(dir, outlines[0]),
            article: path.join(dir, articles[0]),
            srtBase: srtBase
        });
    }

    return triplets;
}

// ─── OBRADA JEDNOG TRIPLETA ─────────────────────────────────────

function processTriplet(srtPath, outlinePath, articlePath) {
    const srtBase = path.basename(srtPath).replace(/\.srt$/, "");
    // Source name: dio prije .wav za citljivije ID-eve
    const sourceName = path.basename(srtPath).replace(/\.wav\.canary\.diarized\.srt$/, "");

    console.log(`   📂 SRT:     ${path.basename(srtPath)}`);
    console.log(`   📋 Outline: ${path.basename(outlinePath)}`);
    console.log(`   📰 Article: ${path.basename(articlePath)}`);

    // Ucitaj datoteke
    const srtContent = fs.readFileSync(srtPath, "utf-8");
    const outlineJson = JSON.parse(fs.readFileSync(outlinePath, "utf-8"));
    const articleJson = JSON.parse(fs.readFileSync(articlePath, "utf-8"));

    // Parsiraj SRT
    const srtBlocks = parseSrt(srtContent);
    console.log(`   🔤 Parsirano ${srtBlocks.length} SRT blokova`);

    // KORAK 1: Raw transcript chunks
    const rawChunks = buildRawChunks(srtBlocks, outlineJson, sourceName);
    console.log(`   📦 Generirano ${rawChunks.length} raw transcript chunkova`);

    // KORAK 2: Article summary chunks
    const summaryChunks = buildSummaryChunks(articleJson, sourceName);
    console.log(`   📦 Generirano ${summaryChunks.length} article summary chunkova`);

    // Spoji sve chunkove
    const allChunks = [...rawChunks, ...summaryChunks];

    // Spremi izlaz
    const outDir = path.dirname(srtPath);
    const outPath = path.join(outDir, `${srtBase}_rag_ready.json`);
    fs.writeFileSync(outPath, JSON.stringify(allChunks, null, 2), "utf-8");
    console.log(`   ✅ Spremljeno ${allChunks.length} chunkova → ${path.basename(outPath)}`);

    return { outPath, rawCount: rawChunks.length, summaryCount: summaryChunks.length };
}

// ─── MAIN ───────────────────────────────────────────────────────

function main() {
    const { dir, srt, outline, article } = parseArgs();

    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   🗂️  RAG IMPORT PRIPREMA                        ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log("");

    if (srt) {
        // Eksplicitni mod: korisnik dao putanje
        if (!outline || !article) {
            console.error("❌ Kad koristiš --srt, moraš dati i --outline i --article");
            process.exit(1);
        }
        for (const f of [srt, outline, article]) {
            if (!fs.existsSync(f)) {
                console.error(`❌ Datoteka ne postoji: ${f}`);
                process.exit(1);
            }
        }

        processTriplet(srt, outline, article);
    } else {
        // Auto-discovery mod
        if (!fs.existsSync(dir)) {
            console.error(`❌ Direktorij ne postoji: ${dir}`);
            process.exit(1);
        }

        console.log(`   🔍 Tražim triplete u: ${dir}`);
        console.log("");

        const triplets = discoverTriplets(dir);

        if (triplets.length === 0) {
            console.log("   ⚠️  Nisu pronađeni kompletni tripleti (srt + outline + article).");
            process.exit(0);
        }

        console.log(`   📊 Pronađeno ${triplets.length} triplet(a)`);
        console.log("");

        let totalRaw = 0;
        let totalSummary = 0;

        for (let i = 0; i < triplets.length; i++) {
            const t = triplets[i];
            console.log(`   ── Triplet ${i + 1}/${triplets.length} ──`);
            const result = processTriplet(t.srt, t.outline, t.article);
            totalRaw += result.rawCount;
            totalSummary += result.summaryCount;
            console.log("");
        }

        console.log(`   🎉 Ukupno: ${totalRaw} raw + ${totalSummary} summary = ${totalRaw + totalSummary} chunkova`);
    }

    console.log("");
}

main();
