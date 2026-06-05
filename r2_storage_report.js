#!/usr/bin/env node
/**
 * r2_storage_report.js
 * ────────────────────
 * Listira cijeli R2 bucket (cdn.domovina.ai) i agregira veličinu po kategoriji
 * datoteke (video h264 / legacy video / screenshots / thumbnails / OG / JSON / SRT…).
 * Read-only — ništa ne briše. Služi za odluku što se može počistiti.
 *
 *   node r2_storage_report.js
 */
const fs = require("fs");
const path = require("path");

(function loadEnv() {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
})();

const S3 = require("@aws-sdk/client-s3");
const client = new S3.S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const BUCKET = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";

function categorize(key) {
    if (key.endsWith("/video_h264.mp4")) return "Video H.264 (novi)";
    if (key.endsWith("/video.mp4")) return "Video legacy (VP9/AV1) — kandidat za brisanje";
    if (key.includes("/screenshots/") && key.endsWith(".png")) return "Screenshots (PNG)";
    if (key.endsWith("/thumbnail.png")) return "Thumbnails";
    if (/\/og[-.].*\.jpg$/.test(key) || key.endsWith("og-share.jpg") || key.includes("og-sections")) return "OG / social slike";
    if (key.endsWith(".png")) return "Ostale slike (PNG)";
    if (key.endsWith(".jpg")) return "Ostale slike (JPG)";
    if (key.endsWith(".jsonl")) return "RAG jsonl";
    if (key.endsWith(".srt")) return "SRT (transkript)";
    if (key.endsWith(".json")) return "JSON (data: article/summary/info…)";
    if (key.endsWith(".md")) return "Markdown";
    return "Ostalo";
}

function human(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
    return `${(b / 1073741824).toFixed(2)} GB`;
}

(async () => {
    const cats = {};
    let token, pages = 0, totalObj = 0, totalBytes = 0;
    process.stdout.write("Listam R2 bucket");
    do {
        const resp = await client.send(new S3.ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }));
        for (const o of resp.Contents || []) {
            const c = categorize(o.Key);
            if (!cats[c]) cats[c] = { n: 0, bytes: 0 };
            cats[c].n++; cats[c].bytes += o.Size || 0;
            totalObj++; totalBytes += o.Size || 0;
        }
        token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        if (++pages % 10 === 0) process.stdout.write(".");
    } while (token);
    process.stdout.write("\n\n");

    const rows = Object.entries(cats).sort((a, b) => b[1].bytes - a[1].bytes);
    console.log(`  ${"Kategorija".padEnd(48)} ${"Objekata".padStart(9)} ${"Veličina".padStart(11)}  %`);
    console.log(`  ${"─".repeat(80)}`);
    for (const [c, v] of rows) {
        const pct = ((v.bytes / totalBytes) * 100).toFixed(1);
        console.log(`  ${c.padEnd(48)} ${String(v.n).padStart(9)} ${human(v.bytes).padStart(11)}  ${pct}%`);
    }
    console.log(`  ${"─".repeat(80)}`);
    console.log(`  ${"UKUPNO".padEnd(48)} ${String(totalObj).padStart(9)} ${human(totalBytes).padStart(11)}`);
})();
