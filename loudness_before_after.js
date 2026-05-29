#!/usr/bin/env node
/**
 * loudness_before_after.js
 *
 * Agregira before/after glasnoću iz `.loudnorm.json` sidecara koje je
 * normalize_loudness.js zapisao tijekom obrade. NE čita ni ne dekodira audio —
 * samo parsa male JSON-e, pa je trošak ~sekunde / ~nula CPU.
 *
 * Svaki sidecar sadrži:
 *   input.integrated_lufs   → PRIJE normalizacije (full-band, mjereno loudnorm-om)
 *   output.integrated_lufs  → POSLIJE (loudnorm self-report)
 *   output.true_peak_dbtp   → true peak izlaza
 *
 * Ispisuje before/after statistiku (cross-katalog + per-kanal) i sprema JSON.
 *
 * Usage:
 *   node loudness_before_after.js
 *   node loudness_before_after.js --input-dir storage/output --target -16 --out loudness_before_after.json
 */

const fs = require("fs");
const path = require("path");

function getArg(name, def = null) {
    const i = process.argv.indexOf(name);
    return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const INPUT_DIR = getArg("--input-dir", "storage/output");
const TARGET = parseFloat(getArg("--target", "-16"));
const OUT = getArg("--out", "loudness_before_after.json");

function listChannelDirs(root) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    return entries
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => path.join(root, e.name))
        .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

function collectSidecars(dir) {
    let files;
    try { files = fs.readdirSync(dir); } catch { return []; }
    return files.filter((f) => f.endsWith(".loudnorm.json") && !f.startsWith("._"))
        .map((f) => path.join(dir, f));
}

function stats(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
    return {
        n: s.length,
        min: +s[0].toFixed(2), p10: +q(0.10).toFixed(2), median: +q(0.50).toFixed(2),
        mean: +mean.toFixed(2), p90: +q(0.90).toFixed(2), max: +s[s.length - 1].toFixed(2),
        stddev: +sd.toFixed(2), spread: +(s[s.length - 1] - s[0]).toFixed(2),
    };
}

function distVsTarget(nums) {
    const w1 = nums.filter((v) => Math.abs(v - TARGET) <= 1).length;
    const w2 = nums.filter((v) => Math.abs(v - TARGET) <= 2).length;
    const o3 = nums.filter((v) => Math.abs(v - TARGET) > 3).length;
    const pct = (x) => +(x / nums.length * 100).toFixed(1);
    return { within_1_lu: w1, within_1_pct: pct(w1), within_2_lu: w2, within_2_pct: pct(w2), off_gt_3_lu: o3, off_gt_3_pct: pct(o3) };
}

function histogram(nums, lo, hi, step) {
    const b = [];
    for (let x = lo; x < hi; x += step) b.push({ from: +x.toFixed(1), to: +(x + step).toFixed(1), count: 0 });
    for (const v of nums) {
        let idx = Math.floor((v - lo) / step);
        idx = Math.max(0, Math.min(b.length - 1, idx));
        b[idx].count++;
    }
    return b;
}
function bar(c, max, w = 30) { const n = max ? Math.round(c / max * w) : 0; return "█".repeat(n) + "░".repeat(w - n); }

function main() {
    const recs = [];
    for (const dir of listChannelDirs(INPUT_DIR)) {
        for (const sc of collectSidecars(dir)) {
            let j; try { j = JSON.parse(fs.readFileSync(sc, "utf8")); } catch { continue; }
            const bi = j.input && j.input.integrated_lufs;
            const ai = j.output && j.output.integrated_lufs;
            if (typeof bi !== "number" || typeof ai !== "number") continue;
            if (bi <= -70 || ai <= -70) continue;
            recs.push({ channel: j.channel || path.basename(dir), before: bi, after: ai, after_tp: j.output.true_peak_dbtp });
        }
    }
    if (!recs.length) { console.error("Nema .loudnorm.json sidecara s input/output. Je li normalize_loudness.js pokrenut?"); process.exit(1); }

    const before = recs.map((r) => r.before), after = recs.map((r) => r.after);
    const tp = recs.map((r) => r.after_tp).filter((x) => typeof x === "number");
    const beforeStats = stats(before), afterStats = stats(after);

    // per-kanal
    const byCh = {};
    for (const r of recs) (byCh[r.channel] ||= { before: [], after: [] }), byCh[r.channel].before.push(r.before), byCh[r.channel].after.push(r.after);
    const channels = Object.entries(byCh).map(([ch, d]) => ({
        channel: ch, n: d.before.length,
        before_median: stats(d.before).median, before_spread: stats(d.before).spread,
        after_median: stats(d.after).median, after_spread: stats(d.after).spread,
    })).sort((a, b) => a.before_median - b.before_median);

    const report = {
        generated_at: new Date().toISOString(), target_i_lufs: TARGET, n: recs.length,
        before: { integrated_lufs: beforeStats, distribution_vs_target: distVsTarget(before) },
        after: { integrated_lufs: afterStats, distribution_vs_target: distVsTarget(after), true_peak: stats(tp) },
        per_channel: channels,
    };
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");

    // ── konzolni sažetak ──
    const L = (x) => String(x).padStart(7);
    console.log(`\n=== BEFORE / AFTER normalizacije (${recs.length} epizoda, cilj ${TARGET} LUFS) ===\n`);
    console.log(`Integrated LUFS:`);
    console.log(`            min     p10  median    mean     p90     max  RASPON  stddev`);
    console.log(`  PRIJE  ${L(beforeStats.min)} ${L(beforeStats.p10)} ${L(beforeStats.median)} ${L(beforeStats.mean)} ${L(beforeStats.p90)} ${L(beforeStats.max)} ${L(beforeStats.spread)} ${L(beforeStats.stddev)}`);
    console.log(`  POSLIJE${L(afterStats.min)} ${L(afterStats.p10)} ${L(afterStats.median)} ${L(afterStats.mean)} ${L(afterStats.p90)} ${L(afterStats.max)} ${L(afterStats.spread)} ${L(afterStats.stddev)}`);

    const db = distVsTarget(before), da = distVsTarget(after);
    console.log(`\nUnutar cilja:`);
    console.log(`  PRIJE   ±1 LU: ${db.within_1_pct}%   ±2 LU: ${db.within_2_pct}%   >±3 LU: ${db.off_gt_3_pct}%`);
    console.log(`  POSLIJE ±1 LU: ${da.within_1_pct}%   ±2 LU: ${da.within_2_pct}%   >±3 LU: ${da.off_gt_3_pct}%`);

    if (tp.length) { const t = stats(tp); console.log(`\nTrue peak (poslije): max ${t.max} dBTP · median ${t.median} · min ${t.min}  (cilj ≤ -2; klipanje bi bilo > 0)`); }

    console.log(`\nHistogram PRIJE:`);
    const hb = histogram(before, -45, -5, 2.5), hbmax = Math.max(...hb.map((x) => x.count));
    for (const x of hb) if (x.count) console.log(`  ${String(x.from).padStart(6)}..${String(x.to).padStart(6)}  ${bar(x.count, hbmax)} ${x.count}`);
    console.log(`\nHistogram POSLIJE:`);
    const ha = histogram(after, -45, -5, 2.5), hamax = Math.max(...ha.map((x) => x.count));
    for (const x of ha) if (x.count) console.log(`  ${String(x.from).padStart(6)}..${String(x.to).padStart(6)}  ${bar(x.count, hamax)} ${x.count}`);

    console.log(`\nIzvještaj: ${OUT}`);
}
main();
