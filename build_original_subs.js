#!/usr/bin/env node
/**
 * build_original_subs.js — izvorni engleski titl za engleske kanale.
 *
 * Kanonski `{base}.wav.canary.diarized.srt` engleskog kanala je HRVATSKI prijevod
 * (Canary en→hr), pa engleska epizoda nema ni engleski titl ni isticanje riječi.
 * Ova skripta iz drugog Canary prolaza (`canary_modal.py::batch --source-lang en
 * --target-lang en --out-tag en`) gradi:
 *
 *   {base}.diarized.en.srt       → data/{id}/diarized.en.srt   (upload_to_r2.js)
 *   {base}.words.en.json         → data/{id}/words.en.json     (≥ prag usidrenosti)
 *   {base}.words.en.skipped.json   (ispod praga; ne ide na CDN)
 *
 * Govornik EN cue-a = govornik HR cue-a s najvećim vremenskim preklapanjem, pa
 * `SPEAKER_xx` znači istu osobu u oba titla. Vrijeme po riječi gradi isti
 * `buildWords` kao KORAK 9.87, nad `.canary.en.word_ts.json` iz istog prolaza.
 * Ugovor: domovina.ai docs/plans/2026-10-29-titlovi-na-dva-jezika.md.
 *
 * Uporaba:
 *   node build_original_subs.js --channel catholic_futurist [--dry-run] [--force]
 *   node build_original_subs.js --channel subclub --video-id c9db521037e
 */

const fs = require("fs");
const path = require("path");
const { parseCues, buildWords, canaryWords } = require("./generate_words_json");

const args = process.argv.slice(2);
const getArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const CHANNEL = getArg("--channel");
const ONLY_VIDEO = getArg("--video-id");
const INPUT_DIR = getArg("--input-dir") || path.join(__dirname, "storage", "output");
const MIN_ANCHORED = parseFloat(getArg("--min-anchored") || "0.6");
const TAG = getArg("--lang") || "en";

const HR_SRT = ".wav.canary.diarized.srt";
const EN_SRT = `.wav.canary.${TAG}.srt`;
const EN_WORDS = `.wav.canary.${TAG}.word_ts.json`;
const OUT_SRT = `.diarized.${TAG}.srt`;
const OUT_WORDS = `.words.${TAG}.json`;
const OUT_SKIP = `.words.${TAG}.skipped.json`;

