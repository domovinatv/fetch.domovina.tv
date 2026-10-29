// Sonda: opisi MCP alata + latencija/rate limit za search vs chat.
const { openSession, rpc, toolResultToResponse } = require('../../tools/magisterium_mcp_client.js');
(async () => {
    const s = await openSession();
    const res = await rpc(s, 'tools/list', {});
    for (const t of res.tools) console.log(`\n### ${t.name}\n${t.description}\n${JSON.stringify(t.inputSchema)}\n${t.outputSchema ? 'OUT ' + JSON.stringify(t.outputSchema) : ''}`);
    const q = process.argv[2] || 'umjetna inteligencija i ljudsko dostojanstvo rada';
    const t0 = Date.now();
    const out = [];
    for (let i = 0; i < 8; i++) {
        const ts = Date.now();
        try {
            const r = await rpc(s, 'tools/call', { name: 'search', arguments: { query: `${q} ${i}` } }, { timeoutMs: 60000 });
            const txt = (r.content || []).map(c => c.text || '').join('');
            out.push({ i, sec: (Date.now() - ts) / 1000, err: !!r.isError, len: txt.length, head: i === 0 ? txt.slice(0, 1500) : txt.slice(0, 80) });
        } catch (e) { out.push({ i, sec: (Date.now() - ts) / 1000, exc: e.message.slice(0, 120) }); }
    }
    console.log(JSON.stringify(out, null, 1), 'wall', (Date.now() - t0) / 1000);
})();
