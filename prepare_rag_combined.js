#!/usr/bin/env node

/**
 * prepare_rag_combined.js
 *
 * Kombinirana RAG priprema koja spaja najbolje iz oba pristupa:
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ZAŠTO POSTOJI OVA SKRIPTA?
 * ═══════════════════════════════════════════════════════════════════════
 *
 * U codebaseu postoje dvije starije RAG skripte s različitim strategijama:
 *
 *   1. prepare_rag.js — SPEAKER-AWARE CHUNKING
 *      + Bogat metadata (youtube_id, upload_date, channel, speakers, topics)
 *      + Speaker name replacement (SPEAKER_00 → "Voditelj") — embeddingi semantički bogatiji
 *      + Konfigurabilan chunk size, dry-run, limit
 *      - Chunkovi su MEHANIČKI — reže na ~500 tokena po granici govornika, ne po temi
 *      - Govornik koji priča 10 min o 3 teme završi u jednom chunku
 *      - Nema article summary → nema "pročišćenu" verziju za search
 *
 *   2. prepare_rag_import.js — OUTLINE-BASED SEMANTIC CHUNKING
 *      + Chunkovi prate TEMATSKE GRANICE iz outline.json — svaki chunk = jedna tema
 *      + Article summary chunkovi — visoko kvalitetan tekst za embedding
 *      + Dva tipa chunkova: raw_transcript za detalje + article_summary za semantic search
 *      - Siromašan metadata — nema youtube_id, upload_date, channel, speakers
 *      - Nema speaker name replacement
 *      - Output je JSON array (ne JSONL) — teži za streaming import
 *
 * Za cross-podcast pretraživanje i video seeking, ni jedna skripta sama nije dovoljna:
 *
 *   | Potreba                    | prepare_rag.js       | prepare_rag_import.js |
 *   |----------------------------|----------------------|-----------------------|
 *   | "Tko je govorio o X?"      | speaker imena, ali   | nema speaker imena    |
 *   |                            | chunk miješa teme    |                       |
 *   | Seek na trenutak u videu   | timestamps, ali      | precizni topic        |
 *   |                            | chunk pokriva previše| timestamps            |
 *   | Cross-podcast search       | channel/date/yt_id   | nema te metapodatke   |
 *   | Kvaliteta embeddinga       | sirovi transcript    | article summary =     |
 *   |                            | sa šumom             | čist tekst            |
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ŠTO JE PREUZETO ODAKLE?
 * ═══════════════════════════════════════════════════════════════════════
 *
 * IZ prepare_rag_import.js:
 *   - Semantičko chunkiranje po outline chapter timestampovima
 *     (svaki chunk = jedna tema, ne fiksni broj tokena)
 *   - Article summary chunkovi kao drugi "sloj" za search
 *   - Triplet discovery (SRT + outline + article)
 *
 * IZ prepare_rag.js:
 *   - Speaker name replacement iz summary.json (SPEAKER_00 → "Voditelj")
 *   - Bogat metadata: youtube_id, upload_date, channel, speakers, topics, title
 *   - Ekstrakcija YouTube ID-a i datuma iz naziva datoteke
 *   - JSONL output format (streamable, univerzalan za sve vector DB-ove)
 *   - CLI opcije: --input-dir, --output-dir, --channel, --limit, --dry-run
 *   - Obrada svih kanala odjednom (ne samo jedan direktorij)
 *
 * NOVO U OVOJ SKRIPTI:
 *   - Četverostruki discovery: SRT + outline + article + summary.json (opcijski)
 *   - Unutar svakog tematskog chunka, govornici imaju imena (ne samo SPEAKER_XX)
 *   - Article summary chunkovi nose isti bogat metadata kao transcript chunkovi
 *   - Precizni timestamps iz outline chaptera + speaker identitet iz summary.json
 *
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ULAZNE DATOTEKE (po epizodi):
 *   1. *.canary.diarized.srt                          — Diarizirani transkript
 *   2. *.canary.diarized_{date}_{model}.outline.json  — Semantički nacrt s chapterima
 *   3. *.canary.diarized_{date}_{model}.article.json  — Generirani članak sa sekcijama
 *   4. *.canary.summary.json (OPCIJSKI)               — Sažetak s imenima govornika
 *
 * OUTPUT: JSONL (jedan JSON objekt po liniji), jedan fajl po YouTube videu
 *   Svaka linija:
 *   {
 *     "id": "RA4bHbq2MkE_topic_001",
 *     "text": "Tema: Rasprava o zakonu\n\n[Voditelj] Danas raspravljamo...\n[Gost] Da, to je...",
 *     "metadata": {
 *       "type": "topic_transcript",
 *       "channel": "domovina_tv",
 *       "title": "Naslov epizode",
 *       "youtube_id": "RA4bHbq2MkE",
 *       "upload_date": "2025-01-15",
 *       "topic": "Rasprava o zakonu",
 *       "speakers": ["Voditelj", "Gost"],
 *       "start_time": "00:05:30",
 *       "end_time": "00:12:45",
 *       "topics": ["zakon", "politika"],
 *       "chunk_index": 1,
 *       "total_chunks": 15
 *     }
 *   }
 *
 * Primjeri:
 *   node prepare_rag_combined.js --input-dir /Volumes/DOMOVINA1TB/fetch_domovina_tv_output
 *   node prepare_rag_combined.js --input-dir ... --channel domovina_tv
 *   node prepare_rag_combined.js --input-dir ... --dry-run
 *   node prepare_rag_combined.js --input-dir ... --output-dir ./rag_export
 *   node prepare_rag_combined.js --input-dir ... --limit 10
 */

