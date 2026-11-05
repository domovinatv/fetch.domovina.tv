const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveEpisodes, staleEnParts } = require('./enqueue_en_new.js');
const { enStaleBySource } = require('../translate_to_english.js');

const B = '20260730_005_naslov_yt_WRE248YCIeI';
const art = (date) => `${B}.wav.canary.diarized_${date}_opus.article.json`;

test('kanal ima prednost; _unlisted s novijim člankom = čeka prijenos u kanal (05.11. utrka)', () => {
    const eps = resolveEpisodes([
        { name: '_unlisted', files: [art('2026-11-05')] },
        { name: 'domovina_tv', files: [art('2026-07-31'), `${B}.wav.canary.diarized_2026-07-31_opus.article.en.json`] },
    ]);
    assert.equal(eps.length, 1);
    assert.equal(eps[0].channel, 'domovina_tv');
    assert.equal(eps[0].date, '2026-07-31');
    assert.equal(eps[0].waitChannel, true);
});

test('isti stem u oba, isti generated_at → ne čeka; različit → čeka', () => {
    const dirs = [{ name: '_unlisted', files: [art('2026-11-05')] }, { name: 'domovina_tv', files: [art('2026-11-05')] }];
    assert.equal(resolveEpisodes(dirs, () => 'X')[0].waitChannel, false);
    assert.equal(resolveEpisodes(dirs, (ch) => (ch === '_unlisted' ? 'NOVI' : 'STARI'))[0].waitChannel, true);
});

test('samo _unlisted (ad-hoc) → kandidat bez čekanja', () => {
    const eps = resolveEpisodes([{ name: '_unlisted', files: [art('2026-11-05')] }]);
    assert.equal(eps[0].channel, '_unlisted');
    assert.equal(eps[0].waitChannel, false);
});

const ok = (ga) => ({ status: 200, ga });
const miss = { status: 404, ga: null };

test('staleEnParts: CDN još servira stari HR članak → null (čekaj objavu)', () => {
    assert.equal(staleEnParts({ article: 'N' }, { article: ok('S') }), null);
});

test('staleEnParts: EN još ne postoji → [] (posao običnog EN joba, ne force)', () => {
    assert.deepEqual(staleEnParts({ article: 'N' }, { article: ok('N'), articleEn: miss }), []);
});

test('staleEnParts: EN iz starog članka + stari sažetak + stari Magisterium (b-nls1ck8EE)', () => {
    const parts = staleEnParts(
        { article: 'N', summary: 'NS', mag: 'NM' },
        { article: ok('N'), articleEn: ok('2026-03-27'), summaryEn: ok('OS'), magHr: ok('NM'), magEn: ok('OM') },
    );
    assert.deepEqual(parts, ['article', 'summary', 'magisterium']);
});

test('staleEnParts: nedostajući summary/Magisterium EN NIJE zastario (bez backfilla starih rupa)', () => {
    assert.deepEqual(staleEnParts(
        { article: 'N', summary: 'NS', mag: 'NM' },
        { article: ok('N'), articleEn: ok('N'), summaryEn: miss, magHr: ok('NM'), magEn: miss },
    ), []);
});

test('staleEnParts: WRE248YCIeI — EN članak iz starog HR-a (summary 404 nadopuni isti run)', () => {
    assert.deepEqual(staleEnParts({ article: 'N', summary: 'NS' }, { article: ok('N'), articleEn: ok('2026-07-31'), summaryEn: miss }), ['article']);
});

test('staleEnParts: HR Magisterium još nije na CDN-u → EN Magisterium nije zastario', () => {
    assert.deepEqual(staleEnParts(
        { article: 'N', summary: 'NS', mag: 'NM' },
        { article: ok('N'), articleEn: ok('N'), summaryEn: ok('NS'), magHr: ok('OLD'), magEn: miss },
    ), []);
});

test('staleEnParts: sve svježe → [] (bez petlje, KLPD-Meu4e8)', () => {
    assert.deepEqual(staleEnParts(
        { article: 'N', summary: 'NS', mag: 'NM' },
        { article: ok('N'), articleEn: ok('N'), summaryEn: ok('NS'), magHr: ok('NM'), magEn: ok('NM') },
    ), []);
});

test('translate_to_english: postojeći EN iz drugog HR izvora je zastario', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'en-stale-'));
    const w = (n, o) => { fs.writeFileSync(path.join(d, n), JSON.stringify(o)); return path.join(d, n); };
    const src = w('a.json', { metadata: { generated_at: '2026-11-05T09:30:14Z' } });
    assert.equal(enStaleBySource(src, w('old.en.json', { metadata: { generated_at: '2026-07-31T10:48:35Z' } })), true);
    assert.equal(enStaleBySource(src, w('new.en.json', { metadata: { generated_at: '2026-11-05T09:30:14Z' } })), false);
    const sum = w('s.json', { generated_at: 'S1' });
    assert.equal(enStaleBySource(sum, w('s.en.json', { generated_at: 'S1' })), false);
    assert.equal(enStaleBySource(sum, path.join(d, 'nema.json')), true);
});
