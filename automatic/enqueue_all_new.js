#!/usr/bin/env node
/**
 * enqueue_all_new.js — obrada SVIH novih epizoda (od 01.11.2026., nightly iza 5b).
 *
 * Pilot 01.11.2026. (docs/2026-11-01-obrada-svih-epizoda-pilot.md) je pokazao da puna
 * obrada svake nove epizode kandidata stane u dan (~19 min/ep na jednom slotu) i troši
 * ~0,37 boda tjedne Claude kvote po epizodi. Korisnik je odlučio: od 01.11. nightly
 * šalje SVE, jednako, bez filtra teme.
 *
 * Izvor: automatic/watchlist/events.jsonl (watch_candidates.js, KORAK 5b) — nove epizode
 * NEpraćenih kanala iz registryja, `cls === 'original'` (bez shortsa i isječaka). Praćene
 * kanale obrađuje sam nightly, pa ih ovdje nema. Isti popis je dao 19/19 epizoda pilota.
 *
 * Za svaku: POST /api/jobs kao u pilotu — ⚡ prioritet, Soniox, Claude Opus, Magisterium,
 * skip_published, llm_force (ograda prozora bi inače odgodila jutarnje članke za 22 h).
 * Backend deduplicira aktivne jobove i preskače objavljene, pa je ponovno slanje sigurno.
 *
 * Konvergencija: gleda zadnja ALL_EPISODES_LOOKBACK_DAYS dana (default 3), pa epizoda koja
 * nije ušla (429 pun red, mreža) uđe idući nightly. Isto vrijedi za job koji je backend
 * stvorio pa je pao na DOWNLOADU (YouTube anti-bot, nema info.json; 02.11.2026.). Najviše
 * 3 pokušaja po epizodi.
 *
 * Ograda kvote: kad je tjedni prozor ≥ ALL_EPISODES_MAX_WEEKLY (default 85 %), ne šalje
 * ništa (epizode ostaju za idući nightly unutar lookbacka).
 *
 * Stanje: automatic/watchlist/all_episodes.json (commita ga nightly chore).
 * Izvještaj potrošnje: automatic/all_episodes_report.js.
 *
 *   node automatic/enqueue_all_new.js --dry-run
 *   node automatic/enqueue_all_new.js --date 2026-11-02
 *
 * Env: PIPELINE_QUEUE_BASE, PIPELINE_QUEUE_INGEST_KEY (iz .env), ALL_EPISODES_SINCE
 * (default 2026-11-01), ALL_EPISODES_LOOKBACK_DAYS, ALL_EPISODES_MAX_WEEKLY,
 * ALL_EPISODES_OFF=1 gasi korak.
 */
const fs = require('fs');
const path = require('path');
const { readUsage, loadEnvKey } = require('./all_episodes_lib');

const REPO = path.resolve(__dirname, '..');
const EVENTS = path.join(REPO, 'automatic/watchlist/events.jsonl');
const STATE = path.join(REPO, 'automatic/watchlist/all_episodes.json');
const BASE = process.env.PIPELINE_QUEUE_BASE || 'https://pipeline.domovina.ai';
const SINCE = process.env.ALL_EPISODES_SINCE || '2026-11-01';
const LOOKBACK = parseInt(process.env.ALL_EPISODES_LOOKBACK_DAYS || '3', 10);
const MAX_WEEKLY = parseFloat(process.env.ALL_EPISODES_MAX_WEEKLY || '85');
const MAX_ATTEMPTS = 3;

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const DRY = args.includes('--dry-run');
const DATE = getArg('--date');

function localDate(d = new Date()) {
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { since: SINCE, episodes: {} }; }
}
function saveState(s) {
    fs.writeFileSync(STATE, JSON.stringify(s, null, 1) + '\n');
}

