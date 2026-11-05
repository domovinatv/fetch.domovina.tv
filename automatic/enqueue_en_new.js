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
 *
 * Zakašnjeli Magisterium EN (od 04.11.2026.): ista zamka kao reelsi. Ad-hoc epizoda u
 * `_unlisted` ne čeka HR Magisterium (nije u full_backfill_channels.txt), pa EN job prevede
 * članak, a HR Magisterium stigne tek poslije (traka je serijska, ~15 min/ep) i nitko ga ne
 * prevede — 74/80 Tier 2 epizoda od 29.10. ostalo je bez article.magisterium.en.json.
 * Epizoda s EN člankom i HR Magisteriumom, a bez EN Magisteriuma → translate_to_english.js
 * (prevede samo što fali) + upload + episode.json. SAMO NAPRIJED: HR Magisterium nastao na
 * ili nakon EN_MAG_LATE_SINCE (default 2026-11-04). Stare rupe se NE popunjavaju automatski
 * (odluka 04.11.2026.: backfill tek kad nightly dokazano 100 % obradi sve nove epizode).
 * EN_MAG_MAX (default 3) po ticku; najviše 3 neuspjeha po epizodi.
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
const MAG_LATE_SINCE = process.env.EN_MAG_LATE_SINCE || '2026-11-04';
const MAG_MAX = parseInt(process.env.EN_MAG_MAX || '3', 10);
const MAG_STATE_FILE = path.join(__dirname, 'logs', '.magisterium_en_late_state.json');
const MAG_MAX_TRIES = 3;

// {basename}.wav.canary.diarized_{date}_{model}.article.json — model sadrži točke (gemini-3.5-flash).
const ARTICLE_RE = /^(.*_yt_([A-Za-z0-9_-]{11}).*)_(\d{4}-\d{2}-\d{2})_(.+?)\.article\.json$/;

const STALE_MAX = parseInt(process.env.EN_STALE_MAX || '2', 10);
const STALE_STATE_FILE = path.join(__dirname, 'logs', '.en_stale_state.json');
const STALE_MAX_TRIES = 3;

if (require.main === module && !INGEST_KEY && !DRY_RUN) {
    console.log('⏭️  PIPELINE_QUEUE_INGEST_KEY nije postavljen — preskačem EN enqueue.');
    process.exit(0);
}

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** generated_at HR dokumenta; EN je deep clone pa nosi generated_at izvora iz kojeg je preveden. */
function genAt(doc) {
    return (doc && ((doc.metadata && doc.metadata.generated_at) || doc.generated_at)) || null;
}

/** Najnoviji članak po videu u jednom direktoriju: id → { stem, date } (leksikografski, kao downstream). */
function latestArticles(files) {
    const latest = new Map();
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
    return latest;
}

/**
 * Jedan zapis po videu: { id, channel, stem, date, files, waitChannel }.
 * Kanal ima prednost pred `_unlisted`. Ponovna obrada piše novi članak PRVO u `_unlisted`,
 * a u kanal tek minutama kasnije (auto_reuse_adhoc.js --replace). U tom prozoru je EN job
 * (poller prevodi kanalski dir) preveo STARI članak kanala — 05.11.2026. pet domovina_tv
 * epizoda. Zato: dok `_unlisted` ima noviji članak od kanala, epizoda čeka (`waitChannel`).
 * `dirs` = [{ name, files }] (čisto, za testove).
 */
