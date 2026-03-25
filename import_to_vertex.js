#!/usr/bin/env node

/**
 * import_to_vertex.js
 *
 * Automatizira ingestion RAG JSONL datoteka u Vertex AI Agent Builder (Discovery Engine).
 *
 * ZA SVAKI .rag_combined.jsonl:
 *   1. Upload na Google Cloud Storage (GCS)
 *   2. Pokreće INCREMENTAL import u Vertex AI Search Data Store
 *
 * PRINCIP RADA:
 *   - Batch mod: skenira --input-dir za .rag_combined.jsonl datoteke, uploada sve na GCS,
 *     pa triggerira jedan skupni import za cijeli bucket prefix
 *   - Single-file mod: prima putanju do jedne .rag_combined.jsonl datoteke
 *   - Idempotentno: re-upload istog filea prepisuje stari u GCS, INCREMENTAL upserta po id
 *
 * PREDUVJETI:
 *   - gcloud CLI autentificiran (gcloud auth application-default login)
 *   - GOOGLE_APPLICATION_CREDENTIALS postavljen (service account) ILI ADC
 *   - GCS bucket kreiran i pristupačan
 *   - Vertex AI Search Data Store kreiran (Structured Data tip)
 *   - .env datoteka s konfiguracijom (vidi .env.example)
 *
 * Primjeri:
 *   node import_to_vertex.js ./path/to/episode.rag_combined.jsonl
 *   node import_to_vertex.js --input-dir /Volumes/DOMOVINA1TB/fetch_domovina_tv_output
 *   node import_to_vertex.js --input-dir ... --channel domovina_tv
 *   node import_to_vertex.js --input-dir ... --dry-run
 *   node import_to_vertex.js --input-dir ... --limit 10
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ─── .env UČITAVANJE (ručno, bez dotenv dependency) ──────────────

function loadEnvFile() {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) {
            process.env[key] = val;
        }
    }
}

loadEnvFile();

// ─── KONFIGURACIJA ───────────────────────────────────────────────

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "global";
const DATA_STORE_ID = process.env.DATA_STORE_ID;
const GCS_PREFIX = process.env.GCS_PREFIX || "imports";

// ─── CLI PARSIRANJE ──────────────────────────────────────────────

function getArg(name) {
    const idx = process.argv.indexOf(name);
    return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

function hasFlag(name) {
    return process.argv.includes(name);
}

const inputDir = getArg("--input-dir");
const channelFilter = getArg("--channel");
const limit = getArg("--limit") ? parseInt(getArg("--limit"), 10) : 0;
const dryRun = hasFlag("--dry-run");
const singleFile = !inputDir ? process.argv[2] : null;

// ─── POMOĆNE FUNKCIJE ───────────────────────────────────────────

function ts() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(emoji, msg) {
    console.log(`   ${emoji} [${ts()}] ${msg}`);
}

/**
 * Pronalazi sve .rag_combined.jsonl datoteke u input direktoriju.
 * Poštuje symlinked channel direktorije (entry.isDirectory() || entry.isSymbolicLink()).
 */
function discoverJsonlFiles(baseDir, channel) {
    const results = [];

    let channelDirs;
    try {
        channelDirs = fs.readdirSync(baseDir, { withFileTypes: true })
            .filter(e => e.isDirectory() || e.isSymbolicLink());
    } catch (err) {
        log("❌", `Ne mogu čitati direktorij: ${baseDir} — ${err.message}`);
        return results;
    }

    for (const chDir of channelDirs) {
        const chName = chDir.name;
        if (channel && chName !== channel) continue;

        const chPath = path.join(baseDir, chName);
        let files;
        try {
            files = fs.readdirSync(chPath);
        } catch {
            continue;
        }

        for (const f of files) {
            if (f.endsWith(".rag_combined.jsonl") && !f.startsWith("._")) {
                results.push({
                    localPath: path.join(chPath, f),
                    channel: chName,
                    filename: f
                });
            }
        }
    }

    // Sortiraj po imenu (sadrži datum) — najnoviji prvi
    results.sort((a, b) => b.filename.localeCompare(a.filename));
    return results;
}

/**
 * Validira da JSONL datoteka ima barem 1 liniju s validnim JSON-om koji sadrži "id" polje.
 */
function validateJsonlFile(filePath) {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) return { valid: false, lines: 0, error: "Prazna datoteka" };

    const lines = content.split("\n");
    let validLines = 0;

    for (const line of lines) {
        try {
            const obj = JSON.parse(line);
            if (!obj.id) return { valid: false, lines: lines.length, error: `Linija bez "id" polja: ${line.slice(0, 80)}` };
            validLines++;
        } catch (e) {
            return { valid: false, lines: lines.length, error: `Nevažeći JSON na liniji ${validLines + 1}: ${e.message}` };
        }
    }

    return { valid: true, lines: validLines };
}

