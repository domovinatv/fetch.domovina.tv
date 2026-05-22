#!/usr/bin/env node

/**
 * dashboard/server.js
 *
 * Lokalni HTTP server (bez vanjskih dependencija) koji izlaže:
 *   GET /                    -> dashboard/index.html
 *   GET /api/registry        -> JSON s registry funnelom (port count_registry.js logike)
 *   GET /api/pipeline        -> JSON s file-scan progresom (port count_progress.js logike)
 *   GET /api/disk-usage      -> JSON s du -skL po kanalu (lazy, sporo)
 *
 * Pokretanje:
 *   node dashboard/server.js
 *   node dashboard/server.js --port 8787 --input-dir storage/output
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);

function getArg(name, fallback) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const PORT = parseInt(getArg('--port', '8787'), 10);
const SNAPSHOT_OUT = getArg('--snapshot', null);  // ako je postavljen → one-shot mod, piše registry.json i izlazi
const REGISTRY_PATH = path.join(ROOT, 'data', 'podcasts_registry.json');
const REFRESH_SH_PATH = path.join(ROOT, 'automatic', 'refresh_podcasts.sh');
const LISTA_DIR = path.join(ROOT, 'automatic', 'podcasts');
const OUTPUT_DIR = path.resolve(ROOT, getArg('--input-dir', 'storage/output'));

// ============================================================================
// REGISTRY — port logike iz data/count_registry.js
// ============================================================================

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

function computeRegistry() {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    const pipelineSlugs = parseKanaliSlugs();
    const podcasts = registry.podcasts || registry.entries || [];

    const tracked = podcasts.filter(p => p.tracking?.enabled === true);
    const inPipeline = podcasts.filter(p => pipelineSlugs.has(p.slug));
    const umbrellas = podcasts.filter(p => p.youtube?.type === 'umbrella');
    const rejected = podcasts.filter(p => p.status === 'rejected' || p.tracking?.rejected === true);
    const realPool = podcasts.length - umbrellas.length - rejected.length;
    const orphanPipeline = [...pipelineSlugs].filter(s => !podcasts.find(p => p.slug === s));

    const isStub = (p) => {
        if (p.youtube?.type === 'umbrella') return false;
        if (rejected.includes(p)) return false;
        return !p.youtube?.url;
    };

    const hasResearchGap = (p) => {
        if (p.youtube?.type === 'umbrella') return false;
        if (rejected.includes(p)) return false;
        if (!p.youtube?.url) return false;
        const noVoditelji = !(p.voditelji?.length);
        const singleSource = (p.sources?.length || 0) <= 1;
        return noVoditelji || singleSource;
    };

    const wellResearched = podcasts.filter(p =>
        p.youtube?.type !== 'umbrella' &&
        p.youtube?.url &&
        (p.sources?.length || 0) >= 2 &&
        (p.voditelji?.length || 0) >= 1 &&
        p.data_quality === 'verified'
    );

    const readyToPromote = podcasts
        .filter(p => p.tracking?.enabled === true && !pipelineSlugs.has(p.slug))
        .sort((a, b) => (b.quality_score?.total || 0) - (a.quality_score?.total || 0));

    const stubs = podcasts.filter(isStub)
        .sort((a, b) => (b.quality_score?.total || 0) - (a.quality_score?.total || 0));

    const researchGap = podcasts.filter(hasResearchGap)
        .sort((a, b) => (b.quality_score?.total || 0) - (a.quality_score?.total || 0));

    // Distribucije
    const tierCounts = {};
    for (const p of podcasts) {
        const t = p.tier == null ? '—' : `T${p.tier}`;
        tierCounts[t] = (tierCounts[t] || 0) + 1;
    }

    const buckets = { elite: 0, strong: 0, moderate: 0, weak: 0, very_low: 0 };
    for (const p of podcasts) {
        const s = p.quality_score?.total || 0;
        if (s >= 80) buckets.elite++;
        else if (s >= 60) buckets.strong++;
        else if (s >= 40) buckets.moderate++;
        else if (s >= 20) buckets.weak++;
        else buckets.very_low++;
    }

    const tagCounts = {};
    for (const p of podcasts) {
        for (const t of p.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);

    const sourceCounts = {};
    for (const p of podcasts) {
        for (const s of p.sources || []) sourceCounts[s] = (sourceCounts[s] || 0) + 1;
    }
    const sourceDistribution = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]);

    const statusCounts = {};
    for (const p of podcasts) {
        const s = p.metadata?.status || '—';
        statusCounts[s] = (statusCounts[s] || 0) + 1;
    }
    const statusDistribution = Object.entries(statusCounts).sort((a, b) => b[1] - a[1]);

    // Compact entries za UI tablicu (sve, klijent filtrira)
    const entries = podcasts.map(p => {
        const inPipeline = pipelineSlugs.has(p.slug);
        return {
            slug: p.slug,
            display_name: p.display_name,
            tier: p.tier,
            score: p.quality_score?.total || 0,
            score_tier: p.quality_score?.tier || '',
            data_quality: p.data_quality,
            tracked: p.tracking?.enabled === true,
            in_pipeline: inPipeline,
            has_url: !!p.youtube?.url,
            type: p.youtube?.type || 'channel',
            url: p.youtube?.url || '',
            // Front-end app URL: postoji samo za entries koji su zaista u pipelineu
            // (domovina.ai slug mapping = registry slug, 1:1, oba s hyphens).
            domovina_url: inPipeline ? `https://www.domovina.ai/c/${p.slug}` : null,
            episodes: p.metadata?.episodes_estimate ?? null,
            status: p.metadata?.status || '',
            sources_count: (p.sources || []).length,
            voditelji_count: (p.voditelji || []).length,
            tags: p.tags || [],
            notes: p.notes || '',
        };
    });

    return {
        version: registry.version || null,
        generated_at: registry.generated_at || null,
        funnel: {
            total: podcasts.length,
            umbrellas: umbrellas.length,
            rejected: rejected.length,
            real_pool: realPool,
            tracked: tracked.length,
            in_pipeline: inPipeline.length,
            orphan_pipeline: orphanPipeline,
        },
        data_quality: {
            verified: podcasts.filter(p => p.data_quality === 'verified').length,
            partial: podcasts.filter(p => p.data_quality === 'partial').length,
            unverified: podcasts.filter(p => p.data_quality === 'unverified').length,
            with_url: podcasts.filter(p => p.youtube?.url).length,
            with_voditelji: podcasts.filter(p => p.voditelji?.length > 0).length,
            multi_source: podcasts.filter(p => (p.sources?.length || 0) >= 2).length,
            well_researched: wellResearched.length,
            research_gap: researchGap.length,
            stubs: stubs.length,
        },
        tier_distribution: tierCounts,
        quality_buckets: buckets,
        top_tags: topTags,
        source_distribution: sourceDistribution,
        status_distribution: statusDistribution,
        ready_to_promote: readyToPromote.map(p => ({
            slug: p.slug,
            display_name: p.display_name,
            score: p.quality_score?.total || 0,
            tier: p.tier,
            episodes: p.metadata?.episodes_estimate ?? null,
            url: p.youtube?.url || '',
        })),
        stubs_list: stubs.map(p => ({
            slug: p.slug,
            display_name: p.display_name,
            score: p.quality_score?.total || 0,
            sources_count: (p.sources || []).length,
        })),
        research_gap_count: researchGap.length,
        entries,
    };
}

// ============================================================================
// PIPELINE — port logike iz count_progress.js
// ============================================================================

const matchers = [
    ['_whisper_prompt.txt', 'prompts'],
    ['.canary.summary.blocked.json', 'summaryBlocked'],
    ['.canary.diarized.blocked.json', 'articleBlocked'],
    ['.canary.diarized.srt', 'canaryDiarized'],
    ['.canary.summary.json', 'summary'],
    ['.canary.srt', 'canarySrt'],
    ['.canary.csv', 'canaryCsv'],
    ['.sortformer.diarized.srt', 'sortformerDiarized'],
    ['.sortformer.srt', 'sortformerSrt'],
    ['.sortformer.csv', 'sortformerCsv'],
    ['.diarized.srt', 'diarized'],
    ['.wav.srt', 'srt'],
    ['.info.json', 'infoJson'],
    ['.description', 'description'],
    ['.outline.json', 'outline'],
    ['.article.magisterium.json', 'magisterium'],
    ['.article.json', 'article'],
    ['.rag_chunks.jsonl', 'ragChunks'],
    ['.rag_import.jsonl', 'ragImport'],
    ['.rag_combined.jsonl', 'ragCombined'],
    ['.mp3', 'mp3'],
    ['.wav', 'wav'],
    ['.mkv', 'mkv'],
    ['.mp4', 'mp4Final'],
];
const INTERMEDIATE_MP4_RE = /\.f\d+\.mp4$/;
const EMBEDDING_RE = /^(.+)\.(canary|sortformer)\.diarized\.embeddings\.(.+)\.json$/;

function classify(filename) {
    if (INTERMEDIATE_MP4_RE.test(filename)) return null;
    for (const [suffix, key] of matchers) {
        if (filename.endsWith(suffix)) return key;
    }
    return null;
}

function countTotalListaEntries() {
    if (!fs.existsSync(LISTA_DIR)) return 0;
    let total = 0;
    for (const f of fs.readdirSync(LISTA_DIR)) {
        if (!f.endsWith('-lista.txt')) continue;
        try {
            const content = fs.readFileSync(path.join(LISTA_DIR, f), 'utf8');
            for (const line of content.split('\n')) {
                const t = line.trim();
                if (t && !t.startsWith('#')) total++;
            }
        } catch { /* skip */ }
    }
    return total;
}

