#!/usr/bin/env node

/**
 * generate_webp_thumbs.js
 *
 * Generira responsive WebP varijante thumbnaila za in-app prikaz u Flutter appu.
 *
 * Zašto: `images/{id}/thumbnail.png` je full-res PNG (1280×720, tipično ~800 KB).
 * PNG je bezgubitni format za grafiku s plohama boje — za fotografski screenshot
 * iz videa je to najgori izbor. Lista od 20 epizoda povlači ~16 MB. Iste slike
 * kao WebP q80 @320px su ~13 KB (mjereno 61× manje), pa ista lista padne na
 * ~0.3 MB.
 *
 * Ovo NIJE on-the-fly resizing servis (weserv/imgproxy/Cloudflare Images).
 * Katalog je fiksan, slike su immutable, a trebaju nam 3 fiksne dimenzije —
 * pa se varijante generiraju jednom, unaprijed, i serviraju kao obični statični
 * fajlovi s R2 kroz cdn.domovina.ai. Nula servera u request pathu.
 *
 * Isti obrazac koji pipeline već koristi za `video.mp4` + `video_h264.mp4`
 * (unaprijed generirana varijanta uz original, klijent bira uz fallback).
 *
 * Varijante (q80, `-resize {w}x` = proporcionalno, bez upscalea):
 *   {base}.thumb-320.webp   → images/{id}/thumb-320.webp    lista        ~13 KB
 *   {base}.thumb-640.webp   → images/{id}/thumb-640.webp    grid/kartice ~33 KB
 *   {base}.thumb-1280.webp  → images/{id}/thumb-1280.webp   fullscreen   ~71 KB
 *
 * `thumbnail.png` se NE dira — ostaje kao original i kao fallback za klijente
 * koji varijante još nemaju (backfill je postupan).
 *
 * NAPOMENA o og-share.jpg: social sharing (`og:image`) NAMJERNO ostaje JPEG i
 * ovaj ga skript ne dira. Link-preview crawleri (Facebook/WhatsApp/LinkedIn/X)
 * ne dokumentiraju WebP podršku, a cijena neuspjeha je da se preview ne prikaže
 * uopće. Vidi `generate_og_image.js`.
 *
 * Implementacija: ImageMagick `magick` (isti alat i isti spawn-obrazac kao
 * `generate_og_image.js`).
 *
 * ── NAČINI POKRETANJA ────────────────────────────────────────────
 *
 *   1. Lokalni pipeline output (normalan tijek, uz postojeće artefakte):
 *      node generate_webp_thumbs.js --input-dir /path/to/output
 *      node generate_webp_thumbs.js --input-dir /path/to/output --channel domovina_tv
 *      node generate_webp_thumbs.js --input-dir /path/to/output --video-id H-p2Hl6x7I0
 *
 *   2. Backfill s CDN-a (za 3157 postojećih epizoda kojima lokalni izvor više
 *      ne postoji) — povlači `images/{id}/thumbnail.png` s cdn.domovina.ai u
 *      temp kanal `_webpbackfill/` i tamo generira varijante:
 *      node generate_webp_thumbs.js --from-cdn --all
 *      node generate_webp_thumbs.js --from-cdn --ids 3_jA9b-myNQ,4_yc9vSG4Jc
 *      node generate_webp_thumbs.js --from-cdn --all --skip-existing
 *
 *      Nakon toga upload ide kroz postojeći uploader:
 *      node upload_to_r2.js --input-dir storage/output --channel _webpbackfill --flutter-keys
 *
 *   3. Dry run / limit / paralelizam:
 *      node generate_webp_thumbs.js --from-cdn --all --dry-run
 *      node generate_webp_thumbs.js --from-cdn --all --limit 50 --concurrency 8
 *
 * Izvorni `.src.png` se briše nakon generiranja (3157 × ~900 KB = ~2.8 GB smeća);
 * `--keep-src` ga zadrži.
 *
 * Idempotentnost: varijanta se preskače ako već postoji i novija je od izvora.
 * `--force` regenerira. `--skip-existing` dodatno preskače ID-eve koji varijante
 * već imaju na CDN-u (HEAD request) — korisno za nastavak prekinutog backfilla.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ─── KONFIGURACIJA ───────────────────────────────────────────────

const CDN = "https://cdn.domovina.ai";
const BACKFILL_CHANNEL = "_webpbackfill";
const SCRIPT_DIR = __dirname;

/** Širine varijanti. Vrijednosti prate stvarne render-širine u Flutter appu:
 *  lista (~160dp), kartica/grid (~360dp), fullscreen (~720dp) — svaka ×2 za
 *  DPR 2.0 uređaje. */
