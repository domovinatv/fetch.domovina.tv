#!/usr/bin/env node
/*
 * ingest_rss.mjs
 *
 * Audio-only podcasti koji NISU na YouTubeu (Spotify for Podcasters / anchor.fm,
 * Apple, bilo koji javni RSS) → fetch.domovina.tv pipeline, preko RSS feeda.
 *
 * Isti izlazni ugovor kao ingest_beamly.mjs (Launched, Sub Club), samo je izvor
 * kataloga RSS umjesto Beamly JSON-a. Za svaku epizodu:
 *   storage/output/{slug}/{YYYYMMDD}_{naslov}_yt_{id}.mp3
 *                                                     .info.json   (_yt_matched:false)
 *                                                     .description
 *                                                     .png         (cover → 16:9 thumbnail)
 * + automatic/podcasts/{slug}-lista.txt, -lista-state.json (completed[]), -channel.json.
 * Sve ostalo (convert_to_wav → Canary → diarizacija → sažetak → članak → EPUB → R2,
 * KORAK 12.6 audio.mp3) radi nepromijenjeno; `_yt_matched:false` je marker na kojem
 * screenshot, EPUB, upload_audio_only i count_progress već znaju za audio-only.
 *
 * Zašto ne yt-dlp: Spotify je DRM (yt-dlp ga izričito odbija), a RSS <enclosure> je
 * direktni link na istu datoteku — nema kolačića, anti-bota ni --via-iphone.
 *
 * ID: prvih 11 hex znakova sha1(<guid>) — stabilno, determinističko, 11 znakova kao
 * YouTube ID (extractVideoId i convert_to_wav ga vade iz lista.txt URL-a youtu.be/{id}).
 * Dedup ide po guidu, ne po naslovu (naslovi se znaju ispraviti nakon objave).
 *
 * Audio: pipeline svugdje očekuje `.mp3` (convert_to_wav, upload_audio_only →
 * audio/mpeg). Anchor daje AAC `.m4a` → ffmpeg u mp3. Izvor koji je već mp3 ide bez
 * pretvorbe.
 *
 * Uporaba:
 *   node ingest_rss.mjs                         # svi izvori, sve nove epizode
 *   node ingest_rss.mjs --source dijalog        # samo jedan
 *   node ingest_rss.mjs --limit 2 --dry-run     # proba, bez pisanja
 *   node ingest_rss.mjs --oldest-first          # backlog kronološki (default: najnovije prvo)
 *
 * Dokumentacija: docs/2026-10-05-logopedija-discovery-i-dijalog.md §6
 */

import { mkdir, writeFile, readFile, rename, access, appendFile, unlink, utimes } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- izvori ----------------------------------------------------------------
// Novi audio-only podcast = jedan redak ovdje + storage.conf + registry unos.
// slug = ime direktorija u storage/output/ i registry slug (domovina.ai/c/{slug}).
const SOURCES = [
  {
    slug: "dijalog",
    display: "DijaLOG - Logopedski podcast",
    rss: "https://anchor.fm/s/10b00353c/podcast/rss",
    homepage: "https://open.spotify.com/show/1uLNzddcxKWG5Qz8LDWXD6",
    // Nulta epizoda, najave sezona i blooperi su 1–3 min — nisu epizode.
    min_duration_sec: 600,
  },
];

// ---- CLI -------------------------------------------------------------------
const argv = process.argv.slice(2);
const getFlag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const ONLY_SOURCE = getFlag("source");
const LIMIT = getFlag("limit") ? parseInt(getFlag("limit"), 10) : Infinity;
const DRY_RUN = hasFlag("dry-run");
const OLDEST_FIRST = hasFlag("oldest-first");

const OUTPUT_ROOT = join(HERE, "storage", "output");
const PODCASTS_DIR = join(HERE, "automatic", "podcasts");

// ---- pomoćno ---------------------------------------------------------------
const DIACRITICS = { č: "c", ć: "c", ž: "z", š: "s", đ: "d" };

// Ista logika kao fetch.js:sanitizeDescription / ingest_beamly.mjs:sanitizeTitle.
function sanitizeTitle(str) {
  if (!str) return "nepoznat_naslov";
  str = str.toLowerCase();
  str = str.replace(/[čćžšđ]/g, (c) => DIACRITICS[c] || c);
  str = str.replace(/[^a-z0-9]/g, "_");
  str = str.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return str || "nepoznat_naslov";
}

