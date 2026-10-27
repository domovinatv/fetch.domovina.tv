#!/usr/bin/env node
/**
 * fix_refine_drift.js — backfill za POMAK ID-a u Gemini sluhu (KORAK 2.8).
 *
 * Do 27.10.2026. refine_diarized_gemini.js nije provjeravao je li tekst segmenta
 * uopće s tog segmenta: Gemini zna točne riječi upisati pod id sljedećeg segmenta i
 * zaostatak raste kroz prozor (ja70p_gJWZA: 49:47–58:57, do 16 segmenata, titl i
 * words.json se razilaze sa zvukom). Ovaj alat nađe takve nizove u postojećim
 * prijepisima (lib/refine_drift.js, nula API poziva) i u njima vrati tekst kostura
 * (Soniox/Speechmatics), koji ima točna vremena riječi. Ostatak Gemini teksta ostaje.
 *
 * Što dira (samo uz --commit):
 *   {base}.wav.canary.diarized.srt         kanonski prijepis (stari → .bak_drift_YYYYMMDD)
 *   {X}.gemini.diarized.srt                isti popravak, da ponovna promocija ne vrati grešku
 *   {X}.gemini.meta.json                   + "drift_fix": {at, segments, runs}
 * Uz --downstream još words.json (--force), segments.jsonl i tri RAG jsonl-a (stari →
 * .bak_drift_*, epizoda se makne iz done-cachea). ClickHouse/Meili u domovina-rag NE
 * vide promjenu sami (ETL preskače indeksirane epizode) — vidi doc, „RAG re-ingest".
 * Uz --upload još CDN: force_upload.js --targets diarized,words (+ bundle 12.7, CF purge).
 *
 * Članak i sažetak se NE diraju: sadržaj im je isti, samo je prijepis bio razmješten.
 *
 * Uporaba:
 *   node tools/fix_refine_drift.js                                  # suho, cijeli katalog
 *   node tools/fix_refine_drift.js --video-id ja70p_gJWZA -v        # detalji po nizu
 *   node tools/fix_refine_drift.js --commit --downstream --upload   # backfill do CDN-a
 *
 * Vidi docs/2026-10-27-gemini-sluh-pomak-id.md.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { detectDrift } = require("../lib/refine_drift");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const INPUT_DIR = getArg("--input-dir") || path.join(ROOT, "storage", "output");
const ONLY_CHANNEL = getArg("--channel");
const ONLY_VIDEO = getArg("--video-id");
const COMMIT = args.includes("--commit");
const DOWNSTREAM = args.includes("--downstream");
const UPLOAD = args.includes("--upload");
const VERBOSE = args.includes("-v") || args.includes("--verbose");

const GEMINI_SUFFIX = ".gemini.diarized.srt";
const CANON_SUFFIX = ".wav.canary.diarized.srt";

// SRT → blokovi {raw: [linije], time, text}. Tekst = sve linije iza vremena.
function parseSrt(content) {
    return content.replace(/\r/g, "").split(/\n\n+/).map((b) => b.split("\n"))
        .filter((l) => l.length >= 2 && l[1].includes("-->"))
        .map((l) => ({ lines: l, time: l[1].trim(), text: l.slice(2).join(" ") }));
}
function renderSrt(blocks) {
    return blocks.map((b) => b.lines.join("\n")).join("\n\n") + "\n";
}
function videoIdOf(name) {
    const m = name.match(/_yt_([A-Za-z0-9_-]{11})(?=\.)/g);
    return m ? m[m.length - 1].slice(4) : null;
}

// Zamijeni tekst sumnjivih blokova tekstom kostura (isti indeks, isto vrijeme).
function patch(target, skel, suspect) {
    return target.map((b, i) => (suspect.has(i) ? { ...b, lines: [b.lines[0], b.lines[1], ...skel[i].lines.slice(2)] } : b));
}

function sameTimes(a, b) {
    return a.length === b.length && a.every((x, i) => x.time === b[i].time);
}

function* episodes() {
    for (const ch of fs.readdirSync(INPUT_DIR).sort()) {
        if (ONLY_CHANNEL && ch !== ONLY_CHANNEL) continue;
        const dir = path.join(INPUT_DIR, ch);
        let files;
        try { files = fs.readdirSync(dir); } catch (_) { continue; }
        const set = new Set(files);
        for (const f of files) {
            if (!f.endsWith(GEMINI_SUFFIX)) continue;
            const vid = videoIdOf(f);
            if (ONLY_VIDEO && vid !== ONLY_VIDEO) continue;
            const stem = f.slice(0, -GEMINI_SUFFIX.length);        // {base}.mp3.soniox_pyannote
            const skel = stem + ".diarized.srt";
            if (!set.has(skel)) continue;
            const base = stem.replace(/\.(mp3|wav|m4a)\..*$/, "");
            yield { ch, dir, vid, base, gemini: f, skel, canon: set.has(base + CANON_SUFFIX) ? base + CANON_SUFFIX : null, meta: set.has(stem + ".gemini.meta.json") ? stem + ".gemini.meta.json" : null };
        }
    }
}

// [skripta, sufiks izlaza, done-cache] — isti redoslijed kao KORAK 9 u run_pipeline.sh.
const RAG_STEPS = [
    ["prepare_rag_combined.js", ".rag_combined.jsonl", "rag-combined-done.json"],
    ["prepare_rag_import.js", ".rag_import.jsonl", "rag-import-done.json"],
    ["prepare_rag.js", ".rag_chunks.jsonl", "rag-chunks-done.json"],
];

const REINGEST_QUEUE = process.env.RAG_REINGEST_QUEUE || path.join(ROOT, "..", "domovina-rag", ".reingest-queue");

function unmarkDone(statePath, base) {
    let data;
    try { data = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch (_) { return; }
    if (!Array.isArray(data.completed) || !data.completed.includes(base)) return;
    data.completed = data.completed.filter((b) => b !== base);
    fs.writeFileSync(statePath + ".tmp", JSON.stringify(data, null, 2));
    fs.renameSync(statePath + ".tmp", statePath);
}

function run(cmd, cmdArgs) {
    console.log(`      $ ${cmd} ${cmdArgs.join(" ")}`);
    execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit" });
}

function main() {
    console.log(`🔎 Pomak id-a u Gemini sluhu — ${COMMIT ? "COMMIT" : "suho (bez --commit ništa ne piše)"}`);
    const stats = { scanned: 0, drifted: 0, segments: 0, skipped: 0, fixed: 0 };
    const toUpload = new Map();   // vid → kanal (kanal bez „_" ima prednost)
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

    for (const ep of episodes()) {
        stats.scanned++;
        const G = parseSrt(fs.readFileSync(path.join(ep.dir, ep.gemini), "utf8"));
        const S = parseSrt(fs.readFileSync(path.join(ep.dir, ep.skel), "utf8"));
        if (!sameTimes(G, S)) { stats.skipped++; console.log(`   ⚠️  ${ep.ch}/${ep.vid}: kostur i Gemini nemaju iste cue-ove — preskačem`); continue; }

        const { runs, suspect } = detectDrift(G.map((b) => b.text), S.map((b) => b.text));
        if (!runs.length) continue;
        stats.drifted++;
        stats.segments += suspect.size;
        console.log(`   🔀 ${ep.ch}/${ep.vid}  ${suspect.size} seg u ${runs.length} niz(a): ` +
            runs.map((r) => `${G[r.from].time.slice(0, 8)}–${G[r.to].time.slice(0, 8)} (do ${r.maxShift})`).join(", "));
        if (VERBOSE) {
            for (const i of [...suspect].slice(0, 12)) {
                console.log(`        ${G[i].time.slice(0, 8)}  G: ${G[i].text.slice(0, 90)}`);
                console.log(`                  K: ${S[i].text.slice(0, 90)}`);
            }
        }

        // Kanonski smije biti samo promovirani Gemini (isti cue-ovi i tekst); inače ga
        // je nešto drugo prepisalo poslije i ne diramo ga.
        let C = null;
        if (ep.canon) {
            C = parseSrt(fs.readFileSync(path.join(ep.dir, ep.canon), "utf8"));
            if (!sameTimes(C, G) || C.some((b, i) => b.text !== G[i].text)) {
                console.log(`      ⏭️  ${CANON_SUFFIX} nije ovaj Gemini prijepis — kanonski ne diram`);
                C = null;
            }
        }
        if (!COMMIT) continue;

        fs.writeFileSync(path.join(ep.dir, ep.gemini), renderSrt(patch(G, S, suspect)), "utf8");
        if (C) {
            const canonPath = path.join(ep.dir, ep.canon);
            const bak = `${canonPath}.bak_drift_${stamp}`;
            if (!fs.existsSync(bak)) fs.copyFileSync(canonPath, bak);
            fs.writeFileSync(canonPath, renderSrt(patch(C, S, suspect)), "utf8");
        }
        if (ep.meta) {
            const mp = path.join(ep.dir, ep.meta);
            const meta = JSON.parse(fs.readFileSync(mp, "utf8"));
            meta.drift_fix = { at: new Date().toISOString(), tool: "tools/fix_refine_drift.js", segments: suspect.size,
                runs: runs.map((r) => ({ from: G[r.from].time.slice(0, 12), to: G[r.to].time.slice(0, 12), max_shift: r.maxShift })) };
            fs.writeFileSync(mp, JSON.stringify(meta, null, 2), "utf8");
        }
        stats.fixed++;
        console.log(`      ✅ zapisano${C ? " (+ kanonski, stari u .bak_drift_" + stamp + ")" : ""}`);

        if (C && DOWNSTREAM) {
            run("node", ["generate_words_json.js", "--input-dir", INPUT_DIR, "--channel", ep.ch, "--video-id", ep.vid, "--force"]);
            // RAG skripte preskaču epizodu kad izlaz postoji ILI je u done-cacheu. NE
            // --rebuild-state: ono na kraju prepiše cijeli cache samo ovom epizodom.
            // Stari izlaz se preimenuje (ne briše), epizoda se makne iz cachea.
            for (const [script, suffix, state] of RAG_STEPS) {
                const out = path.join(ep.dir, ep.base + suffix);
                if (fs.existsSync(out)) fs.renameSync(out, `${out}.bak_drift_${stamp}`);
                unmarkDone(path.join(INPUT_DIR, state), ep.base);
                run("node", [script, "--input-dir", INPUT_DIR, "--channel", ep.ch, "--video-id", ep.vid,
                    ...(script === "prepare_rag_combined.js" ? ["--rebuild-segments"] : [])]);
            }
            // domovina-rag ETL preskače već indeksirane epizode; red čekanja ih noćni
            // sync (04:00) obriše lokalno + cloud i unese ponovno (sync-incremental.sh §0.5).
            if (fs.existsSync(path.dirname(REINGEST_QUEUE))) {
                fs.appendFileSync(REINGEST_QUEUE, ep.vid + "\n");
                console.log(`      📥 ${ep.vid} → ${REINGEST_QUEUE}`);
            }
        }
        if (C && UPLOAD) {
            const prev = toUpload.get(ep.vid);
            if (!prev || prev.startsWith("_")) toUpload.set(ep.vid, ep.ch);
        }
    }

    if (UPLOAD && COMMIT) {
        if (!DOWNSTREAM) console.log("   ⚠️  --upload bez --downstream: words.json na CDN-u bi bio iz STAROG prijepisa — preskačem upload.");
        else for (const [vid, ch] of toUpload) {
            run("node", ["force_upload.js", "--video-id", vid, "--channel", ch, "--targets", "diarized,words"]);
        }
    }

    console.log(`\n   pregledano ${stats.scanned} · s pomakom ${stats.drifted} (${stats.segments} seg) · preskočeno ${stats.skipped}` +
        (COMMIT ? ` · popravljeno ${stats.fixed}` : ""));
}

if (require.main === module) main();
module.exports = { parseSrt, renderSrt, patch, videoIdOf };