// Najnoviji pali job po videu, samo kad je pao na DOWNLOADU (anti-bot ili bez info.json).
// Padovi kasnijih koraka (članak, --replace) nisu stvar ponovnog slanja.
const DOWNLOAD_FAIL_RE = /YouTube anti-bot|prioritetni download nije uspio/;
async function failedDownloadJobs(key) {
    const res = await fetch(`${BASE}/api/jobs?state=failed&limit=300`, {
        headers: { authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { jobs } = await res.json();
    const out = new Map();
    for (const j of jobs || []) {
        if (j.state !== 'failed' || !DOWNLOAD_FAIL_RE.test(j.error || '')) continue;
        if (!out.has(j.youtube_id)) out.set(j.youtube_id, j); // lista je created_at DESC
    }
    return out;
}

async function main() {
    if (process.env.ALL_EPISODES_OFF === '1') { console.log('⏭️  ALL_EPISODES_OFF=1 — preskačem'); return; }
    const key = loadEnvKey(REPO);
    if (!key) { console.log('⚠️  nema PIPELINE_QUEUE_INGEST_KEY — preskačem'); return; }

    const today = localDate();
    const from = DATE || [SINCE, localDate(new Date(Date.now() - LOOKBACK * 86400000))].sort().pop();
    const to = DATE || today;

    const seen = new Set();
    const cands = [];
    for (const line of fs.readFileSync(EVENTS, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.cls !== 'original' || e.date < from || e.date > to || seen.has(e.id)) continue;
        seen.add(e.id);
        cands.push(e);
    }

    const state = loadState();
    // Job koji je backend stvorio pa je PAO na downloadu (YouTube anti-bot, 02.11.: 9/21)
    // nije gotov posao: bez ovoga ga nijedan idući nightly ne bi ponovno poslao.
    const dlFailed = await failedDownloadJobs(key).catch(err => {
        console.log(`   ⚠️  popis palih jobova nečitljiv (${err.message}) — bez ponovnog slanja`);
        return new Map();
    });
    const retryIds = new Set();
    const todo = cands.filter(e => {
        const s = state.episodes[e.id];
        if (!s) return true;
        if ((s.attempts || 0) >= MAX_ATTEMPTS) return false;
        if (['created', 'deduped'].includes(s.result)) {
            const j = dlFailed.get(e.id);
            if (j && (!s.job_id || s.job_id === j.id)) { retryIds.add(e.id); return true; }
            return false;
        }
        return s.result !== 'published';
    });
    if (retryIds.size) console.log(`   🔁 ponovno: ${retryIds.size} jobova palih na downloadu`);
    console.log(`🌐 Obrada svih novih epizoda: ${cands.length} originala ${from}…${to}, za slanje ${todo.length}`);
    if (!todo.length) return;

    const usage = await readUsage().catch(e => ({ error: e.message }));
    if (usage.error) console.log(`   ⚠️  kvota nečitljiva (${usage.error}) — šaljem bez ograde`);
    else console.log(`   📊 kvota: tjedni ${usage.seven_day} %, 5h ${usage.five_hour} %`);
    if (!usage.error && usage.seven_day >= MAX_WEEKLY) {
        console.log(`   ⛔ tjedni ${usage.seven_day} % ≥ ${MAX_WEEKLY} % — ne šaljem ništa, epizode čekaju idući nightly`);
        return;
    }

    const tally = { created: 0, deduped: 0, published: 0, failed: 0 };
    for (let i = 0; i < todo.length; i++) {
        const e = todo[i];
        const label = `${e.id} ${Math.round((e.duration || 0) / 60)} min [${e.slug}] ${(e.title || '').slice(0, 60)}`;
        if (DRY) { console.log(`   (dry) ${label}`); continue; }
        const body = {
            url: `https://www.youtube.com/watch?v=${e.id}`,
            title: e.title || undefined,
            priority: true,
            transcription: 'soniox',
            article_model: 'claude:opus',
            with_magisterium: true,
            skip_published: true,
            llm_force: true,
        };
        const prev = state.episodes[e.id] || {};
        const rec = { date: e.date, slug: e.slug, title: e.title, duration: e.duration,
            attempts: (prev.attempts || 0) + 1, sent_at: new Date().toISOString() };
        let res, data;
        try {
            res = await fetch(`${BASE}/api/jobs`, {
                method: 'POST',
                headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            data = await res.json().catch(() => ({}));
        } catch (err) {
            rec.result = 'error'; rec.error = err.message;
        }
        if (res && res.status === 429) {
            console.log(`   ⛔ ${label} — ${data.error || 'red je pun'}; ostatak (${todo.length - i}) idući nightly`);
            rec.attempts = prev.attempts || 0; // pun red nije pokušaj epizode
            rec.result = 'queue_full';
            state.episodes[e.id] = { ...prev, ...rec };
            tally.failed += todo.length - i;
            break;
        }
        if (res && !res.ok) { rec.result = 'error'; rec.error = `HTTP ${res.status}: ${data.error || ''}`; }
        else if (res && data.skipped === 'published') rec.result = 'published';
        else if (res && data.deduped) { rec.result = 'deduped'; rec.job_id = data.job && data.job.id; }
        else if (res) { rec.result = 'created'; rec.job_id = data.job && data.job.id; }
        state.episodes[e.id] = { ...prev, ...rec };
        tally[rec.result === 'error' ? 'failed' : rec.result]++;
        console.log(`   ${rec.result === 'created' ? '➕' : rec.result === 'error' ? '❌' : '='} ${label} → ${rec.result}${rec.error ? ' ' + rec.error : ''}`);
    }
    if (!DRY) {
        state.since = state.since || SINCE;
        state.updated_at = new Date().toISOString();
        if (!usage.error) state.last_enqueue_usage = { at: new Date().toISOString(), ...usage };
        saveState(state);
    }
    console.log(`   📊 novih ${tally.created} · već u redu ${tally.deduped} · objavljeno ${tally.published} · neuspjelih ${tally.failed}`);
}

main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
