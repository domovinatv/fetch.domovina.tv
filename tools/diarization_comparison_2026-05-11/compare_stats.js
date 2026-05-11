#!/usr/bin/env node

/**
 * compare_stats.js — objektivne metrike za usporedbu dijarizacije
 *
 * Računa statistiku za par SRT datoteka (canary pyannote vs sortformer)
 * za 5 testnih epizoda u storage/output/mladi_za_domovinu/.
 *
 * Output: stats_results.json + ASCII tablica na stdout.
 *
 * Bez vanjskih ovisnosti (samo Node built-ins). Idempotentno:
 * ako stats_results.json postoji, preskače recompute osim s --force.
 */

const fs = require("fs");
const path = require("path");

// ─── KONFIGURACIJA ───────────────────────────────────────────────

const CORPUS_DIR = path.resolve(__dirname, "../../storage/output/mladi_za_domovinu");
const OUTPUT_JSON = path.join(__dirname, "stats_results.json");

const TEST_BASES = [
    "20210425_podcast_2_miroslav_skoro_yt_bL4l4df_UTI.wav",
    "20210514_podcast_6_nansi_ivanisevic_yt_KuWqx0TJaVM.wav",
    "20230521_podcast_19_stjepan_zabcic_yt_Df--kDZSIYU.wav",
    "20240211_podcast_29_nino_raspudic_nasi_roditelji_izborili_su_nam_drzavu_a_mi_igramo_drugo_poluvrijeme_yt_iP5X9Q93sSY.wav",
    "20240309_profesorica_koja_mijenja_hrvatsku_zeljka_zupan_vuksan_podcast_33_yt_LJtqwpxbB84.wav"
];

const SYSTEMS = ["canary", "sortformer"];
const FLICKER_THRESHOLD_SEC = 1.0;
const RAPID_WINDOW_SEC = 5.0;
const RAPID_SWITCHES_MIN = 3;

// ─── CLI ARGUMENTI (Pattern B) ─────────────────────────────────

const args = process.argv.slice(2);
function hasFlag(name) { return args.includes(name); }

const FORCE = hasFlag("--force");

// ─── SRT PARSER ─────────────────────────────────────────────────

/**
 * Parsira SRT datoteku. Preuzeto iz prepare_rag_combined.js (parseSrt),
 * minimalno proširenje za BOM i defensive handling.
 */
function parseSrt(srtContent) {
    // Skini BOM ako postoji
    if (srtContent.charCodeAt(0) === 0xFEFF) {
        srtContent = srtContent.slice(1);
    }
    // Normaliziraj CRLF → LF
    srtContent = srtContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    const segments = [];
    const blocks = srtContent.split(/\n\n+/);

    for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;

        const lines = trimmed.split("\n");
        if (lines.length < 3) continue;

        const index = parseInt(lines[0], 10);
        if (isNaN(index)) continue;

        const timeMatch = lines[1].match(
            /(\d{2}:\d{2}:\d{2})[,.](\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2})[,.](\d{3})/
        );
        if (!timeMatch) continue;

        const startSec = timestampToSeconds(timeMatch[1], timeMatch[2]);
        const endSec = timestampToSeconds(timeMatch[3], timeMatch[4]);

        const textLines = lines.slice(2).join(" ");
        const speakerMatch = textLines.match(/^\[(\w+)\]\s*/);

        const speaker = speakerMatch ? speakerMatch[1] : "UNKNOWN";
        const text = speakerMatch
            ? textLines.replace(/^\[\w+\]\s*/, "").trim()
            : textLines.trim();

        if (!text) continue;

        segments.push({ index, startSec, endSec, speaker, text });
    }

    return segments;
}

function timestampToSeconds(hms, ms) {
    const [h, m, s] = hms.split(":").map(Number);
    return h * 3600 + m * 60 + s + parseInt(ms, 10) / 1000;
}

// ─── METRIKE ────────────────────────────────────────────────────

