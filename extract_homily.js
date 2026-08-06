#!/usr/bin/env node
/**
 * extract_homily.js — izdvaja propovijed iz transkripta svete mise.
 *
 * Zašto postoji: prijenosi misa su ~65-70% nepromjenjivi liturgijski tekst koji je
 * identičan u cijelom svijetu. Jedini jedinstveni sadržaj je propovijed. Ako cijela
 * misa uđe u RAG, dobiješ stotine near-duplicate chunkova koji zaguše dohvaćanje.
 * Ova skripta reže SAMO propovijed, i to nad SRT-om — nikad nad audiom.
 *
 * KLJUČNO: originalni timestampovi se ČUVAJU. Rezanje audia pa re-transkripcija
 * vratila bi timestampove na nulu i razbila deep linkove i screenshotove koji
 * gađaju izvorni YouTube video.
 *
 * Detekcija granica — sidra primarno, struktura kao potvrda i fallback:
 *   1. PRIMARNI (liturgijski): najava evanđelja → KRAJ evanđelja → prvi sljedeći
 *      obred. Mora biti primarni jer je na misi slavitelj ISTI govornik
 *      i za evanđelje i za propovijed, i to bez prekida (izmjereno na 24.7.2026:
 *      SPEAKER_00 drži 05:17→11:46 u komadu). "Najduži monolog" bi zato progutao
 *      evanđelje — a evanđelje je isto u cijelom svijetu i točno ono što ne smije
 *      u RAG.
 *      ⚠️ Vjerovanje ("Vjerujem u jednoga Boga") postoji SAMO nedjeljom i o
 *      svetkovinama. Na ferijalni dan propovijed prelazi ravno u Molitvu vjernika.
 *   2. FALLBACK (strukturni): Kadane max-subarray nad težinskim signalom
 *      (+trajanje za ciljanog govornika, -PENALTY*trajanje za ostale). Koristi se
 *      samo kad sidra zakažu, i tada se ispisuje upozorenje za ručnu provjeru.
 *   Diarizacija služi za identitet govornika i mjeru čistoće prozora.
 *
 * Usage:
 *   node extract_homily.js --file <path/to/*.canary.diarized.srt> [--preacher "don Ivan Šibalić"]
 *   node extract_homily.js --input-dir storage/output/_unlisted --video-id E0AILEwW550
 *
 * Output:
 *   {basename}.homily.srt   — scoped SRT, ORIGINALNI timestampovi
 *   {basename}.homily.json  — granice, govornik, signali, confidence
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
const hasFlag = (name) => args.indexOf(name) !== -1;

// --- Parametri detekcije ---
const INTERRUPT_PENALTY = 2.5;   // koliko "košta" tuđi govor unutar prozora
const MIN_HOMILY_SEC = 120;      // ispod ovoga nije propovijed nego npr. pozdrav
const MAX_HOMILY_SEC = 2400;     // 40 min — iznad toga je vjerojatno cijela misa

// --- Liturgijska sidra (normalizirano: bez dijakritike, lowercase) ---
//
// ⚠️ NE oslanjaj se na "Riječ Gospodnja" kao sidro. Canary ga na stvarnom
// materijalu redovito izobliči ("Riječ gospodinju", "Riječ gospodčima svete"),
// jer se izgovara brzo i preklapa s odgovorom puka. Najavni redak čitanja je
// stabilniji jer se izgovara razgovijetno.
const ANCHORS_GOSPEL = [
    "citanje svetog evandelja",
    "evandelja po",
    "evandelje po",
];

// Kraj evanđelja = početak propovijedi. Canary redovito izobliči zaključnu
// formulu ("Riječ gospodčima svete" 24.7., "Riječ gospodine" 23.7.), pa se
// hvata samo STABILNI PREFIKS. Traži se isključivo iza najave evanđelja, čime
// otpada lažni pogodak na kraju prvog čitanja.
const ANCHOR_GOSPEL_END = "rijec gospod";

// Otvarači propovijedi — SAMO kao potvrdni signal, NIKAD kao granica.
// Izmjereno: 24.7. počinje s "Bratovi i sestre", ali 23.7. kreće ravno u
// životopis sv. Brigite bez ikakvog oslovljavanja. Oslanjanje na otvarač
// srušilo bi svaku drugu propovijed.
const HOMILY_OPENERS = [
    "braco i sestre",
    "brace i sestre",
    "bratovi i sestre",
    "draga braco",
    "dragi vjernici",
];

// Sidra POSLIJE propovijedi, poredana po tome što dolazi prvo u liturgiji.
// ⚠️ Vjerovanje postoji SAMO nedjeljom i o svetkovinama — na ferijalni dan
// propovijed prelazi ravno u Molitvu vjernika. Zato uzimamo NAJRANIJE sidro
// koje se pojavi, a ne prvo s liste.
// `inclusive` = propovijed završava NA tom segmentu (ne prije njega). Potrebno
// jer "Ustanimo" zna biti zalijepljen na kraj zadnje rečenice propovijedi
// (24.7.: "...nekad stostruko ustanimo."), pa bi ekskluzivni rez pojeo cijelu
// zadnju minutu. Kad je "Ustanimo" zaseban segment (23.7.), uključivanje doda
// samo jednu riječ šuma.
const ANCHORS_AFTER = [
    { a: "ustanimo", inclusive: true },                  // poziv na ustajanje
    { a: "vjerujem u jednoga boga", inclusive: false },  // nicejsko — nedjelja/svetkovina
    { a: "vjerujem u boga oca svemogucega", inclusive: false },
    { a: "obratimo se", inclusive: false },              // poziv na molitvu vjernika
    { a: "pomolimo se ocu", inclusive: false },
    { a: "uslisi nas", inclusive: false },               // zaziv molitve vjernika
    { a: "blagoslovljen si gospodine boze", inclusive: false }, // prinos darova
    { a: "molite braco i sestre", inclusive: false },    // orate fratres
];

function normalize(s) {
    return s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[đ]/g, "d")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function timeToSeconds(ts) {
    const m = ts.trim().match(/^(\d+):(\d+):(\d+)[,.](\d+)$/);
    if (!m) return null;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
}

function secondsToTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

function parseSrt(raw) {
    const blocks = raw.replace(/\r/g, "").trim().split(/\n\n+/);
    const segs = [];
    for (const b of blocks) {
        const lines = b.split("\n");
        if (lines.length < 2) continue;
        const tl = lines.find((l) => l.includes("-->"));
        if (!tl) continue;
        const [a, z] = tl.split("-->");
        const start = timeToSeconds(a), end = timeToSeconds(z);
        if (start === null || end === null) continue;
        let text = lines.slice(lines.indexOf(tl) + 1).join(" ").trim();
        let speaker = null;
        const sm = text.match(/^\[([^\]]+)\]\s*/);
        if (sm) { speaker = sm[1]; text = text.slice(sm[0].length); }
        segs.push({ start, end, speaker, text, dur: Math.max(0, end - start) });
    }
    return segs;
}

