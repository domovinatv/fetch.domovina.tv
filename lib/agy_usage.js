/**
 * Kvota agy (Antigravity, Google AI Pro) — 07.11.2026.
 *
 * `agy -p "/usage" --output-format json` odgovara bez pokretanja modela (~3 s, 0 tokena).
 * `agy -p` je pokvaren samo za prave upite; read-only slash naredbe rade.
 *
 * Grupe i prozori (stanje 07.11.2026.):
 *   gemini   — Gemini Flash/Pro: 5h + tjedni
 *   claude   — Claude/GPT kroz agy: 5h + tjedni
 *   argon    — Gemini 4 Argon: ZASEBAN tjedni limit (na Pro planu malen)
 *
 * Vraća POTROŠENO u postocima (kao Claude readUsage), ne preostalo:
 *   { gemini_5h, gemini_weekly, claude_5h, claude_weekly, argon_weekly, resets: {...}, ts }
 * Nedostajući bucket = undefined. Greška = null (nikad ne baca).
 */
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CACHE = path.join(os.homedir(), ".cache", "domovina-pipeline", "agy_usage_cache.json");

const BUCKETS = {
    "gemini-5h": "gemini_5h",
    "gemini-weekly": "gemini_weekly",
    "3p-5h": "claude_5h",
    "3p-weekly": "claude_weekly",
    "gemini-argon-wtu-weekly": "argon_weekly",
};

function parseUsage(payload) {
    const groups = payload && payload.command && payload.command.data && payload.command.data.groups;
    if (!Array.isArray(groups)) return null;
    const out = { resets: {}, ts: Math.floor(Date.now() / 1000) };
    for (const g of groups) {
        for (const b of g.buckets || []) {
            let key = BUCKETS[b.id];
            // Nepoznat id (Google ga može preimenovati): prepoznaj po grupi i prozoru.
            if (!key && /argon/i.test(g.name || "") && b.window === "weekly") key = "argon_weekly";
            if (!key || typeof b.remaining_fraction !== "number") continue;
            out[key] = Math.round((1 - b.remaining_fraction) * 1000) / 10;
            out.resets[key] = b.reset_time;
        }
    }
    return out;
}

function runAgyUsage(timeoutMs) {
    return new Promise((resolve) => {
        execFile("agy", ["-p", "/usage", "--output-format", "json"],
            { cwd: os.tmpdir(), timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 20 },
            (err, stdout) => {
                if (err) return resolve(null);
                try { resolve(parseUsage(JSON.parse(stdout))); } catch { resolve(null); }
            });
    });
}

/** maxAgeSec = 0 → uvijek svježe (za mjerenje potrošnje po članku). */
async function readAgyUsage({ maxAgeSec = 300, timeoutMs = 30000 } = {}) {
    if (maxAgeSec > 0) {
        try {
            const c = JSON.parse(fs.readFileSync(CACHE, "utf8"));
            if (Date.now() / 1000 - c.ts < maxAgeSec) return c;
        } catch { /* nema keša */ }
    }
    const u = await runAgyUsage(timeoutMs);
    if (u) {
        try { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(u)); } catch { /* keš nije bitan */ }
    }
    return u;
}

const pct = (v) => (v === undefined ? "?" : `${Math.round(v)} %`);

/** Jedan red za log: potrošeno po prozoru. */
function formatAgyUsage(u) {
    if (!u) return "agy kvota: nije pročitana";
    return `agy kvota (potrošeno): Gemini 5h ${pct(u.gemini_5h)} · tj. ${pct(u.gemini_weekly)} | Argon tj. ${pct(u.argon_weekly)}`;
}

module.exports = { readAgyUsage, formatAgyUsage, parseUsage };