/**
 * Spaja uzastopne segmente istog govornika u jedan "turn".
 */
function buildTurns(segments) {
    const turns = [];
    let cur = null;
    for (const seg of segments) {
        if (cur && cur.speaker === seg.speaker) {
            cur.endSec = seg.endSec;
            cur.segCount += 1;
        } else {
            if (cur) turns.push(cur);
            cur = {
                speaker: seg.speaker,
                startSec: seg.startSec,
                endSec: seg.endSec,
                segCount: 1
            };
        }
    }
    if (cur) turns.push(cur);
    return turns;
}

function median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function mean(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function computeMetrics(segments) {
    const turns = buildTurns(segments);
    const speakers = [...new Set(segments.map(s => s.speaker))];

    // Trajanje po govorniku
    const speakerTime = {};
    let totalTime = 0;
    for (const seg of segments) {
        const dur = Math.max(0, seg.endSec - seg.startSec);
        speakerTime[seg.speaker] = (speakerTime[seg.speaker] || 0) + dur;
        totalTime += dur;
    }
    const speakerPct = {};
    for (const sp of Object.keys(speakerTime)) {
        speakerPct[sp] = totalTime > 0 ? speakerTime[sp] / totalTime : 0;
    }

    // Balance (1.0 = savršeno 50/50, 0.0 = jedan govornik dominira)
    const pctValues = Object.values(speakerPct);
    const pDominant = pctValues.length > 0 ? Math.max(...pctValues) : 1.0;
    const balance = 1 - Math.abs(0.5 - pDominant) * 2;

    // Trajanja turn-ova
    const turnDurations = turns.map(t => t.endSec - t.startSec);

    // Flicker: turn < FLICKER_THRESHOLD_SEC
    const flickerCount = turnDurations.filter(d => d < FLICKER_THRESHOLD_SEC).length;

    // Rapid switches: 3+ promjena govornika u bilo kojem 5s prozoru.
    // Definiramo "switch" kao granica između dva uzastopna turn-a.
    // Brojimo prozore koji "sadrže" 3+ switcheva (po startSec turn-a).
    const switchTimes = turns.slice(1).map(t => t.startSec);
    let rapidSwitchCount = 0;
    for (let i = 0; i < switchTimes.length; i++) {
        // Broji koliko switcheva pada u [t_i, t_i + 5s)
        let cnt = 1;
        for (let j = i + 1; j < switchTimes.length; j++) {
            if (switchTimes[j] - switchTimes[i] < RAPID_WINDOW_SEC) {
                cnt += 1;
            } else {
                break;
            }
        }
        if (cnt >= RAPID_SWITCHES_MIN) rapidSwitchCount += 1;
    }

    return {
        numSpeakers: speakers.length,
        speakers,
        numSegments: segments.length,
        numTurns: turns.length,
        totalSpeechSec: totalTime,
        meanTurnSec: mean(turnDurations),
        medianTurnSec: median(turnDurations),
        speakerTime,
        speakerPct,
        balance,
        flickerCount,
        rapidSwitchCount,
        turns
    };
}

// ─── DISAGREEMENT IZMEĐU SUSTAVA ─────────────────────────────────

/**
 * Za svaki canary segment, nađi sortformer segment koji najviše overlapa
 * po vremenu i usporedi labelu. Vraća % segmenata gdje se sustavi NE slažu
 * (pod optimalnim mapiranjem 00↔00 / 00↔01 itd.).
 */
function findOverlappingSpeaker(targetSeg, otherSegments) {
    // Linearno traži preklapanje (segmenti su sortirani po startSec).
    let best = null;
    let bestOverlap = 0;
    for (const other of otherSegments) {
        if (other.endSec < targetSeg.startSec) continue;
        if (other.startSec > targetSeg.endSec) break;
        const overlap = Math.min(targetSeg.endSec, other.endSec) - Math.max(targetSeg.startSec, other.startSec);
        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            best = other;
        }
    }
    return best ? best.speaker : null;
}

