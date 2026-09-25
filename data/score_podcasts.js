#!/usr/bin/env node
// Compute objective quality score (0-100) for each podcast in registry.
// Idempotent za isti ulaz i isti dan (svježina se računa od današnjeg datuma).
//
// Run: node data/score_podcasts.js
//
// RUBRIC v2 (2026-09-25) — AKTIVNOST ispred veličine:
//   1. Svježina        (0-30)  — dana od zadnje ORIGINALNE epizode (točan datum gdje postoji)
//   2. Ritam           (0-25)  — broj originala u zadnjih 90 dana
//   3. Format          (0-15)  — ≥30 min razgovorni format
//   4. Supstanca       (0-10)  — prosječno trajanje epizode
//   5. Katalog         (0-10)  — dubina kataloga
//   6. Doseg           (0-10)  — pratitelji, log-skalirano
//
// Zašto: v1 je davao 35 bodova veličini (pratitelji + katalog) a 5 svježini, pa je
// napušteni vlog kanal sa 112k pratitelja (zadnja epizoda 12/2022) nadjačavao živ
// podcast sa 70 pratitelja i 5 epizoda u 2 mjeseca. Veličina kanala ne kaže radi li
// podcast; ritam objavljivanja kaže. Oznake:
//   rising  — mali kanal (<5k) koji aktivno objavljuje (≥4 originala / 90 d, zadnji ≤30 d)
//   dormant — zadnji original prije >365 dana (score ograničen na 39)
//
// Score je namjerno editorijalno neutralan: tematika, politika i vjerska
// orijentacija NE ulaze u izračun.

const fs = require("fs");
const path = require("path");

const REGISTRY_PATH = path.join(__dirname, "podcasts_registry.json");
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));

// --- Component scorers ---

function lastEpisodeDate(p) {
    const a = p.activity?.last_original_upload;                    // YYYYMMDD
    const e = p.metadata?.last_episode_date;                       // YYYY-MM-DD (exact-dates)
    const cands = [];
    if (a && /^\d{8}$/.test(a)) cands.push(`${a.slice(0, 4)}-${a.slice(4, 6)}-${a.slice(6, 8)}`);
    if (e && !p.metadata?.last_episode_date_approx) cands.push(e);
    if (cands.length) return cands.sort().pop();
    if (e) return e;
    const m = /^(\d{4})-(\d{2})$/.exec(p.metadata?.last_episode || "");
    return m ? `${m[1]}-${m[2]}-15` : null;                        // samo mjesec → sredina mjeseca
}

function daysSinceLast(p) {
    const d = lastEpisodeDate(p);
    return d ? Math.floor((Date.now() - Date.parse(d + "T12:00:00Z")) / 86400000) : null;
}

function scoreFreshness(days, p) {
    if (days == null) {
        const s = p.metadata?.status;
        return s === "active" ? 15 : s === "active-slowing" ? 8 : 0;   // bez datuma: samo status
    }
    if (days <= 14) return 30;
    if (days <= 30) return 27;
    if (days <= 60) return 22;
    if (days <= 120) return 14;
    if (days <= 180) return 8;
    if (days <= 365) return 3;
    return 0;
}

function scoreCadence(p) {
    const n = p.activity?.originals_90d;
    if (n == null) {
        const s = p.metadata?.status;
        return s === "active" ? 10 : s === "active-slowing" ? 5 : 0;
    }
    if (n >= 12) return 25;       // tjedno ili češće
    if (n >= 8) return 22;
    if (n >= 5) return 18;        // npr. 5 epizoda u 2 mjeseca
    if (n >= 3) return 12;
    if (n >= 1) return 6;
    return 0;
}

function scoreFormat(p) {
    const status = p.metadata?.status;
    const type = p.youtube?.type;
    if (status === "rejected" || status === "not-podcast" || p.tracking?.permanently_excluded) return 0;
    if (type === "audio-primary" || type === "audio-only") return 6;
    if (type === "disputed" || status === "disputed") return 8;
    const dur = p.metadata?.average_duration_minutes;
    if (dur != null && dur < 30) return 3;
    if (type === "channel" || type === "playlist") return 15;
    return 10;
}

function scoreSubstance(p) {
    const dur = p.metadata?.average_duration_minutes;
    if (dur == null) return 4;
    if (dur >= 90) return 10;
    if (dur >= 60) return 8;
    if (dur >= 45) return 7;
    if (dur >= 30) return 5;
    return 2;
}

function scoreCatalog(p) {
    const n = p.metadata?.episodes_estimate ?? p.activity?.episodes_on_disk ?? p.activity?.originals_365d ?? p.metadata?.episodes_over_30min_sampled;
    if (n == null) return 3;
    if (n >= 200) return 10;
    if (n >= 100) return 8;
    if (n >= 50) return 6;
    if (n >= 20) return 4;
    if (n >= 5) return 2;
    return 1;
}

