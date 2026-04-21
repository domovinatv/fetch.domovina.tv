#!/usr/bin/env node
// Generate human-readable MD view of podcasts_registry.json
// Usage: node data/generate_registry_md.js
//   → writes data/podcasts_registry.md
//
// This is the canonical SSOT view for humans. The JSON is the machine truth.
// Run this whenever you edit podcasts_registry.json.

const fs = require("fs");
const path = require("path");

const REGISTRY_PATH = path.join(__dirname, "podcasts_registry.json");
const OUTPUT_PATH = path.join(__dirname, "podcasts_registry.md");

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));

// --- Helpers ---

function fmtNum(n) {
    if (n == null) return "—";
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(0) + "K";
    return String(n);
}

function fmtQuality(q) {
    return { verified: "✅", partial: "⚠️", unverified: "❓" }[q] || "—";
}

function fmtStatus(s) {
    return (
        {
            active: "🟢 aktivan",
            inactive: "🔴 neaktivan",
            paused: "⏸ pauziran",
            rejected: "❌ rejected",
            unknown: "⚪ nepoznato",
        }[s] || "⚪ nepoznato"
    );
}

function fmtUrl(yt) {
    if (!yt || !yt.url) return "—";
    const label = yt.handle || yt.channel_id || (yt.type === "playlist" ? "playlist" : "link");
    return `[${label}](${yt.url})`;
}

function fmtVoditelji(arr) {
    if (!arr || arr.length === 0) return "—";
    return arr.join(", ");
}

function fmtTags(arr) {
    if (!arr || arr.length === 0) return "—";
    return arr.map((t) => `\`${t}\``).join(" ");
}

