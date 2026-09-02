#!/usr/bin/env node
/*
 * ingest_beamly.js
 *
 * Dohvaća epizode dvaju RevenueCat podcasta (Sub Club, Launched) iz već
 * pripremljenih JSON kataloga repoa ~/git/revenuecat/subclub i ubacuje ih u
 * fetch.domovina.tv pipeline BEZ YouTubea — koristi direktni MP3 (`soundLink`).
 *
 * Oponaša yt-dlp output-ugovor: za svaku epizodu zapiše
 *   storage/output/{slug}/{YYYYMMDD}_{naslov}_yt_{id}.mp3
 *                                                      .info.json
 *                                                      .description
 *                                                      .jpg            (ako ima)
 * i upiše id u automatic/podcasts/{slug}-lista-state.json (completed[]) te
 * redak u {slug}-lista.txt. Sve ostalo (convert_to_wav → transcribe (Canary
 * EN→HR) → summarize → article → index → R2) radi nepromijenjeno.
 *
 * ID shema: 11-znakasti id (kao YouTube), jer convert_to_wav.js izvlači id iz
 * lista.txt URL-a preko extractVideoId koji prima točno 11 znakova. Gdje
 * youtube/{slug}.json ima high-confidence match koristi se pravi YouTube
 * videoId, inače zadnjih 11 znakova beamly id-a (ObjectId — zadnjih 11 su
 * jedinstveni, prvih 8 su timestamp). Literal `_yt_` u imenu je nužan jer ga
 * nizvodni koraci traže.
 *
 * Idempotentno: epizode već u completed[] se preskaču; postojeći .mp3 se ne
 * skida ponovno.
 *
 * Uporaba:
 *   node ingest_beamly.js                      # oba podcasta, sve nove epizode
 *   node ingest_beamly.js --source subclub     # samo jedan
 *   node ingest_beamly.js --limit 2 --dry-run  # proba na 2 epizode, bez pisanja
 *   node ingest_beamly.js --repo /path/to/subclub
 *   node ingest_beamly.js --repair-info        # dopiši .info.json postojećim epizodama
 */

