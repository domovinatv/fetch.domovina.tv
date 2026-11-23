#!/usr/bin/env node
/**
 * missing_report.js — što fali na domovina.ai i zašto (23.11.2026., nightly iza backfill_days.js).
 *
 * Cilj: svaka epizoda koju podcast.domovina.ai/dani/<d> prikazuje mora završiti obrađena na
 * domovina.ai/dani/<d>. Dijagnoza 16.–22. 11. (docs/2026-11-23-epizode-koje-fale-i-retry.md)
 * našla je tri rupe: prijenosi s /streams nikad nisu viđeni, red ponavlja samo 3 dana, i nema
 * jednog popisa „što fali i zašto". Ovo je taj popis.
 *
 * Skup = originali iz automatic/watchlist/backfill.json (YouTube Data API, isti izvor kao
 * podcast.domovina.ai/dani) za zadnjih MISSING_WINDOW_DAYS (14) dana,
 *   minus obrađeni      (data/<id>/article.json u .r2_keys_cache.json)
 *   minus isključeni    (postavke kanala: povučen/tombstone/obrada isključena — npr. Ora et
 *                        Labora; registry tracking.process:false)
 *   minus derivati      ([PROMO] i ostalo što watch_candidates.js zove derivative/short)
 *   minus presvježe     (objavljeno prije < 3 h: prijenos možda još traje).
 * Ostatak → automatic/watchlist/missing.json, po epizodi
 *   { id, slug, date, title, tier, reason, attempts, last_error, last_try, note? }
 * reason ∈ never_seen | queued | failed:<korak> | gave_up   (tier1 = praćeni kanal, nightly)
 *
 * --enqueue: never_seen i failed (Tier 2) idu u isti red kao enqueue_all_new.js (POST
 * /api/jobs, isti parametri), najviše MAX_ATTEMPTS pokušaja po epizodi zbrojeno s
 * enqueue_all_new.js. Iste ograde: postavke kanala nedostupne → ništa, tjedna kvota ≥ 85 % →
 * ništa, 429 (pun red) → stani. Praćeni kanali (Tier 1) se samo prijavljuju: njih obrađuje
 * nightly KORAK 1, a job bi ih obradio u _unlisted.
 *
 *   node automatic/missing_report.js                 # popis po razlogu (+ missing.json)
 *   node automatic/missing_report.js --enqueue --dry-run
 *   node automatic/missing_report.js --enqueue --telegram   # nightly
 *   Opcije: --days 14, --json (ispiši JSON umjesto teksta)
 *
 * Telegram: samo kroz lib/notify_telegram.js (Worker li.domovina.ai drži token), nikad Bot API.
 * Env: MISSING_WINDOW_DAYS, MISSING_OFF=1 (gasi --enqueue), ALL_EPISODES_MAX_WEEKLY.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const W = path.join(REPO, 'automatic/watchlist');
const FILES = {
    backfill: path.join(W, 'backfill.json'),
    watchState: path.join(W, 'watch-state.json'),
    allEpisodes: path.join(W, 'all_episodes.json'),
    missing: path.join(W, 'missing.json'),
    registry: path.join(REPO, 'data/podcasts_registry.json'),
    r2cache: path.join(REPO, '.r2_keys_cache.json'),
    antibot: path.join(os.homedir(), '.cache', 'domovina-pipeline', 'youtube_antibot.json'),
};
const BASE = process.env.PIPELINE_QUEUE_BASE || 'https://pipeline.domovina.ai';
const MAX_ATTEMPTS = 3;
const MAX_WEEKLY = parseFloat(process.env.ALL_EPISODES_MAX_WEEKLY || '85');
const ANTIBOT_COOLDOWN_MIN = parseInt(process.env.PRIORITY_YT_COOLDOWN_MIN || '120', 10);
const FRESH_HOURS = 3;
const ACTIVE_STATES = ['queued', 'fetching', 'transcribing', 'processing', 'postponed'];
const PROMO_RE = /\[promo\]/i;

const args = process.argv.slice(2);
const getArg = (n) => { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : null; };
const WINDOW_DAYS = parseInt(getArg('--days') || process.env.MISSING_WINDOW_DAYS || '14', 10);

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const localDate = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// ─── razvrstavanje (čisto, testira se) ────────────────────────────────

/** Korak na kojem je job pao, iz teksta greške bridgea. */
function failedStep(error) {
    const e = error || '';
    if (/ne ponavlja se|nema zvuka/i.test(e)) return 'bez_zvuka';
    if (/anti-bot|download|info\.json|private/i.test(e)) return 'download';
    if (/ASR|prijepis|Soniox|Speechmatics|Canary|transkrip/i.test(e)) return 'asr';
    if (/Magisterium/i.test(e)) return 'magisterium';
    if (/članak|clanak|article|LLM|agy|claude|sažet|summary/i.test(e)) return 'clanak';
    return 'ostalo';
}
/** Pad koji ponovno slanje ne popravlja. */
const NO_RETRY_STEPS = new Set(['bez_zvuka']);

