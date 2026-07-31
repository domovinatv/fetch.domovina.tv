#!/usr/bin/env bash
# Zatvaranje ostataka nakon Modal backfilla (2026-07-30).
#
# Prethodna sesija je pala na OOM (diarizacija --workers 4 ≈ 12 GB uz Modal + node).
# Ovdje: --workers 2, koraci strogo sekvencijalno, log u repo (scratchpad se briše).
#
# Što ostaje za napraviti:
#   1. 4 nova WAV-a bez transkripta (dnevni priljev 29./30.7.) → Modal
#      ⚠️ launched je EN kanal → zaseban run s --source-lang en
#   2. diarizacija tih 4
#   3. 5 epizoda zapelih na STALE DONE-CACHE (3 _unlisted + 2 launched):
#      imaju .canary.diarized.srt ali nemaju .canary.summary.json, a skripta ih
#      javlja kao "preskočeno (cache)" → treba --rebuild-state
#   4. summary + article (opus, kao nightly) → RAG → screenshotovi → R2

set -uo pipefail
REPO=/Users/ms/git/domovinatv/fetch.domovina.tv
cd "$REPO"

export PIPELINE_LOCK="$REPO/automatic/logs/.pipeline.lock.d"
. "$REPO/automatic/pipeline_lock.sh"

log() { echo ""; echo "════════ $* — $(date '+%Y-%m-%d %H:%M:%S') ════════"; }

acquire_pipeline_lock wait
trap 'release_pipeline_lock' EXIT
log "LOCK uzet (PID $$)"

# ─── 1. Modal transkripcija novog priljeva ───────────────────────────
export MODAL_CANARY_MAX_CONTAINERS=1

log "MODAL: launched (EN → HR)"
modal run modal_canary/canary_modal.py::batch --channels launched \
    --source-lang en --target-lang hr --concurrency 2 2>&1 | grep -avE "^\s*$" | tail -20

log "MODAL: HR kanali"
modal run modal_canary/canary_modal.py::batch --concurrency 2 2>&1 | grep -avE "^\s*$" | tail -20

# ─── 2. Diarizacija (workers 2 — OOM zaštita) ────────────────────────
log "DIARIZACIJA (--workers 2)"
python3 colab_diarize/diarize_canary.py --input-dir storage/output --workers 2 2>&1 | tail -20

# ─── 3. Rebuild done-cachea za kanale sa stale ghost zapisima ────────
log "REBUILD STATE: _unlisted + launched"
for ch in _unlisted launched; do
    GEMINI_BACKEND=vertex node summarize_gemini.js --input-dir storage/output \
        --channel "$ch" --rebuild-state --dry-run 2>&1 | tail -6
    GEMINI_BACKEND=vertex node generate_article_gemini.js --input-dir storage/output \
        --channel "$ch" --rebuild-state --dry-run 2>&1 | tail -6
done

# ─── 4. Sažeci + članci (opus — isti backend kao nightly) ────────────
log "OPUS: sumarizacija"
GEMINI_BACKEND=claude CLAUDE_MODEL=opus node summarize_gemini.js \
    --input-dir storage/output 2>&1 | tail -30

log "OPUS: članci"
GEMINI_BACKEND=claude CLAUDE_MODEL=opus node generate_article_gemini.js \
    --input-dir storage/output 2>&1 | tail -40

# ─── 5. RAG + screenshotovi + R2 ─────────────────────────────────────
log "ZAVRŠNI PROLAZ: RAG + screenshotovi + R2"
env CLAUDE_MODEL=opus "$REPO/run_pipeline.sh" \
    --with-local-canary-diarize --with-screenshots --with-r2-upload \
    --gemini-backend claude 2>&1 | tail -60

log "SVE GOTOVO"
