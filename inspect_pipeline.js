#!/usr/bin/env node

/**
 * inspect_pipeline.js
 *
 * Inspekcijska skripta koja skenira output direktorij i detektira anomalije
 * u pipeline datotekama: prazne datoteke, pokvarene JSON-ove, nedostajuće
 * korake, article.json bez iteracija, itd.
 *
 * Primjeri:
 *   node inspect_pipeline.js
 *   node inspect_pipeline.js --channel domovina_tv
 *   node inspect_pipeline.js --input-dir /path/to/output
 *   node inspect_pipeline.js --verbose
 *   node inspect_pipeline.js --fix-suggestions
 */

const fs = require("fs");
const path = require("path");

// ─── KONFIGURACIJA ───────────────────────────────────────────────

const DEFAULT_OUTPUT_DIR = "/Volumes/DOMOVINA1TB/fetch_domovina_tv_output";

const SUFFIXES = {
    mp3: ".mp3",
    wav: ".wav",
    whisperPrompt: "_whisper_prompt.txt",
    whisperSrt: ".wav.srt",
    diarizedSrt: ".diarized.srt",
    canarySrt: ".canary.srt",
    canaryDiarized: ".canary.diarized.srt",
    summary: ".canary.summary.json",
    ragChunks: ".rag_chunks.jsonl",
    ragImport: ".rag_import.jsonl",
    ragCombined: ".rag_combined.jsonl"
};

// Minimalne očekivane veličine datoteka (u bajtovima)
const MIN_SIZES = {
    mp3: 10000,           // 10 KB — najmanji podcast
    wav: 100000,          // 100 KB
    canarySrt: 500,       // 500 B — barem par SRT blokova
    canaryDiarized: 500,
    summary: 200,         // 200 B — minimalni JSON
    ragChunks: 100,
    ragImport: 100,
    ragCombined: 100
};

// ─── CLI ─────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    function getArg(name) {
        const idx = args.indexOf(name);
        return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
    }

    return {
        inputDir: getArg("--input-dir") || DEFAULT_OUTPUT_DIR,
        channel: getArg("--channel"),
        verbose: args.includes("--verbose"),
        fixSuggestions: args.includes("--fix-suggestions")
    };
}

// ─── INSPEKCIJA ──────────────────────────────────────────────────

