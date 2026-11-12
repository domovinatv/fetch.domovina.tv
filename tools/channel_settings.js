#!/usr/bin/env node
/**
 * tools/channel_settings.js — vlasnikove postavke kanala za pipeline (S7, lanac postavki kanala).
 *
 *   node tools/channel_settings.js fetch [--out <file>] [--quiet]
 *       Jedan dohvat kataloga GET /v1/settings → snimka. Exit 0 = dostupno, 2 = nedostupno
 *       (snimka s ok:false je svejedno zapisana, pa koraci rade fail-closed).
 *   node tools/channel_settings.js check --key <ključ> (--slug <s> | --uc <UC> | --file <putanja>) [--reader]
 *       Korak obrade (processing + ključ, fail-closed); --reader = samo ključ, zadnja dobra snimka.
 *       Exit 0 = smije, 3 = preskoči (razlog na stdout). Za bash korake.
 *   node tools/channel_settings.js show
 *       Sažetak snimke (CHANNEL_SETTINGS_FILE ili storage/.channel_settings.json).
 *
 * Detalji: lib/channel_settings.js, docs/2026-11-12-postavke-kanala-u-pipelineu.md.
 */
"use strict";

const path = require("path");
const cs = require("../lib/channel_settings");

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

async function main() {
    const cmd = args[0];
    if (cmd === "fetch") {
        const out = path.resolve(getArg("--out") || cs.DEFAULT_FILE);
        const snap = await cs.fetchSnapshot();
        cs.writeSnapshot(out, snap);
        if (snap.ok) cs.writeSnapshot(getArg("--last-ok") || cs.LAST_OK_FILE, snap);
        const g = cs.gateFromSnapshot(snap);
        if (!args.includes("--quiet") || !snap.ok) console.error(g.summary());
        process.exit(snap.ok ? 0 : 2);
    }
    if (cmd === "check") {
        const key = getArg("--key") || "processing";
        // Korak obrade: processing + ključ (checkStep); --reader = samo ključ, s rezervnom snimkom.
        const reader = args.includes("--reader");
        const g = reader ? cs.readerGate() : cs.gate();
        const r = g[reader ? "check" : "checkStep"]({ key, slug: getArg("--slug"), uc: getArg("--uc"), filePath: getArg("--file") && path.resolve(getArg("--file")) });
        if (r.skip) { console.log(r.reason); process.exit(3); }
        process.exit(0);
    }
    if (cmd === "show") {
        const g = cs.gate();
        console.log(g.summary());
        if (g.available) {
            for (const [uc, v] of Object.entries(g.snap.settings)) {
                console.log(`  ${uc}  ${v.status}  off=${[...cs.closeOff(v.off, v.status)].join(",")}`);
            }
        }
        process.exit(g.available ? 0 : 2);
    }
    console.error("Upotreba: tools/channel_settings.js fetch|check|show (vidi zaglavlje)");
    process.exit(1);
}

main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
