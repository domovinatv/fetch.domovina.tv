#!/bin/bash
#
# uninstall.sh — Skini tv.domovina.fetch.nightly iz launchd
#

set -euo pipefail

LABEL="tv.domovina.fetch.nightly"
DST_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
GUI_DOMAIN="gui/$(id -u)"

if launchctl print "${GUI_DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    launchctl bootout "${GUI_DOMAIN}/${LABEL}"
    echo "✅ Unload-an iz launchd"
else
    echo "ℹ️  Nije boot-an u launchd-u, preskačem unload"
fi

if [ -f "$DST_PLIST" ]; then
    rm -f "$DST_PLIST"
    echo "✅ Plist obrisan: $DST_PLIST"
else
    echo "ℹ️  Plist ne postoji: $DST_PLIST"
fi

echo ""
echo "Nightly pipeline više se ne pokreće automatski."
echo "Manualno pokretanje uvijek dostupno: ./automatic/nightly_pipeline.sh"