function ymd(d) {
  if (Number.isNaN(d.getTime())) return "00000000";
  return (
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const rssId = (guid) => createHash("sha1").update(String(guid)).digest("hex").slice(0, 11);

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadState(stateFile) {
  try {
    const s = JSON.parse(await readFile(stateFile, "utf8"));
    return {
      completed: Array.isArray(s.completed) ? s.completed : [],
      failed: Array.isArray(s.failed) ? s.failed : [],
      private: Array.isArray(s.private) ? s.private : [],
      archived: Array.isArray(s.archived) ? s.archived : [],
    };
  } catch {
    return { completed: [], failed: [], private: [], archived: [] };
  }
}

async function saveState(stateFile, state) {
  const tmp = `${stateFile}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n");
  await rename(tmp, stateFile);
}

async function downloadTo(url, destPath) {
  // Anchor enclosure je redirect (anchor.fm/…/play/… → CloudFront).
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body) throw new Error(`empty body for ${url}`);
  const tmp = `${destPath}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, destPath);
}

// ---- RSS parsiranje (bez vanjskih ovisnosti) --------------------------------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES[e]);
}
function text(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!m) return "";
  const v = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  return cdata ? cdata[1] : decodeEntities(v);
}
function attr(xml, tag, name) {
  const m = new RegExp(`<${tag}\\s[^>]*?${name}="([^"]*)"`).exec(xml);
  return m ? decodeEntities(m[1]) : "";
}
// Opis epizode je HTML — u .description i info.json ide čisti tekst s prijelomima.
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|div|h\d)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function durationSec(s) {
  if (!s) return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return s.split(":").map(Number).reduce((a, b) => a * 60 + b, 0) || 0;
}

function parseFeed(xml) {
  const head = xml.split("<item>")[0];
  const channel = {
    title: text(head, "title"),
    description: htmlToText(text(head, "description")),
    link: text(head, "link"),
    image: attr(head, "itunes:image", "href"),
    author: text(head, "itunes:author"),
  };
  const items = xml
    .split("<item>")
    .slice(1)
    .map((raw) => {
      const it = raw.split("</item>")[0];
      const guid = text(it, "guid");
      const enclosure = attr(it, "enclosure", "url");
      return {
        guid,
        title: text(it, "title"),
        description: htmlToText(text(it, "description")),
        link: text(it, "link"),
        pubDate: new Date(text(it, "pubDate")),
        duration: durationSec(text(it, "itunes:duration")),
        image: attr(it, "itunes:image", "href"),
        enclosure,
        enclosureType: attr(it, "enclosure", "type"),
        episode: text(it, "itunes:episode") || null,
        season: text(it, "itunes:season") || null,
      };
    })
    .filter((e) => e.guid && e.enclosure);
  return { channel, items };
}

// ---- artefakti ---------------------------------------------------------------
function buildInfoJson({ ep, id, source, channel }) {
  return {
    id,
    title: ep.title,
    description: ep.description,
    upload_date: ymd(ep.pubDate),
    timestamp: Math.floor(ep.pubDate.getTime() / 1000) || 0,
    duration: ep.duration,
    view_count: 0,
    like_count: 0,
    uploader: source.display,
    channel: source.display,
    channel_id: `rss_${source.slug}`,
    channel_url: source.homepage,
    webpage_url: ep.link || source.homepage,
    thumbnail: ep.image || channel.image || "",
    // Trag porijekla — pipeline ih ignorira osim _yt_matched (audio-only marker).
    _source: "rss",
    _rss_feed: source.rss,
    _rss_guid: ep.guid,
    _episode_number: ep.episode,
    _season: ep.season,
    _sound_link: ep.enclosure,
    _yt_matched: false,
  };
}

function buildChannelJson(source, channel) {
  return {
    id: `rss_${source.slug}`,
    channel: source.display,
    channel_id: `rss_${source.slug}`,
    title: `${source.display} - Episodes`,
    availability: null,
    channel_follower_count: 0,
    description: channel.description || "",
    tags: [],
    thumbnails: channel.image ? [{ url: channel.image, id: "0" }] : [],
    _source: "rss",
    _rss_feed: source.rss,
    _homepage: source.homepage,
  };
}

// m4a/aac → mp3. Već-mp3 izvor samo preimenuj.
function toMp3(srcPath, mp3Path, enclosureType) {
  if (/mpeg|mp3/i.test(enclosureType) || /\.mp3$/i.test(srcPath)) return rename(srcPath, mp3Path);
  const tmp = `${mp3Path}.part.mp3`;
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-i", srcPath, "-vn", "-c:a", "libmp3lame", "-b:a", "128k", tmp],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`ffmpeg exit ${r.status}: ${(r.stderr || "").slice(0, 300)}`);
  return rename(tmp, mp3Path).then(() => unlink(srcPath));
}

// Thumbnail ugovor pipelinea je `{base}.png` 16:9 (yt-dlp --convert-thumbnails png):
// iz njega KORAK 9.5 radi og-share, KORAK 12 ga diže kao images/{id}/thumbnail.png, a
// 9.7 iz toga WebP varijante. Podcast cover je kvadrat → u sredinu 1280×720 platna,
// sa zamućenom verzijom istog covera kao pozadinom (bez crnih traka, bez rezanja teksta).
async function coverToThumbnail(url, srcPath, pngPath) {
  await downloadTo(url, srcPath);
  const tmp = `${pngPath}.part.png`;
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-i", srcPath, "-filter_complex",
      "[0]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,boxblur=30:2,eq=brightness=-0.15[bg];" +
      "[0]scale=-2:720[fg];[bg][fg]overlay=(W-w)/2:0", "-frames:v", "1", tmp],
    { encoding: "utf8" },
  );
  await unlink(srcPath).catch(() => {});
  if (r.status !== 0) throw new Error(`ffmpeg cover exit ${r.status}: ${(r.stderr || "").slice(0, 200)}`);
  await rename(tmp, pngPath);
}

