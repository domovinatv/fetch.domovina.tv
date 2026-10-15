#!/usr/bin/env bash
# Set 10.10.2026.: zvuk → bases.tsv → Deepgram Nova-3 → Canary+pyannote (Modal). Idempotentno.
set -u
cd "$(dirname "$0")"
REPO=../..
L=data/logs
set -a; . "$REPO/.env.experiments"; set +a
bash fetch_audio.sh > $L/fetch_audio.log 2>&1
node prepare_output.js > $L/prepare_output.log 2>&1 || { echo "GREŠKA prepare_output"; exit 1; }
node asr_cloud.js --usage > $L/usage_prije.json 2>&1
node asr_cloud.js --provider deepgram --concurrency 3 > $L/deepgram.log 2>&1
node asr_cloud.js --usage > $L/usage_poslije.json 2>&1
MODAL_TOKEN_ID=$MODAL_TOKEN_ID_EXPERIMENT MODAL_TOKEN_SECRET=$MODAL_TOKEN_SECRET_EXPERIMENT \
  modal run modal_asr_diar.py::main --concurrency 3 > $L/modal.log 2>&1
echo "gotovo: audio $(ls data/audio/*.mp3 2>/dev/null | wc -l) | deepgram $(ls data/output/*/*.deepgram-nova3.dijariziran.srt 2>/dev/null | wc -l) | canary $(ls data/output/*/*.canary-1b-v2+pyannote-c1.dijariziran.srt 2>/dev/null | wc -l)"