import { mkdir, writeFile, readFile, readdir, rename, access, appendFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- CLI -------------------------------------------------------------------
const argv = process.argv.slice(2);
const getFlag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const SUBCLUB_REPO =
  getFlag("repo") || process.env.SUBCLUB_REPO || "/Users/ms/git/revenuecat/subclub";
const ONLY_SOURCE = getFlag("source"); // "subclub" | "launched" | null
const LIMIT = getFlag("limit") ? parseInt(getFlag("limit"), 10) : Infinity;
const DRY_RUN = hasFlag("dry-run");
// Epizode ingestirane prije nego je skripta pisala .info.json (ili kojima je taj
// artefakt naknadno nestao) ostaju zauvijek bez njega: glavna petlja ih preskoči
// jer su u completed[]. `--repair-info` dopisuje SAMO taj nedostajući artefakt —
// ne dira mp3, listu ni state. Bez njega `audit_pipeline.js` te epizode trajno
// prijavljuje kao blocker=fetch („nema .info.json"), a screenshot korak ne zna da
// su audio-only pa ih uzalud šalje na YouTube.
const REPAIR_INFO = hasFlag("repair-info");

const OUTPUT_ROOT = join(HERE, "storage", "output");
const PODCASTS_DIR = join(HERE, "automatic", "podcasts");

const SOURCES = [
  {
    slug: "subclub",
    display: "Sub Club by RevenueCat",
    homepage: "https://subclub.com",
    master: "subclub-episodes.json",
    yt: "youtube/subclub.json",
  },
  {
    slug: "launched",
    display: "Launched by RevenueCat",
    homepage: "https://launchedfm.com",
    master: "launched-episodes.json",
    yt: "youtube/launched.json",
  },
];

// ---- helpers ---------------------------------------------------------------
const DIACRITICS = { č: "c", ć: "c", ž: "z", š: "s", đ: "d" };

// Mirror fetch.js:sanitizeDescription so naming/sorting matches yt-dlp items.
function sanitizeTitle(str) {
  if (!str) return "nepoznat_naslov";
  str = str.toLowerCase();
  str = str.replace(/[čćžšđ]/g, (c) => DIACRITICS[c] || c);
  str = str.replace(/[^a-z0-9]/g, "_");
  str = str.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return str || "nepoznat_naslov";
}

function ymd(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "00000000";
  return (
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// 11-char id (YouTube-shaped) so convert_to_wav.js:extractVideoId can recover it
// from the lista.txt URL. beamly ids are MongoDB ObjectIds (24-hex): the first 8
// hex are a timestamp, so episodes published together share a prefix → the LAST
// 11 chars (random + counter) are the high-entropy part and are fully unique.
const synthId = (beamlyId) => String(beamlyId).slice(-11);

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

// Atomic write (temp + rename) so a crash never leaves half-written state.
async function saveState(stateFile, state) {
  const tmp = `${stateFile}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n");
  await rename(tmp, stateFile);
}

// slug -> high-confidence YouTube videoId, from enrich-youtube.mjs output.
function buildYtMap(ytDoc) {
  const map = new Map();
  for (const v of ytDoc?.videos || []) {
    if (v.matched && v.confidence === "high" && v.episodeSlug) {
      map.set(v.episodeSlug, v.videoId);
    }
  }
  return map;
}

async function downloadTo(url, destPath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body) throw new Error(`empty body for ${url}`);
  const tmp = `${destPath}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, destPath);
}

function buildInfoJson({ ep, videoId, source }) {
  return {
    id: videoId,
    title: ep.title,
    description: ep.summary || "",
    upload_date: ymd(ep.pubDate),
    timestamp: Math.floor(new Date(ep.pubDate).getTime() / 1000) || 0,
    duration: parseInt(ep.duration, 10) || 0,
    view_count: 0,
    like_count: 0,
    uploader: source.display,
    channel: source.display,
    channel_id: `beamly_${source.slug}`,
    channel_url: source.homepage,
    webpage_url: ep.link || source.homepage,
    thumbnail: ep.itunesImage || "",
    // Trag porijekla — pipeline ih ignorira, korisni za debug/audit.
    _source: "beamly",
    _beamly_id: ep.id,
    _slug: ep.slug,
    _episode_number: ep.episodeNumber || null,
    _sound_link: ep.soundLink,
    _yt_matched: videoId !== synthId(ep.id),
  };
}

// Hand-written channel metadata (refresh_podcasts.sh ne može — nije YT kanal).
function buildChannelJson(source, episodes) {
  const art = episodes.find((e) => e.itunesImage)?.itunesImage || "";
  return {
    id: `beamly_${source.slug}`,
    channel: source.display,
    channel_id: `beamly_${source.slug}`,
    title: `${source.display} - Episodes`,
    availability: null,
    channel_follower_count: 0,
    description: "",
    tags: [],
    thumbnails: art ? [{ url: art, id: "0" }] : [],
    _source: "beamly",
    _homepage: source.homepage,
  };
}

// Dopiši .info.json epizodi koja je već ingestirana. Base se NE računa iz naslova
// (sanitizeTitle se s vremenom mijenjao) nego čita s diska po `_yt_<id>` u imenu,
// a `_yt_matched` se izvodi iz ID-a koji je u tom imenu stvarno završio.
async function repairInfoJson({ ep, videoId, synth, source, outDir, stats }) {
  let files;
  try { files = await readdir(outDir); } catch { return; }
  for (const id of [videoId, synth]) {
    const media = files.find((f) => f.includes(`_yt_${id}.`) && (f.endsWith(".mp3") || f.endsWith(".wav")));
    if (!media) continue;
    const base = media.replace(/\.(mp3|wav)$/, "");
    if (files.includes(`${base}.info.json`)) return;
    const info = buildInfoJson({ ep, videoId: id, source });
    info._yt_matched = id !== synth;
    if (DRY_RUN) { log(`  [dry] repair-info ${base}.info.json`); return; }
    await writeFile(join(outDir, `${base}.info.json`), JSON.stringify(info, null, 2) + "\n");
    stats.repaired = (stats.repaired || 0) + 1;
    log(`  REPAIR-INFO ${base}.info.json (_yt_matched=${info._yt_matched})`);
    return;
  }
}

// ---- per-source ingest -----------------------------------------------------
async function ingestSource(source) {
  log(`=== ${source.display} (${source.slug}) ===`);

  const master = JSON.parse(
    await readFile(join(SUBCLUB_REPO, source.master), "utf8"),
  );
  let ytMap = new Map();
  try {
    ytMap = buildYtMap(JSON.parse(await readFile(join(SUBCLUB_REPO, source.yt), "utf8")));
  } catch {
    log(`  (no YT mapping for ${source.slug}, using bm<id> for all)`);
  }

  const episodes = master.episodes || [];
  const outDir = join(OUTPUT_ROOT, source.slug);
  const stateFile = join(PODCASTS_DIR, `${source.slug}-lista-state.json`);
  const listaFile = join(PODCASTS_DIR, `${source.slug}-lista.txt`);
  const channelFile = join(PODCASTS_DIR, `${source.slug}-channel.json`);

  if (!DRY_RUN) {
    await mkdir(outDir, { recursive: true });
    await mkdir(PODCASTS_DIR, { recursive: true });
    await writeFile(channelFile, JSON.stringify(buildChannelJson(source, episodes), null, 2) + "\n");
  }

  const state = await loadState(stateFile);
  const done = new Set([...state.completed, ...state.private, ...state.archived]);

  const stats = { fetched: 0, skipped: 0, failed: 0, ytMatched: 0 };
  let processed = 0;

  for (const ep of episodes) {
    if (processed >= LIMIT) break;

    const synth = synthId(ep.id);
    const videoId = ytMap.get(ep.slug) || synth;
    if (ytMap.has(ep.slug)) stats.ytMatched++;

    // Dedup OTPORAN NA synth→real prijelaz ID-a. Epizoda je već ingestirana ako je u
    // `done` pod BILO KOJIM ID-em — pravim (matched) ILI sintetičkim. Bez `done.has(synth)`
    // dijela: kad enrich-youtube osvježi YT mapping (npr. novi launchd @02:00), epizoda
    // dosad ingestirana sa sintetičkim ID-em odjednom dobije pravi videoId →
    // `done.has(videoId)` je false → re-ingest kao "nova" = DUPLIKAT + full re-procesiranje
    // (Canary+Gemini). synthId je deterministički iz ep.id (stabilan identitet), pa hvata taj
    // slučaj. NAPOMENA: ovo NE radi backlog re-match (postojeće synth epizode OSTAJU synth, bez
    // screenshotova) — to je zaseban, odgođen rename-migracijski posao; ovdje ga samo NE
    // pokrećemo slučajno. Vidi memory: beamly-refresh-architecture-and-enrich-gap.
    if (done.has(videoId) || done.has(synth)) {
      stats.skipped++;
      if (REPAIR_INFO) await repairInfoJson({ ep, videoId, synth, source, outDir, stats });
      continue;
    }
    if (!ep.soundLink) {
      log(`  SKIP ${ep.slug}: no soundLink`);
      stats.failed++;
      continue;
    }

    const base = `${ymd(ep.pubDate)}_${sanitizeTitle(ep.title)}_yt_${videoId}`;
    const mp3Path = join(outDir, `${base}.mp3`);
    const infoPath = join(outDir, `${base}.info.json`);
    const descPath = join(outDir, `${base}.description`);
    const jpgPath = join(outDir, `${base}.jpg`);

    processed++;
    if (DRY_RUN) {
      log(`  [dry] ${base}.mp3  <- ${ep.soundLink}`);
      stats.fetched++;
      continue;
    }

    try {
      if (!(await exists(mp3Path))) {
        await downloadTo(ep.soundLink, mp3Path);
      }
      await writeFile(infoPath, JSON.stringify(buildInfoJson({ ep, videoId, source }), null, 2) + "\n");
      await writeFile(descPath, (ep.summary || "") + "\n");
      if (ep.itunesImage && !(await exists(jpgPath))) {
        try {
          await downloadTo(ep.itunesImage, jpgPath);
        } catch (e) {
          log(`  thumb fail ${ep.slug}: ${e.message}`);
        }
      }

      // Lista redak (date | title | url). URL je uvijek youtu.be/{id} jer
      // convert_to_wav.js izvlači id iz njega; pravi izvorni link je u
      // info.json.webpage_url (koji koristi indekser).
      await appendFile(listaFile, `${ymd(ep.pubDate)} | ${ep.title} | https://youtu.be/${videoId}\n`);

      state.completed.push(videoId);
      await saveState(stateFile, state);
      done.add(videoId);
      stats.fetched++;
      log(`  OK ${base}`);
    } catch (err) {
      stats.failed++;
      log(`  FAIL ${ep.slug}: ${err.message}`);
    }
  }

  log(
    `  done: fetched=${stats.fetched} skipped=${stats.skipped} failed=${stats.failed} ` +
      `(yt-matched ids=${stats.ytMatched})`,
  );
  return stats;
}

// ---- main ------------------------------------------------------------------
async function main() {
  log(`ingest_beamly start (repo=${SUBCLUB_REPO}${DRY_RUN ? ", DRY-RUN" : ""})`);
  const sources = ONLY_SOURCE ? SOURCES.filter((s) => s.slug === ONLY_SOURCE) : SOURCES;
  if (!sources.length) {
    console.error(`Unknown --source "${ONLY_SOURCE}". Use: ${SOURCES.map((s) => s.slug).join(", ")}`);
    process.exit(2);
  }
  for (const s of sources) {
    await ingestSource(s);
  }
  log(`ingest_beamly done`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
