#!/usr/bin/env bash
# priority_pipeline.sh — prioritetni fast-path tick (launchd StartInterval, npr. 90s).
#
# Claima prioritetne jobove iz pipeline.domovina.ai i za svaki odmah pokrene PUNI
# single-video pipeline s Modal transkripcijom (~10-15 min do domovina.ai članka).
# Standard jobovi ostaju na noćnom Colab bulku (nightly_pipeline.sh, 03:00).
#
# Ustupa noćnom bulku preko dijeljenog mutexa (pipeline_lock.sh): ako je run_pipeline
# već zauzet (nightly ili prethodni priority tick) → preskoči ovaj tick i probaj za 90s.
# Sve NE-fatalno: bez PIPELINE_QUEUE_INGEST_KEY u .env → poller soft-exit 0.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

# ─── ENVIRONMENT (launchd ne nasljeđuje user PATH) ───
export HOME="${HOME:-/Users/$USER}"
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; nvm use default >/dev/null 2>&1 || true; fi
[ -d "$HOME/google-cloud-sdk/bin" ] && export PATH="$HOME/google-cloud-sdk/bin:$PATH"
[ -d "/Library/Frameworks/Python.framework/Versions/3.13/bin" ] && export PATH="/Library/Frameworks/Python.framework/Versions/3.13/bin:$PATH"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

LOG_DIR="$REPO_DIR/automatic/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/priority_$(date +%Y-%m-%d).log"
exec >> "$LOG_FILE" 2>&1
# Očisti prioritetne logove starije od 14 dana.
find "$LOG_DIR" -name 'priority_*.log' -type f -mtime +14 -delete 2>/dev/null || true

# .env → PIPELINE_QUEUE_INGEST_KEY (isti kao nightly KORAK 0).
set -a; [ -f "$REPO_DIR/.env" ] && . "$REPO_DIR/.env"; set +a

BRIDGE="${PIPELINE_QUEUE_BRIDGE_DIR:-$REPO_DIR/../pipeline.domovina.ai/bridge}"
PIPELINE_LOCK="$LOG_DIR/.pipeline.lock.d"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/pipeline_lock.sh"

# Prioritet USTUPA noćnom bulku: zauzet lock → preskoči tick (probat ćemo za 90s).
if ! acquire_pipeline_lock nowait; then
    echo "$(date '+%F %T') ⏭️  pipeline lock zauzet (nightly/priorno) — preskačem tick."
    exit 0
fi
trap 'release_pipeline_lock' EXIT INT TERM

echo ""
echo "$(date '+%F %T') ⚡ ─── PRIORITY TICK START ───"
# Poller po uspješnom jobu poziva i auto_reuse_adhoc.js --video-id (reuse ad-hoc
# obrade u channel dir praćenog kanala + reindex SAMO kad je nešto kopirano) —
# sve unutar ovog ticka, tj. pod pipeline lockom koji već držimo.
[ -f "$BRIDGE/priority_poller.js" ] && node "$BRIDGE/priority_poller.js" || echo "   ⚠️ nema priority_poller.js — preskačem."
# Javi gotove (article.json live na CDN → done + detail_url) odmah.
[ -f "$BRIDGE/reconcile.js" ] && node "$BRIDGE/reconcile.js" || true
echo "$(date '+%F %T') ⚡ ─── PRIORITY TICK DONE ───"
