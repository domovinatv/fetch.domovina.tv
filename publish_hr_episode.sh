#!/bin/bash
# publish_hr_episode.sh <VIDEO_ID>
# Instant objava HR Magisteriuma za jednu epizodu: upload per-video + reindex + meta upload + GET verify.
# Koristi se ODMAH nakon assemble (magisterium.json) — bez EN.
#
# GOTCHA: YouTube ID koji počinje crticom (npr. "-bOmDXC7rlA") bash tretira kao opciju.
#   Pozovi OVAKO:  bash publish_hr_episode.sh -- -bOmDXC7rlA
#   (ovaj script preskače vodeći "--"; node upload_to_r2.js ispravno parsira --video-id s crticom)
set -uo pipefail
cd /Users/ms/git/domovinatv/fetch.domovina.tv
# Kanal se može pregaziti env varijablom: `CH=mladi_za_domovinu bash publish_hr_episode.sh <VID>`
CH="${CH:-muzevni_budite}"
[ "${1:-}" = "--" ] && shift   # dopusti `-- <VID>` za VID-ove s vodećom crticom
VID="$1"
echo "=== PUBLISH-HR $VID (kanal: $CH) ==="
# E-knjiga dobiva prosudbu (KORAK 9.8 je bio prije Magisteriuma) — HR, i EN ako postoji
# .article.en.json. Bilo je u Claude runbooku (MAGISTERIUM_MCP_RUN.md korak 7), izgubilo se
# prelaskom na izravni put (27.10.). PRIJE per-video uploada (nova knjiga ide njime, a
# promijenjena kroz force_upload_epubs ispod). --force: ponovna obrada inače ostavi staru
# prosudbu (knjiga već ima magisterium.xhtml). Ne-fatalno.
node generate_ebook.js --video-id "$VID" --force 2>&1 | grep -E "✅|❌|⚠️|epub" | head -4
node upload_to_r2.js --input-dir storage/output --video-id "$VID" 2>&1 | grep -iE "magisterium|Novih|Neuspjel|error|⬆" | head -10
node generate_channel_index.js --channel "$CH" 2>&1 | grep -iE "$CH|Ukupno|index.json" | head -3
node upload_to_r2.js --meta-dir storage/meta 2>&1 | grep -iE "$CH.json|index.json|index_bundle|Neuspjel" | head -5
node tools/force_upload_epubs.js --changed-only --video-id "$VID" 2>&1 | grep -E "⬆️|Poslano|greš" | head -4
node build_episode_bundle.js --video-id "$VID" 2>&1 | tail -1
code=$(curl -s -o /dev/null -w "%{http_code}" "https://cdn.domovina.ai/data/$VID/article.magisterium.json")
echo "    CDN GET article.magisterium.json -> $code"
echo "=== DONE $VID ==="
