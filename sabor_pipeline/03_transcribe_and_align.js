#!/usr/bin/env node
/**
 * FAZA 03 — poravnanje Canary ASR-a s globalnom diarizacijom + protokolarno
 * imenovanje govornika iz službenog registra zastupnika.
 *
 * Ulaz  : session_manifest.json (01), diarization.json (02b),
 *         audio/part_NN_16k.wav.canary.srt (Canary 1B v2),
 *         data/rosters/sabor_mps_11_saziv.json (tools/fetch_sabor_roster.js)
 * Izlaz : aligned_transcript.json, speaker_map.json
 *
 * Postupak:
 *   1. svaki SRT redak dobiva govornika po NAJVEĆEM PREKLAPANJU s diarizacijom;
 *   2. uzastopni redci istoga govornika slažu se u BLOK;
 *   3. predsjedavajući se prepoznaju po GUSTOĆI protokolarnih fraza
 *      (isti kriterij kao `tools/validate_chair.py`, §8.10 — njih je više!);
 *   4. najava predsjedavajućeg GLASA za identitet sljedećeg bloka;
 *   5. glasovi se zbrajaju po globalnoj oznaci i razrješavaju većinom.
 *
 * ═══ ⚠️ ISPRAVCI SPECIFIKACIJE `03_asr_and_protocol_parser.md` ═══
 *
 * (1) §1 traži transkripte u `transcripts/part_NN.canary.srt`. Na disku su
 *     `audio/part_NN_16k.wav.canary.srt` — imenovanje slijedi konvenciju
 *     `{wav}.canary.srt` iz cijelog repoa. Čita se stvarna putanja.
 *
 * (2) §4 t.1 govori o JEDNOM predsjedatelju („govornik koji ima najveći broj…").
 *     Sjednicom naizmjence predsjedaju predsjednik i potpredsjednici; na ovoj
 *     ih je TROJE (§8.10). Uzimaju se SVI iznad praga gustoće.
 *
 * (3) §4 t.2 daje „TRAJNO mapiranje" iz PRVE najave. Jedan promašaj bi tako
 *     zatrovao svih 20 h. Ovdje je najava GLAS; identitet se razrješava
 *     većinom uz zabilježenu pouzdanost, a neriješeno ostaje `null`.
 *
 * (4) §3 regexi (gradnja oko „riječ ima", `/iu` uz `[A-ZČĆŽŠĐ]`) ne rade nad
 *     stvarnim tekstom — vidi `utils/protocol_parser.js`.
 *
 * Uporaba:
 *   node sabor_pipeline/03_transcribe_and_align.js --session sabor_11_izvanredna_11_gospic
 *   node sabor_pipeline/03_transcribe_and_align.js --session <id> --dry-run
 */

"use strict";

