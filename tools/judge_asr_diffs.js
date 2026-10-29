#!/usr/bin/env node
// ⚠️ DEPRECATED (29.10.2026.) — Vertex AI / obično Gemini LLM zaključivanje se više ne koristi
// (lib/vertex_auth.js). Datoteka ostaje u sourceu kao zapis stare implementacije, ne brisati.
// Gemini ide samo kroz agy (lib/agy_tmux.js), sažetak i članak kroz Claude Code.
/**
 * tools/judge_asr_diffs.js — SLIJEPO preslušavanje mjesta gdje se Soniox i drugi izvor
 * razlikuju. Gemini 3.8 Flash (Vertex, bimbo-sync-prod) čuje isječak i za svaku stavku
 * kaže koja verzija odgovara izgovorenome. Ne zna koja je čija: A/B je po stavci
 * deterministički promiješan (sha1), ključ ostaje lokalno.
 *
 * Obrazac i prompt: adria-analytics katalog/skripte/news-982/soniox-hibrid (agy_tekst.js +
 * prompt-tekst.md), tamo kroz agy, ovdje izravno kroz Vertex.
 *
 * Izlaz: data/asr_eval/{video_id}/{protiv}.{kljuc,presude}.json + zbroj na stdout.
 * Trošak: ~5 min zvuka po pozivu (≈10k tokena), ~$0,5 po epizodi od sat vremena.
 *
 *   node tools/judge_asr_diffs.js --channel muzevni_budite --video-id f2HIRJPHHK4
 *   node tools/judge_asr_diffs.js --channel muzevni_budite --video-id DOfcONrRyDY --against speechmatics+gemini
 *   node tools/judge_asr_diffs.js … --dry       # samo broj stavki i prozora, nula poziva
 *   node tools/judge_asr_diffs.js … --summary   # samo zbroj postojećih presuda
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { align, loadSources } = require("./compare_asr");
const { vertexEndpointUrl, vertexAccessToken } = require("../lib/vertex_auth");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
function getArg(name, def = null) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : def;
}
const INPUT_DIR = getArg("--input-dir", path.join(ROOT, "storage", "output"));
const CHANNEL = getArg("--channel");
const VIDEO_ID = getArg("--video-id");
const AGAINST = getArg("--against", "canonical");
const WINDOW_SEC = parseFloat(getArg("--window-min", "5")) * 60;
const MAX_ITEMS = parseInt(getArg("--max-items", "40"), 10);
const DRY = args.includes("--dry");
const SUMMARY_ONLY = args.includes("--summary");

function loadConf() {
    const out = {};
    try {
        for (const line of fs.readFileSync(path.join(ROOT, "gemini.conf"), "utf-8").split("\n")) {
            const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
            if (m) out[m[1]] = m[2];
        }
    } catch { /* bez gemini.conf → defaulti */ }
    return out;
}
const CONF = loadConf();
const PROJECT = process.env.VERTEX_PROJECT || CONF.VERTEX_PROJECT || "bimbo-sync-prod";
const MODEL = getArg("--model", CONF.GEMINI_MODEL || "gemini-3.8-flash");
const REGIONS = (process.env.VERTEX_REGIONS || CONF.VERTEX_REGIONS || "global").split(",").map((s) => s.trim()).filter(Boolean);
const PRICE_IN = parseFloat(CONF.GEMINI_PRICE_IN || "0.75"), PRICE_OUT = parseFloat(CONF.GEMINI_PRICE_OUT || "3.75");

const PROMPT = `Ti si pažljiv slušatelj i lektor za hrvatski. Uz ove upute dobivaš zvučni isječak i popis stavki.
Svaka stavka je mjesto gdje se dva automatska prijepisa (A i B) razlikuju. Ne znaš koji je
prijepis iz kojeg sustava i to nije važno: sudi samo po onome što se čuje.

Za svaku stavku:
- \`od\`/\`do\` su sekunde od početka OVOG isječka (približno, ±2 s).
- \`prije\` i \`poslije\` su riječi oko razlike u kojima se A i B slažu (kontekst).
- \`A\` i \`B\` su dvije verzije dijela koji se razlikuje (može biti prazno = taj prijepis tu nema ništa).

Poslušaj to mjesto i odluči:
- "A" ako A odgovara izgovorenome, a B ne
- "B" ako B odgovara izgovorenome, a A ne
- "oba" ako su oba prihvatljiva (npr. „35” prema „trideset pet”, „dobrodošli” prema „dobro došli”,
  ista riječ drugim pravopisom)
- "nijedno" ako ni A ni B ne odgovaraju izgovorenome
- "ne_cuje_se" ako se na tom mjestu ne da razabrati (preklapanje, šum, glazba)

Dijalekt i razgovorni oblici se ne ispravljaju prema standardu: ako govornik kaže „lipo”, točna je
verzija koja piše „lipo”, ne „lijepo”. Poštapalice i ponavljanja koja se stvarno čuju („ovoga”,
„evo”, „ja, ja sam”) su dio izgovorenoga. Sudiš po izgovorenome, ne po pravopisu.

U \`cuje_se\` napiši što se stvarno čuje na mjestu razlike (samo taj dio, bez konteksta).
\`napomena\` je kratka i samo kad je nešto neobično (npr. „dva govornika istovremeno”).
Odgovor mora sadržavati svaku stavku s popisa, istim \`id\`-om.

Stavke:
`;

