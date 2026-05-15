#!/usr/bin/env node

/**
 * generate_og_image.js
 *
 * Generira social-sharing optimiziran og:image variant iz postojećih
 * thumbnail PNG-ova. WhatsApp odbija og:image > 600 KB, a YouTube
 * thumbnail PNG-ovi često idu i preko (~660 KB za 1280×720 na detaljnim
 * scenama).
 *
 * Input:  {channel}/{base}.png             (thumbnail, 1280×720 fetch.js output)
 * Output: {channel}/{base}.og-share.jpg    (1200×630 JPEG, ~80-250 KB)
 *
 * Source 1280×720 (16:9) → output 1200×630 (1.91:1 OG canonical) traži center-extent
 * crop ~6% s vrha i dna jer aspekt nije identičan. YT thumbnaili su obično
 * centrirani pa je gubitak prihvatljiv.
 *
 * Spec (usklađeno s downstream Cloudflare Worker-om koji preferira ovaj
 * file pa fallback na thumbnail.png):
 *   - JPEG, 1200×630 (OG canonical, FB/LinkedIn recommendation)
 *   - Quality 85 (sweet spot — perceptualno indistinguishable od PNG-a)
 *   - Chroma subsampling 4:2:0
 *   - Progressive (interlace JPEG) — brže perceived loading
 *   - sRGB colorspace
 *   - EXIF/ICC stripped
 *   - Target < 600 KB (WhatsApp hard limit)
 *
 * CDN key (postavlja upload_to_r2.js): images/{videoId}/og-share.jpg
 *
 * Implementacija: ImageMagick `magick` (ne ffmpeg) jer ffmpeg mjpeg encoder
 * ne podržava progressive JPEG, a ImageMagick je pouzdaniji za fino kontrolu
 * subsamplinga i metadata stripa.
 *
 * Idempotentno: preskače ako .og-share.jpg već postoji i nije stariji od .png.
 *
 * Primjer:
 *   node generate_og_image.js --input-dir storage/output
 *   node generate_og_image.js --input-dir storage/output --channel domovina_tv
 *   node generate_og_image.js --input-dir storage/output --dry-run
 *   node generate_og_image.js --input-dir storage/output --force       # regeneriraj sve
 *   node generate_og_image.js --input-dir storage/output --limit 10
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DEFAULT_INPUT_DIR = path.join(__dirname, "storage", "output");

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const JPEG_QUALITY = 85;
const HARD_MAX_BYTES = 600 * 1024;  // WhatsApp limit

function getArg(name) {
    const idx = process.argv.indexOf(name);
    return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

function hasFlag(name) {
    return process.argv.includes(name);
}

function ts() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(emoji, msg) {
    console.log(`   ${emoji} [${ts()}] ${msg}`);
}

function humanSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function runMagick(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn("magick", args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`magick exit ${code}: ${stderr.slice(-500)}`));
        });
        proc.on("error", reject);
    });
}

/**
 * Generira 1200×630 progressive JPEG, q=85, 4:2:0, sRGB, no metadata.
 *
 * Referentna komanda (cover-crop iz 16:9 source-a na 1.91:1 OG canonical):
 *   magick {input} -resize 1200x630^ -gravity center -extent 1200x630 \
 *          -quality 85 -sampling-factor 4:2:0 -strip \
 *          -interlace JPEG -colorspace sRGB {output}
 *
 * `-resize 1200x630^` = cover (skalira do popunjavanja oba ruba),
 * `-gravity center -extent 1200x630` = center-crop na točno 1200×630.
 * Za 16:9 ulaz (1280×720): scale → 1200×675, crop top/bottom po 22.5 px → 1200×630.
 */
async function generateOgVariant(pngPath, jpgPath) {
    const args = [
        pngPath,
        "-resize", `${OG_WIDTH}x${OG_HEIGHT}^`,
        "-gravity", "center",
        "-extent", `${OG_WIDTH}x${OG_HEIGHT}`,
        "-quality", String(JPEG_QUALITY),
        "-sampling-factor", "4:2:0",
        "-strip",
        "-interlace", "JPEG",
        "-colorspace", "sRGB",
        jpgPath,
    ];
    await runMagick(args);
}

function shouldRegenerate(pngPath, jpgPath, force) {
    if (force) return true;
    if (!fs.existsSync(jpgPath)) return true;
    try {
        const pngMtime = fs.statSync(pngPath).mtimeMs;
        const jpgMtime = fs.statSync(jpgPath).mtimeMs;
        return jpgMtime < pngMtime;
    } catch {
        return true;
    }
}

