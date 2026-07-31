#!/usr/bin/env bash
# Zatvaranje 4 preostale "ghost" epizode (2026-07-31).
#
# Uzrok: stale done-cache — epizode imaju .canary.diarized.srt ali nemaju
# .canary.summary.json, a skripta ih javlja kao "preskočeno (cache)".
# ISPRAVAK U ODNOSU NA PRETHODNI RUN: --rebuild-state MORA ići BEZ --dry-run.
# S --dry-run se rebuild ne zapiše trajno pa ghost preživi (potvrđeno empirijski).

set -uo pipefail
REPO=/Users/ms/git/domovinatv/fetch.domovina.tv
cd "$REPO"

export PIPELINE_LOCK="$REPO/automatic/logs/.pipeline.lock.d"
. "$REPO/automatic/pipeline_lock.sh"

log() { echo ""; echo "════════ $* — $(date '+%Y-%m-%d %H:%M:%S') ════════"; }

acquire_pipeline_lock wait
trap 'release_pipeline_lock' EXIT
log "LOCK uzet (PID $$)"

for ch in _unlisted launched; do
    log "REBUILD + SUMMARY (opus): $ch"
    GEMINI_BACKEND=claude CLAUDE_MODEL=opus node summarize_gemini.js \
        --input-dir storage/output --channel "$ch" --rebuild-state 2>&1 | tail -12

    log "REBUILD + ARTICLE (opus): $ch"
    GEMINI_BACKEND=claude CLAUDE_MODEL=opus node generate_article_gemini.js \
        --input-dir storage/output --channel "$ch" --rebuild-state 2>&1 | tail -20
done

log "ZAVRŠNI PROLAZ: RAG + screenshotovi + R2"
env CLAUDE_MODEL=opus "$REPO/run_pipeline.sh" \
    --with-local-canary-diarize --with-screenshots --with-r2-upload \
    --gemini-backend claude 2>&1 | tail -50

log "SVE GOTOVO"
