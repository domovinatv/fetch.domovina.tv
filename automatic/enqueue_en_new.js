#!/usr/bin/env node
/**
 * enqueue_en_new.js — auto-enqueue EN prijevoda za SVE NOVE epizode (od 29.10.2026.).
 *
 * Do 29.10. EN je bio uključen samo za kanale s `+EN` u full_backfill_channels.txt, jer je
 * kroz agy trajao 3 h 41 min po epizodi. Otkad translate_to_english.js šalje jedan poziv po
 * dokumentu (~5 min/ep, $0 na pretplati) EN ide za svaku novu epizodu, i za prioritetne
 * ad-hoc videe u `_unlisted` (nemaju channel index, pa enqueue_magisterium_backfill.js ne
 * bi bio dovoljan).
 *
 * „Nova" = najnoviji HR članak epizode datiran (`_{YYYY-MM-DD}_{model}.article.json`) na ili
 * nakon EN_AUTO_SINCE. Bez baseline stanja; stari katalog se NE backfilla automatski.
 *
 * Kandidat: najnoviji članak nema `.article.en.json`, HR članak je objavljen na CDN-u (ne
 * prevodimo članak koji pipeline još piše) i, ako je kanal u full_backfill_channels.txt
 * (dobiva HR Magisterium), HR Magisterium već postoji — da EN prevede i njega u istom
 * prolazu. → POST /api/magisterium { lang: 'en' }; EN traka pollera ga obradi.
 *
 * Disk se čita u Nodeu, ne shell `find` (macOS TCC pod launchd-om, vidi CLAUDE.md).
 *
 * Env:
 *   PIPELINE_QUEUE_BASE        (default https://pipeline.domovina.ai)
 *   PIPELINE_QUEUE_INGEST_KEY  (obavezno — bez njega soft-exit 0)
 *   CDN_BASE                   (default https://cdn.domovina.ai)
 *   EN_AUTO_SINCE              (default 2026-10-29)
 *   EN_MAX_ENQUEUE             (default 10 po ticku)
 *   MAGBF_RETRY_HOURS / MAGBF_MAX_FAILED  (isto kao enqueue_magisterium_backfill.js)
 *
 *   node automatic/enqueue_en_new.js --dry-run   # samo ispiše kandidate
 *
 * Zakašnjeli reelsi (od 29.10.2026.): EN job prevodi i reels.json (→ reels.en.json), ali
 * reels.json zna nastati ili se promijeniti NAKON EN prijevoda (KORAK 9.9 u kasnijem runu).
 * Poller takav EN job preskače jer je article.en.json već na CDN-u, pa ga ovdje rješavamo
 * izravno: epizoda s EN člankom, a bez svježeg reels.en.json (otisak HR teksta, ne mtime) →
 * translate_to_english.js (prevede samo reelse, ~1 agy poziv) + upload + episode.json.
 * EN_REELS_MAX (default 3) po ticku; isti otisak najviše 3 neuspjeha, pa čeka promjenu teksta.
 */
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'storage', 'output');
const PIPELINE_QUEUE_BASE = (process.env.PIPELINE_QUEUE_BASE || 'https://pipeline.domovina.ai').replace(/\/$/, '');
const INGEST_KEY = process.env.PIPELINE_QUEUE_INGEST_KEY;
const CDN_BASE = (process.env.CDN_BASE || 'https://cdn.domovina.ai').replace(/\/$/, '');
const SINCE = process.env.EN_AUTO_SINCE || '2026-10-29';
const MAX_ENQUEUE = parseInt(process.env.EN_MAX_ENQUEUE || '10', 10);
const RETRY_HOURS = parseFloat(process.env.MAGBF_RETRY_HOURS || '24');
const MAX_FAILED = parseInt(process.env.MAGBF_MAX_FAILED || '3', 10);
const CHANNELS_FILE = path.join(__dirname, 'full_backfill_channels.txt');
const DRY_RUN = process.argv.includes('--dry-run');
const REELS_MAX = parseInt(process.env.EN_REELS_MAX || '3', 10);
const REELS_STATE_FILE = path.join(__dirname, 'logs', '.reels_en_state.json');
const REELS_MAX_TRIES = 3;

// {basename}.wav.canary.diarized_{date}_{model}.article.json — model sadrži točke (gemini-3.5-flash).
const ARTICLE_RE = /^(.*_yt_([A-Za-z0-9_-]{11}).*)_(\d{4}-\d{2}-\d{2})_(.+?)\.article\.json$/;

