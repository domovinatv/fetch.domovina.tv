const test = require('node:test');
const assert = require('node:assert/strict');
const { foreignFragments, missingResults } = require('./magisterium_mcp_episode.js');

test('foreignFragments: hrvatski prolazi, druga pisma i dijakritici ne', () => {
    assert.equal(foreignFragments('Čovjek, đak, šuma, žaba, ćup — „navodnici” i 90 %'), 0);
    assert.ok(foreignFragments('Katolიცizam vrednuje yhteisöllisyyttä') >= 3);   // 29.10.2026.
    assert.ok(foreignFragments('ovo не valja') > 0);
    assert.ok(foreignFragments('λόγος') > 0);
    assert.ok(foreignFragments('ու արդարորեն rozděluje') >= 3);   // objavljeno 28.10.2026.
});

test('missingResults: broji indekse bez rezultata, pokvaren JSON = sve fali', () => {
    const ok = '```json\n{"results":[{"index":0,"score":80},{"index":1,"score":70}]}\n```\nReferences:';
    assert.equal(missingResults(ok, [0, 1]), 0);
    assert.equal(missingResults(ok, [0, 1, 2]), 1);
    assert.equal(missingResults('{"results":[{"index":0,"score":80},"enrichment":"x"}', [0, 1, 2]), 3);
    assert.equal(missingResults('nema jsona', [0]), 1);
});
