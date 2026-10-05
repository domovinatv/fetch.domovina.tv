#!/usr/bin/env node
"use strict";
/**
 * generate_words_json.js — KORAK 9.87: vrijeme po riječi za titl (`{base}.words.json`).
 *
 * Frontend (domovina.ai v2.0.168+) ističe riječ koja se upravo izgovara ako na CDN-u
 * postoji `data/<id>/words.json`. Ugovor i mjerenja:
 * `../domovina.ai/docs/2026-10-06-titlovi-rijec-po-rijec.md` §3. Ovo je Node port
 * referentne izvedbe `../domovina.ai/scripts/subtitle-words-reference.py` — isti
 * algoritam, isti izlaz (provjereno na svih 57 epizoda, vidi
 * `docs/2026-10-06-words-json-titlovi.md`).
 *
 *   {"v":1,"source":"speechmatics","anchored":0.876,
 *    "cues":[{"s":0,"e":15000,"w":[120,300,300,450,…],"a":0.91},…]}
 *
 * Izvor vremena: `{base}.{audio}.speechmatics.json` (KORAK 2.7) ili
 * `{base}.wav.canary.word_ts.json` (canary_modal.py od 06.10.2026.). Kad postoje oba,
 * pobjeđuje onaj s više izravno usidrenih riječi. Tekst i granice cue-a:
 * KANONSKI `{base}.wav.canary.diarized.srt` — ugovor je SRT, ne Speechmatics. Frontend
 * prihvaća cue samo ako se broj riječi točno slaže, pa regenerirani SRT ne može dati
 * krivo isticanje, samo nikakvo.
 *
 * Nula API poziva, ~1 s po epizodi.
 *
 * Ispod `--min-anchored` (default 0.6 — epizode s engleskim zvukom i HR tekstom imaju
 * 24–32 %) NE piše se `words.json` nego `{base}.words.skipped.json` (razlog + udio),
 * da idući run ne računa isto ponovno. `.words.skipped.json` ne ide na CDN.
 *
 * Idempotencija: preskače epizodu kad je izlaz (words ili skipped) noviji od SRT-a
 * i Speechmatics JSON-a. Promijeni li se SRT, words.json se regenerira — pa ga
 * upload (immutable ključ) treba poslati s `--force` / tools/upload_sponsors_in_video.js.
 *
 * Primjeri:
 *   node generate_words_json.js --dry-run
 *   node generate_words_json.js --channel 40_dana_za_zivot
 *   node generate_words_json.js --video-id fln3cFCwHcs --force
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const INPUT_DIR = getArg("--input-dir") || path.join(__dirname, "storage", "output");
const ONLY_CHANNEL = getArg("--channel");
const ONLY_VIDEO = getArg("--video-id");
const MIN_ANCHORED = parseFloat(getArg("--min-anchored") || "0.6");
const FORCE = args.includes("--force");
const DRY_RUN = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose");

const SRT_SUFFIX = ".wav.canary.diarized.srt";
const SM_SUFFIX = ".speechmatics.json";
const CANARY_WORDS_SUFFIX = ".wav.canary.word_ts.json";
const OUT_SUFFIX = ".words.json";
const SKIP_SUFFIX = ".words.skipped.json";
const MIN_MS = 120;   // najkraće trajanje interpolirane riječi (vidi §3 korak 4)
const PAD_MS = 50;    // Speechmatics riječi unutar [s-50, e+50]

function extractVideoId(filename) {
    const m = [...filename.matchAll(/_yt_([A-Za-z0-9_-]{11})/g)];
    return m.length ? m[m.length - 1][1] : null;
}

// ─── Python paritet ───────────────────────────────────────────────────

// Python round() je banker's (half-even); Math.round nije.
function roundHalfEven(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
}

// Python round(x, d): zaokružuje TOČNU binarnu vrijednost (0.925 → 0.93, jer je 0.925
// u floatu malo veći), a half-even samo za prave izjednačenosti. Prava izjednačenost
// na d decimala mora biti dijadska, tj. x·2^(d+1) je neparan cijeli broj (0.125, 0.375…).
function pyRound(x, d) {
    const t = x * 2 ** (d + 1);
    if (Number.isInteger(t) && t % 2 === 1) return roundHalfEven(x * 10 ** d) / 10 ** d;
    return parseFloat(x.toFixed(d));
}

function norm(w) {
    w = w.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
    return w.replace(/[^\p{L}\p{N}_]/gu, "");
}

/**
 * difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks() —
 * bez junka i bez "popular" heuristike, pa je ovo cijeli algoritam. Vraća parove
 * [i, j, k]. Redoslijed i izjednačenja (strogo `>`) prate CPython.
 */
