/**
 * lib/asr/words.js — JEDAN format riječi za sve cloud ASR izvore (Soniox, Speechmatics)
 * i iz njega SRT segmenti istog oblika kao canary izlaz.
 *
 *   { w: "listopada", start: 12.34, end: 12.80, speaker: "1" | "S1" | null,
 *     punct?: true,   // samostalna interpunkcija, lijepi se na prethodnu riječ
 *     eos?: true,     // kraj rečenice (samo na interpunkciji)
 *     conf?: 0.97 }
 *
 * `speaker` je SIROVA oznaka providera (Soniox "1", Speechmatics "S1"); null = nepoznat
 * (Speechmatics "UU", Soniox bez diarizacije). U SPEAKER_00/01/… se mapira tek u
 * buildSegments(), po redoslijedu prvog pojavljivanja.
 *
 * Normalizacija Soniox tokena je port `newsroom-be` `soniox_client.py` (NEWS-1034):
 * tokeni su dijelovi riječi, nova riječ počinje razmakom; interpunkcija na kraju riječi
 * se odvaja („listopada,” → „listopada” + „,”); točka ispred malog slova ISTOG govornika
 * nije kraj rečenice („23. listopada”, „tzv. ovo”).
 */
"use strict";

const SENTENCE_END = /[.!?…]$/;
const CLOSING_MARKS = /["')\]»“”’]+$/;
const IS_PUNCT = /\p{P}/u;

function splitTrailingPunctuation(text) {
    // Interpunkcija UNUTAR riječi („5.5”, „don't”) ostaje; riječ od same interpunkcije
    // („-”, „?”) je cijela trailing.
    const chars = [...text];
    let end = chars.length;
    while (end > 0 && IS_PUNCT.test(chars[end - 1])) end--;
    return [chars.slice(0, end).join(""), chars.slice(end).join("")];
}

function isLower(s) {
    return s.toLowerCase() === s && s.toUpperCase() !== s;
}

/** Soniox `tokens[]` (GET /v1/transcriptions/{id}/transcript) → riječi. */
function sonioxTokensToRawWords(tokens) {
    const words = [];
    let closed = true;
    for (const t of tokens || []) {
        const text = t.text || "";
        if (t.translation_status === "translation") continue;
        if (!text.trim()) { closed = true; continue; }
        const last = words[words.length - 1];
        if (last && !closed && !text.startsWith(" ")) {
            last.text += text;
            last.end_ms = t.end_ms;
            last.confidences.push(t.confidence ?? 0);
            continue;
        }
        words.push({
            text: text.trim(),
            start_ms: t.start_ms,
            end_ms: t.end_ms,
            speaker: t.speaker ?? null,
            confidences: [t.confidence ?? 0],
        });
        closed = false;
    }
    return words;
}

function sonioxToWords(transcript) {
    const out = [];
    for (const rw of sonioxTokensToRawWords(transcript.tokens)) {
        const [content, trailing] = splitTrailingPunctuation(rw.text);
        const base = {
            start: rw.start_ms / 1000,
            end: rw.end_ms / 1000,
            speaker: rw.speaker != null && rw.speaker !== "" ? String(rw.speaker) : null,
            conf: Math.min(...rw.confidences),
        };
        if (content) out.push({ w: content, ...base });
        if (trailing) {
            const p = { w: trailing, ...base, punct: true };
            if (SENTENCE_END.test(trailing.replace(CLOSING_MARKS, ""))) p.eos = true;
            out.push(p);
        }
    }
    fixOrdinalStops(out);
    return out;
}

/** Speechmatics json-v2 `results[]` → riječi. */
function speechmaticsToWords(json) {
    const out = [];
    for (const r of json.results || []) {
        if (r.type !== "word" && r.type !== "punctuation") continue;
        const alt = (r.alternatives && r.alternatives[0]) || {};
        if (!alt.content) continue;
        const item = {
            w: alt.content,
            start: r.start_time,
            end: r.end_time,
            speaker: alt.speaker && alt.speaker !== "UU" ? alt.speaker : null,
        };
        if (alt.confidence != null) item.conf = alt.confidence;
        if (r.type === "punctuation") {
            item.punct = true;
            if (r.is_eos || SENTENCE_END.test(alt.content.replace(CLOSING_MARKS, ""))) item.eos = true;
        }
        out.push(item);
    }
    fixOrdinalStops(out);
    return out;
}

// Točka ispred malog slova istog govornika je redni broj ili kratica.
function fixOrdinalStops(words) {
    for (let i = 0; i < words.length - 1; i++) {
        const a = words[i], b = words[i + 1];
        if (a.eos && a.w.replace(CLOSING_MARKS, "") === "." && !b.punct && isLower(b.w) && b.speaker === a.speaker) {
            delete a.eos;
        }
    }
    // Govor nakon zadnje točke inače nikad ne bi bio zatvoren.
    const last = words[words.length - 1];
    if (last && last.punct) last.eos = true;
}

// ─── riječi → SRT segmenti (~10 s, [SPEAKER_XX]) ───
//
// Ista pravila kao transcribe_speechmatics.js buildSegments(), da cloud izlaz izgleda
// kao canary: downstream (članci, RAG, screenshotovi) očekuje segmente od ~10 s.
const SEG_SOFT_MAX_S = 12;   // iznad ovoga zatvori na prvoj rečeničnoj granici
const SEG_HARD_MAX_S = 22;   // apsolutni strop
const SEG_PAUSE_S = 1.2;     // tišina duža od ovoga je granica ako segment već ima sadržaja
const SEG_MIN_S = 2.0;

function buildSegments(words) {
    const speakerMap = new Map();
    const mapSpeaker = (raw) => {
        if (raw == null) return "UNKNOWN";
        if (!speakerMap.has(raw)) speakerMap.set(raw, `SPEAKER_${String(speakerMap.size).padStart(2, "0")}`);
        return speakerMap.get(raw);
    };

    const segments = [];
    let cur = null;
    const flush = () => {
        if (!cur) return;
        const text = cur.tokens.join("").replace(/\s+/g, " ").trim();
        if (text) segments.push({ start: cur.start, end: cur.end, speaker: cur.speaker, text });
        cur = null;
    };

    for (const wd of words) {
        if (!wd.w) continue;
        if (cur && !wd.punct) {
            const speaker = mapSpeaker(wd.speaker);
            const gap = wd.start - cur.end;
            const dur = cur.end - cur.start;
            if (
                speaker !== cur.speaker ||
                dur >= SEG_HARD_MAX_S ||
                (dur >= SEG_SOFT_MAX_S && cur.eos) ||
                (gap >= SEG_PAUSE_S && dur >= SEG_MIN_S)
            ) flush();
        }
        if (!cur) {
            // Segment ne počinje interpunkcijom (osim ako je sve što imamo).
            cur = { start: wd.start, end: wd.end, speaker: mapSpeaker(wd.speaker), tokens: [], eos: false };
        }
        cur.tokens.push(cur.tokens.length === 0 || wd.punct ? wd.w : " " + wd.w);
        cur.end = Math.max(cur.end, wd.end);
        cur.eos = !!(wd.punct && wd.eos);
    }
    flush();
    return { segments, speakerCount: speakerMap.size };
}

function secondsToSrtTimestamp(seconds) {
    const ms = Math.round(seconds * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const rest = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:` +
           `${String(s).padStart(2, "0")},${String(rest).padStart(3, "0")}`;
}

function renderSrt(segments, withSpeakers) {
    const out = [];
    segments.forEach((seg, i) => {
        const prefix = withSpeakers ? `[${seg.speaker}] ` : "";
        out.push(
            `${i + 1}`,
            `${secondsToSrtTimestamp(seg.start)} --> ${secondsToSrtTimestamp(seg.end)}`,
            `${prefix}${seg.text}`,
            ""
        );
    });
    return out.join("\n");
}

module.exports = {
    splitTrailingPunctuation, sonioxTokensToRawWords, sonioxToWords, speechmaticsToWords,
    buildSegments, renderSrt, secondsToSrtTimestamp,
};