function computeDisagreement(canarySegs, sortSegs) {
    // Sortiraj kopije po startSec (defensive)
    const a = [...canarySegs].sort((x, y) => x.startSec - y.startSec);
    const b = [...sortSegs].sort((x, y) => x.startSec - y.startSec);

    // Sakupi parove (canarySpeaker, sortSpeaker) za svaki segment u a
    const pairs = [];
    for (const seg of a) {
        const other = findOverlappingSpeaker(seg, b);
        if (other !== null) {
            pairs.push([seg.speaker, other]);
        }
    }

    if (pairs.length === 0) return { disagreementPct: 1.0, mapping: {}, mappedCount: 0 };

    // Skupi unique labels
    const aLabels = [...new Set(pairs.map(p => p[0]))];
    const bLabels = [...new Set(pairs.map(p => p[1]))];

    // Pokušaj sva permutacija mapiranja a→b (mali set, max 4 govornika).
    // Za 2 govornika to su 2 permutacije, za 4 to je 24 — i dalje OK.
    function permutations(arr) {
        if (arr.length <= 1) return [arr];
        const out = [];
        for (let i = 0; i < arr.length; i++) {
            const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
            for (const p of permutations(rest)) {
                out.push([arr[i], ...p]);
            }
        }
        return out;
    }

    let bestAgreement = -1;
    let bestMapping = {};
    const targetLabels = bLabels.slice(0, aLabels.length);
    // Ako je bLabels manji, pad-ujemo sa null-ovima
    while (targetLabels.length < aLabels.length) targetLabels.push(null);

    for (const perm of permutations(targetLabels)) {
        const mapping = {};
        aLabels.forEach((lbl, i) => { mapping[lbl] = perm[i]; });
        let agree = 0;
        for (const [aLbl, bLbl] of pairs) {
            if (mapping[aLbl] === bLbl) agree += 1;
        }
        if (agree > bestAgreement) {
            bestAgreement = agree;
            bestMapping = { ...mapping };
        }
    }

    return {
        disagreementPct: 1 - bestAgreement / pairs.length,
        mapping: bestMapping,
        mappedCount: pairs.length
    };
}

// ─── FORMATIRANJE TABLICE ───────────────────────────────────────

function fmtSec(s) { return s.toFixed(1) + "s"; }
function fmtPct(p) { return (p * 100).toFixed(1) + "%"; }

function shortBase(base) {
    // Skrati za prikaz: prva 22 znaka + ... + youtube id
    const ytMatch = base.match(/_yt_([a-zA-Z0-9_-]{11})/);
    const yt = ytMatch ? ytMatch[1] : "?";
    return base.substring(0, 20) + "…" + yt;
}

function printTable(results) {
    console.log("");
    console.log("═".repeat(140));
    console.log("USPOREDBA DIJARIZACIJE — objektivne metrike po datoteci");
    console.log("═".repeat(140));

    const header = [
        "epizoda".padEnd(38),
        "sustav".padEnd(11),
        "spk".padStart(3),
        "turns".padStart(6),
        "mean".padStart(7),
        "median".padStart(7),
        "balance".padStart(8),
        "flicker".padStart(8),
        "rapid".padStart(6),
        "disagree".padStart(10)
    ].join(" │ ");
    console.log(header);
    console.log("─".repeat(140));

    for (const r of results.perFile) {
        const short = shortBase(r.base).padEnd(38);
        for (const sys of SYSTEMS) {
            const m = r[sys];
            const disagree = sys === "canary" ? fmtPct(r.disagreementPct) : "";
            const row = [
                (sys === "canary" ? short : " ".repeat(38)),
                sys.padEnd(11),
                String(m.numSpeakers).padStart(3),
                String(m.numTurns).padStart(6),
                fmtSec(m.meanTurnSec).padStart(7),
                fmtSec(m.medianTurnSec).padStart(7),
                m.balance.toFixed(3).padStart(8),
                String(m.flickerCount).padStart(8),
                String(m.rapidSwitchCount).padStart(6),
                disagree.padStart(10)
            ].join(" │ ");
            console.log(row);
        }
        console.log("─".repeat(140));
    }

    // Agregat
    console.log("");
    console.log("═".repeat(80));
    console.log("AGREGAT (mean preko 5 datoteka)");
    console.log("═".repeat(80));
    for (const sys of SYSTEMS) {
        const agg = results.aggregate[sys];
        console.log(`  ${sys.padEnd(12)} balance=${agg.meanBalance.toFixed(3)}  flicker=${agg.meanFlicker.toFixed(1)}  rapid=${agg.meanRapid.toFixed(1)}  turns=${agg.meanTurns.toFixed(1)}`);
    }
    console.log(`  disagreement (canary vs sortformer): ${fmtPct(results.aggregate.meanDisagreement)}`);
}

