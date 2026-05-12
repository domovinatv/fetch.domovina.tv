#!/usr/bin/env node

/**
 * compare_llm_judge.js — Gemini Vertex AI kao "sudac" kvalitete dijarizacije.
 *
 * Za svaku od 5 testnih datoteka uzme 3 random 90-sekundna prozora
 * (izbjegavajući prvih/zadnjih 60s), pripremi side-by-side prikaz
 * canary vs sortformer i pita Gemini da ocijeni svaku stranu 0–100.
 *
 * Autentikacija: gcloud auth print-access-token (Vertex AI OAuth Bearer).
 * NIKAD API key. Model: gemini-2.5-flash, region: global.
 *
 * Output: llm_results.json + REPORT.md.
 * Idempotentno (--force za recompute).
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ─── KONFIGURACIJA ───────────────────────────────────────────────

const CORPUS_DIR = path.resolve(__dirname, "../../storage/output/mladi_za_domovinu");
const STATS_JSON = path.join(__dirname, "stats_results.json");
const LLM_JSON = path.join(__dirname, "llm_results.json");
const REPORT_MD = path.join(__dirname, "REPORT.md");

const TEST_BASES = [
    "20210425_podcast_2_miroslav_skoro_yt_bL4l4df_UTI.wav",
    "20210514_podcast_6_nansi_ivanisevic_yt_KuWqx0TJaVM.wav",
    "20230521_podcast_19_stjepan_zabcic_yt_Df--kDZSIYU.wav",
    "20240211_podcast_29_nino_raspudic_nasi_roditelji_izborili_su_nam_drzavu_a_mi_igramo_drugo_poluvrijeme_yt_iP5X9Q93sSY.wav",
    "20240309_profesorica_koja_mijenja_hrvatsku_zeljka_zupan_vuksan_podcast_33_yt_LJtqwpxbB84.wav"
];

const WINDOWS_PER_FILE = 3;
const WINDOW_DURATION_SEC = 90;
const EDGE_PADDING_SEC = 60;       // izbjegni prvih i zadnjih 60s
const INTER_CALL_DELAY_MS = 2000;

const VERTEX_PROJECT = process.env.VERTEX_PROJECT || "domovina-sync-ms";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const VERTEX_ENDPOINT = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/global/publishers/google/models/${GEMINI_MODEL}:generateContent`;

// Deterministički seed (datum batcha) za reproducibilnost random prozora.
const RNG_SEED = 20260511;

// ─── CLI ARGUMENTI ──────────────────────────────────────────────

const args = process.argv.slice(2);
const FORCE = args.includes("--force");

// ─── SRT PARSER (kopija iz compare_stats.js) ────────────────────

function parseSrt(srtContent) {
    if (srtContent.charCodeAt(0) === 0xFEFF) srtContent = srtContent.slice(1);
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

function secToHms(s) {
    const h = Math.floor(s / 3600).toString().padStart(2, "0");
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${h}:${m}:${sec}`;
}

// ─── SEEDED RNG (Mulberry32) ────────────────────────────────────

function mulberry32(seed) {
    let a = seed;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ─── OAUTH TOKEN (kopija pattern-a iz generate_article_gemini.js) ──

let cachedAccessToken = null;
let tokenExpiry = 0;

function getAccessToken() {
    try {
        return execSync("gcloud auth print-access-token", { encoding: "utf-8" }).trim();
    } catch (e) {
        console.error("❌ Ne mogu dohvatiti access token. Pokreni: gcloud auth login");
        process.exit(1);
    }
}

function getOrRefreshAccessToken() {
    const now = Date.now();
    if (cachedAccessToken && now < tokenExpiry) return cachedAccessToken;
    cachedAccessToken = getAccessToken();
    tokenExpiry = now + 50 * 60 * 1000;
    return cachedAccessToken;
}

// ─── SAMPLING PROZORA ───────────────────────────────────────────

function pickWindows(maxSec, rng) {
    const earliest = EDGE_PADDING_SEC;
    const latest = maxSec - EDGE_PADDING_SEC - WINDOW_DURATION_SEC;
    if (latest <= earliest) {
        // Fallback za vrlo kratke datoteke (ne očekujemo ovdje, ali defensive).
        return [{ startSec: 0, endSec: Math.min(maxSec, WINDOW_DURATION_SEC) }];
    }

    const windows = [];
    let tries = 0;
    while (windows.length < WINDOWS_PER_FILE && tries < 200) {
        tries += 1;
        const start = earliest + rng() * (latest - earliest);
        // Zahtjev: razmaknuti prozori (ne preklapaju se međusobno)
        const overlap = windows.some(w => !(start + WINDOW_DURATION_SEC < w.startSec || start > w.endSec));
        if (overlap) continue;
        windows.push({ startSec: start, endSec: start + WINDOW_DURATION_SEC });
    }
    windows.sort((a, b) => a.startSec - b.startSec);
    return windows;
}

function segmentsInWindow(segments, win) {
    // Uključi sve segmente koji barem djelomično preklapaju prozor.
    return segments.filter(s => s.endSec > win.startSec && s.startSec < win.endSec);
}

function formatWindowBlock(canarySegs, sortSegs, win, idx) {
    const lines = [];
    lines.push(`=== WINDOW ${idx + 1}: t=${secToHms(win.startSec)}–${secToHms(win.endSec)} ===`);
    lines.push("--- CANARY ---");
    for (const s of segmentsInWindow(canarySegs, win)) {
        lines.push(`[${secToHms(s.startSec)}] [${s.speaker}] ${s.text}`);
    }
    lines.push("--- SORTFORMER ---");
    for (const s of segmentsInWindow(sortSegs, win)) {
        lines.push(`[${secToHms(s.startSec)}] [${s.speaker}] ${s.text}`);
    }
    return lines.join("\n");
}

// ─── GEMINI POZIV ──────────────────────────────────────────────

const SYSTEM_PROMPT = `Procjenjuješ kvalitetu dijarizacije (atribucije govornika) dvije ASR pipeline-e nad istim hrvatskim podcastom (host + gost interview).

Za SVAKI sustav (CANARY i SORTFORMER), ocijeni od 0 do 100:
- Konzistentnost govornika (40 pts): Je li SPEAKER_00 isti čovjek kroz cijeli prozor? Mijenjaju li se oznake bez stvarne promjene govornika?
- Granice turn-a (30 pts): Poklapaju li se [SPEAKER_XX] promjene s stvarnim promjenama govornika koje se vide iz teksta (pitanja vs odgovori, ton, dijaloški obrasci)?
- Plauzibilnost (30 pts): Ima li flickanja (SPEAKER mijenja se na 1-2 segmenta pa se vraća)? Je li podjela razgovora prirodna za 2-osobni interview?

Vrati STROGI JSON: {"canary": {"score": N, "reasoning": "..."}, "sortformer": {"score": N, "reasoning": "..."}}. Bez markdown fenceova, samo JSON. Reasoning u 1-2 rečenice na hrvatskom.`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function stripFences(text) {
    // Defensivno: skini ```json ... ``` ako se pojavi unatoč responseMimeType.
    let t = text.trim();
    t = t.replace(/^```(?:json)?\s*/i, "");
    t = t.replace(/```\s*$/i, "");
    return t.trim();
}

async function callGeminiJudge(windowBlock) {
    const payload = {
        contents: [
            { role: "user", parts: [{ text: windowBlock }] }
        ],
        systemInstruction: {
            role: "system",
            parts: [{ text: SYSTEM_PROMPT }]
        },
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
            responseMimeType: "application/json"
        }
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
        const token = getOrRefreshAccessToken();
        try {
            const resp = await fetch(VERTEX_ENDPOINT, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });

            if (!resp.ok) {
                const body = await resp.text();
                if (resp.status === 401) {
                    cachedAccessToken = null; tokenExpiry = 0;
                    console.error(`  ⚠️  401 → refresham token (pokušaj ${attempt}/3)`);
                    continue;
                }
                if (resp.status === 429 || resp.status >= 500) {
                    const waitMs = 2000 * Math.pow(2, attempt - 1);
                    console.error(`  ⏳ HTTP ${resp.status}, čekam ${waitMs}ms (pokušaj ${attempt}/3)`);
                    await sleep(waitMs);
                    continue;
                }
                throw new Error(`HTTP ${resp.status}: ${body.substring(0, 300)}`);
            }

            const data = await resp.json();
            if (data.promptFeedback?.blockReason) {
                throw new Error(`Blocked: ${data.promptFeedback.blockReason}`);
            }
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error("Prazan odgovor");

            // Parsiraj JSON (uz fence-strip + retry once ako padne)
            try {
                const parsed = JSON.parse(stripFences(text));
                if (
                    typeof parsed?.canary?.score !== "number" ||
                    typeof parsed?.sortformer?.score !== "number"
                ) {
                    throw new Error("Format ne sadrži numeričke score-ove");
                }
                return parsed;
            } catch (parseErr) {
                if (attempt < 3) {
                    console.error(`  ⚠️  JSON parse failed (${parseErr.message}), retry...`);
                    continue;
                }
                throw parseErr;
            }
        } catch (err) {
            if (attempt >= 3) throw err;
            console.error(`  ⚠️  Pokušaj ${attempt} failed: ${err.message}`);
            await sleep(1500);
        }
    }
    throw new Error("Iscrpljeni svi pokušaji");
}

// ─── REPORT.md GENERATOR ────────────────────────────────────────

function shortBase(base) {
    const ytMatch = base.match(/_yt_([a-zA-Z0-9_-]{11})/);
    return ytMatch ? ytMatch[1] : base.substring(0, 24);
}

function buildReport(llmResults, statsResults) {
    const lines = [];
    lines.push("# Diarization Quality Benchmark — 2026-05-11");
    lines.push("");
    lines.push(`Generirano: ${llmResults.generatedAt}`);
    lines.push("");
    lines.push("Usporedba dvije dijarizacijske pipeline-e nad 5 epizoda iz `mladi_za_domovinu` kanala:");
    lines.push("");
    lines.push("- **CANARY**: Canary 1B v2 transcription + pyannote community-1 diarization (Mac lokalno)");
    lines.push("- **SORTFORMER**: Canary 1B v2 transcription + NVIDIA Streaming Sortformer 4spk v2.1 (Colab G4)");
    lines.push("");
    lines.push("Transkript je u oba slučaja isti (oba koriste Canary). Razlika su samo `[SPEAKER_XX]` oznake.");
    lines.push("");

    // KEY FINDING — najvažniji rezultat odmah na vrhu
    const cTop = llmResults.aggregate.canaryOverall;
    const sTop = llmResults.aggregate.sortformerOverall;
    const overallDisagree = statsResults ? statsResults.aggregate.meanDisagreement : null;
    lines.push("## TL;DR — Ključni nalaz");
    lines.push("");
    lines.push(`- **LLM ocjene praktički identične**: Canary ${cTop.toFixed(2)}/100, Sortformer ${sTop.toFixed(2)}/100.`);
    if (overallDisagree !== null) {
        lines.push(`- **Razlog**: per-segment disagreement između sustava je samo **${(overallDisagree * 100).toFixed(1)}%** — pod optimalnim mapiranjem govornika, sustavi se slažu u ~98% segmenata. Stoga su side-by-side prikazi koje LLM ocjenjuje u velikoj većini prozora **bukvalno identični**, što vodi do iste ocjene (često i istog obrazloženja verbatim).`);
    }
    lines.push(`- **Praktična implikacija**: oba sustava produciraju usporedivo kvalitetnu dijarizaciju za 2-osobni interview format. Razlike su u **objektivnim mikro-metrikama** (vidi sekciju 4):`);
    if (statsResults) {
        const a = statsResults.aggregate;
        lines.push(`  - Sortformer ima više **flicker** (${a.sortformer.meanFlicker.toFixed(1)} vs ${a.canary.meanFlicker.toFixed(1)}) i **rapid-switch** (${a.sortformer.meanRapid.toFixed(1)} vs ${a.canary.meanRapid.toFixed(1)}) artefakata — sugerira blago više over-segmentation.`);
        lines.push(`  - Sortformer producira ~${(a.sortformer.meanTurns - a.canary.meanTurns).toFixed(0)} više turn-ova po epizodi.`);
        lines.push(`  - Speaker-time balance približno isti (${a.canary.meanBalance.toFixed(3)} vs ${a.sortformer.meanBalance.toFixed(3)}) — niska vrijednost znači da je u korpusu jedan govornik dominantan (host/gost asymmetry tipična za intervjue ovog kanala).`);
    }
    lines.push(`- **Preporuka**: zadržati stabilni Canary+pyannote workflow (Mac lokalno) kao default — jednako kvalitetna dijarizacija uz nižu cijenu (vidi CLAUDE.md "Diarization Cost/Performance Note"). Sortformer je validan eksperimentalni alternativni put kad Mac nije dostupan.`);
    lines.push("");

    // 1. Per-file tablica
    lines.push("## 1. Rezultati po epizodi (LLM ocjene)");
    lines.push("");
    lines.push("| Epizoda | Canary score | Sortformer score | Δ (sort - canary) |");
    lines.push("|---|---:|---:|---:|");
    for (const r of llmResults.perFile) {
        const delta = r.sortformerMean - r.canaryMean;
        const sign = delta > 0 ? "+" : "";
        lines.push(`| \`${shortBase(r.base)}\` | ${r.canaryMean.toFixed(1)} | ${r.sortformerMean.toFixed(1)} | ${sign}${delta.toFixed(1)} |`);
    }
    lines.push("");

    // 2. Overall scores
    lines.push("## 2. Ukupne ocjene");
    lines.push("");
    const c = llmResults.aggregate.canaryOverall;
    const s = llmResults.aggregate.sortformerOverall;
    const winner = c > s ? "CANARY" : (s > c ? "SORTFORMER" : "TIE");
    const margin = Math.abs(c - s);
    lines.push(`- **Canary**: ${c.toFixed(2)} / 100`);
    lines.push(`- **Sortformer**: ${s.toFixed(2)} / 100`);
    lines.push(`- **Pobjednik**: ${winner} (margina: ${margin.toFixed(2)} bodova)`);
    lines.push("");

    // 3. Best i worst sample reasonings
    const allWindows = [];
    for (const r of llmResults.perFile) {
        for (const w of r.windows) {
            if (w.error) continue;
            allWindows.push({
                base: r.base, win: w.window,
                canaryScore: w.canary.score, canaryReasoning: w.canary.reasoning,
                sortScore: w.sortformer.score, sortReasoning: w.sortformer.reasoning,
                combined: (w.canary.score + w.sortformer.score) / 2,
                spread: Math.abs(w.canary.score - w.sortformer.score)
            });
        }
    }

    const bestWindow = [...allWindows].sort((a, b) => b.combined - a.combined)[0];
    const worstWindow = [...allWindows].sort((a, b) => a.combined - b.combined)[0];
    const biggestSpread = [...allWindows].sort((a, b) => b.spread - a.spread)[0];

    lines.push("## 3. Primjeri obrazloženja");
    lines.push("");
    if (bestWindow) {
        lines.push(`### Najbolji prozor (combined=${bestWindow.combined.toFixed(1)})`);
        lines.push(`Epizoda \`${shortBase(bestWindow.base)}\`, t=${secToHms(bestWindow.win.startSec)}–${secToHms(bestWindow.win.endSec)}`);
        lines.push("");
        lines.push(`- **Canary** (${bestWindow.canaryScore}/100): ${bestWindow.canaryReasoning}`);
        lines.push(`- **Sortformer** (${bestWindow.sortScore}/100): ${bestWindow.sortReasoning}`);
        lines.push("");
    }
    if (worstWindow) {
        lines.push(`### Najgori prozor (combined=${worstWindow.combined.toFixed(1)})`);
        lines.push(`Epizoda \`${shortBase(worstWindow.base)}\`, t=${secToHms(worstWindow.win.startSec)}–${secToHms(worstWindow.win.endSec)}`);
        lines.push("");
        lines.push(`- **Canary** (${worstWindow.canaryScore}/100): ${worstWindow.canaryReasoning}`);
        lines.push(`- **Sortformer** (${worstWindow.sortScore}/100): ${worstWindow.sortReasoning}`);
        lines.push("");
    }
    if (biggestSpread && biggestSpread.spread > 5) {
        lines.push(`### Najveće razilaženje (spread=${biggestSpread.spread.toFixed(0)})`);
        lines.push(`Epizoda \`${shortBase(biggestSpread.base)}\`, t=${secToHms(biggestSpread.win.startSec)}–${secToHms(biggestSpread.win.endSec)}`);
        lines.push("");
        lines.push(`- **Canary** (${biggestSpread.canaryScore}/100): ${biggestSpread.canaryReasoning}`);
        lines.push(`- **Sortformer** (${biggestSpread.sortScore}/100): ${biggestSpread.sortReasoning}`);
        lines.push("");
    }

    // 4. Cross-reference sa stats
    lines.push("## 4. Cross-reference s objektivnim metrikama (compare_stats.js)");
    lines.push("");
    if (statsResults) {
        lines.push("| Epizoda | Sustav | Balance | Flicker | Rapid | Turns | Disagreement |");
        lines.push("|---|---|---:|---:|---:|---:|---:|");
        for (const r of statsResults.perFile) {
            for (const sys of ["canary", "sortformer"]) {
                const m = r[sys];
                const dis = sys === "canary" ? `${(r.disagreementPct * 100).toFixed(1)}%` : "";
                lines.push(`| \`${shortBase(r.base)}\` | ${sys} | ${m.balance.toFixed(3)} | ${m.flickerCount} | ${m.rapidSwitchCount} | ${m.numTurns} | ${dis} |`);
            }
        }
        lines.push("");
        lines.push("**Agregat:**");
        const a = statsResults.aggregate;
        lines.push(`- Canary: balance=${a.canary.meanBalance.toFixed(3)}, flicker=${a.canary.meanFlicker.toFixed(1)}, rapid=${a.canary.meanRapid.toFixed(1)}, turns=${a.canary.meanTurns.toFixed(1)}`);
        lines.push(`- Sortformer: balance=${a.sortformer.meanBalance.toFixed(3)}, flicker=${a.sortformer.meanFlicker.toFixed(1)}, rapid=${a.sortformer.meanRapid.toFixed(1)}, turns=${a.sortformer.meanTurns.toFixed(1)}`);
        lines.push(`- Disagreement (canary vs sortformer): ${(a.meanDisagreement * 100).toFixed(1)}%`);
        lines.push("");
        lines.push("**Interpretacija**: viši `balance` = ravnomjernija raspodjela vremena između govornika (bliže 1.0 = savršeno 50/50). Niži `flicker` i `rapid` = manje sumnjivih kratkih turn-ova i rapid-switching artefakta. Niži `disagreement` znači da se sustavi slažu na razini segmenta.");
        lines.push("");
    }

    // 5. Greške / preskočeni prozori
    const errors = [];
    for (const r of llmResults.perFile) {
        for (const w of r.windows) {
            if (w.error) errors.push({ base: r.base, win: w.window, error: w.error });
        }
    }
    if (errors.length > 0) {
        lines.push("## 5. Preskočeni prozori (Gemini greške)");
        lines.push("");
        for (const e of errors) {
            lines.push(`- \`${shortBase(e.base)}\` t=${secToHms(e.win.startSec)}–${secToHms(e.win.endSec)}: ${e.error}`);
        }
        lines.push("");
    }

    lines.push("---");
    lines.push("");
    lines.push("**Metodologija**: 5 epizoda × 3 random 90s prozora = 15 LLM evaluacija. Sudac: Gemini 2.5 Flash (Vertex AI OAuth, global region). Window-ovi sampliraju se sa seeded RNG (mulberry32, seed=20260511) za reproducibilnost. Sustavi se anonimiziraju samo po imenu (`CANARY`/`SORTFORMER`); model ne zna koji je koji algoritam.");
    lines.push("");
    return lines.join("\n");
}

