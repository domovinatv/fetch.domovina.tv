#!/usr/bin/env node
/**
 * magisterium_mcp_client.js — Magisterium MCP BEZ LLM-a u petlji.
 *
 * Zove Magisterium MCP server (https://mcp.magisterium.com) IZRAVNO preko MCP
 * JSON-RPC-a (streamable HTTP), pod korisnikovom Pro pretplatom (OAuth token,
 * scope mcp:access). NIJE Magisterium API i NE koristi MAGISTERIUM_API_KEY.
 *
 * Zamjenjuje korake 2-3 runbooka docs/MAGISTERIUM_MCP_RUN.md: umjesto da Claude
 * agent šalje svaki prompt kao zaseban model-turn (kontekst raste do 200-260k,
 * 45 s - 4 min po pozivu), skripta pošalje sve promptove iz job.json (default
 * sekvencijalno: server propušta ~2.5 chata/min, paralelno samo skuplja rate_limit),
 * čeka na rate_limit_exceeded, ponovi time-out i spremi:
 *   <results>/holistic.mcp.json + holistic.raw.txt
 *   <results>/batch_NN.mcp.json + batch_NN.raw.txt
 * *.mcp.json = strukturirani odgovor {answer, references[]} (reference nose
 * source_url) — magisterium_mcp_assemble.js ga čita izravno, bez parsiranja teksta.
 *
 * Uporaba:
 *   node tools/magisterium_mcp_client.js login          # jednom: OAuth u browseru
 *   node tools/magisterium_mcp_client.js tools          # provjera: popis MCP alata
 *   node tools/magisterium_mcp_client.js run --job <job.json> [--results-dir <dir>]
 *        [--concurrency 1] [--rpm 15] [--timeout-sec 240] [--retries 3] [--force]
 *
 * Token: ~/.config/magisterium-mcp/token.json (0600, IZVAN repoa), auto-refresh.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const MCP_URL = process.env.MAGISTERIUM_MCP_URL || 'https://mcp.magisterium.com';
const AS_META_URL = 'https://www.magisterium.com/.well-known/oauth-authorization-server';
const SCOPE = 'openid email mcp:access';
const CALLBACK_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const TOKEN_PATH = process.env.MAGISTERIUM_MCP_TOKEN
    || path.join(os.homedir(), '.config', 'magisterium-mcp', 'token.json');
const PROTOCOL_VERSION = '2025-06-18';

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

// ─── Čiste funkcije (testirane u magisterium_mcp_client.test.js) ─────────────

// Streamable HTTP odgovor je ili čisti JSON ili SSE (`data: {...}` linije).
// Vrati JSON-RPC poruku s traženim id-em (ili prvu s result/error).
function parseRpcBody(body, contentType, wantId) {
    if (!/event-stream/i.test(contentType || '')) return JSON.parse(body);
    const msgs = [];
    for (const ev of body.split(/\r?\n\r?\n/)) {
        const data = ev.split(/\r?\n/).filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        try { msgs.push(JSON.parse(data)); } catch { /* keep-alive / neispravan event */ }
    }
    return msgs.find(m => m.id === wantId) || msgs.find(m => m.result || m.error) || null;
}

// tools/call result → {answer, references}. Magisterium chat vraća JSON u text bloku.
function toolResultToResponse(result) {
    if (!result) throw new Error('prazan tools/call result');
    if (result.structuredContent && typeof result.structuredContent.answer === 'string') {
        return result.structuredContent;
    }
    const text = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    if (result.isError) throw new Error(`MCP alat vratio grešku: ${text.slice(0, 300)}`);
    let j;
    try { j = JSON.parse(text); } catch { return { answer: text, references: [] }; }
    if (typeof j.answer !== 'string') throw new Error(`neočekivan oblik odgovora: ${text.slice(0, 200)}`);
    return { answer: j.answer, references: j.references || [] };
}

// {answer, references} → sirovi tekst u formatu koji je dosad Claude ručno spremao
// (kompatibilno s magisterium_mcp_assemble.js .raw.txt putem i za ljudski pregled).
function responseToRawText(r) {
    let txt = (r.answer || '').trim() + '\n\nReferences:\n';
    (r.references || []).forEach((x, i) => {
        txt += `[^${i + 1}]. ${x.document_title} (${x.document_author || ''}), ${x.document_reference || ''}\n`;
    });
    return txt;
}

