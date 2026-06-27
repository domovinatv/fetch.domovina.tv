#!/bin/bash
# beamly_video_finish_v2.sh — transcode (SSD output, bez USB thrashinga) → upload → purge → cleanup.
# og-share je već generiran u v1 FAZA 2. Output backfilla NE ide kroz grep (da progres bude vidljiv).
set +e
cd "$(dirname "$0")/.." || exit 1
NOPROXY="env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy"
WEBDIR="/Users/ms/beamly_web_tmp"     # lokalni SSD — izbjegava USB write contention
mkdir -p "$WEBDIR"

echo "━━━ FAZA 3: transcode H.264 (SSD output, concurrency 2) ($(date '+%H:%M:%S')) ━━━"
for ch in subclub launched; do
    echo "  ═══ [$ch] $(date '+%H:%M:%S') ═══"
    $NOPROXY node backfill_video_h264.js --channel "$ch" \
        --web-output-dir "$WEBDIR" --concurrency 2 --rm-local-after-upload
done

echo ""
echo "━━━ FAZA 4: upload thumbnail.png + og-share ($(date '+%H:%M:%S')) ━━━"
for ch in subclub launched; do
    $NOPROXY node upload_to_r2.js --input-dir storage/output --channel "$ch" 2>&1 | grep -aE "⚡|Novih|Uploadano"
done

echo ""
echo "━━━ FAZA 5: CF purge ($(date '+%H:%M:%S')) ━━━"
node purge_beamly_video.js 2>&1 | tail -3

echo ""
echo "━━━ FAZA 6: cleanup source .mp4 ($(date '+%H:%M:%S')) ━━━"
N=$(find -L storage/output/subclub storage/output/launched -maxdepth 1 -name "*.mp4" -not -name "._*" -print -delete 2>/dev/null | wc -l | tr -d ' ')
echo "  obrisano source .mp4: $N"

echo ""
echo "✅ [$(date '+%H:%M:%S')] FINISH-V2 GOTOV."
