#!/usr/bin/env bash
# magisterium_pipeline.sh — Magisterium (re)obrada tick (launchd StartInterval, npr. 600s).
#
# Claima `magisterium_jobs` zahtjeve iz pipeline.domovina.ai (admin gumb "🕊 Mag HR/EN",
# cron auto-enqueue za done jobove s uključenim Magisteriumom, ili full-backfill kanali iz
# automatic/full_backfill_channels.txt preko enqueue_magisterium_backfill.js — vidi dolje)
# i za svaki pokrene PUNI hibridni
# Magisterium MCP workflow (docs/MAGISTERIUM_MCP_RUN.md) headless preko Claude Code CLI, pa
# verificira artefakt na CDN-u. Idempotentno: već obrađeni videi (artefakt 200) → odmah done.
#
# Lockovi (2026-10-19): Magisterium ima SVOJ mutex (.magisterium.lock.d) za cijeli tick, pa
# dva Magisterium runa nikad ne idu istovremeno (MCP chat je sekvencijalan, 15 req/min), a
# prioritetni single-video runovi ga više ne blokiraju satima. Dijeljeni pipeline lock uzima
# samo objava (runbook korak 7: channel index + R2) kroz with_pipeline_lock.sh — od 27.10. je to
# uski publish lock (sekunde), pa prioritetni slotovi objavu više ne blokiraju. Noćni bulk drži pipeline lock
# satima, pa za njegova trajanja tick i dalje preskačemo (objava bi čekala dulje od timeouta).
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
# Claude Code CLI živi u ~/.local/bin — OBAVEZNO u PATH-u (poller ga zove kao `claude`).
[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

LOG_DIR="$REPO_DIR/automatic/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/magisterium_$(date +%Y-%m-%d).log"
exec >> "$LOG_FILE" 2>&1
# Očisti Magisterium logove starije od 14 dana.
find "$LOG_DIR" -name 'magisterium_*.log' -type f -mtime +14 -delete 2>/dev/null || true

# .env → PIPELINE_QUEUE_INGEST_KEY (isti kao nightly KORAK 0) + R2/GCP auth koje runbook koristi.
set -a; [ -f "$REPO_DIR/.env" ] && . "$REPO_DIR/.env"; set +a

BRIDGE="${PIPELINE_QUEUE_BRIDGE_DIR:-$REPO_DIR/../pipeline.domovina.ai/bridge}"
# Noćni bulk drži dijeljeni pipeline lock → preskoči tick (prioritetni run NE blokira).
SHARED_LOCK_PID="$(cat "$LOG_DIR/.pipeline.lock.d/pid" 2>/dev/null || true)"
if [ -n "$SHARED_LOCK_PID" ] && ps -o command= -p "$SHARED_LOCK_PID" 2>/dev/null | grep -q nightly_pipeline; then
    echo "$(date '+%F %T') ⏭️  noćni bulk drži pipeline lock — preskačem Magisterium tick."
    exit 0
fi

# Vlastiti mutex: jedan Magisterium run u isto vrijeme (run ~14 min > tick 10 min).
PIPELINE_LOCK="$LOG_DIR/.magisterium.lock.d"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/pipeline_lock.sh"
if ! acquire_pipeline_lock nowait; then
    echo "$(date '+%F %T') ⏭️  prethodni Magisterium run još traje — preskačem tick."
    exit 0
fi
trap 'release_pipeline_lock' EXIT INT TERM

# Jedan video po ticku (chat je rate-limitiran 15/min; run ~14 min) — ostatak sljedeći tick.
export MAG_MAX="${MAG_MAX:-1}"

echo ""
echo "$(date '+%F %T') 🕊 ─── MAGISTERIUM TICK START ───"

# Praćeni kanali (automatic/full_backfill_channels.txt): NOVE epizode (post-baseline)
# s objavljenim HR člankom a bez Magisteriuma → auto-enqueue u magisterium_jobs (dedupe
# radi worker). Stare rupe NIKAD automatski — puni backfill je ručni na zahtjev.
# Non-fatalno: greška enqueuea ne smije srušiti tick (poller svejedno obrađuje postojeće).
if [ -f "$SCRIPT_DIR/enqueue_magisterium_backfill.js" ]; then
    node "$SCRIPT_DIR/enqueue_magisterium_backfill.js" || echo "   ⚠️ enqueue_magisterium_backfill greška (non-fatal)."
fi

# CLAUDE_WINDOW_GUARD: poller pita `claude-window` prije claima — tick svakih 10 min
# 24/7 inače može otvoriti nov 5h prozor kvote pred 08:30. Vidi launchd-menubar/SCHEDULING.md.
if [ -f "$BRIDGE/magisterium_poller.js" ]; then
    CLAUDE_WINDOW_GUARD=1 node "$BRIDGE/magisterium_poller.js"
else
    echo "   ⚠️ nema magisterium_poller.js — preskačem."
fi
echo "$(date '+%F %T') 🕊 ─── MAGISTERIUM TICK DONE ───"
