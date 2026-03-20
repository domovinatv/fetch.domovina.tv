#!/usr/bin/env node

/**
 * count_progress.js
 * 
 * Skripta koja skenira stvarne datoteke na disku u output direktoriju
 * i broji stvarni progres:
 * 1. Koliko ima .mp3 datoteka (preuzetih)
 * 2. Koliko ima .wav datoteka (konvertiranih)
 * 3. Koliko ima _whisper_prompt.txt datoteka (LLM ključne riječi)
 * 4. Koliko ima .wav.srt datoteka (završenih transkripcija)
 * 5. Koliko ima .diarized.srt datoteka (diariziranih titlova)
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const inputDirIdx = args.indexOf('--input-dir');
const OUTPUT_DIR = inputDirIdx !== -1 && inputDirIdx + 1 < args.length
    ? args[inputDirIdx + 1]
    : '/Volumes/DOMOVINA1TB/fetch_domovina_tv_output';

if (!fs.existsSync(OUTPUT_DIR)) {
    console.error(`❌ Output direktorij ne postoji: ${OUTPUT_DIR}`);
    console.error(`   Je li disk mountan? Ili koristi: node count_progress.js --input-dir <putanja>`);
    process.exit(1);
}

const stats = {
    totalMp3: 0,
    totalWav: 0,
    totalPrompts: 0,
    totalSrt: 0,
    totalDiarized: 0,
    totalCanarySrt: 0,
    totalCanaryDiarized: 0,
    totalSummary: 0,
    totalOutline: 0,
    totalArticle: 0,
    totalRagChunks: 0,
    totalRagImport: 0,
    totalRagCombined: 0,
    totalSummaryBlocked: 0,
    totalArticleBlocked: 0
};

// Brojači po modelu: ukupno datoteka i unikatnih videa
const outlinesByModel = {};
const articlesByModel = {};
const outlineVideosByModel = {};
const articleVideosByModel = {};

console.log("Skeniram direktorije...");

const channels = fs.readdirSync(OUTPUT_DIR).filter(f => {
    const stat = fs.statSync(path.join(OUTPUT_DIR, f));
    return stat.isDirectory() && !f.startsWith('.');
});

for (const channel of channels) {
    const channelPath = path.join(OUTPUT_DIR, channel);

    try {
        const files = fs.readdirSync(channelPath);

        // Za outline/article brojimo unikatne videe i ukupne datoteke po modelu
        const videosWithOutline = new Set();
        const videosWithArticle = new Set();

        for (const file of files) {
            // Ignoriraj macOS resource fork datoteke
            if (file.startsWith('._')) continue;

            if (file.endsWith('.mp3')) {
                stats.totalMp3++;
            } else if (file.endsWith('.wav')) {
                stats.totalWav++;
            } else if (file.endsWith('_whisper_prompt.txt')) {
                stats.totalPrompts++;
            } else if (file.endsWith('.canary.diarized.srt')) {
                stats.totalCanaryDiarized++;
            } else if (file.endsWith('.canary.srt')) {
                stats.totalCanarySrt++;
            } else if (file.endsWith('.diarized.srt')) {
                stats.totalDiarized++;
            } else if (file.endsWith('.wav.srt')) {
                stats.totalSrt++;
            } else if (file.endsWith('.canary.summary.json')) {
                stats.totalSummary++;
            } else if (file.endsWith('.outline.json')) {
                const base = file.replace(/\.wav\.canary\.diarized_.*\.outline\.json$/, '');
                videosWithOutline.add(base);
                const modelMatch = file.match(/\.wav\.canary\.diarized_\d{4}-\d{2}-\d{2}_(.+)\.outline\.json$/);
                if (modelMatch) {
                    const model = modelMatch[1];
                    outlinesByModel[model] = (outlinesByModel[model] || 0) + 1;
                    if (!outlineVideosByModel[model]) outlineVideosByModel[model] = new Set();
                    outlineVideosByModel[model].add(base);
                }
            } else if (file.endsWith('.article.json')) {
                const base = file.replace(/\.wav\.canary\.diarized_.*\.article\.json$/, '');
                videosWithArticle.add(base);
                const modelMatch = file.match(/\.wav\.canary\.diarized_\d{4}-\d{2}-\d{2}_(.+)\.article\.json$/);
                if (modelMatch) {
                    const model = modelMatch[1];
                    articlesByModel[model] = (articlesByModel[model] || 0) + 1;
                    if (!articleVideosByModel[model]) articleVideosByModel[model] = new Set();
                    articleVideosByModel[model].add(base);
                }
            } else if (file.endsWith('.canary.summary.blocked.json')) {
                stats.totalSummaryBlocked++;
            } else if (file.endsWith('.canary.diarized.blocked.json')) {
                stats.totalArticleBlocked++;
            } else if (file.endsWith('.rag_chunks.jsonl')) {
                stats.totalRagChunks++;
            } else if (file.endsWith('.rag_import.jsonl')) {
                stats.totalRagImport++;
            } else if (file.endsWith('.rag_combined.jsonl')) {
                stats.totalRagCombined++;
            }
        }

        stats.totalOutline += videosWithOutline.size;
        stats.totalArticle += videosWithArticle.size;
    } catch (e) {
        console.error(`Greška pri čitanju: ${channelPath} - ${e.message}`);
    }
}

console.log("\n╔══════════════════════════════════════════════════╗");
console.log("║   📊 STVARNI PROGRES NA DISKU                    ║");
console.log("╚══════════════════════════════════════════════════╝");
console.log("");
console.log(`   🎵 Ukupno preuzetih videa (.mp3):             ${stats.totalMp3}`);
console.log(`   🔊 Uspješno konvertirano u WAV:               ${stats.totalWav}`);
console.log(`   📝 Generirano Whisper promptova (.txt):       ${stats.totalPrompts}`);
console.log(`   🎙️  Završeno Whisper (.srt):                  ${stats.totalSrt}`);
console.log(`   🗣️  Whisper Diarizirano (.diarized.srt):      ${stats.totalDiarized}`);
console.log(`   🦅 Canary Transkribirano (.canary.srt):       ${stats.totalCanarySrt}`);
console.log(`   🦜 Canary Diarizirano (.canary.diarized.srt): ${stats.totalCanaryDiarized}`);
console.log(`   📋 Gemini Sažeci (.canary.summary.json):      ${stats.totalSummary}${stats.totalSummaryBlocked > 0 ? ` (🚫 ${stats.totalSummaryBlocked} blokirano)` : ''}`);
console.log(`   📑 Gemini Outlinei (.outline.json):           ${stats.totalOutline} videa`);
const outlineModels = Object.entries(outlinesByModel).sort((a, b) => b[1] - a[1]);
for (const [model, count] of outlineModels) {
    const videos = outlineVideosByModel[model]?.size || 0;
    console.log(`      └─ ${model}: ${videos} videa (${count} datoteka)`);
}
console.log(`   📰 Gemini Članci (.article.json):             ${stats.totalArticle} videa${stats.totalArticleBlocked > 0 ? ` (🚫 ${stats.totalArticleBlocked} blokirano)` : ''}`);
const articleModels = Object.entries(articlesByModel).sort((a, b) => b[1] - a[1]);
for (const [model, count] of articleModels) {
    const videos = articleVideosByModel[model]?.size || 0;
    console.log(`      └─ ${model}: ${videos} videa (${count} datoteka)`);
}
console.log(`   🧩 RAG Chunks (.rag_chunks.jsonl):            ${stats.totalRagChunks}`);
console.log(`   🗂️  RAG Import (.rag_import.jsonl):           ${stats.totalRagImport}`);
console.log(`   🧬 RAG Combined (.rag_combined.jsonl):       ${stats.totalRagCombined}`);
console.log("");

// Dodatni postoci (u odnosu na broj MP3 zapisa)
if (stats.totalMp3 > 0) {
    const wavPerc = Math.round((stats.totalWav / stats.totalMp3) * 100);
    const srtPerc = Math.round((stats.totalSrt / stats.totalMp3) * 100);
    const canarySrtPerc = Math.round((stats.totalCanarySrt / stats.totalMp3) * 100);
    const diarPerc = stats.totalSrt > 0
        ? Math.round((stats.totalDiarized / stats.totalSrt) * 100)
        : 0;
    const canaryDiarPerc = stats.totalCanarySrt > 0
        ? Math.round((stats.totalCanaryDiarized / stats.totalCanarySrt) * 100)
        : 0;
    const summaryPerc = stats.totalCanaryDiarized > 0
        ? Math.round((stats.totalSummary / stats.totalCanaryDiarized) * 100)
        : 0;
    const outlinePerc = stats.totalCanaryDiarized > 0
        ? Math.round((stats.totalOutline / stats.totalCanaryDiarized) * 100)
        : 0;
    const articlePerc = stats.totalCanaryDiarized > 0
        ? Math.round((stats.totalArticle / stats.totalCanaryDiarized) * 100)
        : 0;
    const ragChunksPerc = stats.totalCanaryDiarized > 0
        ? Math.round((stats.totalRagChunks / stats.totalCanaryDiarized) * 100)
        : 0;
    const ragImportPerc = stats.totalCanaryDiarized > 0
        ? Math.round((stats.totalRagImport / stats.totalCanaryDiarized) * 100)
        : 0;
    const ragCombinedPerc = stats.totalCanaryDiarized > 0
        ? Math.round((stats.totalRagCombined / stats.totalCanaryDiarized) * 100)
        : 0;

    console.log(`   📈 PROGRES:`);
    console.log(`      WAV konverzije:       ${wavPerc}% završeno`);
    console.log(`      Whisper Transkripcije:${srtPerc}% završeno`);
    console.log(`      Whisper Diarizacije:  ${diarPerc}% završeno (od transkribiranog)`);
    console.log(`      Canary Transkripcije: ${canarySrtPerc}% završeno`);
    console.log(`      Canary Diarizacije:   ${canaryDiarPerc}% završeno (od canary)`);
    console.log(`      Gemini Sažeci:        ${summaryPerc}% završeno (od canary diarized)`);
    console.log(`      Gemini Outlinei:      ${outlinePerc}% završeno (od canary diarized)`);
    console.log(`      Gemini Članci:        ${articlePerc}% završeno (od canary diarized)`);
    console.log(`      RAG Chunks:           ${ragChunksPerc}% završeno (od canary diarized)`);
    console.log(`      RAG Import:           ${ragImportPerc}% završeno (od canary diarized)`);
    console.log(`      RAG Combined:         ${ragCombinedPerc}% završeno (od canary diarized)`);
    console.log("");
}
