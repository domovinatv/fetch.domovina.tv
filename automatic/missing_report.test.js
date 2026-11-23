const test = require('node:test');
const assert = require('node:assert/strict');
const { collectMissing, reasonFor, shouldEnqueue, failedStep, summaryLine } = require('./missing_report.js');

const NOW = Date.parse('2026-11-23T08:00:00Z');
const backfill = { channels: {
    'hrt-nedjeljom-u-2': { tracked: false, originals: {
        h8qR80bc5VY: { date: '2026-11-16', published_at: '2026-11-16T01:01:00Z', title: 'Nedjeljom u 2: Časno je biti novinar' },
        STARIvideo1: { date: '2026-11-01', title: 'izvan prozora' },
    } },
    'digitalna-kultura': { tracked: false, originals: {
        tW71sjw4Lr4: { date: '2026-11-19', title: 'Je li ovo najbolja igra svih vremena?' },
        GOTOVvideo1: { date: '2026-11-19', title: 'obrađena' },
    } },
    'ora-et-labora': { tracked: true, originals: { ORAvideo001: { date: '2026-11-20', title: 'povučen kanal' } } },
    'neki-kanal': { tracked: false, originals: {
        PROMOvideo1: { date: '2026-11-22', title: '[PROMO] Nova sezona' },
        ISJECAK0001: { date: '2026-11-22', title: 'Isječak' },
        LIVEsad0001: { date: '2026-11-23', published_at: '2026-11-23T07:00:00Z', title: 'Uživo sada' },
    } },
    'praceni': { tracked: true, originals: { TIER1vid001: { date: '2026-11-22', title: 'Tier 1' } } },
} };
const registry = { podcasts: [
    { slug: 'ora-et-labora', youtube: { channel_id: 'UCora' }, tracking: { enabled: true } },
    { slug: 'praceni', tracking: { enabled: true } },
] };
const gate = { checkProcessing: ({ slug }) => (slug === 'ora-et-labora' ? { skip: true, reason: 'povučen' } : { skip: false }) };
const watchState = { channels: { 'neki-kanal': { seen: { ISJECAK0001: { cls: 'derivative' } } } } };

const run = () => collectMissing({ backfill, processed: new Set(['GOTOVvideo1']), watchState, registry, gate,
    from: '2026-11-10', to: '2026-11-23', now: NOW });

test('collectMissing: prozor, obrađeni, povučeni, [PROMO], derivat, presvježe', () => {
    const { missing, excluded } = run();
    assert.deepEqual(missing.map((m) => m.id), ['TIER1vid001', 'tW71sjw4Lr4', 'h8qR80bc5VY']);
    assert.equal(excluded['obrađeno'], 1);
    assert.equal(excluded['kanal isključen (postavke)'], 1);
    assert.equal(excluded['derivat ([PROMO]/isječak)'], 2);
    assert.equal(excluded['presvježe (< 3 h)'], 1);
    assert.equal(missing.find((m) => m.id === 'TIER1vid001').tier, 1);
});

const ep = { id: 'h8qR80bc5VY', tier: 2 };
const ctx = (o = {}) => ({ jobs: new Map(), allEp: {}, prev: {}, pause: null, ...o });

test('reasonFor: never_seen → šalje se', () => {
    const r = reasonFor(ep, ctx());
    assert.equal(r.reason, 'never_seen');
    assert.ok(shouldEnqueue({ ...ep, ...r }));
});

test('reasonFor: queued uz anti-bot pauzu nije pad', () => {
    const jobs = new Map([[ep.id, { state: 'queued', updated_at: 1795417559 }]]);
    const r = reasonFor(ep, ctx({ jobs, allEp: { [ep.id]: { attempts: 1 } }, pause: { until: '08:05' } }));
    assert.equal(r.reason, 'queued');
    assert.equal(r.note, 'pauza anti-bot do 08:05');
    assert.equal(shouldEnqueue({ ...ep, ...r }), false);
});

test('reasonFor: failed:<korak>, pa gave_up nakon 3 pokušaja (zbroj s enqueue_all_new)', () => {
    const jobs = new Map([[ep.id, { state: 'failed', error: 'YouTube anti-bot (Sign in to confirm) — download blokiran' }]]);
    let r = reasonFor(ep, ctx({ jobs, allEp: { [ep.id]: { attempts: 1 } } }));
    assert.equal(r.reason, 'failed:download');
    assert.ok(shouldEnqueue({ ...ep, ...r }));
    r = reasonFor(ep, ctx({ jobs, allEp: { [ep.id]: { attempts: 2 } }, prev: { [ep.id]: { sent: 1 } } }));
    assert.equal(r.reason, 'gave_up');
    assert.equal(shouldEnqueue({ ...ep, ...r }), false);
});

test('reasonFor: video bez zvuka se ne ponavlja; Tier 1 se samo prijavljuje', () => {
    const jobs = new Map([[ep.id, { state: 'failed', error: 'video nema zvuka (max -91 dB) — ASR preskočen, ne ponavlja se' }]]);
    assert.equal(reasonFor(ep, ctx({ jobs })).reason, 'gave_up');
    const t1 = reasonFor({ id: 'x', tier: 1 }, ctx());
    assert.equal(t1.reason, 'tier1');
    assert.equal(shouldEnqueue({ tier: 1, ...t1 }), false);
});

test('failedStep prepoznaje korake iz grešaka bridgea', () => {
    assert.equal(failedStep('prioritetni download nije uspio (private/anti-bot?) — nema info.json u _unlisted'), 'download');
    assert.equal(failedStep('ASR: nema prijepisa nakon svih izvora — Soniox greška: organization_balance_exhausted'), 'asr');
    assert.equal(failedStep('nešto treće'), 'ostalo');
});

test('summaryLine', () => {
    const s = summaryLine({ from: '2026-11-10', to: '2026-11-23', total: 5, episodes: [
        { reason: 'never_seen' }, { reason: 'failed:asr' }, { reason: 'queued' }], enqueued: 'created 2', pause: { until: '08:05' } });
    assert.match(s, /3 od 5 — never_seen 1, failed 1, queued 1\. Poslano u red: created 2\. Poller stoji \(anti-bot\) do 08:05\./);
});
