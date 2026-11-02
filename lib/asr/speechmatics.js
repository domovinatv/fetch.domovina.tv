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

const os = require("os");
const crypto = require("crypto");

const API_BASE = process.env.SPEECHMATICS_API_BASE || "https://asr.api.speechmatics.com/v2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Više ključeva (02.11.2026.) ───────────────────────────────────────────────
// Kad se jednom računu potroše krediti, slanje posla padne (HTTP 401/402/403 ili poruka
// o kreditu/kvoti) i ide se na idući ključ. Redoslijed: SPEECHMATICS_API_KEYS (zarezom
// odvojeni), pa SPEECHMATICS_API_KEY, pa SPEECHMATICS_API_KEY_2, _3, … (bez duplikata).
// Potrošen ključ se pamti EXHAUSTED_TTL_H sati (default 12) u ~/.cache/domovina-pipeline/
// speechmatics_exhausted.json (po otisku sha256, ne ključ), da idući job ne šalje cijeli
// MP3 na mrtav račun. Kad su svi označeni, svejedno se probaju (možda su nadoplaćeni).
const EXHAUSTED_FILE = path.join(os.homedir(), ".cache/domovina-pipeline/speechmatics_exhausted.json");
const EXHAUSTED_TTL_H = parseFloat(process.env.SPEECHMATICS_EXHAUSTED_TTL_H || "12");

function apiKeys(env = process.env) {
    const out = [];
    const add = (k) => { k = (k || "").trim(); if (k && !out.includes(k)) out.push(k); };
    for (const k of String(env.SPEECHMATICS_API_KEYS || "").split(/[,\s]+/)) add(k);
    add(env.SPEECHMATICS_API_KEY);
    const numbered = Object.keys(env)
        .map((n) => n.match(/^SPEECHMATICS_API_KEY_(\d+)$/)).filter(Boolean)
        .sort((a, b) => +a[1] - +b[1]);
    for (const m of numbered) add(env[m[0]]);
    return out;
}

const fingerprint = (key) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);

function readExhausted() {
    try { return JSON.parse(fs.readFileSync(EXHAUSTED_FILE, "utf8")); } catch { return {}; }
}
function markExhausted(key, reason) {
    const all = readExhausted();
    all[fingerprint(key)] = { at: new Date().toISOString(), reason: String(reason).slice(0, 200) };
    try {
        fs.mkdirSync(path.dirname(EXHAUSTED_FILE), { recursive: true });
        fs.writeFileSync(EXHAUSTED_FILE, JSON.stringify(all, null, 1) + "\n");
    } catch { /* cache nije kritičan */ }
}
function clearExhausted(key) {
    const all = readExhausted();
    if (!all[fingerprint(key)]) return;
    delete all[fingerprint(key)];
    try { fs.writeFileSync(EXHAUSTED_FILE, JSON.stringify(all, null, 1) + "\n"); } catch { /* */ }
}
function isExhausted(key, now = Date.now()) {
    const e = readExhausted()[fingerprint(key)];
    return !!(e && now - Date.parse(e.at) < EXHAUSTED_TTL_H * 3600 * 1000);
}

// Greška slanja koja znači „ovaj račun ne može" (krediti, kvota, ključ), ne „ova snimka ne može".
function isAccountError(err) {
    if (err && [401, 402, 403].includes(err.status)) return true;
    return /credit|quota|balance|insufficient|payment|billing|limit exceeded|unauthori[sz]ed|forbidden/i.test(err && err.message || "");
}

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
        if (!res.ok) {
            const err = new Error(`Speechmatics: slanje nije uspjelo, HTTP ${res.status} — ${body.slice(0, 300)}`);
            err.status = res.status;
            err.submit = true;
            throw err;
        }
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

/**
 * Klijent preko svih ključeva: isti transcribeFile, ali kad račun odbije SLANJE posla
 * (krediti/kvota/ključ), označi ključ potrošenim i pokuša idući. Greška nakon što je posao
 * prihvaćen (timeout, rejected) se ne ponavlja na drugom računu — to nije stvar kredita.
 */
function multiClient(keys = apiKeys(), { log = console.log } = {}) {
    if (!keys.length) throw new Error("Nema SPEECHMATICS_API_KEY");
    async function transcribeFile(audioPath, opts = {}) {
        const fresh = keys.filter((k) => !isExhausted(k));
        const order = fresh.length ? [...fresh, ...keys.filter((k) => !fresh.includes(k))] : keys;
        if (!fresh.length) log(`   ⚠️ Svi Speechmatics ključevi (${keys.length}) označeni potrošenima — probam ih ponovno`);
        let lastErr;
        for (let i = 0; i < order.length; i++) {
            const key = order[i];
            const label = `ključ ${keys.indexOf(key) + 1}/${keys.length} (${fingerprint(key).slice(0, 6)})`;
            if (keys.length > 1) log(`   🔑 Speechmatics ${label}`);
            try {
                const r = await (opts.client || client)(key, { log }).transcribeFile(audioPath, opts);
                clearExhausted(key);
                return { ...r, keyIndex: keys.indexOf(key) + 1, keyFingerprint: fingerprint(key) };
            } catch (err) {
                lastErr = err;
                if (!(err.submit && isAccountError(err))) throw err;
                markExhausted(key, err.message);
                log(`   🪫 Speechmatics ${label} odbijen (${err.message.slice(0, 120)})` +
                    (i + 1 < order.length ? " — idući ključ" : ""));
            }
        }
        throw new Error(`Speechmatics: svi ključevi (${keys.length}) odbijeni — ${lastErr && lastErr.message}`);
    }
    return { transcribeFile };
}

module.exports = { client, multiClient, apiKeys, isAccountError, fingerprint, API_BASE };
