#!/usr/bin/env node
/**
 * auto_reuse_adhoc.js
 *
 * Automatski reuse ad-hoc (_unlisted) obrade za PRAĆENE kanale — glue oko
 * reuse_unlisted_into_channel.js. Dva načina rada:
 *
 *   1. --video-id <ID>   (priority fast-path, poziva ga bridge priority_poller.js
 *      nakon uspješne ad-hoc obrade, unutar pipeline locka priority ticka):
 *      • O(1): grep video ID-a kroz automatic/podcasts/*-lista.txt → kanal(i)
 *      • ako kanal video VEĆ ima fetchan (bilo koji fajl s _yt_<ID> u channel diru)
 *        → reuse_unlisted_into_channel.js --channel <ch> --video-id <ID>
 *      • ako je reuse stvarno nešto kopirao → reindex (generate_channel_index.js)
 *        + meta upload (upload_to_r2.js --meta-dir storage/meta) da video na
 *        kanalu odmah izgubi "U OBRADI" label. Skupi reindex se NE pokreće
 *        kad nema kopiranja (čest slučaj: video još nije fetchan u channel dir).
 *
 *   2. --sweep   (nightly catch-up, nightly_pipeline.sh NAKON fetch koraka a
 *      PRIJE KORAKA 13, pod istim pipeline lockom kao run_pipeline):
 *      • jednom pročita _unlisted, nađe DOVRŠENE ad-hoc obrade (diarized+article),
 *        mapira ID→kanal kroz liste pa pokrene reuse SAMO za kanale s kandidatima
 *        (no-op u jednoj sekundi kad ad-hoc obrada nema) — pokriva edge case kad
 *        se ad-hoc obrada dogodila PRIJE nego što je nightly fetchao video u
 *        channel dir. NE publisha: nightly KORAK 13 (index + meta upload) slijedi
 *        odmah iza ovog koraka.
 *
 *   3. --video-id <ID> --replace   (PONOVNA OBRADA iz pipeline.domovina.ai, bridge
 *      priority_poller.js nakon run_pipeline.sh --reprocess):
 *      • kanal VEĆ ima obradu → njegove stare izvedene fajlove skloni u .reprocess_bak/
 *        (tools/reprocess_episode.js, rename na istom volumenu, nikad delete), pa reuse
 *        prekopira NOVU _unlisted obradu pod pravim channel basenameom + reindex.
 *      • Bez ovoga channel dir ostane na starom članku/prijepisu, a upload_to_r2.js kod
 *        drifta veličine uvijek uzme DISK → sljedeći upload iz kanala vrati STARO na CDN.
 *      • CDN prepis (diarized.srt + words.json iz istog prolaza, članak, epub) je već
 *        napravio run_pipeline.sh KORAK 12.1 iz _unlisted; isti sadržaj je sad i u kanalu.
 *      • exit 1 ako prepis nije uspio (bridge tada job označi kao failed).
 *
 * Usage:
 *   node auto_reuse_adhoc.js --video-id dDDwWZPVS0s [--dry-run]
 *   node auto_reuse_adhoc.js --video-id dDDwWZPVS0s --replace [--dry-run]
 *   node auto_reuse_adhoc.js --sweep [--dry-run]
 *
 * Uvijek exit 0 na "nema posla" putevima (soft, ne smije rušiti launchd tick).
 */

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const INPUT_DIR = getArg("--input-dir") || path.join(__dirname, "storage", "output");
const PODCASTS_DIR = path.join(__dirname, "automatic", "podcasts");
const VIDEO_ID = getArg("--video-id");
const SWEEP = args.includes("--sweep");
const DRY_RUN = args.includes("--dry-run");
const REPLACE = args.includes("--replace");

if (REPLACE && !VIDEO_ID) {
    console.error("❌ --replace radi samo uz --video-id <ID>.");
    process.exit(1);
}
if (!VIDEO_ID && !SWEEP) {
    console.error("❌ Zadaj --video-id <ID> (priority fast-path) ili --sweep (nightly catch-up).");
    process.exit(1);
}

// Video ID: LAST match _yt_ (naslovi znaju sadržavati "_yt_") — vidi MEMORY extract_video_id_last_match.
function extractVideoId(name) {
    const m = name.match(/.*_yt_([A-Za-z0-9_-]{11})(?:[._]|$)/);
    return m ? m[1] : null;
}

