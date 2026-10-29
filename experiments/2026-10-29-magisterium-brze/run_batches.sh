#!/bin/bash
# Eksperiment 29.10.2026.: Magisterium chat s više sekcija po pozivu.
# Epizoda QkcpHsj43rE (42 sekcije). Izlaz: data/output/b<N>/ (gitignored, vidi README).
# Holistički odgovor se preuzima iz produkcijskog runa (isti prompt), pa se mjeri samo sekcijski dio.
#   BATCHES="2 3" ./run_batches.sh
set -u
REPO=/Users/ms/git/domovinatv/fetch.domovina.tv
E=$REPO/experiments/2026-10-29-magisterium-brze
ART=$REPO/storage/output/domovina_tv/20261028_ai_u_praksi_claude_code_uzivo_matija_stepanic_startupvg_yt_QkcpHsj43rE.wav.canary.diarized_2026-10-28_opus.article.json
BASE=$E/data/output/b1_produkcija_28-10
cd "$REPO"
for B in ${BATCHES:-3 6}; do
  D=$E/data/output/b$B; mkdir -p "$D/results"
  node magisterium_mcp_prep.js --article "$ART" --batch-size "$B" --max-words 600 --out-dir "$D" >/dev/null || exit 1
  cp "$BASE/holistic.mcp.json" "$BASE/holistic.raw.txt" "$D/results/"
  J=$(ls "$D"/*.job.json)
  node tools/magisterium_mcp_client.js run --job "$J" --results-dir "$D/results" > "$D/client.log" 2>&1
  echo "b$B exit $?"
  node magisterium_mcp_assemble.js --job "$J" --results-dir "$D/results" --out "$D/out.magisterium.json" | grep -E "ocijenjeno|overall"
done
echo gotovo
