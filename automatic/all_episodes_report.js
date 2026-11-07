#!/usr/bin/env node
/**
 * all_episodes_report.js — dnevni izvještaj obrade SVIH novih epizoda: kvota + vrijeme.
 *
 *   node automatic/all_episodes_report.js sample     # 1 uzorak kvote (najviše 1 u 10 min)
 *   node automatic/all_episodes_report.js report     # svi dani koji još nisu zaključeni
 *   node automatic/all_episodes_report.js report --date 2026-11-02
 *
 * `sample` zove priority_pipeline.sh na svakom ticku (90 s, sam se prorijedi na 10 min) →
 * automatic/watchlist/quota_samples.jsonl. `report` ide u nightlyju PRIJE enqueue_all_new.js
 * i zaključuje jučerašnju seriju: vremena iz pipeline.domovina.ai (/api/jobs, /api/magisterium),
 * kvota iz uzoraka između prvog slanja i zadnjeg Magisteriuma.
 *
 * Porast tjedne kvote u prozoru serije uključuje SVE što je u tom vremenu radilo na
 * pretplati (i interaktivne sesije), pa je „po epizodi" gornja granica. API vraća cijele
 * postotke; reset tjednog prozora (pad) se zbraja kao novi početak.
 *
 * Izlaz: automatic/watchlist/ALL_EPISODES_REPORT.md (najnoviji dan gore) +
 * automatic/watchlist/all_episodes_daily.json. Dan je „zaključen" kad su svi jobovi i
 * Magisterium HR terminalni ili je prošlo 36 h od prvog slanja.
 */
const fs = require('fs');
const path = require('path');
const { readUsage, loadEnvKey } = require('./all_episodes_lib');

const REPO = path.resolve(__dirname, '..');
const W = path.join(REPO, 'automatic/watchlist');
const STATE = path.join(W, 'all_episodes.json');
const SAMPLES = path.join(W, 'quota_samples.jsonl');
const DAILY = path.join(W, 'all_episodes_daily.json');
const REPORT = path.join(W, 'ALL_EPISODES_REPORT.md');
const BASE = process.env.PIPELINE_QUEUE_BASE || 'https://pipeline.domovina.ai';
const SAMPLE_EVERY_MS = 10 * 60 * 1000;