function scoreAudience(p) {
    const subs = p.metadata?.subscribers;
    if (subs == null) return 3;
    if (subs >= 100000) return 10;
    if (subs >= 30000) return 9;
    if (subs >= 10000) return 8;
    if (subs >= 3000) return 6;
    if (subs >= 1000) return 5;
    if (subs >= 100) return 3;
    return 2;
}

// --- Tier classification ---

function tierForScore(s) {
    if (s >= 80) return "🌟 elite";
    if (s >= 60) return "✅ strong";
    if (s >= 40) return "👀 moderate";
    if (s >= 20) return "📦 weak";
    return "❌ very-low";
}

// --- Apply scoring ---

let stats = { tiers: {}, total: 0, sum: 0 };

for (const p of registry.podcasts) {
    const days = daysSinceLast(p);
    const breakdown = {
        freshness: scoreFreshness(days, p),
        cadence: scoreCadence(p),
        format: scoreFormat(p),
        substance: scoreSubstance(p),
        catalog: scoreCatalog(p),
        audience: scoreAudience(p),
    };
    let total = Object.values(breakdown).reduce((a, b) => a + b, 0);
    const dormant = days != null && days > 365;
    if (dormant || p.metadata?.status === "not-podcast" || p.metadata?.status === "dead-url") total = Math.min(total, 39);
    const subs = p.metadata?.subscribers;
    const rising = !dormant && subs != null && subs < 5000 && (p.activity?.originals_90d || 0) >= 4 && days != null && days <= 30;
    const tier = tierForScore(total);

    p.quality_score = {
        total,
        tier,
        breakdown,
        days_since_last_episode: days,
        last_episode_date: lastEpisodeDate(p),
        ...(rising ? { rising: true } : {}),
        ...(dormant ? { dormant: true } : {}),
        rubric: "v2",
    };

    stats.tiers[tier] = (stats.tiers[tier] || 0) + 1;
    stats.total++;
    stats.sum += total;
    if (rising) stats.rising = (stats.rising || 0) + 1;
}

// Add rubric metadata to top-level for self-documentation
registry.quality_score_rubric = {
    version: "v2 (2026-09-25)",
    description:
        "Objektivna kvantitativna metrika podcasta (0-100). Editorialno neutralna — ne uzima u obzir tematiku, politiku ili vjersku orijentaciju. v2 mjeri prvenstveno AKTIVNOST (svježina + ritam = 55 bodova), a veličinu (katalog + doseg) samo 20: napušten kanal sa 100k pratitelja ne smije nadjačati živ mali podcast.",
    components: {
        freshness: { max: 30, description: "Dana od zadnje originalne epizode (≤14=30, ≤30=27, ≤60=22, ≤120=14, ≤180=8, ≤365=3)" },
        cadence: { max: 25, description: "Originala u zadnjih 90 dana (≥12=25, ≥8=22, ≥5=18, ≥3=12, ≥1=6)" },
        format: { max: 15, description: "≥30 min razgovorni format (channel/playlist=15, audio-only=6, <30 min=3, not-podcast=0)" },
        substance: { max: 10, description: "Prosječno trajanje epizode (90+=10, 60+=8, 45+=7, 30+=5)" },
        catalog: { max: 10, description: "Broj epizoda (200+=10, 100+=8, 50+=6, 20+=4, 5+=2)" },
        audience: { max: 10, description: "YT pratitelji, log-skalirano (100K+=10, 30K+=9, 10K+=8, 3K+=6, 1K+=5, 100+=3)" },
    },
    flags: {
        rising: "Mali kanal (<5k pratitelja) koji aktivno objavljuje: ≥4 originala u 90 dana, zadnji ≤30 dana — potencijal rasta",
        dormant: "Zadnji original prije >365 dana — score ograničen na 39 bez obzira na veličinu",
    },
    tiers: {
        "🌟 elite": "80-100 — aktivan, redovit, etabliran",
        "✅ strong": "60-79 — aktivan, vrijedi pratiti",
        "👀 moderate": "40-59 — povremen ili usporava",
        "📦 weak": "20-39 — uspavan, ugašen ili premalo podataka",
        "❌ very-low": "0-19 — rejected, ugašen ili premalo podataka",
    },
};

fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf8");

const avg = (stats.sum / stats.total).toFixed(1);
console.log(`✓ Scored ${stats.total} podcasts (avg ${avg}/100, rubric v2, 🌱 rising ${stats.rising || 0})`);
console.log("Tiers:");
Object.entries(stats.tiers)
    .sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => console.log(`  ${t}: ${n}`));
