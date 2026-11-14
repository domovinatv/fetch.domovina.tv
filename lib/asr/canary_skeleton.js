/**
 * lib/asr/canary_skeleton.js — Canary kao ZADNJI izvor kostura za KORAK 2.8 (14.11.2026.).
 *
 * Redoslijed izvora ostaje Soniox → Speechmatics → Canary (CLAUDE.md pravilo #3). Canary
 * se transkribira UVIJEK (KORAK 2.6, Modal), i radi usporedbe kvalitete, ali kanonski
 * `.wav.canary.diarized.srt` iz njega nastaje SAMO kad cloud ASR za tu epizodu nije dao
 * kostur:
 *
 *   1. `{base}.asr_failed.json` postoji (transcribe_soniox.js ga piše kad padnu i Soniox
 *      i Speechmatics, npr. bez kredita 13.11.2026.), ILI
 *   2. WAV je stariji od CANARY_FALLBACK_AFTER_H (24 h) i nijedan cloud kostur ne postoji
 *      (epizoda je npr. ispala iz Soniox capa ili 2.7b nije ni radio).
 *
 * Samo epizode iz zadnjih CANARY_FALLBACK_FRESH_DAYS (14) dana: popravak ide naprijed,
 * stari katalog se ovime ne puni (pravilo #4).
 *
 * Kostur:
 *   canary_pyannote  `.wav.canary.word_ts.json` + `.wav.canary.pyannote.json` (pyannote
 *                    community-1 na Modalu, canary_modal.py) → `{wav}.canary_pyannote.words.json`
 *   canary_solo      samo Canary, jedan govornik → `{wav}.canary_solo.words.json` (kad
 *                    Modal dijarizacija nije uspjela; atribucija govornika je tada na koracima 7+8)
 */
"use strict";

const fs = require("fs");
const { canaryToWords } = require("./words");
const { assignSpeakers } = require("./hybrid");

const WORD_TS = ".canary.word_ts.json";
const PYANNOTE = ".canary.pyannote.json";
const CANONICAL_SRT = ".wav.canary.diarized.srt";
const ASR_FAILED = ".asr_failed.json";
const SKELETON_INPUT = {
    canary_pyannote: ".canary_pyannote.words.json",
    canary_solo: ".canary_solo.words.json",
};
// Cloud kosturi (ulazi KORAKA 2.8 ispred Canaryja). Ako i jedan postoji, Canary šuti.
const CLOUD_INPUTS = [".soniox_pyannote.words.json", ".speechmatics_pyannote.words.json", ".soniox.words.json", ".speechmatics.json"];
const AUDIO_EXTS = [".mp3", ".m4a", ".opus", ".ogg", ".flac", ".wav"];

const num = (v, d) => (Number.isFinite(+v) && v !== "" && v != null ? +v : d);
const AFTER_H = num(process.env.CANARY_FALLBACK_AFTER_H, 24);
const FRESH_DAYS = num(process.env.CANARY_FALLBACK_FRESH_DAYS, 14);

const baseOf = (wavPath) => wavPath.replace(/\.wav$/, "");

function hasCloudSkeleton(base) {
    return AUDIO_EXTS.some((ext) => CLOUD_INPUTS.some((s) => fs.existsSync(base + ext + s)));
}

function readAsrFailed(base) {
    try { return JSON.parse(fs.readFileSync(base + ASR_FAILED, "utf-8")); } catch { return null; }
}

/** Smije li Canary dati kanonski SRT ove epizode? → {eligible, reason}. */
function fallbackStatus(wavPath, now = Date.now()) {
    const base = baseOf(wavPath);
    if (fs.existsSync(base + CANONICAL_SRT)) return { eligible: false, reason: "već ima kanonski SRT" };
    if (fs.existsSync(base + ".silent.json")) return { eligible: false, reason: "tihi zvuk" };
    if (!fs.existsSync(wavPath + WORD_TS)) return { eligible: false, reason: "nema Canary riječi" };
    if (hasCloudSkeleton(base)) return { eligible: false, reason: "cloud kostur postoji" };
    let ageH;
    try { ageH = (now - fs.statSync(wavPath).mtimeMs) / 3600000; } catch { return { eligible: false, reason: "nema WAV-a" }; }
    if (FRESH_DAYS > 0 && ageH > FRESH_DAYS * 24) return { eligible: false, reason: `starija od ${FRESH_DAYS} d` };
    const failed = readAsrFailed(base);
    if (failed) return { eligible: true, reason: `cloud ASR pao: ${String(failed.reason || "").slice(0, 120)}` };
    if (ageH >= AFTER_H) return { eligible: true, reason: `${Math.round(ageH)} h bez cloud kostura` };
    return { eligible: false, reason: `čeka cloud ASR (${Math.round(ageH)}/${AFTER_H} h)` };
}

/**
 * Napiše Canary kostur za KORAK 2.8 i vrati {name, input, speakers}. canary_pyannote kad
 * postoji pyannote izlaz s Modala, inače canary_solo. Idempotentno (prepiše isti sadržaj).
 */
function buildSkeleton(wavPath) {
    const ts = JSON.parse(fs.readFileSync(wavPath + WORD_TS, "utf-8"));
    let diar = null;
    try { diar = JSON.parse(fs.readFileSync(wavPath + PYANNOTE, "utf-8")); } catch { /* nema → solo */ }
    const segs = ((diar && diar.segments) || [])
        .map((s) => ({ start: +s.start, end: +s.end, speaker: String(s.speaker) }))
        .filter((s) => s.end > s.start)
        .sort((a, b) => a.start - b.start);
    const name = segs.length ? "canary_pyannote" : "canary_solo";
    let words = canaryToWords(ts, segs.length ? null : "0");
    if (segs.length) words = assignSpeakers(words, segs);
    const out = { v: 1, source: segs.length ? "canary+pyannote" : "canary", words };
    if (diar && diar.model) out.diarization_model = diar.model;
    fs.writeFileSync(wavPath + SKELETON_INPUT[name], JSON.stringify(out), "utf-8");
    // Drugi kostur iz ranijeg runa (npr. solo prije nego je stigao pyannote) bi u 2.8
    // bio drugi kandidat iste epizode — makni ga.
    for (const [n, suf] of Object.entries(SKELETON_INPUT)) {
        if (n !== name) { try { fs.unlinkSync(wavPath + suf); } catch { /* nema */ } }
    }
    return { name, input: wavPath + SKELETON_INPUT[name], speakers: new Set(segs.map((s) => s.speaker)).size || 1 };
}

module.exports = {
    fallbackStatus, buildSkeleton, hasCloudSkeleton, readAsrFailed,
    SKELETON_INPUT, WORD_TS, PYANNOTE, ASR_FAILED, AFTER_H, FRESH_DAYS,
};
