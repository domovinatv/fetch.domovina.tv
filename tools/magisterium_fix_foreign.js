#!/usr/bin/env node
/**
 * magisterium_fix_foreign.js — popravak objavljenog HR Magisteriuma u kojem je model
 * skliznuo u drugi jezik (armenski, gruzijski, češki… usred hrvatske rečenice).
 *
 * Ponovno pita SAMO pogođene sekcije (i holistički dio ako je on pogođen), istim promptom
 * kao produkcija (batch-size iz postojeće datoteke), ubaci nove odgovore u postojeći
 * article.magisterium.json i preračuna prosjeke. Ostale sekcije ostaju netaknute.
 * Stara datoteka se preimenuje u *.bak.<ts> (nikad delete).
 *
 *   node tools/magisterium_fix_foreign.js --video-id <VID> [--channel <kanal>] [--dry-run]
 *
 * Objava ide zasebno (immutable ključ): force_upload.js --targets magisterium, a ako postoji
 * EN overlay, on je preveden iz pokvarenog HR-a pa ga treba ponovno prevesti.
 * Audit kandidata: node experiments/2026-10-29-magisterium-brze/audit_strani_jezik.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { foreignFragments, missingResults, findArticle } = require('./magisterium_mcp_episode.js');

const REPO = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

function scoreInterpretation(score) {
    if (score >= 90) return 'Aktivno promiče katolički nauk';
    if (score >= 70) return 'Uglavnom usklađeno';
    if (score >= 50) return 'Djelomično usklađeno, nejasnoće';
    if (score >= 30) return 'Odstupanje od crkvenog nauka';
    return 'Proturječi katoličkom nauku ili Pismu';
}

const magTexts = m => m ? [m.assessment, m.enrichment, ...(m.concerns || [])] : [];
const overallTexts = o => o ? [o.assessment, o.theological_context, ...(o.seeds_of_logos || []), ...(o.concerns || [])] : [];
const isForeign = texts => texts.some(t => foreignFragments(t) > 0);

function run(cmd, cmdArgs) {
    const r = spawnSync(cmd, cmdArgs, { cwd: REPO, encoding: 'utf-8', stdio: 'inherit' });
    if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
    return r.status;
}

function main() {
    const videoId = getArg('--video-id');
    if (!videoId) { console.error('Uporaba: --video-id <VID> [--channel <kanal>] [--dry-run]'); process.exit(1); }
    const art = findArticle(videoId, getArg('--channel'));
    if (!art) throw new Error(`nema članka za ${videoId}`);
    const magPath = art.path.replace(/\.article\.json$/, '.article.magisterium.json');
    if (!fs.existsSync(magPath)) throw new Error(`nema ${path.basename(magPath)}`);
    const mag = JSON.parse(fs.readFileSync(magPath, 'utf-8'));

    const bad = [];
    mag.iterations.forEach((it, itIdx) => it.sections.forEach((s, secIdx) => {
        if (isForeign(magTexts(s.magisterium))) bad.push(`${itIdx}:${secIdx}`);
    }));
    const badOverall = isForeign(overallTexts(mag.overall));
    console.log(`✝️  ${videoId} | ${art.channel} | sekcije sa stranim pismom: ${bad.join(', ') || '-'} | holistički: ${badOverall ? 'DA' : 'ne'}`);
    if (!bad.length && !badOverall) { console.log('✅ ništa za popraviti'); return; }
    if (args.includes('--dry-run')) return;

    // Prep s istim batch-sizeom kao produkcija → isti promptovi; zadrži samo pogođene batcheve.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `magfix_${videoId}_`));
    const batchSize = String(mag.batch_size || 1);
    if (run('node', ['magisterium_mcp_prep.js', '--article', art.path, '--batch-size', batchSize, '--out-dir', work]) !== 0) throw new Error('prep nije uspio');
    const jobPath = fs.readdirSync(work).filter(f => f.endsWith('.job.json')).map(f => path.join(work, f))[0];
    const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));
    const badSet = new Set(bad);
    job.batches = job.batches.filter(b => b.sectionRefs.some(r => badSet.has(`${r.itIdx}:${r.secIdx}`)));
    const resultsDir = path.join(work, 'results');
    fs.mkdirSync(resultsDir);
    // holistički: ako nije pogođen, stavi postojeći kao gotov odgovor da ga klijent preskoči
    if (!badOverall) fs.writeFileSync(path.join(resultsDir, 'holistic.mcp.json'), JSON.stringify({ answer: '{}', references: [] }));
    fs.writeFileSync(jobPath, JSON.stringify(job, null, 1));

    const want = new Map(job.batches.map(b => [`batch_${String(b.batchIndex).padStart(2, '0')}.mcp.json`, b.sectionRefs.map(r => r.localIndex)]));
    for (let round = 0; round <= 3; round++) {
        if (run('node', ['tools/magisterium_mcp_client.js', 'run', '--job', jobPath, '--results-dir', resultsDir]) !== 0) throw new Error('chat pozivi nisu prošli');
        const again = fs.readdirSync(resultsDir).filter(f => f.endsWith('.mcp.json')).filter(f => {
            if (f === 'holistic.mcp.json' && !badOverall) return false;
            const a = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf-8')).answer;
            return foreignFragments(a) > 0 || (want.has(f) && missingResults(a, want.get(f)) > 0);
        });
        if (!again.length) break;
        if (round === 3) throw new Error(`strani fragmenti i nakon 3 ponavljanja: ${again.join(', ')}`);
        console.log(`   ⚠️  ponovno: ${again.join(', ')}`);
        for (const f of again) fs.renameSync(path.join(resultsDir, f), path.join(resultsDir, `${f}.r${round}.bak`));
    }

    const fresh = path.join(work, 'fresh.magisterium.json');
    spawnSync('node', ['magisterium_mcp_assemble.js', '--job', jobPath, '--results-dir', resultsDir, '--out', fresh], { cwd: REPO, stdio: 'ignore' });
    if (!fs.existsSync(fresh)) throw new Error('assemble nije uspio');
    const nw = JSON.parse(fs.readFileSync(fresh, 'utf-8'));

    for (const key of bad) {
        const [itIdx, secIdx] = key.split(':').map(Number);
        const m = nw.iterations[itIdx].sections[secIdx].magisterium;
        if (!m || isForeign(magTexts(m))) throw new Error(`sekcija ${key} nije popravljena`);
        mag.iterations[itIdx].sections[secIdx].magisterium = m;
    }
    if (badOverall) {
        if (!nw.overall || isForeign(overallTexts(nw.overall))) throw new Error('holistički dio nije popravljen');
        mag.overall = nw.overall;
    }

    // preračun kao u assembleu: root = prosjek sekcija, iteracija = prosjek njezinih sekcija
    const all = [];
    for (const it of mag.iterations) {
        const sc = it.sections.map(s => s.magisterium && s.magisterium.score).filter(s => typeof s === 'number');
        it.iteration_score = sc.length ? Math.round(sc.reduce((a, b) => a + b, 0) / sc.length) : null;
        all.push(...sc);
    }
    const prev = mag.overall_score;
    mag.overall_score = all.length ? Math.round(all.reduce((a, b) => a + b, 0) / all.length) : null;
    mag.score_interpretation = mag.overall_score !== null ? scoreInterpretation(mag.overall_score) : null;
    mag.score_breakdown = mag.iterations.map(it => ({ iteration: it.iteration_number, theme: it.theme, score: it.iteration_score }));
    mag.total_concerns = mag.iterations.flatMap(it => it.sections).reduce((n, s) => n + ((s.magisterium && s.magisterium.concerns) || []).length, 0);
    mag.foreign_fix = { at: new Date().toISOString(), sections: bad, overall: badOverall };

    fs.renameSync(magPath, `${magPath}.bak.${Date.now()}`);
    fs.writeFileSync(magPath, JSON.stringify(mag, null, 2), 'utf-8');
    console.log(`✅ popravljeno: ${bad.length} sekcija${badOverall ? ' + holistički' : ''} | overall_score ${prev} → ${mag.overall_score}`);
    console.log(`   objava: node force_upload.js --video-id ${videoId} --channel ${art.channel} --targets magisterium`);
}

try { main(); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