function inspectChannel(channelDir, channelName, verbose) {
    const files = fs.readdirSync(channelDir);
    const anomalies = [];

    // Grupiraj datoteke po base imenu (prije .wav.canary...)
    const bases = new Set();
    for (const f of files) {
        if (f.startsWith("._")) continue;
        if (f.endsWith(".mp3")) {
            bases.add(f.replace(/\.mp3$/, ""));
        }
    }

    for (const base of [...bases].sort()) {
        const videoAnomalies = [];
        const fileMap = {};

        // Provjeri sve korake pipeline-a
        const checks = [
            { key: "mp3", file: `${base}.mp3` },
            { key: "wav", file: `${base}.wav` },
            { key: "whisperPrompt", file: `${base}_whisper_prompt.txt` },
            { key: "whisperSrt", file: `${base}.wav.srt` },
            { key: "canarySrt", file: `${base}.wav.canary.srt` },
            { key: "canaryDiarized", file: `${base}.wav.canary.diarized.srt` },
            { key: "summary", file: `${base}.wav.canary.summary.json` },
            { key: "ragChunks", file: `${base}.rag_chunks.jsonl` }
        ];

        for (const { key, file } of checks) {
            const fullPath = path.join(channelDir, file);
            if (fs.existsSync(fullPath)) {
                const stat = fs.statSync(fullPath);
                fileMap[key] = { exists: true, size: stat.size, path: fullPath };

                // Provjera minimalne veličine
                if (MIN_SIZES[key] && stat.size < MIN_SIZES[key]) {
                    videoAnomalies.push({
                        type: "TINY_FILE",
                        severity: "warn",
                        file: file,
                        detail: `${stat.size} B (min očekivano: ${MIN_SIZES[key]} B)`
                    });
                }

                // Provjera prazne datoteke
                if (stat.size === 0) {
                    videoAnomalies.push({
                        type: "EMPTY_FILE",
                        severity: "error",
                        file: file,
                        detail: "Datoteka je prazna (0 bajtova)"
                    });
                }
            } else {
                fileMap[key] = { exists: false };
            }
        }

        // Provjeri pipeline redoslijed — ako postoji kasniji korak ali ne prethodni
        if (fileMap.canaryDiarized.exists && !fileMap.canarySrt.exists) {
            videoAnomalies.push({
                type: "MISSING_STEP",
                severity: "warn",
                file: `${base}.wav.canary.srt`,
                detail: "Postoji canary.diarized.srt ali nema canary.srt"
            });
        }

        if (fileMap.summary.exists && !fileMap.canaryDiarized.exists) {
            videoAnomalies.push({
                type: "MISSING_STEP",
                severity: "error",
                file: `${base}.wav.canary.diarized.srt`,
                detail: "Postoji summary.json ali nema canary.diarized.srt"
            });
        }

        // Provjeri summary.json strukturu
        if (fileMap.summary.exists) {
            try {
                const data = JSON.parse(fs.readFileSync(fileMap.summary.path, "utf-8"));
                if (!data.summary) {
                    videoAnomalies.push({
                        type: "INVALID_JSON",
                        severity: "error",
                        file: `${base}.wav.canary.summary.json`,
                        detail: "Nema 'summary' ključa u JSON-u"
                    });
                } else if (!data.summary.speakers || data.summary.speakers.length === 0) {
                    videoAnomalies.push({
                        type: "MISSING_DATA",
                        severity: "warn",
                        file: `${base}.wav.canary.summary.json`,
                        detail: "Nema speaker identifikacije"
                    });
                }
            } catch (e) {
                videoAnomalies.push({
                    type: "CORRUPT_JSON",
                    severity: "error",
                    file: `${base}.wav.canary.summary.json`,
                    detail: `JSON parse error: ${e.message}`
                });
            }
        }

        // Provjeri outline.json i article.json (mogu biti više verzija)
        const srtBase = `${base}.wav.canary.diarized`;
        const outlines = files.filter(f =>
            f.startsWith(srtBase + "_") && f.endsWith(".outline.json") && !f.startsWith("._")
        ).sort().reverse();

        const articles = files.filter(f =>
            f.startsWith(srtBase + "_") && f.endsWith(".article.json") && !f.startsWith("._")
        ).sort().reverse();

        if (fileMap.canaryDiarized.exists && outlines.length === 0) {
            videoAnomalies.push({
                type: "MISSING_STEP",
                severity: "info",
                file: `${srtBase}_*.outline.json`,
                detail: "Nema outline.json — generate_article_gemini.js nije pokrenut"
            });
        }

        if (fileMap.canaryDiarized.exists && articles.length === 0) {
            videoAnomalies.push({
                type: "MISSING_STEP",
                severity: "info",
                file: `${srtBase}_*.article.json`,
                detail: "Nema article.json — generate_article_gemini.js nije pokrenut ili nije završio"
            });
        }

        // Provjeri najnoviji article.json za prazne iteracije
        if (articles.length > 0) {
            const latestArticle = path.join(channelDir, articles[0]);
            try {
                const data = JSON.parse(fs.readFileSync(latestArticle, "utf-8"));
                const iterations = data.iterations || [];

                if (iterations.length === 0) {
                    videoAnomalies.push({
                        type: "EMPTY_ARTICLE",
                        severity: "error",
                        file: articles[0],
                        detail: "article.json ima 0 iteracija — generiranje nije uspjelo"
                    });
                } else {
                    const emptySections = iterations.filter(it => !it.sections || it.sections.length === 0);
                    if (emptySections.length > 0) {
                        videoAnomalies.push({
                            type: "INCOMPLETE_ARTICLE",
                            severity: "error",
                            file: articles[0],
                            detail: `${emptySections.length}/${iterations.length} iteracija bez sections`
                        });
                    }
                }
            } catch (e) {
                videoAnomalies.push({
                    type: "CORRUPT_JSON",
                    severity: "error",
                    file: articles[0],
                    detail: `JSON parse error: ${e.message}`
                });
            }
        }

        // Provjeri najnoviji outline.json za prazne chapters
        if (outlines.length > 0) {
            const latestOutline = path.join(channelDir, outlines[0]);
            try {
                const data = JSON.parse(fs.readFileSync(latestOutline, "utf-8"));
                const iterations = data.iterations || [];

                if (iterations.length === 0) {
                    videoAnomalies.push({
                        type: "EMPTY_OUTLINE",
                        severity: "error",
                        file: outlines[0],
                        detail: "outline.json ima 0 iteracija"
                    });
                } else {
                    const noChapters = iterations.filter(it => !it.chapters || it.chapters.length === 0);
                    if (noChapters.length > 0) {
                        videoAnomalies.push({
                            type: "INCOMPLETE_OUTLINE",
                            severity: "warn",
                            file: outlines[0],
                            detail: `${noChapters.length}/${iterations.length} iteracija bez chapters`
                        });
                    }
                }
            } catch (e) {
                videoAnomalies.push({
                    type: "CORRUPT_JSON",
                    severity: "error",
                    file: outlines[0],
                    detail: `JSON parse error: ${e.message}`
                });
            }
        }

        // Provjeri RAG combined/import — trebaju triplet
        const hasCompleteTriplet = fileMap.canaryDiarized.exists && outlines.length > 0 && articles.length > 0;
        const ragCombinedFile = `${base}.rag_combined.jsonl`;
        const ragImportFile = `${base}.rag_import.jsonl`;
        const hasRagCombined = files.includes(ragCombinedFile);
        const hasRagImport = files.includes(ragImportFile);

        if (hasCompleteTriplet && !hasRagCombined) {
            // Samo ako article ima sections — inače je očekivano
            if (articles.length > 0) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(channelDir, articles[0]), "utf-8"));
                    const iters = data.iterations || [];
                    const hasContent = iters.some(it => it.sections && it.sections.length > 0);
                    if (hasContent) {
                        videoAnomalies.push({
                            type: "MISSING_RAG",
                            severity: "info",
                            file: ragCombinedFile,
                            detail: "Kompletni triplet postoji ali nema rag_combined.jsonl"
                        });
                    }
                } catch (e) { /* skip */ }
            }
        }

        if (videoAnomalies.length > 0) {
            anomalies.push({ base, channel: channelName, issues: videoAnomalies });
        }
    }

    return anomalies;
}