const fs = require("fs");
const path = require("path");
const timeMapper = require("./utils/time_mapper.js");
const { RosterMatcher } = require("./utils/roster_match.js");
const { findAnnouncements, hasHandover, handoverRole } = require("./utils/protocol_parser.js");
const { normalizeText } = require("./utils/asr_dictionary.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "storage", "output", "sabor");

// Isti skup fraza i isti prag kao `tools/validate_chair.py` — namjerno, da se
// „tko je predsjedavao" ne bi razlikovao između validacije i ove faze.
const CHAIR_RE =
    /riječ ima|riječ je dobio|zahvaljujem.{0,30}zastupni|poštovani zastupnic|otvaram .{0,20}sjednic|zaključujem raspravu|prelazimo na|izvolite|molim glasujmo|u ime kluba/i;
const MIN_CHAIR_DENSITY = 10.0;   // fraza na 1000 riječi

const BLOCK_GAP_S = 20.0;         // pauza koja lomi blok istog govornika
const MIN_VOTE_SHARE = 0.6;       // udio većine potreban za razrješenje
const ANCHOR_MAX_GAP_S = 180.0;   // najava vrijedi najviše 3 min unaprijed

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const DRY_RUN = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose");

// ───────────────────────────── SRT ─────────────────────────────

function parseSrt(file) {
    const raw = fs.readFileSync(file, "utf8").trim();
    const out = [];
    for (const blk of raw.split(/\n\n+/)) {
        const lines = blk.trim().split("\n");
        if (lines.length < 3) continue;
        const m = lines[1].match(
            /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/
        );
        if (!m) continue;
        const g = m.slice(1).map(Number);
        out.push({
            start: g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000,
            end: g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000,
            text: lines.slice(2).join(" ").trim(),
        });
    }
    return out;
}

/** Prvi indeks čiji je `start_local_sec` > t (binarno). */
function upperBound(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].start_local_sec <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/**
 * Govornik s najvećim preklapanjem. Prozor ±3 segmenta oko binarne pozicije
 * (ista heuristika kao `validate_chair.py`) — segmenti su kratki i uredni.
 */
function speakerForCue(segs, cue) {
    if (!segs.length) return null;
    const i = Math.max(0, upperBound(segs, cue.start) - 1);
    let best = null, bestOv = 0;
    for (let j = Math.max(0, i - 3); j < Math.min(segs.length, i + 4); j++) {
        const ov = Math.min(cue.end, segs[j].end_local_sec) -
                   Math.max(cue.start, segs[j].start_local_sec);
        if (ov > bestOv) { bestOv = ov; best = segs[j]; }
    }
    return best ? { speaker: best.speaker, overlap: bestOv } : null;
}

// ─────────────────────────── blokovi ───────────────────────────

function buildBlocks(manifest, diar, sessionDir) {
    const byPart = new Map();
    for (const s of diar.segments) {
        if (!byPart.has(s.part)) byPart.set(s.part, []);
        byPart.get(s.part).push(s);
    }
    for (const list of byPart.values()) {
        list.sort((a, b) => a.start_local_sec - b.start_local_sec);
    }

    const blocks = [];
    const stats = { cues: 0, unattributed: 0, srtFiles: 0, missingSrt: [] };

    for (const p of manifest.parts) {
        const srtPath = path.join(
            sessionDir, "audio", path.basename(p.wav_file) + ".canary.srt"
        );
        if (!fs.existsSync(srtPath)) { stats.missingSrt.push(srtPath); continue; }
        stats.srtFiles++;
        const segs = byPart.get(p.part) || [];
        let cur = null;
        for (const cue of parseSrt(srtPath)) {
            stats.cues++;
            const hit = speakerForCue(segs, cue);
            if (!hit) { stats.unattributed++; continue; }
            const text = normalizeText(cue.text);
            const breaks = cur &&
                (cur.speaker !== hit.speaker || cue.start - cur.end_local_sec > BLOCK_GAP_S);
            if (!cur || breaks) {
                if (cur) blocks.push(cur);
                cur = {
                    part: p.part,
                    speaker: hit.speaker,
                    start_local_sec: cue.start,
                    end_local_sec: cue.end,
                    texts: [text],
                    cue_count: 1,
                };
            } else {
                cur.end_local_sec = Math.max(cur.end_local_sec, cue.end);
                cur.texts.push(text);
                cur.cue_count++;
            }
        }
        if (cur) blocks.push(cur);
    }

    // Globalno vrijeme i sortiranje po vremenskoj osi cijele sjednice.
    const offsets = new Map(manifest.parts.map((p) => [p.part, p.start_global_sec]));
    for (const b of blocks) {
        const off = offsets.get(b.part) || 0;
        b.start_global_sec = round3(b.start_local_sec + off);
        b.end_global_sec = round3(b.end_local_sec + off);
        b.text = b.texts.join(" ");
        delete b.texts;
    }
    blocks.sort((a, b) => a.start_global_sec - b.start_global_sec);
    return { blocks, stats };
}

// ───────────────────── predsjedavajući ─────────────────────

function detectChairs(blocks) {
    const words = new Map(), phrases = new Map();
    for (const b of blocks) {
        const w = b.text.split(/\s+/).filter(Boolean).length;
        words.set(b.speaker, (words.get(b.speaker) || 0) + w);
        if (CHAIR_RE.test(b.text)) {
            phrases.set(b.speaker, (phrases.get(b.speaker) || 0) + 1);
        }
    }
    const rows = [...words.entries()].map(([speaker, w]) => ({
        speaker,
        words: w,
        phrases: phrases.get(speaker) || 0,
        density: w > 0 ? round2(((phrases.get(speaker) || 0) * 1000) / w) : 0,
    })).sort((a, b) => b.density - a.density);
    const chairs = new Set(
        rows.filter((r) => r.density >= MIN_CHAIR_DENSITY && r.words >= 500)
            .map((r) => r.speaker)
    );
    return { chairs, densities: rows };
}

// ─────────────── sidrenje i glasanje o identitetu ───────────────

function collectVotes(blocks, chairs, matcher) {
    const votes = new Map();       // speaker → Map(mpId → count)
    const roleVotes = new Map();   // speaker → Map(uloga → count)
    const anchors = [];

    /** Prvi blok iza `i` koji nije predsjedavajući, unutar dopuštenog razmaka. */
    const nextTarget = (i, from) => {
        let j = i + 1;
        while (j < blocks.length && chairs.has(blocks[j].speaker)) j++;
        if (j >= blocks.length) return null;
        const gap = blocks[j].start_global_sec - from.end_global_sec;
        return gap > ANCHOR_MAX_GAP_S ? null : { j, gap };
    };

    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (!chairs.has(b.speaker)) continue;
        if (!hasHandover(b.text)) continue;
        const found = findAnnouncements(b.text, matcher, { scopeToHandover: true });
        if (!found.length) {
            // Riječ je predana ulozi izvan registra — zabilježi ULOGU.
            const role = handoverRole(b.text);
            const t = role ? nextTarget(i, b) : null;
            if (t) {
                const sp = blocks[t.j].speaker;
                if (!roleVotes.has(sp)) roleVotes.set(sp, new Map());
                const rm = roleVotes.get(sp);
                rm.set(role, (rm.get(role) || 0) + 1);
            }
            continue;
        }
        // Kad blok sadrži više imena, govornik je POSLJEDNJI najavljeni:
        // ranija imena su spomeni („kolega Bulj dobiva opomenu"), a predaja
        // riječi je zadnja stvar koju predsjedavajući kaže prije šutnje.
        const ann = found[found.length - 1];

        const t = nextTarget(i, b);
        if (!t) continue;
        const { j, gap } = t;
        const target = blocks[j];

        if (!votes.has(target.speaker)) votes.set(target.speaker, new Map());
        const m = votes.get(target.speaker);
        m.set(ann.mp.id, (m.get(ann.mp.id) || 0) + 1);

        anchors.push({
            anchor_block: i,
            target_block: j,
            at_global_sec: round3(b.end_global_sec),
            spoken_name: ann.name,
            mp_id: ann.mp.id,
            mp: ann.mp.puno_ime,
            match_score: ann.score,
            speech_type: ann.speech_type,
            target_speaker: target.speaker,
            gap_sec: round3(gap),
        });
    }
    return { votes, roleVotes, anchors };
}

