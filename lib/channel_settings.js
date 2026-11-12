/**
 * channel_settings.js — vlasnikove postavke kanala u pipelineu (lanac „postavke kanala”, S7).
 *
 * Izvor stanja je katalog `GET https://domovina.ai/api/katalog/v1/settings` (odluke 105, 312):
 *   {"version":"1","settings":{"UC…":{"status":"active|withdrawn|deleted","off":[…],"deleted_at"?}}}
 * Navedeni su samo UC-ovi s barem jednim isključenim ključem ili tombstoneom; svi ostali
 * su „sve uključeno” (tvrdi uvjet 4 plana). `off` je već efektivan (odluka 200), ali ga
 * ovdje ponovno zatvaramo po ovisnostima (odluka 108), da stari odgovor ne propusti ništa.
 *
 * Jedan dohvat po runu: `run_pipeline.sh` na početku pozove `tools/channel_settings.js fetch`
 * i izveze `CHANNEL_SETTINGS_FILE`; svi koraci čitaju tu snimku. Skripta pokrenuta sama
 * (bez env-a) dohvati jednom i spremi u `storage/.channel_settings.json` (15 min svježe).
 *
 * **Nedostupan izvor = fail-closed** (S7 točka 4): snimka s `ok:false` kaže „preskoči” za
 * SVAKU epizodu i svaki ključ, uz razlog `izvor postavki nedostupan`. Zadano uključeno bi
 * obradilo povučen kanal. Kanal bez UC-a (RSS, X; odluka 102) nema postavke i radi kao danas
 * — ali samo kad je izvor dostupan.
 *
 * Tombstone (`status: deleted`) je trajan (tvrdi uvjet 5): takav UC se nikad ne otkriva ni
 * obrađuje ponovno.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_URL = "https://domovina.ai/api/katalog/v1/settings";
const DEFAULT_FILE = path.join(__dirname, "..", "storage", ".channel_settings.json");
/** Zadnja USPJEŠNA snimka — samo za čitače (KORAK 13, WhatsApp), nikad za obradu. */
const LAST_OK_FILE = path.join(__dirname, "..", "storage", ".channel_settings.last_ok.json");
const STANDALONE_MAX_AGE_MS = 15 * 60 * 1000;

/** 20 ključeva, ugovor s ostalim potrošačima (odluka 1). Ne preimenovati. */
const KEYS = [
    "channel_enabled", "processing", "home_featured", "in_app_search", "search_engines",
    "push_notifications", "cdn_playback", "share_clips", "ebook", "article_summary",
    "transcript_subtitles", "english_translation", "magisterium", "highlights_reels",
    "persons_mentions", "news_portal", "ai_assistants", "donations", "paid_sponsor_moments",
    "sponsors_in_video",
];
const AI_KEYS = [
    "article_summary", "transcript_subtitles", "english_translation", "magisterium",
    "highlights_reels", "persons_mentions", "news_portal", "ai_assistants",
];
/** Odluka 108/200: ovisni ključevi padaju s ulazom. */
const ARTICLE_DEPENDENTS = ["ebook", "magisterium", "english_translation", "share_clips", "news_portal"];

const UC_RE = /^UC[A-Za-z0-9_-]{22}$/;

function isUc(x) { return typeof x === "string" && UC_RE.test(x); }

/** Zatvori skup isključenih ključeva po ovisnostima (master → sve; transkript → AI; članak → ovisni). */
function closeOff(off, status) {
    const s = new Set((off || []).filter((k) => KEYS.includes(k)));
    if (status === "withdrawn" || status === "deleted" || s.has("channel_enabled")) {
        return new Set(KEYS);
    }
    if (s.has("transcript_subtitles")) AI_KEYS.forEach((k) => s.add(k));
    if (s.has("article_summary")) ARTICLE_DEPENDENTS.forEach((k) => s.add(k));
    return s;
}