function resolveEpisodes(dirs, readGenAt = () => null) {
    const per = new Map();   // id → [{ channel, stem, date, files }]
    for (const d of dirs) {
        for (const [id, a] of latestArticles(d.files)) {
            if (!per.has(id)) per.set(id, []);
            per.get(id).push({ id, channel: d.name, stem: a.stem, date: a.date, files: d.files });
        }
    }
    const out = [];
    for (const [, list] of per) {
        const chans = list.filter((x) => !x.channel.startsWith('_'));
        const adhoc = list.filter((x) => x.channel.startsWith('_'));
        if (!chans.length) { out.push({ ...adhoc[0], waitChannel: false }); continue; }
        const ch = chans.sort((a, b) => (a.stem < b.stem ? 1 : -1))[0];
        const newerAdhoc = adhoc.some((u) => u.stem > ch.stem
            || (u.stem === ch.stem && readGenAt(u.channel, u.stem) !== readGenAt(ch.channel, ch.stem)));
        out.push({ ...ch, waitChannel: newerAdhoc });
    }
    return out;
}

function scanDirs() {
    const dirs = [];
    for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
        if (!(entry.isDirectory() || entry.isSymbolicLink()) || entry.name.startsWith('.')) continue;
        try { dirs.push({ name: entry.name, files: fs.readdirSync(path.join(OUTPUT_DIR, entry.name)) }); } catch { /* nedostupan */ }
    }
    return dirs;
}

const articleGenAt = (channel, stem) => genAt(readJson(path.join(OUTPUT_DIR, channel, `${stem}.article.json`)));