/**
 * Originali u prozoru koji nisu obrađeni i nisu namjerno isključeni.
 * → { missing: [{id, slug, date, title, tier, channel_id}], excluded: {razlog: n}, total }
 */
function collectMissing({ backfill, processed, watchState, registry, gate, from, to, now = Date.now() }) {
    const reg = new Map((registry.podcasts || []).map((p) => [p.slug, p]));
    const missing = [];
    const excluded = {};
    const ex = (k) => { excluded[k] = (excluded[k] || 0) + 1; };
    let total = 0;
    for (const [slug, ch] of Object.entries(backfill.channels || {})) {
        const p = reg.get(slug) || {};
        for (const [id, o] of Object.entries(ch.originals || {})) {
            if (!o.date || o.date < from || o.date > to) continue;
            total++;
            if (processed.has(id)) { ex('obrađeno'); continue; }
            if (o.published_at && now - Date.parse(o.published_at) < FRESH_HOURS * 3600000) { ex('presvježe (< 3 h)'); continue; }
            const seen = watchState.channels?.[slug]?.seen?.[id];
            if (PROMO_RE.test(o.title || '') || (seen && ['derivative', 'short'].includes(seen.cls))) { ex('derivat ([PROMO]/isječak)'); continue; }
            if (p.tracking?.process === false) { ex('samo praćenje (process:false)'); continue; }
            if (gate) {
                const r = gate.checkProcessing({ uc: p.youtube?.channel_id, slug });
                if (r.skip) { ex(r.unavailable ? 'postavke nedostupne' : 'kanal isključen (postavke)'); continue; }
            }
            missing.push({ id, slug, date: o.date, title: o.title || '', duration: o.duration || null,
                tier: ch.tracked || p.tracking?.enabled === true ? 1 : 2, channel_id: p.youtube?.channel_id || null });
        }
    }
    missing.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug.localeCompare(b.slug)));
    return { missing, excluded, total };
}

/**
 * Razlog po epizodi. `jobs` = Map youtube_id → najnoviji job (aktivni imaju prednost),
 * `allEp` = all_episodes.json episodes, `prev` = prošli missing.json po ID-u,
 * `pause` = { until: 'HH:MM' } kad poller stoji zbog YouTube anti-bota.
 */
function reasonFor(ep, { jobs, allEp, prev, pause }) {
    const a = allEp[ep.id] || {};
    const p = prev[ep.id] || {};
    const attempts = (a.attempts || 0) + (p.sent || 0);
    const job = jobs.get(ep.id);
    const lastTry = [a.sent_at, p.last_sent_at, job && job.updated_at && new Date(job.updated_at * 1000).toISOString()]
        .filter(Boolean).sort().pop() || null;
    const base = { attempts, sent: p.sent || 0, last_try: lastTry, last_error: (job && job.error) || a.error || null };
    if (ep.tier === 1) return { ...base, reason: 'tier1', note: 'praćeni kanal — obrađuje nightly KORAK 1' };
    if (job && ACTIVE_STATES.includes(job.state)) {
        const note = job.state === 'queued' && pause ? `pauza anti-bot do ${pause.until}` : job.state;
        return { ...base, reason: 'queued', note, last_error: null };
    }
    if (job && job.state === 'failed') {
        const step = failedStep(job.error);
        if (NO_RETRY_STEPS.has(step) || attempts >= MAX_ATTEMPTS) return { ...base, reason: 'gave_up', note: `failed:${step}` };
        return { ...base, reason: `failed:${step}` };
    }
    if (job && job.state === 'done') return { ...base, reason: 'failed:objava', note: 'job done, a article.json nije na CDN-u' };
    if (attempts >= MAX_ATTEMPTS) return { ...base, reason: 'gave_up' };
    return { ...base, reason: 'never_seen' };
}

/** Treba li epizodu poslati u red. */
function shouldEnqueue(r) {
    if (r.tier === 1 || r.attempts >= MAX_ATTEMPTS) return false;
    return r.reason === 'never_seen' || (r.reason.startsWith('failed:') && r.reason !== 'failed:objava');
}

// ─── ulazi ────────────────────────────────────────────────────────────

function processedIds() {
    const c = readJson(FILES.r2cache, null);
    const keys = c ? Object.keys(c.sizes || c.keys || {}) : [];
    const s = new Set();
    for (const k of keys) { const m = /^data\/([^/]+)\/article\.json$/.exec(k); if (m) s.add(m[1]); }
    return s;
}

