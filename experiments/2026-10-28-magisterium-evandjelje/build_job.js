#!/usr/bin/env node
'use strict';

/**
 * build_job.js — eksperiment: zašto Magisterium daje niske ocjene epizodi koja čita
 * evanđelje dana (ora_et_labora, ep. 120, overall 71).
 *
 * Gradi job.json za tools/magisterium_mcp_client.js run. Svaka varijanta koristi
 * PRODUKCIJSKI prompt (kopija buildBatchPrompt iz magisterium_mcp_prep.js, batch-of-1,
 * ista skala), mijenja se samo ULAZ:
 *   - doslovni prijepis (kanonski SRT) umjesto Opusova prepričavanja,
 *   - samo liturgijski tekst (evanđelje, prvo čitanje) bez komentara,
 *   - ponovljeni produkcijski ulaz (šum mjerenja).
 *
 * Uporaba:
 *   node experiments/2026-10-28-magisterium-evandjelje/build_job.js --dir <kanal_dir> --base <basename> --out <dir>
 *   node tools/magisterium_mcp_client.js run --job <out>/analiza.job.json --results-dir <out>/results
 */

const fs = require('fs');
const path = require('path');
const { trimToWords } = require('../../magisterium_mcp_prep.js');

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const dir = getArg('--dir');
const base = getArg('--base');
const outDir = getArg('--out');
const articleTag = getArg('--article-tag') || '2026-10-27_opus';
if (!dir || !base || !outDir) {
    console.error('Uporaba: --dir <kanal_dir> --base <basename> --out <dir>');
    process.exit(1);
}

