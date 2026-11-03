// Tihi zvuk prije plaćenog ASR-a (03.11.2026.).
//
// radiobenkovac VOcypz9_Ofo je na YouTube stigao BEZ ZVUKA (max_volume -91 dB kroz svih
// 50 min, i u izvornom .f251.webm). Speechmatics je naplatio $0.67 za 0 segmenata, pyannoteAI
// vratio 0 govornika, a job je zauvijek visio u 'transcribing' jer članka nikad nema.
//
// Mjeri se cijela datoteka (volumedetect, ~2–4 s za sat zvuka): uzorak od par minuta
// bi lažno proglasio tihim epizodu koja počinje dugom tišinom/špicom.
// Ugovor: `{base}.silent.json` — priority_poller.js (pipeline.domovina.ai) po njemu job
// označi 'failed' s porukom koja NE odgovara retry uzorku enqueue_all_new.js.

const fs = require("fs");
const { spawnSync } = require("child_process");

const SILENCE_MAX_DB = parseFloat(process.env.SILENCE_MAX_DB || "-80");

function maxVolumeDb(audioPath) {
    const r = spawnSync("ffmpeg", ["-nostats", "-hide_banner", "-i", audioPath, "-map", "0:a:0",
        "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
    const m = String(r.stderr || "").match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
    if (!m) return null; // nečitljivo → ne odlučujemo ovdje
    return m[1] === "-inf" ? -Infinity : parseFloat(m[1]);
}

function silentMarkerPath(audioPath) {
    return audioPath.replace(/\.[A-Za-z0-9]+$/, "") + ".silent.json";
}

// Vraća null ako ima zvuka (ili mjerenje nije uspjelo), inače zapiše marker i vrati ga.
function checkSilent(audioPath) {
    const marker = silentMarkerPath(audioPath);
    if (fs.existsSync(marker)) {
        try { return JSON.parse(fs.readFileSync(marker, "utf-8")); } catch { /* prepiši */ }
    }
    const db = maxVolumeDb(audioPath);
    if (db == null || db > SILENCE_MAX_DB) return null;
    const rec = { v: 1, silent: true, max_volume_db: Number.isFinite(db) ? db : null,
        threshold_db: SILENCE_MAX_DB, audio_file: require("path").basename(audioPath),
        checked_at: new Date().toISOString() };
    fs.writeFileSync(marker, JSON.stringify(rec, null, 2) + "\n", "utf-8");
    return rec;
}

module.exports = { maxVolumeDb, checkSilent, silentMarkerPath, SILENCE_MAX_DB };