function escapeMd(s) {
    if (s == null) return "";
    return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// --- Sorting ---

const podcasts = [...registry.podcasts].sort((a, b) =>
    a.display_name.localeCompare(b.display_name, "hr"),
);

// --- Sections ---

const tracked = podcasts.filter((p) => p.tracking.enabled);
const trackedReview = tracked.filter((p) => p.tracking.review_needed);

const candidatesPhase1 = podcasts.filter(
    (p) => !p.tracking.enabled && p.tracking.candidate_phase === 1,
);
const candidatesPhase2 = podcasts.filter(
    (p) => !p.tracking.enabled && p.tracking.candidate_phase === 2,
);
const candidatesOther = podcasts.filter(
    (p) =>
        !p.tracking.enabled &&
        !p.tracking.permanently_excluded &&
        ![1, 2].includes(p.tracking.candidate_phase),
);
const rejected = podcasts.filter(
    (p) => !p.tracking.enabled && p.tracking.permanently_excluded,
);

// --- Stats ---

const stats = {
    total: podcasts.length,
    tracked: tracked.length,
    trackedReview: trackedReview.length,
    candidatesPhase1: candidatesPhase1.length,
    candidatesPhase2: candidatesPhase2.length,
    candidatesOther: candidatesOther.length,
    rejected: rejected.length,
};

const byTier = {};
podcasts.forEach((p) => {
    const t = p.tier == null ? "—" : `tier ${p.tier}`;
    byTier[t] = (byTier[t] || 0) + 1;
});

const byQuality = {};
podcasts.forEach((p) => {
    byQuality[p.data_quality] = (byQuality[p.data_quality] || 0) + 1;
});

const byStatus = {};
podcasts.forEach((p) => {
    const s = p.metadata?.status || "unknown";
    byStatus[s] = (byStatus[s] || 0) + 1;
});

// --- Table renderer ---

function renderTable(rows, opts = {}) {
    if (rows.length === 0) return "_(prazno)_\n";
    const cols = [
        { h: "Naziv", w: (p) => `**${escapeMd(p.display_name)}**` },
        { h: "YouTube", w: (p) => fmtUrl(p.youtube) },
        { h: "Tier", w: (p) => (p.tier == null ? "—" : String(p.tier)) },
        { h: "Subs", w: (p) => fmtNum(p.metadata?.subscribers) },
        { h: "Ep.", w: (p) => fmtNum(p.metadata?.episodes_estimate) },
        { h: "Status", w: (p) => fmtStatus(p.metadata?.status) },
        { h: "Voditelji", w: (p) => escapeMd(fmtVoditelji(p.voditelji)) },
        { h: "Tagovi", w: (p) => fmtTags(p.tags) },
        { h: "Q", w: (p) => fmtQuality(p.data_quality) },
    ];
    const header = "| " + cols.map((c) => c.h).join(" | ") + " |";
    const sep = "| " + cols.map(() => "---").join(" | ") + " |";
    const body = rows.map((p) => "| " + cols.map((c) => c.w(p)).join(" | ") + " |").join("\n");
    return header + "\n" + sep + "\n" + body + "\n";
}

// --- Compose MD ---

const lines = [];

lines.push("# Hrvatski podcasti — registry");
lines.push("");
lines.push(
    `> **Single source of truth** za hrvatske podcaste na YouTubeu. Generiraj ovaj fajl pokretanjem \`node data/generate_registry_md.js\` nakon izmjena u \`podcasts_registry.json\`.`,
);
lines.push("");
lines.push(`**Generirano:** ${new Date().toISOString().slice(0, 10)}`);
lines.push(`**Verzija registry-ja:** ${registry.version}`);
lines.push("");

// Stats
lines.push("## Sažetak");
lines.push("");
lines.push(`- **Ukupno unosa:** ${stats.total}`);
lines.push(`- **Trenutno se prati:** ${stats.tracked}`);
if (stats.trackedReview > 0) {
    lines.push(`  - od toga \`review_needed\`: ${stats.trackedReview} (vidi sekciju dolje)`);
}
lines.push(`- **Kandidati Faza 1** (postojeća niša, brzi dodaci): ${stats.candidatesPhase1}`);
lines.push(`- **Kandidati Faza 2** (veliki kanali, custom MIN_DURATION): ${stats.candidatesPhase2}`);
lines.push(`- **Ostali kandidati** (sekularni / dijaspora / istražiti): ${stats.candidatesOther}`);
lines.push(`- **Rejected** (permanentno isključeni): ${stats.rejected}`);
lines.push("");

lines.push("**Distribucija po tier-u:** " + Object.entries(byTier).map(([k, v]) => `${k}: ${v}`).join(" · "));
lines.push("");
lines.push(
    "**Distribucija po data_quality:** " +
        Object.entries(byQuality)
            .map(([k, v]) => `${k} ${fmtQuality(k)}: ${v}`)
            .join(" · "),
);
lines.push("");
lines.push(
    "**Distribucija po status-u:** " +
        Object.entries(byStatus)
            .map(([k, v]) => `${fmtStatus(k)}: ${v}`)
            .join(" · "),
);
lines.push("");

lines.push("**Legenda:** ✅ verified · ⚠️ partial · ❓ unverified · 🟢 aktivan · 🔴 neaktivan · ⚪ nepoznato");
lines.push("");

// Izvori
lines.push("## Izvori podataka");
lines.push("");
registry.sources.forEach((s) => {
    lines.push(`- **${s.id}**: ${s.label}${s.date ? ` _(${s.date})_` : ""}`);
});
lines.push("");

// === Trenutno tracked ===
lines.push("---");
lines.push("");
lines.push(`## 🟢 Trenutno se prati (${tracked.length})`);
lines.push("");
lines.push("Kanali aktivno u `automatic/refresh_podcasts.sh`. Sortirano abecedno.");
lines.push("");
lines.push(renderTable(tracked));

// Tracked - review needed
if (trackedReview.length > 0) {
    lines.push("");
    lines.push(`### ⚠️ Tracked ali zahtijeva pregled (${trackedReview.length})`);
    lines.push("");
    lines.push(
        "Kanali koje pratimo, ali Gemini istraživanje 03/2026 sugerira da nisu pravi podcasti, neaktivni su, ili ne zadovoljavaju definiciju (≥30 min razgovorni format 2+ osobe).",
    );
    lines.push("");
    trackedReview.forEach((p) => {
        lines.push(`#### ${p.display_name} (\`${p.slug}\`)`);
        lines.push("");
        lines.push(`- **URL:** ${fmtUrl(p.youtube)}`);
        lines.push(`- **Status:** ${fmtStatus(p.metadata?.status)}`);
        lines.push(`- **Razlog za pregled:** ${p.tracking.review_reason}`);
        if (p.notes) lines.push(`- **Bilješka:** ${p.notes}`);
        lines.push("");
    });
}

// === Kandidati Faza 1 ===
lines.push("---");
lines.push("");
lines.push(`## 🚀 Kandidati Faza 1 — postojeća niša (${candidatesPhase1.length})`);
lines.push("");
lines.push(
    "Visok prioritet za dodavanje. Uklapaju se u trenutni editorijalni profil DOMOVINA.tv (katoličko / domoljubno / hrvatski identitet / povijest). Treba samo potvrditi YouTube URL i dodati u `KANALI` array.",
);
lines.push("");
lines.push(renderTable(candidatesPhase1));

// === Kandidati Faza 2 ===
lines.push("");
lines.push("---");
lines.push("");
lines.push(`## 🏗️ Kandidati Faza 2 — veliki kanali, custom obrada (${candidatesPhase2.length})`);
lines.push("");
lines.push(
    "Veliki kanali s puno shorts/clipova/izjava. Trebaju custom `MIN_DURATION` per-kanal i odvojen ciklus obrade da se filtriraju kratki sadržaji. Trenutno zakomentirani u `refresh_podcasts.sh`.",
);
lines.push("");
lines.push(renderTable(candidatesPhase2));

// === Ostali kandidati ===
lines.push("");
lines.push("---");
lines.push("");
lines.push(`## 📚 Ostali kandidati — sekularni mainstream / dijaspora / istražiti (${candidatesOther.length})`);
lines.push("");
lines.push(
    "Podcasti uglavnom izvan trenutne uske niše DOMOVINA.tv. Razmotriti za Fazu 3 (širenje na cijeli hrvatski podcast ekosustav). Neki su bez verificiranog YouTube URL-a — treba istraživanje.",
);
lines.push("");
lines.push(renderTable(candidatesOther));

// === Rejected ===
lines.push("");
lines.push("---");
lines.push("");
lines.push(`## ❌ Rejected — permanentno isključeni (${rejected.length})`);
lines.push("");
lines.push(
    "**Ne dodavati ponovno.** Ovi unosi su detaljno istraženi i utvrđeno je da NE zadovoljavaju definiciju podcasta (≥30 min razgovorni format, 2+ osobe, dio prepoznatljivog serijala).",
);
lines.push("");
rejected.forEach((p) => {
    lines.push(`### ${p.display_name} (\`${p.slug}\`)`);
    lines.push("");
    lines.push(`- **Razlog:** ${p.tracking.reason_disabled}`);
    if (p.notes) lines.push(`- **Detalji:** ${p.notes}`);
    lines.push("");
});

// === Research gaps ===
if (registry.research_gaps && registry.research_gaps.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## 🔍 Research gaps — kategorije koje treba istražiti");
    lines.push("");
    lines.push(
        "Tematske vertikale za koje oba istraživačka izvora (deep_research_prompt + Gemini) sugeriraju da su underserved u trenutnom registry-ju. Pokrenuti deep research po `deep_research_prompt_hr_podcasti.md` da se popune.",
    );
    lines.push("");
    registry.research_gaps.forEach((g) => lines.push(`- ${g}`));
    lines.push("");
}

// === Footer ===
lines.push("---");
lines.push("");
lines.push("## Schema napomena");
lines.push("");
lines.push("Svaki podcast u JSON-u ima ova polja:");
lines.push("");
lines.push("```");
lines.push("{");
lines.push('  "slug": "kebab-case-id",');
lines.push('  "display_name": "Pun naziv",');
lines.push('  "youtube": { "url", "handle", "channel_id", "type", "parent_channel" },');
lines.push('  "tags": ["category1", "category2"],');
lines.push('  "voditelji": ["Ime Prezime"],');
lines.push('  "metadata": { "subscribers", "episodes_estimate", "first_episode", "last_episode", "average_duration_minutes", "frequency", "status" },');
lines.push('  "tracking": { "enabled", "reason_disabled", "min_duration_override", "candidate_phase", "review_needed", "review_reason", "permanently_excluded" },');
lines.push('  "tier": 1|2|3|4|null,');
lines.push('  "data_quality": "verified" | "partial" | "unverified",');
lines.push('  "sources": ["current", "report", "gemini"],');
lines.push('  "notes": "free-form"');
lines.push("}");
lines.push("```");
lines.push("");

const output = lines.join("\n");
fs.writeFileSync(OUTPUT_PATH, output, "utf8");

console.log(`✓ Generated ${OUTPUT_PATH}`);
console.log(`  Total: ${stats.total} entries`);
console.log(`  Tracked: ${stats.tracked} (review_needed: ${stats.trackedReview})`);
console.log(
    `  Candidates: phase1=${stats.candidatesPhase1} phase2=${stats.candidatesPhase2} other=${stats.candidatesOther}`,
);
console.log(`  Rejected: ${stats.rejected}`);