// ─── MAIN ────────────────────────────────────────────────────────

function main() {
    const { inputDir, channel, verbose, fixSuggestions } = parseArgs();

    if (!fs.existsSync(inputDir)) {
        console.error(`❌ Direktorij ne postoji: ${inputDir}`);
        process.exit(1);
    }

    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   🔍 PIPELINE INSPEKCIJA — DETEKCIJA ANOMALIJA  ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📂 Input: ${inputDir}`);
    if (channel) console.log(`   🎯 Kanal: ${channel}`);
    console.log("");

    const entries = fs.readdirSync(inputDir, { withFileTypes: true });
    const allAnomalies = [];
    let totalVideos = 0;

    // Brojači po tipu anomalije
    const severityCounts = { error: 0, warn: 0, info: 0 };
    const typeCounts = {};

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        if (channel && entry.name !== channel) continue;

        const channelDir = path.join(inputDir, entry.name);
        const channelFiles = fs.readdirSync(channelDir).filter(f =>
            f.endsWith(".mp3") && !f.startsWith("._")
        );
        totalVideos += channelFiles.length;

        const anomalies = inspectChannel(channelDir, entry.name, verbose);
        allAnomalies.push(...anomalies);

        for (const a of anomalies) {
            for (const issue of a.issues) {
                severityCounts[issue.severity]++;
                typeCounts[issue.type] = (typeCounts[issue.type] || 0) + 1;
            }
        }
    }

    // Ispis anomalija
    const errors = allAnomalies.filter(a => a.issues.some(i => i.severity === "error"));
    const warnings = allAnomalies.filter(a => a.issues.some(i => i.severity === "warn") && !a.issues.some(i => i.severity === "error"));

    const SEVERITY_ICONS = { error: "❌", warn: "⚠️ ", info: "ℹ️ " };

    if (errors.length > 0) {
        console.log(`━━━ ❌ GREŠKE (${severityCounts.error}) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        for (const a of errors) {
            console.log(`\n   📂 [${a.channel}] ${a.base}`);
            for (const issue of a.issues.filter(i => i.severity === "error")) {
                console.log(`      ${SEVERITY_ICONS[issue.severity]} [${issue.type}] ${issue.detail}`);
                if (verbose) console.log(`         → ${issue.file}`);
            }
        }
        console.log("");
    }

    if (warnings.length > 0 || verbose) {
        const warnsToShow = verbose ? allAnomalies.filter(a => a.issues.some(i => i.severity === "warn")) : warnings;
        if (warnsToShow.length > 0) {
            console.log(`━━━ ⚠️  UPOZORENJA (${severityCounts.warn}) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            for (const a of warnsToShow) {
                console.log(`\n   📂 [${a.channel}] ${a.base}`);
                for (const issue of a.issues.filter(i => i.severity === "warn")) {
                    console.log(`      ${SEVERITY_ICONS[issue.severity]} [${issue.type}] ${issue.detail}`);
                    if (verbose) console.log(`         → ${issue.file}`);
                }
            }
            console.log("");
        }
    }

    // Sažetak
    // Videa s SAMO info-level anomalijama smatramo čistima
    const videosWithRealIssues = allAnomalies.filter(a =>
        a.issues.some(i => i.severity === "error" || i.severity === "warn")
    ).length;
    const cleanVideos = totalVideos - videosWithRealIssues;
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   📊 SAŽETAK INSPEKCIJE                        ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`   📹 Ukupno videa:        ${totalVideos}`);
    console.log(`   ✅ Bez problema:        ${cleanVideos}`);
    console.log(`   ❌ S greškama:          ${errors.length}`);
    console.log(`   ⚠️  S upozorenjima:     ${warnings.length}`);
    console.log(`   ℹ️  Nedovršen pipeline: ${allAnomalies.length - videosWithRealIssues} (info)`);
    console.log("");

    if (Object.keys(typeCounts).length > 0) {
        console.log("   📋 Po tipu anomalije:");
        const sortedTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
        for (const [type, count] of sortedTypes) {
            console.log(`      ${type}: ${count}`);
        }
        console.log("");
    }

    // Generiranje fix skripte
    if (fixSuggestions) {
        const filesToDelete = [];

        for (const a of allAnomalies) {
            for (const issue of a.issues) {
                if (issue.severity !== "error") continue;

                if (issue.type === "EMPTY_ARTICLE" || issue.type === "INCOMPLETE_ARTICLE" || issue.type === "CORRUPT_JSON") {
                    filesToDelete.push(path.join(inputDir, a.channel, issue.file));
                } else if (issue.type === "EMPTY_FILE") {
                    filesToDelete.push(path.join(inputDir, a.channel, issue.file));
                }
            }
        }

        if (filesToDelete.length === 0) {
            console.log("   ✨ Nema datoteka za brisanje!");
        } else {
            const scriptPath = path.join(inputDir, `_fix_cleanup_${Date.now()}.sh`);
            const lines = [
                "#!/bin/bash",
                "",
                "# Automatski generirana skripta za brisanje pokvarenih datoteka",
                `# Generirao: inspect_pipeline.js @ ${new Date().toISOString()}`,
                `# Ukupno datoteka za brisanje: ${filesToDelete.length}`,
                "",
                "set -e",
                "",
                `echo "Brisanje ${filesToDelete.length} pokvarenih datoteka..."`,
                ""
            ];

            for (const f of filesToDelete) {
                lines.push(`rm -v "${f}"`);
            }

            lines.push("");
            lines.push(`echo ""`);
            lines.push(`echo "Obrisano ${filesToDelete.length} datoteka."`);
            lines.push(`echo "Brišem samu sebe..."`);
            lines.push(`rm -v "$0"`);
            lines.push("");

            fs.writeFileSync(scriptPath, lines.join("\n"), { mode: 0o755 });
            console.log(`   🔧 Generirana fix skripta: ${scriptPath}`);
            console.log(`      Datoteka za brisanje: ${filesToDelete.length}`);
            console.log(`      Pokreni s: bash "${scriptPath}"`);
            console.log(`      (skripta obriše samu sebe nakon izvršenja)`);
        }
        console.log("");
    }
}

main();