// ─── GLAVNI PROGRAM ─────────────────────────────────────────────

async function main() {
    console.log("");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   🧠 VERTEX AI RAG IMPORTER                     ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log("");

    // Provjeri konfiguraciju
    const missing = [];
    if (!GCP_PROJECT_ID) missing.push("GCP_PROJECT_ID");
    if (!GCS_BUCKET_NAME) missing.push("GCS_BUCKET_NAME");
    if (!DATA_STORE_ID) missing.push("DATA_STORE_ID");

    if (missing.length > 0) {
        log("❌", `Nedostaju env varijable: ${missing.join(", ")}`);
        log("💡", "Postavi ih u .env datoteku ili kao env varijable. Vidi .env.example.");
        process.exit(1);
    }

    log("📋", `Projekt:    ${GCP_PROJECT_ID}`);
    const gcloudProject = (() => { try { return execSync("gcloud config get-value project 2>/dev/null", { encoding: "utf-8" }).trim(); } catch { return "N/A"; } })();
    if (gcloudProject !== GCP_PROJECT_ID) {
        log("⚠️", `gcloud projekt: ${gcloudProject} (RAZLIKUJE SE OD GCP_PROJECT_ID!)`);
    } else {
        log("✅", `gcloud projekt: ${gcloudProject}`);
    }
    log("🪣", `Bucket:     ${GCS_BUCKET_NAME}`);
    log("📂", `GCS prefix: ${GCS_PREFIX}/`);
    log("🏪", `Data Store: ${DATA_STORE_ID}`);
    log("🌍", `Lokacija:   ${VERTEX_LOCATION}`);
    if (dryRun) log("🏜️", "DRY RUN — neće se ništa uploadati ni importirati");
    console.log("");

    // Pronađi datoteke za obradu
    let filesToProcess = [];

    if (singleFile) {
        // Single-file mod
        if (!fs.existsSync(singleFile)) {
            log("❌", `Datoteka ne postoji: ${singleFile}`);
            process.exit(1);
        }
        filesToProcess.push({
            localPath: path.resolve(singleFile),
            channel: path.basename(path.dirname(singleFile)),
            filename: path.basename(singleFile)
        });
    } else if (inputDir) {
        // Batch mod
        if (!fs.existsSync(inputDir)) {
            log("❌", `Input direktorij ne postoji: ${inputDir}`);
            process.exit(1);
        }
        filesToProcess = discoverJsonlFiles(inputDir, channelFilter);
        if (limit > 0) filesToProcess = filesToProcess.slice(0, limit);
    } else {
        console.log("Uporaba:");
        console.log("  node import_to_vertex.js ./path/to/episode.rag_combined.jsonl");
        console.log("  node import_to_vertex.js --input-dir /path/to/output [--channel X] [--limit N] [--dry-run]");
        process.exit(1);
    }

    if (filesToProcess.length === 0) {
        log("✨", "Nema .rag_combined.jsonl datoteka za obradu.");
        return;
    }

    log("📊", `Pronađeno datoteka: ${filesToProcess.length}`);
    console.log("");

    // Validiraj sve datoteke prije uploada
    log("🔍", "Validiram JSONL datoteke...");
    const validFiles = [];
    for (const f of filesToProcess) {
        const result = validateJsonlFile(f.localPath);
        if (!result.valid) {
            log("⚠️", `[PRESKAČEM] ${f.filename}: ${result.error}`);
        } else {
            validFiles.push({ ...f, lineCount: result.lines });
        }
    }

    if (validFiles.length === 0) {
        log("❌", "Nijedna datoteka nije prošla validaciju.");
        process.exit(1);
    }

    const totalChunks = validFiles.reduce((sum, f) => sum + f.lineCount, 0);
    log("✅", `Validno: ${validFiles.length} datoteka, ${totalChunks} ukupno chunkova`);
    console.log("");

    if (dryRun) {
        log("🏜️", "DRY RUN — prikazujem što bi se uploadalo:");
        for (const f of validFiles) {
            const gcsPath = `${GCS_PREFIX}/${f.channel}/${f.filename}`;
            console.log(`      gs://${GCS_BUCKET_NAME}/${gcsPath}  (${f.lineCount} chunkova)`);
        }
        console.log("");
        log("🏜️", "DRY RUN završen. Pokreni bez --dry-run za stvarni import.");
        return;
    }

    // Lazy load GCS i Discovery Engine (tek kad znamo da treba)
    const { Storage } = require("@google-cloud/storage");
    const { DocumentServiceClient } = require("@google-cloud/discoveryengine").v1;

    const storage = new Storage({ projectId: GCP_PROJECT_ID });
    const bucket = storage.bucket(GCS_BUCKET_NAME);

    // ─── KORAK 1: Upload na GCS ──────────────────────────────────
    log("☁️", "Uploadam datoteke na GCS...");

    const uploadedUris = [];

    for (const f of validFiles) {
        const gcsPath = `${GCS_PREFIX}/${f.channel}/${f.filename}`;
        const gcsUri = `gs://${GCS_BUCKET_NAME}/${gcsPath}`;

        try {
            await bucket.upload(f.localPath, {
                destination: gcsPath,
                metadata: {
                    contentType: "application/x-ndjson",
                    metadata: {
                        channel: f.channel,
                        source: "import_to_vertex.js"
                    }
                }
            });
            uploadedUris.push(gcsUri);
            log("⬆️", `[${uploadedUris.length}/${validFiles.length}] ${f.channel}/${f.filename} → ${gcsUri}`);
        } catch (err) {
            log("❌", `Upload neuspješan za ${f.filename}: ${err.message}`);
        }
    }

    if (uploadedUris.length === 0) {
        log("❌", "Nijedan file nije uspješno uploadan na GCS.");
        process.exit(1);
    }

    log("✅", `Uploadano ${uploadedUris.length}/${validFiles.length} datoteka na GCS`);
    console.log("");

    // ─── KORAK 2: Trigger Discovery Engine import ────────────────
    log("🧠", "Pokrećem Vertex AI Discovery Engine import...");

    const parent = `projects/${GCP_PROJECT_ID}/locations/${VERTEX_LOCATION}/collections/default_collection/dataStores/${DATA_STORE_ID}/branches/0`;

    const client = new DocumentServiceClient({
        apiEndpoint: VERTEX_LOCATION === "global"
            ? "discoveryengine.googleapis.com"
            : `${VERTEX_LOCATION}-discoveryengine.googleapis.com`
    });

    const request = {
        parent: parent,
        gcsSource: {
            inputUris: uploadedUris,
            dataSchema: "custom"
        },
        reconciliationMode: "INCREMENTAL",
        autoGenerateIds: false
    };

    log("📤", `Parent: ${parent}`);
    log("📤", `Input URIs: ${uploadedUris.length} datoteka`);
    log("📤", `Reconciliation: INCREMENTAL (upsert po id polju)`);
    console.log("");

    try {
        const [operation] = await client.importDocuments(request);

        log("⏳", `Operacija pokrenuta: ${operation.name || "(LRO)"}`);
        log("⏳", "Čekam završetak importa (ovo može potrajati)...");

        const [response] = await operation.promise();

        // Izvuci rezultate
        const successCount = Number(response?.importSummary?.successCount || 0);
        const failureCount = Number(response?.importSummary?.failureCount || 0);

        console.log("");
        if (successCount > 0) {
            log("✅", `Uspješno importirano: ${successCount} dokumenata`);
        }
        if (failureCount > 0) {
            log("⚠️", `Neuspješno: ${failureCount} dokumenata`);
        }

        // Logaj error sample ako postoje
        if (response?.errorSamples && response.errorSamples.length > 0) {
            log("⚠️", `Error uzorci (${response.errorSamples.length}):`);
            for (const err of response.errorSamples.slice(0, 5)) {
                console.log(`      ❌ [${err.code}] ${err.message}`);
            }
        }

        if (failureCount === 0 && successCount > 0) {
            console.log("");
            log("🎉", `Import završen! ${successCount} chunkova upsertano u Data Store "${DATA_STORE_ID}".`);
        } else if (successCount > 0) {
            console.log("");
            log("🟡", `Djelomičan uspjeh: ${successCount} ok, ${failureCount} neuspješno.`);
        } else {
            console.log("");
            log("❌", "Import potpuno neuspješan. Provjeri error uzorke iznad.");
            process.exit(1);
        }

    } catch (err) {
        console.log("");
        log("❌", `Discovery Engine greška: ${err.message}`);

        if (err.code) {
            log("❌", `gRPC status: ${err.code} (${err.details || "nema detalja"})`);
        }

        // Česti problemi
        if (err.message.includes("PERMISSION_DENIED")) {
            log("💡", "Provjeri da service account ima roles/discoveryengine.editor na projektu.");
        } else if (err.message.includes("NOT_FOUND")) {
            log("💡", `Provjeri da Data Store "${DATA_STORE_ID}" postoji u projektu "${GCP_PROJECT_ID}" (lokacija: ${VERTEX_LOCATION}).`);
        } else if (err.message.includes("INVALID_ARGUMENT")) {
            log("💡", "Provjeri format JSONL datoteka — svaka linija mora imati 'id' polje.");
        }

        process.exit(1);
    }
}

main().catch(err => {
    log("❌", `Neočekivana greška: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
