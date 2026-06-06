#!/bin/bash
#
# nightly_pipeline.sh — End-to-end overnight pipeline wrapper
#
# Pokreće cijeli pipeline za fetch.domovina.tv u jednom prolazu:
#
#   FAZA A — priprema za Colab Canary transkripciju:
#     • automatic/refresh_podcasts.sh  (KORAK 0 unutar run_pipeline.sh, rclone diarized.srt-ova)
#     • fetch.js                       (KORAK 1, novi videi s YouTube-a)
#     • convert_to_wav.js              (KORAK 2, MP3 → WAV 16kHz mono)
#     • upload WAV-ova na Google Drive (KORAK 2.5, za Colab batch)
#
#   FAZA B — post-Colab catch-up za prethodno transkribirane videe:
#     • diarize_canary.py              (KORAK 6, pyannote lokalno na M4 Pro)
#     • summarize_gemini.js            (KORAK 7)
#     • generate_article_gemini.js     (KORAK 8)
#     • prepare_rag_combined.js        (KORAK 9)
#     • generate_og_image.js           (KORAK 9.5)
#     • generate_og_sections.py        (KORAK 9.6)
#     • screenshot_youtube.js          (KORAK 10, --with-screenshots)
#     • upload_to_r2.js                (KORAK 12, --with-r2-upload)
#
#   ZAVRŠNI KORACI (samostalni, run_pipeline.sh ih ne zove):
#     • generate_channel_index.js                       — refresh channels/data/index.json
#     • upload_to_r2.js --meta-dir storage/meta         — upload index na CDN
#
# Sve je idempotentno — script može se vrtjeti svaki dan, svaki korak skipa već dovršeno.
#
# NAMJERNO NIJE UKLJUČENO:
#   --with-vertex-import — chain dependency na završenu Canary transkripciju; ne pokreći
#                          automatski dok Canary visi na Colabu (vidi MEMORY: pipeline_catchup_pass).
#
# iPHONE PROXY (auto-probe):
#   Prije fetcha, nightly probe-a iPhone mobile-phone-proxy (Tailscale
#   http://100.71.146.11:8888). Ako je živ I daje egress IP različit od Ethernet
#   IP-a, prosljeđuje --proxy run_pipeline.sh-u → yt-dlp ide kroz iPhone cellular
#   i zaobilazi anti-bot. Da bi to radilo noću: iPhone na punjaču + mobile-phone-proxy
#   app upaljen + WiFi UGAŠEN na iPhonu (inače egress curi kroz WiFi = isti IP =
#   probe odbacuje proxy). Vidi MEMORY: iphone-http-proxy-via-tailscale.
#
# OČEKIVANI FAILURE-i (kad iPhone proxy NIJE dostupan):
#   YouTube anti-bot na direct connection (Mac na Ethernet/WiFi bez residential proxy-ja).
#   fetch.js / screenshot_youtube.js exit-aju 0 čak i kod ABORT-a (vidi MEMORY:
#   pipeline_anti_bot_silent_continue). Failed videi će biti pokupljeni sljedećim
#   runom kad je iPhone proxy gore (auto) ili manualnim re-runom na tethering-u.
#
# Pokretanje:
#   Ručno:    ./automatic/nightly_pipeline.sh
#   launchd:  automatic/launchd/tv.domovina.fetch.nightly.plist  (svaki dan u 03:00)
#

set -uo pipefail

# ─── REPO ROOT ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

# ─── ENVIRONMENT ──────────────────────────────────────────────────
# launchd ne nasljedjuje user shell PATH — moramo eksplicitno.
export HOME="${HOME:-/Users/$USER}"

# nvm (za node)
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    nvm use default >/dev/null 2>&1 || true
fi

# gcloud SDK (za Vertex AI OAuth token refresh)
if [ -d "$HOME/google-cloud-sdk/bin" ]; then
    export PATH="$HOME/google-cloud-sdk/bin:$PATH"
fi

# Python 3.13 Framework (drži Pillow za generate_og_sections.py — brew/system pythoni ga nemaju)
if [ -d "/Library/Frameworks/Python.framework/Versions/3.13/bin" ]; then
    export PATH="/Library/Frameworks/Python.framework/Versions/3.13/bin:$PATH"
fi

# Homebrew (rclone, ffmpeg, jq)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# ─── LOGGING ──────────────────────────────────────────────────────
LOG_DIR="$REPO_DIR/automatic/logs"
mkdir -p "$LOG_DIR"

