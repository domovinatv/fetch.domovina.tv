"use strict";

/**
 * Tanak wrapper oko dijeljenog `claude-window` arbitra.
 *
 * Zašto (2026-08-26): Claude Code pretplata broji kvotu u ~5h prozoru, a nightly
 * pipeline ima dugačak rep — medijan ~20 min, ali 4h31m (16.8.) i 6h37m (14.8.).
 * U tim runovima su se Opus sessioni spawnali u 07:35 i 08:31 i otvarali svjež
 * prozor tik prije 08:30, pa je jutro počinjalo s potrošenom kvotom.
 *
 * Prva verzija ovoga je imala fiksni cutoff (CLAUDE_WINDOW_END=02:30). To je bilo
 * krivo postavljeno pitanje: bitno je otvara li poziv NOVI prozor ili ulazi u već
 * otvoren, a to se iz sata ne vidi. Ako je prozor otvoren u 00:10, pozivi do ~05:10
 * su besplatni; ako je istekao, poziv u 05:20 otvara novi koji traje do 10:20.
 * Zato odluku donosi dijeljeni arbitar koji drži stanje na jednom mjestu i čita
 * `quotaLimits` zapise iz Claude Code session logova.
 *
 * Arbitar: `claude-window` (repo stepanic/launchd-menubar, tools/claude-window,
 * symlinkan u ~/.local/bin). Politika i testovi su tamo, ne ovdje.
 *
 * Ograda je aktivna samo uz CLAUDE_WINDOW_GUARD=1 — postavljaju je nightly,
 * priority i magisterium wrapperi. Ručni runovi rade bez nje.
 */

const { spawnSync } = require("child_process");

const GUARD_ENABLED = process.env.CLAUDE_WINDOW_GUARD === "1";
const ARBITER = process.env.CLAUDE_WINDOW_BIN || "claude-window";
const DEFER_EXIT_CODE = 10;

let lastReason = "";

/**
 * Pita arbitra smije li se sada zvati `claude`.
 *
 * Poziv ujedno zapisuje da je prozor otvoren, pa ga zovi neposredno prije stvarnog
 * `claude` poziva, ne unaprijed za cijeli batch.
 *
 * @returns {boolean} true = odgodi posao
 */
function claudeWindowClosed() {
    if (!GUARD_ENABLED) return false;

    const res = spawnSync(ARBITER, ["check"], { encoding: "utf-8" });

    // Arbitar nedostupan (nije instaliran, nije u PATH-u launchd joba) — ne ruši
    // pipeline zbog ograde. Propuštamo posao i vičemo u log; gora je varijanta da
    // nightly stane jer symlink fali.
    if (res.error || typeof res.status !== "number") {
        lastReason = `arbitar '${ARBITER}' nedostupan (${res.error ? res.error.message : "nepoznat status"}) — propuštam`;
        console.error(`      ⚠️  ${lastReason}`);
        return false;
    }

    lastReason = (res.stderr || "").replace(/^claude-window:\s*/, "").trim();
    return res.status === DEFER_EXIT_CODE;
}

/** Obrazloženje zadnje odluke, za log. */
function claudeWindowReason() {
    return lastReason || "claude-window je odgodio posao";
}

module.exports = { claudeWindowClosed, claudeWindowReason };
