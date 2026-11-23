#!/usr/bin/env node
/**
 * Noćna Modal serija za Tier 2 (od 23.11.2026.) — ALTERNATIVNI način obrade, prekidač
 * `MODAL_NIGHTLY_BATCH=1` (env ili `.env`). Bez prekidača skripta odmah izlazi i nightly
 * radi točno kao prije.
 *
 * Što radi, PRIJE nego `enqueue_all_new.js` stvori jobove:
 *   1. Popis epizoda = ono što bi `enqueue_all_new.js` sada poslao (njegov `--dry-run`,
 *      dakle ISTA logika: lookback, process:false, postavke kanala, kvota, pokušaji).
 *   2. Za svaku skine SAMO ono što job ionako skida u KORAKU 1 (`fetch.js --unlisted-url`,
 *      MP3 + 360p) i složi WAV (`convert_to_wav.js`), jednu po jednu.
 *   3. Sve WAV-ove pošalje na Modal u JEDNOM appu (`canary_modal.py::batch_list`): Canary
 *      prijepis + pyannote govornici, model se učita jednom umjesto jednom po epizodi.
 *   4. Izađe; `enqueue_all_new.js` zatim stvori jobove kao i inače.
 *
 * Jobovi se ne mijenjaju: fetch.js vidi epizodu u `_unlisted-state.json` i preskoči skidanje,
 * convert_to_wav preskoči postojeći WAV, KORAK 2.6 vidi `.canary.srt` + `.canary.pyannote.json`
 * i ne zove Modal. 1080p za screenshotove i dalje skida job sam (KORAK 10). Epizoda koja ovdje
 * ne uspije (anti-bot, pad na Modalu, prevelik WAV) nema `.canary.srt`, pa njezin job ide
 * starim putem — ova skripta ne može ostaviti epizodu bez prijepisa.
 *
 * Usage:
 *   node automatic/modal_nightly_batch.js             # poštuje prekidač
 *   node automatic/modal_nightly_batch.js --force     # radi i bez prekidača (ručna proba)
 *   node automatic/modal_nightly_batch.js --dry-run   # samo popis, bez skidanja i Modala
 *   node automatic/modal_nightly_batch.js --from-queue --force   # jobovi koji već čekaju u redu
 *   [--limit N] [--concurrency 2] [--no-download]
 *
 * --from-queue (23.11.): popis = jobovi u stanju `queued` na pipeline.domovina.ai, od kraja reda
 * (poller uzima s početka, pa se serija i slotovi rijetko preklapaju). Job koji poller uzme
 * dok serija radi samo ponovno pokrene svoj Modal poziv; ništa se ne gubi.
 *
 * Env: MODAL_NIGHTLY_BATCH (1 = uključeno), MODAL_NIGHTLY_BATCH_MAX (default 40 epizoda),
 *      PIPELINE_QUEUE_INGEST_KEY (transcribe claim, isti kao KORAK 2.6).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const UNLISTED = path.join(REPO, 'storage/output/_unlisted');
const EVENTS = path.join(REPO, 'automatic/watchlist/events.jsonl');
const REGISTRY = path.join(REPO, 'data/podcasts_registry.json');
const LANG_CONF = path.join(REPO, 'automatic/channel_languages.conf');
const MODAL_APP = path.join(REPO, 'modal_canary/canary_modal.py');
const LOG_DIR = path.join(REPO, 'automatic/logs');
const PROXY_FILE = path.join(require('os').homedir(), '.cache', 'domovina-pipeline', 'youtube_proxy');
const ANTIBOT_FILE = path.join(require('os').homedir(), '.cache', 'domovina-pipeline', 'youtube_antibot.json');
// Isti prozor kao ANTIBOT_COOLDOWN_MIN u priority_poller.js: dok traje, YouTube se ne dira.
const ANTIBOT_COOLDOWN_MIN = parseInt(process.env.PRIORITY_YT_COOLDOWN_MIN || '120', 10);
// Razmak između skidanja: bez njega serija pošalje ~35 zahtjeva u nekoliko minuta, a YouTube
// anti-bot je po IP-u i broju zahtjeva (ne po rezoluciji). Jobovi su se prirodno razmicali.
const GAP_MIN_S = parseInt(process.env.MODAL_NIGHTLY_BATCH_GAP_MIN || '20', 10);
const GAP_MAX_S = parseInt(process.env.MODAL_NIGHTLY_BATCH_GAP_MAX || '45', 10);
const QUEUE_BASE = process.env.PIPELINE_QUEUE_BASE || 'https://pipeline.domovina.ai';

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');
const NO_DOWNLOAD = args.includes('--no-download');
const FROM_QUEUE = args.includes('--from-queue');
const LIMIT = parseInt(getArg('--limit') || process.env.MODAL_NIGHTLY_BATCH_MAX || '40', 10);
const CONCURRENCY = parseInt(getArg('--concurrency') || '2', 10);

function envFromDotenv(name) {
    if (process.env[name] !== undefined) return process.env[name];
    try {
        const m = fs.readFileSync(path.join(REPO, '.env'), 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
        return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
    } catch { return undefined; }
}
function localDate(d = new Date()) {
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function ts() { return new Date().toTimeString().slice(0, 8); }
function sleepSync(sec) { spawnSync('sleep', [String(sec)]); }
function antiBotActive() {
    try {
        const m = JSON.parse(fs.readFileSync(ANTIBOT_FILE, 'utf8'));
        const at = Date.parse(m.at);
        if (Number.isFinite(at) && Date.now() - at < ANTIBOT_COOLDOWN_MIN * 60000) return m;
    } catch { /* nema markera */ }
    return null;
}