const RATE_LIMIT_WAIT_MS = 20000;
const RATE_LIMIT_MAX_WAITS = 30;
function isRateLimit(err) {
    return /rate_limit_exceeded|Too many requests|HTTP 429/i.test((err && err.message) || '');
}

// job.json → popis poslova {name, prompt}
function jobToTasks(job) {
    const tasks = [{ name: 'holistic', prompt: job.holisticPrompt }];
    for (const b of job.batches) {
        tasks.push({ name: `batch_${String(b.batchIndex).padStart(2, '0')}`, prompt: b.prompt });
    }
    return tasks;
}

// Klizni prozor: najviše `rpm` startova u bilo kojih 60 s (dijeljeno među workerima).
function createRateLimiter(rpm, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms))) {
    const starts = [];
    let chain = Promise.resolve();
    return function acquire() {
        const p = chain.then(async () => {
            for (;;) {
                const t = now();
                while (starts.length && t - starts[0] >= 60000) starts.shift();
                if (starts.length < rpm) { starts.push(t); return; }
                await sleep(60000 - (t - starts[0]) + 50);
            }
        });
        chain = p.catch(() => {});
        return p;
    };
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

function loadToken() {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
}
function saveToken(t) {
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2), { mode: 0o600 });
}
async function asMeta() {
    const r = await fetch(AS_META_URL);
    if (!r.ok) throw new Error(`AS metadata HTTP ${r.status}`);
    return r.json();
}
function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function tokenRequest(meta, params) {
    const r = await fetch(meta.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(params).toString(),
    });
    const body = await r.text();
    if (!r.ok) throw new Error(`token endpoint HTTP ${r.status}: ${body.slice(0, 300)}`);
    return JSON.parse(body);
}
function withExpiry(tok, prev) {
    return {
        ...prev, ...tok,
        refresh_token: tok.refresh_token || (prev && prev.refresh_token),
        expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
    };
}

async function login() {
    const meta = await asMeta();
    let saved = loadToken() || {};
    if (!saved.client_id) {
        const r = await fetch(meta.registration_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_name: 'domovina.ai pipeline (fetch.domovina.tv)',
                redirect_uris: [REDIRECT_URI],
                grant_types: ['authorization_code', 'refresh_token'],
                response_types: ['code'],
                token_endpoint_auth_method: 'none',
                scope: SCOPE,
            }),
        });
        const body = await r.text();
        if (!r.ok) throw new Error(`registracija klijenta HTTP ${r.status}: ${body.slice(0, 300)}`);
        const reg = JSON.parse(body);
        saved = { client_id: reg.client_id, client_secret: reg.client_secret || null };
        saveToken(saved);
        console.log(`✅ Klijent registriran: ${reg.client_id}`);
    }
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const authUrl = `${meta.authorization_endpoint}?` + new URLSearchParams({
        response_type: 'code', client_id: saved.client_id, redirect_uri: REDIRECT_URI,
        scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256',
        resource: MCP_URL,
    }).toString();

    const code = await new Promise((resolve, reject) => {
        const srv = http.createServer((req, res) => {
            const u = new URL(req.url, REDIRECT_URI);
            if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
            const err = u.searchParams.get('error');
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(err ? `Greška: ${err}` : 'Magisterium MCP: prijava gotova, možeš zatvoriti karticu.');
            srv.close();
            if (err) return reject(new Error(`OAuth greška: ${err} ${u.searchParams.get('error_description') || ''}`));
            if (u.searchParams.get('state') !== state) return reject(new Error('OAuth state se ne poklapa'));
            resolve(u.searchParams.get('code'));
        });
        srv.listen(CALLBACK_PORT, '127.0.0.1', () => {
            console.log(`🔐 Otvori u browseru (čekam callback na ${REDIRECT_URI}):\n${authUrl}`);
        });
        setTimeout(() => { srv.close(); reject(new Error('OAuth: istekao rok od 10 min')); }, 600000).unref();
    });

    const params = {
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
        client_id: saved.client_id, code_verifier: verifier, resource: MCP_URL,
    };
    if (saved.client_secret) params.client_secret = saved.client_secret;
    const tok = await tokenRequest(meta, params);
    saveToken(withExpiry(tok, saved));
    console.log(`✅ Token spremljen: ${TOKEN_PATH} (refresh_token: ${tok.refresh_token ? 'da' : 'NE'})`);
}