function computePipeline() {
    if (!fs.existsSync(OUTPUT_DIR)) {
        return { error: `Output direktorij ne postoji: ${OUTPUT_DIR}` };
    }

    const stats = {};
    const outlinesByModel = {};
    const articlesByModel = {};
    const outlineVideosByModel = {};
    const articleVideosByModel = {};
    const embeddingsByModel = { canary: {}, sortformer: {} };
    const embeddingVideosByModel = { canary: {}, sortformer: {} };
    const embeddingVideosBySource = { canary: new Set(), sortformer: new Set() };
    const blockedReasons = { summary: {}, article: {} };
    const blockedPermanent = { summary: 0, article: 0 };

    // Symlinks — koristi statSync (slijedi symlink). count_progress.js gotcha.
    const channels = fs.readdirSync(OUTPUT_DIR).filter(f => {
        try {
            const stat = fs.statSync(path.join(OUTPUT_DIR, f));
            return stat.isDirectory() && !f.startsWith('.');
        } catch { return false; }
    });

    let totalOutlineVideos = 0;
    let totalArticleVideos = 0;
    let totalMagisteriumVideos = 0;
    let totalMkvRemuxed = 0;
    let totalMkvWaiting = 0;

    for (const channel of channels) {
        const channelPath = path.join(OUTPUT_DIR, channel);
        try {
            const files = fs.readdirSync(channelPath);
            const videosWithOutline = new Set();
            const videosWithArticle = new Set();
            const videosWithMagisterium = new Set();
            const videosWithMkv = new Set();
            const videosWithMp4 = new Set();

            for (const file of files) {
                if (file.startsWith('._')) continue;

                if (file.endsWith('_screenshots')) {
                    const ssPath = path.join(channelPath, file);
                    try {
                        if (fs.statSync(ssPath).isDirectory()) {
                            if (fs.existsSync(path.join(ssPath, '_manifest.json'))) {
                                stats.screenshots = (stats.screenshots || 0) + 1;
                            }
                            for (const inner of fs.readdirSync(ssPath)) {
                                if (inner.startsWith('._')) continue;
                                if (inner.endsWith('.png')) {
                                    stats.screenshotPng = (stats.screenshotPng || 0) + 1;
                                }
                            }
                        }
                    } catch { /* skip */ }
                    continue;
                }

                const key = classify(file);
                if (key) {
                    stats[key] = (stats[key] || 0) + 1;
                    if (key === 'summaryBlocked' || key === 'articleBlocked') {
                        try {
                            const content = JSON.parse(fs.readFileSync(path.join(channelPath, file), 'utf-8'));
                            const reason = content.reason || 'UNKNOWN';
                            const type = (key === 'summaryBlocked') ? 'summary' : 'article';
                            blockedReasons[type][reason] = (blockedReasons[type][reason] || 0) + 1;
                            if ((content.retry_count || 0) >= 3) blockedPermanent[type]++;
                        } catch { /* parse fail */ }
                    }
                }

                if (key === 'outline') {
                    const base = file.replace(/\.wav\.canary\.diarized_.*\.outline\.json$/, '');
                    videosWithOutline.add(base);
                    const m = file.match(/\.wav\.canary\.diarized_\d{4}-\d{2}-\d{2}_(.+)\.outline\.json$/);
                    if (m) {
                        outlinesByModel[m[1]] = (outlinesByModel[m[1]] || 0) + 1;
                        if (!outlineVideosByModel[m[1]]) outlineVideosByModel[m[1]] = new Set();
                        outlineVideosByModel[m[1]].add(base);
                    }
                } else if (key === 'article') {
                    const base = file.replace(/\.wav\.canary\.diarized_.*\.article\.json$/, '');
                    videosWithArticle.add(base);
                    const m = file.match(/\.wav\.canary\.diarized_\d{4}-\d{2}-\d{2}_(.+)\.article\.json$/);
                    if (m) {
                        articlesByModel[m[1]] = (articlesByModel[m[1]] || 0) + 1;
                        if (!articleVideosByModel[m[1]]) articleVideosByModel[m[1]] = new Set();
                        articleVideosByModel[m[1]].add(base);
                    }
                } else if (key === 'magisterium') {
                    const base = file.replace(/\.wav\.canary\.diarized_.*\.article\.magisterium\.json$/, '');
                    videosWithMagisterium.add(base);
                } else if (key === 'mkv') {
                    videosWithMkv.add(file.slice(0, -4));
                } else if (key === 'mp4Final') {
                    videosWithMp4.add(file.slice(0, -4));
                }

                const embMatch = file.match(EMBEDDING_RE);
                if (embMatch) {
                    const [, base, source, model] = embMatch;
                    embeddingVideosBySource[source].add(base);
                    embeddingsByModel[source][model] = (embeddingsByModel[source][model] || 0) + 1;
                    if (!embeddingVideosByModel[source][model]) embeddingVideosByModel[source][model] = new Set();
                    embeddingVideosByModel[source][model].add(base);
                }
            }

            totalOutlineVideos += videosWithOutline.size;
            totalArticleVideos += videosWithArticle.size;
            totalMagisteriumVideos += videosWithMagisterium.size;
            for (const base of videosWithMkv) {
                if (videosWithMp4.has(base)) totalMkvRemuxed++;
                else totalMkvWaiting++;
            }
        } catch (e) {
            // skip unreadable channel
        }
    }

    const g = (k) => stats[k] || 0;
    const listaTotal = countTotalListaEntries();
    const mp3Count = g('mp3');
    const total = listaTotal || mp3Count;
    const backlog = listaTotal ? listaTotal - mp3Count : 0;

    // Embedding setovi → counts
    const embCanaryVideosByModel = {};
    for (const [m, set] of Object.entries(embeddingVideosByModel.canary)) {
        embCanaryVideosByModel[m] = set.size;
    }
    const embSortformerVideosByModel = {};
    for (const [m, set] of Object.entries(embeddingVideosByModel.sortformer)) {
        embSortformerVideosByModel[m] = set.size;
    }

    const outlineModels = {};
    for (const m of Object.keys(outlinesByModel)) {
        outlineModels[m] = { files: outlinesByModel[m], videos: outlineVideosByModel[m]?.size || 0 };
    }
    const articleModels = {};
    for (const m of Object.keys(articlesByModel)) {
        articleModels[m] = { files: articlesByModel[m], videos: articleVideosByModel[m]?.size || 0 };
    }

    return {
        channels,
        total_base: total,
        lista_total: listaTotal,
        mp3_count: mp3Count,
        backlog,
        downloads: {
            mp3: g('mp3'),
            wav: g('wav'),
            mkv: g('mkv'),
            info_json: g('infoJson'),
            description: g('description'),
        },
        whisper: {
            prompts: g('prompts'),
            srt: g('srt'),
            diarized: g('diarized'),
        },
        canary: {
            srt: g('canarySrt'),
            csv: g('canaryCsv'),
            diarized: g('canaryDiarized'),
        },
        sortformer: {
            srt: g('sortformerSrt'),
            csv: g('sortformerCsv'),
            diarized: g('sortformerDiarized'),
        },
        embeddings: {
            canary: {
                videos: embeddingVideosBySource.canary.size,
                diarized_total: g('canaryDiarized'),
                files_by_model: embeddingsByModel.canary,
                videos_by_model: embCanaryVideosByModel,
            },
            sortformer: {
                videos: embeddingVideosBySource.sortformer.size,
                diarized_total: g('sortformerDiarized'),
                files_by_model: embeddingsByModel.sortformer,
                videos_by_model: embSortformerVideosByModel,
            },
        },
        gemini: {
            summary: g('summary'),
            summary_blocked: {
                total: g('summaryBlocked'),
                reasons: blockedReasons.summary,
                permanent: blockedPermanent.summary,
            },
            outline_videos: totalOutlineVideos,
            outline_files: g('outline'),
            outline_models: outlineModels,
            article_videos: totalArticleVideos,
            article_files: g('article'),
            article_models: articleModels,
            article_blocked: {
                total: g('articleBlocked'),
                reasons: blockedReasons.article,
                permanent: blockedPermanent.article,
            },
            magisterium_videos: totalMagisteriumVideos,
            magisterium_files: g('magisterium'),
        },
        rag: {
            chunks: g('ragChunks'),
            import: g('ragImport'),
            combined: g('ragCombined'),
        },
        publish: {
            screenshots: g('screenshots'),
            screenshot_png: g('screenshotPng'),
            mp4: g('mp4Final'),
            mkv_total: g('mkv'),
            mkv_remuxed: totalMkvRemuxed,
            mkv_waiting: totalMkvWaiting,
        },
    };
}