// ─── 1. Popis: točno ono što bi enqueue_all_new.js sada poslao ──────────────
function candidates() {
    const r = spawnSync('node', [path.join(REPO, 'automatic/enqueue_all_new.js'), '--dry-run'],
        { cwd: REPO, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write((r.stdout || '').split('\n').filter(l => !/^\s*\(dry\)/.test(l)).join('\n'));
    if (r.status !== 0) {
        console.log(`   ⚠️  enqueue_all_new.js --dry-run izašao s ${r.status} — bez serije`);
        return [];
    }
    const ids = [];
    for (const l of (r.stdout || '').split('\n')) {
        const m = l.match(/^\s*\(dry\)\s+([A-Za-z0-9_-]{11})\s/);
        if (m && !ids.includes(m[1])) ids.push(m[1]);
    }
    // Puni naslov iz istog izvora kao enqueue (events.jsonl) — dry-run ispis ga reže na 60 znakova.
    const byId = new Map();
    for (const line of fs.readFileSync(EVENTS, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (ids.includes(e.id) && !byId.has(e.id)) byId.set(e.id, e);
    }
    return ids.map(id => byId.get(id) || { id });
}

// ─── 1b. Popis iz reda: jobovi koji već čekaju (--from-queue) ───────────────
async function queuedCandidates() {
    const key = envFromDotenv('PIPELINE_QUEUE_INGEST_KEY');
    if (!key) { console.log('   ⚠️  nema PIPELINE_QUEUE_INGEST_KEY — bez serije'); return []; }
    try {
        const res = await fetch(`${QUEUE_BASE}/api/jobs?state=queued&limit=200`,
            { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
        const { jobs = [] } = await res.json();
        const seen = new Set();
        return jobs.filter(j => /^[A-Za-z0-9_-]{11}$/.test(j.youtube_id || '') && !seen.has(j.youtube_id) && seen.add(j.youtube_id))
            .reverse()
            .map(j => ({ id: j.youtube_id, title: j.title, duration: j.duration_seconds, slug: j.channel }));
    } catch (e) {
        console.log(`   ⚠️  red nedostupan (${e.message}) — bez serije`);
        return [];
    }
}

// ─── Disk ───────────────────────────────────────────────────────────────────
function unlistedFiles() {
    try { return fs.readdirSync(UNLISTED); } catch { return []; }
}
function findFor(files, id, suffix) {
    return files.find(f => f.includes('_yt_' + id) && f.endsWith(suffix) && !f.startsWith('._')
        && !f.includes('.loudnorm.'));
}
function wavFor(id) {
    const f = findFor(unlistedFiles(), id, '.wav');
    return f ? path.join(UNLISTED, f) : null;
}
function downloaded(id) {
    const files = unlistedFiles();
    return !!(findFor(files, id, '.info.json') && findFor(files, id, '.mp3'));
}

// Isti redoslijed kao _source_lang_for_path u run_pipeline.sh (KORAK 2.6):
// channel_languages.conf → {base}.info.json `language` → registry metadata.asr_language → hr.
let registryCache = null;
function sourceLang(wav) {
    try {
        const hit = fs.readFileSync(LANG_CONF, 'utf8').match(/^_unlisted=\s*([a-z]{2})/m);
        if (hit) return hit[1];
    } catch { /* nema conf-a */ }
    let info = {};
    try { info = JSON.parse(fs.readFileSync(wav.replace(/\.wav$/, '.info.json'), 'utf8')); } catch { /* bez info */ }
    const lang = String(info.language || '').toLowerCase().match(/^([a-z]{2})([-_]|$)/);
    if (lang) return lang[1];
    if (info.channel_id) {
        try {
            registryCache = registryCache || JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
            const p = (registryCache.podcasts || []).find(x => x.youtube?.channel_id === info.channel_id);
            const al = p?.metadata?.asr_language;
            if (/^[a-z]{2}$/.test(al || '')) return al;
        } catch { /* registry nečitljiv */ }
    }
    return 'hr';
}

// Isti proxy kao priority_poller.js (liveProxy): ručni iPhone proxy, samo za skidanje.
function liveProxy() {
    let url = '';
    try { url = fs.readFileSync(PROXY_FILE, 'utf-8').trim(); } catch { return null; }
    if (!url) return null;
    const r = spawnSync('curl', ['-s', '-m', '15', '-x', url, 'https://api.ipify.org'], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.trim()) return url;
    console.log(`   ⚠️  YouTube proxy ${url} ne odgovara — skidam bez njega.`);
    return null;
}

async function claim(id, key) {
    if (!key) return true;
    try {
        const res = await fetch(`${QUEUE_BASE}/api/transcription/claim`, {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ youtube_id: id, backend: 'modal' }),
            signal: AbortSignal.timeout(15000),
        });
        const d = await res.json().catch(() => ({}));
        return d.claimed !== false;          // isto kao KORAK 2.6: preskoči samo na eksplicitni false
    } catch { return true; }
}

async function main() {
    const on = envFromDotenv('MODAL_NIGHTLY_BATCH');
    if (!FORCE && !DRY && on !== '1') {
        console.log('⏭️  MODAL_NIGHTLY_BATCH nije 1 — noćna Modal serija ugašena, jobovi idu pojedinačno (stari put).');
        return;
    }
    if (envFromDotenv('ALL_EPISODES_OFF') === '1') { console.log('⏭️  ALL_EPISODES_OFF=1 — nema serije'); return; }
    const t0 = Date.now();
    console.log(`🧺 [${ts()}] Noćna Modal serija (Tier 2): popis iz ${FROM_QUEUE ? 'reda (queued jobovi)' : 'enqueue_all_new.js --dry-run'}`);
    let eps = FROM_QUEUE ? await queuedCandidates() : candidates();
    if (eps.length > LIMIT) {
        console.log(`   ✂️  ${eps.length} epizoda > limit ${LIMIT} — ostatak ide pojedinačno kroz svoje jobove`);
        eps = eps.slice(0, LIMIT);
    }
    console.log(`   📋 epizoda za seriju: ${eps.length}`);
    if (!eps.length) return;
    if (DRY) {
        for (const e of eps) {
            const w = wavFor(e.id);
            console.log(`   (dry) ${e.id} ${Math.round((e.duration || 0) / 60)} min [${e.slug || '?'}] ` +
                `${w ? 'WAV već na disku' : downloaded(e.id) ? 'MP3 na disku' : 'skinuti'}  ${(e.title || '').slice(0, 60)}`);
        }
        return;
    }

    // ─── 2. Skidanje + WAV, jedna po jedna (isti KORAK 1/2 kao job) ──────────
    const proxy = NO_DOWNLOAD ? null : liveProxy();
    if (proxy) console.log(`   🌐 skidanje kroz proxy ${proxy}`);
    const ready = [];
    let consecutiveFail = 0;
    let downloads = 0;
    for (const [i, e] of eps.entries()) {
        const label = `[${i + 1}/${eps.length}] ${e.id} [${e.slug || '?'}]`;
        if (!downloaded(e.id)) {
            if (NO_DOWNLOAD) { console.log(`   ⏭️  ${label} nije skinut (--no-download)`); continue; }
            if (consecutiveFail >= 2) { console.log(`   ⏭️  ${label} — 2 pada zaredom, ostatak skida job`); continue; }
            const ab = proxy ? null : antiBotActive();
            if (ab) {
                console.log(`   ⛔ ${label} — YouTube anti-bot (${ab.source}, ${ab.at}) — ne skidam dalje, ostatak skida job nakon pauze`);
                consecutiveFail = 99;
                continue;
            }
            if (downloads++ > 0) {
                const gap = GAP_MIN_S + Math.floor(Math.random() * (GAP_MAX_S - GAP_MIN_S + 1));
                sleepSync(gap);
            }
            const fa = ['fetch.js', '--unlisted-url', `https://www.youtube.com/watch?v=${e.id}`];
            if (e.title) fa.push('--unlisted-title', e.title);
            if (proxy) fa.push('--proxy', proxy);
            // VIDEO_SINGLE_1080P=1: serija skida samo zvuk; video jednom skida job (KORAK 9.95).
            if (envFromDotenv('VIDEO_SINGLE_1080P') === '1') fa.push('--audio-only');
            console.log(`   ⬇️  [${ts()}] ${label} ${(e.title || '').slice(0, 60)}`);
            const r = spawnSync('node', fa, { cwd: REPO, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
            if (!downloaded(e.id)) {
                consecutiveFail++;
                const err = ((r.stderr || '') + (r.stdout || '')).split('\n')
                    .filter(l => /ERROR|GREŠKA|bot|unavailable|private/i.test(l)).slice(-1)[0] || `exit ${r.status}`;
                console.log(`   ❌ ${label} skidanje nije uspjelo — ${err.trim().slice(0, 160)}`);
                continue;
            }
            consecutiveFail = 0;
        }
        if (!wavFor(e.id)) {
            const r = spawnSync('node', ['convert_to_wav.js', '--channel', '_unlisted', '--video-id', e.id],
                { cwd: REPO, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
            if (!wavFor(e.id)) { console.log(`   ❌ ${label} WAV nije nastao (exit ${r.status})`); continue; }
        }
        ready.push(e);
    }

    // ─── 3. Jedan Modal app za sve ───────────────────────────────────────────
    const key = envFromDotenv('PIPELINE_QUEUE_INGEST_KEY');
    const manifest = [];
    for (const e of ready) {
        const wav = wavFor(e.id);
        if (fs.existsSync(wav + '.canary.srt') && fs.existsSync(wav + '.canary.pyannote.json')) continue;
        if (!(await claim(e.id, key))) { console.log(`   🔒 ${e.id} drži drugi backend (Colab) — preskačem`); continue; }
        manifest.push({ wav, source_lang: sourceLang(wav), id: e.id });
    }
    const dlMin = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`   📦 [${ts()}] skinuto/spremno ${ready.length}/${eps.length} (${dlMin} min) → Modal: ${manifest.length}`);
    if (!manifest.length) return;

    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = `${localDate()}_${ts().replace(/:/g, '')}`;
    const manPath = path.join(LOG_DIR, `modal_batch_${stamp}.manifest.json`);
    const resPath = path.join(LOG_DIR, `modal_batch_${stamp}.result.json`);
    fs.writeFileSync(manPath, JSON.stringify(manifest, null, 1));
    const langs = [...new Set(manifest.map(m => m.source_lang))].join(',');
    console.log(`   🚀 [${ts()}] modal run ::batch_list (${manifest.length} WAV, jezici ${langs}, concurrency ${CONCURRENCY})`);
    const r = spawnSync('modal', ['run', `${MODAL_APP}::batch_list`, '--manifest', manPath,
        '--concurrency', String(CONCURRENCY), '--result-out', resPath], {
        cwd: REPO, stdio: 'inherit',
        // Jedan Canary container: concurrency>1 samo preklapa upload idućeg s inferencom.
        env: { ...process.env, MODAL_CANARY_MAX_CONTAINERS: process.env.MODAL_CANARY_MAX_CONTAINERS || '1' },
    });
    let ok = 0;
    for (const m of manifest) {
        if (fs.existsSync(m.wav + '.canary.srt')) ok++;
    }
    const min = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`   ${r.status === 0 ? '✅' : '⚠️ '} [${ts()}] Modal serija: ${ok}/${manifest.length} s prijepisom, ukupno ${min} min` +
        (r.status === 0 ? '' : ` (modal exit ${r.status}; epizode bez .canary.srt idu starim putem u svom jobu)`));
}

main().catch(err => {
    // Nikad ne ruši nightly: bez serije jobovi rade kao prije.
    console.log(`   ⚠️  noćna Modal serija pala (${err.message}) — jobovi idu starim putem`);
});
