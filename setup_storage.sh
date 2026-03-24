#!/bin/bash

#
# setup_storage.sh
#
# Kreira lokalni storage/output/ direktorij sa symlinkovima prema fizičkim diskovima.
# Čita konfiguraciju iz storage.conf (kopiraj iz storage.conf.example).
#
# Primjer:
#   cp storage.conf.example storage.conf
#   # Editiraj storage.conf prema svojim diskovima
#   ./setup_storage.sh
#
# Nakon toga sve skripte (fetch.js, run_pipeline.sh, itd.) koriste
# storage/output/ kao logički output direktorij.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_FILE="$SCRIPT_DIR/storage.conf"
STORAGE_DIR="$SCRIPT_DIR/storage"
OUTPUT_DIR="$STORAGE_DIR/output"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   💾 SETUP STORAGE — Multi-Disk Symlinks        ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# --- 1. Provjeri da storage.conf postoji ---
if [ ! -f "$CONF_FILE" ]; then
    echo "❌ Nedostaje storage.conf!"
    echo ""
    echo "   Kopiraj primjer i prilagodi:"
    echo "   cp storage.conf.example storage.conf"
    echo ""
    exit 1
fi

# --- 2. Parsiraj storage.conf ---
# Kompatibilno s bash 3 (macOS) — bez associative arrays
DEFAULT_PATH=""
CHANNEL_KEYS=""
CHANNEL_PATHS=""

while IFS= read -r line; do
    # Preskoči komentare i prazne linije
    case "$line" in
        \#*|"") continue ;;
    esac
    # Trim whitespace
    line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -z "$line" ] && continue
    case "$line" in
        \#*) continue ;;
    esac

    key="${line%%=*}"
    value="${line#*=}"
    key="$(echo "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

    if [ "$key" = "DEFAULT" ]; then
        DEFAULT_PATH="$value"
    else
        # Dodaj u listu (newline-separated)
        CHANNEL_KEYS="${CHANNEL_KEYS}${key}
"
        CHANNEL_PATHS="${CHANNEL_PATHS}${value}
"
    fi
done < "$CONF_FILE"

if [ -z "$DEFAULT_PATH" ]; then
    echo "❌ DEFAULT putanja nije definirana u storage.conf!"
    exit 1
fi

echo "   📂 DEFAULT: $DEFAULT_PATH"
echo ""

# --- 3. Provjeri da DEFAULT disk postoji ---
if [ ! -d "$DEFAULT_PATH" ]; then
    echo "⚠️  DEFAULT putanja ne postoji: $DEFAULT_PATH"
    echo "   Je li disk mountan?"
    echo ""
    read -p "   Želiš li kreirati direktorij? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        mkdir -p "$DEFAULT_PATH"
        echo "   ✅ Kreiran: $DEFAULT_PATH"
    else
        echo "   ❌ Prekid."
        exit 1
    fi
fi

# --- Helper: dohvati path za kanal iz liste ---
get_channel_path() {
    local channel="$1"
    local i=1
    echo "$CHANNEL_KEYS" | while IFS= read -r k; do
        [ -z "$k" ] && continue
        if [ "$k" = "$channel" ]; then
            echo "$CHANNEL_PATHS" | sed -n "${i}p"
            return
        fi
        i=$((i + 1))
    done
}

is_explicit_channel() {
    local channel="$1"
    echo "$CHANNEL_KEYS" | grep -qx "$channel" 2>/dev/null
}

# --- 4. Provjeri eksplicitno navedene diskove ---
MISSING=false
echo "$CHANNEL_KEYS" | while IFS= read -r k; do
    [ -z "$k" ] && continue
    chan_path="$(get_channel_path "$k")"
    volume_mount="$(echo "$chan_path" | cut -d'/' -f1-3)"
    if [ -n "$volume_mount" ] && [ ! -d "$volume_mount" ]; then
        echo "❌ Volume nije mountan: $volume_mount (za kanal: $k)"
        MISSING=true
    fi
done

# --- 5. Kreiraj storage/output/ ---
mkdir -p "$OUTPUT_DIR"

# --- 6. Ukloni stare symlinkove (samo symlinkove, ne direktorije!) ---
if [ -d "$OUTPUT_DIR" ]; then
    find "$OUTPUT_DIR" -maxdepth 1 -type l -delete
fi

# --- 7. Kreiraj symlinkove ---
CHANNEL_COUNT=0
EXPLICIT_COUNT=0

# Eksplicitno mapirani kanali
echo "$CHANNEL_KEYS" | while IFS= read -r k; do
    [ -z "$k" ] && continue
    chan_path="$(get_channel_path "$k")"
    [ -z "$chan_path" ] && continue

    # Kreiraj fizički direktorij ako ne postoji
    if [ ! -d "$chan_path" ]; then
        mkdir -p "$chan_path"
        echo "   📁 Kreiran: $chan_path"
    fi

    ln -s "$chan_path" "$OUTPUT_DIR/$k"
    echo "   🔗 $k → $chan_path"
done

# Brojač eksplicitnih
EXPLICIT_COUNT=$(echo "$CHANNEL_KEYS" | awk 'NF' | wc -l | tr -d ' ')

# Auto-discover iz DEFAULT (kanali koji nisu eksplicitno navedeni)
AUTO_COUNT=0
if [ -d "$DEFAULT_PATH" ]; then
    for dir in "$DEFAULT_PATH"/*/; do
        [ -d "$dir" ] || continue
        channel="$(basename "$dir")"

        # Preskoči ako je eksplicitno mapiran
        if is_explicit_channel "$channel"; then
            continue
        fi

        # Preskoči ako symlink već postoji
        if [ -L "$OUTPUT_DIR/$channel" ]; then
            continue
        fi

        ln -s "${dir%/}" "$OUTPUT_DIR/$channel"
        AUTO_COUNT=$((AUTO_COUNT + 1))
    done
fi

TOTAL_COUNT=$((EXPLICIT_COUNT + AUTO_COUNT))

# --- 8. Marker file ---
date "+%Y-%m-%d %H:%M:%S" > "$STORAGE_DIR/.storage_ready"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   ✅ Storage konfiguriran!"
echo "   📂 Symlink dir: $OUTPUT_DIR"
echo "   🔗 Kanala ukupno: $TOTAL_COUNT (eksplicitno: $EXPLICIT_COUNT, auto: $AUTO_COUNT)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   Sada možeš pokrenuti pipeline:"
echo "   ./run_pipeline.sh --channel domovina_tv --hf-token TVOJ_TOKEN"
echo ""
