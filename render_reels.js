#!/usr/bin/env node
/**
 * render_reels.js — reels.json (KORAK 9.9) → brendirani HyperFrames reel 9:16 → CDN.
 *
 * Za top N trenutaka (default 2) svake epizode čiji kanal ima brand.json:
 *   1. isječak u 1080p (yt-dlp --download-sections; lokalni video samo ako je ≥720p),
 *   2. lica kroz vrijeme (tools/hyperframes_reel/face_track.py, YuNet),
 *   3. kompozicija iz kartica (tools/hyperframes_reel/compose_reel.js + generic.template.html),
 *   4. `hyperframes check`, storyboard (snapshot po kartici → jedna JPG ploča), render,
 *   5. {base}.reels/{rank}.mp4 + {rank}.storyboard.jpg uz epizodu, upis u reels.json.
 * Objava (--publish): data/{id}/reels/{rank}-{sha8}.mp4 i .jpg (verzionirani ključevi,
 * immutable), pa data/{id}/reels.json (purge) i episode.json bundle (12.7).
 *
 * Render i objava su odvojeni namjerno: render traje ~1–2 min po reelu i ne treba pipeline
 * lock, a objava piše u data/{id}/ kao i nightly, pa je wrapper
 * (automatic/reels_render.sh) pušta tek pod lockom.
 *
 * Branding je ujedno i ograda: kanal bez data/branding/<kanal>/brand.json se ne renderira,
 * a automatski (bez --video-id) samo uz "reel": {"auto": true} u brand.json — reel s logom
 * kanala traži suglasnost kanala, a brand.json postoji i dok se na nju čeka.
 *
 * Upotreba:
 *   node render_reels.js --video-id f2HIRJPHHK4 --render-only
 *   node render_reels.js --render-only --max-renders 4
 *   node render_reels.js --publish-only
 *   node render_reels.js --dry-run
 *
 * Zastavice: --input-dir, --channel, --video-id, --top N (2), --since-days N (21, 0 = sve),
 *   --max-renders N (8), --render-only, --publish-only, --force (ponovni render),
 *   --keep-work, --debug (iscrta sigurnu zonu), --dry-run
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { preparePublic, loadBrand } = require("./tools/hyperframes_reel/compose_reel");

const ROOT = __dirname;
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

// .env (ručno, kao upload_to_r2.js)
try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
} catch (_) {}

const INPUT_DIR = getArg("--input-dir") || path.join(ROOT, "storage", "output");
const ONLY_CHANNEL = getArg("--channel");
const ONLY_VIDEO = getArg("--video-id");
const TOP = parseInt(getArg("--top") || "2", 10);
const SINCE_DAYS = parseInt(getArg("--since-days") || "21", 10);
const MAX_RENDERS = parseInt(getArg("--max-renders") || "8", 10);
const RENDER = !args.includes("--publish-only");
const PUBLISH = !args.includes("--render-only");
const FORCE = args.includes("--force");
const KEEP_WORK = args.includes("--keep-work");
const DEBUG = args.includes("--debug");
const DRY_RUN = args.includes("--dry-run");

const HF = "hyperframes@0.8.38";
const NPX = path.join(path.dirname(process.execPath), "npx");
const PY = process.env.REELS_PYTHON || path.join(os.homedir(), ".cache", "domovina-reels", "venv", "bin", "python");
const WORK_ROOT = process.env.REELS_WORK_DIR || path.join(os.homedir(), ".cache", "domovina-reels", "work");
const MAX_ATTEMPTS = 3;
const RENDER_VERSION = 1;   // povećaj kad se promijeni izgled → sve se renderira ponovno
const PAD_START = 0.12, PAD_END = 0.45;   // kao words_for_range.py

const R2_BUCKET = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "https://cdn.domovina.ai").replace(/\/$/, "");
const KEYS_CACHE = path.join(ROOT, ".r2_keys_cache.json");
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
// reels.json se prepisuje (novi render, poster) pod istim ključem — kao episode.json/listinzi
const CACHE_MUTABLE = "public, max-age=60, must-revalidate";

// ─── pomoćne ───────────────────────────────────────────────────────
function extractVideoId(filename) {
    const all = [...filename.matchAll(/(?=_yt_([A-Za-z0-9_-]{11}))/g)];
    return all.length ? all[all.length - 1][1] : null;
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; } };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function run(cmd, argv, opts = {}) {
    const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 15 * 60 * 1000, cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) } });
    if (r.error) throw new Error(`${path.basename(cmd)}: ${r.error.message}`);
    if (r.status !== 0) {
        const tail = `${r.stderr || ""}\n${r.stdout || ""}`.trim().split("\n").slice(-8).join("\n");
        throw new Error(`${path.basename(cmd)} ${argv[0] || ""} exit ${r.status}:\n${tail}`);
    }
    return r.stdout || "";
}

function probe(file) {
    const out = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-show_entries", "format=duration", "-of", "json", file]);
    const j = JSON.parse(out);
    const s = (j.streams || [])[0] || {};
    return { w: s.width || 0, h: s.height || 0, dur: parseFloat((j.format || {}).duration || "0") };
}

function listEpisodes() {
    const out = [];
    const chans = fs.readdirSync(INPUT_DIR, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".") && (!ONLY_CHANNEL || e.name === ONLY_CHANNEL));
    for (const ch of chans) {
        const dir = path.join(INPUT_DIR, ch.name);
        let files;
        try { files = fs.readdirSync(dir); } catch (_) { continue; }
        for (const f of files) {
            if (!f.endsWith(".reels.json")) continue;
            const vid = extractVideoId(f);
            if (!vid || (ONLY_VIDEO && vid !== ONLY_VIDEO)) continue;
            const base = f.slice(0, -".reels.json".length);
            out.push({ channel: ch.name, dir, base, vid, reelsPath: path.join(dir, f) });
        }
    }
    // kanalska kopija pobjeđuje `_unlisted` (auto_reuse_adhoc.js), kao u uploaderima
    const inChannel = new Set(out.filter((e) => e.channel !== "_unlisted").map((e) => e.vid));
    return out.filter((e) => e.channel !== "_unlisted" || !inChannel.has(e.vid));
}

function uploadDate(ep) {
    const first = (fs.readFileSync(path.join(ep.dir, ep.base + ".segments.jsonl"), "utf8").split("\n")[0]) || "{}";
    try { return JSON.parse(first).upload_date || ""; } catch (_) { return ""; }
}

// Što ulazi u render: promjena bilo čega od ovoga = novi render
// Brend ulazi samo izgledom (boje, fontovi, logo i njihove datoteke) — ne mtime-om ni
// poljima pristanka (reel.auto), inače bi svaka izmjena brand.json renderirala sve ponovno.
function brandStamp(brand) {
    if (!brand) return null;
    const b = brand.json;
    const files = [...Object.values(b.typography || {}), ...Object.values(b.logo || {})]
        .filter((f) => typeof f === "string" && /\.(ttf|otf|png|svg)$/i.test(f))
        .map((f) => { try { return sha(fs.readFileSync(path.join(brand.dir, f))).slice(0, 12); } catch (_) { return null; } });
    const { auto, auto_note, ...reelLook } = b.reel || {};
    return [b.colors, reelLook, files];
}

function renderFingerprint(reel, brand) {
    return sha(JSON.stringify([RENDER_VERSION, reel.start_sec, reel.end_sec, reel.cards, reel.hook, brandStamp(brand)])).slice(0, 16);
}

// Riječi reela iz segments.jsonl + words.json (cue-ovi 1:1, tokeni = text.split)
function reelWords(ep, reel, r_s) {
    const segs = fs.readFileSync(path.join(ep.dir, ep.base + ".segments.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const wj = readJson(path.join(ep.dir, ep.base + ".words.json"));
    if (!wj || !wj.cues || wj.cues.length !== segs.length) throw new Error("words.json nedostaje ili nije par sa segments.jsonl");
    const words = [];
    segs.forEach((s, i) => {
        if (s.seq < reel.start_seq || s.seq > reel.end_seq) return;
        const toks = s.text.split(/\s+/).filter(Boolean);
        const w = wj.cues[i].w;
        if (w.length !== toks.length * 2) throw new Error(`cue ${s.seq}: broj riječi ne odgovara words.json`);
        toks.forEach((t, k) => words.push({ text: t, start: +(w[2 * k] / 1000 - r_s).toFixed(3), end: +(w[2 * k + 1] / 1000 - r_s).toFixed(3) }));
    });
    return words;
}

function localVideo(ep) {
    for (const ext of [".mp4", ".mkv", ".webm"]) {
        const p = path.join(ep.dir, ep.base + ext);
        if (fs.existsSync(p)) {
            try { const pr = probe(p); if (pr.h >= 720) return p; } catch (_) {}
        }
    }
    return null;
}

// ─── render jednog reela ───────────────────────────────────────────
function renderOne(ep, info, reel, brand) {
    const work = path.join(WORK_ROOT, `${ep.vid}_${reel.rank}`);
    fs.rmSync(work, { recursive: true, force: true });
    const pub = path.join(work, "public");
    fs.mkdirSync(pub, { recursive: true });
    const t0 = Date.now();

    const r_s = Math.max(0, reel.start_sec - PAD_START);
    const r_e = reel.end_sec + PAD_END;
    const dur = +(r_e - r_s).toFixed(3);

    // 1. isječak
    const local = localVideo(ep);
    let src, off;
    if (local) {
        src = local; off = r_s;
    } else {
        const a = Math.max(0, r_s - 1), b = r_e + 1;
        src = path.join(work, "raw.mp4");
        run("yt-dlp", ["-q", "--no-warnings", "-f", "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[height<=1080]",
            "--download-sections", `*${a.toFixed(2)}-${b.toFixed(2)}`, "--force-keyframes-at-cuts",
            "--merge-output-format", "mp4", "-o", src, `https://www.youtube.com/watch?v=${ep.vid}`], { timeout: 10 * 60 * 1000 });
        off = r_s - a;
    }
    const input = path.join(pub, "input-video.mp4");
    run("ffmpeg", ["-y", "-loglevel", "error", "-ss", off.toFixed(3), "-i", src, "-t", dur.toFixed(3),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "25", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", input]);
    const pr = probe(input);
    if (pr.h < 720) throw new Error(`isječak je ${pr.w}×${pr.h}, treba ≥720p`);
    if (Math.abs(pr.w / pr.h - 16 / 9) > 0.05) throw new Error(`omjer ${pr.w}×${pr.h} nije 16:9 (raspored pretpostavlja 16:9)`);

    // 2. lica
    const facesPath = path.join(work, "faces.json");
    run(PY, [path.join(ROOT, "tools", "hyperframes_reel", "face_track.py"), input, facesPath], { cwd: ROOT });

    // 3. kompozicija
    const comp = preparePublic(pub, {
        reel, dur, debug: DEBUG, brand,
        words: reelWords(ep, reel, r_s),
        faces: readJson(facesPath),
        videoId: ep.vid,
        title: info.title,
        channelName: (brand && brand.json.name) || info.channel || ep.channel,
    });

    // 4. provjera, storyboard, render
    run(NPX, ["--yes", HF, "check", pub], { timeout: 5 * 60 * 1000 });
    // number: snimi tek kad brojač stane (compose_reel: start+0.3, trajanje min(1.6, max(0.6, dur-1.2))),
    // inače ploča pokaže međuvrijednost („4.569 €" umjesto „5.000 €")
    const at = comp.cards.map((c) => {
        const t = c.type === "number"
            ? Math.min(c.start + c.dur - 0.3, c.start + 0.3 + Math.min(1.6, Math.max(0.6, c.dur - 1.2)) + 0.2)
            : c.start + Math.min(1.2, c.dur / 2);
        return Math.min(dur - 0.1, t).toFixed(2);
    });
    const boards = path.join(work, "boards");
    run(NPX, ["--yes", HF, "snapshot", pub, "--at", at.join(","), "--no-end", "--describe", "false", "-o", boards], { timeout: 5 * 60 * 1000, env: { GEMINI_API_KEY: "" } });
    const stills = fs.readdirSync(boards).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(boards, f));
    const board = path.join(work, "storyboard.jpg");
    if (stills.length) {
        // montage i za prazan natpis traži font — bez -font pada s „unable to read font"
        run("montage", ["-font", path.join(ROOT, "data", "branding", "fonts", "Montserrat-Bold.ttf"), "-label", "", ...stills, "-tile", `${Math.min(4, stills.length)}x`, "-geometry", "270x480+6+6", "-background", "#111", "-quality", "82", board]);
    }
    const raw = path.join(work, "render.mp4");
    run(NPX, ["--yes", HF, "render", pub, "-o", raw, "--crf", "20", "--quiet"], { timeout: 20 * 60 * 1000 });
    const final = path.join(work, "final.mp4");
    run("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-c", "copy", "-movflags", "+faststart", final]);

    // 5. uz epizodu
    const outDir = path.join(ep.dir, ep.base + ".reels");
    fs.mkdirSync(outDir, { recursive: true });
    const mp4 = path.join(outDir, `${reel.rank}.mp4`);
    fs.copyFileSync(final, mp4);
    let boardOut = null;
    if (fs.existsSync(board)) { boardOut = path.join(outDir, `${reel.rank}.storyboard.jpg`); fs.copyFileSync(board, boardOut); }
    if (!KEEP_WORK) fs.rmSync(work, { recursive: true, force: true });

    return {
        version: RENDER_VERSION,
        rendered_at: new Date().toISOString(),
        seconds: Math.round((Date.now() - t0) / 1000),
        source: local ? "local" : "youtube",
        clip_start_sec: +r_s.toFixed(3),
        duration_sec: dur,
        cards: comp.cards.map((c) => ({ type: c.type, start: c.start, dur: c.dur })),
        file: path.basename(mp4),
        bytes: fs.statSync(mp4).size,
        sha256: sha(fs.readFileSync(mp4)),
        storyboard: boardOut ? path.basename(boardOut) : null,
    };
}

// Poster za sličicu: čist kadar bez kartica (naslov/hook klijent ionako piše uz sliku) —
// sredina najduljeg razmaka između kartica. Titl riječ po riječ je i dalje u kadru.
function posterSec(render) {
    const dur = render.duration_sec;
    const busy = (render.cards || []).map((c) => [c.start - 0.3, c.start + c.dur + 0.3]).sort((a, b) => a[0] - b[0]);
    let best = [0, 0], t = 0.5;
    for (const [a, b] of [...busy, [dur - 0.5, dur]]) {
        if (a - t > best[1] - best[0]) best = [t, a];
        t = Math.max(t, b);
    }
    return +(best[1] > best[0] ? (best[0] + best[1]) / 2 : dur / 2).toFixed(2);
}

function ensurePoster(ep, r, mp4) {
    const out = path.join(ep.dir, ep.base + ".reels", `${r.rank}.poster.webp`);
    const at = posterSec(r.render);
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(mp4).mtimeMs && r.render.poster_sec === at) return out;
    const png = path.join(os.tmpdir(), `reel_poster_${ep.vid}_${r.rank}.png`);
    try {
        run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(at), "-i", mp4, "-frames:v", "1", "-vf", "scale=540:960", png]);
        run("magick", [png, "-quality", "80", out]);   // lokalni ffmpeg nema libwebp
        r.render.poster_sec = at;
        return out;
    } catch (e) {
        console.log(`   ⚠️  poster ${ep.vid} #${r.rank}: ${e.message}`);
        return null;
    } finally { fs.rmSync(png, { force: true }); }
}

function consented(channel) {
    const brand = loadBrand(channel);
    return !!(brand && brand.json.reel && brand.json.reel.auto === true);
}

function writeReels(ep, doc) {
    const tmp = ep.reelsPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
    fs.renameSync(tmp, ep.reelsPath);
}

function renderPhase(eps) {
    const todo = [];
    let noBrand = 0, noConsent = 0, outside = 0;
    for (const ep of eps) {
        const brand = loadBrand(ep.channel);
        if (!brand) { noBrand++; continue; }
        // Automatski (bez --video-id) samo uz izričit pristanak kanala u brand.json:
        // "reel": { "auto": true }. Sam brand.json nije pristanak (npr. logo poslan na odobrenje).
        if (!ONLY_VIDEO && !consented(ep.channel)) { noConsent++; continue; }
        if (!ONLY_VIDEO && SINCE_DAYS > 0) {
            const d = uploadDate(ep);
            if (!d || (Date.now() - Date.parse(d)) / 86400000 > SINCE_DAYS) { outside++; continue; }
        }
        const doc = readJson(ep.reelsPath);
        if (!doc || !Array.isArray(doc.reels)) continue;
        for (const reel of doc.reels.filter((r) => r.rank <= TOP)) {
            const fp = renderFingerprint(reel, brand);
            const r = reel.render || {};
            const done = r.fingerprint === fp && r.file && fs.existsSync(path.join(ep.dir, ep.base + ".reels", r.file));
            if (done && !FORCE) continue;
            if (!FORCE && r.fingerprint === fp && (r.attempts || 0) >= MAX_ATTEMPTS) continue;
            todo.push({ ep, brand, rank: reel.rank, fp, date: uploadDate(ep) });
        }
    }
    todo.sort((a, b) => b.date.localeCompare(a.date) || a.rank - b.rank);
    const batch = todo.slice(0, MAX_RENDERS);
    console.log(`🎞️  render: ${todo.length} reelova čeka (u ovom runu ${batch.length}) | bez brenda: ${noBrand} ep | bez reel.auto: ${noConsent} ep | izvan prozora: ${outside} ep`);

    let ok = 0, failed = 0;
    for (const job of batch) {
        const { ep, brand } = job;
        const doc = readJson(ep.reelsPath);
        const reel = doc.reels.find((r) => r.rank === job.rank);
        console.log(`\n▶ ${ep.channel}/${ep.vid} #${reel.rank} ${Math.round(reel.start_sec)}–${Math.round(reel.end_sec)} s — ${reel.title}`);
        if (DRY_RUN) continue;
        const info = { title: doc.title, channel: doc.channel };
        try {
            const res = renderOne(ep, info, reel, brand);
            const fresh = readJson(ep.reelsPath);
            const target = fresh.reels.find((r) => r.rank === job.rank);
            target.render = { ...res, fingerprint: job.fp };
            writeReels(ep, fresh);
            ok++;
            console.log(`   ✅ ${res.file} ${(res.bytes / 1e6).toFixed(1)} MB, ${res.seconds} s (${res.source}), kartica ${res.cards.length}`);
        } catch (err) {
            failed++;
            const fresh = readJson(ep.reelsPath);
            const target = fresh.reels.find((r) => r.rank === job.rank);
            const prev = target.render && target.render.fingerprint === job.fp ? target.render.attempts || 0 : 0;
            target.render = { fingerprint: job.fp, attempts: prev + 1, error: String(err.message).slice(0, 600), failed_at: new Date().toISOString() };
            writeReels(ep, fresh);
            console.log(`   ❌ ${err.message.split("\n").join("\n      ")}`);
        }
    }
    console.log(`\n📊 render: gotovo ${ok}, grešaka ${failed}${DRY_RUN ? " (dry-run)" : ""}`);
    return { ok, failed };
}

// ─── objava na CDN ─────────────────────────────────────────────────
function loadKeysCache() {
    const raw = readJson(KEYS_CACHE);
    if (Array.isArray(raw)) return { v: 2, sizes: Object.fromEntries(raw.map((k) => [k, null])) };
    return raw && raw.sizes ? raw : { v: 2, sizes: {} };
}

async function purge(urls) {
    const token = process.env.DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE;
    if (!urls.length || !token) return 0;
    const z = await (await fetch("https://api.cloudflare.com/client/v4/zones?name=domovina.ai", { headers: { Authorization: `Bearer ${token}` } })).json();
    const zoneId = z && z.success && z.result && z.result[0] && z.result[0].id;
    if (!zoneId) return 0;
    const files = urls.flatMap((u) => [u, { url: u, headers: { Origin: "https://domovina.ai" } }]);
    let n = 0;
    for (let i = 0; i < files.length; i += 30) {
        const r = await (await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
            method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ files: files.slice(i, i + 30) }),
        })).json().catch(() => ({}));
        if (r && r.success) n += Math.min(30, files.length - i);
    }
    return n;
}

// data/{id}/reels.json = lokalni reels.json bez `rejected` (odbačeni kandidati nisu za klijenta)
function publicReelsJson(doc) {
    const pubDoc = { ...doc };
    delete pubDoc.rejected;
    return JSON.stringify(pubDoc);
}

async function publishPhase(eps) {
    const cache = loadKeysCache();
    const published = (id) => Object.prototype.hasOwnProperty.call(cache.sizes, `data/${id}/info.json`);
    const jobs = [];
    let waiting = 0, candidatesOnly = 0;
    for (const ep of eps) {
        const doc = readJson(ep.reelsPath);
        if (!doc || !(doc.reels || []).length) continue;
        const rendered = doc.reels.some((r) => r.render && r.render.file);
        if (!published(ep.vid)) {
            if (rendered) console.log(`   ⏭️  ${ep.vid}: epizoda još nije na CDN-u — objavit će se kad bude`);
            else waiting++;
            continue;
        }
        // Video (logo kanala) ide van pod istom ogradom kao render: reel.auto ili izričit --video-id.
        // Bez nje bi launchd tick (--publish-only) objavio i reel izrenderiran samo za pregled.
        ep.videoConsent = !!ONLY_VIDEO || consented(ep.channel);
        const needs = ep.videoConsent && doc.reels.some((r) => r.render && r.render.file && fs.existsSync(path.join(ep.dir, ep.base + ".reels", r.render.file))
            && (!r.render.url || !r.render.url.includes(r.render.sha256.slice(0, 8)) || !r.render.poster_url));
        // Kandidati (istaknuti trenuci na timelineu) idu na CDN za SVAKU epizodu, i bez
        // brenda i pristanka kanala: to su samo vremena i naslovi, bez loga i videa.
        // Drift po veličini kao u keys-cacheu (upload_to_r2.js): nova ili promijenjena datoteka.
        const jsonDrift = cache.sizes[`data/${ep.vid}/reels.json`] !== Buffer.byteLength(publicReelsJson(doc));
        if (needs || jsonDrift || FORCE) {
            jobs.push({ ep, doc });
            if (!rendered) candidatesOnly++;
        }
    }
    if (waiting) console.log(`   ⏭️  ${waiting} epizoda s kandidatima još nije na CDN-u`);
    console.log(`☁️  objava: ${jobs.length} epizoda (od toga samo kandidati: ${candidatesOnly})`);
    if (!jobs.length || DRY_RUN) return { ok: 0 };

    const { S3Client, PutObjectCommand } = require(path.join(ROOT, "node_modules", "@aws-sdk", "client-s3"));
    const client = new S3Client({
        region: "auto",
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
    const put = async (key, body, type, cacheControl = CACHE_IMMUTABLE) => {
        await client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: type, CacheControl: cacheControl }));
        cache.sizes[key] = body.length;
    };

    const purgeUrls = [];
    const bundleIds = [];
    for (const { ep } of jobs) {
        const doc = readJson(ep.reelsPath);   // svježe — render je mogao pisati
        try {
            for (const r of doc.reels) {
                if (!ep.videoConsent || !r.render || !r.render.file) continue;
                const local = path.join(ep.dir, ep.base + ".reels", r.render.file);
                if (!fs.existsSync(local)) continue;
                const v = r.render.sha256.slice(0, 8);
                const fresh = !(r.render.url && r.render.url.includes(v)) || FORCE;
                // poster stiže i reelu objavljenom prije njega (backfill bez ponovnog rendera)
                if (fresh || !r.render.poster_url) {
                    const pl = ensurePoster(ep, r, local);
                    if (pl) {
                        const pkey = `data/${ep.vid}/reels/${r.rank}-${v}.poster.webp`;
                        await put(pkey, fs.readFileSync(pl), "image/webp");
                        r.render.poster = path.basename(pl);
                        r.render.poster_url = `${R2_PUBLIC_URL}/${pkey}`;
                        purgeUrls.push(r.render.poster_url);
                        console.log(`   🖼️  ${pkey} (t=${r.render.poster_sec} s)`);
                    }
                }
                if (!fresh) continue;
                const key = `data/${ep.vid}/reels/${r.rank}-${v}.mp4`;
                await put(key, fs.readFileSync(local), "video/mp4");
                r.render.url = `${R2_PUBLIC_URL}/${key}`;
                purgeUrls.push(r.render.url);     // novi ključ, ali CDN je možda zapamtio 404
                if (r.render.storyboard) {
                    const bl = path.join(ep.dir, ep.base + ".reels", r.render.storyboard);
                    if (fs.existsSync(bl)) {
                        const bkey = `data/${ep.vid}/reels/${r.rank}-${v}.storyboard.jpg`;
                        await put(bkey, fs.readFileSync(bl), "image/jpeg");
                        r.render.storyboard_url = `${R2_PUBLIC_URL}/${bkey}`;
                    }
                }
                console.log(`   ⬆️  ${key} (${(r.render.bytes / 1e6).toFixed(1)} MB)`);
            }
            if (doc.reels.some((r) => r.render && r.render.file)) writeReels(ep, doc);
            const jkey = `data/${ep.vid}/reels.json`;
            await put(jkey, Buffer.from(publicReelsJson(doc)), "application/json; charset=utf-8", CACHE_MUTABLE);
            purgeUrls.push(`${R2_PUBLIC_URL}/${jkey}`);
            bundleIds.push(ep.vid);
        } catch (err) {
            console.log(`   ❌ ${ep.vid}: ${err.message}`);
        }
    }

    try {
        const fresh = loadKeysCache();
        for (const [k, v] of Object.entries(cache.sizes)) if (k.startsWith("data/") && k.includes("/reels")) fresh.sizes[k] = v;
        fs.writeFileSync(KEYS_CACHE, JSON.stringify(fresh));
    } catch (e) { console.log(`   ⚠️  keys-cache: ${e.message}`); }

    const purged = await purge(purgeUrls);
    console.log(`   🧹 purge: ${purged} zapisa`);
    if (bundleIds.length) {
        // episode.json mora vidjeti nove datoteke (KORAK 12.7) — inače ih ekran epizode ne zna
        const r = spawnSync(process.execPath, [path.join(ROOT, "build_episode_bundle.js"), "--video-id", bundleIds.join(",")], { encoding: "utf8", stdio: "inherit" });
        if (r.status !== 0) console.log("   ⚠️  build_episode_bundle.js nije prošao — idući nightly ga ponavlja");
    }
    return { ok: bundleIds.length };
}

async function main() {
    console.log(`🎬 render_reels.js — top ${TOP}${ONLY_VIDEO ? `, video=${ONLY_VIDEO}` : `, since-days=${SINCE_DAYS}`}` +
        `${RENDER ? "" : ", samo objava"}${PUBLISH ? "" : ", bez objave"}${DRY_RUN ? ", DRY RUN" : ""}`);
    const eps = listEpisodes();
    let failed = 0;
    if (RENDER) failed += renderPhase(eps).failed;
    if (PUBLISH) await publishPhase(eps);
    if (failed) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((e) => { console.error(`❌ ${e.stack || e.message}`); process.exit(1); });
}

module.exports = { renderFingerprint, reelWords, loadBrand };
