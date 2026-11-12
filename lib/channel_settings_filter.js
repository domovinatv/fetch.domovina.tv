/**
 * channel_settings_filter.js — vlasnikove postavke kanala na ULAZU obrade i u ASR koracima
 * (lanac „postavke kanala”, S7). Čiste funkcije nad `ChannelGate` iz `lib/channel_settings.js`,
 * da ih fetch.js, ingest_beamly/rss, convert_to_wav i ASR skripte dijele i da se testiraju
 * bez mreže (`gateFromSnapshot`).
 *
 * Pravila:
 *  - skidanje medija: `processing` + master; uz to se NE skida kad su `cdn_playback` I
 *    `transcript_subtitles` oboje isključeni (odluka 108: medij i transkript se preuzimaju samo
 *    kad se nešto od njih objavljuje);
 *  - ASR (WAV, Modal, Soniox, Speechmatics, pyannoteAI, kostur 2.8): `transcript_subtitles`
 *    (checkStep → uključuje i `processing` + master);
 *  - nedostupan izvor = preskoči SVE (fail-closed, gate to već radi);
 *  - preskočena epizoda se NIGDJE ne upisuje (ni completed, ni failed, ni private), pa se
 *    obradi čim vlasnik uključi.
 */
"use strict";

const path = require("path");

const SKIP_TAG = "⏭️  postavke kanala:";

/**
 * Smije li se skinuti medij epizode? → `{skip:false}` ili `{skip:true, reason, uc?, unavailable?}`.
 * @param {import("./channel_settings").ChannelGate} gate
 * @param {{slug?:string, uc?:string, infoPath?:string, filePath?:string}} who
 */
function downloadDecision(gate, who = {}) {
    const p = gate.checkProcessing(who);
    if (p.skip) return p;
    const cdn = gate.checkStep({ ...who, key: "cdn_playback" });
    if (!cdn.skip) return { skip: false };
    const tr = gate.checkStep({ ...who, key: "transcript_subtitles" });
    if (!tr.skip) return { skip: false };
    return {
        skip: true,
        uc: cdn.uc || tr.uc,
        reason: "vlasnik je isključio „cdn_playback” i „transcript_subtitles” — nema se što objaviti, medij se ne skida (odluka 108)",
    };
}

/**
 * Filtar unosa s liste kanala (`automatic/podcasts/<slug>-lista.txt`) prije skidanja.
 * Unos smije nositi `uc` (vlasnik sadržaja, kad je poznat). Ne dira state.
 * @returns {{keep: object[], skipped: {entry: object, reason: string}[]}}
 */
function filterListEntriesBySettings(entries, slug, gate, { log = console.log } = {}) {
    const keep = [];
    const skipped = [];
    for (const entry of entries || []) {
        const d = downloadDecision(gate, { slug, uc: entry.uc });
        if (d.skip) {
            skipped.push({ entry, reason: d.reason });
            if (log) log(`   ${SKIP_TAG} ${slug}/${entry.videoId || entry.id || "?"} — ${d.reason}`);
        } else {
            keep.push(entry);
        }
    }
    return { keep, skipped };
}

/**
 * Smije li ASR korak raditi nad ovom datotekom epizode (`storage/output/<slug>/<base>.*`)?
 * UC se čita iz `<base>.info.json` (vlasnik sadržaja) i registryja (slug).
 */
function asrDecision(gate, filePath, key = "transcript_subtitles") {
    return gate.checkStep({ key, filePath });
}

/**
 * Filtar ASR kandidata (putanje ili objekti). Zove se PRIJE `--limit`/capa, da isključene
 * epizode ne troše mjesto. `getPath` vadi putanju iz objekta kandidata.
 */
function filterAsrCandidates(items, gate, { key = "transcript_subtitles", getPath = (x) => x, log = console.log } = {}) {
    const out = [];
    for (const it of items || []) {
        const p = getPath(it);
        const d = asrDecision(gate, p, key);
        if (d.skip) {
            if (log) log(`   ${SKIP_TAG} ${path.basename(p)} — ${d.reason}`);
            continue;
        }
        out.push(it);
    }
    return out;
}

module.exports = { SKIP_TAG, downloadDecision, filterListEntriesBySettings, asrDecision, filterAsrCandidates };
