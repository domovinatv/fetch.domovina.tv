#!/usr/bin/env node
/**
 * enqueue_magisterium_backfill.js — auto-enqueue Magisterium obrade za NOVE epizode
 * praćenih kanala (automatic/full_backfill_channels.txt).
 *
 * SEMANTIKA (2026-07-16): automatika pokriva SAMO NOVE epizode — one koje se u channel
 * indexu pojave NAKON što je kanal uvršten u config. Pri prvom viđenju kanala skripta
 * snimi BASELINE (snapshot svih tadašnjih video ID-jeva u automatic/full_backfill_state.json)
 * i taj run NIŠTA ne enqueuea. Stare rupe (video u baselineu bez Magisteriuma) NIKAD se
 * ne enqueueaju automatski — puni povijesni backfill uvijek ide RUČNO na zahtjev
 * (admin gumb "🕊 Mag HR/EN" ili in-session subagent-po-epizodi).
 *
 * Za svaki praćeni kanal povuče channel index s CDN-a (channels/data/{channel}.json);
 * video koji NIJE u baselineu, ima objavljen HR članak (pipeline.has_article) a nema
 * Magisterium (pipeline.has_magisterium=false) → POST /api/magisterium (dedupe za
 * queued/running radi worker). Launchd Magisterium poller (magisterium_pipeline.sh →
 * bridge/magisterium_poller.js) ga zatim obradi. Nightly objavi novu epizodu u 03:00,
 * sljedeći tick (10 min) je enqueuea → efektivno "svaku noć samo novo".
 *
 * Zaštite od beskonačnog retryja (worker dedupe NE pokriva 'failed'):
 *   - video s >= MAGBF_MAX_FAILED failed pokušaja → trajno preskočen (kao MAX_BLOCKED_RETRIES)
 *   - video s failed pokušajem mlađim od MAGBF_RETRY_HOURS → pričekaj (grace retry)
 *
 * Env:
 *   PIPELINE_QUEUE_BASE        (default https://pipeline.domovina.ai)
 *   PIPELINE_QUEUE_INGEST_KEY  (obavezno — bez njega soft-exit 0, ništa ne radi)
 *   CDN_BASE                   (default https://cdn.domovina.ai)
 *   MAGBF_CHANNELS_FILE        (default automatic/full_backfill_channels.txt)
 *   MAGBF_STATE_FILE           (default automatic/full_backfill_state.json — gitignored, machine-local)
 *   MAGBF_MAX_ENQUEUE          (default 25 — cap novih jobova po runu, zaštita od mass-enqueuea)
 *   MAGBF_RETRY_HOURS          (default 24 — grace prije ponovnog pokušaja nakon faila)
 *   MAGBF_MAX_FAILED           (default 3 — nakon toliko failova video se više ne enqueuea)
 *
 * Sve NE-fatalno: greška po kanalu/videu se logira i nastavlja se dalje (launchd tick ne smije pasti).
 */
const fs = require('fs');
const path = require('path');

const PIPELINE_QUEUE_BASE = (process.env.PIPELINE_QUEUE_BASE || 'https://pipeline.domovina.ai').replace(/\/$/, '');
const INGEST_KEY = process.env.PIPELINE_QUEUE_INGEST_KEY;
const CDN_BASE = (process.env.CDN_BASE || 'https://cdn.domovina.ai').replace(/\/$/, '');
const CHANNELS_FILE = process.env.MAGBF_CHANNELS_FILE || path.join(__dirname, 'full_backfill_channels.txt');
const STATE_FILE = process.env.MAGBF_STATE_FILE || path.join(__dirname, 'full_backfill_state.json');
const MAX_ENQUEUE = parseInt(process.env.MAGBF_MAX_ENQUEUE || '25', 10);
const RETRY_HOURS = parseFloat(process.env.MAGBF_RETRY_HOURS || '24');
const MAX_FAILED = parseInt(process.env.MAGBF_MAX_FAILED || '3', 10);

if (!INGEST_KEY) {
    console.log('⏭️  PIPELINE_QUEUE_INGEST_KEY nije postavljen — preskačem Magisterium backfill enqueue.');
    process.exit(0);
}

// Kanali iz config datoteke: "channel_id" ili "channel_id +EN"; '#' komentar, prazno preskoči.
function loadChannels() {
    if (!fs.existsSync(CHANNELS_FILE)) return [];
    return fs.readFileSync(CHANNELS_FILE, 'utf8')
        .split('\n')
        .map((l) => l.replace(/#.*$/, '').trim())
        .filter(Boolean)
        .map((l) => {
            const parts = l.split(/\s+/);
            return { channel: parts[0], withEn: parts.slice(1).some((p) => p.toUpperCase() === '+EN') };
        });
}

// Baseline state: { channels: { <channel>: { adopted_at, baseline: [ids...] } } }
function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return { channels: {} };
    }
}
function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

