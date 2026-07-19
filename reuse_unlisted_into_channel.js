#!/usr/bin/env node
/**
 * reuse_unlisted_into_channel.js
 *
 * Reuse ad-hoc (_unlisted) obrade za videe praćenih kanala — "obradi jednom,
 * koristi svugdje". Kad je video prošao prioritetnu ad-hoc obradu preko
 * pipeline.domovina.ai (artefakti u storage/output/_unlisted/, per-video data
 * već na CDN-u), ova skripta:
 *
 *   1. prođe kroz channel dir i za svaki video BEZ .wav.canary.diarized.srt
 *      jeftino provjeri (O(1) lookup u _unlisted mapi, bez mreže) postoji li
 *      dovršena ad-hoc obrada (diarized.srt + article.json),
 *   2. prekopira SVE derivirane artefakte u channel dir s channel basenameom
 *      (transkripti, summary, outline/article/magisterium, RAG, screenshots,
 *      og-sections, og-share, gemini_usage) — izvorni mediji (mp3/wav/video)
 *      se NE diraju, channel dir ih već ima iz nightlyja,
 *   3. pushne .canary.srt (+.csv) na Drive pokraj WAV-a — transcribe_canary.py
 *      na Colabu skipa WAV čiji .canary.srt već postoji → NEMA duple
 *      transkripcije.
 *
 * Nakon toga su svi pipeline koraci za taj video no-op (idempotentni na
 * postojeće fajlove), a sljedeći generate_channel_index.js vidi article →
 * video gubi "U OBRADI" label. R2 upload ključeve preskače (već postoje od
 * ad-hoc runa).
 *
 * Usage:
 *   node reuse_unlisted_into_channel.js --channel slijedi_svoj_poziv_2 [--video-id dDDwWZPVS0s] [--dry-run] [--no-drive-srt]
 *
 * Idempotentno: postojeći fajlovi u channel diru se NIKAD ne prepisuju.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const INPUT_DIR = getArg("--input-dir") || path.join(__dirname, "storage", "output");
const CHANNEL = getArg("--channel");
const ONLY_VIDEO_ID = getArg("--video-id");
const DRY_RUN = args.includes("--dry-run");
const NO_DRIVE_SRT = args.includes("--no-drive-srt");
const DRIVE_REMOTE = getArg("--drive-remote") || "google_drive_ms:domovina_fetch_data/canary_wav";

if (!CHANNEL) {
    console.error("❌ Obavezan argument: --channel <ime_kanala> (underscored, npr. slijedi_svoj_poziv_2)");
    process.exit(1);
}

// Izvorni mediji + fetch metapodaci — channel dir ih već ima, NE kopiraju se.
const SOURCE_SUFFIX_SKIP = /^(\.(mp3|wav|mkv|mp4|webm|m4a|part|ytdl|description|png|webp|jpg)|\.info\.json|\.f\d+\.(mp4|webm|m4a))$/;

// Video ID: LAST match _yt_ (naslovi znaju sadržavati "_yt_") — vidi MEMORY extract_video_id_last_match.
function extractVideoId(name) {
    const m = name.match(/.*_yt_([A-Za-z0-9_-]{11})(?:[._]|$)/);
    return m ? m[1] : null;
}

// Basename = sve do kraja _yt_<ID> (radi i za `{base}_screenshots`, `{base}_{date}_{model}.article.json`).
function baseUpToId(name, videoId) {
    const marker = `_yt_${videoId}`;
    const idx = name.lastIndexOf(marker);
    return idx === -1 ? null : name.slice(0, idx + marker.length);
}

function groupByVideoId(dir) {
    const map = new Map(); // videoId → { base, entries: [name...] }
    let names;
    try {
        names = fs.readdirSync(dir).filter((n) => !n.startsWith("._") && !n.startsWith("."));
    } catch (e) {
        console.error(`❌ Ne mogu čitati ${dir}: ${e.message}`);
        process.exit(1);
    }
    for (const name of names) {
        const vid = extractVideoId(name);
        if (!vid) continue;
        if (!map.has(vid)) map.set(vid, { base: baseUpToId(name, vid), entries: [] });
        map.get(vid).entries.push(name);
    }
    return map;
}

function hasSuffix(group, suffix) {
    return group.entries.some((n) => n.endsWith(suffix));
}
function hasArticle(group) {
    return group.entries.some((n) => n.endsWith(".article.json"));
}

const channelDir = path.join(INPUT_DIR, CHANNEL);
const unlistedDir = path.join(INPUT_DIR, "_unlisted");

const channelMap = groupByVideoId(channelDir);
const unlistedMap = groupByVideoId(unlistedDir);

console.log(`\n🔁 REUSE _unlisted → ${CHANNEL}${DRY_RUN ? "  (DRY RUN)" : ""}`);
console.log(`   Kanal: ${channelMap.size} videa | _unlisted: ${unlistedMap.size} videa\n`);

let reused = 0, alreadyDone = 0, noSource = 0, partialSource = 0;

for (const [vid, chGroup] of channelMap) {
    if (ONLY_VIDEO_ID && vid !== ONLY_VIDEO_ID) continue;

    if (hasSuffix(chGroup, ".wav.canary.diarized.srt")) { alreadyDone++; continue; }

    const src = unlistedMap.get(vid);
    if (!src) { noSource++; continue; }

    const srcDone = hasSuffix(src, ".wav.canary.diarized.srt") && hasArticle(src);
    if (!srcDone) {
        partialSource++;
        console.log(`   ⚠️  ${vid}: postoji u _unlisted ali obrada NIJE dovršena (diarized+article) — preskačem`);
        continue;
    }

    console.log(`   ♻️  ${vid}: reuse iz _unlisted (${src.base})`);
    let copied = 0, skippedExisting = 0;
    for (const name of src.entries) {
        const suffix = name.slice(src.base.length);
        if (SOURCE_SUFFIX_SKIP.test(suffix)) continue;
        const from = path.join(unlistedDir, name);
        const to = path.join(channelDir, chGroup.base + suffix);
        if (fs.existsSync(to)) { skippedExisting++; continue; }
        if (DRY_RUN) {
            console.log(`      [dry] ${name} → ${path.basename(to)}`);
            copied++;
            continue;
        }
        fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
        copied++;
    }
    console.log(`      📄 kopirano: ${copied}, preskočeno (postoji): ${skippedExisting}`);

    // .canary.srt (+csv) na Drive pokraj WAV-a → Colab transcribe_canary.py ga skipa.
    if (!NO_DRIVE_SRT) {
        for (const ext of [".wav.canary.srt", ".wav.canary.csv"]) {
            const local = path.join(channelDir, chGroup.base + ext);
            if (!fs.existsSync(local)) continue;
            const remote = `${DRIVE_REMOTE}/${CHANNEL}/${chGroup.base}${ext}`;
            if (DRY_RUN) { console.log(`      [dry] rclone copyto → ${remote}`); continue; }
            try {
                execFileSync("rclone", ["copyto", local, remote, "--drive-shared-with-me"], {
                    stdio: "pipe",
                    env: { ...process.env, HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "" },
                });
                console.log(`      ⏫ Drive: ${path.basename(remote)} (Colab će skipati ovaj WAV)`);
            } catch (e) {
                console.log(`      ⚠️ rclone copyto nije uspio (${e.message.split("\n")[0]}) — Colab će transkribirati duplo (benigno, ~$0.003)`);
            }
        }
    }
    reused++;
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`   ♻️  Reusano:                ${reused}`);
console.log(`   ✅ Već obrađeni (kanal):    ${alreadyDone}`);
console.log(`   ⚠️  Nedovršeni u _unlisted:  ${partialSource}`);
console.log(`   ⏭️  Bez ad-hoc obrade:       ${noSource} (čekaju Colab batch)`);
if (reused > 0 && !DRY_RUN) {
    console.log(`\n   Sljedeći korak: node generate_channel_index.js && node upload_to_r2.js --meta-dir storage/meta`);
}
