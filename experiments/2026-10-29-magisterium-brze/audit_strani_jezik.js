// Audit objavljenih HR Magisterium datoteka: strano pismo / slova kojih nema u hrvatskom.
// node experiments/2026-10-29-magisterium-brze/audit_strani_jezik.js [--json]
const fs = require('fs');
const path = require('path');
const { foreignFragments } = require('../../tools/magisterium_mcp_episode.js');
const ROOT = path.join(__dirname, '..', '..', 'storage', 'output');
const RE = /[^\P{L}\p{Script=Latin}]|[ąęėįųūõäöåěřůňťďýĺľŕ]/iu;
const hits = [];
let total = 0;
for (const ch of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!(ch.isDirectory() || ch.isSymbolicLink())) continue;
    let files; try { files = fs.readdirSync(path.join(ROOT, ch.name)); } catch { continue; }
    for (const f of files.filter(f => !f.startsWith('._') && f.endsWith('.article.magisterium.json'))) {
        total++;
        const j = JSON.parse(fs.readFileSync(path.join(ROOT, ch.name, f), 'utf-8'));
        const texts = (j.iterations || []).flatMap(it => it.sections.map(s => s.magisterium).filter(Boolean)
            .flatMap(m => [m.assessment, m.enrichment, ...(m.concerns || [])]));
        // overall: samo tekst modela, bez naslova/autora citata (Schönstatt, Jörgen su ispravni)
        if (j.overall) texts.push(JSON.stringify(j.overall, (k, v) => /^(citations|document_|source_url)/.test(k) ? undefined : v));
        const bad = texts.filter(t => foreignFragments(t) > 0);
        if (bad.length) {
            const t = bad[0], i = t.search(RE);
            hits.push({ channel: ch.name, id: (f.match(/_yt_(.{11})/g) || []).pop()?.slice(4), fields: bad.length, sample: t.slice(Math.max(0, i - 40), i + 40) });
        }
    }
}
if (process.argv.includes('--json')) console.log(JSON.stringify(hits, null, 1));
else for (const h of hits) console.log(`${h.channel}\t${h.id}\t${h.fields}\t${h.sample.replace(/\s+/g, ' ')}`);
console.log(`\n${hits.length}/${total} datoteka ima strane fragmente`);
