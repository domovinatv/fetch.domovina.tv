#!/usr/bin/env node
/**
 * Zajednički Podscan.fm REST klijent za sve skripte u podscan/.
 *
 * Tri stvari koje ovaj modul rješava, a koje su na trial planu presudne:
 *
 *  1. KVOTA. Trial = 100 zahtjeva/DAN, 10/min, 5 paralelno. To je toliko malo
 *     da jedan neoprezan `for` po registru (291 kanala) potroši tri dana kvote.
 *     Zato svaki poziv prolazi kroz budžet (`.podscan_budget.json`, per-dan) i
 *     skripta odustane s jasnom porukom umjesto da zaradi 429.
 *  2. CACHE NA DISKU. Svaki GET se sprema u data/podscan_cache/ po hashu URL-a.
 *     Ponovno pokretanje izvještaja je time BESPLATNO — a to je jedini način da
 *     se analiza iterira bez trošenja dnevne kvote.
 *  3. THROTTLE. 10/min znači ≥6s razmaka; držimo 6.5s + exponential backoff na 429.
 *
 * Ključ se čita iz .env (PODSCAN_API_KEY). Nikad ga ne hardkodiraj.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(REPO_ROOT, "data", "podscan_cache");
const BUDGET_FILE = path.join(REPO_ROOT, "data", "podscan_cache", ".podscan_budget.json");
const BASE_URL = "https://podscan.fm/api/v1";

// Trial plan. Ako se plan nadogradi, podigni preko env vara — ne diraj kod.
const DAILY_LIMIT = parseInt(process.env.PODSCAN_DAILY_LIMIT || "100", 10);
const MIN_SPACING_MS = parseInt(process.env.PODSCAN_MIN_SPACING_MS || "6500", 10);

function loadEnv() {
    const envPath = path.join(REPO_ROOT, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
}
loadEnv();

function apiKey() {
    const k = process.env.PODSCAN_API_KEY;
    if (!k) {
        console.error("❌ PODSCAN_API_KEY nije postavljen (.env ili env var).");
        process.exit(1);
    }
    return k;
}

// ── Budžet ────────────────────────────────────────────────────────────────
function today() {
    return new Date().toISOString().slice(0, 10);
}

function loadBudget() {
    try {
        const b = JSON.parse(fs.readFileSync(BUDGET_FILE, "utf8"));
        if (b.date === today()) return b;
    } catch (_) { /* prvi run ili novi dan */ }
    return { date: today(), used: 0 };
}

function saveBudget(b) {
    fs.mkdirSync(path.dirname(BUDGET_FILE), { recursive: true });
    fs.writeFileSync(BUDGET_FILE, JSON.stringify(b, null, 2));
}

function budgetStatus() {
    const b = loadBudget();
    return { used: b.used, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - b.used) };
}

// ── Cache ─────────────────────────────────────────────────────────────────
function cachePath(method, url, body) {
    const h = crypto.createHash("sha1").update(`${method} ${url} ${body || ""}`).digest("hex").slice(0, 20);
    const slug = url.replace(BASE_URL, "").replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 60);
    return path.join(CACHE_DIR, `${slug}__${h}.json`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCallAt = 0;

/**
 * Jedan API poziv. Vraća { data, cached, status }.
 *
 * @param {string} endpoint  npr. "/podcasts/search"
 * @param {object} opts
 *   - params: query parametri
 *   - method: "GET" (default) | "POST"
 *   - body:   objekt za POST
 *   - maxAge: sekunde koliko cache vrijedi (default: zauvijek za GET)
 *   - noCache: preskoči cache (POST je uvijek noCache)
 */
async function call(endpoint, opts = {}) {
    const { params = {}, method = "GET", body = null, maxAge = null, noCache = false } = opts;
    const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
    ).toString();
    const url = `${BASE_URL}${endpoint}${qs ? "?" + qs : ""}`;
    const bodyStr = body ? JSON.stringify(body) : null;

    const useCache = method === "GET" && !noCache;
    const cp = cachePath(method, url, bodyStr);
    if (useCache && fs.existsSync(cp)) {
        const stat = fs.statSync(cp);
        const ageSec = (Date.now() - stat.mtimeMs) / 1000;
        if (maxAge === null || ageSec < maxAge) {
            return { data: JSON.parse(fs.readFileSync(cp, "utf8")), cached: true, status: 200 };
        }
    }

    const budget = loadBudget();
    if (budget.used >= DAILY_LIMIT) {
        const err = new Error(
            `KVOTA POTROŠENA: ${budget.used}/${DAILY_LIMIT} zahtjeva danas (${budget.date}). ` +
            `Nastavi sutra — skripte su resumable, cache na disku ostaje.`
        );
        err.code = "BUDGET_EXHAUSTED";
        throw err;
    }

    // Throttle: 10 req/min → ≥6s razmaka.
    const since = Date.now() - lastCallAt;
    if (since < MIN_SPACING_MS) await sleep(MIN_SPACING_MS - since);

    let attempt = 0;
    while (true) {
        attempt++;
        lastCallAt = Date.now();
        budget.used++;
        saveBudget(budget);

        const res = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${apiKey()}`,
                Accept: "application/json",
                ...(bodyStr ? { "Content-Type": "application/json" } : {}),
            },
            body: bodyStr,
        });

        // Server je jedini pouzdan izvor potrošnje: istu dnevnu kvotu troše i
        // Podscan MCP konektor, i ručni curl, i web sučelje. Naš lokalni brojač
        // vidi samo vlastite pozive i zato PODCJENJUJE (izmjereno 2026-08-26:
        // lokalno 75, server 100). Zato ga poravnavamo po svakom odgovoru.
        const srvLimit = parseInt(res.headers.get("x-ratelimit-limit") || "", 10);
        const srvRemaining = parseInt(res.headers.get("x-ratelimit-remaining") || "", 10);
        if (Number.isFinite(srvLimit) && Number.isFinite(srvRemaining) && srvLimit >= DAILY_LIMIT) {
            const realUsed = srvLimit - srvRemaining;
            if (realUsed > budget.used) {
                budget.used = realUsed;
                saveBudget(budget);
            }
        }

        if (res.status === 429) {
            // `retry-after` na dnevnoj kvoti zna biti ~20 SATI. Slijepo ponavljanje
            // s 30-sekundnim backoffom tu ne pomaže ničemu — bolje odustati s
            // porukom koja kaže kad se kvota vraća.
            const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
            if (retryAfter > 300 || attempt >= 4) {
                budget.used = DAILY_LIMIT;
                saveBudget(budget);
                const hrs = retryAfter ? ` Kvota se vraća za ~${(retryAfter / 3600).toFixed(1)}h.` : "";
                const err = new Error(`429 — dnevna kvota potrošena.${hrs} (${url})`);
                err.code = "BUDGET_EXHAUSTED";
                throw err;
            }
            const wait = Math.max(retryAfter * 1000, 30000 * attempt);
            console.warn(`   ⏳ 429 — čekam ${Math.round(wait / 1000)}s (pokušaj ${attempt})`);
            await sleep(wait);
            continue;
        }

        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (_) {
            throw new Error(`Neispravan JSON (HTTP ${res.status}) na ${url}: ${text.slice(0, 200)}`);
        }
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status} na ${url}: ${text.slice(0, 200)}`);
            err.status = res.status;
            err.data = data;
            throw err;
        }

        if (useCache) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
            fs.writeFileSync(cp, JSON.stringify(data));
        }
        return { data, cached: false, status: res.status };
    }
}

module.exports = { call, budgetStatus, DAILY_LIMIT, CACHE_DIR, REPO_ROOT, BASE_URL };