if (!INGEST_KEY && !DRY_RUN) {
    console.log('⏭️  PIPELINE_QUEUE_INGEST_KEY nije postavljen — preskačem EN enqueue.');
    process.exit(0);
}

function magisteriumChannels() {
    if (!fs.existsSync(CHANNELS_FILE)) return new Set();
    return new Set(fs.readFileSync(CHANNELS_FILE, 'utf8').split('\n')
        .map((l) => l.replace(/#.*$/, '').trim().split(/\s+/)[0]).filter(Boolean));
}

/** Najnoviji HR članak po videu, samo članci datirani >= SINCE. */
function collectCandidates() {
    const magCh = magisteriumChannels();
    const byId = new Map();
    for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
        if (!(entry.isDirectory() || entry.isSymbolicLink()) || entry.name.startsWith('.')) continue;
        let files;
        try { files = fs.readdirSync(path.join(OUTPUT_DIR, entry.name)); } catch { continue; }
        const set = new Set(files);
        const latest = new Map();   // id → { stem, date } (leksikografski najveći, kao downstream)
        for (const f of files) {
            if (f.startsWith('._')) continue;
            const m = f.match(ARTICLE_RE);
            if (!m) continue;
            // extractVideoId mora uzeti ZADNJI _yt_ (naslovi znaju sadržavati "_yt_").
            const ids = [...m[1].matchAll(/_yt_([A-Za-z0-9_-]{11})/g)];
            const id = ids[ids.length - 1][1];
            const stem = f.slice(0, -'.article.json'.length);
            const prev = latest.get(id);
            if (!prev || stem > prev.stem) latest.set(id, { stem, date: m[3] });
        }
        for (const [id, { stem, date }] of latest) {
            if (date < SINCE) continue;
            if (set.has(`${stem}.article.en.json`)) continue;
            const waitMag = magCh.has(entry.name) && !set.has(`${stem}.article.magisterium.json`);
            const prev = byId.get(id);
            // Ista epizoda u _unlisted i u kanalu: prednost kanalu (poller ionako bira po inventaru).
            if (prev && !prev.channel.startsWith('_')) continue;
            byId.set(id, { id, channel: entry.name, date, waitMag });
        }
    }
    return [...byId.values()];
}

/** Epizode s EN člankom čiji reels.en.json nedostaje ili je zastario (isti SINCE prozor). */
function staleReelsEn() {
    const { reelsEnStale, reelsSourceSha } = require(path.join(ROOT, 'translate_to_english.js'));
    const out = [];
    for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
        if (!(entry.isDirectory() || entry.isSymbolicLink()) || entry.name.startsWith('.')) continue;
        const dir = path.join(OUTPUT_DIR, entry.name);
        let files;
        try { files = fs.readdirSync(dir); } catch { continue; }
        const set = new Set(files);
        for (const f of files) {
            if (f.startsWith('._') || !f.endsWith('.reels.json')) continue;
            const ids = [...f.matchAll(/_yt_([A-Za-z0-9_-]{11})/g)];
            if (!ids.length) continue;
            const id = ids[ids.length - 1][1];
            const base = f.slice(0, -'.reels.json'.length);
            // Najnoviji datirani članak te epizode mora imati EN — inače reelse prevede EN job.
            const stems = files.map((x) => x.match(ARTICLE_RE)).filter((m) => m && m[1] === `${base}.wav.canary.diarized`).sort((a, b) => (a[0] < b[0] ? 1 : -1));
            const latest = stems[0];
            if (!latest || latest[3] < SINCE || !set.has(latest[0].replace(/\.article\.json$/, '.article.en.json'))) continue;
            const src = path.join(dir, f);
            if (!reelsEnStale(src, path.join(dir, `${base}.reels.en.json`))) continue;
            let sha = '';
            try { sha = reelsSourceSha(JSON.parse(fs.readFileSync(src, 'utf8'))); } catch { continue; }
            out.push({ id, channel: entry.name, sha });
        }
    }
    return out;
}

function refreshReelsEn() {
    const stale = staleReelsEn();
    if (!stale.length) return;
    let state = {};
    try { state = JSON.parse(fs.readFileSync(REELS_STATE_FILE, 'utf8')); } catch { /* prazno */ }
    let done = 0;
    for (const r of stale) {
        const tag = `${r.id} [${r.channel}]`;
        const st = state[r.id];
        if (st && st.sha === r.sha && st.tries >= REELS_MAX_TRIES) { console.log(`  ⛔ reels EN ${tag} — ${st.tries}× neuspjeh za isti tekst`); continue; }
        if (done >= REELS_MAX) { console.log(`🛑 EN_REELS_MAX=${REELS_MAX} — ostatak idući tick.`); break; }
        done++;
        if (DRY_RUN) { console.log(`  🧪 reels EN ${tag} → bi se preveo`); continue; }
        console.log(`  🎬 reels EN ${tag} — reels.en.json nedostaje ili je zastario`);
        const run = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' }).status === 0;
        const ok = run('node', ['translate_to_english.js', '--input-dir', 'storage/output', '--channel', r.channel, '--video-id', r.id])
            && run(path.join(__dirname, 'with_pipeline_lock.sh'), ['node', 'upload_to_r2.js', '--input-dir', 'storage/output', '--video-id', r.id])
            && run('node', ['build_episode_bundle.js', '--video-id', r.id]);
        state[r.id] = ok ? { sha: r.sha, tries: 0 } : { sha: r.sha, tries: (st && st.sha === r.sha ? st.tries : 0) + 1 };
        console.log(ok ? `  ✅ reels EN ${tag} objavljen` : `  ❌ reels EN ${tag} nije uspio`);
    }
    if (!DRY_RUN) {
        try { fs.writeFileSync(REELS_STATE_FILE, JSON.stringify(state, null, 1)); } catch { /* nije kritično */ }
    }
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

// GET s Range i cache-busterom (ne HEAD — Cloudflare kešira 404 po točnom URL-u).
async function cdnHas(id, name) {
    try {
        const r = await fetch(`${CDN_BASE}/data/${id}/${name}?x=${Date.now()}`, { headers: { Range: 'bytes=0-0' } });
        return r.ok || r.status === 206;
    } catch {
        return false;
    }
}

(async () => {
    try { refreshReelsEn(); } catch (e) { console.log(`⚠️ reels EN greška: ${e.message}`); }
    const candidates = collectCandidates();
    console.log(`🌐 EN auto (članci od ${SINCE}): ${candidates.length} epizoda bez EN-a.`);
    if (!candidates.length) return;

    const failedMap = new Map();
    if (!DRY_RUN) {
        try {
            const { jobs } = await api('GET', '/api/magisterium?state=failed&limit=500');
            for (const j of jobs) {
                if (j.lang !== 'en') continue;
                const prev = failedMap.get(j.youtube_id) || { count: 0, lastSec: 0 };
                failedMap.set(j.youtube_id, { count: prev.count + 1, lastSec: Math.max(prev.lastSec, j.updated_at || 0) });
            }
        } catch (e) {
            console.log(`⚠️ Ne mogu dohvatiti failed jobove (${e.message}) — nastavljam bez grace provjere.`);
        }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    let enqueued = 0, deduped = 0, waiting = 0;
    for (const c of candidates) {
        const tag = `${c.id} [${c.channel}, ${c.date}]`;
        if (c.waitMag) { console.log(`  ⏳ ${tag} — čeka HR Magisterium`); waiting++; continue; }
        if (!(await cdnHas(c.id, 'article.json'))) { console.log(`  ⏳ ${tag} — HR članak još nije na CDN-u`); waiting++; continue; }
        const fail = failedMap.get(c.id);
        if (fail && (fail.count >= MAX_FAILED || nowSec - fail.lastSec < RETRY_HOURS * 3600)) {
            console.log(`  ⛔ ${tag} — ${fail.count}× failed (grace ${RETRY_HOURS} h, max ${MAX_FAILED})`);
            continue;
        }
        if (enqueued >= MAX_ENQUEUE) { console.log(`🛑 EN_MAX_ENQUEUE=${MAX_ENQUEUE} — ostatak idući tick.`); break; }
        if (DRY_RUN) { console.log(`  🧪 ${tag} → bi se enqueueao`); enqueued++; continue; }
        try {
            const r = await api('POST', '/api/magisterium', { youtube_id: c.id, lang: 'en', source: 'en-auto' });
            if (r.deduped) deduped++;
            else { enqueued++; console.log(`  ➕ ${tag} → queued (${r.job?.id || '?'})`); }
        } catch (e) {
            console.log(`  ⚠️ ${tag} enqueue greška: ${e.message}`);
        }
    }
    console.log(`🌐 EN auto gotov: +${enqueued}${DRY_RUN ? ' (dry-run)' : ''}, ${deduped} već u queueu, ${waiting} čeka.`);
})().catch((e) => {
    console.error('⚠️ enqueue_en_new greška:', e.message);
    process.exit(0); // soft fail — launchd tick ne ruši ništa
});