let refreshing = null;
async function accessToken(force = false) {
    const t = loadToken();
    if (!t || !t.access_token) throw new Error(`nema tokena — pokreni: node tools/magisterium_mcp_client.js login`);
    if (!force && (!t.expires_at || t.expires_at - Date.now() > 120000)) return t.access_token;
    if (!t.refresh_token) throw new Error('token istekao, nema refresh_tokena — ponovi login');
    if (!refreshing) {
        refreshing = (async () => {
            const meta = await asMeta();
            const params = { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id, resource: MCP_URL };
            if (t.client_secret) params.client_secret = t.client_secret;
            const nt = withExpiry(await tokenRequest(meta, params), t);
            saveToken(nt);
            return nt.access_token;
        })().finally(() => { refreshing = null; });
    }
    return refreshing;
}

// ─── MCP sesija (streamable HTTP) ────────────────────────────────────────────

let rpcId = 0;
async function rpc(session, method, params, { timeoutMs = 60000, notify = false } = {}) {
    const id = notify ? undefined : ++rpcId;
    for (let attempt = 0; attempt < 2; attempt++) {
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${await accessToken(attempt > 0)}`,
            'MCP-Protocol-Version': PROTOCOL_VERSION,
        };
        if (session.id) headers['Mcp-Session-Id'] = session.id;
        const r = await fetch(MCP_URL, {
            method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
        });
        if (r.status === 401 && attempt === 0) continue;   // istekao token → refresh pa ponovi
        const sid = r.headers.get('mcp-session-id');
        if (sid) session.id = sid;
        const body = await r.text();
        if (!r.ok) throw new Error(`MCP ${method} HTTP ${r.status}: ${body.slice(0, 300)}`);
        if (notify) return null;
        const msg = parseRpcBody(body, r.headers.get('content-type'), id);
        if (!msg) throw new Error(`MCP ${method}: nema JSON-RPC odgovora`);
        if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
        return msg.result;
    }
}

async function openSession() {
    const session = { id: null };
    const init = await rpc(session, 'initialize', {
        protocolVersion: PROTOCOL_VERSION, capabilities: {},
        clientInfo: { name: 'domovina-magisterium-client', version: '1.0.0' },
    });
    await rpc(session, 'notifications/initialized', {}, { notify: true });
    session.server = init.serverInfo;
    return session;
}

// ─── Naredbe ─────────────────────────────────────────────────────────────────

async function cmdTools() {
    const s = await openSession();
    const res = await rpc(s, 'tools/list', {});
    console.log(`Server: ${JSON.stringify(s.server)}`);
    for (const t of res.tools) {
        console.log(`- ${t.name}: ${JSON.stringify(Object.keys((t.inputSchema || {}).properties || {}))}`);
    }
}

async function cmdRun() {
    const jobPath = getArg('--job');
    if (!jobPath) { console.error('Uporaba: run --job <job.json> [--results-dir <dir>]'); process.exit(1); }
    const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));
    const resultsDir = getArg('--results-dir') || jobPath.replace(/\.job\.json$/, '.results');
    // 1 je namjerno: paralelni chat pozivi samo skupljaju rate_limit_exceeded,
    // propusnost ostaje ista (~2.5/min), vidi docs/2026-10-24-magisterium-mcp-bez-llm-a.md
    const concurrency = parseInt(getArg('--concurrency') || '1', 10);
    const rpm = parseInt(getArg('--rpm') || '15', 10);
    const timeoutMs = parseInt(getArg('--timeout-sec') || '240', 10) * 1000;
    const retries = parseInt(getArg('--retries') || '3', 10);
    const force = args.includes('--force');
    fs.mkdirSync(resultsDir, { recursive: true });

    const all = jobToTasks(job);
    const tasks = all.filter(t => force || !fs.existsSync(path.join(resultsDir, `${t.name}.mcp.json`)));
    console.log(`✝️  Magisterium MCP (izravno, bez LLM-a) — ${job.basename}`);
    console.log(`   Poziva: ${tasks.length}/${all.length} (ostalo već gotovo) | concurrency ${concurrency} | ${rpm} req/min`);
    console.log(`   Rezultati: ${resultsDir}`);

    const t0 = Date.now();
    const session = await openSession();
    const acquire = createRateLimiter(rpm);
    const stats = [];
    let next = 0;
    async function worker() {
        while (next < tasks.length) {
            const task = tasks[next++];
            // rate_limit_exceeded NIJE kvar: server propušta ~2.5 chata/min po korisniku
            // (izmjereno 24.10.2026.), pa se na njega samo čeka i ne troši retry budžet.
            let attempt = 1, rlWaits = 0;
            for (;;) {
                await acquire();
                const ts = Date.now();
                try {
                    const result = await rpc(session, 'tools/call',
                        { name: 'chat', arguments: { prompt: task.prompt } }, { timeoutMs });
                    const resp = toolResultToResponse(result);
                    fs.writeFileSync(path.join(resultsDir, `${task.name}.mcp.json`), JSON.stringify(resp, null, 1));
                    fs.writeFileSync(path.join(resultsDir, `${task.name}.raw.txt`), responseToRawText(resp));
                    const sec = (Date.now() - ts) / 1000;
                    stats.push({ name: task.name, sec, attempt, rate_limit_waits: rlWaits, refs: resp.references.length });
                    console.log(`   ✅ ${task.name}  ${sec.toFixed(1)} s  refs=${resp.references.length}`
                        + `${attempt > 1 ? `  (pokušaj ${attempt})` : ''}${rlWaits ? `  (rate-limit čekanja: ${rlWaits})` : ''}`);
                    break;
                } catch (e) {
                    if (isRateLimit(e) && rlWaits < RATE_LIMIT_MAX_WAITS) {
                        rlWaits++;
                        await new Promise(r => setTimeout(r, RATE_LIMIT_WAIT_MS));
                        continue;
                    }
                    console.log(`   ⚠️  ${task.name} pokušaj ${attempt}: ${e.message.slice(0, 160)}`);
                    if (attempt > retries) { stats.push({ name: task.name, failed: true }); break; }
                    await new Promise(r => setTimeout(r, 5000 * attempt));
                    attempt++;
                }
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));

    const ok = stats.filter(s => !s.failed);
    const failed = stats.filter(s => s.failed);
    const wall = (Date.now() - t0) / 1000;
    const avg = ok.length ? ok.reduce((a, s) => a + s.sec, 0) / ok.length : 0;
    console.log(`\n📊 Gotovo: ${ok.length} OK, ${failed.length} neuspjelih | zid ${wall.toFixed(1)} s | prosjek ${avg.toFixed(1)} s/poziv`);
    // ponovljeni run (npr. 2b retry) ne smije pregaziti mjerenja prvog runa
    const statsPath = path.join(resultsDir, 'client_stats.json');
    if (fs.existsSync(statsPath)) fs.renameSync(statsPath, path.join(resultsDir, `client_stats.${Date.now()}.json`));
    fs.writeFileSync(statsPath,
        JSON.stringify({ wall_sec: wall, concurrency, rpm, calls: stats }, null, 1));
    if (failed.length) {
        console.log(`❌ Neuspjeli: ${failed.map(f => f.name).join(', ')} — ponovi isti run (preskače gotove)`);
        process.exit(2);
    }
}

if (require.main === module) {
    const cmd = args[0];
    const fn = { login, tools: cmdTools, run: cmdRun }[cmd];
    if (!fn) { console.error('Naredbe: login | tools | run --job <job.json>'); process.exit(1); }
    fn().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
}

module.exports = { parseRpcBody, toolResultToResponse, responseToRawText, jobToTasks, createRateLimiter, isRateLimit, openSession, rpc };
