#!/usr/bin/env bash
# E2E verifikacija single-pass puta (2026-07-31, drugi pokušaj).
#
# Prvi pokušaj je pao jer je `modal run <file>` bez ::main tiho pucao (regresija od
# dodavanja batch entrypointa). Popravljeno u 1d258f8; obje epizode su transkribirane
# ručnim pozivom, pa ovaj run vozi ostatak lanca:
#   diarizacija → sažetak → članak → RAG → screenshotovi (1080p) → R2 → channel index
#
# ⚠️ NE provlačiti izlaz kroz `| tail` — u tri prethodna runa to je sakrilo log do
# kraja procesa i produžilo dijagnostiku greške s sekundi na sat vremena.

set -uo pipefail
REPO=/Users/ms/git/domovinatv/fetch.domovina.tv
cd "$REPO"

export PIPELINE_LOCK="$REPO/automatic/logs/.pipeline.lock.d"
. "$REPO/automatic/pipeline_lock.sh"

log() { echo ""; echo "════════ $* — $(date '+%Y-%m-%d %H:%M:%S') ════════"; }

acquire_pipeline_lock wait
trap 'release_pipeline_lock' EXIT
log "LOCK uzet (PID $$)"

log "PUNI PROLAZ (single-pass flagovi)"
env CLAUDE_MODEL=opus "$REPO/run_pipeline.sh" \
    --with-modal-transcribe --modal-scope channels \
    --with-local-canary-diarize --with-screenshots --with-r2-upload \
    --gemini-backend claude

log "SVE GOTOVO"
