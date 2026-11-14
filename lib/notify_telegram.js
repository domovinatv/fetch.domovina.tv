/**
 * lib/notify_telegram.js — kratka obavijest u Telegram grupu ms-social-poster (14.11.2026.).
 *
 * Token bota živi samo u Workeru li.domovina.ai (repo ~/git/stepanic/linkedin-poster), pa
 * poruka ide kroz njegov `POST /telegram/document` (bearer = API_TOKEN iz .dev.vars), isti
 * put kao tools/nightly_step_report/auto.py. Worker nema tekstualni endpoint: tekst ide u
 * potpis (caption), a detalji u mali .txt prilog.
 *
 * Ograda: isti `key` šalje se najviše jednom u `cooldownH` sati (stanje u
 * storage/.telegram_alerts.json), da nightly + prioritetni slotovi svakih 90 s ne zatrpaju
 * grupu. Sve je NE-fatalno: bez tokena ili mreže samo ispiše razlog.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const POSTER = process.env.POSTER_BASE || "https://li.domovina.ai";
const POSTER_VARS = process.env.POSTER_VARS || path.join(os.homedir(), "git/stepanic/linkedin-poster/.dev.vars");
const STATE = path.join(__dirname, "..", "storage", ".telegram_alerts.json");

function token() {
    if (process.env.POSTER_API_TOKEN) return process.env.POSTER_API_TOKEN;
    try {
        const m = fs.readFileSync(POSTER_VARS, "utf-8").match(/^API_TOKEN\s*=\s*"?([^"\n]+)"?/m);
        return m ? m[1].trim() : null;
    } catch { return null; }
}

function readState() { try { return JSON.parse(fs.readFileSync(STATE, "utf-8")); } catch { return {}; } }

/** Pošalje obavijest; vrati true ako je poslana. `details` = tekst priloga (opcionalno). */
function notify(key, caption, { details = "", cooldownH = 12, log = console.log } = {}) {
    if (/^(0|off|false|no)$/i.test(process.env.TELEGRAM_ALERTS || "")) return false;
    const state = readState();
    const last = state[key] ? Date.parse(state[key]) : 0;
    if (last && Date.now() - last < cooldownH * 3600000) {
        log(`   🔕 Telegram (${key}) već poslan ${state[key]} — ograda ${cooldownH} h`);
        return false;
    }
    const tok = token();
    if (!tok) { log(`   ⚠️  Telegram: nema API_TOKEN (${POSTER_VARS}) — obavijest preskočena`); return false; }
    const tmp = path.join(os.tmpdir(), `alert-${key.replace(/[^\w-]/g, "_")}-${process.pid}.txt`);
    try {
        fs.writeFileSync(tmp, details || caption, "utf-8");
        const out = execFileSync("curl", ["-sS", "--max-time", "60", "-X", "POST",
            "-H", `Authorization: Bearer ${tok}`,
            "-F", `document=@${tmp};type=text/plain;filename=${key}.txt`,
            "--form-string", `caption=${caption.slice(0, 1000)}`,
            `${POSTER}/telegram/document`], { encoding: "utf-8" });
        if (!/"sent"\s*:\s*true|"ok"\s*:\s*true/.test(out)) {
            log(`   ⚠️  Telegram odgovor bez potvrde: ${out.slice(0, 200)}`);
            return false;
        }
        state[key] = new Date().toISOString();
        try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(state, null, 2)); } catch { /* ne ruši */ }
        log(`   📨 Telegram obavijest poslana (${key})`);
        return true;
    } catch (e) {
        log(`   ⚠️  Telegram nije poslan: ${e.message.split("\n")[0]}`);
        return false;
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* nema */ }
    }
}

module.exports = { notify };