function discoverThumbnails(channelDir) {
    const result = [];
    let entries;
    try { entries = fs.readdirSync(channelDir); } catch { return result; }
    for (const filename of entries) {
        if (filename.startsWith("._")) continue;
        if (!filename.endsWith(".png")) continue;
        // Mora imati _yt_ pattern (znači da je thumbnail za video, ne screenshot)
        if (!filename.includes("_yt_")) continue;
        const pngPath = path.join(channelDir, filename);
        let stat;
        try { stat = fs.statSync(pngPath); } catch { continue; }
        if (!stat.isFile()) continue;
        result.push({
            pngPath,
            jpgPath: pngPath.replace(/\.png$/, ".og-share.jpg"),
            base: filename.replace(/\.png$/, ""),
        });
    }
    return result;
}

function discoverChannels(inputDir, channelFilter) {
    let entries;
    try { entries = fs.readdirSync(inputDir, { withFileTypes: true }); } catch { return []; }
    const channels = [];
    for (const entry of entries) {
        // Symlinks su channel dirs na drugim diskovima (storage.conf)
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
        if (channelFilter && entry.name !== channelFilter) continue;
        channels.push({ name: entry.name, dir: path.join(inputDir, entry.name) });
    }
    return channels;
}

async function main() {
    const inputDir = getArg("--input-dir") || DEFAULT_INPUT_DIR;
    const channelFilter = getArg("--channel");
    const limitArg = getArg("--limit");
    const limit = limitArg ? parseInt(limitArg, 10) : null;
    const dryRun = hasFlag("--dry-run");
    const force = hasFlag("--force");

    console.log("");
    log("🖼️ ", `OG-share generator — ${OG_WIDTH}×${OG_HEIGHT} progressive JPEG q=${JPEG_QUALITY}, 4:2:0, sRGB, stripped`);
    log("📂", `Input: ${inputDir}`);
    if (channelFilter) log("🔎", `Channel filter: ${channelFilter}`);
    if (dryRun) log("🧪", "DRY RUN — neće pisati datoteke");
    if (force) log("♻️ ", "Force regeneracija svih .og-share.jpg");
    console.log("");

    if (!fs.existsSync(inputDir)) {
        console.error(`❌ Input dir ne postoji: ${inputDir}`);
        process.exit(1);
    }

    const channels = discoverChannels(inputDir, channelFilter);
    if (channels.length === 0) {
        console.error(`❌ Nema kanala u ${inputDir}${channelFilter ? ` (filter: ${channelFilter})` : ""}`);
        process.exit(1);
    }

    let totalCandidates = 0;
    let totalGenerated = 0;
    let totalSkipped = 0;
    let totalOversized = 0;
    let totalErrors = 0;
    let processed = 0;

    for (const channel of channels) {
        const thumbs = discoverThumbnails(channel.dir);
        if (thumbs.length === 0) continue;

        log("📺", `${channel.name} — ${thumbs.length} thumbnail(a)`);

        for (const thumb of thumbs) {
            if (limit !== null && processed >= limit) break;
            totalCandidates++;

            if (!shouldRegenerate(thumb.pngPath, thumb.jpgPath, force)) {
                totalSkipped++;
                continue;
            }

            processed++;
            const srcSize = humanSize(fs.statSync(thumb.pngPath).size);

            if (dryRun) {
                log("🧪", `[DRY] ${thumb.base}.png (${srcSize}) → .og-share.jpg`);
                continue;
            }

            try {
                await generateOgVariant(thumb.pngPath, thumb.jpgPath);
                const size = fs.statSync(thumb.jpgPath).size;
                if (size <= HARD_MAX_BYTES) {
                    log("✅", `${thumb.base}.og-share.jpg → ${humanSize(size)}`);
                    totalGenerated++;
                } else {
                    log("⚠️ ", `${thumb.base}.og-share.jpg → ${humanSize(size)} (IZNAD WhatsApp 600 KB limita)`);
                    totalOversized++;
                    totalGenerated++;
                }
            } catch (err) {
                log("❌", `${thumb.base}: ${err.message}`);
                totalErrors++;
            }
        }

        if (limit !== null && processed >= limit) {
            log("🛑", `Limit ${limit} dosegnut`);
            break;
        }
    }

    console.log("");
    log("📊", `Kandidata: ${totalCandidates} | Generirano: ${totalGenerated} | Preskočeno: ${totalSkipped} | Iznad 600 KB: ${totalOversized} | Greške: ${totalErrors}`);
    console.log("");
}

main().catch((err) => {
    console.error(`❌ Fatalna greška: ${err.message}`);
    process.exit(1);
});
