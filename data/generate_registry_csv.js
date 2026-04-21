#!/usr/bin/env node
// Export podcasts_registry.json to flat CSV for Google Sheets review.
//
// Run: node data/generate_registry_csv.js
//   → writes data/podcasts_registry.csv
//
// All fields are escaped per RFC 4180:
//   - Fields containing comma, double-quote or newline are wrapped in "..."
//   - Internal double-quotes are doubled ""

const fs = require("fs");
const path = require("path");

const REGISTRY_PATH = path.join(__dirname, "podcasts_registry.json");
const OUTPUT_PATH = path.join(__dirname, "podcasts_registry.csv");

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));

function csvEscape(v) {
    if (v == null) return "";
    const s = String(v);
    if (/[,"\n\r]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function joinList(arr, sep = "; ") {
    if (!arr || !Array.isArray(arr) || arr.length === 0) return "";
    return arr.join(sep);
}

function truncateNotes(s, max = 500) {
    if (!s) return "";
    if (s.length <= max) return s;
    return s.slice(0, max - 3) + "...";
}

// Column definitions — order matters for CSV
const columns = [
    { h: "score", v: (p) => p.quality_score?.total ?? "" },
    { h: "tier", v: (p) => p.quality_score?.tier ?? "" },
    { h: "tracked", v: (p) => (p.tracking?.enabled ? "YES" : "no") },
    { h: "slug", v: (p) => p.slug },
    { h: "display_name", v: (p) => p.display_name },
    { h: "youtube_url", v: (p) => p.youtube?.url ?? "" },
    { h: "youtube_handle", v: (p) => p.youtube?.handle ?? "" },
    { h: "youtube_channel_id", v: (p) => p.youtube?.channel_id ?? "" },
    { h: "youtube_type", v: (p) => p.youtube?.type ?? "" },
    { h: "parent_channel", v: (p) => p.youtube?.parent_channel ?? "" },
    { h: "tags", v: (p) => joinList(p.tags) },
    { h: "voditelji", v: (p) => joinList(p.voditelji) },
    { h: "subscribers", v: (p) => p.metadata?.subscribers ?? "" },
    { h: "subscribers_as_of", v: (p) => p.metadata?.subscribers_as_of ?? "" },
    { h: "episodes_estimate", v: (p) => p.metadata?.episodes_estimate ?? "" },
    { h: "first_episode", v: (p) => p.metadata?.first_episode ?? "" },
    { h: "last_episode", v: (p) => p.metadata?.last_episode ?? "" },
    { h: "avg_duration_min", v: (p) => p.metadata?.average_duration_minutes ?? "" },
    { h: "frequency", v: (p) => p.metadata?.frequency ?? "" },
    { h: "status", v: (p) => p.metadata?.status ?? "" },
    { h: "tier_research", v: (p) => p.tier ?? "" },
    { h: "data_quality", v: (p) => p.data_quality ?? "" },
    { h: "sources", v: (p) => joinList(p.sources) },
    { h: "num_sources", v: (p) => (p.sources?.length ?? 0) },
    { h: "score_activity", v: (p) => p.quality_score?.breakdown?.activity ?? "" },
    { h: "score_catalog", v: (p) => p.quality_score?.breakdown?.catalog ?? "" },
    { h: "score_audience", v: (p) => p.quality_score?.breakdown?.audience ?? "" },
    { h: "score_format", v: (p) => p.quality_score?.breakdown?.format ?? "" },
    { h: "score_substance", v: (p) => p.quality_score?.breakdown?.substance ?? "" },
    { h: "score_verification", v: (p) => p.quality_score?.breakdown?.verification ?? "" },
    { h: "score_recency", v: (p) => p.quality_score?.breakdown?.recency ?? "" },
    { h: "review_needed", v: (p) => (p.tracking?.review_needed ? "YES" : "") },
    { h: "review_reason", v: (p) => p.tracking?.review_reason ?? "" },
    { h: "reason_disabled", v: (p) => p.tracking?.reason_disabled ?? "" },
    { h: "permanently_excluded", v: (p) => (p.tracking?.permanently_excluded ? "YES" : "") },
    { h: "candidate_phase", v: (p) => p.tracking?.candidate_phase ?? "" },
    { h: "min_duration_override", v: (p) => p.tracking?.min_duration_override ?? "" },
    { h: "notes", v: (p) => truncateNotes(p.notes) },
];

// Sort by score descending, then by display_name
const podcasts = [...registry.podcasts].sort((a, b) => {
    const sa = a.quality_score?.total ?? 0;
    const sb = b.quality_score?.total ?? 0;
    if (sb !== sa) return sb - sa;
    return a.display_name.localeCompare(b.display_name, "hr");
});

const lines = [];
lines.push(columns.map((c) => csvEscape(c.h)).join(","));
for (const p of podcasts) {
    lines.push(columns.map((c) => csvEscape(c.v(p))).join(","));
}

fs.writeFileSync(OUTPUT_PATH, lines.join("\n") + "\n", "utf8");

console.log(`✓ Generated ${OUTPUT_PATH}`);
console.log(`  ${podcasts.length} rows (sorted by quality_score desc)`);
console.log(`  ${columns.length} columns`);
console.log(`  Top 5: ${podcasts.slice(0, 5).map((p) => p.slug).join(", ")}`);
