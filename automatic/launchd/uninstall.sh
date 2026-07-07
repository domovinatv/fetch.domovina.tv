#!/bin/bash
#
# uninstall.sh — Skini DOMOVINA launchd jobove (nightly + priority)
#
# Uporaba:  ./uninstall.sh [all|nightly|priority]   (default: all)
#

set -euo pipefail

GUI_DOMAIN="gui/$(id -u)"

case "${1:-all}" in
    nightly)  LABELS=("tv.domovina.fetch.nightly") ;;
    priority) LABELS=("tv.domovina.fetch.priority") ;;
    all|"")   LABELS=("tv.domovina.fetch.nightly" "tv.domovina.fetch.priority") ;;
    *) echo "❌ Nepoznat argument: $1 (all|nightly|priority)" >&2; exit 1 ;;
esac

for LABEL in "${LABELS[@]}"; do
    DST_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
    if launchctl print "${GUI_DOMAIN}/${LABEL}" >/dev/null 2>&1; then
        launchctl bootout "${GUI_DOMAIN}/${LABEL}"
        echo "✅ Unload-an: ${LABEL}"
    else
        echo "ℹ️  ${LABEL} nije boot-an, preskačem"
    fi
    if [ -f "$DST_PLIST" ]; then rm -f "$DST_PLIST"; echo "✅ Plist obrisan: $DST_PLIST"; fi
done

echo ""
echo "Manualno pokretanje uvijek dostupno:"
echo "  ./automatic/nightly_pipeline.sh    (bulk)"
echo "  ./automatic/priority_pipeline.sh   (prioritetni tick)"
