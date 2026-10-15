#!/bin/bash
# Objava varijanti eksperimenta (sintetički ID npr. OspwepfLO_2) na cdn.domovina.ai/data/<ID>/.
# Varijante žive IZVAN storage/output (data/varijante/_varijante/), pa ih nightly i RAG ne vide.
#   run_variants.sh            # promocija novih + screenshotovi + words.json + suhi upload
#   run_variants.sh --commit   # isto, ali upload stvarno ide na R2 (+ episode.json, CF purge)
# Idempotentno: postojeće varijante, kadrovi i R2 ključevi se preskaču.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ROOT="$(cd "$HERE/data" && pwd -P)/varijante"
cd "$REPO"

echo "▶ 1/4 promocija (novi agy članci postaju _5 kad su gotovi)"
node "$HERE/promote_to_unlisted.js" --variants --commit | tail -2

echo "▶ 2/4 screenshotovi (kadrovi iz izvornog videa preko _variant_of)"
node screenshot_youtube.js --input-dir "$ROOT" --channel _varijante 2>&1 | grep -E "Varijanta od|✅|❌|⚠️|Ukupno|ABORT" | tail -20

echo "▶ 3/4 words.json"
node generate_words_json.js --input-dir "$ROOT" --channel _varijante 2>&1 | tail -4

echo "▶ 4/4 upload na R2"
if [ "${1:-}" = "--commit" ]; then
    node upload_to_r2.js --input-dir "$ROOT" --channel _varijante 2>&1 | tail -15
else
    node upload_to_r2.js --input-dir "$ROOT" --channel _varijante --dry-run 2>&1 | tail -15
fi
