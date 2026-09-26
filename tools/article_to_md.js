#!/usr/bin/env node
/**
 * article_to_md.js — {base}_{date}_{model}.article.json → čitljiv Markdown.
 *
 * Za dijeljenje rezultata IZVAN domovina.ai (Drive, mail, demo): pipeline sam ne
 * piše Markdown članka, samo JSON. Nula API poziva.
 *
 *   node tools/article_to_md.js <article.json> <out.md> ["Oznaka modela"]
 *
 * Markdown → Google Doc: pandoc out.md -o out.docx, pa
 *   rclone copy <dir> google_drive_ms:<folder> --drive-import-formats docx
 * Vidi docs/2026-09-26-audio-datoteka-u-clanak.md.
 */
const fs = require("fs");

const [src, out, label] = process.argv.slice(2);
if (!src || !out) {
    console.error("Upotreba: node tools/article_to_md.js <article.json> <out.md> [\"Oznaka\"]");
    process.exit(1);
}
const a = JSON.parse(fs.readFileSync(src, "utf8"));
const model = a.metadata?.model || "?";
const L = [];
L.push(`# Članak (${label || model})`, "");
L.push(`_Automatski generirano: model \`${model}\`, ${a.metadata?.generated_at || ""}._`, "");
for (const it of a.iterations || []) {
    L.push(`## ${it.iteration_number}. ${it.theme}`, `_${it.start_time} – ${it.end_time}_`, "");
    for (const s of it.sections || []) {
        L.push(`### ${s.subtitle}`, `⏱ ${s.screenshot_timestamp || ""}`, "", s.content || "", "");
        if (s.keywords?.length) L.push(`**Ključne riječi:** ${s.keywords.join(", ")}`, "");
    }
}
fs.writeFileSync(out, L.join("\n"));
console.log(`✅ ${out} (${L.length} linija)`);