/** Kadane nad težinskim signalom — najduži prozor u kojem dominira `spk`. */
function bestWindowFor(segs, spk) {
    let best = { score: -Infinity, i: 0, j: -1 };
    let cur = 0, curStart = 0;
    for (let k = 0; k < segs.length; k++) {
        const w = segs[k].speaker === spk
            ? segs[k].dur
            : -INTERRUPT_PENALTY * segs[k].dur;
        if (cur <= 0) { cur = w; curStart = k; } else { cur += w; }
        if (cur > best.score) best = { score: cur, i: curStart, j: k };
    }
    // Skratimo rubove na segmente ciljanog govornika (prozor ne smije
    // počinjati ni završavati tuđim govorom).
    while (best.i <= best.j && segs[best.i].speaker !== spk) best.i++;
    while (best.j >= best.i && segs[best.j].speaker !== spk) best.j--;
    return best;
}

function findAnchor(segs, anchors, from, to, dir) {
    const range = [];
    for (let k = from; dir > 0 ? k <= to : k >= to; k += dir) range.push(k);
    for (const k of range) {
        const n = normalize(segs[k].text);
        for (const a of anchors) {
            if (n.includes(a)) return { idx: k, anchor: a, at: segs[k].start, text: segs[k].text };
        }
    }
    return null;
}

