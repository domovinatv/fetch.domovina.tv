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
node upload_to_r2.js --input-dir storage/output --video-id "$VID" 2>&1 | grep -iE "magisterium|Novih|Neuspjel|error|⬆" | head -10
node generate_channel_index.js --channel "$CH" 2>&1 | grep -iE "$CH|Ukupno|index.json" | head -3
node upload_to_r2.js --meta-dir storage/meta 2>&1 | grep -iE "$CH.json|index.json|index_bundle|Neuspjel" | head -5
code=$(curl -s -o /dev/null -w "%{http_code}" "https://cdn.domovina.ai/data/$VID/article.magisterium.json")
echo "    CDN GET article.magisterium.json -> $code"
echo "=== DONE $VID ==="
