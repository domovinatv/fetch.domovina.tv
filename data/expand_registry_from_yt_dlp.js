#!/usr/bin/env node
/**
 * expand_registry_from_yt_dlp.js
 *
 * Generic transformer: yt-dlp enriched playlist data + manualna klasifikacija
 * -> dodaje per-playlist entries u data/podcasts_registry.json.
 *
 * Slijedi shemu postojecih playlist-as-podcast unosa (popcast-pavicic,
 * podcast-bitno-net). Idempotentno preko slug-a.
 *
 * Usage:
 *   node data/expand_registry_from_yt_dlp.js \
 *     --enriched data/_raw_research/_playlist_enriched.json \
 *     --classification data/_raw_research/_classification.json \
 *     [--dry-run]
 *
 * Re-runnable za buduce kanale: dovoljno je pripremiti par
 * (enriched.json + classification.json) i pokrenuti istu skriptu.
 */

const fs = require("fs");
const path = require("path");

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

const ENRICHED = getArg("--enriched") || "data/_raw_research/_playlist_enriched.json";
const CLASSIFICATION = getArg("--classification") || "data/_raw_research/_classification.json";
const REGISTRY = getArg("--registry") || "data/podcasts_registry.json";
const DRY_RUN = process.argv.includes("--dry-run");