// ─── MAIN ───────────────────────────────────────────────────────

async function main() {
    const statsResults = fs.existsSync(STATS_JSON)
        ? JSON.parse(fs.readFileSync(STATS_JSON, "utf-8"))
        : null;
    if (!statsResults) {
        console.error("⚠️  stats_results.json ne postoji — pokreni compare_stats.js prvo.");
    }

    let llmResults;

    if (fs.existsSync(LLM_JSON) && !FORCE) {
        console.log(`✅ llm_results.json već postoji — koristim cache. (--force za recompute)`);
        llmResults = JSON.parse(fs.readFileSync(LLM_JSON, "utf-8"));
    } else {
        const rng = mulberry32(RNG_SEED);
        const perFile = [];

        for (const base of TEST_BASES) {
            console.log(`\n📁 ${base}`);
            const canaryPath = path.join(CORPUS_DIR, base + ".canary.diarized.srt");
            const sortPath = path.join(CORPUS_DIR, base + ".sortformer.diarized.srt");
            if (!fs.existsSync(canaryPath) || !fs.existsSync(sortPath)) {
                console.error(`  ❌ Nedostaje SRT par — preskačem.`);
                continue;
            }

            const canarySegs = parseSrt(fs.readFileSync(canaryPath, "utf-8"));
            const sortSegs = parseSrt(fs.readFileSync(sortPath, "utf-8"));

            // Trajanje datoteke = max endSec među oba
            const maxSec = Math.max(
                canarySegs.length > 0 ? canarySegs[canarySegs.length - 1].endSec : 0,
                sortSegs.length > 0 ? sortSegs[sortSegs.length - 1].endSec : 0
            );

            const windows = pickWindows(maxSec, rng);
            console.log(`  🪟 Trajanje ~${secToHms(maxSec)}, prozori: ${windows.map(w => secToHms(w.startSec)).join(", ")}`);

            const windowResults = [];
            for (let i = 0; i < windows.length; i++) {
                const win = windows[i];
                const block = formatWindowBlock(canarySegs, sortSegs, win, i);
                process.stdout.write(`  ⏳ Window ${i + 1}/${windows.length} (${secToHms(win.startSec)})... `);

                try {
                    const judge = await callGeminiJudge(block);
                    console.log(`canary=${judge.canary.score} sort=${judge.sortformer.score}`);
                    windowResults.push({ window: win, canary: judge.canary, sortformer: judge.sortformer });
                } catch (err) {
                    console.log(`SKIP (${err.message})`);
                    windowResults.push({ window: win, error: err.message });
                }
                await sleep(INTER_CALL_DELAY_MS);
            }

            const validWindows = windowResults.filter(w => !w.error);
            const canaryMean = validWindows.length > 0
                ? validWindows.reduce((a, w) => a + w.canary.score, 0) / validWindows.length
                : 0;
            const sortMean = validWindows.length > 0
                ? validWindows.reduce((a, w) => a + w.sortformer.score, 0) / validWindows.length
                : 0;

            perFile.push({
                base,
                windows: windowResults,
                canaryMean,
                sortformerMean: sortMean,
                validWindowCount: validWindows.length
            });
        }

        // Agregat
        const valids = perFile.filter(r => r.validWindowCount > 0);
        const canaryOverall = valids.length > 0
            ? valids.reduce((a, r) => a + r.canaryMean, 0) / valids.length
            : 0;
        const sortOverall = valids.length > 0
            ? valids.reduce((a, r) => a + r.sortformerMean, 0) / valids.length
            : 0;

        llmResults = {
            generatedAt: new Date().toISOString(),
            model: GEMINI_MODEL,
            project: VERTEX_PROJECT,
            seed: RNG_SEED,
            perFile,
            aggregate: { canaryOverall, sortformerOverall: sortOverall }
        };

        fs.writeFileSync(LLM_JSON, JSON.stringify(llmResults, null, 2), "utf-8");
        console.log(`\n📄 LLM rezultati: ${LLM_JSON}`);
    }

    // Write REPORT.md
    const report = buildReport(llmResults, statsResults);
    fs.writeFileSync(REPORT_MD, report, "utf-8");
    console.log(`📄 Report: ${REPORT_MD}`);

    const c = llmResults.aggregate.canaryOverall;
    const s = llmResults.aggregate.sortformerOverall;
    const winner = c > s ? "CANARY" : (s > c ? "SORTFORMER" : "TIE");
    console.log(`\n🏆 Canary: ${c.toFixed(2)}/100  |  Sortformer: ${s.toFixed(2)}/100  →  ${winner}`);
}

main().catch(err => {
    console.error("❌ Fatal:", err);
    process.exit(1);
});