// ---- po izvoru ---------------------------------------------------------------
async function ingestSource(source) {
  log(`=== ${source.display} (${source.slug}) ===`);
  const res = await fetch(source.rss, { redirect: "follow" });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const { channel, items } = parseFeed(await res.text());

  const outDir = join(OUTPUT_ROOT, source.slug);
  const stateFile = join(PODCASTS_DIR, `${source.slug}-lista-state.json`);
  const listaFile = join(PODCASTS_DIR, `${source.slug}-lista.txt`);
  const channelFile = join(PODCASTS_DIR, `${source.slug}-channel.json`);

  if (!DRY_RUN) {
    await mkdir(outDir, { recursive: true });
    await mkdir(PODCASTS_DIR, { recursive: true });
    await writeFile(channelFile, JSON.stringify(buildChannelJson(source, channel), null, 2) + "\n");
  }

  const state = await loadState(stateFile);
  const done = new Set([...state.completed, ...state.private, ...state.archived]);
  const stats = { fetched: 0, skipped: 0, short: 0, failed: 0 };

  const eps = [...items].sort((a, b) => (OLDEST_FIRST ? a.pubDate - b.pubDate : b.pubDate - a.pubDate));
  let processed = 0;
  for (const ep of eps) {
    if (processed >= LIMIT) break;
    const id = rssId(ep.guid);
    if (done.has(id)) {
      stats.skipped++;
      continue;
    }
    if (source.min_duration_sec && ep.duration && ep.duration < source.min_duration_sec) {
      stats.short++;
      continue;
    }

    const base = `${ymd(ep.pubDate)}_${sanitizeTitle(ep.title)}_yt_${id}`;
    const mp3Path = join(outDir, `${base}.mp3`);
    processed++;
    if (DRY_RUN) {
      log(`  [dry] ${base}.mp3  (${Math.round(ep.duration / 60)} min, ${ep.enclosureType})`);
      stats.fetched++;
      continue;
    }

    try {
      if (!(await exists(mp3Path))) {
        const ext = /mpeg|mp3/i.test(ep.enclosureType) ? "mp3" : "m4a";
        const srcPath = join(outDir, `${base}.src.${ext}`);
        await downloadTo(ep.enclosure, srcPath);
        await toMp3(srcPath, mp3Path, ep.enclosureType);
        // mtime = datum objave. KORAK 2.7 (Speechmatics, plaćen) bira kandidate po
        // svježini mtime-a (3 dana) — bez ovoga bi uvoz backloga izgledao kao 55
        // svježih epizoda i noćima išao na plaćeni ASR (2026-10-05, DijaLOG).
        if (!Number.isNaN(ep.pubDate.getTime())) await utimes(mp3Path, ep.pubDate, ep.pubDate);
      }
      await writeFile(join(outDir, `${base}.info.json`), JSON.stringify(buildInfoJson({ ep, id, source, channel }), null, 2) + "\n");
      await writeFile(join(outDir, `${base}.description`), ep.description + "\n");
      const img = ep.image || channel.image;
      const pngPath = join(outDir, `${base}.png`);
      if (img && !(await exists(pngPath))) {
        try {
          await coverToThumbnail(img, join(outDir, `${base}.cover.src`), pngPath);
        } catch (e) {
          log(`  thumb fail ${base}: ${e.message}`);
        }
      }
      // URL je youtu.be/{id} jer convert_to_wav.js izvlači id iz njega; pravi izvor
      // je u info.json (webpage_url, _sound_link).
      await appendFile(listaFile, `${ymd(ep.pubDate)} | ${ep.title} | https://youtu.be/${id}\n`);
      state.completed.push(id);
      await saveState(stateFile, state);
      done.add(id);
      stats.fetched++;
      log(`  OK ${base}`);
    } catch (err) {
      stats.failed++;
      log(`  FAIL ${ep.title}: ${err.message}`);
    }
  }
  log(`  done: fetched=${stats.fetched} skipped=${stats.skipped} short=${stats.short} failed=${stats.failed} (feed ${items.length})`);
  return stats;
}

async function main() {
  log(`ingest_rss start${DRY_RUN ? " (DRY-RUN)" : ""}`);
  const sources = ONLY_SOURCE ? SOURCES.filter((s) => s.slug === ONLY_SOURCE) : SOURCES;
  if (!sources.length) {
    console.error(`Nepoznat --source "${ONLY_SOURCE}". Dostupno: ${SOURCES.map((s) => s.slug).join(", ")}`);
    process.exit(2);
  }
  let failed = 0;
  for (const s of sources) {
    try {
      failed += (await ingestSource(s)).failed;
    } catch (e) {
      failed++;
      log(`  ✗ ${s.slug}: ${e.message}`);
    }
  }
  log(`ingest_rss done`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
