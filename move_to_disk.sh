#!/bin/bash

#
# move_to_disk.sh
#
# Sigurno preseli kanal na drugi disk:
#   1. rsync kopija (s verifikacijom)
#   2. Ažurira storage.conf
#   3. Briše original
#   4. Pokreće setup_storage.sh (osvježava symlink)
#
# Usage:
#   ./move_to_disk.sh <kanal> <dest-disk-path>
#   ./move_to_disk.sh lood_podcast /Volumes/DOMOVINA2TB/fetch_domovina_tv_output
#   ./move_to_disk.sh --all /Volumes/DOMOVINA2TB/fetch_domovina_tv_output
#
# Options:
#   --dry-run    Samo prikaži što bi se premjestilo, ne premještaj
#   --no-delete  Preseli (rsync), ali ne briši original
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_FILE="$SCRIPT_DIR/storage.conf"
OUTPUT_DIR="$SCRIPT_DIR/storage/output"

# --- Argumenti ---
DRY_RUN=false
NO_DELETE=false
KANAL=""
DEST_BASE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)   DRY_RUN=true; shift ;;
        --no-delete) NO_DELETE=true; shift ;;
        --all)       KANAL="--all"; shift ;;
        -*)          echo "❌ Nepoznata opcija: $1"; exit 1 ;;
        *)
            if [ -z "$KANAL" ]; then KANAL="$1"
            elif [ -z "$DEST_BASE" ]; then DEST_BASE="$1"
            fi
            shift ;;
    esac
done

if [ -z "$KANAL" ] || [ -z "$DEST_BASE" ]; then
    echo ""
    echo "Usage: ./move_to_disk.sh <kanal|--all> <dest-disk-path>"
    echo ""
    echo "  Primjeri:"
    echo "    ./move_to_disk.sh lood_podcast /Volumes/DOMOVINA2TB/fetch_domovina_tv_output"
    echo "    ./move_to_disk.sh --all /Volumes/DOMOVINA2TB/fetch_domovina_tv_output"
    echo "    ./move_to_disk.sh --all /Volumes/DOMOVINA2TB/fetch_domovina_tv_output --dry-run"
    echo ""
    exit 1
fi

# --- Provjeri dest disk ---
if [ ! -d "$(dirname "$DEST_BASE")" ] && [ ! -d "$DEST_BASE" ]; then
    echo "❌ Destinacijski disk nije dostupan: $(dirname "$DEST_BASE")"
    echo "   Je li disk mountan?"
    exit 1
fi

