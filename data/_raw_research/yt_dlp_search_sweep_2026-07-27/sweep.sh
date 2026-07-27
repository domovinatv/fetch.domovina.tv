#!/bin/bash
SP="$1"
run_one() {
  cat="${1%%|*}"; q="${1#*|}"
  out="$SP/sweep/$(echo "$cat-$q" | tr -cd '[:alnum:]-' | cut -c1-60).tsv"
  [ -s "$out" ] && return
  yt-dlp --flat-playlist --print "%(channel)s\t%(channel_url)s\t%(duration)s\t%(title).70s\t$cat" \
    "ytsearch40:$q" 2>/dev/null > "$out"
}
export -f run_one; export SP
xargs -P 6 -I{} bash -c 'run_one "$@"' _ {} < "$SP/queries.txt"