function magisteriumChannels() {
    if (!fs.existsSync(CHANNELS_FILE)) return new Set();
    return new Set(fs.readFileSync(CHANNELS_FILE, 'utf8').split('\n')
        .map((l) => l.replace(/#.*$/, '').trim().split(/\s+/)[0]).filter(Boolean));
}

/** Najnoviji HR članak po videu, samo članci datirani >= SINCE, bez lokalnog EN-a. */
function collectCandidates() {
    const magCh = magisteriumChannels();
    const out = [];
    for (const e of resolveEpisodes(scanDirs(), articleGenAt)) {
        if (e.date < SINCE) continue;
        const set = new Set(e.files);
        if (set.has(`${e.stem}.article.en.json`)) continue;
        const waitMag = magCh.has(e.channel) && !set.has(`${e.stem}.article.magisterium.json`);
        out.push({ id: e.id, channel: e.channel, stem: e.stem, date: e.date, waitMag, waitChannel: e.waitChannel });
    }
    return out;
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

/** Epizode s EN člankom i HR Magisteriumom (nastalim >= MAG_LATE_SINCE), a bez EN Magisteriuma. */
function lateMagisteriumEn() {
    const sinceMs = Date.parse(`${MAG_LATE_SINCE}T00:00:00`);
    const out = [];
    for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
        if (!(entry.isDirectory() || entry.isSymbolicLink()) || entry.name.startsWith('.')) continue;
        const dir = path.join(OUTPUT_DIR, entry.name);
        let files;
        try { files = fs.readdirSync(dir); } catch { continue; }
        const set = new Set(files);
        for (const f of files) {
            if (f.startsWith('._') || !f.endsWith('.article.magisterium.json')) continue;
            const stem = f.slice(0, -'.article.magisterium.json'.length);
            if (!set.has(`${stem}.article.en.json`) || set.has(`${stem}.article.magisterium.en.json`)) continue;
            // Samo Magisterium NAJNOVIJEG članka (downstream servira leksikografski najveći).
            const m = `${stem}.article.json`.match(ARTICLE_RE);
            if (!m || m[3] < SINCE) continue;
            const prefix = m[1];
            const newer = files.some((x) => { const k = x.match(ARTICLE_RE); return k && k[1] === prefix && x.slice(0, -'.article.json'.length) > stem; });
            if (newer) continue;
            let mtime = 0;
            try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch { continue; }
            if (mtime < sinceMs) continue;   // stara rupa — namjerno bez backfilla
            const ids = [...stem.matchAll(/_yt_([A-Za-z0-9_-]{11})/g)];
            if (!ids.length) continue;
            out.push({ id: ids[ids.length - 1][1], channel: entry.name });
        }
    }
    return out;
}

function refreshMagisteriumEn() {
    const late = lateMagisteriumEn();
    if (!late.length) return;
    let state = {};
    try { state = JSON.parse(fs.readFileSync(MAG_STATE_FILE, 'utf8')); } catch { /* prazno */ }
    let done = 0;
    for (const r of late) {
        const tag = `${r.id} [${r.channel}]`;
        const tries = (state[r.id] && state[r.id].tries) || 0;
        if (tries >= MAG_MAX_TRIES) { console.log(`  ⛔ Magisterium EN ${tag} — ${tries}× neuspjeh`); continue; }
        if (done >= MAG_MAX) { console.log(`🛑 EN_MAG_MAX=${MAG_MAX} — ostatak idući tick.`); break; }
        done++;
        if (DRY_RUN) { console.log(`  🧪 Magisterium EN ${tag} → bi se preveo`); continue; }
        console.log(`  🕊 Magisterium EN ${tag} — HR Magisterium stigao nakon EN prijevoda`);
        const run = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' }).status === 0;
        const ok = run('node', ['translate_to_english.js', '--input-dir', 'storage/output', '--channel', r.channel, '--video-id', r.id])
            && run(path.join(__dirname, 'with_pipeline_lock.sh'), ['node', 'upload_to_r2.js', '--input-dir', 'storage/output', '--video-id', r.id])
            && run('node', ['build_episode_bundle.js', '--video-id', r.id]);
        state[r.id] = { tries: ok ? 0 : tries + 1 };
        console.log(ok ? `  ✅ Magisterium EN ${tag} objavljen` : `  ❌ Magisterium EN ${tag} nije uspio`);
    }
    if (!DRY_RUN) {
        try { fs.writeFileSync(MAG_STATE_FILE, JSON.stringify(state, null, 1)); } catch { /* nije kritično */ }
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

/** CDN JSON s cache-busterom: { status, doc } (doc = null kad nije 200 ili nije JSON). */
async function cdnJson(id, name) {
    try {
        const r = await fetch(`${CDN_BASE}/data/${id}/${name}?x=${Date.now()}`);
        if (!r.ok) return { status: r.status, doc: null };
        try { return { status: r.status, doc: await r.json() }; } catch { return { status: r.status, doc: null }; }
    } catch {
        return { status: 0, doc: null };
    }
}

/**
 * Koji EN dijelovi na CDN-u NISU prevedeni iz trenutnog HR izvora. Čisto (za testove).
 * hr  = { article, summary, mag }   generated_at lokalnih HR dokumenata (mag/summary smiju biti null)
 * cdn = { article, articleEn, summaryEn, magEn, magHr }  { status, ga }
 * Vraća null dok CDN ne servira OVAJ HR članak (ponovna obrada još objavljuje), inače popis.
 * EN koji još ne postoji (404) nije „zastario" — to je posao običnog EN joba (collectCandidates).
 */
function staleEnParts(hr, cdn) {
    if (cdn.article.status !== 200 || cdn.article.ga !== hr.article) return null;
    if (cdn.articleEn.status !== 200) return [];
    const parts = [];
    if (cdn.articleEn.ga !== hr.article) parts.push('article');
    // Zastario = POSTOJI na CDN-u, ali iz drugog HR izvora. Nedostajući summary/Magisterium EN
    // nije razlog za run: to su stare rupe (74/80 Tier 2 bez Magisterium EN), a backfill je
    // isključen (odluka 04.11.2026.). Kad se prijevod ionako pokrene, translate nadopuni i njih.
    if (hr.summary && cdn.summaryEn.status === 200 && cdn.summaryEn.ga !== hr.summary) parts.push('summary');
    // Magisterium EN samo kad CDN već servira ovaj HR Magisterium (inače ga čeka HR traka).
    if (hr.mag && cdn.magEn.status === 200 && cdn.magHr.status === 200 && cdn.magHr.ga === hr.mag && cdn.magEn.ga !== hr.mag) parts.push('magisterium');
    return parts;
}

function stashDir(channel, id) {
    const real = fs.realpathSync(path.join(OUTPUT_DIR, channel));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    return path.join(path.dirname(real), '.reprocess_bak', channel, `${id}_${stamp}_en_stale`);
}

/**
 * EN na CDN-u preveden iz STARIJEG HR izvora (ponovna obrada, ili EN job u prozoru dok je
 * kanal još imao stari članak) → skloni zastarjele lokalne .en.json (rename u .reprocess_bak,
 * nikad delete), prevedi iz trenutnog HR-a, prepiši CDN (force_upload: PUT + purge s i bez
 * Origina + episode.json). Bez enqueuea: poller bi takav job preskočio jer article.en.json
 * postoji na CDN-u, a idući tick bi ga opet ubacio (KLPD-Meu4e8, 199×, 05.11.2026.).
 * Stanje po potpisu HR izvora: isti potpis najviše STALE_MAX_TRIES pokušaja, a potvrđeno
 * svjež potpis se više ne provjerava (nema CDN zahtjeva po ticku za cijeli prozor).
 */
async function refreshStaleEn() {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(STALE_STATE_FILE, 'utf8')); } catch { /* prazno */ }
    let done = 0;
    for (const e of resolveEpisodes(scanDirs(), articleGenAt)) {
        if (e.date < SINCE || e.waitChannel) continue;
        const dir = path.join(OUTPUT_DIR, e.channel);
        const set = new Set(e.files);
        const hr = {
            article: articleGenAt(e.channel, e.stem),
            summary: genAt(readJson(path.join(dir, e.files.find((f) => f.includes(`_yt_${e.id}`) && f.endsWith('.canary.summary.json')) || '-'))),
            mag: set.has(`${e.stem}.article.magisterium.json`) ? genAt(readJson(path.join(dir, `${e.stem}.article.magisterium.json`))) : null,
        };
        if (!hr.article) continue;
        const sig = `${hr.article}|${hr.summary || ''}|${hr.mag || ''}`;
        const st = state[e.id];
        if (st && st.sig === sig && (st.fresh || st.tries >= STALE_MAX_TRIES)) continue;

        const get = async (n) => { const r = await cdnJson(e.id, n); return { status: r.status, ga: genAt(r.doc) }; };
        const cdn = { article: await get('article.json') };
        if (cdn.article.status !== 200 || cdn.article.ga !== hr.article) continue;
        cdn.articleEn = await get('article.en.json');
        if (cdn.articleEn.status !== 200) continue;
        cdn.summaryEn = await get('summary.en.json');
        cdn.magHr = hr.mag ? await get('article.magisterium.json') : { status: 0 };
        cdn.magEn = hr.mag ? await get('article.magisterium.en.json') : { status: 0 };
        const parts = staleEnParts(hr, cdn);
        if (!parts) continue;
        if (!parts.length) { state[e.id] = { sig, fresh: true }; continue; }

        const tag = `${e.id} [${e.channel}]`;
        if (done >= STALE_MAX) { console.log(`🛑 EN_STALE_MAX=${STALE_MAX} — ostatak idući tick.`); break; }
        done++;
        if (DRY_RUN) { console.log(`  🧪 zastario EN ${tag}: ${parts.join(', ')} → bi se preveo ponovno`); continue; }
        console.log(`  ♻️  zastario EN ${tag}: ${parts.join(', ')} preveden iz starijeg HR-a — prevodim ponovno`);

        // Skloni lokalne EN-ove starijih stemova i one iz drugog HR izvora.
        const toStash = e.files.filter((f) => f.includes(`_yt_${e.id}`) && !f.startsWith('._') && (
            (/\.article(\.magisterium)?\.en\.json$/.test(f) && !f.startsWith(`${e.stem}.`))
            || (parts.includes('summary') && f.endsWith('.canary.summary.en.json'))
            || (parts.includes('article') && f === `${e.stem}.article.en.json`)
            || (parts.includes('magisterium') && f === `${e.stem}.article.magisterium.en.json`)));
        if (toStash.length) {
            const bak = stashDir(e.channel, e.id);
            fs.mkdirSync(bak, { recursive: true });
            for (const f of toStash) { fs.renameSync(path.join(dir, f), path.join(bak, f)); console.log(`    🗄 ${f.slice(-60)} → ${bak}`); }
        }
        const run = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' }).status === 0;
        const lock = path.join(__dirname, 'with_pipeline_lock.sh');
        const ok = run('node', ['translate_to_english.js', '--input-dir', 'storage/output', '--channel', e.channel, '--video-id', e.id])
            && run(lock, ['bash', '-c', [
                `{ node generate_ebook.js --video-id ${e.id} --force || true; }`,
                // Novi ključevi (reels.en.json, book.en.epub prvi put) + prepis immutable data/*.
                `node upload_to_r2.js --input-dir storage/output --video-id ${e.id}`,
                `node force_upload.js --video-id ${e.id} --channel ${e.channel} --targets summary-en,article-en,magisterium-en`,
                `{ node tools/force_upload_epubs.js --changed-only --video-id ${e.id}; node build_episode_bundle.js --video-id ${e.id}; true; }`,
            ].join(' && ')]);
        const verified = ok && (await get('article.en.json')).ga === hr.article;
        state[e.id] = verified ? { sig, fresh: true } : { sig, tries: (st && st.sig === sig ? st.tries || 0 : 0) + 1 };
        console.log(verified ? `  ✅ EN ${tag} objavljen iz trenutnog HR-a` : `  ❌ EN ${tag} nije uspio (CDN article.en.json još nije iz trenutnog HR-a)`);
    }
    if (!DRY_RUN) {
        try { fs.writeFileSync(STALE_STATE_FILE, JSON.stringify(state, null, 1)); } catch { /* nije kritično */ }
    }
}

async function main() {
    try { refreshReelsEn(); } catch (e) { console.log(`⚠️ reels EN greška: ${e.message}`); }
    try { refreshMagisteriumEn(); } catch (e) { console.log(`⚠️ Magisterium EN greška: ${e.message}`); }
    try { await refreshStaleEn(); } catch (e) { console.log(`⚠️ zastarjeli EN greška: ${e.message}`); }
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
        if (c.waitChannel) { console.log(`  ⏳ ${tag} — _unlisted ima noviji članak, čeka prijenos u kanal`); waiting++; continue; }
        if (c.waitMag) { console.log(`  ⏳ ${tag} — čeka HR Magisterium`); waiting++; continue; }
        // Ne samo 200: CDN mora servirati OVAJ članak (ponovna obrada zna imati stari na CDN-u).
        const cdnArticle = await cdnJson(c.id, 'article.json');
        if (cdnArticle.status !== 200 || genAt(cdnArticle.doc) !== articleGenAt(c.channel, c.stem)) { console.log(`  ⏳ ${tag} — ovaj HR članak još nije na CDN-u`); waiting++; continue; }
        // EN već na CDN-u, a lokalno ga nema (npr. nastao na drugom disku): poller bi job
        // preskočio kao gotov, a idući tick bi ga opet enqueueao. 05.11.2026. se tako
        // KLPD-Meu4e8 vrtio 199× i od 08:10 izgladnio prave EN jobove u redu.
        // Zastarjeli EN (iz starijeg HR-a) ovdje se NE enqueuea — rješava ga refreshStaleEn().
        if (await cdnHas(c.id, 'article.en.json')) { console.log(`  ✔︎ ${tag} — EN već na CDN-u (lokalno nema), preskačem`); continue; }
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
}

if (require.main === module) {
    main().catch((e) => {
        console.error('⚠️ enqueue_en_new greška:', e.message);
        process.exit(0); // soft fail — launchd tick ne ruši ništa
    });
}

module.exports = { resolveEpisodes, latestArticles, staleEnParts, genAt };
