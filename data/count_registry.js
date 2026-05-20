#!/usr/bin/env node

/**
 * count_registry.js
 *
 * Funnel/pool statistika za `data/podcasts_registry.json`.
 * Slijedi 3-layer model:
 *   1. Registry (ukupno poznatih)
 *   2. tracking.enabled=true (editorial intent)
 *   3. U `automatic/refresh_podcasts.sh` (stvarno se povlaci)
 *
 * Usage:
 *   node data/count_registry.js
 *   node data/count_registry.js --list-ready    # samo tracked-but-not-in-pipeline
 *   node data/count_registry.js --list-stubs    # samo entries kojima fali research
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, 'podcasts_registry.json');
const REFRESH_SH_PATH = path.join(__dirname, '..', 'automatic', 'refresh_podcasts.sh');

const args = process.argv.slice(2);
const LIST_READY = args.includes('--list-ready');
const LIST_STUBS = args.includes('--list-stubs');

// --- Helpers (matching count_progress.js style) ---

function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

const BAR_WIDTH = 20;

function progressBar(count, base) {
    const ratio = base > 0 ? Math.min(count / base, 1) : 0;
    const pct = (ratio * 100).toFixed(1);
    const filled = Math.round(ratio * BAR_WIDTH);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    return { bar, pct };
}

function line(label, count, base, opts = {}) {
    const { bar, pct } = progressBar(count, base);
    const extra = opts.extra ? ` (${opts.extra})` : '';
    console.log(
        `    ${pad(label, 36)} ${bar} ${rpad(pct + '%', 7)} ${rpad(count, 4)}/${base}${extra}`
    );
}

// --- Parse refresh_podcasts.sh KANALI array ---

function parseKanaliSlugs() {
    if (!fs.existsSync(REFRESH_SH_PATH)) return new Set();
    const content = fs.readFileSync(REFRESH_SH_PATH, 'utf8');
    const slugs = new Set();
    for (const line of content.split('\n')) {
        const m = line.match(/^\s*"([a-z0-9-]+)\|http/);
        if (m) slugs.add(m[1]);
    }
    return slugs;
}

// --- Load ---

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const pipelineSlugs = parseKanaliSlugs();
const podcasts = registry.podcasts || registry.entries || [];

// --- Compute funnel ---

const tracked = podcasts.filter(p => p.tracking?.enabled === true);
const inPipeline = podcasts.filter(p => pipelineSlugs.has(p.slug));
const umbrellas = podcasts.filter(p => p.youtube?.type === 'umbrella');
const rejected = podcasts.filter(p => p.status === 'rejected' || p.tracking?.rejected === true);
const realPool = podcasts.length - umbrellas.length - rejected.length;

// Pipeline slugs not in registry — sanity check
const orphanPipeline = [...pipelineSlugs].filter(s => !podcasts.find(p => p.slug === s));

// --- Action lists ---

// "Ready to promote": tracking.enabled=true ali NIJE u pipelineu
const readyToPromote = podcasts
    .filter(p => p.tracking?.enabled === true && !pipelineSlugs.has(p.slug))
    .sort((a, b) => (b.quality_score?.total || 0) - (a.quality_score?.total || 0));

// "Stubs": NEMA URL — kriticno, ne moze ni u pipeline
function isStub(p) {
    if (p.youtube?.type === 'umbrella') return false;  // umbrellas su namjerno bez URL-a
    if (rejected.includes(p)) return false;
    return !p.youtube?.url;
}
const stubs = podcasts.filter(isStub).sort((a, b) =>
    (b.quality_score?.total || 0) - (a.quality_score?.total || 0)
);

// "Research-gap": ima URL (moze u pipeline) ali fali voditelji ili je single-source
function hasResearchGap(p) {
    if (p.youtube?.type === 'umbrella') return false;
    if (rejected.includes(p)) return false;
    if (!p.youtube?.url) return false;  // stubs su zasebna kategorija
    const noVoditelji = !(p.voditelji?.length);
    const singleSource = (p.sources?.length || 0) <= 1;
    return noVoditelji || singleSource;
}
const researchGap = podcasts.filter(hasResearchGap).sort((a, b) =>
    (b.quality_score?.total || 0) - (a.quality_score?.total || 0)
);

// "Well-researched": ima URL + voditelje + 2+ izvora + verified
const wellResearched = podcasts.filter(p =>
    p.youtube?.type !== 'umbrella' &&
    p.youtube?.url &&
    (p.sources?.length || 0) >= 2 &&
    (p.voditelji?.length || 0) >= 1 &&
    p.data_quality === 'verified'
);

// --- Single-purpose modes ---

if (LIST_READY) {
    console.log(`\n  Ready to promote (tracking.enabled=true ali NIJE u refresh_podcasts.sh)\n`);
    console.log(`    ${pad('slug', 36)} ${rpad('score', 5)} ${rpad('tier', 4)} ${rpad('ep', 4)} ${pad('url', 50)}`);
    console.log(`    ${'-'.repeat(36)} ${'-'.repeat(5)} ${'-'.repeat(4)} ${'-'.repeat(4)} ${'-'.repeat(50)}`);
    for (const p of readyToPromote) {
        const score = p.quality_score?.total || 0;
        const ep = p.metadata?.episodes_estimate || '—';
        const url = (p.youtube?.url || '').replace(/^https:\/\/www\.youtube\.com/, 'yt');
        console.log(`    ${pad(p.slug, 36)} ${rpad(score, 5)} ${rpad('T' + p.tier, 4)} ${rpad(ep, 4)} ${pad(url, 50)}`);
    }
    console.log(`\n    Total: ${readyToPromote.length} ready to promote\n`);
    process.exit(0);
}

if (LIST_STUBS) {
    console.log(`\n  Stubs (NEMA YouTube URL — ne moze ni u pipeline dok se ne pronade)\n`);
    console.log(`    ${pad('slug', 36)} ${rpad('score', 5)} ${rpad('src', 3)} ${pad('display_name', 40)}`);
    console.log(`    ${'-'.repeat(36)} ${'-'.repeat(5)} ${'-'.repeat(3)} ${'-'.repeat(40)}`);
    for (const p of stubs) {
        const score = p.quality_score?.total || 0;
        const srcCount = p.sources?.length || 0;
        console.log(`    ${pad(p.slug, 36)} ${rpad(score, 5)} ${rpad(srcCount, 3)} ${pad((p.display_name || '').slice(0, 40), 40)}`);
    }
    console.log(`\n    Total: ${stubs.length} stubs bez URL-a\n`);
    process.exit(0);
}

// --- Main output ---

console.log(`\n  Registry funnel (${registry.version || '?'}, generated ${registry.generated_at || '?'})\n`);

console.log('    -- 3-layer funnel --');
line('Registry total entries', podcasts.length, podcasts.length);
line('  − umbrella (not-trackable)', umbrellas.length, podcasts.length);
line('  − rejected', rejected.length, podcasts.length);
line('Real pool (trackable entries)', realPool, podcasts.length);
line('tracking.enabled=true', tracked.length, realPool, { extra: 'editorial intent' });
line('U refresh_podcasts.sh (live)', inPipeline.length, tracked.length, { extra: 'aktivno se povlaci' });

if (orphanPipeline.length > 0) {
    console.log(`\n    ⚠️  Slugovi u refresh_podcasts.sh kojih NEMA u registry-ju (${orphanPipeline.length}):`);
    for (const s of orphanPipeline) console.log(`       - ${s}`);
}

// --- Data quality ---

console.log('\n    -- Data quality (research completeness) --');
const verified = podcasts.filter(p => p.data_quality === 'verified').length;
const partial = podcasts.filter(p => p.data_quality === 'partial').length;
const unverified = podcasts.filter(p => p.data_quality === 'unverified').length;
const withUrl = podcasts.filter(p => p.youtube?.url).length;
const withVoditelji = podcasts.filter(p => p.voditelji?.length > 0).length;
const multiSource = podcasts.filter(p => (p.sources?.length || 0) >= 2).length;

line('Verified (full metadata)', verified, podcasts.length);
line('Partial', partial, podcasts.length);
line('Unverified', unverified, podcasts.length);
line('Has YouTube URL', withUrl, podcasts.length);
line('Has voditelji', withVoditelji, podcasts.length);
line('2+ research izvora', multiSource, podcasts.length);
line('Well-researched (composite)', wellResearched.length, podcasts.length, { extra: 'url+voditelji+src≥2+verified' });
line('Research-gap (ima URL, fali ostalo)', researchGap.length, podcasts.length, { extra: 'pipeline-ready ali nepotpuno' });
line('Stubs (nema URL, blocker)', stubs.length, podcasts.length, { extra: 'ne moze ni u pipeline' });

// --- Tier distribution ---

console.log('\n    -- Tier distribucija --');
const tierCounts = {};
for (const p of podcasts) {
    const t = p.tier == null ? '—' : `T${p.tier}`;
    tierCounts[t] = (tierCounts[t] || 0) + 1;
}
for (const t of ['T1', 'T2', 'T3', 'T4', '—'].filter(t => tierCounts[t])) {
    line(`Tier ${t.replace('T', '')}`, tierCounts[t], podcasts.length);
}

// --- Quality score buckets ---

console.log('\n    -- Quality score raspodjela --');
const buckets = { '🌟 elite (80+)': 0, '✅ strong (60-79)': 0, '👀 moderate (40-59)': 0, '📦 weak (20-39)': 0, '❌ very-low (<20)': 0 };
for (const p of podcasts) {
    const s = p.quality_score?.total || 0;
    if (s >= 80) buckets['🌟 elite (80+)']++;
    else if (s >= 60) buckets['✅ strong (60-79)']++;
    else if (s >= 40) buckets['👀 moderate (40-59)']++;
    else if (s >= 20) buckets['📦 weak (20-39)']++;
    else buckets['❌ very-low (<20)']++;
}
for (const [label, count] of Object.entries(buckets)) {
    if (count > 0) line(label, count, podcasts.length);
}

// --- Top tags ---

console.log('\n    -- Top 10 tagova --');
const tagCounts = {};
for (const p of podcasts) {
    for (const t of p.tags || []) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
}
const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
for (const [tag, count] of topTags) {
    line(tag, count, podcasts.length);
}

// --- Source distribution (where the data came from) ---

console.log('\n    -- Po izvoru research-a --');
const sourceCounts = {};
for (const p of podcasts) {
    for (const s of p.sources || []) {
        sourceCounts[s] = (sourceCounts[s] || 0) + 1;
    }
}
for (const [src, count] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])) {
    line(src, count, podcasts.length);
}

// --- Status distribution ---

console.log('\n    -- Aktivnost (metadata.status) --');
const statusCounts = {};
for (const p of podcasts) {
    const s = p.metadata?.status || '—';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
}
for (const [status, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    line(status, count, podcasts.length);
}

// --- Action items ---

console.log('\n    -- Action items --');
console.log(`    Ready to promote (tracked ali nije u pipelineu):  ${readyToPromote.length}`);
if (readyToPromote.length > 0) {
    console.log(`       └─ vidi: node data/count_registry.js --list-ready`);
    const top5 = readyToPromote.slice(0, 5);
    for (const p of top5) {
        const score = p.quality_score?.total || 0;
        const ep = p.metadata?.episodes_estimate || '?';
        console.log(`       ${rpad(score, 3)}  ${pad(p.slug, 36)}  ${ep} ep`);
    }
    if (readyToPromote.length > 5) {
        console.log(`       ... + ${readyToPromote.length - 5} jos`);
    }
}

console.log(`\n    Stubs bez URL-a (blocker za pipeline):            ${stubs.length}`);
if (stubs.length > 0) {
    console.log(`       └─ vidi: node data/count_registry.js --list-stubs`);
}

console.log(`    Research-gap (ima URL, fali voditelji/sources):   ${researchGap.length}`);

console.log();