function main() {
    let file = getArg("--file");
    const inputDir = getArg("--input-dir");
    const videoId = getArg("--video-id");

    if (!file && inputDir && videoId) {
        const hit = fs.readdirSync(inputDir)
            .filter((f) => f.includes(`_yt_${videoId}`) && f.endsWith(".canary.diarized.srt"));
        if (!hit.length) {
            console.error(`❌ Nema .canary.diarized.srt za ${videoId} u ${inputDir}`);
            process.exit(1);
        }
        file = path.join(inputDir, hit[0]);
    }
    if (!file || !fs.existsSync(file)) {
        console.error("❌ Zadaj --file <diarized.srt> ili --input-dir + --video-id");
        process.exit(1);
    }

    const segs = parseSrt(fs.readFileSync(file, "utf8"));
    if (!segs.length) { console.error("❌ Prazan/neparsabilan SRT"); process.exit(1); }

    const total = segs[segs.length - 1].end;
    const perSpk = {};
    for (const s of segs) {
        const k = s.speaker || "UNKNOWN";
        perSpk[k] = (perSpk[k] || 0) + s.dur;
    }

    console.log(`📄 ${path.basename(file)}`);
    console.log(`   segmenata: ${segs.length}, trajanje: ${secondsToTime(total)}`);
    console.log(`   govornici: ${Object.entries(perSpk).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${Math.round(v)}s`).join(", ")}`);

    // === Detekcija granica ===
    //
    // Redoslijed signala je diktiran stvarnim podacima, ne teorijom: na misi je
    // slavitelj isti govornik i za evanđelje i za propovijed, i to BEZ prekida
    // (izmjereno: SPEAKER_00 drži 05:17→11:46 u komadu). Zato čisti "najduži
    // monolog" proguta evanđelje — a evanđelje je isto u cijelom svijetu i točno
    // ono što ne smije u RAG. Sidra zato određuju GRANICE, a diarizacija služi
    // za identitet govornika i mjeru čistoće prozora.
    const gospel = findAnchor(segs, ANCHORS_GOSPEL, 0, segs.length - 1, 1);

    // Kraj evanđelja → propovijed počinje na SLJEDEĆEM segmentu.
    const gospelEnd = gospel
        ? findAnchor(segs, [ANCHOR_GOSPEL_END], gospel.idx + 1, segs.length - 1, 1)
        : null;
    const startIdx = gospelEnd ? gospelEnd.idx + 1 : null;

    // Otvarač je samo potvrda da smo pogodili početak — ne pomiče granicu.
    const opener = startIdx != null
        ? findAnchor(segs, HOMILY_OPENERS, startIdx, Math.min(segs.length - 1, startIdx + 2), 1)
        : null;

    // Kraj: NAJRANIJE sidro iza početka (Vjerovanje nedjeljom, Molitva vjernika
    // na ferijalni dan, "Ustanimo" u oba slučaja).
    let after = null;
    if (startIdx != null) {
        for (let k = startIdx; k < segs.length; k++) {
            const n = normalize(segs[k].text);
            const hit = ANCHORS_AFTER.find((x) => n.includes(x.a));
            if (hit) {
                after = { idx: k, anchor: hit.a, inclusive: hit.inclusive,
                          at: segs[k].start, text: segs[k].text };
                break;
            }
        }
    }

    let best, method;
    if (startIdx != null && after && after.idx >= startIdx) {
        const i = startIdx, j = after.inclusive ? after.idx : after.idx - 1;
        const win = segs.slice(i, j + 1);
        const tally = {};
        for (const s of win) tally[s.speaker || "UNKNOWN"] = (tally[s.speaker || "UNKNOWN"] || 0) + s.dur;
        const spk = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
        const spoken = tally[spk];
        best = { spk, i, j, start: segs[i].start, end: segs[j].end,
                 span: segs[j].end - segs[i].start, spoken,
                 purity: spoken / Math.max(1e-9, segs[j].end - segs[i].start) };
        method = "liturgical-anchors (gospel-end → next-rite)";
    } else {
        // Fallback kad sidra zakažu (loša transkripcija, netipičan tijek).
        const cands = Object.keys(perSpk).map((spk) => {
            const w = bestWindowFor(segs, spk);
            if (w.j < w.i) return null;
            const start = segs[w.i].start, end = segs[w.j].end;
            const spoken = segs.slice(w.i, w.j + 1)
                .filter((s) => s.speaker === spk).reduce((a, s) => a + s.dur, 0);
            return { spk, ...w, start, end, span: end - start, spoken,
                     purity: spoken / Math.max(1e-9, end - start) };
        }).filter(Boolean)
          .filter((c) => c.span >= MIN_HOMILY_SEC && c.span <= MAX_HOMILY_SEC)
          .sort((a, b) => b.spoken - a.spoken);
        if (!cands.length) {
            console.error("❌ Ni sidra ni monolog nisu dali kandidata.");
            process.exit(2);
        }
        best = cands[0];
        method = "fallback: longest-monologue (kadane)";
        console.log("   ⚠️  Sidra nisu uhvaćena — fallback na strukturni signal. PROVJERI RUČNO.");
    }

    const before = gospel;
    let confidence = "low";
    if (gospel && gospelEnd && after) confidence = "high";
    else if (gospelEnd && after) confidence = "medium";

    console.log(`\n🎯 Propovijed: ${secondsToTime(best.start)} → ${secondsToTime(best.end)}`
        + `  (${Math.round(best.span / 60)} min, govornik ${best.spk}, čistoća ${(best.purity * 100).toFixed(0)}%)`);
    console.log(`   udio u misi: ${((best.span / total) * 100).toFixed(1)}%`);
    console.log(`   sidro PRIJE: ${before ? `"${before.anchor}" @ ${secondsToTime(before.at)}` : "✗ nije nađeno"}`);
    console.log(`   sidro POSLIJE: ${after ? `"${after.anchor}" @ ${secondsToTime(after.at)}` : "✗ nije nađeno"}`);
    console.log(`   confidence: ${confidence.toUpperCase()}`);

    if (hasFlag("--dry-run")) { console.log("\n(dry-run — ništa nije zapisano)"); return; }

    const base = file.replace(/\.wav\.canary\.diarized\.srt$/, "").replace(/\.srt$/, "");
    const slice = segs.slice(best.i, best.j + 1);

    // SRT s OČUVANIM originalnim timestampovima (samo indeks se renumerira).
    const srtOut = slice.map((s, n) =>
        `${n + 1}\n${secondsToTime(s.start)} --> ${secondsToTime(s.end)}\n`
        + `${s.speaker ? `[${s.speaker}] ` : ""}${s.text}`
    ).join("\n\n") + "\n";
    fs.writeFileSync(`${base}.homily.srt`, srtOut);

    const meta = {
        version: 1,
        source_srt: path.basename(file),
        homily: {
            start_sec: +best.start.toFixed(3),
            end_sec: +best.end.toFixed(3),
            duration_sec: +best.span.toFixed(3),
            speaker_id: best.spk,
            preacher: getArg("--preacher") || null,
            segment_count: slice.length,
            purity: +best.purity.toFixed(4),
            share_of_mass: +(best.span / total).toFixed(4),
        },
        mass: { total_sec: +total.toFixed(3), speakers: perSpk },
        detection: {
            primary: method,
            anchor_gospel: before ? { anchor: before.anchor, at_sec: +before.at.toFixed(3), text: before.text } : null,
            homily_opener: opener ? { at_sec: +opener.at.toFixed(3), text: opener.text } : null,
            anchor_after: after ? { anchor: after.anchor, at_sec: +after.at.toFixed(3), text: after.text } : null,
            confidence,
        },
        timestamps_preserved: true,
    };
    fs.writeFileSync(`${base}.homily.json`, JSON.stringify(meta, null, 2));

    console.log(`\n✅ ${path.basename(base)}.homily.srt (${slice.length} segmenata)`);
    console.log(`✅ ${path.basename(base)}.homily.json`);
}

main();