const args = process.argv.slice(2);
const cmd = args[0];
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const fmtT = s => s ? new Date(s * 1000).toLocaleString('hr-HR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
const median = a => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const r1 = x => Math.round(x * 10) / 10;

function loadSamples() {
    if (!fs.existsSync(SAMPLES)) return [];
    return fs.readFileSync(SAMPLES, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .sort((a, b) => a.ts - b.ts);
}

async function sample() {
    const s = loadSamples();
    if (s.length && Date.now() - s[s.length - 1].ts * 1000 < SAMPLE_EVERY_MS && !args.includes('--force')) return;
    const u = await readUsage();
    // agy kvota uz Claude (07.11.2026.): Tier 2 piše kroz agy, Argon ima zaseban tjedni limit.
    const a = await require('../lib/agy_usage').readAgyUsage({ maxAgeSec: 0 }).catch(() => null);
    const agy = a ? { agy_gemini_5h: a.gemini_5h, agy_gemini_weekly: a.gemini_weekly, agy_argon_weekly: a.argon_weekly } : {};
    fs.appendFileSync(SAMPLES, JSON.stringify({ ts: Math.floor(Date.now() / 1000), five_hour: u.five_hour, seven_day: u.seven_day, ...agy }) + '\n');
}

// Porast tjednog između t0 i t1: zbroj pozitivnih koraka; pad > 3 = reset prozora.
function weeklyGrowth(samples, t0, t1) {
    // Polazište = zadnji uzorak PRIJE prvog slanja, kraj = prvi uzorak NAKON zadnjeg posla.
    const before = samples.filter(s => s.ts <= t0).pop();
    const after = samples.find(s => s.ts >= t1);
    const w = samples.filter(s => s.ts > t0 && s.ts < t1);
    if (before) w.unshift(before);
    if (after) w.push(after);
    if (w.length < 2) return { growth: null, start: w[0] && w[0].seven_day, end: w[0] && w[0].seven_day, peak5h: w.length ? Math.max(...w.map(s => s.five_hour)) : null, n: w.length };
    let g = 0;
    for (let i = 1; i < w.length; i++) {
        const d = w[i].seven_day - w[i - 1].seven_day;
        if (d > 0) g += d; else if (d < -3) g += w[i].seven_day;
    }
    return { growth: g, start: w[0].seven_day, end: w[w.length - 1].seven_day, peak5h: Math.max(...w.map(s => s.five_hour)), n: w.length };
}

async function api(p, key) {
    const res = await fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`${p} HTTP ${res.status}`);
    return res.json();
}

async function report() {
    const key = loadEnvKey(REPO);
    if (!key) { console.log('⚠️  nema PIPELINE_QUEUE_INGEST_KEY — preskačem'); return; }
    const state = readJson(STATE, { episodes: {} });
    const daily = readJson(DAILY, {});
    const dates = getArg('--date') ? [getArg('--date')]
        : [...new Set(Object.values(state.episodes).map(e => e.date))].filter(d => !(daily[d] && daily[d].final)).sort();
    if (!dates.length) { console.log('📊 nema otvorenih dana za izvještaj'); return; }

    const jobs = (await api('/api/jobs?limit=500', key)).jobs;
    const mags = (await api('/api/magisterium?limit=500', key)).jobs;
    const samples = loadSamples();
    const latestBy = (arr, id, pred = () => true) => arr.filter(j => j.youtube_id === id && pred(j))
        .sort((a, b) => b.created_at - a.created_at)[0];

    for (const date of dates) {
        const eps = Object.entries(state.episodes).filter(([, e]) => e.date === date && ['created', 'deduped'].includes(e.result));
        const rows = eps.map(([id, e]) => {
            const j = latestBy(jobs, id) || {};
            const m = latestBy(mags, id, x => x.lang === 'hr') || {};
            return { id, title: e.title, audio_min: Math.round((j.duration_seconds || e.duration || 0) / 60),
                state: j.state || '?', created: j.created_at, claimed: j.claimed_at, done: j.done_at,
                proc_min: j.done_at && j.claimed_at ? (j.done_at - j.claimed_at) / 60 : null,
                mag: m.state || '-', mag_done: m.done_at, mag_min: m.done_at && m.claimed_at ? (m.done_at - m.claimed_at) / 60 : null,
                error: j.error || m.error || null };
        });
        const done = rows.filter(r => r.state === 'done');
        const failed = rows.filter(r => r.state === 'failed');
        const terminal = rows.every(r => ['done', 'failed'].includes(r.state) && (r.state === 'failed' || ['done', 'failed'].includes(r.mag)));
        const t0 = Math.min(...rows.map(r => r.created).filter(Boolean));
        const tEndProc = Math.max(0, ...rows.map(r => r.done || 0));
        const tEnd = Math.max(tEndProc, ...rows.map(r => r.mag_done || 0));
        const final = terminal || (Date.now() / 1000 - t0 > 36 * 3600);
        const q = weeklyGrowth(samples, t0, final ? tEnd : Math.floor(Date.now() / 1000));
        const procs = done.map(r => r.proc_min).filter(x => x != null);
        const magm = rows.map(r => r.mag_min).filter(x => x != null);
        const perEp = q.growth != null && done.length ? q.growth / done.length : null;
        const d = {
            date, final, generated_at: new Date().toISOString(),
            episodes: rows.length, done: done.length, failed: failed.length,
            magisterium_done: rows.filter(r => r.mag === 'done').length,
            audio_h: r1(rows.reduce((a, r) => a + r.audio_min, 0) / 60),
            first_enqueue: t0, processing_end: tEndProc, magisterium_end: tEnd,
            processing_wall_h: tEndProc ? r1((tEndProc - t0) / 3600) : null,
            proc_min_median: r1(median(procs)), proc_min_sum: Math.round(procs.reduce((a, b) => a + b, 0)),
            mag_min_median: r1(median(magm)), mag_min_sum: Math.round(magm.reduce((a, b) => a + b, 0)),
            weekly_start: q.start, weekly_end: q.end, weekly_growth: q.growth, peak_5h: q.peak5h, quota_samples: q.n,
            weekly_per_episode: perEp != null ? Math.round(perEp * 100) / 100 : null,
            failures: failed.map(r => ({ id: r.id, error: (r.error || '').slice(0, 200) })),
            rows,
        };
        daily[date] = d;
        console.log(`📊 ${date}: ${d.done}/${d.episodes} gotovo, Mag ${d.magisterium_done}, tjedni +${d.weekly_growth ?? '?'} (${d.weekly_per_episode ?? '?'}/ep)${final ? '' : ' — u tijeku'}`);
    }
    fs.writeFileSync(DAILY, JSON.stringify(daily, null, 1) + '\n');
    writeMarkdown(daily);
}

function writeMarkdown(daily) {
    const days = Object.values(daily).sort((a, b) => b.date.localeCompare(a.date));
    const L = [];
    L.push('# Obrada svih novih epizoda — dnevni izvještaj', '');
    L.push('Generira `automatic/all_episodes_report.js` (nightly, prije slanja nove serije).',
        'Kontekst i pilot: `docs/2026-11-01-obrada-svih-epizoda-pilot.md`. Porast tjedne kvote uključuje',
        'sve što je u prozoru serije radilo na pretplati, pa je „po ep." gornja granica.', '');
    L.push('| datum | ep. | gotovo | pali | Mag HR | audio h | obrada (prvo slanje → zadnja ep.) | medijan min/ep | Mag kraj | tjedni % | +tjedni | /ep | max 5h % |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const d of days) {
        L.push(`| ${d.date}${d.final ? '' : ' ⏳'} | ${d.episodes} | ${d.done} | ${d.failed} | ${d.magisterium_done} | ${d.audio_h} | ${fmtT(d.first_enqueue)} → ${fmtT(d.processing_end)} (${d.processing_wall_h ?? '–'} h) | ${d.proc_min_median} | ${fmtT(d.magisterium_end)} | ${d.weekly_start ?? '?'} → ${d.weekly_end ?? '?'} | ${d.weekly_growth ?? '?'} | ${d.weekly_per_episode ?? '?'} | ${d.peak_5h ?? '?'} |`);
    }
    const fin = days.filter(d => d.final && d.weekly_per_episode != null);
    if (fin.length) {
        const per = fin.reduce((a, d) => a + d.weekly_growth, 0) / fin.reduce((a, d) => a + d.done, 0);
        const epd = fin.reduce((a, d) => a + d.episodes, 0) / fin.length;
        L.push('', `**Prosjek zaključenih dana (${fin.length}):** ${Math.round(per * 100) / 100} boda tjednog/ep, ${r1(epd)} ep/dan → ` +
            `**~${Math.round(per * epd * 7)} % tjedne kvote tjedno** samo za ovu obradu.`);
    }
    for (const d of days) {
        if (!d.failures.length) continue;
        L.push('', `### Padovi ${d.date}`, '');
        for (const f of d.failures) L.push(`- \`${f.id}\` — ${f.error || '(bez poruke)'}`);
    }
    L.push('');
    fs.writeFileSync(REPORT, L.join('\n'));
}

(async () => {
    if (cmd === 'sample') await sample();
    else if (cmd === 'report') await report();
    else { console.error('Upotreba: all_episodes_report.js sample|report [--date YYYY-MM-DD]'); process.exit(2); }
})().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
