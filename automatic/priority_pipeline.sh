#!/usr/bin/env bash
# priority_pipeline.sh — prioritetni DISPATCHER (launchd StartInterval 90 s).
#
# Od 27.10.2026. više prioritetnih videa ide PARALELNO (docs: pipeline.domovina.ai
# docs/2026-10-27-paralelna-obrada.md). Svaki tick:
#   1. nightly / ručni bulk drži globalni lock (.pipeline.lock.d) → ne otvara slot
#   2. traži slobodan slot logs/.priority.d/slot-1..PRIORITY_SLOTS (default 2); slot 2+
#      samo uz ≥ PRIORITY_MIN_FREE_GB slobodnog RADNOG diska (default 25; _unlisted → DOMOVINA2TB)
#      i ≥ PRIORITY_MIN_FREE_SSD_GB na internom SSD-u (default 5, privremeni web.mp4)
#   3. u slotu pokrene priority_worker.sh u VLASTITOJ sesiji (setsid), koji claima 1 job i
#      vrti PUNI single-video pipeline (~30–60 min) — tick odmah izlazi
#   4. reconcile (article.json live na CDN → done)
# Najviše jedan novi worker po ticku: claimovi su ≥90 s razmaknuti (dnevni budžet, yt-dlp).
# launchd ne pali novi tick dok stari živi — zato worker NE smije biti dijete ticka koje
# launchd ubije na izlazu (setsid + AbandonProcessGroup u plistu).
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

# yt-dlp: biraj po verziji, ne po PATH redoslijedu (stari ekstraktor → 403 na
# medijskom streamu). Isti helper koji koristi nightly.
# shellcheck source=/dev/null
. "$SCRIPT_DIR/resolve_ytdlp.sh"

# .env → PIPELINE_QUEUE_INGEST_KEY (isti kao nightly KORAK 0).
set -a; [ -f "$REPO_DIR/.env" ] && . "$REPO_DIR/.env"; set +a

# Uzorak kvote Claude pretplate za dnevni izvještaj obrade svih epizoda (najviše 1 u 10 min,
# sam se prorijedi; tih i ne-fatalan).
node "$REPO_DIR/automatic/all_episodes_report.js" sample >/dev/null 2>&1 || true

BRIDGE="${PIPELINE_QUEUE_BRIDGE_DIR:-$REPO_DIR/../pipeline.domovina.ai/bridge}"

SLOTS="${PRIORITY_SLOTS:-2}"
MIN_FREE_GB="${PRIORITY_MIN_FREE_GB:-25}"
SLOT_DIR="$LOG_DIR/.priority.d"
GLOBAL_LOCK="$LOG_DIR/.pipeline.lock.d"
mkdir -p "$SLOT_DIR"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/pipeline_lock.sh"

reconcile() { [ -f "$BRIDGE/reconcile.js" ] && node "$BRIDGE/reconcile.js" || true; }

# 1. Nightly/bulk (živ holder globalnog locka, ili upravo uzet) → prioritet ustupa.
if [ -d "$GLOBAL_LOCK" ]; then
    holder="$(cat "$GLOBAL_LOCK/pid" 2>/dev/null || echo "")"
    if [ -z "$holder" ] || kill -0 "$holder" 2>/dev/null; then
        echo "$(date '+%F %T') ⏭️  nightly/bulk drži pipeline lock — ne otvaram slot."
        exit 0
    fi
fi

# 2. Slobodan slot.
# Disk se mjeri ondje gdje obrada stvarno piše (04.11.2026.): prioritetni videi idu u
# storage/output/_unlisted, a to je symlink na radni disk (DOMOVINA2TB). Do 04.11. se mjerio
# $REPO_DIR = interni SSD, pa je slot 2 cijeli dan stajao zbog „12 GB < 25 GB” dok je radni
# disk imao 650 GB. Na SSD ide samo privremeni web.mp4 iz KORAKA 12.5 (briše se nakon
# uploada), zato za SSD vrijedi manja ograda PRIORITY_MIN_FREE_SSD_GB (default 5).
WORK_DIR="$REPO_DIR/storage/output/_unlisted"
[ -e "$WORK_DIR" ] || WORK_DIR="$REPO_DIR/storage/output"
MIN_FREE_SSD_GB="${PRIORITY_MIN_FREE_SSD_GB:-5}"
free_gb="$(df -g "$WORK_DIR/" | awk 'NR==2 {print $4}')"
ssd_free_gb="$(df -g "$HOME" | awk 'NR==2 {print $4}')"
slot=""
busy=""
for k in $(seq 1 "$SLOTS"); do
    if [ "$k" -gt 1 ] && [ "${free_gb:-0}" -lt "$MIN_FREE_GB" ]; then
        [ -z "$slot" ] && busy="$busy (slot $k+: radni disk ${free_gb} GB < ${MIN_FREE_GB} GB)"
        break
    fi
    if [ "$k" -gt 1 ] && [ "${ssd_free_gb:-0}" -lt "$MIN_FREE_SSD_GB" ]; then
        [ -z "$slot" ] && busy="$busy (slot $k+: SSD ${ssd_free_gb} GB < ${MIN_FREE_SSD_GB} GB)"
        break
    fi
    PIPELINE_LOCK="$SLOT_DIR/slot-$k"
    if acquire_pipeline_lock nowait; then slot="$k"; break; fi
    busy="$busy slot-$k"
done

if [ -z "$slot" ]; then
    echo "$(date '+%F %T') ⏭️  nema slobodnog slota:$busy"
    reconcile
    exit 0
fi

# 3. Worker u vlastitoj sesiji (preživi izlazak ticka); pid workera preuzima slot.
PRIORITY_SLOT="$slot" PRIORITY_SLOT_LOCK="$SLOT_DIR/slot-$slot" PRIORITY_LOG_FILE="$LOG_FILE" BRIDGE="$BRIDGE" \
    perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' bash "$SCRIPT_DIR/priority_worker.sh" </dev/null >/dev/null 2>&1 &
echo "$!" > "$SLOT_DIR/slot-$slot/pid"
echo "$(date '+%F %T') ⚡ slot $slot → worker PID $! (radni disk ${free_gb} GB, SSD ${ssd_free_gb} GB slobodno)"

# 4. Javi gotove.
reconcile