// Praćeni kanali: <ime-s-crticama>-lista.txt → channel dir ime s underscoreima.
function listaFiles() {
    try {
        return fs.readdirSync(PODCASTS_DIR).filter((n) => n.endsWith("-lista.txt"));
    } catch {
        return [];
    }
}
function channelFromLista(listaName) {
    return listaName.replace(/-lista\.txt$/, "").replace(/-/g, "_");
}

// U kojim je listama video? URL boundary match (youtu.be/<ID> ili v=<ID>),
// komentirane linije (#) su namjerno isključene iz kanala pa se preskaču.
function channelsForVideoId(videoId) {
    const re = new RegExp(`(youtu\\.be/|[?&]v=)${videoId}(?![A-Za-z0-9_-])`);
    const channels = [];
    for (const lista of listaFiles()) {
        let content;
        try {
            content = fs.readFileSync(path.join(PODCASTS_DIR, lista), "utf-8");
        } catch {
            continue;
        }
        const hit = content.split("\n").some((line) => !line.trimStart().startsWith("#") && re.test(line));
        if (hit) channels.push(channelFromLista(lista));
    }
    return channels;
}

function channelEntriesFor(channel, videoId) {
    try {
        return fs.readdirSync(path.join(INPUT_DIR, channel)).filter((n) => n.includes(`_yt_${videoId}`));
    } catch {
        return null; // channel dir ne postoji (nije u storage.conf / setup_storage.sh)
    }
}