function load(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function ymFromYyyymmdd(d) {
  if (!d) return null;
  const s = String(d);
  if (s.length < 6) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
}

function buildEntry(playlistMeta, classification, parentLabel, sourceId) {
  const avgMin = playlistMeta.duration_avg_sec ? Math.round(playlistMeta.duration_avg_sec / 60) : null;
  const entry = {
    slug: classification.slug,
    display_name: classification.display_name,
    youtube: {
      url: playlistMeta.url,
      handle: null,
      type: "playlist",
      parent_channel: parentLabel,
      playlist_id: playlistMeta.playlist_id,
    },
    tags: classification.tags || [],
    voditelji: classification.voditelji || [],
    metadata: {
      episodes_estimate: playlistMeta.episode_count || null,
      last_episode: ymFromYyyymmdd(playlistMeta.modified_date),
      average_duration_minutes: avgMin,
      status: classification.status || "active",
    },
    tracking: {
      enabled: classification.tracking_enabled === true,
      ...(classification.tracking_enabled === false && classification.notes
        ? { reason_disabled: classification.notes }
        : {}),
    },
    tier: classification.tier || 3,
    data_quality: "verified",
    sources: [sourceId],
    notes: classification.notes || "",
  };
  if (classification.possible_duplicate_of) {
    entry.possible_duplicate_of = classification.possible_duplicate_of;
  }
  return entry;
}

function buildUmbrella(existing, umbrellaUpdate, childSlugs) {
  // Zadrzi sto vise postojecih polja, samo update relevantna.
  const out = JSON.parse(JSON.stringify(existing));
  out.youtube = {
    url: umbrellaUpdate.youtube_url,
    handle: umbrellaUpdate.youtube_handle,
    type: "umbrella",
    channel_id: umbrellaUpdate.youtube_channel_id,
  };
  out.tracking = {
    enabled: false,
    reason_disabled: "Umbrella entry — sadrzaj se prati per-playlist child entries, ne direktno preko kanala.",
  };
  out.notes = umbrellaUpdate.notes;
  out.child_slugs = childSlugs;
  out.metadata = {
    ...out.metadata,
    status: "active",
    children_count: childSlugs.length,
  };
  return out;
}

function main() {
  const enriched = load(ENRICHED);
  const classification = load(CLASSIFICATION);
  const registry = load(REGISTRY);

  const enrichedById = {};
  for (const p of enriched) {
    if (p.playlist_id) enrichedById[p.playlist_id] = p;
  }

  // Add source if missing
  const newSource = classification.new_source;
  if (newSource && !registry.sources.find((s) => s.id === newSource.id)) {
    registry.sources.push(newSource);
    console.log(`+ Added source: ${newSource.id}`);
  }

  const podcastsBySlug = {};
  for (const p of registry.podcasts) podcastsBySlug[p.slug] = p;

  const stats = { added: 0, updated_existing: 0, umbrella: 0, skipped: 0 };

  // Sort classification.playlists by parent for grouped output
  const playlistsByParent = {};
  for (const c of classification.playlists) {
    const meta = enrichedById[c.playlist_id];
    if (!meta) {
      console.warn(`! WARN: playlist_id ${c.playlist_id} (${c.slug}) not found in enriched data — SKIP`);
      stats.skipped++;
      continue;
    }
    playlistsByParent[meta.parent] = playlistsByParent[meta.parent] || [];
    playlistsByParent[meta.parent].push({ classification: c, meta });
  }

  // Find umbrella label for each parent
  const parentLabels = {};
  for (const u of classification.umbrella_updates) {
    parentLabels[u.slug] = podcastsBySlug[u.slug]?.display_name || u.slug;
  }

  for (const [parent, items] of Object.entries(playlistsByParent)) {
    const parentLabel = parentLabels[parent] || parent;
    console.log(`\n=== ${parent} (${items.length} playlists) ===`);
    for (const { classification: c, meta } of items) {
      const targetSlug = c.merge_existing_slug || c.slug;
      const entry = buildEntry(meta, c, parentLabel, newSource.id);
      // If merging into existing slug, preserve some user-curated fields
      if (c.merge_existing_slug && podcastsBySlug[c.merge_existing_slug]) {
        const existing = podcastsBySlug[c.merge_existing_slug];
        entry.slug = c.merge_existing_slug;
        entry.voditelji = existing.voditelji?.length ? existing.voditelji : entry.voditelji;
        entry.tier = existing.tier ?? entry.tier;
        entry.sources = Array.from(new Set([...(existing.sources || []), newSource.id]));
        podcastsBySlug[c.merge_existing_slug] = entry;
        console.log(`  ↻ Updated existing: ${c.merge_existing_slug}  (was URL: null)`);
        stats.updated_existing++;
      } else if (podcastsBySlug[c.slug]) {
        // Already exists — refresh metadata but keep curated fields
        const existing = podcastsBySlug[c.slug];
        entry.voditelji = existing.voditelji?.length ? existing.voditelji : entry.voditelji;
        entry.tier = existing.tier ?? entry.tier;
        entry.sources = Array.from(new Set([...(existing.sources || []), newSource.id]));
        podcastsBySlug[c.slug] = entry;
        console.log(`  ↻ Refreshed: ${c.slug}`);
        stats.updated_existing++;
      } else {
        podcastsBySlug[c.slug] = entry;
        console.log(`  + Added: ${c.slug}  (${meta.episode_count} ep, ${entry.metadata.average_duration_minutes}m avg, ${c.tracking_enabled ? "TRACKING" : "not-tracked"})`);
        stats.added++;
      }
    }
  }

  // Update umbrella entries
  for (const u of classification.umbrella_updates) {
    const existing = podcastsBySlug[u.slug];
    if (!existing) {
      console.warn(`! WARN: umbrella stub ${u.slug} not found — skipping`);
      continue;
    }
    // Collect actual child slugs from registry after expansion
    const childSlugs = [];
    for (const c of classification.playlists) {
      const targetSlug = c.merge_existing_slug || c.slug;
      const meta = enrichedById[c.playlist_id];
      if (meta && meta.parent === u.slug) {
        childSlugs.push(targetSlug);
      }
    }
    podcastsBySlug[u.slug] = buildUmbrella(existing, u, childSlugs);
    console.log(`\n☂  Umbrella updated: ${u.slug}  (${childSlugs.length} children)`);
    stats.umbrella++;
  }

  // Reconstruct podcasts array preserving original order, adding new entries at end
  const seenSlugs = new Set();
  const newPodcasts = [];
  for (const p of registry.podcasts) {
    if (podcastsBySlug[p.slug]) {
      newPodcasts.push(podcastsBySlug[p.slug]);
      seenSlugs.add(p.slug);
    }
  }
  // Append new
  for (const [slug, entry] of Object.entries(podcastsBySlug)) {
    if (!seenSlugs.has(slug)) {
      newPodcasts.push(entry);
      seenSlugs.add(slug);
    }
  }

  registry.podcasts = newPodcasts;
  registry.generated_at = new Date().toISOString().slice(0, 10);

  console.log(`\n--- Stats ---`);
  console.log(`  Added new:        ${stats.added}`);
  console.log(`  Updated existing: ${stats.updated_existing}`);
  console.log(`  Umbrella updates: ${stats.umbrella}`);
  console.log(`  Skipped:          ${stats.skipped}`);
  console.log(`  Total entries:    ${registry.podcasts.length}`);

  if (DRY_RUN) {
    console.log("\n[DRY RUN] No changes written.");
    return;
  }

  fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + "\n");
  console.log(`\nWritten: ${REGISTRY}`);
}

main();
