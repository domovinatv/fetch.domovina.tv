#!/usr/bin/env node
/**
 * tools/compare_asr.js — usporedba ASR/diarizacijskih izvora jedne epizode. Nula API poziva.
 *
 * Izvori (koji postoje):
 *   canonical            {base}.wav.canary.diarized.srt (ono što servira CDN)
 *   speechmatics         {audio}.speechmatics.json (riječi + Speechmatics govornici)
 *   speechmatics+gemini  {audio}.speechmatics.gemini.diarized.srt (KORAK 2.8)
 *   soniox               {audio}.soniox.words.json (riječi + Soniox govornici)
 *   soniox+pyannote      {audio}.soniox_pyannote.words.json (hibrid, diarize_pyannote_ai.js)
 *   speechmatics+pyannote  izračunato ovdje (Speechmatics riječi + isti pyannoteAI izlaz)
 *
 * Mjeri, prema referenci (default soniox+pyannote):
 *   • WER teksta (mala slova, bez interpunkcije, dijakritika OSTAJE — č/ć je razlika)
 *   • broj govornika
 *   • slaganje govornika po riječima: na poravnatim parovima riječi (jednake ili
 *     zamijenjene), uz najbolje 1:1 mapiranje oznaka
 * i izvozi MJESTA RAZLIKE (soniox prema drugom izvoru, s vremenom iz Soniox riječi)
 * za slijepo preslušavanje (`--diffs-out`).
 *
 *   node tools/compare_asr.js --channel muzevni_budite --video-id f2HIRJPHHK4
 *   node tools/compare_asr.js --video-id DOfcONrRyDY --channel muzevni_budite --json out.json --diffs-out diffs.json
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { speechmaticsToWords } = require("../lib/asr/words");
const { pyannoteSegments, assignSpeakers, speakerAgreement } = require("../lib/asr/hybrid");

const args = process.argv.slice(2);
function getArg(name, def = null) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : def;
}
const INPUT_DIR = getArg("--input-dir", path.join(__dirname, "..", "storage", "output"));
const CHANNEL = getArg("--channel");
const VIDEO_ID = getArg("--video-id");
const REF = getArg("--ref", "soniox+pyannote");
const JSON_OUT = getArg("--json");
const DIFFS_OUT = getArg("--diffs-out");
const DIFF_AGAINST = getArg("--diff-against", "canonical");

const normTok = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// ─── učitavanje izvora → [{t, speaker, start?}] ───
function fromWords(words) {
    return words.filter((w) => !w.punct)
        .flatMap((w) => normTok(w.w) ? [{ t: normTok(w.w), raw: w.w, speaker: w.speaker, start: w.start, end: w.end }] : []);
}
function fromSrt(raw) {
    const out = [];
    for (const block of raw.trim().split(/\r?\n\s*\r?\n/)) {
        const l = block.trim().split("\n");
        if (l.length < 3) continue;
        let t = l.slice(2).join(" ").trim();
        const m = t.match(/^\[(\w+)\]\s*/);
        const speaker = m ? m[1] : null;
        if (m) t = t.slice(m[0].length);
        for (const w of t.split(/\s+/)) if (normTok(w)) out.push({ t: normTok(w), raw: w, speaker });
    }
    return out;
}

function loadSources(dir, base) {
    const P = (f) => path.join(dir, f);
    const ex = (f) => fs.existsSync(P(f));
    const J = (f) => JSON.parse(fs.readFileSync(P(f), "utf-8"));
    const src = {};
    if (ex(base + ".wav.canary.diarized.srt")) src.canonical = fromSrt(fs.readFileSync(P(base + ".wav.canary.diarized.srt"), "utf-8"));
    for (const ext of ["mp3", "m4a", "wav"]) {
        const a = `${base}.${ext}`;
        if (ex(a + ".speechmatics.json") && !src.speechmatics) {
            const smWords = speechmaticsToWords(J(a + ".speechmatics.json"));
            src.speechmatics = fromWords(smWords);
            if (ex(a + ".pyannote_ai.json")) src["speechmatics+pyannote"] = fromWords(assignSpeakers(smWords, pyannoteSegments(J(a + ".pyannote_ai.json"))));
        }
        if (ex(a + ".speechmatics.gemini.diarized.srt")) src["speechmatics+gemini"] = fromSrt(fs.readFileSync(P(a + ".speechmatics.gemini.diarized.srt"), "utf-8"));
        if (ex(a + ".soniox.words.json")) src.soniox = fromWords(J(a + ".soniox.words.json").words);
        if (ex(a + ".soniox_pyannote.words.json")) src["soniox+pyannote"] = fromWords(J(a + ".soniox_pyannote.words.json").words);
    }
    return src;
}

