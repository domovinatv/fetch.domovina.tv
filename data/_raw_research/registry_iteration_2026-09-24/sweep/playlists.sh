#!/bin/bash
# Popis playlista kanala (+ streams tab) za kandidate tipa playlist.
SP="$(cd "$(dirname "$0")" && pwd)"
pl_one() {
  id="$1"; out="$SP/playlists/$id.tsv"; [ -s "$out" ] && return
  /opt/homebrew/bin/yt-dlp --flat-playlist --print "%(id)s;;%(title)s" "https://www.youtube.com/channel/$id/playlists" 2>/dev/null > "$out.tmp"
  echo "--STREAMS" >> "$out.tmp"
  /opt/homebrew/bin/yt-dlp --flat-playlist -I 1:40 --print "%(duration)s;;%(title).70s" "https://www.youtube.com/channel/$id/streams" 2>/dev/null >> "$out.tmp"
  mv "$out.tmp" "$out"; sleep 1
}
export -f pl_one; export SP
cat "$SP/playlist_ids.txt" | xargs -P 4 -I{} bash -c 'pl_one "$@"' _ {}