function timeToSeconds(t) {
    const [h, m, s] = t.replace(',', '.').split(':');
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

// Doslovni tekst kanonskog SRT-a u rasponu [od, do), bez [SPEAKER_xx] oznaka.
function transcriptRange(srt, from, to) {
    const a = timeToSeconds(from), b = timeToSeconds(to);
    const out = [];
    for (const blk of srt.trim().split(/\n\n+/)) {
        const lines = blk.split('\n');
        if (lines.length < 3) continue;
        const start = timeToSeconds(lines[1].split(' --> ')[0]);
        if (start >= a && start < b) out.push(lines.slice(2).join(' ').replace(/^\[(\w+)\]\s*/, ''));
    }
    return out.join(' ');
}

// Kopija magisterium_mcp_prep.js:buildBatchPrompt za batch-of-1 (index 0).
function buildBatchPrompt(podcastTitle, item, maxWords = 600) {
    const content = trimToWords(item.content || '', maxWords);
    const block = [
        `=== SEKCIJA 0 ===`,
        `Blok: ${item.iterationTheme}`,
        `Tema: ${item.subtitle || '(bez naslova)'}`,
        item.keywords ? `Ključni pojmovi: ${item.keywords}` : null,
        item.entities ? `Osobe/organizacije: ${item.entities}` : null,
        `Sadržaj:\n${content}`,
    ].filter(Boolean).join('\n');

    return `Ti si teološki analitičar. Evaluiraj usklađenost sljedećih 1 odlomaka iz katoličkog podcasta s katoličkim naukom i Svetim pismom. Vrati ISKLJUČIVO JSON bez komentara.

Podcast: ${podcastTitle}

${block}

Za svaku sekciju (indeksi 0–0) vrati JSON točno ovog oblika:
{
  "results": [
    {
      "index": 0,
      "score": <cijeli broj 0-100>,
      "assessment": "<1-2 rečenice teološke procjene na hrvatskom>",
      "concerns": ["<eventualni teološki problemi; prazna lista ako nema>"],
      "enrichment": "<2-3 rečenice teološkog konteksta koji obogaćuje razumijevanje>"
    }
  ]
}

Skala usklađenosti:
90-100 = aktivno promiče i produbljuje katolički nauk
70-89  = uglavnom usklađeno, bez bitnih problema
50-69  = djelomično usklađeno, postoje nejasnoće
30-49  = značajno odstupanje od crkvenog nauka
0-29   = proturječi katoličkom nauku ili Svetom pismu`;
}

const srt = fs.readFileSync(path.join(dir, `${base}.wav.canary.diarized.srt`), 'utf-8');
const articleBase = `${base}.wav.canary.diarized_${articleTag}`;
const article = JSON.parse(fs.readFileSync(path.join(dir, `${articleBase}.article.json`), 'utf-8'));
const mag = JSON.parse(fs.readFileSync(path.join(dir, `${articleBase}.article.magisterium.json`), 'utf-8'));
const podcastTitle = (article.metadata && (article.metadata.title || article.metadata.naslov)) || articleBase;

// Sekcije članka po screenshot_timestamp (+ produkcijska ocjena i tema bloka)
const sections = {};
for (const it of mag.iterations) {
    for (const s of it.sections) {
        sections[s.screenshot_timestamp] = { ...s, iterationTheme: it.theme, prodScore: s.magisterium && s.magisterium.score };
    }
}
function fromArticle(ts) {
    const s = sections[ts];
    return {
        iterationTheme: s.iterationTheme, subtitle: s.subtitle, content: s.content,
        keywords: (s.keywords || []).join(', '), entities: (s.entities || []).join(', '),
    };
}
function fromTranscript(ts, from, to) {
    const s = sections[ts];
    return { iterationTheme: s.iterationTheme, subtitle: s.subtitle, content: transcriptRange(srt, from, to) };
}

// [ime, opis, ulaz, produkcijska ocjena za usporedbu]
const variants = [
    ['evandjelje_doslovno', 'Samo evanđelje dana (Lk 13,18-21), doslovno iz prijepisa',
        { iterationTheme: sections['01:30:10'].iterationTheme, subtitle: 'Evanđelje dana: gorušičino zrno i kvasac',
          content: transcriptRange(srt, '01:30:08', '01:30:40') }, null],
    ['evandjelje_doslovno_r2', 'Ponovljeno: samo evanđelje dana (šum)',
        { iterationTheme: sections['01:30:10'].iterationTheme, subtitle: 'Evanđelje dana: gorušičino zrno i kvasac',
          content: transcriptRange(srt, '01:30:08', '01:30:40') }, null],
    ['citanje_ef5_doslovno', 'Samo prvo čitanje (Ef 5,21-33), doslovno iz prijepisa',
        { iterationTheme: sections['00:39:24'].iterationTheme, subtitle: 'Prvo čitanje: Poslanica Efežanima',
          content: transcriptRange(srt, '00:38:07', '00:39:24') }, null],
    ['s013010_clanak_r2', 'Produkcijski ulaz ponovljen (Opus članak, sekcija 01:30:10)', fromArticle('01:30:10'), sections['01:30:10'].prodScore],
    ['s013010_prijepis', 'Ista sekcija 01:30:10, doslovni prijepis (evanđelje + komentar)', fromTranscript('01:30:10', '01:30:08', '01:31:15'), sections['01:30:10'].prodScore],
    ['s004611_clanak_r2', 'Produkcijski ulaz ponovljen (Opus članak, sekcija 00:46:11)', fromArticle('00:46:11'), sections['00:46:11'].prodScore],
    ['s004611_prijepis', 'Ista sekcija 00:46:11, doslovni prijepis', fromTranscript('00:46:11', '00:46:11', '00:49:32'), sections['00:46:11'].prodScore],
    ['s011305_prijepis', 'Sekcija 01:13:05, doslovni prijepis', fromTranscript('01:13:05', '01:13:05', '01:15:00'), sections['01:13:05'].prodScore],
    ['s000025_prijepis', 'Molitva oslobođenja 00:00:25, doslovni prijepis', fromTranscript('00:00:25', '00:00:20', '00:01:58'), sections['00:00:25'].prodScore],
];

fs.mkdirSync(outDir, { recursive: true });
const batches = variants.map(([name, desc, input, prod], i) => ({
    batchIndex: i, name, desc, prodScore: prod,
    words: input.content.split(/\s+/).length,
    prompt: buildBatchPrompt(podcastTitle, input),
}));
const job = {
    basename: base,
    // client uvijek šalje holistički prompt prvi; ovdje je to kontrola: samo evanđelje kao "struktura"
    holisticPrompt: batches[0].prompt,
    batches,
};
fs.writeFileSync(path.join(outDir, 'analiza.job.json'), JSON.stringify(job, null, 1));
const promptDir = path.join(outDir, 'prompts');
fs.mkdirSync(promptDir, { recursive: true });
batches.forEach(b => fs.writeFileSync(path.join(promptDir, `batch_${String(b.batchIndex).padStart(2, '0')}_${b.name}.txt`), b.prompt));
for (const b of batches) console.log(`${String(b.batchIndex).padStart(2, '0')} ${b.name.padEnd(24)} ${String(b.words).padStart(4)} rij.  prod=${b.prodScore ?? '-'}  ${b.desc}`);
