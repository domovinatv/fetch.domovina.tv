#!/usr/bin/env node
/**
 * magisterium_mcp_episode.js — HR Magisterium za JEDNU epizodu, end-to-end, BEZ LLM-a.
 *
 * Deterministička zamjena za `claude -p "@docs/MAGISTERIUM_MCP_RUN.md <VID>"`:
 *   1. prep      magisterium_mcp_prep.js (promptovi po sekciji + holistički)
 *   2. chat      tools/magisterium_mcp_client.js run (Magisterium MCP izravno, OAuth Pro)
 *   2b. jezik    odgovor s fragmentima na drugom jeziku (nelatinično pismo, lit./fin. dijakritici)
 *                ili nepotpun/pokvaren JSON (sekcija bez rezultata)
 *                se ponovno pita — isti prompt, do --lang-retries puta; score se ne dira
 *   3. assemble  magisterium_mcp_assemble.js → storage (*.mcp.json nose source_url)
 *   4. publish   with_pipeline_lock.sh + publish_hr_episode.sh (+ force_upload kod --force)
 *   5. verify    CDN GET s Origin headerom, md5 diska == md5 CDN-a
 *
 * Uporaba:
 *   node tools/magisterium_mcp_episode.js --video-id <VID> [--channel <kanal>]
 *        [--force] [--no-publish] [--batch-size 2] [--max-words 600]   (env MAGISTERIUM_BATCH_SIZE)
 * Exit: 0 = objavljeno i md5 se slaže (ili već postoji), 1 = greška, 2 = chat pozivi nisu prošli.
 * Statistika koraka: <results>/episode_stats.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(REPO, 'storage', 'output');
const CDN_BASE = (process.env.CDN_BASE || 'https://cdn.domovina.ai').replace(/\/$/, '');

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

// Croatian koristi č ć đ š ž; svako nelatinično slovo (ćirilica, gruzijsko, grčko…) i
// ą ę ė į ų ū õ ä ö å znače da je model skliznuo u drugi jezik (viđeno 24.10.2026.:
// finski, litavski, ćirilica; 29.10.: gruzijsko „Katolიცizam” usred JSON-a).
const FOREIGN_RE = /[^\P{L}\p{Script=Latin}]|[ąęėįųūõäöåěřůňťďýĺľŕ]/iu;
function foreignFragments(answer) {
    const m = (answer || '').match(new RegExp(FOREIGN_RE.source, 'giu'));
    return m ? m.length : 0;
}

// Sekcijski odgovor mora biti parsabilan JSON s rezultatom za svaki traženi index.
// Pokvaren JSON (29.10.2026., batch od 3) assemble tiho preskoči → sekcija bez ocjene.
function missingResults(answer, wantIndexes) {
    const a = answer || '';
    const s = a.indexOf('{'), e = a.lastIndexOf('}');
    if (s === -1 || e <= s) return wantIndexes.length;
    let j;
    try { j = JSON.parse(a.slice(s, e + 1)); } catch { return wantIndexes.length; }
    const got = new Set((Array.isArray(j.results) ? j.results : []).map(r => r && r.index));
    return wantIndexes.filter(i => !got.has(i)).length;
}

// Kandidati: *_yt_<VID>*.article.json (NE .en./.magisterium.), leksikografski najnoviji.
// Kanali su symlinkovi → isDirectory() || isSymbolicLink(). `_`-direktoriji (npr. _unlisted)
// dolaze tek ako u pravom kanalu nema članka.
function findArticle(videoId, channel, root = OUTPUT_ROOT) {
    const dirs = channel ? [channel] : fs.readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name);
    const hits = [];
    for (const ch of dirs) {
        let files;
        try { files = fs.readdirSync(path.join(root, ch)); } catch { continue; }
        for (const f of files) {
            if (f.startsWith('._') || !f.includes(`_yt_${videoId}`)) continue;
            if (!/\.article\.json$/.test(f) || /\.(en|magisterium)\.article\.json$|\.article\.(en|magisterium)\.json$/.test(f)) continue;
            hits.push({ channel: ch, file: f });
        }
    }
    if (!hits.length) return null;
    const real = hits.filter(h => !h.channel.startsWith('_'));
    const pool = real.length ? real : hits;
    const channels = [...new Set(pool.map(h => h.channel))];
    if (channels.length > 1) throw new Error(`članak u više kanala (${channels.join(', ')}) — zadaj --channel`);
    pool.sort((a, b) => a.file.localeCompare(b.file));
    const best = pool[pool.length - 1];
    return { channel: best.channel, path: path.join(root, best.channel, best.file) };
}

function run(cmd, cmdArgs, opts = {}) {
    const r = spawnSync(cmd, cmdArgs, { cwd: REPO, encoding: 'utf-8', stdio: opts.capture ? 'pipe' : 'inherit', env: { ...process.env, ...(opts.env || {}) } });
    if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
    return r;
}

async function cdnMd5(videoId) {
    const r = await fetch(`${CDN_BASE}/data/${videoId}/article.magisterium.json`, {
        headers: { Origin: 'https://domovina.ai' }, cache: 'no-store',
    });
    if (!r.ok) return { status: r.status, md5: null };
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, md5: crypto.createHash('md5').update(buf).digest('hex') };
}

async function main() {
    const videoId = getArg('--video-id');
    if (!videoId) { console.error('Uporaba: --video-id <VID> [--channel <kanal>] [--force] [--no-publish]'); process.exit(1); }
    const force = args.includes('--force');
    const publish = !args.includes('--no-publish');
    // 2 sekcije po chat pozivu (29.10.2026.): 1,9× brže, ocjene unutar šuma, ~17 % manje citata
    // (chat vraća max 10 referenci po pozivu). 1 = stara kvaliteta citata. Vidi
    // docs/2026-10-29-magisterium-brzina-batch-eksperiment.md
    const batchSize = getArg('--batch-size') || process.env.MAGISTERIUM_BATCH_SIZE || '2';
    const maxWords = getArg('--max-words') || '600';
    const langRetries = parseInt(getArg('--lang-retries') || '2', 10);
    const steps = [];
    const step = async (name, fn) => {
        const t = Date.now();
        console.log(`\n── ${name} ──`);
        const out = await fn();
        steps.push({ step: name, sec: +((Date.now() - t) / 1000).toFixed(1) });
        return out;
    };

    const art = findArticle(videoId, getArg('--channel'));
    if (!art) { console.error(`❌ nema *.article.json za ${videoId} u storage/output`); process.exit(1); }
    const base = path.basename(art.path).replace(/\.article\.json$/, '');
    const outPath = path.join(path.dirname(art.path), `${base}.article.magisterium.json`);
    console.log(`✝️  ${videoId} | kanal ${art.channel}\n   ${path.basename(art.path)}`);

    if (fs.existsSync(outPath) && !force) {
        console.log(`✅ Magisterium već postoji (${path.basename(outPath)}) — ništa ne radim (--force za ponovnu obradu)`);
        return;
    }

    const jobDir = '/tmp/mag_hybrid';
    const jobPath = path.join(jobDir, `${base}.job.json`);
    const resultsDir = path.join(jobDir, `${base}.results`);

    await step('1 prep', () => {
        const r = run('node', ['magisterium_mcp_prep.js', '--article', art.path, '--batch-size', batchSize, '--max-words', maxWords]);
        if (r.status !== 0) throw new Error('prep nije uspio');
    });

    const clientArgs = ['tools/magisterium_mcp_client.js', 'run', '--job', jobPath, '--results-dir', resultsDir];
    await step('2 chat (Magisterium MCP)', () => {
        const r = run('node', force ? [...clientArgs, '--force'] : clientArgs);
        if (r.status !== 0) { console.error('❌ dio chat poziva nije prošao — ponovi isti run (gotovi se preskaču)'); process.exit(2); }
    });

    await step('2b jezik + potpunost', () => {
        const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));
        const wantByName = new Map(job.batches.map(b =>
            [`batch_${String(b.batchIndex).padStart(2, '0')}.mcp.json`, b.sectionRefs.map(r => r.localIndex)]));
        for (let round = 1; round <= langRetries; round++) {
            const bad = fs.readdirSync(resultsDir).filter(f => f.endsWith('.mcp.json')).filter(f => {
                const answer = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf-8')).answer;
                const want = wantByName.get(f);
                return foreignFragments(answer) > 0 || (want && missingResults(answer, want) > 0);
            });
            if (!bad.length) { console.log('   ✅ svi odgovori na hrvatskom i potpuni'); return; }
            console.log(`   ⚠️  strani fragmenti ili nepotpun JSON u: ${bad.join(', ')} — ponovno pitam (krug ${round}/${langRetries})`);
            for (const f of bad) {
                const p = path.join(resultsDir, f);
                fs.renameSync(p, `${p}.lang${round}.bak`);
            }
            const r = run('node', clientArgs);
            if (r.status !== 0) { console.error('❌ ponovljeni chat pozivi nisu prošli'); process.exit(2); }
        }
        console.log('   ⚠️  fragmenti ostali i nakon ponavljanja — objavljujem, ali provjeri ručno');
    });

    await step('3 assemble', () => {
        if (fs.existsSync(outPath)) fs.renameSync(outPath, `${outPath}.${Date.now()}.bak`);  // --force: rename, nikad delete
        const r = run('node', ['magisterium_mcp_assemble.js', '--job', jobPath, '--results-dir', resultsDir, '--out', outPath], { capture: true });
        process.stdout.write(r.stdout);
        if (r.status !== 0 || !fs.existsSync(outPath)) throw new Error(`assemble nije uspio: ${r.stderr}`);
        const m = r.stdout.match(/Sekcija ocijenjeno: (\d+)\/(\d+)/);
        if (!m || m[1] !== m[2]) throw new Error(`nisu sve sekcije ocijenjene (${m ? m[0] : '?'})`);
    });

    let verified = null;
    if (publish) {
        await step('4 publish', () => {
            const r = run(path.join(REPO, 'automatic', 'with_pipeline_lock.sh'),
                ['bash', 'publish_hr_episode.sh', '--', videoId], { env: { CH: art.channel } });
            if (r.status === 75) throw new Error('pipeline lock nije dobiven — HR rezultat ostaje na disku');
            if (r.status !== 0) throw new Error(`publish_hr_episode.sh izašao s ${r.status}`);
            // immutable ključ: kod ponovne obrade publish preskoči postojeći → prepiši + purge
            if (force) run('node', ['force_upload.js', '--video-id', videoId, '--channel', art.channel, '--targets', 'magisterium']);
        });
        verified = await step('5 CDN md5', async () => {
            const local = crypto.createHash('md5').update(fs.readFileSync(outPath)).digest('hex');
            const cdn = await cdnMd5(videoId);
            console.log(`   disk ${local} | CDN ${cdn.md5 || '-'} (HTTP ${cdn.status})`);
            return cdn.md5 === local;
        });
    }

    const stats = { video_id: videoId, channel: art.channel, steps, verified, at: new Date().toISOString() };
    fs.writeFileSync(path.join(resultsDir, 'episode_stats.json'), JSON.stringify(stats, null, 1));
    console.log(`\n📊 ${steps.map(s => `${s.step}: ${s.sec} s`).join(' | ')}`);
    if (publish && !verified) { console.error('❌ md5 na CDN-u se ne slaže s diskom'); process.exit(1); }
    console.log(publish ? '✅ objavljeno, md5 OK' : '✅ gotovo (bez objave)');
}

if (require.main === module) {
    main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
}

module.exports = { foreignFragments, missingResults, findArticle };
