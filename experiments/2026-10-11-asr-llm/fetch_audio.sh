#!/usr/bin/env bash
# Skida zvuk test seta (samo audio) → data/audio/{ID}.m4a, pa 16 kHz mono WAV (Modal/pyannote)
# i 64 kbps mono MP3 (upload na cloud ASR). Idempotentno. Za 2 već obrađene epizode
# koristi postojeći MP3 iz storage/output umjesto ponovnog skidanja.
set -u
cd "$(dirname "$0")"
REPO=../..
source "$REPO/automatic/resolve_ytdlp.sh" >/dev/null 2>&1 || true
A=data/audio
tail -n +2 testset.tsv | cut -f1 | while read -r id; do
  [ -s "$A/$id.wav" ] && [ -s "$A/$id.mp3" ] && { echo "preskačem $id"; continue; }
  src=$(node -e 'const fs=require("fs"),p=require("path");const r=process.argv[1]+"/storage/output";for(const c of fs.readdirSync(r)){const d=p.join(r,c);let fl;try{fl=fs.readdirSync(d)}catch{continue}const f=fl.find(x=>x.endsWith("_yt_"+process.argv[2]+".mp3"));if(f){console.log(p.join(d,f));break}}' "$REPO" "$id")
  if [ -z "$src" ]; then
    yt-dlp -q --no-warnings -f bestaudio -o "$A/$id.%(ext)s" -- "https://www.youtube.com/watch?v=$id" || { echo "GREŠKA yt-dlp $id"; continue; }
    src=$(ls "$A/$id".* 2>/dev/null | grep -vE '\.(wav|mp3)$' | head -1)
  fi
  ffmpeg -nostdin -loglevel error -y -i "$src" -ac 1 -ar 16000 -c:a pcm_s16le "$A/$id.wav" || { echo "GREŠKA wav $id"; continue; }
  ffmpeg -nostdin -loglevel error -y -i "$src" -ac 1 -b:a 64k "$A/$id.mp3" || { echo "GREŠKA mp3 $id"; continue; }
  echo "ok $id $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$A/$id.wav" | cut -d. -f1)s"
done
echo "gotovo"
