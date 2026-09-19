#!/usr/bin/env node
/**
 * tools/compare_transcripts.js — tvrde brojke za usporedbu ASR izlaza
 *
 * Ne prosuđuje stil; mjeri ono što se MOŽE izmjeriti bez ušiju:
 *   • degeneracija (ASR collapse) — najdulji niz iste riječi, udio ponovljenih
 *     trigrama, broj mjesta s 3+ uzastopne identične riječi. Ovo je brojka koja
 *     hvata Canaryjevo "nije, nije, nije…" 30×.
 *   • pokrivenost — riječi/min i praznine u vremenskoj osi.
 *   • preklapanje — Jaccard nad trigramima između dva transkripta; gdje se dva
 *     nezavisna ASR-a slažu, vjerojatno su oba u pravu.
 *
 * Namjerno NE donosi presudu o točnosti: za to treba uho (v. KORAK 2.8 i
 * `docs/` zapis o usporedbi).
 *
 *   node tools/compare_transcripts.js <srt> [<srt> ...] [--json]
 *   node tools/compare_transcripts.js --video-id aue1GuuMsbA
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const getArg = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : d; };
const AS_JSON = args.includes("--json");
const VIDEO_ID = getArg("--video-id");
const SAMPLE_N = parseInt(getArg("--sample", "0"), 10);
const INPUT_DIR = getArg("--input-dir", "storage/output");

function timeToSeconds(ts) {
    const m = ts.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return 0;
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

function parseSrt(text) {
    const out = [];
    for (const block of text.split(/\n\s*\n+/)) {
        const lines = block.split("\n").filter((l) => l.trim());
        if (lines.length < 2) continue;
        const tIdx = lines.findIndex((l) => l.includes("-->"));
        if (tIdx === -1) continue;
        const [a, b] = lines[tIdx].split("-->");
        let body = lines.slice(tIdx + 1).join(" ").trim();
        let speaker = null;
        const sm = body.match(/^\[([^\]]+)\]\s*/);
        if (sm) { speaker = sm[1]; body = body.slice(sm[0].length); }
        if (!body) continue;
        out.push({ start: timeToSeconds(a), end: timeToSeconds(b), speaker, text: body });
    }
    return out;
}

// Normalizacija za usporedbu: mala slova, bez interpunkcije, bez dijakritike.
// Dijakritika pada jer se ASR-i razlikuju u č/ć i to nije sadržajna razlika.
function normWords(s) {
    return String(s || "")
        .toLowerCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/).filter(Boolean);
}

function trigrams(words) {
    const out = new Set();
    for (let i = 0; i + 2 < words.length; i++) out.add(words.slice(i, i + 3).join(" "));
    return out;
}

function degeneracy(words) {
    let maxRun = 1, run = 1, runs3 = 0, inRun = false;
    for (let i = 1; i < words.length; i++) {
        if (words[i] === words[i - 1]) {
            run++;
            if (run >= 3 && !inRun) { runs3++; inRun = true; }
        } else {
            if (run > maxRun) maxRun = run;
            run = 1; inRun = false;
        }
    }
    if (run > maxRun) maxRun = run;

    // Udio trigrama koji se pojavljuju više od jednom — kod zdravog govora je
    // nizak; kod collapsea skoči jer model melje isti niz.
    const counts = new Map();
    for (let i = 0; i + 2 < words.length; i++) {
        const k = words.slice(i, i + 3).join(" ");
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    let repeated = 0, total = 0;
    for (const c of counts.values()) { total += c; if (c > 1) repeated += c; }
    return { max_run: maxRun, runs_3plus: runs3, repeated_trigram_ratio: total ? repeated / total : 0 };
}

/**
 * CIKLIČKI collapse — ponavlja se FRAZA, ne jedna riječ.
 *
 * `degeneracy().max_run` gleda samo identične uzastopne tokene, pa mu ovo
 * potpuno izmakne:
 *   "on je vodio on, on je vodio on, on je vodio on…" (×14)  → max_run = 1
 * Izmjereno 19.09. na `70uXR4DDZiE`, epizodi kojoj je max_run javio bezopasnih 8.
 *
 * Mjera: najdulji niz uzastopnih ponavljanja istog bloka duljine 2..8 riječi.
 * Vraća broj ponavljanja i sam blok, da se u ispisu vidi ŠTO se melje.
 */
function cyclicDegeneracy(words) {
    let best = { cycle_reps: 1, cycle_len: 0, cycle: "" };
    for (let period = 2; period <= 8; period++) {
        let i = 0;
        while (i + period * 2 <= words.length) {
            let reps = 1;
            while (i + period * (reps + 1) <= words.length) {
                let same = true;
                for (let k = 0; k < period; k++) {
                    if (words[i + k] !== words[i + period * reps + k]) { same = false; break; }
                }
                if (!same) break;
                reps++;
            }
            if (reps > best.cycle_reps) {
                best = { cycle_reps: reps, cycle_len: period, cycle: words.slice(i, i + period).join(" ") };
            }
            i += reps > 1 ? period * reps : 1;
        }
    }
    return best;
}

function analyze(file) {
    const segs = parseSrt(fs.readFileSync(file, "utf-8"));
    const words = normWords(segs.map((s) => s.text).join(" "));
    const dur = segs.length ? segs[segs.length - 1].end : 0;
    const spoken = segs.reduce((s, x) => s + Math.max(0, x.end - x.start), 0);
    const speakers = new Set(segs.map((s) => s.speaker).filter(Boolean));

    // Praznine: tišina duža od 15 s između segmenata je ili stvarna pauza ili
    // progutan govor. Broj i zbroj daju grubu sliku ispuštenog sadržaja.
    let gaps = 0, gapSec = 0;
    for (let i = 1; i < segs.length; i++) {
        const g = segs[i].start - segs[i - 1].end;
        if (g > 15) { gaps++; gapSec += g; }
    }

    return {
        file: path.basename(file),
        segments: segs.length,
        speakers: speakers.size,
        words: words.length,
        duration_min: +(dur / 60).toFixed(1),
        words_per_min: dur ? +(words.length / (dur / 60)).toFixed(1) : 0,
        spoken_ratio: dur ? +(spoken / dur).toFixed(3) : 0,
        gaps_over_15s: gaps,
        gap_seconds: Math.round(gapSec),
        ...degeneracy(words),
        ...cyclicDegeneracy(words),
        _tri: trigrams(words),
    };
}

function findForVideo(videoId, root) {
    const found = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory() || e.isSymbolicLink()) {
                let st; try { st = fs.statSync(p); } catch (_) { continue; }
                if (st.isDirectory()) walk(p);
                continue;
            }
            if (e.name.includes(`_yt_${videoId}`) && e.name.endsWith(".srt")) found.push(p);
        }
    };
    walk(root);
    return found.sort();
}