# --- Dohvati listu kanala za premještanje ---
if [ "$KANAL" = "--all" ]; then
    # Svi kanali koji su trenutno na DEFAULT disku
    DEFAULT_DISK=""
    while IFS= read -r line; do
        case "$line" in \#*|"") continue ;; esac
        line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        [ -z "$line" ] && continue
        key="${line%%=*}"; value="${line#*=}"
        [ "$key" = "DEFAULT" ] && DEFAULT_DISK="$value"
    done < "$CONF_FILE"

    if [ -z "$DEFAULT_DISK" ]; then
        echo "❌ DEFAULT nije definiran u storage.conf"
        exit 1
    fi

    KANALI_LIST=""
    for dir in "$DEFAULT_DISK"/*/; do
        [ -d "$dir" ] || continue
        KANALI_LIST="$KANALI_LIST $(basename "$dir")"
    done
else
    KANALI_LIST="$KANAL"
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   🚛 PREMJEŠTANJE KANALA NA NOVI DISK            ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "   Destinacija: $DEST_BASE"
[ "$DRY_RUN" = true ] && echo "   ⚠️  DRY RUN — ništa se ne briše ni kopira"
[ "$NO_DELETE" = true ] && echo "   ⚠️  --no-delete — original ostaje nakon kopiranja"
echo ""

# --- Pronađi stvarni put kanala (prati symlink) ---
get_real_path() {
    local channel="$1"
    local link="$OUTPUT_DIR/$channel"
    if [ -L "$link" ]; then
        local target
        target="$(readlink "$link")"
        # Ako je relativno, spoji s OUTPUT_DIR
        case "$target" in
            /*) echo "$target" ;;
            *)  echo "$OUTPUT_DIR/$target" ;;
        esac
    elif [ -d "$link" ]; then
        echo "$link"
    else
        echo ""
    fi
}

# --- Ažuriraj storage.conf za kanal ---
update_storage_conf() {
    local channel="$1"
    local new_path="$2"

    # Provjeri postoji li već unos za ovaj kanal
    if grep -q "^${channel}=" "$CONF_FILE" 2>/dev/null; then
        # Zamijeni postojeći unos
        sed -i.bak "s|^${channel}=.*|${channel}=${new_path}|" "$CONF_FILE"
        rm -f "${CONF_FILE}.bak"
        echo "   📝 Ažuriran unos u storage.conf: $channel → $new_path"
    else
        # Dodaj novi unos na kraj
        echo "${channel}=${new_path}" >> "$CONF_FILE"
        echo "   📝 Dodan unos u storage.conf: $channel → $new_path"
    fi
}

# --- Premjesti jedan kanal ---
move_channel() {
    local channel="$1"
    local src
    src="$(get_real_path "$channel")"

    if [ -z "$src" ] || [ ! -d "$src" ]; then
        echo "   ⚠️  Kanal '$channel' ne postoji u $OUTPUT_DIR — preskačem"
        return 0
    fi

    local dest="$DEST_BASE/$channel"

    # Provjeri ne preseljujemo na isti disk
    local src_vol dest_vol
    src_vol="$(echo "$src" | cut -d'/' -f1-3)"
    dest_vol="$(echo "$dest" | cut -d'/' -f1-3)"
    if [ "$src_vol" = "$dest_vol" ]; then
        echo "   ⚠️  $channel je već na $src_vol — preskačem"
        return 0
    fi

    # Veličina izvora
    local size_human
    size_human="$(du -sh "$src" 2>/dev/null | cut -f1)"

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "   📦 Kanal: $channel  ($size_human)"
    echo "   📂 Izvor: $src"
    echo "   📂 Dest:  $dest"
    echo ""

    if [ "$DRY_RUN" = true ]; then
        echo "   [dry-run] rsync -a --progress \"$src/\" \"$dest/\""
        echo "   [dry-run] storage.conf ← $channel=$dest"
        echo "   [dry-run] rm -rf \"$src\""
        echo ""
        return 0
    fi

    # Kreiraj dest direktorij
    mkdir -p "$DEST_BASE"

    # Rsync kopija
    echo "   ⏳ Kopiram s rsync..."
    rsync -a --progress --human-readable "$src/" "$dest/"
    echo ""

    # Verifikacija broja datoteka
    local src_count dest_count
    src_count="$(find "$src" -type f | wc -l | tr -d ' ')"
    dest_count="$(find "$dest" -type f | wc -l | tr -d ' ')"

    if [ "$src_count" != "$dest_count" ]; then
        echo "   ❌ VERIFIKACIJA NEUSPJEŠNA! Izvor: $src_count datoteka, Dest: $dest_count datoteka"
        echo "   ❌ Original nije obrisan. Provjeri ručno: $dest"
        return 1
    fi

    echo "   ✅ Verifikacija OK: $dest_count datoteka"

    # Ažuriraj storage.conf
    update_storage_conf "$channel" "$dest"

    # Obrisi original
    if [ "$NO_DELETE" = false ]; then
        echo "   🗑️  Brišem original: $src"
        rm -rf "$src"
        echo "   ✅ Original obrisan"
    else
        echo "   ℹ️  Original zadržan (--no-delete): $src"
    fi

    echo ""
}

# --- Premjesti sve kanale ---
for channel in $KANALI_LIST; do
    move_channel "$channel"
done

if [ "$DRY_RUN" = false ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "   🔄 Osvježavam symlink strukturu..."
    "$SCRIPT_DIR/setup_storage.sh"
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✅ PREMJEŠTANJE ZAVRŠENO                       ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
