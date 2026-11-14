#!/bin/bash
# A/B agy modela za Tier 2 članak (KORAK 8): flash-low vs hydrogen-low vs hydrogen-medium.
# Isti ulaz (canary.diarized.srt + summary + info.json) kopiran u out/<model>/, nikad storage/output.
# Ograda: stani ako agy Gemini 5h prijeđe 60 % (Tier 2 queue troši isti prozor).
cd "$(dirname "$0")/../.." || exit 1
E=experiments/2026-11-15-agy-hydrogen-ab
IDS="HYNJ0Ddwjyw L9JEBGkSokM nToZnW8RHP4"
MODELS="${MODELS:-hydrogen-low flash-low hydrogen-medium}"

usage5h() {
    node -e 'require("./lib/agy_usage").readAgyUsage({maxAgeSec:0}).then(u=>console.log(u?u.gemini_5h:"?"))'
}

for id in $IDS; do
    for m in $MODELS; do
        case $m in
            flash-*) full="gemini-3.8-$m" ;;
            hydrogen-*) full="gemini-4-$m" ;;
        esac
        u=$(usage5h)
        if [ "$u" != "?" ] && [ "${u%.*}" -ge 60 ]; then
            echo "STOP: agy Gemini 5h = $u % (≥60) prije $id/$m"; exit 2
        fi
        srt=$(ls $E/out/$m/*_yt_${id}.wav.canary.diarized.srt)
        echo "=== $id $m ($full) start $(date +%H:%M:%S) gemini_5h=$u"
        t0=$(date +%s)
        GEMINI_BACKEND=agy AGY_ARTICLE_MODEL=$full PRIORITY_SLOT=9 \
            node generate_article_gemini.js --file "$srt" > "$E/out/$m/$id.log" 2>&1
        rc=$?
        echo "=== $id $m rc=$rc trajanje=$(( $(date +%s) - t0 )) s"
        LC_ALL=C grep -a "🔋" "$E/out/$m/$id.log"
    done
done
echo "gotovo $(date +%H:%M:%S)"
