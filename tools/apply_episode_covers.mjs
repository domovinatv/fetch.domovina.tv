#!/usr/bin/env node
/*
 * apply_episode_covers.mjs — cover po epizodi za audio-only kanale (ingest_rss.mjs).
 *
 * RSS daje isti cover za sve epizode (logo podcasta). Autori često za svaku epizodu
 * objave Instagram karticu s gostom i temom — ta slika je puno bolji thumbnail.
 * Mapiranje epizoda → objava je u automatic/podcasts/{slug}-covers.json:
 *   { "covers": { "<rss id>": { "episode": 54, "instagram": "DVwFKY5CI3j", "match": "…" } } }
 *
 * Za svaku epizodu s mapiranjem:
 *   1. skine PRVU sliku objave (gallery-dl + Brave kolačići, profil Default) u
 *      storage/covers/{slug}/{shortcode}.jpg (keš; ne skida ponovno)
 *   2. složi {base}.png 1280×720 (cover u sredini, zamućena pozadina) — isti ugovor
 *      kao ingest_rss.mjs, pa KORAK 9.5 (og-share), 9.7 (WebP) i 12 (thumbnail.png)
 *      rade nepromijenjeno; og-share se sam regenerira jer je .png noviji.
 *
 * ⚠️ images/{id}/thumbnail.png na CDN-u je IMMUTABLE (kešira se godinu dana): cover
 * primijeni PRIJE prvog uploada epizode. Za već objavljenu epizodu treba force
 * upload + CF purge (vidi memory upload_r2_data_dir_immutable_force_pattern).
 *
 * Mapiranje se radi jednom, u browseru (Instagram feed API odbija skripte, a grid
 * se puni samo pravim scrollom): opis objave = početak RSS opisa, inače prezime
 * gosta. Postupak: docs/2026-10-05-logopedija-discovery-i-dijalog.md §6.7.
 *
 * Uporaba:
 *   node tools/apply_episode_covers.mjs --channel dijalog [--dry-run] [--force]
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const getArg = (n) => { const i = argv.indexOf(n); return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null; };
const CHANNEL = getArg("--channel");
const DRY_RUN = argv.includes("--dry-run");
const FORCE = argv.includes("--force");
if (!CHANNEL) { console.error("Treba --channel <slug>"); process.exit(2); }

const map = JSON.parse(readFileSync(join(ROOT, "automatic", "podcasts", `${CHANNEL}-covers.json`), "utf8")).covers || {};
const outDir = join(ROOT, "storage", "output", CHANNEL);
const cacheDir = join(ROOT, "storage", "covers", CHANNEL);
mkdirSync(cacheDir, { recursive: true });

// ID iz imena datoteke: zadnji `_yt_` (naslovi znaju sadržavati "_yt_").
const bases = new Map();
for (const f of readdirSync(outDir)) {
  if (f.startsWith("._") || !f.endsWith(".info.json")) continue;
  const base = f.slice(0, -".info.json".length);
  const id = base.slice(base.lastIndexOf("_yt_") + 4);
  bases.set(id, base);
}

// Starije objave Instagram servira kao .webp, novije kao .jpg; video-prva objava
// (reel) dođe kao .mp4 i nije upotrebljiva kao cover.
const IMG = /\.(jpe?g|webp|png)$/i;
const cached = (code) => readdirSync(cacheDir).find((f) => f.startsWith(`${code}.`) && IMG.test(f));

function fetchCover(code) {
  const hit = cached(code);
  if (hit) return join(cacheDir, hit);
  const r = spawnSync("gallery-dl", ["--cookies-from-browser", "brave", "-D", cacheDir, "-f", "{shortcode}.{extension}",
    "--range", "1", `https://www.instagram.com/p/${code}/`], { encoding: "utf8" });
  const got = cached(code);
  if (!got) throw new Error(`gallery-dl nije dao sliku za ${code} (exit ${r.status}): ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
  return join(cacheDir, got);
}

function toThumbnail(src, pngPath) {
  const tmp = `${pngPath}.part.png`;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-filter_complex",
    "[0]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,boxblur=30:2,eq=brightness=-0.15[bg];" +
    "[0]scale=-2:720[fg];[bg][fg]overlay=(W-w)/2:0", "-frames:v", "1", tmp], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg exit ${r.status}: ${(r.stderr || "").slice(0, 200)}`);
  renameSync(tmp, pngPath);
}

const stats = { applied: 0, skipped: 0, missing: 0, failed: 0 };
for (const [id, c] of Object.entries(map)) {
  const base = bases.get(id);
  if (!base) { stats.missing++; console.log(`  ? ${id} (ep ${c.episode}) nije na disku`); continue; }
  const png = join(outDir, `${base}.png`);
  const hit = cached(c.instagram);
  // Već primijenjen: .png noviji od keširane slike.
  if (!FORCE && hit && existsSync(png) && statSync(png).mtimeMs >= statSync(join(cacheDir, hit)).mtimeMs) { stats.skipped++; continue; }
  if (DRY_RUN) { console.log(`  [dry] ep ${c.episode} ${id} ← ${c.instagram}`); stats.applied++; continue; }
  try {
    toThumbnail(fetchCover(c.instagram), png);
    stats.applied++;
    console.log(`  ✓ ep ${c.episode} ${id} ← ${c.instagram}`);
  } catch (e) {
    stats.failed++;
    console.log(`  ✗ ep ${c.episode} ${id}: ${e.message}`);
  }
}
console.log(`covers ${CHANNEL}: primijenjeno ${stats.applied}, preskočeno ${stats.skipped}, nema na disku ${stats.missing}, grešaka ${stats.failed}`);
if (stats.failed) process.exit(1);
