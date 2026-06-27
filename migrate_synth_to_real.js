#!/usr/bin/env node
/**
 * migrate_synth_to_real.js
 * ────────────────────────
 * Migrira beamly audio-only epizode koje su NAKNADNO dobile YouTube match: mijenja
 * sintetički `_yt_` ID u pravi YouTube ID svuda (imena fajlova + sadržaj + state + lista),
 * pa epizoda postaje "matched" (dobije video kao i ostale). Auto-detektira kandidate:
 * info.json `_yt_matched===false` ALI slug ima high-confidence match u enrich mappingu.
 *
 * NE radi R2/video/reindex — to ide POSLIJE (download_matched_beamly_video → backfill_video_h264
 * → upload_to_r2 → generate_channel_index), plus brisanje orphan synth R2 ključeva.
 *
 *   node migrate_synth_to_real.js [--dry-run] [--video-id <synthId>]
 *
 * ⚠️  Mijenja JAVNI ID 5 live epizoda. Pokreni --dry-run prvo.
 */
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ONLY = (() => { const i = args.indexOf("--video-id"); return i !== -1 ? args[i + 1] : null; })();
const OUTPUT_DIR = path.join(__dirname, "storage", "output");
const PODCASTS = path.join(__dirname, "automatic", "podcasts");
const SUBCLUB_REPO = "/Users/ms/git/revenuecat/subclub";
const TEXT_EXT = new Set(["json", "jsonl", "txt", "md", "srt", "csv", "vtt", "description"]);

function hcMap(f) {
    const d = JSON.parse(fs.readFileSync(path.join(SUBCLUB_REPO, f), "utf8"));
    const m = new Map();
    for (const v of (d.videos || [])) if (v.matched && v.confidence === "high" && v.episodeSlug) m.set(v.episodeSlug, v.videoId);
    return m;
}

function isText(p) {
    const ext = p.split(".").pop().toLowerCase();
    return TEXT_EXT.has(ext);
}

// Rekurzivno: za svaki fajl/dir pod chDir koji sadrži `synth` u imenu → rename synth→real;
// za text fajlove i replace sadržaja. Dirovi (_raw, _screenshots) se renameaju pa recurse.
function migratePath(p, synth, real, stats) {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
        for (const e of fs.readdirSync(p)) migratePath(path.join(p, e), synth, real, stats);
        // rename dir nakon djece
        if (path.basename(p).includes(synth)) {
            const np = path.join(path.dirname(p), path.basename(p).split(synth).join(real));
            if (!DRY) fs.renameSync(p, np);
            stats.dirs++;
        }
        return;
    }
    const base = path.basename(p);
    const hasInName = base.includes(synth);
    let contentChanged = false;
    if (isText(p)) {
        try {
            const raw = fs.readFileSync(p, "utf8");
            if (raw.includes(synth)) {
                if (!DRY) fs.writeFileSync(p, raw.split(synth).join(real), "utf8");
                contentChanged = true; stats.contentFiles++;
            }
        } catch {}
    }
    if (hasInName) {
        const np = path.join(path.dirname(p), base.split(synth).join(real));
        if (!DRY) fs.renameSync(p, np);
        stats.renamed++;
    }
    if (contentChanged && !hasInName) { /* npr. state izvan, ne ovdje */ }
}

(function main() {
    const maps = { subclub: hcMap("youtube/subclub.json"), launched: hcMap("youtube/launched.json") };
    const targets = [];
    for (const ch of ["subclub", "launched"]) {
        const chDir = path.join(OUTPUT_DIR, ch);
        let infs;
        try { infs = cp.execSync(`find -L "${chDir}" -maxdepth 1 -name "*.info.json" -not -name "._*" 2>/dev/null`).toString().trim().split("\n").filter(Boolean); } catch { continue; }
        for (const inf of infs) {
            let j; try { j = JSON.parse(fs.readFileSync(inf, "utf8")); } catch { continue; }
            if (j._yt_matched !== false) continue;
            const real = maps[ch].get(j._slug);
            if (!real) continue;
            const synth = path.basename(inf).match(/_yt_([A-Za-z0-9_-]{11})\.info\.json$/)?.[1];
            if (!synth || (ONLY && synth !== ONLY)) continue;
            targets.push({ ch, chDir, synth, real, slug: j._slug });
        }
    }

    console.log(`\n🔀 Synth→real migracija${DRY ? " (DRY-RUN)" : ""} — ${targets.length} epizoda:\n`);
    for (const t of targets) {
        console.log(`  ── ${t.ch} | ${t.synth} → ${t.real} (${t.slug.slice(0, 45)})`);
        const stats = { renamed: 0, dirs: 0, contentFiles: 0 };
        // 1. fajlovi + sadržaj pod channel dir
        for (const e of fs.readdirSync(t.chDir)) {
            if (e.startsWith("._")) continue;
            if (e.includes(t.synth)) migratePath(path.join(t.chDir, e), t.synth, t.real, stats);
        }
        // 2. info.json: _yt_matched false→true (na NOVOM imenu)
        const newInfo = path.join(t.chDir, fs.readdirSync(t.chDir).find(f => !f.startsWith("._") && f.includes(t.real) && f.endsWith(".info.json")) || "");
        if (!DRY && fs.existsSync(newInfo)) {
            const j = JSON.parse(fs.readFileSync(newInfo, "utf8"));
            j._yt_matched = true; j.id = t.real;
            fs.writeFileSync(newInfo, JSON.stringify(j, null, 2) + "\n", "utf8");
        }
        // 3. state + lista (replace synth→real)
        for (const sf of [`${t.ch}-lista-state.json`, `${t.ch}-state.json`, `${t.ch}-lista.txt`]) {
            const fp = path.join(PODCASTS, sf);
            if (!fs.existsSync(fp)) continue;
            const raw = fs.readFileSync(fp, "utf8");
            if (raw.includes(t.synth)) { if (!DRY) fs.writeFileSync(fp, raw.split(t.synth).join(t.real), "utf8"); stats.contentFiles++; }
        }
        console.log(`     renamed: ${stats.renamed} fajlova, ${stats.dirs} dirova | content-replace: ${stats.contentFiles} fajlova`);
    }
    console.log(`\n${DRY ? "DRY-RUN — ništa nije promijenjeno." : "✅ Lokalna migracija gotova."} Sljedeće: video download + backfill + upload + reindex + delete orphan synth R2 ključeva.`);
})();