function matchingBlocks(a, b) {
    const b2j = new Map();
    b.forEach((x, j) => { if (!b2j.has(x)) b2j.set(x, []); b2j.get(x).push(j); });

    function longest(alo, ahi, blo, bhi) {
        let besti = alo, bestj = blo, bestsize = 0;
        let j2len = new Map();
        for (let i = alo; i < ahi; i++) {
            const newj2len = new Map();
            for (const j of b2j.get(a[i]) || []) {
                if (j < blo) continue;
                if (j >= bhi) break;
                const k = (j2len.get(j - 1) || 0) + 1;
                newj2len.set(j, k);
                if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
            }
            j2len = newj2len;
        }
        while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
        while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
        return [besti, bestj, bestsize];
    }

    const out = [];
    const queue = [[0, a.length, 0, b.length]];
    while (queue.length) {
        const [alo, ahi, blo, bhi] = queue.pop();
        const [i, j, k] = longest(alo, ahi, blo, bhi);
        if (k) {
            out.push([i, j, k]);
            if (alo < i && blo < j) queue.push([alo, i, blo, j]);
            if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
        }
    }
    return out;
}

// ─── SRT ──────────────────────────────────────────────────────────────

function srtMs(s) {
    const [h, m, r] = s.split(":");
    const [sec, f] = r.split(",");
    return ((parseInt(h, 10) * 60 + parseInt(m, 10)) * 60 + parseInt(sec, 10)) * 1000 + parseInt(f, 10);
}

/** Cue-ovi kakve vidi frontend: tekst bez `[SPEAKER_XX]`, riječi po whitespaceu. */
function parseCues(raw) {
    const cues = [];
    for (const block of raw.trim().split(/\r?\n\s*\r?\n/)) {
        const l = block.trim().split("\n");
        if (l.length < 3) continue;
        const m = l[1].match(/(\S+)\s*-->\s*(\S+)/);
        if (!m) continue;
        let t = l.slice(2).map((x) => x.trim()).join(" ").trim();
        if (!/^\[\w+\]/.test(t)) continue;
        t = t.replace(/^\[\w+\]/, "").trim();
        cues.push({ s: srtMs(m[1]), e: srtMs(m[2]), toks: t.split(/\s+/).filter(Boolean) });
    }
    return cues;
}

// ─── Poravnanje (§3) ──────────────────────────────────────────────────

function speechmaticsWords(json) {
    return json.results
        .filter((r) => r.type === "word")
        .map((r) => [roundHalfEven(r.start_time * 1000), roundHalfEven(r.end_time * 1000), r.alternatives[0].content]);
}

function canaryWords(json) {
    return json.words.map(([a, b, w]) => [a, b, w]);
}

/** Vraća {doc, anch, tot} — doc je točno ugovor iz §3. */
function buildWords(cues, W, source = "speechmatics") {
    const res = [];
    let anch = 0, tot = 0;
    // Speechmatics daje riječi po početku; ako nisu sortirane, pošteni filter kao referenca.
    const sorted = W.every((w, k) => k === 0 || W[k - 1][0] <= w[0]);
    for (const { s, e, toks } of cues) {
        if (!toks.length) continue;
        let sw;
        if (sorted) {
            let lo = 0, hi = W.length;   // prvi s početkom >= s-PAD
            while (lo < hi) { const mid = (lo + hi) >> 1; if (W[mid][0] < s - PAD_MS) lo = mid + 1; else hi = mid; }
            sw = [];
            for (let x = lo; x < W.length && W[x][0] <= e + PAD_MS; x++) if (W[x][1] <= e + PAD_MS) sw.push(W[x]);
        } else {
            sw = W.filter((w) => w[0] >= s - PAD_MS && w[1] <= e + PAD_MS);
        }
        const A = toks.map(norm), B = sw.map((w) => norm(w[2]));
        const t = new Array(toks.length).fill(null);
        for (const [ai, bj, k] of matchingBlocks(A, B)) {
            for (let q = 0; q < k; q++) t[ai + q] = [sw[bj + q][0], sw[bj + q][1]];
        }
        const n = t.filter((x) => x !== null).length;
        anch += n; tot += toks.length;

        // Interpolacija neusidrenih nizova između susjednih sidara, razmjerno znakovima.
        let i = 0;
        while (i < t.length) {
            if (t[i] !== null) { i++; continue; }
            const i0 = i;
            let j = i;
            while (j < t.length && t[j] === null) j++;
            // Premalo mjesta (riječi na kraju cue-a koje je Speechmatics stavio u
            // sljedeći cue): niz upija susjedne usidrene riječi dok svaka ne dobije MIN_MS.
            for (;;) {
                const lo = i > 0 ? t[i - 1][1] : s, hi = j < t.length ? t[j][0] : e;
                if (hi - lo >= MIN_MS * (j - i)) break;
                if (i > 0) i--;
                else if (j < t.length) { j++; while (j < t.length && t[j] === null) j++; }
                else break;
            }
            const lo = i > 0 ? t[i - 1][1] : s;
            let hi = j < t.length ? t[j][0] : e;
            if (hi < lo) hi = lo;
            let L = 0;
            for (let k = i; k < j; k++) L += toks[k].length + 1;
            let acc = 0;
            for (let k = i; k < j; k++) {
                const a = lo + Math.floor((hi - lo) * acc / L);
                acc += toks[k].length + 1;
                const b = lo + Math.floor((hi - lo) * acc / L);
                t[k] = [a, b];
            }
            i = Math.max(j, i0 + 1);
        }
        // Monotonost po početku.
        for (let k = 1; k < t.length; k++) {
            if (t[k][0] < t[k - 1][0]) t[k] = [t[k - 1][0], Math.max(t[k][1], t[k - 1][0])];
        }
        res.push({ s, e, w: t.flat(), a: pyRound(n / toks.length, 2) });
    }
    const anchored = tot ? pyRound(anch / tot, 3) : 0;
    return { doc: { v: 1, source, anchored, cues: res }, anch, tot };
}