function computeDiskUsage() {
    if (!fs.existsSync(OUTPUT_DIR)) return { error: `Output direktorij ne postoji: ${OUTPUT_DIR}` };

    const channels = fs.readdirSync(OUTPUT_DIR).filter(f => {
        try {
            const stat = fs.statSync(path.join(OUTPUT_DIR, f));
            return stat.isDirectory() && !f.startsWith('.');
        } catch { return false; }
    });

    const diskUsage = [];
    for (const channel of channels) {
        const channelPath = path.join(OUTPUT_DIR, channel);
        try {
            const raw = execSync(`du -skL "${channelPath}"`, { encoding: 'utf-8' });
            const kb = parseInt(raw.split('\t')[0], 10);
            let realPath = channelPath;
            try { realPath = fs.realpathSync(channelPath); } catch { /* ignore */ }
            const volume = realPath.split('/').slice(0, 3).join('/');
            diskUsage.push({ channel, kb, volume });
        } catch {
            diskUsage.push({ channel, kb: 0, volume: '?' });
        }
    }
    diskUsage.sort((a, b) => b.kb - a.kb);

    const volumes = {};
    for (const { kb, volume } of diskUsage) {
        volumes[volume] = (volumes[volume] || 0) + kb;
    }

    return {
        channels: diskUsage,
        volumes: Object.entries(volumes).sort((a, b) => b[1] - a[1]).map(([v, kb]) => ({ volume: v, kb })),
        total_kb: diskUsage.reduce((s, d) => s + d.kb, 0),
    };
}