/**
 * Poravnata usporedba po VREMENU, ne po rednom broju segmenta.
 *
 * Različiti ASR-i segmentiraju različito (Canary je na istoj epizodi dao 1695
 * segmenata, Speechmatics 993), pa je "segment br. 100" u jednom i drugom
 * potpuno drugo mjesto. Jedino zajedničko sidro je sat.
 */
function sample(files, n) {
    const parsed = files.map((f) => ({ file: f, segs: parseSrt(fs.readFileSync(f, "utf-8")) }));
    const dur = Math.max(...parsed.map((p) => (p.segs.length ? p.segs[p.segs.length - 1].end : 0)));
    if (!dur) { console.error("Prazni transkripti."); return; }

    // Ravnomjerno po epizodi, bez prvih i zadnjih 5 % (špica i odjava nisu reprezentativne).
    const points = [];
    for (let i = 0; i < n; i++) points.push(dur * (0.05 + (0.9 * (i + 0.5)) / n));

    const label = (f) => path.basename(f).replace(/^.*_yt_[A-Za-z0-9_-]+\./, "").replace(/\.srt$/, "");
    const width = Math.max(...parsed.map((p) => label(p.file).length));

    for (const t of points) {
        console.log(`\n┌─ ${secondsToHms(t)} ${"─".repeat(70)}`);
        for (const p of parsed) {
            // Uzmi sve segmente koji dodiruju prozor od 20 s oko točke.
            const hit = p.segs.filter((s) => s.end > t - 10 && s.start < t + 10);
            const text = hit.map((s) => (s.speaker ? `[${s.speaker}] ` : "") + s.text).join(" ") || "—";
            console.log(`│ ${label(p.file).padEnd(width)} │ ${text.slice(0, 400)}`);
        }
    }
    console.log();
}

function secondsToHms(x) {
    const s = Math.round(x);
    return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function main() {
    let files = args.filter((a) => a.endsWith(".srt") && fs.existsSync(a));
    if (VIDEO_ID) files = findForVideo(VIDEO_ID, INPUT_DIR);
    if (files.length === 0) {
        console.error("Nema .srt datoteka. Zadaj putanje ili --video-id.");
        process.exit(1);
    }

    if (SAMPLE_N > 0) { sample(files, SAMPLE_N); return; }

    const rows = files.map(analyze);

    if (AS_JSON) {
        console.log(JSON.stringify(rows.map(({ _tri, ...r }) => r), null, 2));
        return;
    }

    const label = (f) => f.replace(/^.*_yt_[A-Za-z0-9_-]+\./, "").replace(/\.srt$/, "");
    const pad = (s, n) => String(s).padEnd(n);
    const num = (s, n) => String(s).padStart(n);

    console.log("\n╔═══ USPOREDBA TRANSKRIPATA ═══════════════════════════════════════════════════════╗\n");
    console.log(pad("izvor", 34) + num("riječi", 8) + num("r/min", 7) + num("seg", 6) + num("gov", 5) + num("maxRun", 8) + num("3+×", 6) + num("ciklus", 7) + num("rep3g", 8));
    console.log("─".repeat(82));
    for (const r of rows) {
        console.log(
            pad(label(r.file).slice(0, 33), 34) +
            num(r.words, 8) + num(r.words_per_min, 7) + num(r.segments, 6) +
            num(r.speakers || "-", 5) + num(r.max_run, 8) + num(r.runs_3plus, 6) + num(r.cycle_reps, 7) +
            num((r.repeated_trigram_ratio * 100).toFixed(1) + "%", 8)
        );
    }

    console.log("\n  maxRun = najdulji niz iste riječi zaredom · 3+× = mjesta s 3+ ponavljanja");
    console.log("  ciklus = najviše ponavljanja iste FRAZE zaredom (maxRun ovo ne vidi)\n  rep3g  = udio trigrama koji se javljaju više puta (visok ⇒ ASR collapse)\n");

    if (rows.length > 1) {
        console.log("── Preklapanje (Jaccard nad trigramima) ──");
        for (let i = 0; i < rows.length; i++) {
            for (let j = i + 1; j < rows.length; j++) {
                const a = rows[i]._tri, b = rows[j]._tri;
                let inter = 0;
                for (const t of a) if (b.has(t)) inter++;
                const uni = a.size + b.size - inter;
                console.log(`  ${label(rows[i].file).slice(0, 28)}  ×  ${label(rows[j].file).slice(0, 28)}  →  ${uni ? ((inter / uni) * 100).toFixed(1) : 0}%`);
            }
        }
        console.log();
    }
}

if (require.main === module) main();

module.exports = { parseSrt, normWords, degeneracy, cyclicDegeneracy, analyze, sample };
