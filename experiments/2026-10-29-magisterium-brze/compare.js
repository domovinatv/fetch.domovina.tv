// Usporedba article.magisterium.json: baseline (1 sekcija/poziv) vs eksperiment.
// node compare.js <baseline.json> <exp.json> [...]
const fs = require('fs');
const secs = p => JSON.parse(fs.readFileSync(p, 'utf-8')).iterations.flatMap(it => it.sections.map(s => s.magisterium));
const words = t => (t || '').split(/\s+/).filter(Boolean).length;
function summary(list) {
    const ok = list.filter(Boolean);
    const avg = f => +(ok.reduce((a, m) => a + f(m), 0) / ok.length).toFixed(1);
    return {
        sekcija: list.length, ocijenjeno: ok.length,
        score: avg(m => m.score), assess_rijeci: avg(m => words(m.assessment)),
        enrich_rijeci: avg(m => words(m.enrichment)), concerns: avg(m => m.concerns.length),
        citata: avg(m => (m.citations || []).length),
        s_url: avg(m => (m.citations || []).filter(c => c.url || c.source_url).length),
    };
}
const [base, ...exps] = process.argv.slice(2);
const b = secs(base);
console.log('baseline', JSON.stringify(summary(b)));
for (const e of exps) {
    const x = secs(e);
    const d = b.map((m, i) => (m && x[i]) ? x[i].score - m.score : null).filter(v => v !== null);
    const mad = +(d.reduce((a, v) => a + Math.abs(v), 0) / d.length).toFixed(1);
    console.log(e.split('/').slice(-2).join('/'), JSON.stringify({ ...summary(x), mean_abs_delta: mad, max_delta: Math.max(...d.map(Math.abs)) }));
}
