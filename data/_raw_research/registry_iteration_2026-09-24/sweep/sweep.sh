#!/bin/bash
# Drugi ciklus yt-dlp search sweepa (2026-09-24). Separator ;; (\t ostaje literal).
SP="$(cd "$(dirname "$0")" && pwd)"
run_one() {
  cat="${1%%|*}"; q="${1#*|}"
  out="$SP/raw/$(echo "$cat-$q" | tr -cd '[:alnum:]-' | cut -c1-70).tsv"
  [ -s "$out" ] && return
  /opt/homebrew/bin/yt-dlp --flat-playlist --print "%(channel)s;;%(channel_id)s;;%(channel_url)s;;%(duration)s;;%(title).80s;;$cat" \
    "ytsearch40:$q" 2>>"$SP/raw/_errors.log" > "$out"
  sleep 1
}
export -f run_one; export SP
grep -v '^#' "$SP/queries.txt" | grep . | xargs -P 4 -I{} bash -c 'run_one "$@"' _ {}
