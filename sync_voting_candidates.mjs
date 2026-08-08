#!/usr/bin/env node
/*
 * sync_voting_candidates.mjs — registar hrvatskih podcasta → glasački bazen
 *
 * Puni `domovina_ai.vote_candidates` u domovina-api Supabaseu iz
 * `data/podcasts_registry.json`, i uploada avatare kandidata na
 * `cdn.domovina.ai/registry/avatars/<slug>.jpg`.
 *
 * Kontekst: „Izborni dan" — verificiran građanin (Certilia) glasa jednom dnevno
 * o tome koji se podcast sljedeći onboarda u pipeline.
 * Dizajn: domovina.ai/docs/plans/2026-08-08-glasanje-o-kanalima.md (§3, §8.4, §9.1)
 * Shema:  domovina-api/supabase/migrations/20260808120000_channel_voting.sql
 *
 * ── Filtar kandidata (§3) ────────────────────────────────────────────────────
 *   tracking.enabled === false            (već praćeni kanali NISU kandidati)
 *   AND youtube.url postoji
 *   AND metadata.status ∈ {active, active-slowing, unknown}
 * Registar v1.2 (273 zapisa) daje točno 181 kandidata.
 * Filtar je NAMJERNO samo tehnički — registar je „free speech aggregator" i
 * bazen ne smije biti ideološki predfiltriran, inače glasanje nema legitimitet.
 *
 * ── Što ovaj skript NIKAD ne radi ───────────────────────────────────────────
 *   * NE briše retke iz `vote_candidates` — kandidat koji nestane iz registra
 *     dobiva `status = 'withdrawn'` (glasovi ga referenciraju preko FK-a).
 *   * NE dira `status` postojećih redova pri upsertu — inače bi pobjednik kola
 *     (`winner` / `onboarding` / `onboarded`) bio vraćen u bazen. Promociju radi
 *     zaseban promote_winner tok (§9), ne ovaj skript.
 *   * NE piše ništa bez `--commit` (ni u bazu ni na CDN).
 *
 * ── Avatari (§8.4) ──────────────────────────────────────────────────────────
 * Dizajn spominje `yt-dlp --print thumbnail`. Na URL-u kanala to vrati BANNER
 * (1060×175), ne avatar — zato čitamo cijelu playlist-razinu (`-J
 * --flat-playlist --playlist-items 0`) i biramo kvadratni thumbnail
 * (`avatar_uncropped`, odnosno najveći width==height ≤ 1024 px). Playliste
 * nemaju avatar pa dobiju svoj kvadratni poster (240/480/720).
 * Slike se NIKAD ne serviraju direktno s yt3.googleusercontent.com — CORS puca
 * u Flutter webu (isto pravilo kao CdnConfig.thumbnailUrl).
 *
 * ── Uporaba ─────────────────────────────────────────────────────────────────
 *   node sync_voting_candidates.mjs --dry-run          # ništa se ne piše (default)
 *   node sync_voting_candidates.mjs --dry-run --no-avatars
 *   node sync_voting_candidates.mjs --commit           # baza + CDN
 *   node sync_voting_candidates.mjs --commit --no-avatars    # samo baza
 *   node sync_voting_candidates.mjs --commit --force-avatars # prepiši + CF purge
 *   node sync_voting_candidates.mjs --limit 5 --json
 *
 * ── Env (.env u korijenu repoa) ─────────────────────────────────────────────
 *   SUPABASE_URL                (default https://api.domovina.ai)
 *   SUPABASE_SERVICE_ROLE_KEY   ← obavezno za --commit; NIKAD u repo
 *   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME
 *   R2_PUBLIC_URL               (default https://cdn.domovina.ai)
 *   DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE   (samo za --force-avatars)
 */

import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

// ─── .env učitavanje (ručno, isti pattern kao upload_to_r2.js) ───────────────
(() => {
  const envPath = join(HERE, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
})();

// ─── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes(`--${n}`);
const getFlag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

const COMMIT = hasFlag("commit");
const WITH_AVATARS = !hasFlag("no-avatars");
const FORCE_AVATARS = hasFlag("force-avatars");
const AS_JSON = hasFlag("json");
const LIMIT = getFlag("limit") ? parseInt(getFlag("limit"), 10) : Infinity;
const REGISTRY_PATH = getFlag("registry") || join(HERE, "data", "podcasts_registry.json");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://api.domovina.ai").replace(/\/$/, "");
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "cdn-domovina-ai";
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "https://cdn.domovina.ai").replace(/\/$/, "");
const CF_PURGE_TOKEN = process.env.DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE;
const CF_ZONE_NAME = "domovina.ai";