/**
 * Glasovi → identiteti.
 *
 * Tri pravila, svako zbog konkretnog promašaja izmjerenog na ovoj sjednici:
 *
 *  1. **Većina** (`MIN_VOTE_SHARE`) — kad dvije najave pokazuju na istu oznaku
 *     a ne slažu se, jedna je promašaj i mora izgubiti.
 *  2. **Jedan zastupnik = jedna oznaka.** Ako dvije oznake polažu pravo na
 *     istog zastupnika, jača (više glasova) ga zadržava, slabija ostaje bez
 *     imena. Bez toga bi jedan promašaj udvostručio postojećeg zastupnika, a
 *     nizvodni „hub osobe" bi spojio dva različita glasa.
 *  3. **Razina pouzdanosti se BILJEŽI, ne skriva.** 43 od 62 oznake počivaju
 *     na jednoj jedinoj najavi. To je nakon ograde iz `protocol_parser.js`
 *     dobra evidencija, ali nije jednako dobra kao šest složnih najava, pa
 *     `confidence_tier` to kaže naglas umjesto da svi izgledaju kao 1.0.
 */
function resolveIdentities(votes, roleVotes, mpById) {
    const map = {};
    for (const [speaker, tally] of votes) {
        const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]);
        const total = rows.reduce((s, r) => s + r[1], 0);
        const [topId, topCount] = rows[0];
        const share = topCount / total;
        const mp = mpById.get(topId);
        const resolved = share >= MIN_VOTE_SHARE;
        map[speaker] = {
            mp_id: resolved ? topId : null,
            puno_ime: resolved ? mp.puno_ime : null,
            stranka: resolved ? mp.stranka : null,
            klub: resolved ? mp.klub : null,
            votes: topCount,
            votes_total: total,
            confidence: round3(share),
            confidence_tier: !resolved ? "nerazriješeno"
                : topCount >= 2 ? "visoka" : "srednja",
            resolved,
            competitors: rows.slice(1, 4).map(([id, n]) => ({
                mp: mpById.get(id) ? mpById.get(id).puno_ime : id, votes: n,
            })),
        };
    }

    // Pravilo 2 — jedan zastupnik na najviše jednoj oznaci.
    const claims = new Map();
    for (const [speaker, v] of Object.entries(map)) {
        if (!v.resolved) continue;
        if (!claims.has(v.mp_id)) claims.set(v.mp_id, []);
        claims.get(v.mp_id).push(speaker);
    }
    for (const [mpId, speakers] of claims) {
        if (speakers.length < 2) continue;
        speakers.sort((a, b) => map[b].votes - map[a].votes ||
                                map[b].confidence - map[a].confidence);
        for (const loser of speakers.slice(1)) {
            map[loser] = {
                ...map[loser],
                mp_id: null, puno_ime: null, stranka: null, klub: null,
                resolved: false, confidence_tier: "nerazriješeno",
                dropped_reason: `zastupnik ${mpById.get(mpId).puno_ime} već pripisan ` +
                                `oznaci ${speakers[0]} s više glasova`,
            };
        }
    }

    // Uloge izvan registra (član Vlade) — ne imenuju, ali tipiziraju govornika.
    for (const [speaker, tally] of roleVotes) {
        const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]);
        if (!map[speaker]) {
            map[speaker] = {
                mp_id: null, puno_ime: null, stranka: null, klub: null,
                votes: 0, votes_total: 0, confidence: null,
                confidence_tier: "nerazriješeno", resolved: false, competitors: [],
            };
        }
        if (!map[speaker].resolved) {
            map[speaker].role_hint = rows[0][0];
            map[speaker].role_votes = rows[0][1];
        }
    }
    return map;
}

