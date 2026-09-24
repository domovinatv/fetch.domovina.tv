#!/bin/bash
# Probe /streams taba (live podcasti se NE vide na /videos tabu).
SP="$(cd "$(dirname "$0")" && pwd)"
ps_one() {
  id="$1"; out="$SP/probe_streams/$id.tsv"; [ -e "$out" ] && return
  /opt/homebrew/bin/yt-dlp --flat-playlist -I 1:60 --extractor-args youtubetab:approximate_date \
    --print "%(duration)s;;%(upload_date)s;;%(id)s;;%(title).90s" \
    "https://www.youtube.com/channel/$id/streams" 2>/dev/null > "$out.tmp"; mv "$out.tmp" "$out"; sleep 1
}
export -f ps_one; export SP
node -e 'require(process.argv[1]).forEach(c=>console.log(c.id))' "$SP/new_channels.json" | xargs -P 4 -I{} bash -c 'ps_one "$@"' _ {}
