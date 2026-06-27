#!/bin/bash
# beamly_video_finish.sh — čeka kraj download_matched_beamly_video.js pa odradi
# preostale faze: og-share → transcode H.264 → upload → CF purge → cleanup source mp4.
# Idempotentno; pokreni nakon (ili paralelno s krajem) batch downloada.
set +e
cd "$(dirname "$0")/.." || exit 1
DL_LOG="automatic/logs/beamly_video_download.log"
NOPROXY="env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy"

echo "⏳ [$(date '+%H:%M:%S')] Čekam kraj downloada..."
for i in $(seq 1 240); do
    grep -qaE "✓ Gotovo:" "$DL_LOG" 2>/dev/null && { echo "✅ download gotov"; break; }
    pgrep -f "download_matched_beamly_video" >/dev/null || { echo "✅ download proces završio"; break; }
    sleep 30
done

echo ""
echo "━━━ FAZA 2: og-share ($(date '+%H:%M:%S')) ━━━"
for ch in subclub launched; do node generate_og_image.js --input-dir storage/output --channel "$ch" 2>&1 | tail -2; done

echo ""
echo "━━━ FAZA 3: transcode H.264 + upload video_h264.mp4 ($(date '+%H:%M:%S')) ━━━"
for ch in subclub launched; do
    echo "  [$ch]"
    $NOPROXY node backfill_video_h264.js --channel "$ch" --rm-local-after-upload 2>&1 | grep -aE "transcode|upload →|SAŽETAK|done:|✗" | tail -8
done

echo ""
echo "━━━ FAZA 4: upload thumbnail.png + og-share ($(date '+%H:%M:%S')) ━━━"
for ch in subclub launched; do
    echo "  [$ch]"
    $NOPROXY node upload_to_r2.js --input-dir storage/output --channel "$ch" 2>&1 | grep -aE "Novih|Uploadano" | tail -3
done

echo ""
echo "━━━ FAZA 5: CF purge ($(date '+%H:%M:%S')) ━━━"
node purge_beamly_video.js 2>&1 | tail -4

echo ""
echo "━━━ FAZA 6: cleanup source .mp4 ($(date '+%H:%M:%S')) ━━━"
N=$(find -L storage/output/subclub storage/output/launched -maxdepth 1 -name "*.mp4" -not -name "._*" -print -delete 2>/dev/null | wc -l | tr -d ' ')
echo "  obrisano source .mp4: $N"

echo ""
echo "✅ [$(date '+%H:%M:%S')] FINISH GOTOV. Video epizoda na R2: provjeri GET-om."
