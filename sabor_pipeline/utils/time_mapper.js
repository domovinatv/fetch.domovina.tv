#!/usr/bin/env node

/**
 * time_mapper.js — mapiranje globalnog timestampa spojene sjednice → YouTube deep link
 *
 * Saborska sjednica je jedan kontinuirani događaj razbijen na N YouTube live streamova.
 * `01_ingest.js` mjeri trajanje svakog dijela i gradi kumulativnu tablicu pomaka; ovaj
 * modul je jedina točka koja tu tablicu čita, pa se semantika granica (poluotvoreni
 * interval, clamp na kraju) ne razilazi između faza 02/03/04.
 *
 * Namjerno BEZ ovisnosti i BEZ I/O — čista funkcija nad manifestom, da je testabilna
 * bez diska i pozivna iz svake faze pipelinea.
 */

/**
 * Gradi `parts[]` s kumulativnim pomacima iz liste dijelova s izmjerenim trajanjem.
 * Ulaz: [{ part, video_id, url, duration_sec, ... }] — poredak po `part`.
 * Izlaz: isti objekti + { offset_global_sec, start_global_sec, end_global_sec }.
 */
function buildParts(rawParts) {
    const sorted = [...rawParts].sort((a, b) => a.part - b.part);
    // Uzorci su vodeća os kad su poznati: spojeni WAV je bit-točna konkatenacija, pa je
    // granica dijela cijeli broj uzoraka. `*_sec` je zaokružen na ms radi čitljivosti i
    // dovoljan je za deep linkove (koji ionako floor-aju na sekundu), ali REZANJE audija
    // mora ići preko `*_samples` — inače chunk starta nekoliko uzoraka pomaknut.
    const hasSamples = sorted.every((p) => Number.isInteger(p.duration_samples) && p.duration_samples > 0);
    let cursor = 0;
    let sampleCursor = 0;
    return sorted.map((p) => {
        const duration = Number(p.duration_sec);
        if (!Number.isFinite(duration) || duration <= 0) {
            throw new Error(`Dio ${p.part} nema valjano duration_sec (${p.duration_sec})`);
        }
        const withOffsets = {
            ...p,
            offset_global_sec: round3(cursor),
            start_global_sec: round3(cursor),
            end_global_sec: round3(cursor + duration),
        };
        if (hasSamples) {
            withOffsets.offset_global_samples = sampleCursor;
            withOffsets.start_global_samples = sampleCursor;
            withOffsets.end_global_samples = sampleCursor + p.duration_samples;
            sampleCursor += p.duration_samples;
        }
        cursor += duration;
        return withOffsets;
    });
}

/** Ukupno trajanje spojene sjednice (zbroj svih dijelova). */
function totalDuration(manifest) {
    const parts = partsOf(manifest);
    if (parts.length === 0) return 0;
    return parts[parts.length - 1].end_global_sec;
}

/**
 * Pronalazi dio kojemu pripada globalna sekunda.
 *
 * Interval je POLUOTVOREN — [start, end) — pa timestamp točno na granici pripada
 * SLJEDEĆEM dijelu (isto pravilo koje koristi diarizacija pri spajanju chunkova).
 * Iznimka je sam kraj sjednice: `t === total` bi inače pao izvan svih dijelova,
 * pa se clampa na zadnji dio.
 */
function findPart(manifest, globalSec) {
    const parts = partsOf(manifest);
    if (parts.length === 0) throw new Error("Manifest nema parts[]");
    const t = Number(globalSec);
    if (!Number.isFinite(t)) throw new Error(`globalSec nije broj: ${globalSec}`);

    if (t < 0) return parts[0];
    for (const p of parts) {
        if (t >= p.start_global_sec && t < p.end_global_sec) return p;
    }
    return parts[parts.length - 1];
}

/**
 * Globalna sekunda → { part, video_id, yt_sec, url }.
 *
 * `yt_sec` je FLOOR lokalne sekunde: YouTube `&t=` prima cijeli broj, a zaokruživanje
 * prema dolje jamči da deep link nikad ne preskoči početak rečenice (radije 0.9 s
 * ranije nego 0.1 s prekasno).
 */
function globalToYoutube(manifest, globalSec) {
    const p = findPart(manifest, globalSec);
    const local = clamp(Number(globalSec) - p.start_global_sec, 0, Math.max(0, p.duration_sec - 0.001));
    const ytSec = Math.floor(local);
    return {
        part: p.part,
        video_id: p.video_id,
        timestamp_sec: ytSec,
        url: youtubeUrl(p.video_id, ytSec),
        local_sec: round3(local),
    };
}

/** Obrnuti smjer — (part, sekunda unutar tog videa) → globalna sekunda. */
function youtubeToGlobal(manifest, part, ytSec) {
    const p = partsOf(manifest).find((x) => x.part === Number(part));
    if (!p) throw new Error(`Manifest nema dio ${part}`);
    return round3(p.start_global_sec + clamp(Number(ytSec), 0, p.duration_sec));
}

function youtubeUrl(videoId, seconds) {
    return `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(seconds))}s`;
}

/** HH:MM:SS iz sekundi — za ljudski čitljive izvještaje (20 h → dvoznamenkasti sati). */
function secondsToHms(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

// --- interno ---

function partsOf(manifest) {
    if (Array.isArray(manifest)) return manifest;
    if (manifest && Array.isArray(manifest.parts)) return manifest.parts;
    throw new Error("Očekivan manifest s parts[] ili niz dijelova");
}

function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
}

function round3(v) {
    return Math.round(v * 1000) / 1000;
}

module.exports = {
    buildParts,
    totalDuration,
    findPart,
    globalToYoutube,
    youtubeToGlobal,
    youtubeUrl,
    secondsToHms,
};
