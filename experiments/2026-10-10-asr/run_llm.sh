#!/usr/bin/env bash
# Opus 5.5 (pretplata) epizodu po epizodu: za svaku epizodu 3 paralelna procesa, po jedan za svaki
# ASR+diarizaciju (Speechmatics / Deepgram / Canary+pyannote), pa tek onda sljedeća epizoda —
# usporedba za epizodu je gotova čim ona završi. Idempotentno (gotovi članci se preskaču).
#   ./run_llm.sh                 # sve epizode, najkraća prva
#   ./run_llm.sh ID1,ID2         # samo te
set -u
cd "$(dirname "$0")"
unset ANTHROPIC_API_KEY
L=data/logs/llm; mkdir -p "$L"
INPUTS="speechmatics-enhanced deepgram-nova3 canary-1b-v2+pyannote-c1"
if [ -n "${1:-}" ]; then IDS=$(echo "$1" | tr , ' ')
else IDS=$(tail -n +2 testset.tsv | sort -t$'\t' -k3 -n | cut -f1); fi
for id in $IDS; do
  for inp in $INPUTS; do
    node llm_opus.js --model opus-5-5 --input "$inp" --id "$id" > "$L/$id.$inp.log" 2>&1 &
  done
  wait
  echo "$id: $(grep -l '✅' $L/$id.*.log 2>/dev/null | wc -l | tr -d ' ')/3 gotovo"
done
echo "gotovo"