DATESTAMP="$(date +%Y-%m-%d)"
LOG_FILE="$LOG_DIR/nightly_${DATESTAMP}.log"

# Pipeline output ide u per-day log. Ako smo u tty (manual run), tee-aj i u terminal;
# inače (launchd context) samo redirect — bez tee-a izbjegavamo dupliciranje istog
# sadržaja u launchd.out.log (koje launchd inherit-a kao stdout/stderr).
if [ -t 1 ]; then
    exec > >(tee -a "$LOG_FILE") 2>&1
else
    exec >> "$LOG_FILE" 2>&1
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   🌙  NIGHTLY PIPELINE                                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "   Start:        $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "   Repo:         $REPO_DIR"
echo "   Log:          $LOG_FILE"
echo "   Caller PID:   $$"
echo "   PATH:         $PATH"
echo "   Node:         $(command -v node || echo MISSING) $(node --version 2>/dev/null || true)"
echo "   gcloud:       $(command -v gcloud || echo MISSING)"
echo "   rclone:       $(command -v rclone || echo MISSING)"
echo "   ffmpeg:       $(command -v ffmpeg || echo MISSING)"
echo ""

# ─── LOCKFILE ─────────────────────────────────────────────────────
# Spriječi paralelne run-ove (manual + launchd kolizija ili dugo trajanje
# prethodnog run-a koje preklopi sljedeći schedule).
LOCK_FILE="$LOG_DIR/.nightly.lock"

if [ -e "$LOCK_FILE" ]; then
    LOCK_PID="$(cat "$LOCK_FILE" 2>/dev/null || echo "")"
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
        echo "⚠️  Prethodni pipeline (PID $LOCK_PID) još radi — izlazim."
        exit 0
    else
        echo "ℹ️  Stale lockfile pronađen (PID $LOCK_PID neaktivan) — preuzimam."
        rm -f "$LOCK_FILE"
    fi
fi

echo "$$" > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT INT TERM

# ─── LOG ROTACIJA ─────────────────────────────────────────────────
# Tri sloja loga:
#   1. nightly_YYYY-MM-DD.log         — per-day pipeline log. Brisanje > 30 dana.
#   2. launchd.{out,err}.log          — append-only kroz sve runove (launchd capture).
#                                       Truncate kad pređu prag, .1 backup za diagnostiku.
#   3. nightly_*.log.gz arhiva        — gzip-anje starije od 7 dana (čuvaj forensic).
#
# Sve rotacije rade tijekom početka run-a (nakon lockfile-a, prije pipeline koraka).
LAUNCHD_LOG_MAX_SIZE_MB=5
LOG_GZIP_AGE_DAYS=7
LOG_DELETE_AGE_DAYS=30

# 1. Brisanje starih per-day logova (svejedno gzip ili plain)
find "$LOG_DIR" -name 'nightly_*.log' -type f -mtime +$LOG_DELETE_AGE_DAYS -delete 2>/dev/null || true
find "$LOG_DIR" -name 'nightly_*.log.gz' -type f -mtime +$LOG_DELETE_AGE_DAYS -delete 2>/dev/null || true

# 2. Gzip per-day logova starijih od 7 dana (još nije gzip-an)
find "$LOG_DIR" -name 'nightly_*.log' -type f -mtime +$LOG_GZIP_AGE_DAYS \
    ! -name "nightly_${DATESTAMP}.log" -exec gzip -f {} \; 2>/dev/null || true

# 3. launchd.{out,err}.log — size-bound truncate s .1 backup
for launchd_log in "$LOG_DIR/launchd.out.log" "$LOG_DIR/launchd.err.log"; do
    if [ -f "$launchd_log" ]; then
        size_mb=$(du -m "$launchd_log" 2>/dev/null | cut -f1)
        if [ -n "$size_mb" ] && [ "$size_mb" -gt "$LAUNCHD_LOG_MAX_SIZE_MB" ]; then
            # Backup → .1 (overwrite stari .1). Nova writes idu na novi inode
            # jer launchd otvori fresh file na svakom run-u.
            mv -f "$launchd_log" "${launchd_log}.1" 2>/dev/null || true
            : > "$launchd_log" 2>/dev/null || true
        fi
    fi
done

# ─── FAZE PIPELINE-A ──────────────────────────────────────────────

FAILED_STEPS=()

run_step() {
    local label="$1"
    shift
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "   ▶️  $label"
    echo "   $ $*"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if "$@"; then
        echo "   ✅ $label"
        return 0
    else
        local rc=$?
        echo "   ❌ $label (exit $rc) — nastavljam dalje"
        FAILED_STEPS+=("$label (exit $rc)")
        return $rc
    fi
}

