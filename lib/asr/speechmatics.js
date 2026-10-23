/**
 * lib/asr/speechmatics.js — Speechmatics Batch API (v2) kao FALLBACK za Soniox.
 *
 * Isti poziv kao transcribe_speechmatics.js (enhanced, diarization: speaker), samo kao
 * funkcija koju transcribe_soniox.js zove kad Soniox padne ili je snimka dulja od 300 min.
 * transcribe_speechmatics.js ostaje samostalan (KORAK 2.7, evaluacijski) i ne ovisi o ovome.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const API_BASE = process.env.SPEECHMATICS_API_BASE || "https://asr.api.speechmatics.com/v2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(apiKey, { log = console.log } = {}) {
    if (!apiKey) throw new Error("Nema SPEECHMATICS_API_KEY");

    async function apiFetch(url, opts = {}, tries = 4) {
        let lastErr;
        for (let i = 0; i < tries; i++) {
            try {
                const res = await fetch(url, {
                    ...opts,
                    headers: { Authorization: `Bearer ${apiKey}`, ...(opts.headers || {}) },
                });
                if (res.status === 429 || res.status >= 500) {
                    const wait = Math.min(60, 2 ** i * 5);
                    log(`   ⏳ Speechmatics HTTP ${res.status} — čekam ${wait}s…`);
                    await sleep(wait * 1000);
                    continue;
                }
                return res;
            } catch (err) {
                lastErr = err;
                await sleep(Math.min(60, 2 ** i * 5) * 1000);
            }
        }
        throw lastErr || new Error("Speechmatics API nedostupan nakon svih pokušaja");
    }

    async function transcribeFile(audioPath, { language = "hr", operatingPoint = "enhanced", sensitivity = 0.5, pollSeconds = 15, timeoutMinutes = 90 } = {}) {
        const config = {
            type: "transcription",
            transcription_config: {
                language,
                operating_point: operatingPoint,
                diarization: "speaker",
                speaker_diarization_config: { speaker_sensitivity: sensitivity },
            },
        };
        const form = new FormData();
        form.append("config", JSON.stringify(config));
        form.append("data_file", new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath));
        const res = await apiFetch(`${API_BASE}/jobs`, { method: "POST", body: form });
        const body = await res.text();
        if (!res.ok) throw new Error(`Speechmatics: slanje nije uspjelo, HTTP ${res.status} — ${body.slice(0, 300)}`);
        const jobId = JSON.parse(body).id;
        log(`   ⬆️  Speechmatics posao ${jobId}`);

        const deadline = Date.now() + timeoutMinutes * 60 * 1000;
        let last = "", job;
        for (;;) {
            const r = await apiFetch(`${API_BASE}/jobs/${jobId}`);
            job = (await r.json()).job || {};
            if (job.status !== last) { log(`   📡 status: ${job.status}`); last = job.status; }
            if (job.status === "done") break;
            if (["rejected", "expired", "deleted"].includes(job.status)) {
                throw new Error(`Speechmatics posao odbijen (${job.status}): ${JSON.stringify(job.errors || "")}`);
            }
            if (Date.now() > deadline) throw new Error(`Speechmatics timeout nakon ${timeoutMinutes} min (posao ${jobId})`);
            await sleep(pollSeconds * 1000);
        }
        const tr = await apiFetch(`${API_BASE}/jobs/${jobId}/transcript?format=json-v2`);
        const raw = await tr.text();
        if (!tr.ok) throw new Error(`Speechmatics: dohvat transkripta HTTP ${tr.status}`);
        return { raw, json: JSON.parse(raw), job, config, jobId };
    }

    return { transcribeFile };
}

module.exports = { client, API_BASE };
