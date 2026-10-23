#!/usr/bin/env node
/**
 * tools/build_processing_manifest.js — (re)generira `{base}.processing.json` iz datoteka
 * na disku. Nula API poziva. Za backfill i za provjeru; koraci koji pišu nove izvore
 * (transcribe_soniox.js, diarize_pyannote_ai.js) zovu isti lib sami.
 *
 * Epizoda = postoji `{base}.wav.canary.diarized.srt` ili neki cloud ASR meta.
 *
 *   node tools/build_processing_manifest.js --channel muzevni_budite
 *   node tools/build_processing_manifest.js --video-id f2HIRJPHHK4 --print
 *   node tools/build_processing_manifest.js --dry-run
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { writeManifest, extractVideoId } = require("../lib/processing_manifest");

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const INPUT_DIR = getArg("--input-dir") || path.join(__dirname, "..", "storage", "output");
const CHANNEL = getArg("--channel");
const VIDEO_ID = getArg("--video-id");
const DRY_RUN = args.includes("--dry-run");
const PRINT = args.includes("--print");

const EPISODE_MARKERS = [/\.wav\.canary\.diarized\.srt$/, /\.[a-z0-9]+\.soniox\.meta\.json$/, /\.[a-z0-9]+\.speechmatics\.meta\.json$/];

const channels = CHANNEL ? [CHANNEL]
    : fs.readdirSync(INPUT_DIR, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
        .map((e) => e.name).sort();

let changed = 0, same = 0, errors = 0;
for (const ch of channels) {
    const dir = path.join(INPUT_DIR, ch);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => !f.startsWith("._")); } catch { continue; }
    const bases = new Set();
    for (const f of files) {
        const re = EPISODE_MARKERS.find((r) => r.test(f));
        if (!re) continue;
        const base = f.replace(re, "");
        if (VIDEO_ID && extractVideoId(base) !== VIDEO_ID) continue;
        bases.add(base);
    }
    for (const base of bases) {
        try {
            const r = writeManifest(dir, base, { dryRun: DRY_RUN });
            if (r.changed) changed++; else same++;
            if (PRINT) console.log(JSON.stringify(r.doc, null, 2));
        } catch (e) {
            errors++;
            console.log(`   ❌ ${ch}/${base}: ${e.message}`);
        }
    }
}
console.log(`🧾 processing.json — promijenjeno: ${changed} · isto: ${same} · greške: ${errors}${DRY_RUN ? " · DRY RUN" : ""}`);
if (errors) process.exitCode = 1;
