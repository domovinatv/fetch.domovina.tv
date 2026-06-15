#!/bin/bash
# finalize_backfill_muzevni.sh — JEDINI vlasnik objave (publish) za muzevni_budite backfill.
# Po epizodi (newest->oldest) koja ima .article.magisterium.json:
#   1) PUBLISH-HR (ako nije): upload video magisterium.json + reindex + meta upload  -> HR odmah live
#   2) ako magisterium.en NE postoji: translate EN
#   3) PUBLISH-EN (ako nije): upload video EN + reindex + meta upload                 -> EN overlay live
# Markeri u /tmp/finalize_muzevni_marks/<VID>.{hr,en} sprječavaju ponovni reindex istog koraka.
# Ako trenutno nema epizode za obraditi -> sleep 60 i ponovno (pati iza Magisterium MCP produkcije).
# Izlazi kad SVE epizode iz queue-a imaju .en marker (potpuno objavljene).
set -uo pipefail
cd /Users/ms/git/domovinatv/fetch.domovina.tv
CH=muzevni_budite
LOG=/tmp/finalize_muzevni.log
MARKS=/tmp/finalize_muzevni_marks
mkdir -p "$MARKS"
export VERTEX_REGIONS="${VERTEX_REGIONS:-global}"

VIDS=(JHI8hdCB7nM LHq2vkcG0Mc jtKGRyQLeFA Aov_fOtzYB4 Tt0FN_oPLsQ kCa7edJS-Lo MvZxLBktz6M Ya7G_HL2hTc cJDIasnJ84Q jinHljZFK6w De_gQMB88Ss 1--IUSQILFA pgvvy_xYUmg JV1vYeN5Hus ygZPMqkYQvI fZDla39p32o -bOmDXC7rlA h7BaJ4HwM-s V7qrVZFma1w 3M9Qy8lMGSM LnjTZ39Tsdc bLLXwDlGpA4 06gtEL8DLqI HzkTEwwUnDg HpSfrntR2ww RjIs_1eqtjE UFi8UEjBfhY ra8EXlXtKeQ k_6wWSbz_Jc CYnzinK5hV0 gJAq9OjUe8E Kqof_krcS8U EXx7jiu-Yyg Egt-ZqGqYMw A0oGNWTtTjo cLt3rsMMsdM yVF0Dg7sLpc iXZNbpL-8mk uD0oWjcpWMY wdQt7PJ_qro ejB6y9rs8OI sSyp87-7WNE lWqCNv6azWU 5X5uBiZQKEU pxTGzYkm3DA ZN2liA-JO0M cyIuyFeW11A PkRK1hCAfNs 47iJ13_xHoQ MJP-mcm1cZE qC5x-vRNX-I CQ53RVpbYOs kI9BqEknj3s TZWAqOvefd8 oaTaXMvLj7c BXI9Ds42HyM jrSVj1i9WAg dF4GX-svSYU H4Omb9ReLpo knlvJbEmKV0 xULTVr9d_50 nl4iCxd-VAM eFX2XWJlt00)

f1(){ find -L storage/output/$CH -name "$1" 2>/dev/null | grep -v '/\._' | head -1; }
log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
reindex_and_meta(){ node generate_channel_index.js --channel $CH >>"$LOG" 2>&1; node upload_to_r2.js --meta-dir storage/meta >>"$LOG" 2>&1; }

log "=== drainer start (queue=${#VIDS[@]}) ==="
while true; do
  did=0
  for VID in "${VIDS[@]}"; do
    MAG=$(f1 "*_yt_${VID}*.article.magisterium.json"); [ -z "$MAG" ] && continue
    # 1) PUBLISH-HR
    if [ ! -f "$MARKS/$VID.hr" ]; then
      log ">>> $VID PUBLISH-HR (upload video + reindex + meta)"
      node upload_to_r2.js --input-dir storage/output --video-id "$VID" >>"$LOG" 2>&1
      reindex_and_meta
      c=$(curl -s -o /dev/null -w "%{http_code}" "https://cdn.domovina.ai/data/$VID/article.magisterium.json")
      log "    GET article.magisterium.json -> $c"
      touch "$MARKS/$VID.hr"; did=1; break
    fi
    # 2) translate EN ako fali
    ENMAG=$(f1 "*_yt_${VID}*.article.magisterium.en.json")
    if [ -z "$ENMAG" ]; then
      log ">>> $VID translate EN"
      node translate_to_english.js --input-dir storage/output --video-id "$VID" >>"$LOG" 2>&1
      did=1; break
    fi
    # 3) PUBLISH-EN
    if [ ! -f "$MARKS/$VID.en" ]; then
      log ">>> $VID PUBLISH-EN (upload video + reindex + meta)"
      node upload_to_r2.js --input-dir storage/output --video-id "$VID" >>"$LOG" 2>&1
      reindex_and_meta
      c=$(curl -s -o /dev/null -w "%{http_code}" "https://cdn.domovina.ai/data/$VID/article.magisterium.en.json")
      log "    GET article.magisterium.en.json -> $c"
      touch "$MARKS/$VID.en"; did=1; break
    fi
  done
  if [ "$did" -eq 1 ]; then continue; fi
  # provjeri jesu li sve gotove (svi VID-ovi s magisterium imaju .en marker, i nema vise magisterium bez en marker)
  rem=0
  for VID in "${VIDS[@]}"; do
    MAG=$(f1 "*_yt_${VID}*.article.magisterium.json"); [ -z "$MAG" ] && { rem=$((rem+1)); continue; }
    [ -f "$MARKS/$VID.en" ] || rem=$((rem+1))
  done
  if [ "$rem" -eq 0 ]; then log "=== SVE OBJAVLJENO — drainer exit ==="; break; fi
  log "... cekam (jos $rem epizoda treba Magisterium ili EN); sleep 60"
  sleep 60
done
