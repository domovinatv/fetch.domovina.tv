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

const OUTPUT_DIR = '/Volumes/DOMOVINA1TB/fetch_domovina_tv_output';

if (!fs.existsSync(OUTPUT_DIR)) {
    console.error(`❌ Output direktorij ne postoji: ${OUTPUT_DIR}`);
    console.error(`   Je li disk DOMOVINA1TB mountan?`);
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
    totalArticle: 0,
    totalRagReady: 0
};

console.log("Skeniram direktorije...");

const channels = fs.readdirSync(OUTPUT_DIR).filter(f => {
    const stat = fs.statSync(path.join(OUTPUT_DIR, f));
    return stat.isDirectory() && !f.startsWith('.');
});

for (const channel of channels) {
    const channelPath = path.join(OUTPUT_DIR, channel);

    try {
        const files = fs.readdirSync(channelPath);

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
            } else if (file.endsWith('.article.json')) {
                stats.totalArticle++;
            } else if (file.endsWith('_rag_ready.json')) {
                stats.totalRagReady++;
            }
        }
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
console.log(`   📋 Gemini Sažeci (.canary.summary.json):      ${stats.totalSummary}`);
console.log(`   📰 Gemini Članci (.article.json):             ${stats.totalArticle}`);
console.log(`   🗂️  RAG Ready (_rag_ready.json):              ${stats.totalRagReady}`);
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
    const articlePerc = stats.totalCanaryDiarized > 0
        ? Math.round((stats.totalArticle / stats.totalCanaryDiarized) * 100)
        : 0;
    const ragPerc = stats.totalCanaryDiarized > 0
        ? Math.round((stats.totalRagReady / stats.totalCanaryDiarized) * 100)
        : 0;

    console.log(`   📈 PROGRES:`);
    console.log(`      WAV konverzije:       ${wavPerc}% završeno`);
    console.log(`      Whisper Transkripcije:${srtPerc}% završeno`);
    console.log(`      Whisper Diarizacije:  ${diarPerc}% završeno (od transkribiranog)`);
    console.log(`      Canary Transkripcije: ${canarySrtPerc}% završeno`);
    console.log(`      Canary Diarizacije:   ${canaryDiarPerc}% završeno (od canary)`);
    console.log(`      Gemini Sažeci:        ${summaryPerc}% završeno (od canary diarized)`);
    console.log(`      Gemini Članci:        ${articlePerc}% završeno (od canary diarized)`);
    console.log(`      RAG Ready:            ${ragPerc}% završeno (od canary diarized)`);
    console.log("");
}
