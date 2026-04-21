#!/usr/bin/env node
// One-shot migration: drop editorial niche-based filtering from registry.
// New principle: free speech aggregator that includes ALL Croatian podcasts
// regardless of political/religious orientation. Tracking decisions become
// purely TECHNICAL (URL verified, metadata complete, format compatible),
// not editorial.
//
// Run once: node data/reclassify_v1_2.js

const fs = require("fs");
const path = require("path");

const REGISTRY_PATH = path.join(__dirname, "podcasts_registry.json");
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));

// Pattern that matches editorial niche-based language (Croatian)
const NICHE_PATTERNS = [
    /izvan trenutne niše/i,
    /izvan trenutne nise/i,
    /izvan postojeće niše/i,
    /izvan niše/i,
    /sekularni mainstream/i,
    /sekularni\s+(\w+\s+)?(podcast|hibrid|biznis|osobni razvoj|ženski|health|fitness|roditeljski)/i,
    /mainstream sekularni/i,
    /brzo rastući mainstream/i,
    /razmotriti za fazu 3/i,
    /razmotriti za faza 3/i,
    /razmotriti za fazi 3/i,
    /Faza 3/i,
    /relevantan za DOMOVINA\.tv/i,
    /uklapa se u DOMOVINA\.tv/i,
    /uklapa se u postojeću nišu/i,
    /preklapati s 'Rastući s djecom'/i,
    /dijasporni format/i,
];

function isNicheLanguage(text) {
    if (!text) return false;
    return NICHE_PATTERNS.some((p) => p.test(text));
}

// Replacement reasoning by category — purely technical/neutral
function buildNeutralReason(podcast) {
    const yt = podcast.youtube || {};
    const url = yt.url;
    const type = yt.type;
    const status = podcast.metadata?.status;

    if (podcast.tracking?.permanently_excluded) {
        return podcast.tracking.reason_disabled; // keep rejection reason
    }

    if (type === "audio-primary" || type === "audio-only") {
        return "Audio-only podcast — pipeline ne podržava distribuciju bez YouTube kanala. Dodati ako/kada se pokrene YT distribucija.";
    }

    if (status === "inactive" || status === "completed" || status === "paused") {
        const statusHr = { inactive: "neaktivan", completed: "završen", paused: "pauziran" }[status];
        return `Status: ${statusHr}. Arhiviran u registry-ju radi povijesnog konteksta — nema smisla trošiti pipeline na kanal koji više ne objavljuje.`;
    }

    if (status === "rejected") {
        return podcast.tracking?.reason_disabled || "Ne zadovoljava podcast definiciju.";
    }

    if (status === "disputed") {
        return "Status sporan između istraživačkih izvora — treba ručna verifikacija prije dodavanja u pipeline.";
    }

    if (!url) {
        return "Treba pronaći i potvrditi YouTube URL prije dodavanja u pipeline.";
    }

    if (podcast.tracking?.candidate_phase === 2) {
        return "Veliki kanal s puno shorts/clipova/izjava. Treba custom MIN_DURATION i odvojen ciklus obrade prije dodavanja.";
    }

    return "Kandidat za dodavanje u pipeline. URL je poznat, treba verifikacija metapodataka i odluka o uključivanju.";
}

// Apply migration
let touched = 0;
let droppedPhases = 0;

for (const p of registry.podcasts) {
    if (!p.tracking) continue;
    const reason = p.tracking.reason_disabled || "";

    // Drop candidate_phase 1 and 3 — they were editorial. Keep phase 2 (technical).
    if (p.tracking.candidate_phase === 1 || p.tracking.candidate_phase === 3) {
        delete p.tracking.candidate_phase;
        droppedPhases++;
    }

    // Neutralize niche-language reasons
    if (!p.tracking.enabled && isNicheLanguage(reason)) {
        p.tracking.reason_disabled = buildNeutralReason(p);
        touched++;
    }
}

// Update top-level description to reflect new principle
registry.version = "1.2";
registry.description =
    "Single source of truth za hrvatske podcaste na YouTubeu. Spaja: (1) trenutno praćene kanale iz automatic/refresh_podcasts.sh, (2) deep_research_prompt_hr_podcasti.md, (3) Gemini Deep Research, (4) Perplexity research, (5) Claude Opus 4.6 sveobuhvatni research. PRINCIP v1.2: free speech aggregator — uključuje SVE hrvatske podcaste bez obzira na političku ili vjersku orijentaciju. Tracking odluke su isključivo tehničke (verificirani URL, kompletni metapodaci, format kompatibilan s pipeline-om), nikad editorijalne. Polje 'disputes' u notes-ima entries-a označava gdje se izvori ne slažu.";
registry.philosophy = {
    principle: "Free speech aggregator — pravedno nogometno igralište",
    description:
        "Cilj registry-ja i platforme je objediniti SVE hrvatske podcaste bez obzira na političku, vjersku ili tematsku orijentaciju. Publika bira sadržaj koji želi konzumirati. Tracking odluke su isključivo tehničke prirode — ne provodi se editorijalna selekcija po tematici.",
    tracking_decision_criteria: [
        "URL je verificiran (yt-dlp može doseći kanal)",
        "Format je kompatibilan s pipeline-om (≥30 min razgovorni format na YouTube-u, ne audio-only)",
        "Metapodaci su dovoljno popunjeni (poznati hosts, prosječno trajanje, status aktivnosti)",
        "Veliki kanali (>1000 videa) dobivaju custom MIN_DURATION i odvojen ciklus obrade",
    ],
};

fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf8");

console.log(`✓ Reclassification complete (v1.2)`);
console.log(`  Touched entries (neutralized reason_disabled): ${touched}`);
console.log(`  Dropped editorial candidate_phase: ${droppedPhases}`);
console.log(`  Total entries: ${registry.podcasts.length}`);
