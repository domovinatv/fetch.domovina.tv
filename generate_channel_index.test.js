'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    buildHomeEpisodes, buildSearchEpisodes, pipelineBits, writeJsonStable, addDays,
} = require('./generate_channel_index.js');

function video(id, date, extra = {}) {
    return { id, title: `T ${id}`, title_hr: null, date, duration_seconds: 60, magisterium_score: null,
        pipeline: {}, abstract: null, topics: [], speakers: [], ...extra };
}

test('pipelineBits slijedi redoslijed VideoPipeline.fromBits', () => {
    assert.equal(pipelineBits({}), 0);
    assert.equal(pipelineBits({ has_transcript: true }), 1);
    assert.equal(pipelineBits({ has_article: true }), 8);
    assert.equal(pipelineBits({ has_magisterium: true }), 16);
    assert.equal(pipelineBits({ has_magisterium_en: true }), 256);
    assert.equal(pipelineBits({ has_transcript: true, has_diarized: true, has_summary: true,
        has_article: true, has_magisterium: true }), 31);
});

test('addDays preko granice mjeseca', () => {
    assert.equal(addDays('2026-10-09', -45), '2026-08-25');
});

test('home: unija 45 dana + top magisterium + najnoviji članci, bez duplikata', () => {
    const today = '2026-10-09';
    const old = [];
    for (let i = 0; i < 40; i++) {
        old.push(video(`old${String(i).padStart(2, '0')}`, `2025-0${1 + (i % 9)}-1${i % 10}`,
            { pipeline: { has_article: true } }));
    }
    const channels = [
        { id: 'a', videos: [
            video('new1', '2026-10-01'),
            video('edge', '2026-08-25'),            // točno na granici → ulazi
            video('out', '2026-08-24'),             // dan prije granice → ne
            video('mag95', '2024-01-01', { magisterium_score: 95, pipeline: { has_magisterium: true } }),
            video('mag69', '2024-01-02', { magisterium_score: 69, pipeline: { has_magisterium: true } }),
            video('magNoFlag', '2024-01-03', { magisterium_score: 99 }),
        ] },
        { id: 'b', videos: [...old, video('new1', '2026-10-01')] }, // duplikat ID-a
    ];
    const ids = buildHomeEpisodes(channels, today).map(e => e.id);
    assert.ok(ids.includes('new1'));
    assert.ok(ids.includes('edge'));
    assert.ok(ids.includes('mag95'));
    assert.ok(!ids.includes('mag69'));
    assert.ok(!ids.includes('magNoFlag'));
    assert.equal(ids.filter(i => i === 'new1').length, 1);
    // `out` nema članak → ne ulazi ni kroz pravilo 3
    assert.ok(!ids.includes('out'));
    // Točno 30 najnovijih s člankom iz `old` (svi imaju članak, nitko drugi nema)
    assert.equal(ids.filter(i => i.startsWith('old')).length, 30);
});

test('home: oblik epizode — title_hr samo kad se razlikuje, null polja izostavljena', () => {
    const [same, diff] = buildHomeEpisodes([{ id: 'k', videos: [
        video('x1', '2026-10-08', { title: 'A', title_hr: 'A', pipeline: { has_summary: true } }),
        video('x2', '2026-10-07', { title: 'B', title_hr: 'Bh', magisterium_score: 80 }),
    ] }], '2026-10-09');
    assert.deepEqual(same, { c: 'k', id: 'x1', title: 'A', date: '2026-10-08', duration_seconds: 60, p: 4 });
    assert.deepEqual(diff, { c: 'k', id: 'x2', title: 'B', title_hr: 'Bh', date: '2026-10-07',
        duration_seconds: 60, magisterium_score: 80, p: 0 });
});

test('search: imena iz objekata i stringova, prazne epizode izostavljene', () => {
    const out = buildSearchEpisodes([{ id: 'k', videos: [
        video('s1', '2026-10-01', { abstract: 'Sažetak', topics: ['vjera'],
            speakers: [{ id: 'SPEAKER_00', suggested_name: 'Ana' }, 'Ivo', { id: 'SPEAKER_02' }] }),
        video('s2', '2026-10-02'),
    ] }]);
    assert.deepEqual(out, { s1: { a: 'Sažetak', t: ['vjera'], s: ['Ana', 'Ivo'] } });
});

test('writeJsonStable: isti sadržaj ne dira datoteku ni generated_at', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gci-'));
    const p = path.join(dir, 'x.json');
    assert.equal(writeJsonStable(p, { version: 1, generated_at: 'T1', episodes: [1] }), true);
    const before = fs.readFileSync(p, 'utf-8');

    const again = { version: 1, generated_at: 'T2', episodes: [1] };
    assert.equal(writeJsonStable(p, again), false);
    assert.equal(fs.readFileSync(p, 'utf-8'), before);
    assert.equal(again.generated_at, 'T1');

    assert.equal(writeJsonStable(p, { version: 1, generated_at: 'T3', episodes: [2] }), true);
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf-8')).generated_at, 'T3');
    fs.rmSync(dir, { recursive: true });
});
