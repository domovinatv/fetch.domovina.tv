// node --test import_to_vertex.test.js — ograda ai_assistants (S7 točka 6). Ne zove Vertex/GCS.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cs = require("./lib/channel_settings");
const { filterByAiAssistants } = require("./import_to_vertex");

test("ai_assistants off ili povučen kanal → izvan Vertex importa; nedostupan izvor → ništa", () => {
    const UC_AI = "UCaaaaaaaaaaaaaaaaaaaaaa", UC_W = "UCwwwwwwwwwwwwwwwwwwwwww";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vtx-"));
    const mk = (dir, id, uc) => {
        fs.mkdirSync(path.join(root, dir), { recursive: true });
        const base = `20261110_x_yt_${id}`;
        fs.writeFileSync(path.join(root, dir, `${base}.info.json`), JSON.stringify({ channel_id: uc }));
        return { localPath: path.join(root, dir, `${base}.rag_combined.jsonl`), channel: dir, filename: `${base}.rag_combined.jsonl` };
    };
    const files = [mk("ai_off", "aaaaaaaaaaa", UC_AI), mk("povucen", "wwwwwwwwwww", UC_W), mk("normalan", "nnnnnnnnnnn", "UCnnnnnnnnnnnnnnnnnnnnnn")];
    const opts = { registryPath: "/nepostojeci/registry.json" };
    const g = cs.gateFromSnapshot({ ok: true, settings: {
        [UC_AI]: { status: "active", off: ["ai_assistants"] },
        [UC_W]: { status: "withdrawn", off: [] },
    } }, opts);
    const r = filterByAiAssistants(files, g);
    assert.deepEqual(r.kept.map((f) => f.channel), ["normalan"]);
    assert.equal(r.skipped.length, 2);
    const down = filterByAiAssistants(files, cs.gateFromSnapshot({ ok: false, error: "HTTP 503" }, opts));
    assert.equal(down.kept.length, 0);
});