// ─── Skeniranje ───────────────────────────────────────────────────────

function listChannelDirs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
        .map((e) => e.name).sort();
}

function mtime(p) {
    try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function main() {
    const channels = ONLY_CHANNEL ? [ONLY_CHANNEL] : listChannelDirs(INPUT_DIR);
    const stats = { written: 0, skippedLow: 0, fresh: 0, noSource: 0, errors: 0 };
    console.log(`🔤 words.json (vrijeme po riječi) — prag usidrenosti ${MIN_ANCHORED}${DRY_RUN ? " · DRY RUN" : ""}`);

    for (const channel of channels) {
        const dir = path.join(INPUT_DIR, channel);
        let files;
        try { files = fs.readdirSync(dir).filter((f) => !f.startsWith("._")); } catch { continue; }
        const smByBase = new Map();
        for (const f of files) {
            if (!f.endsWith(SM_SUFFIX)) continue;
            // {base}.{mp3|m4a|…}.speechmatics.json
            const m = f.slice(0, -SM_SUFFIX.length).match(/^(.+)\.[A-Za-z0-9]+$/);
            if (m) smByBase.set(m[1], f);
        }
        for (const f of files) {
            if (!f.endsWith(SRT_SUFFIX)) continue;
            const base = f.slice(0, -SRT_SUFFIX.length);
            if (ONLY_VIDEO && extractVideoId(base) !== ONLY_VIDEO) continue;
            const srtPath = path.join(dir, f);
            const sources = [];
            if (smByBase.has(base)) sources.push({ name: "speechmatics", path: path.join(dir, smByBase.get(base)), read: speechmaticsWords });
            const cwPath = path.join(dir, base + CANARY_WORDS_SUFFIX);
            if (fs.existsSync(cwPath)) sources.push({ name: "canary", path: cwPath, read: canaryWords });
            if (!sources.length) { stats.noSource++; continue; }

            const outPath = path.join(dir, base + OUT_SUFFIX);
            const skipPath = path.join(dir, base + SKIP_SUFFIX);
            const srcTime = Math.max(mtime(srtPath), ...sources.map((x) => mtime(x.path)));
            if (!FORCE && Math.max(mtime(outPath), mtime(skipPath)) > srcTime) { stats.fresh++; continue; }

            try {
                const cues = parseCues(fs.readFileSync(srtPath, "utf8"));
                let best = null;
                for (const src of sources) {
                    const r = buildWords(cues, src.read(JSON.parse(fs.readFileSync(src.path, "utf8"))), src.name);
                    if (!best || r.anch > best.anch) best = r;
                }
                const { doc, anch, tot } = best;
                const pct = tot ? (anch / tot * 100).toFixed(1) : "0.0";
                const label = `${channel}/${extractVideoId(base) || base}`;
                if (!tot || doc.anchored < MIN_ANCHORED) {
                    stats.skippedLow++;
                    console.log(`   ⏭️  ${label} — usidreno ${pct} % < ${MIN_ANCHORED * 100} %, ne objavljujem`);
                    if (!DRY_RUN) {
                        fs.writeFileSync(skipPath, JSON.stringify({
                            reason: "low_anchored", source: doc.source, anchored: doc.anchored,
                            min_anchored: MIN_ANCHORED, words: tot, at: new Date().toISOString(),
                        }, null, 2) + "\n");
                        if (fs.existsSync(outPath)) fs.renameSync(outPath, outPath + ".bak");
                    }
                    continue;
                }
                stats.written++;
                if (VERBOSE || DRY_RUN) console.log(`   ✅ ${label} [${doc.source}] — usidreno ${pct} % od ${tot}, cue-ova ${doc.cues.length}`);
                if (!DRY_RUN) {
                    fs.writeFileSync(outPath, JSON.stringify(doc));
                    if (fs.existsSync(skipPath)) fs.unlinkSync(skipPath);
                }
            } catch (e) {
                stats.errors++;
                console.log(`   ❌ ${channel}/${base} — ${e.message}`);
            }
        }
    }
    console.log(`\n🔤 Zapisano: ${stats.written} · ispod praga: ${stats.skippedLow} · svježe (preskočeno): ${stats.fresh}` +
        ` · bez izvora vremena: ${stats.noSource} · greške: ${stats.errors}`);
    if (stats.errors) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { pyRound, norm, matchingBlocks, parseCues, buildWords, roundHalfEven, speechmaticsWords, canaryWords };