const fs = require("fs");
const path = require("path");

// ─── SUFIKSI DATOTEKA ───────────────────────────────────────────

const DIARIZED_SRT_SUFFIX = ".canary.diarized.srt";
const SORTFORMER_DIARIZED_SRT_SUFFIX = ".sortformer.diarized.srt";

// Razrješava koji se dijarizirani SRT stvarno čita za dani canary path.
// Ako uz canary postoji i .sortformer.diarized.srt (eksperimentalna pipeline),
// preferira sortformer. Discovery i izlazna imena fajlova ostaju canary-anchored.
function resolveDiarizedSrt(canarySrtPath) {
    const sortformerPath = canarySrtPath.replace(
        /\.canary\.diarized\.srt$/,
        SORTFORMER_DIARIZED_SRT_SUFFIX
    );
    if (fs.existsSync(sortformerPath)) {
        return { path: sortformerPath, source: "sortformer" };
    }
    return { path: canarySrtPath, source: "canary" };
}
const SUMMARY_JSON_SUFFIX = ".canary.summary.json";

// ─── SRT PARSER (iz prepare_rag.js — preciznije parsira milisekunde) ──

/**
 * Parsira SRT datoteku u listu segmenata.
 * Koristi pristup iz prepare_rag.js koji čuva milisekunde za precizne timestamps.
 */
function parseSrt(srtContent) {
    const segments = [];
    const blocks = srtContent.split(/\n\n+/);

    for (const block of blocks) {
        const lines = block.trim().split("\n");
        if (lines.length < 3) continue;

        const index = parseInt(lines[0], 10);
        if (isNaN(index)) continue;

        const timeMatch = lines[1].match(
            /(\d{2}:\d{2}:\d{2})[,.](\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2})[,.](\d{3})/
        );
        if (!timeMatch) continue;

        const startTime = timeMatch[1];
        const endTime = timeMatch[3];
        const startSec = timestampToSeconds(timeMatch[1], timeMatch[2]);
        const endSec = timestampToSeconds(timeMatch[3], timeMatch[4]);

        const textLines = lines.slice(2).join(" ");
        const speakerMatch = textLines.match(/^\[(\w+)\]\s*/);

        const speaker = speakerMatch ? speakerMatch[1] : "UNKNOWN";
        const text = speakerMatch
            ? textLines.replace(/^\[\w+\]\s*/, "").trim()
            : textLines.trim();

        if (!text) continue;

        segments.push({ index, startTime, endTime, startSec, endSec, speaker, text });
    }

    return segments;
}

function timestampToSeconds(hms, ms) {
    const [h, m, s] = hms.split(":").map(Number);
    return h * 3600 + m * 60 + s + parseInt(ms, 10) / 1000;
}

function timeToSeconds(hhmmss) {
    const parts = hhmmss.split(":");
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
}