// ─── Levenshtein po riječima s putem (Uint8 matrica smjerova) ───
// 0 = jednako, 1 = zamjena, 2 = brisanje (riječ samo u A), 3 = umetanje (samo u B)
function align(A, B) {
    const n = A.length, m = B.length;
    const dir = new Uint8Array((n + 1) * (m + 1));
    let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
    for (let j = 0; j <= m; j++) { prev[j] = j; dir[j] = 3; }
    for (let i = 1; i <= n; i++) {
        cur[0] = i; dir[i * (m + 1)] = 2;
        const a = A[i - 1].t;
        for (let j = 1; j <= m; j++) {
            const eq = a === B[j - 1].t;
            let best = prev[j - 1] + (eq ? 0 : 1), d = eq ? 0 : 1;
            if (prev[j] + 1 < best) { best = prev[j] + 1; d = 2; }
            if (cur[j - 1] + 1 < best) { best = cur[j - 1] + 1; d = 3; }
            cur[j] = best; dir[i * (m + 1) + j] = d;
        }
        [prev, cur] = [cur, prev];
    }
    const ops = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
        const d = dir[i * (m + 1) + j];
        if (i > 0 && j > 0 && d <= 1) { ops.push([d, i - 1, j - 1]); i--; j--; }
        else if (i > 0 && (d === 2 || j === 0)) { ops.push([2, i - 1, -1]); i--; }
        else { ops.push([3, -1, j - 1]); j--; }
    }
    ops.reverse();
    return { dist: prev[m], ops };
}

function compare(ref, hyp) {
    const { dist, ops } = align(ref, hyp);
    const pa = [], pb = [];
    for (const [d, i, j] of ops) if (d <= 1) { pa.push(ref[i]); pb.push(hyp[j]); }
    return {
        wer: ref.length ? dist / ref.length : 0,
        speaker_agreement: speakerAgreement(pa, pb),
        ops,
    };
}

/** Uzastopni nizovi ne-jednakih operacija → mjesta razlike s vremenom iz reference. */
function diffSpots(ref, hyp, ops, refName, hypName) {
    const spots = [];
    let cur = null;
    const close = () => { if (cur) { spots.push(cur); cur = null; } };
    let lastRefStart = 0;
    for (const [d, i, j] of ops) {
        if (i >= 0 && ref[i].start != null) lastRefStart = ref[i].start;
        if (d === 0) { close(); continue; }
        if (!cur) cur = { start: lastRefStart, [refName]: [], [hypName]: [] };
        if (i >= 0) cur[refName].push(ref[i].t);
        if (j >= 0) cur[hypName].push(hyp[j].t);
        cur.end = lastRefStart;
    }
    close();
    return spots.map((s) => ({ ...s, [refName]: s[refName].join(" "), [hypName]: s[hypName].join(" ") }));
}

function main() {
    const channels = CHANNEL ? [CHANNEL] : fs.readdirSync(INPUT_DIR);
    let found = null;
    for (const ch of channels) {
        const dir = path.join(INPUT_DIR, ch);
        let files; try { files = fs.readdirSync(dir); } catch { continue; }
        const f = files.find((x) => x.endsWith(`_yt_${VIDEO_ID}.wav.canary.diarized.srt`)) ||
                  files.find((x) => x.includes(`_yt_${VIDEO_ID}.`) && x.endsWith(".soniox.meta.json"));
        if (f) { found = { dir, base: f.slice(0, f.indexOf(`_yt_${VIDEO_ID}`) + 4 + VIDEO_ID.length) }; break; }
    }
    if (!found) { console.error(`❌ Nema epizode ${VIDEO_ID}`); process.exit(1); }
    const src = loadSources(found.dir, found.base);
    if (!src[REF]) { console.error(`❌ Nema referentnog izvora ${REF}; ima: ${Object.keys(src).join(", ")}`); process.exit(1); }

    const rows = [];
    let diffs = null;
    for (const [name, toks] of Object.entries(src)) {
        const spk = new Set(toks.map((x) => x.speaker).filter((s) => s != null && s !== "UNKNOWN")).size;
        if (name === REF) { rows.push({ source: name, words: toks.length, speakers: spk, wer: 0, speaker_agreement: 1 }); continue; }
        const c = compare(src[REF], toks);
        rows.push({ source: name, words: toks.length, speakers: spk, wer: +c.wer.toFixed(4), speaker_agreement: +c.speaker_agreement.toFixed(4) });
        if (DIFFS_OUT && name === DIFF_AGAINST) {
            // Mjesta razlike TEKSTA: soniox prema izabranom izvoru (vremena iz Sonioxa).
            const sx = src.soniox || src[REF];
            const cc = compare(sx, toks);
            diffs = diffSpots(sx, toks, cc.ops, "soniox", name);
        }
    }
    console.log(`\n📏 ${path.basename(found.dir)}/${VIDEO_ID} — referenca: ${REF}`);
    console.log("izvor".padEnd(24) + "riječi".padStart(8) + "govornika".padStart(11) + "WER".padStart(9) + "slaganje govornika".padStart(21));
    for (const r of rows) {
        console.log(r.source.padEnd(24) + String(r.words).padStart(8) + String(r.speakers).padStart(11) +
            `${(r.wer * 100).toFixed(1)} %`.padStart(9) + `${(r.speaker_agreement * 100).toFixed(1)} %`.padStart(21));
    }
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ video_id: VIDEO_ID, ref: REF, rows }, null, 2));
    if (DIFFS_OUT && diffs) {
        fs.writeFileSync(DIFFS_OUT, JSON.stringify({ video_id: VIDEO_ID, a: "soniox", b: DIFF_AGAINST, spots: diffs }, null, 2));
        console.log(`\n🔍 ${diffs.length} mjesta razlike soniox ↔ ${DIFF_AGAINST} → ${DIFFS_OUT}`);
    }
}

if (require.main === module) main();
module.exports = { align, compare, fromSrt, fromWords, normTok, diffSpots, loadSources };