const SCHEMA = {
    type: "OBJECT",
    properties: {
        stavke: {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    id: { type: "INTEGER" },
                    presuda: { type: "STRING", enum: ["A", "B", "oba", "nijedno", "ne_cuje_se"] },
                    cuje_se: { type: "STRING" },
                    napomena: { type: "STRING" },
                },
                required: ["id", "presuda", "cuje_se"],
            },
        },
    },
    required: ["stavke"],
};

// ─── stavke: razlike soniox ↔ drugi, spojene kad ih dijeli < 3 zajedničke riječi ───
function buildItems(sx, other) {
    const { ops } = align(sx, other);
    const groups = [];
    let cur = null, eqRun = 0, lastSx = -1;
    for (const [d, i, j] of ops) {
        if (i >= 0) lastSx = i;
        if (d === 0) {
            eqRun++;
            if (cur && eqRun >= 3) { groups.push(cur); cur = null; }
            continue;
        }
        // < 3 jednake riječi između dvije razlike → ista stavka; te riječi ulaze u nju
        // preko min/max raspona indeksa ispod.
        if (!cur) cur = { sx: [], ot: [], anchor: lastSx };
        if (i >= 0) cur.sx.push(i);
        if (j >= 0) cur.ot.push(j);
        eqRun = 0;
    }
    if (cur) groups.push(cur);

    // Ispuni rupe: stavka obuhvaća neprekinut raspon indeksa s obje strane.
    return groups.map((g, k) => {
        const s1 = g.sx.length ? Math.min(...g.sx) : g.anchor + 1, s2 = g.sx.length ? Math.max(...g.sx) + 1 : g.anchor + 1;
        const o1 = g.ot.length ? Math.min(...g.ot) : null, o2 = g.ot.length ? Math.max(...g.ot) + 1 : null;
        const tAt = (idx, end) => {
            const w = sx[Math.min(Math.max(idx, 0), sx.length - 1)];
            return end ? w.end : w.start;
        };
        const t0 = s2 > s1 ? tAt(s1, false) : tAt(s1 - 1, true);
        const t1 = s2 > s1 ? tAt(s2 - 1, true) : t0;
        const S = sx.slice(s1, s2).map((w) => w.raw).join(" ");
        const O = o1 != null ? other.slice(o1, o2).map((w) => w.raw).join(" ") : "";
        const flip = crypto.createHash("sha1").update(`${VIDEO_ID}:${AGAINST}:${k}`).digest()[0] & 1;
        return {
            id: k, t0, t1,
            prije: sx.slice(Math.max(s1 - 4, 0), s1).map((w) => w.raw).join(" "),
            poslije: sx.slice(s2, s2 + 4).map((w) => w.raw).join(" "),
            A: flip ? O : S, B: flip ? S : O,
            kljuc: flip ? { A: AGAINST, B: "soniox" } : { A: "soniox", B: AGAINST },
            rijeci_sx: s2 - s1, rijeci_ot: o1 != null ? o2 - o1 : 0,
        };
    });
}

function windows(items) {
    const out = [];
    for (let i = 0; i < items.length;) {
        const idx = [], st = items[i].t0;
        for (let j = i; j < items.length && idx.length < MAX_ITEMS && (idx.length === 0 || items[j].t1 - st <= WINDOW_SEC); j++) idx.push(j);
        out.push(idx);
        i += idx.length;
    }
    return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token = null, tokenAt = 0, regionIdx = 0;
const usage = { in: 0, out: 0, calls: 0 };

async function callGemini(audio, text) {
    for (let attempt = 1; attempt <= 6; attempt++) {
        if (!token || Date.now() - tokenAt > 50 * 60 * 1000) { token = vertexAccessToken({ account: CONF.VERTEX_ACCOUNT }); tokenAt = Date.now(); }
        const url = vertexEndpointUrl(PROJECT, REGIONS[regionIdx % REGIONS.length], MODEL);
        const res = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/mpeg", data: audio.toString("base64") } }, { text }] }],
                generationConfig: { temperature: 0, maxOutputTokens: 32768, responseMimeType: "application/json", responseSchema: SCHEMA },
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) { token = null; continue; }
        if (res.status === 429 || res.status >= 500) { regionIdx++; await sleep(attempt * 5000); continue; }
        if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
        const um = data.usageMetadata || {};
        usage.in += um.promptTokenCount || 0;
        usage.out += (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0);
        usage.calls++;
        const cand = data.candidates && data.candidates[0];
        const out = cand && (cand.content && cand.content.parts || []).map((p) => p.text || "").join("");
        if (!out) { regionIdx++; continue; }
        try { return JSON.parse(out); } catch { regionIdx++; continue; }
    }
    throw new Error("Gemini nije vratio valjan JSON nakon 6 pokušaja");
}