/** Provjeri oblik odgovora kataloga; vrati normaliziranu mapu ili baci. */
function parseCatalogResponse(body) {
    const j = typeof body === "string" ? JSON.parse(body) : body;
    if (!j || typeof j !== "object" || !j.settings || typeof j.settings !== "object" || Array.isArray(j.settings)) {
        throw new Error("neispravan odgovor kataloga (nema objekta settings)");
    }
    const out = {};
    for (const [uc, v] of Object.entries(j.settings)) {
        if (!isUc(uc) || !v || typeof v !== "object") continue;
        const status = ["active", "withdrawn", "deleted"].includes(v.status) ? v.status : "active";
        out[uc] = {
            status,
            off: Array.isArray(v.off) ? v.off.filter((k) => typeof k === "string") : [],
            ...(v.deleted_at ? { deleted_at: v.deleted_at } : {}),
        };
    }
    return out;
}

/**
 * Dohvati stanje iz kataloga (async). Nikad ne baca: vraća snimku `{ok, fetched_at, url, settings|error}`.
 * `fetchImpl` je za testove.
 */
async function fetchSnapshot({ url = process.env.CHANNEL_SETTINGS_URL || DEFAULT_URL, retries = 3,
    timeoutMs = 15000, fetchImpl = globalThis.fetch, sleepMs = 2000 } = {}) {
    let lastErr = "nepoznata greška";
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), timeoutMs);
            let res;
            try {
                res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
            } finally { clearTimeout(t); }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const settings = parseCatalogResponse(await res.text());
            return { ok: true, fetched_at: new Date().toISOString(), url, settings };
        } catch (e) {
            lastErr = e && e.name === "AbortError" ? `timeout ${timeoutMs} ms` : String((e && e.message) || e);
            if (attempt < retries && sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs * attempt));
        }
    }
    return { ok: false, fetched_at: new Date().toISOString(), url, error: lastErr };
}

function writeSnapshot(file, snap) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2) + "\n");
    fs.renameSync(tmp, file);
}

/** Pročitaj snimku; nečitljiva/neispravna snimka je isto što i nedostupan izvor. */
function readSnapshot(file) {
    try {
        const s = JSON.parse(fs.readFileSync(file, "utf8"));
        if (s && s.ok === true && s.settings && typeof s.settings === "object") return s;
        if (s && s.ok === false) return s;
        return { ok: false, error: `neispravna snimka ${file}` };
    } catch (e) {
        return { ok: false, error: `nečitljiva snimka ${file}: ${e.message}` };
    }
}

// ── Registry: slug → UC (fallback kad epizoda nema info.json) ────────────────
let _registryUc = null;
function registrySlugToUc(registryPath = path.join(__dirname, "..", "data", "podcasts_registry.json")) {
    if (_registryUc && _registryUc.path === registryPath) return _registryUc.map;
    const map = new Map();
    try {
        const r = JSON.parse(fs.readFileSync(registryPath, "utf8"));
        const list = Array.isArray(r) ? r : (r.channels || r.podcasts || []);
        for (const c of list) {
            const uc = c && c.youtube && c.youtube.channel_id;
            if (c && c.slug && isUc(uc)) map.set(c.slug, uc);
        }
    } catch { /* bez registryja: samo info.json */ }
    _registryUc = { path: registryPath, map };
    return map;
}

/** UC iz `<base>.info.json` (yt-dlp `channel_id`) — vlasnik sadržaja epizode. */
function ucFromInfoJson(infoPath) {
    try {
        const j = JSON.parse(fs.readFileSync(infoPath, "utf8"));
        return isUc(j.channel_id) ? j.channel_id : null;
    } catch { return null; }
}

/**
 * Iz putanje bilo koje datoteke epizode izvuci slug kanala i put do info.json.
 * Epizode leže izravno u `<kanal>/`; `_screenshots/` i `_raw/` poddirektoriji se penju gore.
 */