// ============================================================================
// HTTP
// ============================================================================

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function serveStatic(res, filePath) {
    if (!fs.existsSync(filePath)) {
        res.writeHead(404); res.end('not found'); return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
}

// ============================================================================
// Snapshot mode (one-shot, za CF Pages deploy)
// ============================================================================

if (SNAPSHOT_OUT) {
    const t0 = Date.now();
    const data = computeRegistry();
    data._snapshot_at = new Date().toISOString();
    data._took_ms = Date.now() - t0;
    const outPath = path.resolve(SNAPSHOT_OUT);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data));
    console.log(`✓ Snapshot zapisan: ${outPath}`);
    console.log(`  ${data.entries.length} entries, ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`);
    process.exit(0);
}

const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/' || url === '/index.html') {
            return serveStatic(res, path.join(__dirname, 'index.html'));
        }
        if (url === '/api/registry') {
            const t0 = Date.now();
            const data = computeRegistry();
            data._took_ms = Date.now() - t0;
            return sendJson(res, 200, data);
        }
        if (url === '/api/pipeline') {
            const t0 = Date.now();
            const data = computePipeline();
            data._took_ms = Date.now() - t0;
            return sendJson(res, 200, data);
        }
        if (url === '/api/disk-usage') {
            const t0 = Date.now();
            const data = computeDiskUsage();
            data._took_ms = Date.now() - t0;
            return sendJson(res, 200, data);
        }
        res.writeHead(404); res.end('not found');
    } catch (e) {
        sendJson(res, 500, { error: e.message, stack: e.stack });
    }
});

server.listen(PORT, () => {
    console.log(`\n  DOMOVINA Dashboard:  http://localhost:${PORT}\n`);
    console.log(`  Registry:            ${REGISTRY_PATH}`);
    console.log(`  Output dir:          ${OUTPUT_DIR}`);
    console.log(`  Refresh script:      ${REFRESH_SH_PATH}\n`);
});
