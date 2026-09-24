#!/bin/bash
# Probe: zadnjih 60 videa s /videos taba (flat, samo metapodaci) + follower count.
SP="$(cd "$(dirname "$0")" && pwd)"
probe_one() {
  id="$1"; out="$SP/probe/$id.tsv"
  [ -s "$out" ] && return
  /opt/homebrew/bin/yt-dlp --flat-playlist -I 1:60 --extractor-args youtubetab:approximate_date \
    --print "%(duration)s;;%(upload_date)s;;%(id)s;;%(title).90s" \
    --print "playlist:META;;%(channel_follower_count)s;;%(channel)s" \
    "https://www.youtube.com/channel/$id/videos" 2>>"$SP/probe/_errors.log" > "$out.tmp" && mv "$out.tmp" "$out"
  sleep 1
}
export -f probe_one; export SP
node -e 'require(process.argv[1]).forEach(c=>console.log(c.id))' "$SP/new_channels.json" | xargs -P 4 -I{} bash -c 'probe_one "$@"' _ {}