function summarize(items, verdicts) {
    const byId = new Map(verdicts.map((v) => [v.id, v]));
    const tally = { soniox: 0, [AGAINST]: 0, oba: 0, nijedno: 0, ne_cuje_se: 0, bez_presude: 0 };
    const small = { ...tally };
    for (const it of items) {
        const v = byId.get(it.id);
        const key = !v ? "bez_presude" : (v.presuda === "A" || v.presuda === "B") ? it.kljuc[v.presuda] : v.presuda;
        tally[key]++;
        if (it.rijeci_sx + it.rijeci_ot <= 2) small[key]++;
    }
    const decided = tally.soniox + tally[AGAINST];
    return { stavki: items.length, tally, male_1_2_rijeci: small, soniox_pobjeda_od_odlucenih: decided ? +(tally.soniox / decided).toFixed(3) : null };
}

(async () => {
    const dir = path.join(INPUT_DIR, CHANNEL);
    const srt = fs.readdirSync(dir).find((f) => f.endsWith(`_yt_${VIDEO_ID}.wav.canary.diarized.srt`));
    if (!srt) { console.error(`❌ Nema ${VIDEO_ID} u ${CHANNEL}`); process.exit(1); }
    const base = srt.slice(0, -".wav.canary.diarized.srt".length);
    const src = loadSources(dir, base);
    if (!src.soniox || !src[AGAINST]) { console.error(`❌ Treba soniox i ${AGAINST}; ima: ${Object.keys(src).join(", ")}`); process.exit(1); }
    const audio = path.join(dir, base + ".mp3");

    const outDir = path.join(ROOT, "data", "asr_eval", VIDEO_ID);
    fs.mkdirSync(outDir, { recursive: true });
    const keyPath = path.join(outDir, `${AGAINST}.kljuc.json`), verdictPath = path.join(outDir, `${AGAINST}.presude.json`);

    const items = buildItems(src.soniox, src[AGAINST]);
    const wins = windows(items);
    console.log(`⚖️  ${VIDEO_ID}: soniox ↔ ${AGAINST} — ${items.length} stavki (1–2 riječi: ${items.filter((i) => i.rijeci_sx + i.rijeci_ot <= 2).length}), ${wins.length} prozora, ${MODEL}`);
    if (DRY) return;
    fs.writeFileSync(keyPath, JSON.stringify(items));

    let verdicts = [];
    try { verdicts = JSON.parse(fs.readFileSync(verdictPath, "utf-8")).stavke || []; } catch { /* prvi run */ }
    if (!SUMMARY_ONLY) {
        const done = new Set(verdicts.map((v) => v.id));
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "judge-"));
        for (let w = 0; w < wins.length; w++) {
            const idx = wins[w].filter((k) => !done.has(k));
            if (!idx.length) continue;
            const b = Math.max(0, items[idx[0]].t0 - 3), dur = items[idx[idx.length - 1]].t1 - b + 3;
            const clip = path.join(tmp, `w${w}.mp3`);
            execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(b), "-t", String(dur), "-i", audio, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", clip]);
            const listing = idx.map((k) => ({
                id: k, od: Math.round((items[k].t0 - b) * 10) / 10, do: Math.round((items[k].t1 - b) * 10) / 10,
                prije: items[k].prije, A: items[k].A, B: items[k].B, poslije: items[k].poslije,
            }));
            const t0 = Date.now();
            try {
                const r = await callGemini(fs.readFileSync(clip), PROMPT + JSON.stringify(listing));
                const got = (r.stavke || []).filter((v) => idx.includes(v.id));
                verdicts.push(...got);
                fs.writeFileSync(verdictPath, JSON.stringify({ video_id: VIDEO_ID, against: AGAINST, model: MODEL, stavke: verdicts }, null, 1));
                console.log(`   prozor ${w + 1}/${wins.length}: ${got.length}/${idx.length} presuda, ${(dur / 60).toFixed(1)} min zvuka, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
            } catch (e) {
                console.log(`   ⚠️ prozor ${w + 1}/${wins.length}: ${e.message}`);
            }
        }
        fs.rmSync(tmp, { recursive: true, force: true });
        const usd = usage.in / 1e6 * PRICE_IN + usage.out / 1e6 * PRICE_OUT;
        console.log(`   💰 ${usage.calls} poziva, ${usage.in} in / ${usage.out} out tokena ≈ $${usd.toFixed(3)}`);
    }
    const sum = summarize(items, verdicts);
    fs.writeFileSync(path.join(outDir, `${AGAINST}.zbroj.json`), JSON.stringify(sum, null, 2));
    console.log(JSON.stringify(sum, null, 2));
})();
