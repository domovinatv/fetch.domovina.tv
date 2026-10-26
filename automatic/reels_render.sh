#!/bin/bash
# reels_render.sh — render i objava brendiranih reelova (render_reels.js), IZA nightlyja.
#
# launchd: automatic/launchd/tv.domovina.fetch.reels.plist (svakih 1800 s). Svaki tick:
#   1. preskače ako radi nightly ili bilo koji run_pipeline.sh (CPU i disk su njihovi),
#   2. render bez pipeline locka (samo CPU, radni dir na internom disku), najviše
#      REELS_MAX_RENDERS reelova po ticku (~2–3 min po reelu),
#   3. objava na R2 + episode.json (12.7) POD pipeline lockom (piše u data/{id}/ kao nightly).
# Idempotentno: gotovi reelovi imaju render.fingerprint u reels.json, objavljeni render.url.
# Nema obavijesti tijekom rada — samo log automatic/logs/reels_YYYY-MM-DD.log.
# Vidi docs/2026-10-25-reels-kandidati.md.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR" || exit 1

export HOME="${HOME:-/Users/$USER}"
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; nvm use default >/dev/null 2>&1 || true; fi
[ -d "/Library/Frameworks/Python.framework/Versions/3.13/bin" ] && export PATH="/Library/Frameworks/Python.framework/Versions/3.13/bin:$PATH"
[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# najnoviji yt-dlp na PATH-u (stari daje 403 na medijskom streamu)
. "$SCRIPT_DIR/resolve_ytdlp.sh" >/dev/null

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/reels_$(date +%Y-%m-%d).log"

if pgrep -f "nightly_pipeline.sh|run_pipeline.sh|render_reels.js" >/dev/null 2>&1; then
    echo "$(date '+%H:%M:%S') ⏭️  pipeline radi — reels tick preskočen" >> "$LOG"
    exit 0
fi

{
    echo ""
    echo "════════ $(date '+%Y-%m-%d %H:%M:%S') reels tick ════════"
    node "$REPO_DIR/render_reels.js" --render-only --max-renders "${REELS_MAX_RENDERS:-6}"
    PIPELINE_LOCK_WAIT_S=600 "$SCRIPT_DIR/with_pipeline_lock.sh" node "$REPO_DIR/render_reels.js" --publish-only
    echo "════════ $(date '+%H:%M:%S') kraj ticka ════════"
} >> "$LOG" 2>&1
