const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
    parseRpcBody, toolResultToResponse, responseToRawText, jobToTasks, createRateLimiter, isRateLimit,
} = require("./tools/magisterium_mcp_client.js");
const { foreignFragments, findArticle } = require("./tools/magisterium_mcp_episode.js");

test("parseRpcBody čita čisti JSON i SSE, bira poruku po id-u", () => {
    assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{"a":1}}', "application/json", 1).result, { a: 1 });
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'
        + 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(sse, "text/event-stream", 7).result, { ok: true });
    assert.equal(parseRpcBody(": ping\n\n", "text/event-stream", 1), null);
});

test("toolResultToResponse: JSON u text bloku → {answer, references}", () => {
    const r = toolResultToResponse({ content: [{ type: "text", text: JSON.stringify({ answer: "A", references: [{ document_title: "T" }] }) }] });
    assert.equal(r.answer, "A");
    assert.equal(r.references.length, 1);
});

test("toolResultToResponse: rate limit dolazi kao isError i prepoznaje se", () => {
    const res = { isError: true, content: [{ type: "text", text: '{"error":"rate_limit_exceeded","message":"Too many requests."}' }] };
    assert.throws(() => toolResultToResponse(res), e => isRateLimit(e));
    assert.equal(isRateLimit(new Error("MCP tools/call HTTP 504: timeout")), false);
});

test("responseToRawText daje References: format koji assemble parsira", () => {
    const raw = responseToRawText({ answer: '{"x":1} [^1]', references: [{ document_title: "Catechism", document_author: "Church", document_reference: "2293" }] });
    assert.match(raw, /References:\n\[\^1\]\. Catechism \(Church\), 2293\n$/);
});

test("jobToTasks: holistički prvi, batchovi s nul-paddingom", () => {
    const t = jobToTasks({ holisticPrompt: "H", batches: [{ batchIndex: 0, prompt: "B0" }, { batchIndex: 11, prompt: "B11" }] });
    assert.deepEqual(t.map(x => x.name), ["holistic", "batch_00", "batch_11"]);
});

test("createRateLimiter: najviše rpm startova u 60 s", async () => {
    let now = 0;
    const sleeps = [];
    const acquire = createRateLimiter(2, () => now, async ms => { sleeps.push(ms); now += ms; });
    await acquire(); await acquire(); await acquire();
    assert.equal(sleeps.length, 1);
    assert.ok(now >= 60000);
});

test("foreignFragments: hrvatski prolazi, ćirilica i litavski ne", () => {
    assert.equal(foreignFragments("Čovjek, žena, đak i šešir — ćud."), 0);
    assert.ok(foreignFragments("Ovo je теологија") > 0);
    assert.ok(foreignFragments("dvasinis gyvenimą") > 0);
});

test("findArticle: pravi kanal pobjeđuje _unlisted, preskače .en/.magisterium i ._", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "magfind-"));
    for (const d of ["kanal", "_unlisted"]) fs.mkdirSync(path.join(root, d));
    const b = "20261021_x_yt_ABCDEFGHIJK.wav.canary.diarized";
    for (const f of [`${b}_2026-10-21_gemini-3.8-flash.article.json`, `${b}_2026-10-22_opus.article.json`,
        `${b}_2026-10-23_zzz.article.en.json`, `${b}_2026-10-23_zzz.article.magisterium.json`, `._${b}_2026-10-24_zzz.article.json`]) {
        fs.writeFileSync(path.join(root, "kanal", f), "{}");
    }
    fs.writeFileSync(path.join(root, "_unlisted", `${b}_2026-10-25_opus.article.json`), "{}");
    const a = findArticle("ABCDEFGHIJK", null, root);
    assert.equal(a.channel, "kanal");
    assert.match(a.path, /2026-10-22_opus\.article\.json$/);
    assert.equal(findArticle("NEMA0000000", null, root), null);
});

test("assemble čita .mcp.json: source_url sa servera, naslov s ugniježđenim zagradama", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magasm-"));
    const articlePath = path.join(dir, "a.article.json");
    fs.writeFileSync(articlePath, JSON.stringify({ iterations: [{ iteration_number: 1, theme: "T", sections: [{ subtitle: "S0", content: "c" }] }] }));
    const job = { basename: "a", articlePath, podcastTitle: "a", batchSize: 1, sectionCount: 1,
        batches: [{ batchIndex: 0, sectionRefs: [{ localIndex: 0, globalIndex: 0, itIdx: 0, secIdx: 0, subtitle: "S0" }] }] };
    const jobPath = path.join(dir, "a.job.json");
    fs.writeFileSync(jobPath, JSON.stringify(job));
    const res = path.join(dir, "res");
    fs.mkdirSync(res);
    const nested = { document_title: "Lumen Gentium (Dogmatic Constitution (on the Church))", document_author: "Vatican II",
        document_reference: "para-8", source_url: "https://www.magisterium.com/docs/uuid-1/ref/para-8" };
    fs.writeFileSync(path.join(res, "batch_00.mcp.json"), JSON.stringify({
        answer: '{"results":[{"index":0,"score":84,"assessment":"Usklađeno [^1].","concerns":[],"enrichment":"Kontekst."}]}',
        references: [nested],
    }));
    fs.writeFileSync(path.join(res, "holistic.mcp.json"), JSON.stringify({
        answer: '{"overall_score":90,"assessment":"Dobro.","seeds_of_logos":[],"concerns":[],"theological_context":"KKC."}',
        references: [nested],
    }));
    const out = path.join(dir, "out.json");
    const r = spawnSync("node", ["magisterium_mcp_assemble.js", "--job", jobPath, "--results-dir", res, "--out", out,
        "--doc-registry", path.join(dir, "nema.json")], { cwd: __dirname, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(fs.readFileSync(out, "utf-8"));
    const mag = d.iterations[0].sections[0].magisterium;
    assert.equal(mag.score, 84);
    assert.equal(d.overall_score, 84);
    assert.equal(mag.citations[0].document_title, nested.document_title);
    assert.equal(mag.citations[0].source_url, nested.source_url);
});
