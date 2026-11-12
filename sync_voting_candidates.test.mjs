// node --test sync_voting_candidates.test.mjs — postavke kanala u glasačkom bazenu (S7 točka 6).
// Uvoz NE pokreće main() (nema mreže, Supabasea ni R2).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { filterOwnerWithdrawn } from "./sync_voting_candidates.mjs";

const require = createRequire(import.meta.url);
const cs = require("./lib/channel_settings.js");

test("(g) voting: povučen ili obrisan UC nije u skupu kandidata", () => {
  const UC_W = "UCaaaaaaaaaaaaaaaaaaaaaa", UC_D = "UCdddddddddddddddddddddd";
  const UC_H = "UChhhhhhhhhhhhhhhhhhhhhh", UC_N = "UCnnnnnnnnnnnnnnnnnnnnnn";
  const g = cs.gateFromSnapshot({ ok: true, settings: {
    [UC_W]: { status: "withdrawn", off: [] },
    [UC_D]: { status: "deleted", off: [] },
    [UC_H]: { status: "active", off: ["home_featured"] },
  } }, { registryPath: "/nepostojeci/registry.json" });
  const p = (slug, uc) => ({ slug, youtube: { url: `https://www.youtube.com/channel/${uc}`, channel_id: uc } });
  const all = [p("povucen", UC_W), p("obrisan", UC_D), p("home-off", UC_H), p("normalan", UC_N), { slug: "bez-uc", youtube: { url: "https://x" } }];
  const { kept, dropped } = filterOwnerWithdrawn(all, g);
  assert.deepEqual(kept.map((x) => x.slug), ["home-off", "normalan", "bez-uc"]);
  assert.deepEqual(dropped.map((d) => d.uc), [UC_W, UC_D]);
  // bez postavki: isti skup
  const g0 = cs.gateFromSnapshot({ ok: true, settings: {} }, { registryPath: "/nepostojeci/registry.json" });
  assert.equal(filterOwnerWithdrawn(all, g0).kept.length, all.length);
});