function episodeFromPath(filePath) {
    let dir = path.dirname(filePath);
    let name = path.basename(filePath);
    const parent = path.basename(dir);
    if (/_(screenshots|raw)$/.test(parent)) {
        name = parent;
        dir = path.dirname(dir);
    }
    const m = name.match(/^(.*_yt_[A-Za-z0-9_-]{11})/);
    const base = m ? m[1] : null;
    return {
        slug: path.basename(dir),
        infoPath: base ? path.join(dir, `${base}.info.json`) : null,
    };
}

class ChannelGate {
    /** @param {object} snap snimka iz fetchSnapshot/readSnapshot; @param {{registryPath?:string}} opts */
    constructor(snap, opts = {}) {
        this.snap = snap || { ok: false, error: "nema snimke" };
        this.available = this.snap.ok === true;
        this.registryPath = opts.registryPath;
        this._infoCache = new Map();
    }

    /** UC-ovi koji se tiču epizode: info.json (vlasnik sadržaja) + slug iz registryja. */
    ucsFor({ uc, slug, infoPath, filePath } = {}) {
        const out = new Set();
        if (filePath && (!slug || !infoPath)) {
            const ep = episodeFromPath(filePath);
            slug = slug || ep.slug;
            infoPath = infoPath || ep.infoPath;
        }
        if (isUc(uc)) out.add(uc);
        if (infoPath) {
            if (!this._infoCache.has(infoPath)) this._infoCache.set(infoPath, ucFromInfoJson(infoPath));
            const u = this._infoCache.get(infoPath);
            if (u) out.add(u);
        }
        if (slug) {
            const u = registrySlugToUc(this.registryPath).get(slug);
            if (u) out.add(u);
        }
        return [...out];
    }

    /** Efektivno isključeni ključevi za jedan UC. */
    offFor(uc) {
        const v = this.available && this.snap.settings[uc];
        return v ? closeOff(v.off, v.status) : new Set();
    }

    isTombstoned(uc) {
        return !!(this.available && isUc(uc) && this.snap.settings[uc] && this.snap.settings[uc].status === "deleted");
    }

    isWithdrawn(uc) {
        const v = this.available && isUc(uc) && this.snap.settings[uc];
        return !!(v && (v.status === "withdrawn" || v.status === "deleted" || closeOff(v.off, v.status).has("channel_enabled")));
    }

    /**
     * Smije li se za ovu epizodu generirati artefakt vezan uz `key`?
     * → `{skip:false}` ili `{skip:true, reason, uc}`. Bez izvora: uvijek skip (fail-closed).
     * `processing` i svaki drugi ključ uvijek uključuju master (closeOff).
     */
    check({ key, ...who } = {}) {
        if (key && !KEYS.includes(key)) throw new Error(`nepoznat ključ postavki: ${key}`);
        if (!this.available) {
            return { skip: true, reason: `izvor postavki nedostupan (${this.snap.error || "?"})`, unavailable: true };
        }
        for (const uc of this.ucsFor(who)) {
            const v = this.snap.settings[uc];
            if (!v) continue;
            if (v.status === "deleted") return { skip: true, uc, reason: `kanal ${uc} je trajno obrisan (tombstone)` };
            const off = closeOff(v.off, v.status);
            if (off.has("channel_enabled")) return { skip: true, uc, reason: `vlasnik je povukao kanal ${uc}` };
            if (key && off.has(key)) return { skip: true, uc, reason: `vlasnik je isključio „${key}” (${uc})` };
        }
        return { skip: false };
    }

    /** Za nove epizode: obrada (`processing`) + master. */
    checkProcessing(who) { return this.check({ ...who, key: "processing" }); }

    /**
     * Korak obrade koji proizvodi artefakt ključa `key` (S7 točke 1+2): prvo `processing`
     * (i master), pa ključ koraka. Isključena obrada zaustavlja i epizodu koja je već u tijeku.
     */
    checkStep({ key, ...who } = {}) {
        const p = this.check({ ...who, key: "processing" });
        if (p.skip || !key || key === "processing") return p;
        return this.check({ ...who, key });
    }