// ─── MAIN ────────────────────────────────────────────────────────

function main() {
    if (fs.existsSync(OUTPUT_JSON) && !FORCE) {
        console.log(`✅ stats_results.json već postoji — koristim cache. (--force za recompute)`);
        const cached = JSON.parse(fs.readFileSync(OUTPUT_JSON, "utf-8"));
        printTable(cached);
        console.log(`\n📄 Output: ${OUTPUT_JSON}`);
        return;
    }

    const perFile = [];

    for (const base of TEST_BASES) {
        const canaryPath = path.join(CORPUS_DIR, base + ".canary.diarized.srt");
        const sortPath = path.join(CORPUS_DIR, base + ".sortformer.diarized.srt");

        if (!fs.existsSync(canaryPath)) {
            console.error(`❌ Nedostaje: ${canaryPath}`);
            continue;
        }
        if (!fs.existsSync(sortPath)) {
            console.error(`❌ Nedostaje: ${sortPath}`);
            continue;
        }

        const canarySegs = parseSrt(fs.readFileSync(canaryPath, "utf-8"));
        const sortSegs = parseSrt(fs.readFileSync(sortPath, "utf-8"));

        const canaryMetrics = computeMetrics(canarySegs);
        const sortMetrics = computeMetrics(sortSegs);
        const disagree = computeDisagreement(canarySegs, sortSegs);

        perFile.push({
            base,
            canary: { ...canaryMetrics, turns: undefined },  // izbaci sirove turns iz JSON outputa
            sortformer: { ...sortMetrics, turns: undefined },
            disagreementPct: disagree.disagreementPct,
            mapping: disagree.mapping,
            mappedSegments: disagree.mappedCount
        });
    }

    // Agregat
    const meanBy = (arr, key) => mean(arr.map(x => x[key]));
    const aggregate = {
        canary: {
            meanBalance: meanBy(perFile.map(r => r.canary), "balance"),
            meanFlicker: meanBy(perFile.map(r => r.canary), "flickerCount"),
            meanRapid: meanBy(perFile.map(r => r.canary), "rapidSwitchCount"),
            meanTurns: meanBy(perFile.map(r => r.canary), "numTurns")
        },
        sortformer: {
            meanBalance: meanBy(perFile.map(r => r.sortformer), "balance"),
            meanFlicker: meanBy(perFile.map(r => r.sortformer), "flickerCount"),
            meanRapid: meanBy(perFile.map(r => r.sortformer), "rapidSwitchCount"),
            meanTurns: meanBy(perFile.map(r => r.sortformer), "numTurns")
        },
        meanDisagreement: mean(perFile.map(r => r.disagreementPct))
    };

    const results = { generatedAt: new Date().toISOString(), perFile, aggregate };

    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2), "utf-8");

    printTable(results);
    console.log(`\n📄 Output: ${OUTPUT_JSON}`);
}

main();
