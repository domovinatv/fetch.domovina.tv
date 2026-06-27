#!/usr/bin/env node
/**
 * download_matched_beamly_video.js
 * ────────────────────────────────
 * Skida YouTube VIDEO za YT-matchane beamly (subclub/launched) epizode i sprema ga
 * kao lokalni `{base}.mp4` u channel dir. Postojeći KORAK 12.5 `backfill_video_h264.js`
 * ga onda transkodira u H.264 → uploada `data/{videoId}/video_h264.mp4` na R2
 * (cdn.domovina.ai), a Flutter ga probe-a po konvenciji (bez frontend promjene).
 *
 * ZAŠTO zaseban korak: beamly epizode dolaze kao direktni MP3 (audio), bez videa.
 * `backfill_video_h264.js` samo TRANSKODIRA postojeći lokalni video — ne skida ga.
 * Ova skripta popunjava taj korak za matchane epizode (info.json `_yt_matched===true`),
 * čiji `_yt_` u imenu JE pravi YouTube ID.
 *
 * IDEMPOTENTNO:
 *   - LIST-once R2 (data/ prefix) → preskoči ako `data/{id}/video_h264.mp4` već postoji.
 *   - preskoči ako lokalni `{base}.mp4` ili `{base}.web.mp4` već postoji.
 * Sekvencijalno (concurrency 1) by default — 117 yt-dlp downloada paralelno bi povećalo
 * anti-bot rizik. Cookies preko `--cookies-from-browser brave` (kao fetch.js).
 *
 * Primjeri:
 *   node download_matched_beamly_video.js --dry-run
 *   node download_matched_beamly_video.js --channel subclub --video-id 5qWhNLUR3MA   # jedan (test)
 *   node download_matched_beamly_video.js --max-height 720                            # cijeli backfill
 *   node download_matched_beamly_video.js --channel launched
 *
 * Nakon ovoga (transcode + R2 upload):
 *   env -u HTTPS_PROXY node backfill_video_h264.js --channel subclub --rm-local-after-upload
 *   env -u HTTPS_PROXY node backfill_video_h264.js --channel launched --rm-local-after-upload
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ─── .env (ručni parser, kao upload_to_r2.js / backfill_video_h264.js) ───
(() => {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
})();

const _S3 = require("@aws-sdk/client-s3");
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET     = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";

// ─── CLI (Pattern B) ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && i + 1 < args.length ? args[i + 1] : d; };
const hasFlag = (n) => args.includes(n);

const OUTPUT_DIR  = getArg("--input-dir", path.join(__dirname, "storage", "output"));
const CHANNELS    = (getArg("--channel") || "subclub,launched").split(",").map(s => s.trim()).filter(Boolean);
const ONLY_VID    = getArg("--video-id");
const MAX_HEIGHT  = parseInt(getArg("--max-height", "720"), 10);
const LIMIT       = parseInt(getArg("--limit", "0"), 10);
const DRY_RUN     = hasFlag("--dry-run");
const BROWSER     = "brave";

// _yt_<11>  (last-match — naslovi epizoda mogu sami sadržavati _yt_; vidi memory)
function extractVideoId(name) {
    const m = name.match(/.*_yt_([A-Za-z0-9_-]{11})(?:[._]|$)/);
    return m ? m[1] : null;
}

function s3() {
    return new _S3.S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
}

// LIST-once: skup videoId-eva koji već imaju data/{id}/video_h264.mp4 na R2.
async function listR2VideoIds() {
    if (!R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID) {
        console.log("   ⚠️  Nema R2 credentials — preskačem R2 skip-provjeru (sve će se downloadati).");
        return null;
    }
    const client = s3();
    const ids = new Set();
    let token;
    do {
        const resp = await client.send(new _S3.ListObjectsV2Command({
            Bucket: R2_BUCKET, Prefix: "data/", ContinuationToken: token, MaxKeys: 1000,
        }));
        for (const o of resp.Contents || []) {
            if (o.Key.endsWith("/video_h264.mp4")) ids.add(o.Key.split("/")[1]);
        }
        token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
    return ids;
}

function ytdlp(videoId, outPath) {
    return new Promise((resolve) => {
        // Cap rezoluciju (talking-head); merge u mp4. cookies-from-browser brave (anti-bot).
        // --write-thumbnail --convert-thumbnails png → uz video skida i YouTube thumbnail kao
        // {base}.png (isto kao fetch.js za normalne epizode). upload_to_r2 ga mapira na
        // images/{id}/thumbnail.png (naslovna slika), a generate_og_image.js radi og-share iz njega.
        const fmt = `bestvideo[height<=${MAX_HEIGHT}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${MAX_HEIGHT}][ext=mp4]/best[height<=${MAX_HEIGHT}]/best`;
        const a = [
            "-f", fmt, "--merge-output-format", "mp4",
            "--write-thumbnail", "--convert-thumbnails", "png",
            "--cookies-from-browser", BROWSER,
            "--no-playlist", "--no-warnings", "--no-progress",
            "-o", outPath,
            `https://www.youtube.com/watch?v=${videoId}`,
        ];
        const proc = spawn("yt-dlp", a, { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        proc.stderr.on("data", c => { err += c.toString(); });
        proc.on("close", (code) => resolve({ ok: code === 0 && fs.existsSync(outPath), err }));
        proc.on("error", e => resolve({ ok: false, err: e.message }));
    });
}

function isAntiBot(s) {
    return /Sign in to confirm|not a bot|confirm you.?re not a bot|HTTP Error 429|too many requests/i.test(s || "");
}

(async () => {
    console.log(`\n🎬 Beamly video download — kanali: ${CHANNELS.join(", ")} | max ${MAX_HEIGHT}p${DRY_RUN ? " | DRY-RUN" : ""}`);
    const r2Ids = await listR2VideoIds();
    if (r2Ids) console.log(`   📋 R2 već ima video_h264.mp4 za ${r2Ids.size} videa (skip set).`);

    // Discovery: matchane beamly epizode.
    const tasks = [];
    for (const ch of CHANNELS) {
        const dir = path.join(OUTPUT_DIR, ch);
        let entries;
        try { entries = fs.readdirSync(dir); } catch { console.log(`   ⚠️  Nema dir: ${dir}`); continue; }
        for (const f of entries) {
            if (!f.endsWith(".info.json") || f.startsWith("._")) continue;
            const base = f.replace(/\.info\.json$/, "");
            const videoId = extractVideoId(base);
            if (!videoId) continue;
            if (ONLY_VID && videoId !== ONLY_VID) continue;
            let info;
            try { info = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")); } catch { continue; }
            if (info._yt_matched !== true) continue;   // samo matchane (audio-only nemaju YT video)
            tasks.push({ ch, dir, base, videoId,
                mp4: path.join(dir, `${base}.mp4`),
                web: path.join(dir, `${base}.web.mp4`) });
        }
    }

    // Filtriraj skip (već na R2 ili lokalno).
    const pending = [];
    let skipR2 = 0, skipLocal = 0;
    for (const t of tasks) {
        if (r2Ids && r2Ids.has(t.videoId)) { skipR2++; continue; }
        if (fs.existsSync(t.mp4) || fs.existsSync(t.web)) { skipLocal++; continue; }
        pending.push(t);
    }
    console.log(`   🔎 Matchanih: ${tasks.length} | već na R2: ${skipR2} | lokalno već: ${skipLocal} | ZA DOWNLOAD: ${pending.length}`);

    const todo = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;
    let ok = 0, fail = 0, n = 0;
    const t0 = Date.now();
    for (const t of todo) {
        n++;
        const tag = `[${n}/${todo.length}] ${t.ch}/${t.videoId}`;
        if (DRY_RUN) { console.log(`   [dry] ${tag} → ${path.basename(t.mp4)}`); continue; }
        process.stdout.write(`   ⏬ ${tag} ... `);
        const { ok: good, err } = await ytdlp(t.videoId, t.mp4);
        if (good) {
            const mb = (fs.statSync(t.mp4).size / 1e6).toFixed(1);
            const png = fs.existsSync(path.join(t.dir, `${t.base}.png`)) ? "+thumb" : "(BEZ thumb!)";
            const eta = ((Date.now() - t0) / n * (todo.length - n) / 1000 / 60).toFixed(0);
            console.log(`✅ ${mb} MB ${png} (ETA ~${eta} min)`);
            ok++;
        } else {
            console.log(`❌ ${(err.split("\n").find(l => /ERROR/.test(l)) || err.slice(0, 120)).slice(0, 160)}`);
            try { fs.existsSync(t.mp4) && fs.unlinkSync(t.mp4); } catch {}
            fail++;
            if (isAntiBot(err)) { console.log(`   🚫 Anti-bot detektiran — prekidam (pokreni kasnije / s tetherom).`); break; }
        }
    }
    console.log(`\n   ✓ Gotovo: ${ok} downloadano, ${fail} neuspjelo, ${skipR2 + skipLocal} preskočeno.`);
    if (ok > 0) console.log(`   ➡️  Sljedeće: node backfill_video_h264.js --channel ${CHANNELS.join(",")} --rm-local-after-upload`);
})();