const WIDTHS = [320, 640, 1280];

/** q80 je knee-point na ovom sadržaju: q90 udvostruči bajtove za razliku koja
 *  se na thumbnailu ne vidi, q70 počne vidljivo mrljati gradijente u pozadini. */
const WEBP_QUALITY = 80;

const DEFAULT_CONCURRENCY = 4;
const HTTP_TIMEOUT_MS = 60000;
const USER_AGENT = "domovina-webp-thumbs/1.0";

// ─── CLI ─────────────────────────────────────────────────────────

function getArg(name) {
    const idx = process.argv.indexOf(name);
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

function hasFlag(name) {
    return process.argv.includes(name);
}

function ts() {
    return new Date().toISOString().slice(11, 19);
}

function log(emoji, msg) {
    console.log(`[${ts()}] ${emoji} ${msg}`);
}

function humanSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ─── HTTP ────────────────────────────────────────────────────────

/** Cloudflare 403-a prazan/neobičan UA → uvijek šalji normalan UA
 *  (isti razlog i isti fix kao u backfill_og_sections_from_cdn.py). */
function httpGet(url, { binary = false } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(
            url,
            { headers: { "User-Agent": USER_AGENT }, timeout: HTTP_TIMEOUT_MS },
            (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return resolve(httpGet(res.headers.location, { binary }));
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
                }
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const buf = Buffer.concat(chunks);
                    resolve(binary ? buf : buf.toString("utf-8"));
                });
            }
        );
        req.on("timeout", () => req.destroy(new Error(`timeout — ${url}`)));
        req.on("error", reject);
    });
}

function httpExists(url) {
    return new Promise((resolve) => {
        const req = https.request(
            url,
            { method: "HEAD", headers: { "User-Agent": USER_AGENT }, timeout: 20000 },
            (res) => {
                res.resume();
                resolve(res.statusCode === 200);
            }
        );
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.on("error", () => resolve(false));
        req.end();
    });
}

// ─── IMAGEMAGICK ─────────────────────────────────────────────────

function hasMagick() {
    try {
        require("child_process").execSync("magick -version", { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

/**
 * `-resize {w}x`  → proporcionalno na širinu, visina se računa sama.
 * `>` suffix      → NIKAD ne upscalea; izvor uži od tražene širine ostaje kakav
 *                   jest (inače bismo dobili mutan 1280px iz 640px originala,
 *                   veći od izvora i lošiji).
 * `-strip`        → makni EXIF/ICC; na thumbnailu je to čisti balast.
 */
function magickWebp(srcPath, outPath, width, quality) {
    return new Promise((resolve, reject) => {
        const args = [
            srcPath,
            "-resize", `${width}x>`,
            "-strip",
            "-quality", String(quality),
            "-define", "webp:method=6",
            outPath,
        ];
        const proc = spawn("magick", args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (c) => { stderr += c.toString(); });
        proc.on("error", reject);
        proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`magick exit ${code}: ${stderr.slice(-500)}`));
        });
    });
}

// ─── PARALELIZAM ─────────────────────────────────────────────────