function secondsToTime(sec) {
    const h = Math.floor(sec / 3600).toString().padStart(2, "0");
    const m = Math.floor((sec % 3600) / 60).toString().padStart(2, "0");
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${h}:${m}:${s}`;
}

// ─── METADATA IZ SUMMARY.JSON (iz prepare_rag.js) ──────────────

/**
 * Čita .canary.summary.json i izvlači speaker mapu, teme, naslov itd.
 * Preuzeto iz prepare_rag.js — speaker mapa omogućuje zamjenu
 * "SPEAKER_00" → "Voditelj" u chunkovima.
 */
function loadSummary(srtFilePath) {
    const dir = path.dirname(srtFilePath);
    const base = path.basename(srtFilePath).replace(/\.canary\.diarized\.srt$/, "");
    const summaryPath = path.join(dir, base + SUMMARY_JSON_SUFFIX);

    if (!fs.existsSync(summaryPath)) return null;

    try {
        const data = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));

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

// ─── FILENAME METADATA (iz prepare_rag.js) ──────────────────────

function extractVideoIdFromFilename(filename) {
    const match = filename.match(/_yt_([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
}

function extractDateFromFilename(filename) {
    const match = filename.match(/^(\d{4})(\d{2})(\d{2})_/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

// ─── TOPIC TRANSCRIPT CHUNKOVI (iz prepare_rag_import.js + speaker names iz prepare_rag.js) ──

/**
 * Grupira SRT segmente u chunkove po outline chapter timestampovima.
 *
 * Preuzeto iz prepare_rag_import.js: semantičko chunkiranje po tematskim granicama.
 * Dodano iz prepare_rag.js: speaker name replacement unutar svakog chunka.
 *
 * Rezultat: svaki chunk pokriva jednu temu, sa speaker imenima umjesto SPEAKER_XX,
 * i preciznim start/end timestampovima za video seeking.
 */
function buildTopicChunks(segments, outlineJson, speakerMap) {
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
        console.error("   ⚠️  Outline nema chaptera, preskačem topic chunks.");
        return [];
    }

    // Kreiraj granice: [start, end) za svaki chapter
    const boundaries = chapters.map((ch, i) => ({
        topic: ch.topic,
        startSeconds: ch.seconds,
        startTime: ch.timestamp,
        endSeconds: i + 1 < chapters.length ? chapters[i + 1].seconds : Infinity,
        endTime: i + 1 < chapters.length ? chapters[i + 1].timestamp : null,
        segments: []
    }));

    // Mapiraj segmente u chaptere po timestampu
    for (const seg of segments) {
        for (let i = boundaries.length - 1; i >= 0; i--) {
            if (seg.startSec >= boundaries[i].startSeconds) {
                boundaries[i].segments.push(seg);
                break;
            }
        }
    }

    // Kreiraj chunkove sa speaker name replacement
    const chunks = [];
    for (const b of boundaries) {
        if (b.segments.length === 0) continue;

        // Grupiraj uzastopne segmente istog govornika unutar chaptera
        // za čitljiviji tekst (ne ponavljaj [Voditelj] za svaki segment)
        const textParts = [];
        let lastSpeaker = null;
        let currentParts = [];

        for (const seg of b.segments) {
            const speakerName = speakerMap[seg.speaker] || seg.speaker;
            if (speakerName !== lastSpeaker) {
                if (currentParts.length > 0) {
                    textParts.push(`[${lastSpeaker}] ${currentParts.join(" ")}`);
                }
                lastSpeaker = speakerName;
                currentParts = [seg.text];
            } else {
                currentParts.push(seg.text);
            }
        }
        if (currentParts.length > 0) {
            textParts.push(`[${lastSpeaker}] ${currentParts.join(" ")}`);
        }

        const transcriptText = textParts.join("\n\n");

        // Prikupi sve govornike u ovom chunku
        const chunkSpeakers = [...new Set(
            b.segments.map(seg => speakerMap[seg.speaker] || seg.speaker)
        )];

        const actualEnd = b.endTime || secondsToTime(
            Math.round(b.segments[b.segments.length - 1].endSec)
        );

        chunks.push({
            type: "topic_transcript",
            text: `Tema: ${b.topic}\n\n${transcriptText}`,
            topic: b.topic,
            speakers: chunkSpeakers,
            startTime: b.startTime,
            endTime: actualEnd
        });
    }

    return chunks;
}

// ─── ARTICLE SUMMARY CHUNKOVI (iz prepare_rag_import.js) ────────

/**
 * Pretvara article sections u summary chunkove.
 * Preuzeto iz prepare_rag_import.js — svaka sekcija članka postaje chunk.
 * Ovi chunkovi sadrže "pročišćeni" tekst generiran Gemini modelom,
 * koji daje bolje embedding rezultate od sirovog transkripta.
 */
function buildSummaryChunks(articleJson) {
    const chunks = [];

    for (const iter of articleJson.iterations) {
        if (!iter.sections) continue;
        for (const section of iter.sections) {
            chunks.push({
                type: "article_summary",
                text: `Naslov: ${section.subtitle}\n\nSažetak: ${section.content}`,
                topic: section.subtitle,
                speakers: [],
                startTime: null,
                endTime: null
            });
        }
    }

    return chunks;
}

// ─── DISCOVERY (kombinirano) ────────────────────────────────────

/**
 * Pronalazi sve datoteke za obradu, grupirane po kanalu.
 * Discovery iz prepare_rag.js (skenira sve kanale u input-dir),
 * ali traži triplete (SRT + outline + article) kao prepare_rag_import.js,
 * plus opcijski summary.json.
 */
function discoverFiles(inputDir, channelFilter, videoIdFilter) {
    const results = [];

    if (!fs.existsSync(inputDir)) {
        console.error(`❌ Input direktorij ne postoji: ${inputDir}`);
        process.exit(1);
    }

    const entries = fs.readdirSync(inputDir, { withFileTypes: true });

    for (const entry of entries) {
        if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
        if (entry.name.startsWith(".")) continue;

        const channelName = entry.name;
        if (channelFilter && channelName !== channelFilter) continue;

        const channelDir = path.join(inputDir, channelName);
        const files = fs.readdirSync(channelDir);

        // Pronadi sve SRT datoteke (opcijski filtrirane po YouTube video ID-u)
        const srtFiles = files.filter(f =>
            f.endsWith(DIARIZED_SRT_SUFFIX) &&
            !f.startsWith("._") &&
            (!videoIdFilter || f.includes(`_yt_${videoIdFilter}`))
        );

        for (const srtFile of srtFiles) {
            const srtBase = srtFile.replace(/\.srt$/, "");

            // Trazi najnoviji outline i article (iz prepare_rag_import.js)
            const outlines = files
                .filter(f => f.startsWith(srtBase + "_") && f.endsWith(".outline.json"))
                .sort()
                .reverse();

            const articles = files
                .filter(f => f.startsWith(srtBase + "_") && f.endsWith(".article.json"))
                .sort()
                .reverse();

            if (outlines.length === 0 || articles.length === 0) {
                continue; // Preskoci — nema outline ili article
            }

            results.push({
                srtPath: path.join(channelDir, srtFile),
                outlinePath: path.join(channelDir, outlines[0]),
                articlePath: path.join(channelDir, articles[0]),
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

// ─── DONE CACHE ─────────────────────────────────────────────────

const DONE_STATE_FILENAME = "rag-combined-done.json";

function loadDoneState(inputDir) {
    const statePath = path.join(inputDir, DONE_STATE_FILENAME);
    try {
        if (fs.existsSync(statePath)) {
            const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
            return new Set(Array.isArray(data.completed) ? data.completed : []);
        }
    } catch (e) {
        console.error(`   ⚠️  Neispravan done-state: ${statePath} — rebuildam cache`);
    }
    return new Set();
}

function saveDoneState(inputDir, doneSet) {
    const statePath = path.join(inputDir, DONE_STATE_FILENAME);
    const tempPath = statePath + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify({ completed: [...doneSet] }, null, 2));
    fs.renameSync(tempPath, statePath);
}

// ─── CLI (iz prepare_rag.js) ────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);

    function getArg(name) {
        const idx = args.indexOf(name);
        return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
    }

    const inputDir = getArg("--input-dir");
    const outputDir = getArg("--output-dir");
    const channel = getArg("--channel");
    // --video-id filter: obradi samo jedan video po YouTube ID-u (11 znakova)
    const videoId = getArg("--video-id");
    const limit = getArg("--limit") ? parseInt(getArg("--limit"), 10) : null;
    const dryRun = args.includes("--dry-run");
    const rebuildState = args.includes("--rebuild-state");

    if (!inputDir) {
        console.error("❌ Obavezan argument: --input-dir <putanja>");
        console.error("");
        console.error("Primjeri:");
        console.error("  node prepare_rag_combined.js --input-dir /Volumes/DOMOVINA1TB/fetch_domovina_tv_output");
        console.error("  node prepare_rag_combined.js --input-dir ... --output-dir ./rag_export");
        console.error("  node prepare_rag_combined.js --input-dir ... --channel domovina_tv");
        console.error("  node prepare_rag_combined.js --input-dir ... --video-id dQw4w9WgXcQ");
        console.error("  node prepare_rag_combined.js --input-dir ... --limit 10");
        console.error("  node prepare_rag_combined.js --input-dir ... --dry-run");
        console.error("  node prepare_rag_combined.js --input-dir ... --rebuild-state");
        process.exit(1);
    }

    return { inputDir, outputDir, channel, videoId, limit, dryRun, rebuildState };
}

// ─── MAIN ───────────────────────────────────────────────────────

function main() {
    const { inputDir, outputDir, channel, videoId, limit, dryRun, rebuildState } = parseArgs();
    const finalOutputDir = outputDir || inputDir;

    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   🧬 RAG COMBINED — SEMANTIC + SPEAKER-AWARE    ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📂 Input:  ${inputDir}`);
    console.log(`   💾 Output: ${finalOutputDir}`);
    if (channel) console.log(`   🎯 Kanal:  ${channel}`);
    if (videoId) console.log(`   🎯 Video ID: ${videoId}`);
    if (limit) console.log(`   🔢 Limit:  ${limit}`);
    if (dryRun) console.log("   ⚠️  DRY RUN — samo prikaz statistike");
    if (rebuildState) console.log("   🔄 REBUILD STATE — ignoriram done cache");
    console.log("");

    // Done cache: O(1) skip za već obrađene datoteke
    const doneSet = rebuildState ? new Set() : loadDoneState(inputDir);
    if (doneSet.size > 0) {
        console.log(`   💾 Done cache: ${doneSet.size} već obrađenih epizoda`);
    }

    // Pronadi datoteke (SRT + outline + article, grupirane po kanalu)
    const allFiles = discoverFiles(inputDir, channel, videoId);

    // Filtriraj: preskoči datoteke iz done cachea, ali i one kojima već postoji JSONL
    const toProcess = [];
    let cachedSkipped = 0;
    let fsSkipped = 0;

    for (const f of allFiles) {
        const base = path.basename(f.srtPath).replace(/\.wav\.canary\.diarized\.srt$/, "");

        // O(1) cache provjera
        if (doneSet.has(base)) {
            cachedSkipped++;
            continue;
        }

        // Filesystem fallback: provjeri postoji li .rag_combined.jsonl
        const jsonlPath = path.join(path.dirname(f.srtPath), `${base}.rag_combined.jsonl`);
        if (fs.existsSync(jsonlPath)) {
            // Cache warming: dodaj u done set za sljedeći put
            doneSet.add(base);
            fsSkipped++;
            continue;
        }

        toProcess.push(f);
    }

    const finalList = limit ? toProcess.slice(0, limit) : toProcess;

    console.log(`   📊 Pronađeno tripleta (SRT+outline+article): ${allFiles.length}`);
    console.log(`   ✅ Preskočeno (cache):    ${cachedSkipped}`);
    if (fsSkipped > 0) console.log(`   ✅ Preskočeno (FS check): ${fsSkipped} (dodano u cache)`);
    console.log(`   🔄 Za obradu: ${finalList.length}`);
    console.log("");

    if (finalList.length === 0) {
        // Spremi cache warming rezultate
        if (fsSkipped > 0 && !dryRun) saveDoneState(inputDir, doneSet);
        console.log("   ✨ Nema novih datoteka za obradu!");
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
    let totalTopicChunks = 0;
    let totalSummaryChunks = 0;
    let totalWithSpeakerNames = 0;
    let totalWithoutSpeakerNames = 0;

    for (const [ch, files] of Object.entries(byChannel)) {
        console.log(`\n🔵 [${ch.toUpperCase()}] — ${files.length} epizoda`);

        for (const { srtPath, outlinePath, articlePath } of files) {
            const basename = path.basename(srtPath);
            const base = basename.replace(/\.wav\.canary\.diarized\.srt$/, "");
            const youtubeId = extractVideoIdFromFilename(base);
            const uploadDate = extractDateFromFilename(base);

            // Čitaj SRT — sortformer ima prioritet ako postoji
            const { path: _actualSrtPath, source: _diarSource } = resolveDiarizedSrt(srtPath);
            if (_diarSource === "sortformer") console.log(`   🎭 Dijarizacija: sortformer (override canary)`);
            const srtContent = fs.readFileSync(_actualSrtPath, "utf-8");
            const segments = parseSrt(srtContent);

            if (segments.length === 0) {
                console.log(`   ⚠️  [PRAZAN] ${base}`);
                continue;
            }

            // Čitaj outline i article
            const outlineJson = JSON.parse(fs.readFileSync(outlinePath, "utf-8"));
            const articleJson = JSON.parse(fs.readFileSync(articlePath, "utf-8"));

            // Čitaj summary.json (opcijski — za speaker imena i teme)
            const summary = loadSummary(srtPath);
            const speakerMap = summary?.speakerMap || {};
            const hasSpeakerNames = Object.keys(speakerMap).length > 0;

            if (hasSpeakerNames) totalWithSpeakerNames++;
            else totalWithoutSpeakerNames++;

            // KORAK 1: Topic transcript chunkovi (outline granice + speaker imena)
            const topicChunks = buildTopicChunks(segments, outlineJson, speakerMap);

            // KORAK 2: Article summary chunkovi
            const summaryChunks = buildSummaryChunks(articleJson);

            // Spoji i generiraj JSONL
            const allChunks = [...topicChunks, ...summaryChunks];
            const totalForEpisode = allChunks.length;

            const jsonlLines = [];
            for (let i = 0; i < allChunks.length; i++) {
                const chunk = allChunks[i];
                const typeSuffix = chunk.type === "topic_transcript" ? "topic" : "summary";
                const chunkId = `${youtubeId || base}_${typeSuffix}_${String(i + 1).padStart(3, "0")}`;

                const record = {
                    id: chunkId,
                    text: chunk.text,
                    metadata: {
                        type: chunk.type,
                        channel: ch,
                        title: summary?.title || base,
                        youtube_id: youtubeId,
                        upload_date: uploadDate,
                        topic: chunk.topic,
                        speakers: chunk.speakers,
                        start_time: chunk.startTime,
                        end_time: chunk.endTime,
                        topics: summary?.topics || [],
                        chunk_index: i + 1,
                        total_chunks: totalForEpisode,
                        has_speaker_names: hasSpeakerNames
                    }
                };

                jsonlLines.push(JSON.stringify(record));
            }

            totalTopicChunks += topicChunks.length;
            totalSummaryChunks += summaryChunks.length;
            totalFiles++;

            // Zapiši JSONL po videu (u isti direktorij kao SRT)
            if (!dryRun && jsonlLines.length > 0) {
                const jsonlPath = path.join(path.dirname(srtPath), `${base}.rag_combined.jsonl`);
                fs.writeFileSync(jsonlPath, jsonlLines.join("\n") + "\n", "utf-8");
                const sizeKb = (Buffer.byteLength(jsonlLines.join("\n")) / 1024).toFixed(0);
                console.log(`   ✅ ${base}: ${topicChunks.length} topic + ${summaryChunks.length} summary → ${path.basename(jsonlPath)} (${sizeKb} KB)`);
                doneSet.add(base);
            } else if (dryRun) {
                console.log(`   📄 ${base}: ${segments.length} seg → ${topicChunks.length} topic + ${summaryChunks.length} summary` +
                    `${hasSpeakerNames ? " ✅ speaker imena" : " ⚠️ bez imena"}`);
            }
        }
    }

    // Sažetak
    const totalChunks = totalTopicChunks + totalSummaryChunks;
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║   📊 SAŽETAK RAG COMBINED PRIPREME              ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📄 Obrađenih epizoda:      ${totalFiles}`);
    console.log(`   🧩 Topic chunkova:         ${totalTopicChunks}`);
    console.log(`   📰 Summary chunkova:       ${totalSummaryChunks}`);
    console.log(`   📦 Ukupno chunkova:        ${totalChunks}`);
    console.log(`   📏 Prosjek chunk/epizoda:  ${totalFiles > 0 ? (totalChunks / totalFiles).toFixed(1) : 0}`);
    console.log(`   ✅ Sa speaker imenima:     ${totalWithSpeakerNames}`);
    console.log(`   ⚠️  Bez speaker imena:     ${totalWithoutSpeakerNames}`);

    // Spremi done cache
    if (!dryRun) {
        saveDoneState(inputDir, doneSet);
        console.log(`   💾 Done cache spremljen: ${doneSet.size} epizoda`);
    }

    console.log("");
}

main();
