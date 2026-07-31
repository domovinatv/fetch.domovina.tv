#!/usr/bin/env bash
# Verifikacija single-pass puta u produkciji (2026-07-31).
#
# Čeka da tekući nightly (koji još vrti STARI inode run_pipeline.sh-a) završi, pa pokreće
# novi put s --modal-scope channels nad 2 svježe epizode koje su ostale bez transkripta:
#   domovina_tv/20260730_005_marijana_sarolic_robic_crostartup...
#   lood_podcast/20260730_promatram_ljude_bez_maski...
#
# Ovo je ujedno prvi stvarni end-to-end test izmjene: transkripcija → diarizacija →
# sažetak → članak → RAG → screenshotovi → R2, sve u jednom prolazu.

set -uo pipefail
REPO=/Users/ms/git/domovinatv/fetch.domovina.tv
cd "$REPO"

export PIPELINE_LOCK="$REPO/automatic/logs/.pipeline.lock.d"
. "$REPO/automatic/pipeline_lock.sh"

log() { echo ""; echo "════════ $* — $(date '+%Y-%m-%d %H:%M:%S') ════════"; }

NIGHTLY_PID="${1:-}"
if [ -n "$NIGHTLY_PID" ]; then
    log "Čekam tekući nightly (PID $NIGHTLY_PID)"
    while kill -0 "$NIGHTLY_PID" 2>/dev/null; do sleep 60; done
    log "Nightly završio"
fi

acquire_pipeline_lock wait
trap 'release_pipeline_lock' EXIT
log "LOCK uzet (PID $$)"

log "DRY-RUN provjera scopea (bez Modal poziva)"
env CLAUDE_MODEL=opus ./run_pipeline.sh --with-modal-transcribe --modal-scope channels \
    --only-summaries --dry-run 2>&1 | grep -aE "Modal kandidata|kandidata \(cap|Izuzimam|soft-skip|DRY RUN|🔄" | head -20

log "STVARNI RUN: single-pass nad svježim epizodama"
env CLAUDE_MODEL=opus ./run_pipeline.sh \
    --with-modal-transcribe --modal-scope channels \
    --with-local-canary-diarize --with-screenshots --with-r2-upload \
    --gemini-backend claude 2>&1 | tail -70

log "SVE GOTOVO"
