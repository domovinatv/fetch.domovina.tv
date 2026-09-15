#!/usr/bin/env node
"use strict";
/**
 * tools/rebuild_summary_md.js — ponovno složi `.canary.summary.md` iz postojećeg
 * `.canary.summary.json`. **NE ZOVE NIJEDAN LLM** — sav sadržaj već je na disku,
 * mijenja se samo formatiranje (npr. linkovi koji su vodili na YouTube, a sada
 * vode na domovina.ai).
 *
 * Zašto zasebna skripta: `summarize_gemini.js` piše .md samo uz svježu
 * sumarizaciju, a ponovno sumariziranje 3000+ epizoda radi jednog retka bilo bi
 * apsurdno skupo. Markdown se gradi istom funkcijom (`buildSummaryMarkdown`)
 * koju koristi i pipeline, pa formati ne mogu razići.
 *
 * Primjeri:
 *   node tools/rebuild_summary_md.js --dry-run
 *   node tools/rebuild_summary_md.js --channel bozanstvena_komedija
 *   node tools/rebuild_summary_md.js --video-id rAAplrRelPM
 *   node tools/rebuild_summary_md.js            # cijeli katalog
 *
 * Nakon ovoga .md na disku i .md na R2 se razlikuju — za isporuku treba
 * `node upload_to_r2.js ...` (data/ ključevi su immutable, vidi force_upload.js).
 */

const fs = require("fs");
const path = require("path");
const { buildSummaryMarkdown } = require("../summarize_gemini.js");

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const INPUT_DIR = getArg("--input-dir") || path.join(__dirname, "..", "storage", "output");
const ONLY_CHANNEL = getArg("--channel");
const ONLY_VIDEO_ID = getArg("--video-id");
const LIMIT = parseInt(getArg("--limit") || "0", 10) || 0;
const DRY_RUN = args.includes("--dry-run");

const SUMMARY_JSON_SUFFIX = ".canary.summary.json";
const SUMMARY_MD_SUFFIX = ".canary.summary.md";

/** Zadnji `_yt_XXXXXXXXXXX` u imenu — naslovi znaju sadržavati "_yt_". */
function extractVideoId(filename) {
    const matches = [...filename.matchAll(/_yt_([A-Za-z0-9_-]{11})/g)];
    return matches.length ? matches[matches.length - 1][1] : null;
}

// Kanali su simlinkovi na vanjske diskove — isDirectory() je na njima false.
function listChannelDirs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();
}

function main() {
    if (!fs.existsSync(INPUT_DIR)) {
        console.error(`❌ Ulazni direktorij ne postoji: ${INPUT_DIR}`);
        process.exit(1);
    }
    console.log(`📝 Rebuild .canary.summary.md — ulaz: ${INPUT_DIR}`);
    if (DRY_RUN) console.log("   ⚠️  DRY RUN — ništa se ne piše");

    const channels = ONLY_CHANNEL ? [ONLY_CHANNEL] : listChannelDirs(INPUT_DIR);
    let written = 0, unchanged = 0, failed = 0, missing = 0;

    for (const channel of channels) {
        const channelDir = path.join(INPUT_DIR, channel);
        let files;
        try {
            files = fs.readdirSync(channelDir).filter((f) => f.endsWith(SUMMARY_JSON_SUFFIX));
        } catch { continue; }

        for (const f of files) {
            if (LIMIT && written + unchanged >= LIMIT) break;
            const base = f.slice(0, -SUMMARY_JSON_SUFFIX.length);
            if (ONLY_VIDEO_ID && extractVideoId(base) !== ONLY_VIDEO_ID) continue;

            const jsonPath = path.join(channelDir, f);
            const mdPath = path.join(channelDir, `${base}${SUMMARY_MD_SUFFIX}`);
            let json;
            try {
                json = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
            } catch (e) {
                console.log(`   ❌ ${base} — neispravan JSON: ${e.message}`);
                failed++;
                continue;
            }
            if (!json || !json.summary) { missing++; continue; }

            let md;
            try {
                md = buildSummaryMarkdown(json);
            } catch (e) {
                console.log(`   ❌ ${base} — ${e.message}`);
                failed++;
                continue;
            }
            const old = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, "utf-8") : null;
            if (old === md) { unchanged++; continue; }
            if (!DRY_RUN) fs.writeFileSync(mdPath, md);
            written++;
            if (written <= 5 || written % 250 === 0) console.log(`   ✅ ${channel}/${base}`);
        }
        if (LIMIT && written + unchanged >= LIMIT) break;
    }

    console.log(`\n📊 Gotovo: ${written} osvježeno · ${unchanged} bez promjene · ${missing} bez summary bloka · ${failed} grešaka`);
    if (written > 0 && !DRY_RUN) {
        console.log("   ℹ️  .md na R2 je sada zastario — pokreni upload (data/ ključevi su immutable).");
    }
    if (failed > 0) process.exitCode = 1;
}

main();
