"use strict";

/**
 * Claude Code "session window" ograda za nightly pipeline.
 *
 * Zašto (2026-08-26): Claude Code pretplata broji kvotu u prozoru od ~5h koji
 * KREĆE od prve poruke. Nightly pipeline zna trajati 9 min (medijan ~20 min),
 * ali i 4h31m (16.8.) odnosno 6h37m (14.8.) kad naiđe veći priljev epizoda.
 * U tim dugim runovima `--gemini-backend claude` je spawnao Opus sessione u
 * 07:35 i 08:31 — dakle otvarao svjež 5h prozor tik prije nego korisnik u 08:30
 * sjedne za komp, pa ga je jutro dočekalo s već potrošenom kvotom.
 *
 * Ograda: koraci 7+8 smiju zvati `claude` samo unutar noćnog prozora. Kad
 * prozor istekne, preostale epizode se NE degradiraju na Vertex/Flash nego se
 * ODGAĐAJU za sljedeću noć. Degradacija bi poništila odluku od 2026-07-29
 * (Flash je u incidentu atribucije imena — Ivan Voras / cb4CsFDCDho — prekršio
 * strict uputu; Opus nije), a pipeline je dir-driven pa neobrađena epizoda
 * ionako bude pokupljena u idućem prolazu.
 *
 * Aktivira se SAMO kad je CLAUDE_WINDOW_END postavljen (nightly_pipeline.sh ga
 * postavlja). Ručni i prioritetni (fast-path) runovi ga nemaju i rade kao prije —
 * ad-hoc zatražen video ne smije čekati do sutra.
 *
 *   CLAUDE_WINDOW_START  HH:MM, default "00:00"
 *   CLAUDE_WINDOW_END    HH:MM, bez njega je ograda isključena
 *
 * Prozor smije prelaziti ponoć (npr. 22:00 → 02:30).
 */

function parseHHMM(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

/**
 * @returns {{enabled: boolean, open: boolean, start: string, end: string}}
 */
function claudeWindow(now = new Date()) {
    const endRaw = process.env.CLAUDE_WINDOW_END;
    const end = parseHHMM(endRaw);
    if (end === null) {
        return { enabled: false, open: true, start: null, end: null };
    }
    const start = parseHHMM(process.env.CLAUDE_WINDOW_START) ?? 0;
    const nowMin = now.getHours() * 60 + now.getMinutes();

    // start < end  → obični prozor unutar istog dana
    // start >= end → prozor prelazi ponoć (npr. 22:00 → 02:30)
    const open = start < end
        ? (nowMin >= start && nowMin < end)
        : (nowMin >= start || nowMin < end);

    const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    return { enabled: true, open, start: fmt(start), end: fmt(end) };
}

/** Ograda je aktivna i prozor je zatvoren → AI korak treba odgoditi. */
function claudeWindowClosed(now = new Date()) {
    const w = claudeWindow(now);
    return w.enabled && !w.open;
}

/** Jednoredni razlog za log kad se posao odgađa. */
function claudeWindowReason(now = new Date()) {
    const w = claudeWindow(now);
    if (!w.enabled) return "";
    return `Claude prozor ${w.start}–${w.end} zatvoren`;
}

module.exports = { claudeWindow, claudeWindowClosed, claudeWindowReason, parseHHMM };
