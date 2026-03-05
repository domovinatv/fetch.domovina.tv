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
    totalDiarized: 0
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
            } else if (file.endsWith('.diarized.srt')) {
                stats.totalDiarized++;
            } else if (file.endsWith('.wav.srt')) {
                stats.totalSrt++;
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
console.log(`   🎵 Ukupno preuzetih videa (.mp3):        ${stats.totalMp3}`);
console.log(`   🔊 Uspješno konvertirano u WAV:          ${stats.totalWav}`);
console.log(`   📝 Generirano Whisper promptova (.txt):  ${stats.totalPrompts}`);
console.log(`   🎙️  Završeno transkripcija (.srt):       ${stats.totalSrt}`);
console.log(`   🗣️  Diariziranih titlova (.diarized.srt): ${stats.totalDiarized}`);
console.log("");

// Dodatni postoci (u odnosu na broj MP3 zapisa)
if (stats.totalMp3 > 0) {
    const wavPerc = Math.round((stats.totalWav / stats.totalMp3) * 100);
    const srtPerc = Math.round((stats.totalSrt / stats.totalMp3) * 100);
    const diarPerc = stats.totalSrt > 0
        ? Math.round((stats.totalDiarized / stats.totalSrt) * 100)
        : 0;

    console.log(`   📈 PROGRES:`);
    console.log(`      WAV konverzije: ${wavPerc}% završeno`);
    console.log(`      Transkripcije:  ${srtPerc}% završeno`);
    console.log(`      Diarizacije:    ${diarPerc}% završeno (od transkribiranog)`);
    console.log("");
}