/** Poller ne claima dok je marker svjež (bridge/priority_poller.js antiBotSince). */
function antiBotPause(now = Date.now()) {
    const m = readJson(FILES.antibot, null);
    const at = m && Date.parse(m.at);
    if (!Number.isFinite(at) || now - at >= ANTIBOT_COOLDOWN_MIN * 60000) return null;
    const until = new Date(at + ANTIBOT_COOLDOWN_MIN * 60000);
    return { until: until.toTimeString().slice(0, 5), source: m.source, video_id: m.video_id };
}

async function fetchJobs(key) {
    const get = async (state) => {
        const res = await fetch(`${BASE}/api/jobs?state=${state}&limit=200`, { headers: { authorization: `Bearer ${key}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()).jobs || [];
    };
    const [active, failed, done] = await Promise.all([get(ACTIVE_STATES.join(',')), get('failed'), get('done')]);
    const m = new Map();
    // Prednost: aktivni > najnoviji pali > done (lista je created_at DESC).
    for (const j of [...active, ...failed, ...done]) if (!m.has(j.youtube_id)) m.set(j.youtube_id, j);
    return m;
}

// ─── izlaz ────────────────────────────────────────────────────────────

const ORDER = ['never_seen', 'failed', 'queued', 'gave_up', 'tier1'];
const groupKey = (r) => (r.reason.startsWith('failed:') ? 'failed' : r.reason);

function render(doc) {
    const out = [];
    out.push(`📋 Epizode koje fale na domovina.ai: ${doc.from} … ${doc.to}`);
    out.push(`   originala ${doc.total}, fali ${doc.episodes.length}; isključeno: ${Object.entries(doc.excluded).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`);
    if (doc.pause) out.push(`   ⏸️  poller stoji: YouTube anti-bot (${doc.pause.source}, ${doc.pause.video_id}) do ${doc.pause.until}`);
    const groups = {};
    for (const e of doc.episodes) (groups[groupKey(e)] ||= []).push(e);
    for (const g of ORDER) {
        const list = groups[g];
        if (!list) continue;
        out.push('', `── ${g} (${list.length})`);
        for (const e of list) {
            const extra = [e.reason !== g ? e.reason : null, e.note, e.attempts ? `pokušaja ${e.attempts}` : null,
                e.last_error ? e.last_error.slice(0, 90) : null, e.enqueued ? `→ ${e.enqueued}` : null].filter(Boolean).join(' · ');
            out.push(`   ${e.date} ${e.id} [${e.slug}] ${e.title.slice(0, 60)}${extra ? `  (${extra})` : ''}`);
        }
    }
    return out.join('\n');
}

function summaryLine(doc) {
    const c = {};
    for (const e of doc.episodes) c[groupKey(e)] = (c[groupKey(e)] || 0) + 1;
    const parts = ORDER.filter((g) => c[g]).map((g) => `${g} ${c[g]}`);
    return `Fali na domovina.ai (${doc.from}…${doc.to}): ${doc.episodes.length} od ${doc.total}` +
        (parts.length ? ` — ${parts.join(', ')}` : '') + (doc.enqueued ? `. Poslano u red: ${doc.enqueued}.` : '.') +
        (doc.pause ? ` Poller stoji (anti-bot) do ${doc.pause.until}.` : '');
}

// ─── main ─────────────────────────────────────────────────────────────

async function main() {
    const DRY = args.includes('--dry-run');
    const ENQUEUE = args.includes('--enqueue') && process.env.MISSING_OFF !== '1';
    const channelSettings = require('../lib/channel_settings');
    const { readUsage, loadEnvKey } = require('./all_episodes_lib');

    const to = localDate();
    const from = localDate(new Date(Date.now() - (WINDOW_DAYS - 1) * 86400000));
    const gate = ENQUEUE ? channelSettings.gate() : channelSettings.readerGate();
    const { missing, excluded, total } = collectMissing({
        backfill: readJson(FILES.backfill, { channels: {} }), processed: processedIds(),
        watchState: readJson(FILES.watchState, { channels: {} }), registry: readJson(FILES.registry, { podcasts: [] }),
        gate, from, to,
    });
    const key = loadEnvKey(REPO);
    let jobs = new Map(), jobsError = null;
    if (key) jobs = await fetchJobs(key).catch((e) => { jobsError = e.message; return new Map(); });
    else jobsError = 'nema PIPELINE_QUEUE_INGEST_KEY';
    const prevDoc = readJson(FILES.missing, { episodes: [] });
    // Brojač slanja živi u `sent_log` (svi ID-evi u prozoru), ne u popisu: epizoda koja
    // privremeno ispadne s popisa (npr. job u tijeku) ne smije izgubiti pokušaje.
    const prev = { ...(prevDoc.sent_log || {}) };
    const allEp = readJson(FILES.allEpisodes, { episodes: {} }).episodes || {};
    const pause = antiBotPause();
    const episodes = missing.map((ep) => ({ ...ep, ...reasonFor(ep, { jobs, allEp, prev, pause }) }));

    const doc = { generated_at: new Date().toISOString(), from, to, window_days: WINDOW_DAYS, total, excluded,
        ...(pause ? { pause } : {}), ...(jobsError ? { jobs_error: jobsError } : {}), episodes };

    if (ENQUEUE) await enqueue(doc, { key, DRY, readUsage, gateAvailable: gate.available, jobsError });

    doc.sent_log = {};
    for (const [id, v] of Object.entries(prev)) if (v.last_sent_at && v.last_sent_at.slice(0, 10) >= from) doc.sent_log[id] = v;
    for (const e of episodes) if (e.sent) doc.sent_log[e.id] = { sent: e.sent, last_sent_at: e.last_sent_at || prev[e.id]?.last_sent_at };
    if (!DRY) {
        fs.writeFileSync(FILES.missing, JSON.stringify(doc, null, 1) + '\n');
    }
    if (args.includes('--json')) console.log(JSON.stringify(doc, null, 1));
    else console.log(render(doc));
    if (jobsError) console.log(`   ⚠️  red nečitljiv (${jobsError}) — razlozi bez stanja jobova`);

    if (args.includes('--telegram') && !DRY && doc.episodes.some((e) => e.reason !== 'tier1')) {
        const { notify } = require('../lib/notify_telegram');
        notify(`missing-${to}`, summaryLine(doc), { details: render(doc), cooldownH: 20 });
    }
}

async function enqueue(doc, { key, DRY, readUsage, gateAvailable, jobsError }) {
    const todo = doc.episodes.filter(shouldEnqueue);
    console.log(`📤 Za slanje u red: ${todo.length} (never_seen + failed, Tier 2, < ${MAX_ATTEMPTS} pokušaja)`);
    if (!todo.length) return;
    if (!key) { console.log('   ⚠️  nema PIPELINE_QUEUE_INGEST_KEY — ne šaljem'); return; }
    if (jobsError) { console.log(`   ⛔ stanje reda nepoznato (${jobsError}) — ne šaljem`); return; }
    if (!gateAvailable) { console.log('   ⛔ postavke kanala nedostupne — ne šaljem nijedan job'); return; }
    const usage = await readUsage().catch((e) => ({ error: e.message }));
    if (usage.error) console.log(`   ⚠️  kvota nečitljiva (${usage.error}) — šaljem bez ograde`);
    else if (usage.seven_day >= MAX_WEEKLY) { console.log(`   ⛔ tjedni ${usage.seven_day} % ≥ ${MAX_WEEKLY} % — ne šaljem`); return; }
    const tally = {};
    for (let i = 0; i < todo.length; i++) {
        const e = todo[i];
        const label = `${e.id} [${e.slug}] ${e.title.slice(0, 60)} (${e.reason})`;
        if (DRY) { console.log(`   (dry) ${label}`); continue; }
        let res, data = {};
        try {
            res = await fetch(`${BASE}/api/jobs`, {
                method: 'POST',
                headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
                // Isti parametri kao enqueue_all_new.js.
                body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${e.id}`, title: e.title || undefined,
                    priority: true, transcription: 'soniox', article_model: 'claude:opus', with_magisterium: true,
                    skip_published: true, llm_force: true }),
            });
            data = await res.json().catch(() => ({}));
        } catch (err) { e.enqueued = 'error'; e.last_error = err.message; }
        if (res && res.status === 429) {
            console.log(`   ⛔ red je pun — ostatak (${todo.length - i}) idući nightly`);
            for (const r of todo.slice(i)) r.enqueued = 'queue_full';
            break;
        }
        if (res && !res.ok) { e.enqueued = 'error'; e.last_error = `HTTP ${res.status}: ${data.error || ''}`; }
        else if (res && data.skipped === 'published') e.enqueued = 'published';
        else if (res && data.deduped) e.enqueued = 'deduped';
        else if (res) e.enqueued = 'created';
        if (e.enqueued === 'created' || e.enqueued === 'deduped') {
            e.sent = (e.sent || 0) + 1; e.attempts += 1; e.last_sent_at = new Date().toISOString(); e.last_try = e.last_sent_at;
            e.note = `poslano sada (bio ${e.reason})`; e.reason = 'queued';
        }
        tally[e.enqueued] = (tally[e.enqueued] || 0) + 1;
        console.log(`   ${e.enqueued === 'created' ? '➕' : e.enqueued === 'error' ? '❌' : '='} ${label} → ${e.enqueued}${e.enqueued === 'error' ? ' ' + e.last_error : ''}`);
    }
    doc.enqueued = Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ');
}

if (require.main === module) {
    main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
module.exports = { collectMissing, reasonFor, shouldEnqueue, failedStep, summaryLine, render, MAX_ATTEMPTS };