# ─── iPhone proxy auto-probe ──────────────────────────────────────
# Nightly ide unattended. Ako je iPhone mobile-phone-proxy (Tailscale
# 100.71.146.11:8888) ŽIV *I* daje egress IP različit od Ethernet IP-a, dodaj
# --proxy za yt-dlp pozive (fetch + screenshot) da zaobiđemo YouTube IP-level
# anti-bot. Inače fallback na direktno — fetch/screenshot tiho fail-aju na
# anti-bot (isto kao i dosad), pipeline nastavlja dalje.
#
# Egress-IP usporedba hvata i slučaj kad user zaboravi UGASITI WiFi na iPhonu:
# tada iOS egress-a kroz WiFi (home NAT) → isti public IP kao Mac Ethernet →
# proxy ne donosi ništa anti-botu, pa ga ne koristimo. Vidi MEMORY:
# iphone-http-proxy-via-tailscale (KRITIČNO: WiFi off na iPhonu za cellular egress).
IPHONE_PROXY_URL="http://100.71.146.11:8888"
PROXY_ARGS=()

probe_iphone_proxy() {
    local direct_ip proxy_ip
    direct_ip="$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || echo "")"
    proxy_ip="$(curl -s --max-time 15 -x "$IPHONE_PROXY_URL" https://api.ipify.org 2>/dev/null || echo "")"
    if [ -z "$proxy_ip" ]; then
        echo "   📡 iPhone proxy nedostupan ($IPHONE_PROXY_URL) — fetch ide direktno (anti-bot očekivan)."
        return 1
    fi
    if [ "$proxy_ip" = "$direct_ip" ]; then
        echo "   ⚠️  iPhone proxy egress ($proxy_ip) == Ethernet IP — WiFi na iPhonu vjerojatno NIJE ugašen. Ne koristim proxy."
        return 1
    fi
    echo "   📡 iPhone proxy ŽIV: egress $proxy_ip (Ethernet $direct_ip) — yt-dlp ide kroz iPhone (cellular)."
    PROXY_ARGS=("--proxy" "$IPHONE_PROXY_URL")
    return 0
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📡 iPhone proxy probe ($IPHONE_PROXY_URL)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
probe_iphone_proxy || true

# ─── 1. GLAVNI PIPELINE (faze A + B) ──────────────────────────────
# --with-local-canary-diarize: pyannote diarizacija lokalno na Macu (gdje nightly
# ionako trči); token se resolve-a iz ~/.cache/huggingface/token (ne treba --hf-token).
# Diarize ide PRIJE summary/article u istom prolazu → nove epizode s pristiglim
# .canary.srt (Colab) dobiju .canary.diarized.srt pa odmah idu kroz AI sloj.
# PROXY_ARGS je prazan ako probe nije našao živ iPhone proxy (guard za set -u + bash 3).
run_step "run_pipeline.sh (faza A + faza B)" \
    "$REPO_DIR/run_pipeline.sh" ${PROXY_ARGS[@]+"${PROXY_ARGS[@]}"} --with-local-canary-diarize --with-screenshots --with-r2-upload || true

# ─── 2. CHANNEL INDEX REGEN ───────────────────────────────────────
run_step "generate_channel_index.js" \
    node "$REPO_DIR/generate_channel_index.js" || true

# ─── 3. META UPLOAD (channels/data/* na CDN) ──────────────────────
run_step "upload_to_r2.js --meta-dir storage/meta" \
    node "$REPO_DIR/upload_to_r2.js" --meta-dir storage/meta || true

# ─── SAŽETAK ──────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   🌙  NIGHTLY PIPELINE — SAŽETAK                             ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "   Kraj:    $(date '+%Y-%m-%d %H:%M:%S %Z')"

if [ ${#FAILED_STEPS[@]} -eq 0 ]; then
    echo "   Status:  ✅ Svi koraci OK"
else
    echo "   Status:  ⚠️  ${#FAILED_STEPS[@]} korak/a vraćao nenula:"
    for s in "${FAILED_STEPS[@]}"; do
        echo "            • $s"
    done
    echo ""
    echo "   ℹ️  Pipeline ne aborta na nenula iz pojedinog koraka — failed videi"
    echo "      bit će pokupljeni sljedećim manualnim re-runom (vjerojatno preko"
    echo "      iPhone tethering-a, ako se radi o YouTube anti-bot blokovima)."
fi
echo ""