async function runConcurrent(tasks, concurrency) {
    const results = [];
    let cursor = 0;
    async function worker() {
        while (cursor < tasks.length) {
            const idx = cursor++;
            results[idx] = await tasks[idx]();
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
    );
    return results;
}

// ─── OTKRIVANJE IZVORA ───────────────────────────────────────────

function extractVideoIdFromFilename(filename) {
    const match = filename.match(/.*_yt_([a-zA-Z0-9_-]{11})(?:[._]|$)/);
    return match ? match[1] : null;
}

/** Skenira pipeline output i vraća {channel, base, videoId, pngPath} za svaki
 *  video koji ima `{base}.png`. Ista konvencija kao `discoverVideos` u
 *  upload_to_r2.js. */
function discoverLocal(inputDir, channelFilter, videoIdFilter) {
    const out = [];
    let channels;
    try {
        channels = fs.readdirSync(inputDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    } catch (e) {
        log("❌", `Ne mogu čitati --input-dir: ${e.message}`);
        return out;
    }

    for (const channel of channels) {
        if (channelFilter && channel !== channelFilter) continue;
        const channelDir = path.join(inputDir, channel);

        let files;
        try {
            files = fs.readdirSync(channelDir);
        } catch {
            continue;
        }

        for (const f of files) {
            if (f.startsWith("._")) continue;
            if (!f.endsWith(".png")) continue;

            const base = f.slice(0, -4);
            // Samo pravi thumbnail `{base}.png` — ne screenshotovi, ne `.src.png`.
            if (!/_yt_[a-zA-Z0-9_-]{11}$/.test(base)) continue;

            const videoId = extractVideoIdFromFilename(base);
            if (!videoId) continue;
            if (videoIdFilter && videoId !== videoIdFilter) continue;

            out.push({ channel, base, videoId, pngPath: path.join(channelDir, f) });
        }
    }

    return out.sort((a, b) => a.videoId.localeCompare(b.videoId));
}

/** Povuče sve video ID-eve iz CDN channels indexa (48 kanala → ~3157 videa). */
async function discoverCdnIds() {
    log("🌐", "Dohvaćam listu kanala s CDN-a…");
    const index = JSON.parse(await httpGet(`${CDN}/channels/data/index.json`));
    const channels = index.channels || [];
    log("📚", `${channels.length} kanala`);

    const ids = [];
    const seen = new Set();

    const tasks = channels.map((ch) => async () => {
        try {
            const data = JSON.parse(await httpGet(`${CDN}/channels/data/${ch.id}.json`));
            return { channel: ch.id, videos: data.videos || [] };
        } catch (e) {
            log("⚠️", `kanal ${ch.id}: ${e.message}`);
            return { channel: ch.id, videos: [] };
        }
    });

    const perChannel = await runConcurrent(tasks, 8);
    for (const { channel, videos } of perChannel) {
        for (const v of videos) {
            if (!v.id || seen.has(v.id)) continue;
            seen.add(v.id);
            ids.push({ videoId: v.id, channel });
        }
    }

    log("🎬", `${ids.length} jedinstvenih epizoda`);
    return ids;
}

// ─── OBRADA ──────────────────────────────────────────────────────

/** Generira varijante iz `srcPath` u `outDir` pod imenom `{base}.thumb-{w}.webp`. */
async function generateVariants(srcPath, outDir, base, { force, dryRun }) {
    const res = { generated: 0, skipped: 0, bytes: 0, srcBytes: 0 };

    let srcStat;
    try {
        srcStat = fs.statSync(srcPath);
    } catch (e) {
        throw new Error(`izvor nedostupan: ${e.message}`);
    }
    res.srcBytes = srcStat.size;

    for (const w of WIDTHS) {
        const outPath = path.join(outDir, `${base}.thumb-${w}.webp`);

        if (!force && fs.existsSync(outPath)) {
            const outStat = fs.statSync(outPath);
            if (outStat.mtimeMs >= srcStat.mtimeMs && outStat.size > 0) {
                res.skipped++;
                res.bytes += outStat.size;
                continue;
            }
        }

        if (dryRun) {
            res.generated++;
            continue;
        }

        await magickWebp(srcPath, outPath, w, WEBP_QUALITY);
        res.generated++;
        res.bytes += fs.statSync(outPath).size;
    }

    return res;
}

async function processCdnVideo(videoId, outDir, opts) {
    const base = `webp_yt_${videoId}`;
    // `.src.png` (a NE `{base}.png`) — uploader collecta samo točan `{base}.png`,
    // pa se izvorni thumbnail neće nehotice re-uploadati preko originala.
    const srcPath = path.join(outDir, `${base}.src.png`);

    // Sve varijante već lokalno → nema potrebe ni skidati izvor. Ovo je i resume
    // put nakon što je `.src.png` obrisan (default), jer bez izvora
    // generateVariants ne bi mogao usporediti mtime.
    const allPresent = WIDTHS.every((w) => {
        const p = path.join(outDir, `${base}.thumb-${w}.webp`);
        try { return fs.statSync(p).size > 0; } catch { return false; }
    });
    if (allPresent && !opts.force) {
        const bytes = WIDTHS.reduce(
            (s, w) => s + fs.statSync(path.join(outDir, `${base}.thumb-${w}.webp`)).size, 0);
        return { videoId, status: "ok", generated: 0, skipped: WIDTHS.length, bytes, srcBytes: 0 };
    }

    if (opts.skipExisting) {
        const exists = await httpExists(`${CDN}/images/${videoId}/thumb-${WIDTHS[0]}.webp`);
        if (exists) return { videoId, status: "already-on-cdn", generated: 0, skipped: 0, bytes: 0, srcBytes: 0 };
    }

    if (!fs.existsSync(srcPath) || fs.statSync(srcPath).size === 0) {
        if (opts.dryRun) {
            return { videoId, status: "would-fetch", generated: WIDTHS.length, skipped: 0, bytes: 0, srcBytes: 0 };
        }
        let buf;
        try {
            buf = await httpGet(`${CDN}/images/${videoId}/thumbnail.png`, { binary: true });
        } catch (e) {
            // 404 = AUDIO-ONLY epizoda (beamly/transistor kanali bez YouTube videa,
            // `_yt_matched === false`). Nemaju thumbnail i nikad ga neće imati —
            // app za njih ionako renderira cover fallback. Nije greška.
            if (String(e.message).includes("HTTP 404")) {
                return { videoId, status: "no-thumbnail", generated: 0, skipped: 0, bytes: 0, srcBytes: 0 };
            }
            throw e;
        }
        fs.writeFileSync(srcPath, buf);
    }

    const r = await generateVariants(srcPath, outDir, base, opts);

    // Izvor je samo međukorak — 3157 × ~900 KB bi ostavilo ~2.8 GB smeća.
    // `--keep-src` ga zadrži (debug / ponovna generacija s drugom kvalitetom).
    if (!opts.dryRun && !opts.keepSrc) {
        try { fs.unlinkSync(srcPath); } catch { /* nebitno */ }
    }

    return { videoId, status: "ok", ...r };
}

async function processLocalVideo(entry, opts) {
    const outDir = path.dirname(entry.pngPath);
    const r = await generateVariants(entry.pngPath, outDir, entry.base, opts);
    return { videoId: entry.videoId, status: "ok", ...r };
}

// ─── MAIN ────────────────────────────────────────────────────────

async function main() {
    const fromCdn = hasFlag("--from-cdn");
    const all = hasFlag("--all");
    const dryRun = hasFlag("--dry-run");
    const force = hasFlag("--force");
    const skipExisting = hasFlag("--skip-existing");
    const keepSrc = hasFlag("--keep-src");
    const inputDir = getArg("--input-dir");
    const channelFilter = getArg("--channel");
    const videoIdFilter = getArg("--video-id");
    const idsArg = getArg("--ids");
    const idsFile = getArg("--ids-file");
    const limit = parseInt(getArg("--limit") || "0", 10);
    const concurrency = parseInt(getArg("--concurrency") || String(DEFAULT_CONCURRENCY), 10);

    if (!hasMagick()) {
        log("❌", "ImageMagick `magick` nije dostupan u PATH-u. brew install imagemagick");
        process.exit(1);
    }

    if (!fromCdn && !inputDir) {
        log("❌", "Treba --input-dir (lokalni izvor) ili --from-cdn (backfill s CDN-a).");
        log("ℹ️", "Vidi header ovog fajla za primjere.");
        process.exit(1);
    }

    log("🖼️", `WebP varijante: ${WIDTHS.join("px, ")}px @ q${WEBP_QUALITY}`);
    if (dryRun) log("🧪", "DRY RUN — ništa se ne piše");

    const opts = { force, dryRun, skipExisting, keepSrc };
    let tasks = [];
    let label = "";

    if (fromCdn) {
        const outDir = path.join(SCRIPT_DIR, "storage", "output", BACKFILL_CHANNEL);
        if (!dryRun) fs.mkdirSync(outDir, { recursive: true });

        let ids = [];
        if (idsArg) {
            ids = idsArg.split(",").map((s) => s.trim()).filter(Boolean).map((videoId) => ({ videoId }));
        } else if (idsFile) {
            ids = fs.readFileSync(idsFile, "utf-8")
                .split("\n").map((s) => s.trim()).filter(Boolean)
                .map((videoId) => ({ videoId }));
        } else if (all) {
            ids = await discoverCdnIds();
        } else {
            log("❌", "--from-cdn traži --all, --ids ili --ids-file.");
            process.exit(1);
        }

        if (limit > 0) ids = ids.slice(0, limit);
        label = `${ids.length} epizoda s CDN-a → ${path.relative(SCRIPT_DIR, outDir)}/`;
        tasks = ids.map(({ videoId }) => async () => {
            try {
                return await processCdnVideo(videoId, outDir, opts);
            } catch (e) {
                return { videoId, status: `error: ${e.message}`, generated: 0, skipped: 0, bytes: 0, srcBytes: 0 };
            }
        });
    } else {
        let entries = discoverLocal(inputDir, channelFilter, videoIdFilter);
        if (limit > 0) entries = entries.slice(0, limit);
        label = `${entries.length} epizoda iz ${inputDir}`;
        tasks = entries.map((entry) => async () => {
            try {
                return await processLocalVideo(entry, opts);
            } catch (e) {
                return { videoId: entry.videoId, status: `error: ${e.message}`, generated: 0, skipped: 0, bytes: 0, srcBytes: 0 };
            }
        });
    }

    if (tasks.length === 0) {
        log("🤷", "Nema ničega za obraditi.");
        return;
    }

    log("🚀", `${label} — concurrency ${concurrency}`);

    let done = 0;
    const total = tasks.length;
    const wrapped = tasks.map((t) => async () => {
        const r = await t();
        done++;
        if (done % 25 === 0 || done === total) {
            log("⏳", `${done}/${total}`);
        }
        if (r.status.startsWith("error")) {
            log("⚠️", `${r.videoId}: ${r.status}`);
        }
        return r;
    });

    const started = Date.now();
    const results = await runConcurrent(wrapped, concurrency);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    const ok = results.filter((r) => r.status === "ok");
    const errors = results.filter((r) => r.status.startsWith("error"));
    const alreadyCdn = results.filter((r) => r.status === "already-on-cdn");
    const noThumb = results.filter((r) => r.status === "no-thumbnail");
    const generated = results.reduce((s, r) => s + r.generated, 0);
    const skipped = results.reduce((s, r) => s + r.skipped, 0);
    const outBytes = results.reduce((s, r) => s + r.bytes, 0);
    const srcBytes = ok.reduce((s, r) => s + r.srcBytes, 0);

    console.log("");
    log("📊", "─────────── REZULTAT ───────────");
    log("✅", `obrađeno:        ${ok.length}`);
    if (alreadyCdn.length) log("⏭️", `već na CDN-u:    ${alreadyCdn.length}`);
    if (noThumb.length) log("🎧", `bez thumbnaila:  ${noThumb.length} (audio-only epizode — očekivano)`);
    if (errors.length) log("❌", `greške:          ${errors.length}`);
    log("🆕", `generirano:      ${generated} varijanti`);
    if (skipped) log("♻️", `preskočeno:      ${skipped} (već postoje)`);
    log("💾", `izvor (PNG):     ${humanSize(srcBytes)}`);
    log("💾", `varijante:       ${humanSize(outBytes)}`);
    if (srcBytes > 0 && outBytes > 0) {
        log("📉", `sve 3 varijante zajedno su ${(srcBytes / outBytes).toFixed(1)}× manje od samih originala`);
    }
    log("⏱️", `${elapsed}s`);

    if (errors.length) {
        console.log("");
        log("❌", "Neuspjeli ID-evi (za --ids retry):");
        console.log(errors.map((e) => e.videoId).join(","));
    }

    if (fromCdn && !dryRun && generated > 0) {
        console.log("");
        log("➡️", "Sljedeći korak — upload na R2:");
        console.log(`   node upload_to_r2.js --input-dir storage/output --channel ${BACKFILL_CHANNEL} --flutter-keys`);
    }
}

main().catch((e) => {
    log("💥", e.stack || e.message);
    process.exit(1);
});
