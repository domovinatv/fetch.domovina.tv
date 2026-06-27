#!/usr/bin/env node
/**
 * purge_beamly_video.js — CF CDN purge za matchane beamly video URL-ove.
 * Frontend je već keširao 404 za video_h264.mp4/thumbnail.png tih epizoda (CDN cache-ira
 * 404 4h), a upload_to_r2 NE auto-purge-a immutable uploade. Ova skripta purge-a
 * data/{id}/video_h264.mp4 + images/{id}/thumbnail.png + images/{id}/og-share.jpg
 * za sve _yt_matched===true epizode (subclub/launched). Verificiraj GET, ne HEAD.
 *
 *   node purge_beamly_video.js [--channel subclub,launched] [--video-id ID]
 */
const fs = require("fs");
const path = require("path");
(() => { const p = path.join(__dirname, ".env"); if (!fs.existsSync(p)) return;
    for (const l of fs.readFileSync(p, "utf-8").split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } })();

const args = process.argv.slice(2);
const getArg = (n, d = null) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : d; };
const OUTPUT_DIR = path.join(__dirname, "storage", "output");
const CHANNELS = (getArg("--channel") || "subclub,launched").split(",").map(s => s.trim());
const ONLY_VID = getArg("--video-id");
const CDN = "https://cdn.domovina.ai";
const TOKEN = process.env.DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE;
const ZONE_NAME = "domovina.ai";

function extractVideoId(name) { const m = name.match(/.*_yt_([A-Za-z0-9_-]{11})(?:[._]|$)/); return m ? m[1] : null; }

(async () => {
    if (!TOKEN) { console.error("❌ Nema DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE"); process.exit(1); }
    const ids = new Set();
    for (const ch of CHANNELS) {
        let entries; try { entries = fs.readdirSync(path.join(OUTPUT_DIR, ch)); } catch { continue; }
        for (const f of entries) {
            if (!f.endsWith(".info.json") || f.startsWith("._")) continue;
            const vid = extractVideoId(f.replace(/\.info\.json$/, ""));
            if (!vid || (ONLY_VID && vid !== ONLY_VID)) continue;
            try { if (JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, ch, f), "utf-8"))._yt_matched === true) ids.add(vid); } catch {}
        }
    }
    const urls = [];
    for (const id of ids) urls.push(`${CDN}/data/${id}/video_h264.mp4`, `${CDN}/images/${id}/thumbnail.png`, `${CDN}/images/${id}/og-share.jpg`);
    console.log(`🧹 Purge ${ids.size} epizoda × 3 = ${urls.length} URL-ova...`);

    const zr = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${ZONE_NAME}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const zone = (await zr.json()).result?.[0]?.id;
    if (!zone) { console.error("❌ Ne mogu razriješiti zone ID"); process.exit(1); }

    let ok = 0;
    for (let i = 0; i < urls.length; i += 30) {
        const batch = urls.slice(i, i + 30);
        const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
            method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ files: batch }) });
        const j = await r.json().catch(() => ({}));
        if (j.success) ok += batch.length; else console.error(`  ⚠️ batch ${i}: ${JSON.stringify(j.errors || j).slice(0, 150)}`);
    }
    console.log(`✅ Purgeano ${ok}/${urls.length} URL-ova.`);
})();