    /** Sažetak za log na početku runa. */
    summary() {
        if (!this.available) return `⛔ postavke kanala NEDOSTUPNE (${this.snap.error}) — nova obrada staje za sve kanale`;
        const all = Object.entries(this.snap.settings);
        const del = all.filter(([, v]) => v.status === "deleted").length;
        const wd = all.filter(([, v]) => v.status === "withdrawn").length;
        return `🔐 postavke kanala: ${all.length} kanala s isključenim ključem (povučeno ${wd}, obrisano ${del})`;
    }
}

/** Testovi i izvori koji već imaju snimku. */
function gateFromSnapshot(snap, opts) { return new ChannelGate(snap, opts); }

let _gate = null;
/**
 * Sinkroni singleton za skripte pipelinea:
 *  1. `CHANNEL_SETTINGS_FILE` (postavio run) → ta snimka, bez obzira na starost (jedan poziv po runu);
 *  2. inače `storage/.channel_settings.json` ako je mlađi od 15 min;
 *  3. inače jednom dohvati (podproces, jer je fetch async) i spremi.
 */
function gate(opts = {}) {
    if (_gate && !opts.fresh) return _gate;
    const envFile = process.env.CHANNEL_SETTINGS_FILE;
    let snap;
    if (envFile) {
        snap = readSnapshot(envFile);
    } else {
        const file = opts.file || DEFAULT_FILE;
        let fresh = false;
        try { fresh = Date.now() - fs.statSync(file).mtimeMs < STANDALONE_MAX_AGE_MS; } catch { /* nema */ }
        if (!fresh || opts.fresh) {
            try {
                execFileSync(process.execPath, [path.join(__dirname, "..", "tools", "channel_settings.js"), "fetch", "--out", file, "--quiet"],
                    { stdio: ["ignore", "ignore", "inherit"], timeout: 120000 });
            } catch { /* exit 2 = nedostupno; snimka s ok:false je svejedno zapisana */ }
        }
        snap = readSnapshot(file);
    }
    _gate = new ChannelGate(snap, opts);
    return _gate;
}

/**
 * Gate za ČITAČE (KORAK 13 indeksi, share_to_whatsapp, Vertex, glasački bazen): kad je izvor
 * nedostupan, koristi zadnju uspješnu snimku (`LAST_OK_FILE`), a bez nje ne filtrira ništa
 * i to kaže u `stale`. Čitač je druga linija (prva je aplikacija/worker, S5/S6), pa pad
 * kataloga ne smije isprazniti naslovnicu. Obrada NIKAD ne koristi ovo (fail-closed).
 */
function readerGate(opts = {}) {
    const g = gate(opts);
    if (g.available) return g;
    const last = readSnapshot(opts.lastOkFile || LAST_OK_FILE);
    if (last.ok) {
        const rg = new ChannelGate(last, opts);
        rg.stale = `izvor nedostupan (${g.snap.error}); zadnja uspješna snimka ${last.fetched_at}`;
        return rg;
    }
    const rg = new ChannelGate({ ok: true, settings: {}, fetched_at: null }, opts);
    rg.stale = `izvor nedostupan (${g.snap.error}) i nema zadnje uspješne snimke — bez filtra`;
    return rg;
}

function _resetForTests() { _gate = null; _registryUc = null; }

module.exports = {
    KEYS, AI_KEYS, ARTICLE_DEPENDENTS, DEFAULT_URL, DEFAULT_FILE, LAST_OK_FILE, readerGate,
    isUc, closeOff, parseCatalogResponse, fetchSnapshot, writeSnapshot, readSnapshot,
    registrySlugToUc, ucFromInfoJson, episodeFromPath, ChannelGate, gateFromSnapshot, gate,
    _resetForTests,
};
