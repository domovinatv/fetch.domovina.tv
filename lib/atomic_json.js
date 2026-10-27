/**
 * atomic_json.js — sigurno pisanje dijeljenih state fajlova kad više pipeline runova
 * radi istovremeno (prioritetni slotovi, Magisterium objava, nightly).
 *
 *   writeFileAtomic(path, text)  — tmp s PID-om + rename: čitatelj nikad ne vidi napola
 *                                  zapisan fajl, a dva pisca ne dijele isti .tmp
 *   loadDoneState(path)          — { completed: [...] } → Set (pamti početno stanje)
 *   saveDoneState(path, set)     — na disk ide TRENUTNI disk ∪ ono što je OVAJ proces
 *                                  dodao od učitavanja. Unija cijelog seta bi vratila
 *                                  unose koje je u međuvremenu maknuo reprocess_episode.js
 *                                  (ponovna obrada bi tada tiho preskočila članak).
 */
const fs = require("fs");

function writeFileAtomic(filePath, text) {
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
        fs.writeFileSync(tmp, text, "utf-8");
        fs.renameSync(tmp, filePath);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* nema tmp-a */ }
        throw e;
    }
}

function readCompleted(statePath) {
    const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    return Array.isArray(data.completed) ? data.completed : [];
}

// Set → što je bilo u njemu pri učitavanju / zadnjem spremanju.
const baselines = new WeakMap();

function loadDoneState(statePath) {
    let set = new Set();
    try {
        if (fs.existsSync(statePath)) set = new Set(readCompleted(statePath));
    } catch (e) {
        console.error(`   ⚠️  Neispravan done-state: ${statePath} — rebuildam cache`);
    }
    baselines.set(set, new Set(set));
    return set;
}

function saveDoneState(statePath, doneSet) {
    const base = baselines.get(doneSet) || new Set();
    let merged;
    try {
        merged = new Set(fs.existsSync(statePath) ? readCompleted(statePath) : []);
    } catch {
        merged = new Set(doneSet);   // pokvaren disk → naš set je najbolje što imamo
    }
    for (const k of doneSet) if (!base.has(k)) merged.add(k);
    writeFileAtomic(statePath, JSON.stringify({ completed: [...merged] }, null, 2));
    baselines.set(doneSet, new Set(doneSet));
}

module.exports = { writeFileAtomic, loadDoneState, saveDoneState };
