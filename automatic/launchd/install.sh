#!/bin/bash
#
# install.sh — Registriraj DOMOVINA launchd jobove
#   • tv.domovina.fetch.nightly   — noćni bulk pipeline (03:00)
#   • tv.domovina.fetch.priority  — prioritetni fast-path poller (svakih 90s)
#
# Kopira plistove u ~/Library/LaunchAgents/ i bootstrap-a ih u GUI launchd domenu.
# Idempotentno — ako je već instaliran, prvo unload-a pa ponovo load-a.
#
# Uporaba:
#   ./automatic/launchd/install.sh              # oba
#   ./automatic/launchd/install.sh priority     # samo prioritet
#   ./automatic/launchd/install.sh nightly      # samo nightly
#

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUI_DOMAIN="gui/$(id -u)"
mkdir -p "$HOME/Library/LaunchAgents"

case "${1:-all}" in
    nightly)  LABELS=("tv.domovina.fetch.nightly") ;;
    priority) LABELS=("tv.domovina.fetch.priority") ;;
    all|"")   LABELS=("tv.domovina.fetch.nightly" "tv.domovina.fetch.priority") ;;
    *) echo "❌ Nepoznat argument: $1 (all|nightly|priority)" >&2; exit 1 ;;
esac

for LABEL in "${LABELS[@]}"; do
    SRC_PLIST="$SRC_DIR/${LABEL}.plist"
    DST_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
    if [ ! -f "$SRC_PLIST" ]; then
        echo "❌ Plist ne postoji: $SRC_PLIST" >&2
        exit 1
    fi
    if launchctl print "${GUI_DOMAIN}/${LABEL}" >/dev/null 2>&1; then
        echo "ℹ️  ${LABEL} već boot-an — unload-am prije reinstall-a"
        launchctl bootout "${GUI_DOMAIN}/${LABEL}" 2>/dev/null || true
    fi
    cp "$SRC_PLIST" "$DST_PLIST"
    launchctl bootstrap "$GUI_DOMAIN" "$DST_PLIST"
    echo "✅ Boot-an: ${GUI_DOMAIN}/${LABEL}"
    launchctl print "${GUI_DOMAIN}/${LABEL}" | grep -E "state|next run|last exit code" || true
done

echo ""
echo "Pokreni odmah (jednom):"
for LABEL in "${LABELS[@]}"; do echo "  launchctl kickstart -k ${GUI_DOMAIN}/${LABEL}"; done
echo ""
echo "Logovi:"
echo "  automatic/logs/nightly_YYYY-MM-DD.log     (bulk pipeline)"
echo "  automatic/logs/priority_YYYY-MM-DD.log    (prioritetni fast-path)"
echo "  automatic/logs/launchd.{,priority.}{out,err}.log  (launchd capture)"
