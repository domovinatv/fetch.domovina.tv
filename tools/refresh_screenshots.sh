#!/bin/bash
# Ponovni izbor kadrova OBJAVLJENE epizode kroz Apple Vision + prepis na CDN.
#
#   tools/refresh_screenshots.sh <kanal> <video-id> [timings.txt]
#
# Za epizode čiji su kadrovi uzeti točno na timestampu (prije 26.10.2026.) ili kroz
# agy: zatvorene oči, grimase. Stari kadrovi idu u <volumen>/.reprocess_bak/ (rename,
# nikad delete). Redoslijed: 10 → 9.6 (og bez natpisa preko teksta) → 9.8 EPUB →
# R2 (--force-og --force-screenshots, s purgeom) → WebP + ručni purge (app crta WebP)
# → EPUB na CDN → episode.json. Mjereno 28.10. na nuNw4qWs0r4 (16 kadrova): 83 s.
# Vidi docs/2026-10-26-screenshot-izbor-kadra.md.
CH="$1"; VID="$2"; TIM="${3:-/dev/null}"
[ -n "$CH" ] && [ -n "$VID" ] || { echo "upotreba: $0 <kanal> <video-id> [timings.txt]"; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"; OUT="$REPO/storage/output"
cd "$REPO" || exit 1; set -a; . ./.env; set +a
: > "$TIM"
step() { local n="$1"; shift; local t0=$(date +%s); echo "████ $(date +%T) $n"; "$@"; local rc=$?
  printf "%-30s %4ds rc=%s\n" "$n" "$(( $(date +%s)-t0 ))" "$rc" >> "$TIM"; }
T0=$(date +%s)
SSDIR=$(ls -d "$OUT/$CH"/*_yt_${VID}_screenshots 2>/dev/null | head -1)
[ -n "$SSDIR" ] || { echo "nema $OUT/$CH/*_yt_${VID}_screenshots"; exit 1; }
BAK="$(cd "$OUT/$CH" && pwd -P)/../.reprocess_bak/$CH/${VID}_screenshots_$(date +%Y%m%d%H%M)"
step "sklanjanje starih kadrova" bash -c "mkdir -p '$(dirname "$BAK")' && mv '$SSDIR' '$BAK'"
step "10 izbor kadrova (Vision)" node screenshot_youtube.js --input-dir "$OUT" --channel "$CH" --video-id "$VID" --ignore-r2
step "9.6 og-sections"          python3 generate_og_sections.py --input-dir "$OUT" --channel "$CH" --video-id="$VID" --force
step "9.8 EPUB"                 node generate_ebook.js --input-dir "$OUT" --channel "$CH" --video-id "$VID" --force
step "12 R2 (kadrovi + og)"     node upload_to_r2.js --input-dir "$OUT" --channel "$CH" --video-id "$VID" --force-og --force-screenshots
step "12.65 WebP kadrovi"       node generate_webp_screenshots.js --input-dir "$OUT" --channel "$CH" --video-id "$VID" --force
step "12.66 EPUB na CDN"        node tools/force_upload_epubs.js --changed-only
step "12.7 episode.json"        node build_episode_bundle.js --video-id "$VID"
step "CF purge WebP"            node -e '
const fs=require("fs"),path=require("path");const [dir,vid]=process.argv.slice(1);
const urls=fs.readdirSync(dir).filter(f=>/_\d\d-\d\d-\d\d\.png$/.test(f)).map(f=>`https://cdn.domovina.ai/images/${vid}/screenshots/${f.slice(-12,-4)}-960.webp`);
(async()=>{const t=process.env.DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE;const h={Authorization:`Bearer ${t}`,"Content-Type":"application/json"};
const z=(await (await fetch("https://api.cloudflare.com/client/v4/zones?name=domovina.ai",{headers:h})).json()).result[0].id;
for(const origin of [undefined,"https://domovina.ai"]){const files=urls.map(u=>origin?{url:u,headers:{Origin:origin}}:u);
const r=await (await fetch(`https://api.cloudflare.com/client/v4/zones/${z}/purge_cache`,{method:"POST",headers:h,body:JSON.stringify({files})})).json();console.log("purge",urls.length,origin||"bez Origin",r.success);}})();' "$(ls -d "$OUT/$CH"/*_yt_${VID}_screenshots)" "$VID"
printf "%-30s %4ds\n" "UKUPNO" "$(( $(date +%s)-T0 ))" >> "$TIM"
echo "GOTOVO: $VID za $(( $(date +%s)-T0 )) s (stari kadrovi: $BAK)"