// reuse_unlisted_into_channel.js + parse "Reusano: N" iz sažetka.
function runReuse(channel, videoId) {
    const reuseArgs = [
        path.join(__dirname, "reuse_unlisted_into_channel.js"),
        "--channel", channel,
        ...(videoId ? ["--video-id", videoId] : []),
        ...(DRY_RUN ? ["--dry-run"] : []),
    ];
    let out;
    try {
        out = execFileSync("node", reuseArgs, { encoding: "utf-8", cwd: __dirname });
    } catch (e) {
        console.log(e.stdout || "");
        console.error(`   ⚠️ reuse_unlisted_into_channel.js pao za ${channel}: ${(e.stderr || e.message).split("\n")[0]}`);
        return 0;
    }
    process.stdout.write(out);
    const m = out.match(/Reusano:\s+(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
}

// Reindex + meta upload (KORAK 13 ekvivalent) — SAMO kad je reuse nešto kopirao.
function publish() {
    if (DRY_RUN) {
        console.log("\n   [dry] preskačem reindex + meta upload (generate_channel_index.js + upload_to_r2.js --meta-dir storage/meta)");
        return;
    }
    console.log("\n📇 Reindex + meta upload (reuse je kopirao artefakte)…");
    for (const cmd of [
        ["node", [path.join(__dirname, "generate_channel_index.js")]],
        ["node", [path.join(__dirname, "upload_to_r2.js"), "--meta-dir", path.join(__dirname, "storage", "meta")]],
    ]) {
        const r = spawnSync(cmd[0], cmd[1], { cwd: __dirname, stdio: "inherit" });
        if (r.status !== 0) console.error(`   ⚠️ ${path.basename(cmd[1][0])} exit ${r.status} — nightly KORAK 13 će nadoknaditi.`);
    }
}

// ─── Mode 1: --video-id (priority fast-path) ─────────────────────────────────
if (VIDEO_ID) {
    const channels = channelsForVideoId(VIDEO_ID);
    if (!channels.length) {
        console.log(`⏭️  ${VIDEO_ID}: nije u listama praćenih kanala — ništa za reuse (čisti ad-hoc).`);
        process.exit(0);
    }
    let totalReused = 0;
    let replaceFailed = false;
    for (const channel of channels) {
        const entries = channelEntriesFor(channel, VIDEO_ID);
        if (entries === null) {
            console.log(`⏭️  ${VIDEO_ID}: kanal ${channel} nema channel dir (storage.conf?) — preskačem.`);
            continue;
        }
        if (entries.some((n) => n.endsWith(".wav.canary.diarized.srt"))) {
            if (!REPLACE) {
                console.log(`✅ ${VIDEO_ID}: kanal ${channel} već ima diarized obradu — no-op.`);
                continue;
            }
            // Ponovna obrada: nova _unlisted obrada MORA biti dovršena prije nego dirnemo
            // kanal — inače bismo sklonili staro i ostavili kanal bez ičega.
            const unlisted = channelEntriesFor("_unlisted", VIDEO_ID) || [];
            const srcDone = unlisted.some((n) => n.endsWith(".wav.canary.diarized.srt"))
                && unlisted.some((n) => n.endsWith(".article.json"));
            if (!srcDone) {
                console.error(`❌ ${VIDEO_ID}: --replace, ali _unlisted obrada NIJE dovršena (diarized+article) — kanal ${channel} ostaje netaknut.`);
                replaceFailed = true;
                continue;
            }
            console.log(`🔁 ${VIDEO_ID}: --replace — sklanjam staru obradu kanala ${channel} u .reprocess_bak/`);
            const st = spawnSync("node", [
                path.join(__dirname, "tools", "reprocess_episode.js"), "stash",
                "--input-dir", INPUT_DIR, "--dir", channel, "--video-id", VIDEO_ID, "--scope", "derived",
                ...(DRY_RUN ? ["--dry-run"] : []),
            ], { cwd: __dirname, stdio: "inherit" });
            if (st.status !== 0) {
                console.error(`❌ ${VIDEO_ID}: sklanjanje stare obrade kanala ${channel} nije uspjelo.`);
                replaceFailed = true;
                continue;
            }
            const n = runReuse(channel, VIDEO_ID);
            if (n === 0 && !DRY_RUN) {
                console.error(`❌ ${VIDEO_ID}: reuse u ${channel} nije ništa prekopirao nakon sklanjanja — provjeri .reprocess_bak/.`);
                replaceFailed = true;
            }
            totalReused += n;
            continue;
        }
        if (!entries.length) {
            console.log(`⏭️  ${VIDEO_ID}: kanal ${channel} još NIJE fetchao video — nightly sweep će ga pokupiti nakon fetcha.`);
            continue;
        }
        console.log(`♻️  ${VIDEO_ID}: pripada kanalu ${channel} i fetchan je — pokrećem reuse.`);
        totalReused += runReuse(channel, VIDEO_ID);
    }
    if (totalReused > 0) publish();
    process.exit(replaceFailed ? 1 : 0);
}

// ─── Mode 2: --sweep (nightly catch-up) ──────────────────────────────────────
// Jedan readdir _unlisted → dovršene ad-hoc obrade → kanali s kandidatima.
const unlistedDir = path.join(INPUT_DIR, "_unlisted");
let unlistedNames = [];
try {
    unlistedNames = fs.readdirSync(unlistedDir).filter((n) => !n.startsWith("."));
} catch {
    console.log("⏭️  Nema _unlisted dira — ništa za sweep.");
    process.exit(0);
}

const byId = new Map(); // videoId → { diarized, article }
for (const name of unlistedNames) {
    const vid = extractVideoId(name);
    if (!vid) continue;
    const g = byId.get(vid) || { diarized: false, article: false };
    if (name.endsWith(".wav.canary.diarized.srt")) g.diarized = true;
    if (name.endsWith(".article.json")) g.article = true;
    byId.set(vid, g);
}
const completedIds = [...byId.entries()].filter(([, g]) => g.diarized && g.article).map(([vid]) => vid);
if (!completedIds.length) {
    console.log("⏭️  Sweep: nema dovršenih ad-hoc obrada u _unlisted — no-op.");
    process.exit(0);
}

// ID → kanali (svaka lista se čita jednom, testira sve kandidate).
const candidateChannels = new Set();
for (const lista of listaFiles()) {
    let content;
    try {
        content = fs.readFileSync(path.join(PODCASTS_DIR, lista), "utf-8");
    } catch {
        continue;
    }
    const lines = content.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    for (const vid of completedIds) {
        const re = new RegExp(`(youtu\\.be/|[?&]v=)${vid}(?![A-Za-z0-9_-])`);
        if (lines.some((l) => re.test(l))) {
            candidateChannels.add(channelFromLista(lista));
            break;
        }
    }
}

console.log(`🔎 Sweep: ${completedIds.length} dovršenih ad-hoc obrada u _unlisted; kandidat-kanala: ${candidateChannels.size}`);
if (!candidateChannels.size) process.exit(0);

let totalReused = 0;
for (const channel of [...candidateChannels].sort()) {
    if (!fs.existsSync(path.join(INPUT_DIR, channel))) {
        console.log(`⏭️  ${channel}: nema channel dir (storage.conf?) — preskačem.`);
        continue;
    }
    totalReused += runReuse(channel, null);
}

console.log(`\n🔁 Sweep gotov — ukupno reusano: ${totalReused}`);
if (totalReused > 0) {
    console.log("   ℹ️  Publish NE radim (sweep mode) — očekuje se da KORAK 13 (generate_channel_index.js + upload_to_r2.js --meta-dir storage/meta) slijedi.");
}