const AVATAR_PREFIX = "registry/avatars";
const AVATAR_CACHE_CONTROL = "public, max-age=86400";
const YTDLP_CONCURRENCY = 6;
const YTDLP_TIMEOUT_MS = 45_000;
const UPSERT_BATCH = 50;

const log = (emoji, msg) => { if (!AS_JSON) console.log(`${emoji}  ${msg}`); };
const warn = (msg) => { if (!AS_JSON) console.warn(`⚠️   ${msg}`); };

// ─── §3 filtar + mapiranje na shemu ──────────────────────────────────────────
const ALLOWED_STATUS = new Set(["active", "active-slowing", "unknown"]);

function isCandidate(p) {
  return (
    p?.tracking?.enabled === false &&
    typeof p?.youtube?.url === "string" &&
    p.youtube.url.length > 0 &&
    ALLOWED_STATUS.has(p?.metadata?.status)
  );
}

/** Registry zapis → red u domovina_ai.vote_candidates (bez `status`, v. zaglavlje). */
function toRow(p) {
  const meta = p.metadata || {};
  return {
    slug: p.slug,
    display_name: p.display_name,
    youtube_url: p.youtube.url,
    youtube_channel_id: p.youtube.channel_id ?? null,
    tags: Array.isArray(p.tags) ? p.tags : [],
    voditelji: Array.isArray(p.voditelji) ? p.voditelji : [],
    subscribers: Number.isFinite(meta.subscribers) ? meta.subscribers : null,
    episodes_estimate: Number.isFinite(meta.episodes_estimate) ? meta.episodes_estimate : null,
    quality_score: Number.isFinite(p?.quality_score?.total) ? p.quality_score.total : null,
    tier: Number.isFinite(p.tier) ? p.tier : null,
    notes: p.notes || null,
    // `youtube.type` DOSLOVNO — kanonske vrijednosti su channel | playlist |
    // audio-primary; registar nosi i umbrella / disputed / audio-only, koje
    // prolaze kako jesu (Dart ih mapira u unknown). NIKAD `audio-direct` —
    // to je top-level `source_type` polje na ne-kandidatima (launched, subclub)
    // i namjerno se ne čita ovdje.
    // UI time najavljuje da playlist-only kandidat možda ne prolazi pipeline (§11.3).
    source_type: p?.youtube?.type || null,
  };
}

/** Provjeri ono što baza provjerava (constrainti iz 20260808120000). */
function validateRow(r) {
  const bad = [];
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(r.slug)) bad.push("slug format");
  if (!r.display_name || r.display_name.length > 200) bad.push("display_name duljina");
  if (!/^https:\/\//i.test(r.youtube_url) || r.youtube_url.length > 500) bad.push("youtube_url");
  if (r.source_type && !/^[a-z0-9-]{1,32}$/.test(r.source_type)) bad.push("source_type format");
  if (r.quality_score !== null && (r.quality_score < 0 || r.quality_score > 100)) bad.push("quality_score raspon");
  if (r.tags.length > 40) bad.push("previše tagova");
  if (r.voditelji.length > 40) bad.push("previše voditelja");
  return bad;
}

// ─── PostgREST (domovina_ai shema) ───────────────────────────────────────────
function pgHeaders(extra = {}) {
  return {
    apikey: SERVICE_ROLE,
    authorization: `Bearer ${SERVICE_ROLE}`,
    "content-type": "application/json",
    "accept-profile": "domovina_ai",
    "content-profile": "domovina_ai",
    ...extra,
  };
}

async function fetchExistingRows() {
  const url = `${SUPABASE_URL}/rest/v1/vote_candidates?select=slug,status,avatar_url&limit=5000`;
  const res = await fetch(url, { headers: pgHeaders() });
  if (!res.ok) throw new Error(`GET vote_candidates ${res.status}: ${await res.text()}`);
  return res.json();
}

async function upsertRows(rows) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/vote_candidates`, {
      method: "POST",
      headers: pgHeaders({ prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`upsert batch ${i}: ${res.status} ${await res.text()}`);
    log("💾", `upsert ${Math.min(i + UPSERT_BATCH, rows.length)}/${rows.length}`);
  }
}

async function patchStatus(slugs, status) {
  if (!slugs.length) return;
  const inList = slugs.map((s) => `"${s}"`).join(",");
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vote_candidates?slug=in.(${encodeURIComponent(inList)})`,
    {
      method: "PATCH",
      headers: pgHeaders({ prefer: "return=minimal" }),
      body: JSON.stringify({ status }),
    }
  );
  if (!res.ok) throw new Error(`PATCH status=${status}: ${res.status} ${await res.text()}`);
}