// ──────────────────────────── main ────────────────────────────

function main() {
    const session = getArg("--session");
    if (!session) {
        console.error("Uporaba: node sabor_pipeline/03_transcribe_and_align.js --session <session_id>");
        process.exit(2);
    }
    const outputDir = getArg("--output-dir") || DEFAULT_OUTPUT_DIR;
    const sessionDir = path.join(outputDir, session);
    const rosterPath = getArg("--roster") ||
        path.join(__dirname, "data", "rosters", "sabor_mps_11_saziv.json");

    for (const f of ["session_manifest.json", "diarization.json"]) {
        const p = path.join(sessionDir, f);
        if (!fs.existsSync(p)) { console.error(`GREŠKA: nedostaje ${p}`); process.exit(1); }
    }
    if (!fs.existsSync(rosterPath)) {
        console.error(`GREŠKA: nedostaje registar ${rosterPath}\n` +
            "         pokreni: node sabor_pipeline/tools/fetch_sabor_roster.js");
        process.exit(1);
    }

    const manifest = readJson(path.join(sessionDir, "session_manifest.json"));
    const diar = readJson(path.join(sessionDir, "diarization.json"));
    const roster = readJson(rosterPath);
    const matcher = new RosterMatcher(roster);
    const mpById = new Map(roster.mps.map((m) => [m.id, m]));

    log(`Sjednica ${session} — ${diar.total_speakers_detected} globalnih govornika, ` +
        `${diar.segments.length} segmenata, registar ${roster.mps.length} zastupnika`);

    const { blocks, stats } = buildBlocks(manifest, diar, sessionDir);
    if (stats.missingSrt.length) {
        for (const p of stats.missingSrt) log(`  ⚠ nema SRT-a: ${p}`);
    }
    log(`Blokova: ${blocks.length} (iz ${stats.cues} SRT redaka u ${stats.srtFiles} dijelova, ` +
        `nepridruženih ${stats.unattributed})`);

    const { chairs, densities } = detectChairs(blocks);
    log(`Predsjedavajućih: ${chairs.size} → ${[...chairs].join(", ")}`);
    for (const r of densities.slice(0, 6)) {
        log(`   ${chairs.has(r.speaker) ? "▶" : " "} ${r.speaker}  gustoća ${String(r.density).padStart(6)} ` +
            `(${r.phrases} fraza / ${r.words} riječi)`);
    }
    if (chairs.size === 0) {
        console.error("GREŠKA: nijedan govornik nije prošao prag gustoće — sidrenje nije moguće.");
        process.exit(1);
    }

    const { votes, roleVotes, anchors } = collectVotes(blocks, chairs, matcher);
    const speakerMap = resolveIdentities(votes, roleVotes, mpById);
    const resolvedCount = Object.values(speakerMap).filter((v) => v.resolved).length;
    const namedMps = new Set(
        Object.values(speakerMap).filter((v) => v.resolved).map((v) => v.mp_id)
    );
    log(`Sidrenih najava: ${anchors.length} → glasova za ${votes.size} oznaka → ` +
        `razriješeno ${resolvedCount} (različitih zastupnika: ${namedMps.size})`);

    // Sastavljanje izlaza.
    const outBlocks = blocks.map((b, i) => {
        const id = speakerMap[b.speaker];
        const yt = timeMapper.globalToYoutube(manifest, b.start_global_sec);
        return {
            block_id: i + 1,
            part: b.part,
            start_global_sec: b.start_global_sec,
            end_global_sec: b.end_global_sec,
            duration_sec: round3(b.end_global_sec - b.start_global_sec),
            start_hms: timeMapper.secondsToHms(b.start_global_sec),
            speaker_id: b.speaker,
            speaker_name: id && id.resolved ? id.puno_ime : null,
            party: id && id.resolved ? id.stranka : null,
            klub: id && id.resolved ? id.klub : null,
            identity_confidence: id ? id.confidence : null,
            role: chairs.has(b.speaker) ? "predsjedatelj"
                : (id && id.role_hint) ? id.role_hint
                : id && id.resolved ? "zastupnik" : "govornik",
            cue_count: b.cue_count,
            text: b.text,
            youtube: {
                part: yt.part,
                video_id: yt.video_id,
                timestamp_sec: yt.timestamp_sec,
                url: yt.url,
            },
        };
    });

    const named = outBlocks.filter((b) => b.speaker_name).length;
    const namedSec = outBlocks.filter((b) => b.speaker_name)
        .reduce((s, b) => s + b.duration_sec, 0);
    const totalSec = outBlocks.reduce((s, b) => s + b.duration_sec, 0);
    log(`Imenovanih blokova: ${named}/${outBlocks.length} ` +
        `(${round1((100 * namedSec) / totalSec)} % izgovorenog vremena)`);

    const payload = {
        session_id: session,
        source: "canary-1b-v2 + chunked-diarization + protocol-anchoring",
        generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        roster: {
            path: path.relative(REPO_ROOT, rosterPath),
            saziv: roster.saziv,
            fetched_at: roster.fetched_at,
            mps: roster.mps.length,
            source_url: roster.source_url,
        },
        total_blocks: outBlocks.length,
        total_speakers: diar.total_speakers_detected,
        chairs: [...chairs],
        stats: {
            srt_cues: stats.cues,
            unattributed_cues: stats.unattributed,
            anchors: anchors.length,
            speakers_with_votes: votes.size,
            speakers_resolved: resolvedCount,
            distinct_mps_named: namedMps.size,
            named_blocks: named,
            named_speech_pct: round1((100 * namedSec) / totalSec),
        },
        blocks: outBlocks,
    };

    const mapPayload = {
        session_id: session,
        generated_at: payload.generated_at,
        rule: `većina glasova ≥ ${MIN_VOTE_SHARE}, najava vrijedi ≤ ${ANCHOR_MAX_GAP_S} s unaprijed`,
        chairs: [...chairs],
        speaker_density: densities,
        speakers: speakerMap,
        anchors,
    };

    if (DRY_RUN) { log("--dry-run — ništa nije zapisano"); return; }
    writeJson(path.join(sessionDir, "aligned_transcript.json"), payload);
    writeJson(path.join(sessionDir, "speaker_map.json"), mapPayload);
    log(`Zapisano: ${path.join(sessionDir, "aligned_transcript.json")}`);
    log(`Zapisano: ${path.join(sessionDir, "speaker_map.json")}`);
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJson(p, o) { fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n", "utf8"); }
function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function log(s) { process.stderr.write(s + "\n"); }

if (require.main === module) main();
module.exports = { parseSrt, speakerForCue, buildBlocks, detectChairs, collectVotes, resolveIdentities };