function srtMs(s) {
    const [h, m, r] = s.split(":");
    const [sec, f] = r.split(",");
    return ((+h * 60 + +m) * 60 + +sec) * 1000 + +f;
}
function msSrt(ms) {
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/** SRT blokovi: {s, e, speaker|null, text}. */
function parseSrt(raw) {
    const out = [];
    for (const block of raw.trim().split(/\r?\n\s*\r?\n/)) {
        const l = block.trim().split(/\r?\n/);
        if (l.length < 3) continue;
        const m = l[1].match(/(\S+)\s*-->\s*(\S+)/);
        if (!m) continue;
        let text = l.slice(2).map((x) => x.trim()).join(" ").trim();
        const sp = text.match(/^\[(\w+)\]\s*/);
        if (sp) text = text.slice(sp[0].length);
        if (text) out.push({ s: srtMs(m[1]), e: srtMs(m[2]), speaker: sp ? sp[1] : null, text });
    }
    return out;
}

/** Govornik HR cue-a s najvećim preklapanjem; bez preklapanja najbliži po vremenu. */
function assignSpeakers(en, hr) {
    let j = 0;
    return en.map((c) => {
        while (j < hr.length && hr[j].e <= c.s) j++;
        const overlap = new Map();
        for (let k = Math.max(0, j - 1); k < hr.length && hr[k].s < c.e; k++) {
            const o = Math.min(c.e, hr[k].e) - Math.max(c.s, hr[k].s);
            if (o > 0 && hr[k].speaker) overlap.set(hr[k].speaker, (overlap.get(hr[k].speaker) || 0) + o);
        }
        let speaker = [...overlap].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (!speaker) {
            const mid = (c.s + c.e) / 2;
            const near = hr.filter((h) => h.speaker)
                .reduce((b, h) => (!b || Math.abs((h.s + h.e) / 2 - mid) < Math.abs((b.s + b.e) / 2 - mid) ? h : b), null);
            speaker = near ? near.speaker : "SPEAKER_00";
        }
        return { ...c, speaker };
    });
}

function renderSrt(cues) {
    return cues.map((c, i) => `${i + 1}\n${msSrt(c.s)} --> ${msSrt(c.e)}\n[${c.speaker}] ${c.text}\n`).join("\n");
}

function main() {
    if (!CHANNEL) { console.error("Uporaba: node build_original_subs.js --channel CH [--video-id ID] [--dry-run] [--force]"); process.exit(2); }
    const dir = path.join(INPUT_DIR, CHANNEL);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(EN_SRT) && !f.startsWith("._"));
    const st = { written: 0, low: 0, noHr: 0, fresh: 0 };
    console.log(`🔤 izvorni titl (${TAG}) — ${CHANNEL}: ${files.length} kandidata${DRY_RUN ? " · DRY RUN" : ""}`);
    for (const f of files) {
        const base = f.slice(0, -EN_SRT.length);
        const vid = (base.match(/_yt_([A-Za-z0-9_-]{11})$/) || [])[1] || base;
        if (ONLY_VIDEO && vid !== ONLY_VIDEO) continue;
        const p = (s) => path.join(dir, base + s);
        if (!fs.existsSync(p(HR_SRT))) { st.noHr++; console.log(`   ⚠️  ${vid}: nema ${HR_SRT}`); continue; }
        if (!FORCE && fs.existsSync(p(OUT_SRT)) && fs.statSync(p(OUT_SRT)).mtimeMs > fs.statSync(p(EN_SRT)).mtimeMs) { st.fresh++; continue; }

        const en = assignSpeakers(parseSrt(fs.readFileSync(p(EN_SRT), "utf8")), parseSrt(fs.readFileSync(p(HR_SRT), "utf8")));
        const srt = renderSrt(en);
        let words = null;
        if (fs.existsSync(p(EN_WORDS))) {
            words = buildWords(parseCues(srt), canaryWords(JSON.parse(fs.readFileSync(p(EN_WORDS), "utf8"))), "canary");
        }
        const anchored = words ? words.doc.anchored : 0;
        const speakers = new Set(en.map((c) => c.speaker)).size;
        console.log(`   ${anchored >= MIN_ANCHORED ? "✅" : "⏭️ "} ${vid}: ${en.length} cue-ova, ${speakers} govornika, usidreno ${(anchored * 100).toFixed(1)} %`);
        if (DRY_RUN) continue;
        fs.writeFileSync(p(OUT_SRT), srt);
        if (words && anchored >= MIN_ANCHORED) {
            fs.writeFileSync(p(OUT_WORDS), JSON.stringify(words.doc));
            if (fs.existsSync(p(OUT_SKIP))) fs.unlinkSync(p(OUT_SKIP));
            st.written++;
        } else {
            fs.writeFileSync(p(OUT_SKIP), JSON.stringify({ reason: words ? "low_anchored" : "no_word_ts", source: "canary",
                anchored, min_anchored: MIN_ANCHORED, at: new Date().toISOString() }, null, 2) + "\n");
            if (fs.existsSync(p(OUT_WORDS))) fs.renameSync(p(OUT_WORDS), p(OUT_WORDS) + ".bak");
            st.low++;
        }
    }
    console.log(`\n🔤 titl+words: ${st.written} · titl bez words: ${st.low} · bez HR titla: ${st.noHr} · svježe: ${st.fresh}`);
}

if (require.main === module) main();
module.exports = { parseSrt, assignSpeakers, renderSrt };