// ─── Avatari ─────────────────────────────────────────────────────────────────
/**
 * Iz yt-dlp thumbnails niza izaberi sliku za avatar, redom:
 *   1. kvadratna ≤ 1024 px  → pravi avatar kanala
 *   2. `avatar_uncropped`   → avatar bez rezanja (može biti > 1024)
 *   3. najveći thumbnail    → playliste nemaju avatar, samo 16:9 poster
 * Banner (1060×175 i slični) nikad ne prolazi kroz 1. ni 2., a kroz 3. dolazi
 * samo ako drugoga nema — UI ionako crta s BoxFit.cover.
 */
function pickAvatarThumb(thumbnails) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) return null;
  const sized = thumbnails.filter((t) => t.url && t.width && t.height);

  const squares = sized
    .filter((t) => t.width === t.height && t.width <= 1024)
    .sort((a, b) => b.width - a.width);
  if (squares.length) return squares[0].url;

  const uncropped = thumbnails.find((t) => t.id === "avatar_uncropped" && t.url);
  if (uncropped) return uncropped.url;

  const largest = sized.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return largest ? largest.url : null;
}

async function resolveAvatarSource(youtubeUrl) {
  const args = ["--skip-download", "--flat-playlist", "--playlist-items", "0",
                "--no-warnings", "--ignore-config", "-J", youtubeUrl];
  try {
    const { stdout } = await execFileAsync("yt-dlp", args, {
      timeout: YTDLP_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    return pickAvatarThumb(JSON.parse(stdout).thumbnails);
  } catch (e) {
    // yt-dlp piše pravi razlog (404, private, geo-block) u stderr; exec-ova
    // poruka je samo cijela naredba pa je beskorisna u izvještaju.
    const reason = String(e.stderr || "")
      .split("\n").find((l) => l.startsWith("ERROR:")) || e.message;
    throw new Error(reason.replace(/^ERROR:\s*/, "").slice(0, 140));
  }
}

function sniffImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** HEAD na javni CDN URL — ne treba R2 kredencijale, pa radi i u --dry-run. */
async function avatarOnCdn(slug) {
  try {
    const res = await fetch(`${R2_PUBLIC_URL}/${AVATAR_PREFIX}/${slug}.jpg`, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

let s3Client = null;
async function getS3() {
  if (s3Client) return s3Client;
  for (const [k, v] of Object.entries({ R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY })) {
    if (!v) throw new Error(`Nedostaje ${k} u .env — upload avatara nije moguć.`);
  }
  const { S3Client } = await import("@aws-sdk/client-s3");
  s3Client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return s3Client;
}

/**
 * yt3.googleusercontent.com servira avatar u traženoj veličini preko `=sNNN-c-…`
 * segmenta. Original je ~260 KB (900×900); za listu od 181 avatara to je 45 MB
 * prometa bez potrebe. 400 px pokriva i 3× DPR na mobitelu uz ~100 KB.
 * Ako rewrite ne prođe (drugi host, drugi oblik URL-a), vraćamo original.
 */
async function normalizeAvatarSize(sourceUrl) {
  if (!/googleusercontent\.com\//.test(sourceUrl) || !sourceUrl.includes("=")) return sourceUrl;
  const resized = `${sourceUrl.split("=")[0]}=s400-c-k-c0x00ffffff-no-rj`;
  try {
    const probe = await fetch(resized, { method: "HEAD" });
    return probe.ok ? resized : sourceUrl;
  } catch {
    return sourceUrl;
  }
}

async function uploadAvatar(slug, sourceUrl) {
  const res = await fetch(await normalizeAvatarSize(sourceUrl));
  if (!res.ok) throw new Error(`GET avatar ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = sniffImageType(buf);
  if (!contentType) throw new Error("nepoznat format slike");

  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await getS3();
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: `${AVATAR_PREFIX}/${slug}.jpg`,
    Body: buf,
    ContentType: contentType,          // ključ je .jpg, ali tip ide iz magic-bytesa
    CacheControl: AVATAR_CACHE_CONTROL,
  }));
  return `${R2_PUBLIC_URL}/${AVATAR_PREFIX}/${slug}.jpg`;
}

async function purgeCdn(urls) {
  if (!urls.length) return;
  if (!CF_PURGE_TOKEN) { warn("Nema DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE — preskačem purge."); return; }
  const zoneRes = await fetch(
    `https://api.cloudflare.com/client/v4/zones?name=${CF_ZONE_NAME}`,
    { headers: { authorization: `Bearer ${CF_PURGE_TOKEN}` } }
  );
  const zoneId = (await zoneRes.json())?.result?.[0]?.id;
  if (!zoneId) { warn("Ne mogu razriješiti Cloudflare zone id — preskačem purge."); return; }
  for (let i = 0; i < urls.length; i += 30) {
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
      method: "POST",
      headers: { authorization: `Bearer ${CF_PURGE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ files: urls.slice(i, i + 30) }),
    });
  }
  log("🧹", `CDN purge: ${urls.length} URL-ova.`);
}

// ─── mali concurrency pool ───────────────────────────────────────────────────
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    })
  );
  return results;
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(REGISTRY_PATH)) {
    console.error(`❌  Registar ne postoji: ${REGISTRY_PATH}`);
    process.exit(1);
  }
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  const all = registry.podcasts || [];
  const candidates = all.filter(isCandidate);

  log("📖", `Registar v${registry.version || "?"} — ${all.length} zapisa, ${candidates.length} kandidata (§3 filtar).`);

  const rows = candidates.map(toRow);
  const invalid = rows
    .map((r) => ({ slug: r.slug, bad: validateRow(r) }))
    .filter((x) => x.bad.length);
  if (invalid.length) {
    for (const x of invalid) warn(`${x.slug}: ${x.bad.join(", ")}`);
    console.error(`❌  ${invalid.length} kandidata ne prolazi constrainte sheme — prekidam.`);
    process.exit(1);
  }

  const scoped = rows.slice(0, LIMIT);
  if (scoped.length !== rows.length) {
    log("✂️", `--limit ${LIMIT} → upsert i avatari samo za ${scoped.length} kandidata ` +
              `(povlačenje se i dalje računa nad svih ${rows.length}).`);
  }

  // ── postojeće stanje u bazi (za diff i za očuvanje avatara) ───────────────
  let existing = null;
  if (SERVICE_ROLE) {
    try {
      existing = await fetchExistingRows();
      log("🗄", `Baza: ${existing.length} postojećih redova (${SUPABASE_URL}).`);
    } catch (e) {
      if (COMMIT) throw e;
      warn(`Ne mogu pročitati bazu (${e.message}) — nastavljam bez diffa.`);
    }
  } else if (COMMIT) {
    console.error("❌  SUPABASE_SERVICE_ROLE_KEY nije postavljen — --commit nije moguć.");
    process.exit(1);
  } else {
    warn("SUPABASE_SERVICE_ROLE_KEY nije postavljen — diff prema bazi se preskače.");
  }

  const byExisting = new Map((existing || []).map((r) => [r.slug, r]));

  // ── avatari ───────────────────────────────────────────────────────────────
  const avatarStats = { naCdn: 0, izYtDlp: 0, bezIzvora: 0, uploadano: 0, greske: 0 };
  const uploadedUrls = [];

  if (WITH_AVATARS) {
    log("🖼", `Razrješavam avatare za ${scoped.length} kandidata (yt-dlp ×${YTDLP_CONCURRENCY})…`);
    await runPool(scoped, YTDLP_CONCURRENCY, async (row) => {
      const cdnUrl = `${R2_PUBLIC_URL}/${AVATAR_PREFIX}/${row.slug}.jpg`;

      if (!FORCE_AVATARS && (await avatarOnCdn(row.slug))) {
        row.avatar_url = cdnUrl;
        avatarStats.naCdn++;
        return;
      }

      let source = null;
      try {
        source = await resolveAvatarSource(row.youtube_url);
      } catch (e) {
        avatarStats.greske++;
        warn(`${row.slug}: yt-dlp — ${String(e.message).split("\n")[0].slice(0, 120)}`);
      }

      if (!source) {
        avatarStats.bezIzvora++;
        // ne gazi postojeći avatar u bazi ako ga ovaj put nismo razriješili
        row.avatar_url = byExisting.get(row.slug)?.avatar_url ?? null;
        return;
      }

      avatarStats.izYtDlp++;
      if (COMMIT) {
        try {
          row.avatar_url = await uploadAvatar(row.slug, source);
          uploadedUrls.push(row.avatar_url);
          avatarStats.uploadano++;
        } catch (e) {
          avatarStats.greske++;
          warn(`${row.slug}: upload — ${e.message}`);
          row.avatar_url = byExisting.get(row.slug)?.avatar_url ?? null;
        }
      } else {
        // dry-run: znamo da avatar POSTOJI, ali ga još nema na CDN-u
        row.avatar_url = byExisting.get(row.slug)?.avatar_url ?? null;
      }
    });
  } else {
    for (const row of scoped) row.avatar_url = byExisting.get(row.slug)?.avatar_url ?? null;
    log("🖼", "Avatari preskočeni (--no-avatars).");
  }

  const razrijeseni = avatarStats.naCdn + avatarStats.izYtDlp;

  // ── diff prema bazi ───────────────────────────────────────────────────────
  // ⚠ liveSlugs se gradi iz PUNOG skupa kandidata (`rows`), NIKAD iz `scoped`.
  // `--limit` je debug flag za upsert/avatare; da povlačenje ide po njemu,
  // `--commit --limit 1` bi povukao svih preostalih 180 kandidata.
  const liveSlugs = new Set(rows.map((r) => r.slug));
  const novi = existing ? scoped.filter((r) => !byExisting.has(r.slug)).map((r) => r.slug) : [];
  const azurirani = existing ? scoped.filter((r) => byExisting.has(r.slug)).map((r) => r.slug) : [];
  // ispali iz registra/filtra → withdrawn (NIKAD delete: glasovi ih referenciraju)
  const zaPovlacenje = (existing || [])
    .filter((r) => r.status === "candidate" && !liveSlugs.has(r.slug))
    .map((r) => r.slug);
  // vratili se u filtar dok su bili withdrawn → natrag u bazen
  const zaVracanje = (existing || [])
    .filter((r) => r.status === "withdrawn" && liveSlugs.has(r.slug))
    .map((r) => r.slug);
  // winner / onboarding / onboarded se NE diraju
  const zamrznuti = (existing || [])
    .filter((r) => ["winner", "onboarding", "onboarded"].includes(r.status))
    .map((r) => r.slug);

  // ── pisanje ───────────────────────────────────────────────────────────────
  if (COMMIT) {
    await upsertRows(scoped);
    await patchStatus(zaPovlacenje, "withdrawn");
    await patchStatus(zaVracanje, "candidate");
    if (FORCE_AVATARS) await purgeCdn(uploadedUrls);
    log("✅", `Zapisano: ${scoped.length} upsertano, ${zaPovlacenje.length} withdrawn, ${zaVracanje.length} vraćeno, ${avatarStats.uploadano} avatara na CDN.`);
  }

  // ── izvještaj ─────────────────────────────────────────────────────────────
  const summary = {
    registry_version: registry.version || null,
    registry_records: all.length,
    kandidata: scoped.length,
    avatari: { razrijeseni, ...avatarStats },
    baza: existing
      ? { postojecih: existing.length, novih: novi.length, azuriranih: azurirani.length,
          za_povlacenje: zaPovlacenje.length, za_vracanje: zaVracanje.length, zamrznutih: zamrznuti.length }
      : null,
    committed: COMMIT,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("");
  console.log("─".repeat(64));
  console.log(`  KANDIDATA: ${scoped.length}`);
  console.log(`  Avatari:   ${razrijeseni} razriješeno ` +
              `(${avatarStats.naCdn} već na CDN-u, ${avatarStats.izYtDlp} iz yt-dlp), ` +
              `${avatarStats.bezIzvora} bez izvora, ${avatarStats.greske} grešaka`);
  if (existing) {
    console.log(`  Baza:      ${novi.length} novih, ${azurirani.length} ažuriranih, ` +
                `${zaPovlacenje.length} → withdrawn, ${zaVracanje.length} → natrag u bazen, ` +
                `${zamrznuti.length} zamrznutih (winner/onboarding/onboarded)`);
    if (zaPovlacenje.length) console.log(`             withdrawn: ${zaPovlacenje.join(", ")}`);
  } else {
    console.log("  Baza:      preskočena (nema SUPABASE_SERVICE_ROLE_KEY)");
  }
  console.log("─".repeat(64));
  console.log(COMMIT
    ? "  ✅ ZAPISANO (--commit)."
    : "  🔍 DRY-RUN — ništa nije zapisano ni u bazu ni na CDN. Za pisanje: --commit");
  console.log("");
}

main().catch((e) => {
  console.error(`❌  ${e.stack || e.message}`);
  process.exit(1);
});
