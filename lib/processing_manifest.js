/**
 * lib/processing_manifest.js — `{base}.processing.json`: kako je epizoda obrađena.
 *
 * Jedno mjesto koje kaže ODAKLE je koji artefakt: ASR izvor(i), diarizacija, Gemini sluh,
 * što je kanonski `.wav.canary.diarized.srt` zapravo, model sažetka i članka, nad kojim
 * člankom je rađen Magisterium, izvor `words.json`. Do sada se to moralo rekonstruirati
 * ručno iz imena datoteka i pet različitih meta formata.
 *
 * Manifest se IZVODI iz datoteka na disku (nula API poziva), pa je „update u koraku” isto
 * što i ponovno generiranje: korak nakon pisanja zove writeManifest(dir, base). Tako
 * backfill i živi pipeline daju isti rezultat i manifest ne može zastarjeti u odnosu na
 * datoteke iz kojih je izveden.
 *
 * NE ide na R2 (docs/data_contract.md §16): sadrži job ID-jeve i procjene troška.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const AUDIO_EXTS = ["mp3", "m4a", "opus", "ogg", "flac", "wav"];
const SKELETONS = ["speechmatics", "soniox_pyannote", "speechmatics_pyannote", "soniox"];

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}
function mtimeIso(p) {
    try { return fs.statSync(p).mtime.toISOString(); } catch { return null; }
}
function sameContent(a, b) {
    try {
        const sa = fs.statSync(a), sb = fs.statSync(b);
        return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
    } catch { return false; }
}
function pick(obj, keys) {
    if (!obj) return null;
    const out = {};
    for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
    return out;
}
function extractVideoId(name) {
    // Zadnji _yt_ pogodak — naslovi znaju sadržavati "_yt_" (memory extract_video_id_last_match).
    // Lookahead da se pogoci mogu preklapati: „…_yt_u_imenu_yt_ID” inače proguta pravi ID.
    const all = [...name.matchAll(/(?=_yt_([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-]))/g)];
    return all.length ? all[all.length - 1][1] : null;
}

function buildManifest(dir, base, files = null) {
    files = files || fs.readdirSync(dir).filter((f) => f.startsWith(base) && !f.startsWith("._"));
    const has = (f) => files.includes(f);
    const P = (f) => path.join(dir, f);

    // ─── ASR ───
    const asr = [];
    if (has(base + ".wav.canary.srt")) {
        const wt = has(base + ".wav.canary.word_ts.json");
        asr.push({ provider: "canary", file: base + ".wav.canary.srt", word_timestamps: wt, at: mtimeIso(P(base + ".wav.canary.srt")) });
    }
    for (const ext of AUDIO_EXTS) {
        const sx = readJson(P(`${base}.${ext}.soniox.meta.json`));
        if (sx) asr.push({ ...pick(sx, ["provider", "model", "job_id", "audio_seconds", "est_usd", "fallback_reason"]), via: "transcribe_soniox", audio: `${base}.${ext}`, at: sx.generated_at });
        const sm = readJson(P(`${base}.${ext}.speechmatics.meta.json`));
        if (sm) asr.push({ provider: "speechmatics", ...pick(sm, ["job_id", "audio_seconds", "fallback_from"]), est_usd: sm.estimated_usd, audio: `${base}.${ext}`, at: sm.generated_at });
    }

    // ─── Diarizacija ───
    const diarization = [];
    for (const ext of AUDIO_EXTS) {
        const pa = readJson(P(`${base}.${ext}.pyannote_ai.meta.json`));
        if (pa) diarization.push({ provider: "pyannote_ai", ...pick(pa, ["model", "job_id", "speakers", "est_usd"]), audio: `${base}.${ext}`, at: pa.generated_at });
    }

    // ─── Gemini sluh (KORAK 2.8) ───
    // Kostur: speechmatics (KORAK 2.8) ili soniox_pyannote / speechmatics_pyannote / soniox
    // (refine_diarized_gemini.js --skeleton). Svi pokušaji, ne samo zadnji.
    const geminiEar = [];
    for (const ext of AUDIO_EXTS) {
        for (const sk of SKELETONS) {
            const g = readJson(P(`${base}.${ext}.${sk}.gemini.meta.json`));
            if (g) geminiEar.push({ skeleton: sk, ...pick(g, ["model", "source", "segments", "speakers", "est_usd"]), at: g.at });
        }
    }

    // ─── Kanonski SRT: što je on ZAPRAVO (po sadržaju, ne po imenu) ───
    const canonicalName = base + ".wav.canary.diarized.srt";
    let canonical = null;
    if (has(canonicalName)) {
        let origin = null;
        const candidates = [];
        for (const ext of AUDIO_EXTS) {
            candidates.push([`${base}.${ext}.speechmatics.gemini.diarized.srt`, "speechmatics+gemini"]);
            candidates.push([`${base}.${ext}.soniox_pyannote.gemini.diarized.srt`, "soniox+pyannote_ai+gemini"]);
            candidates.push([`${base}.${ext}.speechmatics_pyannote.gemini.diarized.srt`, "speechmatics+pyannote_ai+gemini"]);
            candidates.push([`${base}.${ext}.soniox_pyannote.diarized.srt`, "soniox+pyannote_ai"]);
            candidates.push([`${base}.${ext}.speechmatics_pyannote.diarized.srt`, "speechmatics+pyannote_ai"]);
            candidates.push([`${base}.${ext}.speechmatics.diarized.srt`, "speechmatics"]);
            candidates.push([`${base}.${ext}.soniox.diarized.srt`, "soniox"]);
        }
        for (const [f, o] of candidates) {
            if (!has(f) || !sameContent(P(f), P(canonicalName))) continue;
            origin = o;
            // --no-gemini (28.10.2026.) piše pod .gemini.* imenom bez Gemini poziva — meta kaže istinu.
            const m = o.endsWith("+gemini") ? readJson(P(f.replace(/\.diarized\.srt$/, ".meta.json"))) : null;
            if (m && m.gemini_ear === false) origin = o.slice(0, -"+gemini".length);
            break;
        }
        if (!origin && has(base + ".wav.canary.srt")) origin = "canary+pyannote_local";
        canonical = { file: canonicalName, origin: origin || "nepoznato", at: mtimeIso(P(canonicalName)) };
    }
    // Lokalni pyannote (KORAK 6) samo kad je kanonski SRT stvarno nastao iz njega.
    if (canonical && canonical.origin === "canary+pyannote_local") {
        const emb = files.some((f) => f.startsWith(base + ".wav.canary.diarized.embeddings.pyannote"));
        diarization.push({ provider: "pyannote_local", voice_embeddings: emb });
    }

    // ─── Sažetak, članak, Magisterium ───
    const sumJson = readJson(P(base + ".wav.canary.summary.json"));
    const summary = sumJson ? { model: sumJson.model || null, at: sumJson.generated_at || null } : null;

    // {base}.wav.canary.diarized_{date}_{model}.article.json — model slug sadrži točke.
    const artRe = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.wav\\.canary\\.diarized_(\\d{4}-\\d{2}-\\d{2})_(.+?)\\.article\\.json$`);
    const articles = files
        .map((f) => { const m = f.match(artRe); return m ? { file: f, date: m[1], slug: m[2] } : null; })
        .filter(Boolean)
        .sort((a, b) => (a.file < b.file ? -1 : 1));
    for (const a of articles) {
        const j = readJson(P(a.file));
        const md = (j && j.metadata) || {};
        Object.assign(a, pick(md, ["model", "complete", "iterations_expected"]), { at: md.generated_at || null });
    }
    // Downstream dedupa po leksikografski najvećem imenu (CLAUDE.md, „slug odlučuje”).
    const article = articles.length ? { served: articles[articles.length - 1].file, all: articles } : null;

    const magisterium = files
        .filter((f) => f.endsWith(".article.magisterium.json"))
        .map((f) => {
            const m = readJson(P(f)) || {};
            return { file: f, source_article: m.source_article || null, model: m.model || null, overall_score: m.overall_score ?? null, at: m.generated_at || null };
        });

    // ─── words.json ───
    const wj = readJson(P(base + ".words.json"));
    const ws = readJson(P(base + ".words.skipped.json"));
    const words = wj ? { source: wj.source, anchored: wj.anchored, at: mtimeIso(P(base + ".words.json")) }
        : ws ? { skipped: ws.reason, source: ws.source, anchored: ws.anchored } : null;

    return {
        v: 1,
        video_id: extractVideoId(base),
        channel: path.basename(dir),
        base,
        asr,
        diarization,
        gemini_ear: geminiEar.length ? geminiEar : null,
        canonical_srt: canonical,
        summary,
        article,
        magisterium,
        words_json: words,
        ebook: has(base + ".epub") ? { at: mtimeIso(P(base + ".epub")) } : null,
    };
}

/** Piše `{base}.processing.json` samo kad se sadržaj promijeni (generated_at izvan usporedbe). */
function writeManifest(dir, base, { dryRun = false } = {}) {
    const doc = buildManifest(dir, base);
    const out = path.join(dir, base + ".processing.json");
    const prev = readJson(out);
    if (prev) {
        const { generated_at: _ignored, ...rest } = prev;
        if (JSON.stringify(rest) === JSON.stringify(doc)) return { changed: false, path: out, doc: prev };
    }
    const full = { ...doc, generated_at: new Date().toISOString() };
    if (!dryRun) fs.writeFileSync(out, JSON.stringify(full, null, 2) + "\n", "utf-8");
    return { changed: true, path: out, doc: full };
}

/** `{base}.mp3` / `{base}.wav` → base (za skripte koje rade po audio datoteci). */
function baseFromAudio(audioPath) {
    const name = path.basename(audioPath);
    const ext = path.extname(name).slice(1).toLowerCase();
    return AUDIO_EXTS.includes(ext) ? name.slice(0, -(ext.length + 1)) : name;
}

module.exports = { buildManifest, writeManifest, baseFromAudio, extractVideoId };
