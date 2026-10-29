#!/usr/bin/env node
/**
 * fill_citations.js — hibrid: dopuni citate po sekciji preko Magisterium MCP `search` + `fetch`.
 *
 * Zašto: `chat` vraća najviše 10 referenci po pozivu, pa kod više sekcija po pozivu
 * (batch 3/6) svaka sekcija dobije ~2,3 citata umjesto ~3,6. `search` (~3–5 s) i
 * `fetch` (~0,5 s) nemaju chat rate limit od ~2,5/min.
 *
 * Upit = Magisteriumov vlastiti tekst sekcije (assessment + enrichment), dakle dopunski
 * izvori podupiru ono što je stvarno napisano, a ne temu podcasta općenito.
 * Dopunjeni citati nose `added_by: "search"` i `cited_text` (početak odlomka iz `fetch`).
 *
 *   node fill_citations.js --in out.magisterium.json --out out.hybrid.json [--target 4] [--concurrency 1]
 */
const fs = require('fs');
const path = require('path');
const { openSession, rpc } = require('../../tools/magisterium_mcp_client.js');

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const RL_WAIT_MS = 10000;
// search/fetch dijele rate limit (izmjereno 29.10.2026.: 3 paralelna odmah padnu) → čekaj i ponovi
async function call(session, name, a, timeoutMs, stats) {
    for (let waits = 0; ; waits++) {
        try { return structured(await rpc(session, 'tools/call', { name, arguments: a }, { timeoutMs })); }
        catch (e) {
            if (!/rate_limit_exceeded|Too many requests/i.test(e.message) || waits >= 30) throw e;
            stats.rl_waits++;
            await new Promise(r => setTimeout(r, RL_WAIT_MS));
        }
    }
}

function structured(r) {
    if (r.structuredContent) return r.structuredContent;
    const text = (r.content || []).map(c => c.text || '').join('');
    if (r.isError) throw new Error(text.slice(0, 200));
    return JSON.parse(text);
}

async function main() {
    const inPath = getArg('--in'), outPath = getArg('--out');
    if (!inPath || !outPath) { console.error('Uporaba: --in <magisterium.json> --out <p> [--target 4]'); process.exit(1); }
    const target = parseInt(getArg('--target') || '4', 10);
    const concurrency = parseInt(getArg('--concurrency') || '1', 10);
    const doc = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
    const sections = doc.iterations.flatMap(it => it.sections.map(s => s.magisterium)).filter(Boolean);
    const todo = sections.filter(m => (m.citations || []).length < target);

    const t0 = Date.now();
    const session = await openSession();
    const stats = { search: [], fetch: [], added: 0, errors: 0, rl_waits: 0 };
    let next = 0;
    async function worker() {
        while (next < todo.length) {
            const m = todo[next++];
            m.citations = m.citations || [];
            const have = new Set(m.citations.map(c => c.source_url).filter(Boolean));
            const query = `${m.assessment} ${m.enrichment}`.slice(0, 700);
            try {
                let ts = Date.now();
                const sr = await call(session, 'search', { query }, 60000, stats);
                stats.search.push((Date.now() - ts) / 1000);
                for (const hit of sr.results || []) {
                    if (m.citations.length >= target) break;
                    if (have.has(hit.url)) continue;
                    ts = Date.now();
                    const f = await call(session, 'fetch', { id: hit.id }, 30000, stats);
                    stats.fetch.push((Date.now() - ts) / 1000);
                    if (!f.found) continue;
                    have.add(hit.url);
                    const text = (f.text || '').replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim();
                    m.citations.push({
                        cited_text: text.length > 300 ? text.slice(0, 300).replace(/\s\S*$/, '') + '…' : text,
                        document_title: f.title || hit.title,
                        document_author: (f.metadata && f.metadata.author) || '',
                        document_year: '',
                        document_reference: (f.metadata && f.metadata.ref) || '',
                        source_url: hit.url,
                        added_by: 'search',
                    });
                    stats.added++;
                }
            } catch (e) {
                stats.errors++;
                console.log(`   ⚠️  ${e.message.slice(0, 160)}`);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

    doc.citation_fill = { method: 'mcp search+fetch', target, added: stats.added, at: new Date().toISOString() };
    fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
    const avg = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0;
    const summary = {
        wall_sec: +((Date.now() - t0) / 1000).toFixed(1), sekcija_dopunjeno: todo.length, dodano_citata: stats.added,
        search_poziva: stats.search.length, search_avg_s: avg(stats.search), search_max_s: Math.max(0, ...stats.search),
        fetch_poziva: stats.fetch.length, fetch_avg_s: avg(stats.fetch), rate_limit_cekanja: stats.rl_waits, greske: stats.errors,
    };
    fs.writeFileSync(path.join(path.dirname(outPath), 'fill_stats.json'), JSON.stringify(summary, null, 1));
    console.log(JSON.stringify(summary));
}

main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
