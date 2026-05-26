#!/bin/bash
#
# install.sh — Registriraj tv.domovina.fetch.nightly u launchd
#
# Kopira plist u ~/Library/LaunchAgents/ i bootstrap-a ga u GUI launchd domenu.
# Idempotentno — ako je već instaliran, prvo unload-a pa ponovo load-a.
#
# Uporaba:
#   ./automatic/launchd/install.sh
#

set -euo pipefail

LABEL="tv.domovina.fetch.nightly"
SRC_PLIST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${LABEL}.plist"
DST_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
GUI_DOMAIN="gui/$(id -u)"

if [ ! -f "$SRC_PLIST" ]; then
    echo "❌ Plist ne postoji: $SRC_PLIST" >&2
    exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

# Ako već boot-an, prvo unload (zanemari grešku ako nije).
if launchctl print "${GUI_DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    echo "ℹ️  Već boot-an — unload-am prije reinstall-a"
    launchctl bootout "${GUI_DOMAIN}/${LABEL}" 2>/dev/null || true
fi

cp "$SRC_PLIST" "$DST_PLIST"
echo "✅ Kopirano: $DST_PLIST"

launchctl bootstrap "$GUI_DOMAIN" "$DST_PLIST"
echo "✅ Boot-an u launchd: ${GUI_DOMAIN}/${LABEL}"

# Provjeri status
if launchctl print "${GUI_DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    echo ""
    echo "Sljedeći run:"
    launchctl print "${GUI_DOMAIN}/${LABEL}" | grep -E "state|next run|last exit code" || true
else
    echo "⚠️  Bootstrap prijavio uspjeh ali launchctl print ne vidi job — provjeri ručno." >&2
    exit 1
fi

echo ""
echo "Pokreni odmah (jednom, ne čekajući 03:00):"
echo "  launchctl kickstart -k ${GUI_DOMAIN}/${LABEL}"
echo ""
echo "Logovi:"
echo "  automatic/logs/nightly_YYYY-MM-DD.log    (pipeline output)"
echo "  automatic/logs/launchd.out.log           (launchd capture)"
echo "  automatic/logs/launchd.err.log"
