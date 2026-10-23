/**
 * lib/asr/soniox.js — Soniox async API (https://api.soniox.com/v1), model stt-async-v5.
 *
 * Obrazac iz newsroom-be `clients/soniox.py` + `soniox_client.py` (NEWS-1034):
 *   POST /v1/files (upload)  → POST /v1/transcriptions {model, file_id|audio_url,
 *   language_hints, enable_speaker_diarization} → poll GET /v1/transcriptions/{id}
 *   (queued|processing|completed|error) → GET …/transcript → DELETE transkripciju i datoteku.
 *
 * Brisanje NIJE opcionalno: Soniox drži najviše 2000 transkripcija i 1000 datoteka po
 * računu, pa bi bez njega backfill nakon ~1000 epizoda počeo padati. Sirovi transkript
 * spremamo lokalno (`.soniox.json`) prije brisanja.
 *
 * Duljina zvuka je ograničena na 300 min (Soniox, ne može se podići) — dulje snimke
 * idu ravno na fallback (Speechmatics).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const API_BASE = process.env.SONIOX_API_BASE || "https://api.soniox.com";
const MODEL = "stt-async-v5";
const MAX_AUDIO_SECONDS = 300 * 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SonioxError extends Error {}

function client(apiKey, { log = console.log } = {}) {
    if (!apiKey) throw new SonioxError("Nema SONIOX_API_KEY");

    async function call(method, url, { body, json, tries = 4, okStatuses = [] } = {}) {
        let lastErr;
        for (let i = 0; i < tries; i++) {
            try {
                const headers = { Authorization: `Bearer ${apiKey}` };
                if (json !== undefined) headers["Content-Type"] = "application/json";
                const res = await fetch(API_BASE + url, {
                    method, headers, body: json !== undefined ? JSON.stringify(json) : body,
                });
                if (res.status === 429 || res.status >= 500) {
                    const wait = Math.min(60, 2 ** i * 5);
                    log(`   ⏳ Soniox HTTP ${res.status} — čekam ${wait}s pa ponavljam…`);
                    await sleep(wait * 1000);
                    continue;
                }
                const text = await res.text();
                if (!res.ok && !okStatuses.includes(res.status)) {
                    throw new SonioxError(`Soniox ${method} ${url}: HTTP ${res.status} — ${text.slice(0, 300)}`);
                }
                return text ? JSON.parse(text) : null;
            } catch (err) {
                if (err instanceof SonioxError) throw err;
                lastErr = err;
                const wait = Math.min(60, 2 ** i * 5);
                log(`   ⏳ Soniox mrežna greška (${err.message}) — čekam ${wait}s…`);
                await sleep(wait * 1000);
            }
        }
        throw new SonioxError(`Soniox nedostupan nakon ${tries} pokušaja: ${lastErr ? lastErr.message : "5xx/429"}`);
    }

    async function uploadFile(audioPath) {
        const form = new FormData();
        form.append("file", new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath));
        const r = await call("POST", "/v1/files", { body: form, tries: 2 });
        return r.id;
    }

    async function createTranscription(config) {
        const r = await call("POST", "/v1/transcriptions", { json: config });
        return r.id;
    }

    const getTranscription = (id) => call("GET", `/v1/transcriptions/${id}`);
    const getTranscript = (id) => call("GET", `/v1/transcriptions/${id}/transcript`);
    const deleteTranscription = (id) => call("DELETE", `/v1/transcriptions/${id}`, { okStatuses: [404] });
    const deleteFile = (id) => call("DELETE", `/v1/files/${id}`, { okStatuses: [404] });

    /**
     * Cijeli put za jednu datoteku. Vraća {transcript, job, config}. Na Soniox `error`
     * baca SonioxError (pozivatelj prelazi na fallback). Posao i datoteka se brišu u
     * svakom ishodu osim timeouta (tada ostaju za ručnu provjeru, kao i kod Speechmaticsa).
     */
    async function transcribeFile(audioPath, { language = "hr", pollSeconds = 10, timeoutMinutes = 90, diarize = true } = {}) {
        const config = {
            model: MODEL,
            language_hints: [language],
            enable_speaker_diarization: diarize,
            client_reference_id: path.basename(audioPath).slice(0, 200),
        };
        const fileId = await uploadFile(audioPath);
        let txId = null;
        let keepRemote = false;
        try {
            txId = await createTranscription({ ...config, file_id: fileId });
            log(`   ⬆️  Soniox posao ${txId}`);
            const deadline = Date.now() + timeoutMinutes * 60 * 1000;
            let last = "";
            let job;
            for (;;) {
                job = await getTranscription(txId);
                if (job.status !== last) { log(`   📡 status: ${job.status}`); last = job.status; }
                if (job.status === "completed") break;
                if (job.status === "error") {
                    throw new SonioxError(`Soniox greška: ${job.error_type || "?"} — ${job.error_message || ""}`);
                }
                if (Date.now() > deadline) {
                    const e = new SonioxError(`Timeout nakon ${timeoutMinutes} min — Soniox posao ${txId} ostavljen (provjeri ručno).`);
                    e.keepRemote = true;
                    throw e;
                }
                await sleep(pollSeconds * 1000);
            }
            const transcript = await getTranscript(txId);
            return { transcript, job, config, transcriptionId: txId };
        } catch (err) {
            keepRemote = !!err.keepRemote;
            throw err;
        } finally {
            if (!keepRemote) await cleanup(txId, fileId);
        }
    }

    async function cleanup(txId, fileId) {
        try { if (txId) await deleteTranscription(txId); } catch (e) { log(`   ⚠️ Soniox: brisanje transkripcije ${txId} nije uspjelo (${e.message})`); }
        try { if (fileId) await deleteFile(fileId); } catch (e) { log(`   ⚠️ Soniox: brisanje datoteke ${fileId} nije uspjelo (${e.message})`); }
    }

    return { uploadFile, createTranscription, getTranscription, getTranscript, deleteTranscription, deleteFile, transcribeFile };
}

module.exports = { client, SonioxError, MODEL, MAX_AUDIO_SECONDS, API_BASE };
