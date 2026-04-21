#!/usr/bin/env node
// Compute objective quality score (0-100) for each podcast in registry.
// Idempotent — re-running produces same scores from same input.
//
// Run: node data/score_podcasts.js
//
// Adds to each podcast entry:
//   "quality_score": { "total": N, "breakdown": {...}, "tier": "..." }
//
// RUBRIC (max 100 points):
//   1. Activity         (0-25)  — recency of last episode
//   2. Catalog depth    (0-20)  — total episode count
//   3. Audience reach   (0-15)  — log-scaled subscriber count
//   4. Format compliance (0-15) — meets ≥30min/2+ person definition
//   5. Production substance (0-10) — average episode duration
//   6. Verification    (0-10)   — source agreement + URL quality
//   7. Recency bonus   (0-5)    — fresh content in last cycle
//
// Score is INTENTIONALLY editorial-neutral. It does NOT consider topic,
// political orientation, or fit with any particular editorial niche.
// All Croatian podcasts are scored on the same axes.

const fs = require("fs");
const path = require("path");

const REGISTRY_PATH = path.join(__dirname, "podcasts_registry.json");
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));

// --- Component scorers ---

function scoreActivity(p) {
    const status = p.metadata?.status;
    const last = p.metadata?.last_episode || "";
    if (status === "rejected") return 0;
    if (status === "inactive" || status === "completed") return 0;
    if (status === "paused") return 5;
    if (status === "active-slowing") return 18;
    if (status === "disputed") return 12;
    if (status === "active") return 25;
    // No explicit status — try to infer from last_episode
    if (/2026/.test(last)) return 25;
    if (/2025/.test(last)) return 12;
    if (/2024/.test(last)) return 5;
    return 8; // default mid for unknown
}

function scoreCatalog(p) {
    const n = p.metadata?.episodes_estimate;
    if (n == null) return 4; // default low
    if (n >= 1000) return 20;
    if (n >= 500) return 18;
    if (n >= 200) return 15;
    if (n >= 100) return 12;
    if (n >= 50) return 9;
    if (n >= 20) return 6;
    if (n >= 5) return 3;
    return 1;
}

function scoreAudience(p) {
    const subs = p.metadata?.subscribers;
    if (subs == null) return 4; // default low-mid for unknown
    if (subs >= 100000) return 15;
    if (subs >= 30000) return 13;
    if (subs >= 10000) return 11;
    if (subs >= 3000) return 8;
    if (subs >= 1000) return 5;
    return 2;
}

function scoreFormat(p) {
    const status = p.metadata?.status;
    const type = p.youtube?.type;
    if (status === "rejected" || p.tracking?.permanently_excluded) return 0;
    if (type === "audio-primary" || type === "audio-only") return 6;
    if (type === "disputed") return 8;
    if (status === "disputed") return 8;
    // Check for ≥30min meta
    const dur = p.metadata?.average_duration_minutes;
    if (dur != null && dur < 30) return 3;
    if (type === "channel" || type === "playlist") return 15;
    return 10; // default — assume valid
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

function scoreVerification(p) {
    const hasUrl = !!p.youtube?.url;
    const numSources = (p.sources || []).length;
    const dq = p.data_quality;

    let score = 0;
    if (hasUrl) {
        if (numSources >= 3) score = 8;
        else if (numSources >= 2) score = 7;
        else score = 5;
    } else {
        if (numSources >= 3) score = 4;
        else if (numSources >= 2) score = 3;
        else score = 1;
    }
    if (dq === "verified") score += 2;
    else if (dq === "unverified") score = Math.max(0, score - 2);

    return Math.min(10, score);
}

function scoreRecency(p) {
    const last = p.metadata?.last_episode || "";
    if (/2026-0[3-9]|2026-1[0-2]|2026-04|2026-03/.test(last)) return 5;
    if (/2026/.test(last)) return 4;
    if (/2025/.test(last)) return 2;
    if (/2024/.test(last)) return 1;
    return 0;
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
    const breakdown = {
        activity: scoreActivity(p),
        catalog: scoreCatalog(p),
        audience: scoreAudience(p),
        format: scoreFormat(p),
        substance: scoreSubstance(p),
        verification: scoreVerification(p),
        recency: scoreRecency(p),
    };
    const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
    const tier = tierForScore(total);

    p.quality_score = {
        total,
        tier,
        breakdown,
    };

    stats.tiers[tier] = (stats.tiers[tier] || 0) + 1;
    stats.total++;
    stats.sum += total;
}

// Add rubric metadata to top-level for self-documentation
registry.quality_score_rubric = {
    description:
        "Objektivna kvantitativna metrika kvalitete podcasta (0-100). Editorialno neutralna — ne uzima u obzir tematiku, politiku ili vjersku orijentaciju. Mjeri samo: aktivnost, dubinu kataloga, doseg auditorija, format compliance, supstancu, verificiranost i svježinu.",
    components: {
        activity: { max: 25, description: "Recentnost zadnje epizode (active=25, disputed=12, paused=5, inactive=0)" },
        catalog: { max: 20, description: "Ukupan broj epizoda (1000+=20, 500+=18, 200+=15, 100+=12...)" },
        audience: { max: 15, description: "Broj YT pretplatnika, log-skaliran (100K+=15, 30K+=13, 10K+=11...)" },
        format: { max: 15, description: "Zadovoljava li ≥30min razgovornu definiciju (channel=15, audio-only=6, rejected=0)" },
        substance: { max: 10, description: "Prosječno trajanje epizode (90+=10, 60+=8, 45+=7, 30+=5)" },
        verification: { max: 10, description: "Broj nezavisnih izvora + verificirani URL + data_quality" },
        recency: { max: 5, description: "Bonus za svježe epizode (2026=5, 2025=2, 2024=1)" },
    },
    tiers: {
        "🌟 elite": "80-100 — top kvaliteta, verificirano, aktivno",
        "✅ strong": "60-79 — etablirano, vrijedi pratiti",
        "👀 moderate": "40-59 — vrijedi promatrati, treba verifikacija",
        "📦 weak": "20-39 — ograničeni podaci ili niska aktivnost",
        "❌ very-low": "0-19 — rejected, ugašen ili premalo podataka",
    },
};

fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf8");

const avg = (stats.sum / stats.total).toFixed(1);
console.log(`✓ Scored ${stats.total} podcasts (avg ${avg}/100)`);
console.log("Tiers:");
Object.entries(stats.tiers)
    .sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => console.log(`  ${t}: ${n}`));