async function api(method, pathname, body) {
    const res = await fetch(PIPELINE_QUEUE_BASE + pathname, {
        method,
        headers: { authorization: 'Bearer ' + INGEST_KEY, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${await res.text()}`);
    return res.json();
}

// Channel index s CDN-a — cache-buster query da ne dobijemo stari CF edge-cache manifesta.
async function fetchChannelIndex(channel) {
    const url = `${CDN_BASE}/channels/data/${channel}.json?magbf=${Date.now()}`;
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return res.json();
}

(async () => {
    const channels = loadChannels();
    if (!channels.length) {
        console.log(`⏭️  Nema kanala u ${CHANNELS_FILE} — ništa za backfill enqueue.`);
        return;
    }
    const state = loadState();
    if (!state.channels) state.channels = {};

    // Failed povijest: youtube_id|lang → { count, lastSec } (grace retry + trajni skip).
    const failedMap = new Map();
    try {
        const { jobs } = await api('GET', '/api/magisterium?state=failed&limit=500');
        for (const j of jobs) {
            const key = `${j.youtube_id}|${j.lang}`;
            const prev = failedMap.get(key) || { count: 0, lastSec: 0 };
            failedMap.set(key, { count: prev.count + 1, lastSec: Math.max(prev.lastSec, j.updated_at || 0) });
        }
    } catch (e) {
        console.log(`⚠️ Ne mogu dohvatiti failed jobove (${e.message}) — nastavljam bez grace provjere.`);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    let enqueued = 0, deduped = 0, skippedFailed = 0, stateDirty = false;

    for (const { channel, withEn } of channels) {
        let index;
        try {
            index = await fetchChannelIndex(channel);
        } catch (e) {
            console.log(`⚠️ ${channel}: channel index nedostupan (${e.message}) — preskačem kanal.`);
            continue;
        }
        const videos = Array.isArray(index.videos) ? index.videos : [];

        // Prvo viđenje kanala → snimi baseline i NIŠTA ne enqueuea (stare rupe = ručni posao).
        if (!state.channels[channel]) {
            state.channels[channel] = {
                adopted_at: new Date().toISOString(),
                baseline: videos.map((v) => v.id),
            };
            stateDirty = true;
            const oldGaps = videos.filter((v) => v.pipeline?.has_article && !v.pipeline?.has_magisterium).length;
            console.log(`📌 ${channel}: adoptiran — baseline ${videos.length} videa (${oldGaps} starih rupa OSTAJE za ručni backfill). Ubuduće samo NOVE epizode.`);
            continue;
        }

        const baseline = new Set(state.channels[channel].baseline);

        // Kandidati: NOVE epizode (nisu u baselineu) s HR člankom bez Magisteriuma
        // (+ EN varijanta ako je kanal označen +EN).
        const wanted = [];
        for (const v of videos) {
            if (baseline.has(v.id)) continue;
            const p = v.pipeline || {};
            if (p.has_article && !p.has_magisterium) wanted.push({ id: v.id, lang: 'hr' });
            if (withEn && p.has_article_en && !p.has_magisterium_en) wanted.push({ id: v.id, lang: 'en' });
        }
        if (!wanted.length) {
            console.log(`✅ ${channel}: nema novih epizoda za Magisterium (${videos.length} videa, baseline ${baseline.size}).`);
            continue;
        }
        console.log(`🕊 ${channel}: ${wanted.length} NOVIH kandidata za Magisterium.`);

        for (const { id, lang } of wanted) {
            if (enqueued >= MAX_ENQUEUE) {
                console.log(`🛑 Cap MAGBF_MAX_ENQUEUE=${MAX_ENQUEUE} dosegnut — ostatak na sljedećem ticku.`);
                return finish();
            }
            const fail = failedMap.get(`${id}|${lang}`);
            if (fail) {
                if (fail.count >= MAX_FAILED) {
                    console.log(`  ⛔ ${id} [${lang}] — ${fail.count}× failed → trajno preskočen (očisti failed jobove za retry).`);
                    skippedFailed++;
                    continue;
                }
                if (nowSec - fail.lastSec < RETRY_HOURS * 3600) {
                    console.log(`  ⏳ ${id} [${lang}] — failed prije <${RETRY_HOURS}h → pričekaj grace.`);
                    skippedFailed++;
                    continue;
                }
            }
            try {
                const r = await api('POST', '/api/magisterium', { youtube_id: id, lang, source: 'backfill' });
                if (r.deduped) {
                    deduped++;
                } else {
                    enqueued++;
                    console.log(`  ➕ ${id} [${lang}] → queued (${r.row?.id || '?'})`);
                }
            } catch (e) {
                console.log(`  ⚠️ ${id} [${lang}] enqueue greška: ${e.message}`);
            }
        }
    }
    finish();

    function finish() {
        if (stateDirty) saveState(state);
        console.log(`🕊 Backfill enqueue gotov: +${enqueued} novih, ${deduped} već u queueu, ${skippedFailed} preskočeno (failed/grace).`);
    }
})().catch((e) => {
    console.error('⚠️ enqueue_magisterium_backfill greška:', e.message);
    process.exit(0); // soft fail — launchd tick ne ruši ništa
});
