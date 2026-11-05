#!/bin/bash
# seed_streams_archive.sh — upiši SVE postojeće livestreamove praćenih kanala u arhivu.
#
# refresh_podcasts.sh od 05.11.2026. uz /videos skenira i /streams. Bez ovog upisa
# prvi bi prolaz povukao cijelu povijest livestreamova (stotine klanjanja, straža…)
# u *-lista.txt, a fetch.js bi ih sve skinuo i obradio = backfill, koji ne želimo
# (CLAUDE.md pravilo 4). Nakon upisa ulaze samo streamovi koji izađu poslije.
#
# Isti postupak kao Ora et Labora (27.10.): poznato → arhiva → --break-on-existing staje.
#
# Upotreba (iz automatic/):
#   tools/seed_streams_archive.sh --dry-run        # samo broji
#   tools/seed_streams_archive.sh                  # svi kanali s /videos URL-om
#   tools/seed_streams_archive.sh 40-dana-za-zivot # jedan kanal (npr. kod onboardinga)
#
# Idempotentno: ID koji je već u arhivi se ne dodaje ponovno. Bash 3 kompatibilno.

cd "$(dirname "$0")/.." || exit 1
OUTPUT_DIR="./podcasts"
DRY=false
SAMO=""
for a in "$@"; do
    case "$a" in
        --dry-run) DRY=true ;;
        *) SAMO="$a" ;;
    esac
done

# Kanali = KANALI iz refresh_podcasts.sh (jedan izvor istine), samo /videos URL-ovi.
STAVKE=$(sed -n '/^KANALI=(/,/^)/p' refresh_podcasts.sh | grep -E '^[[:space:]]*"[^"]+\|https://[^"]+/videos"' | sed -E 's/^[[:space:]]*"([^"]+)".*/\1/')

UKUPNO=0
for stavka in $STAVKE; do
    IME="${stavka%%|*}"
    URL="${stavka#*|}"
    [ -n "$SAMO" ] && [ "$SAMO" != "$IME" ] && continue
    ARHIVA="$OUTPUT_DIR/${IME}-arhiva.txt"
    STREAMS="${URL%/videos}/streams"

    # Najavljeni (is_upcoming) i trenutno živi (is_live) NE idu u arhivu: to su buduće
    # epizode, a arhiva bi ih zauvijek isključila čim postanu snimka.
    IDS=$(yt-dlp --flat-playlist --no-warnings --ignore-errors --print "%(id)s %(live_status)s" "$STREAMS" 2>/dev/null \
        | awk '$2 != "is_upcoming" && $2 != "is_live" {print $1}')
    NOVIH=0
    for id in $IDS; do
        [ ${#id} -eq 11 ] || continue
        if [ -f "$ARHIVA" ] && grep -qx "youtube $id" "$ARHIVA"; then continue; fi
        NOVIH=$((NOVIH + 1))
        [ "$DRY" = true ] || echo "youtube $id" >> "$ARHIVA"
    done
    UKUPNO=$((UKUPNO + NOVIH))
    printf '  %-32s streamova: %4s  upisano u arhivu: %4s\n' "$IME" "$(printf '%s\n' $IDS | grep -c .)" "$NOVIH"
done
echo "Ukupno upisano: $UKUPNO$([ "$DRY" = true ] && echo ' (dry-run, ništa nije zapisano)')"
