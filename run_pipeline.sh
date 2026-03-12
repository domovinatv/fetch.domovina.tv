#!/bin/bash

#
# run_pipeline.sh
#
# Pokreće cijeli pipeline za obradu audio zapisa:
#   1. fetch.js             — Osvježavanje i preuzimanje podcasta
#   2. convert_to_wav.js    — MP3 → WAV (16kHz, mono, PCM 16-bit LE)
#   3. generate_whisper_prompt.js — Ekstrakcija ključnih riječi putem LLM-a
#   4. transcribe.js        — Whisper transkripcija → SRT titlovi
#   5. transcribe_diarized.js — Diarizacija govornika (pyannote na MPS)
#   6. diarize_canary.py    — Canary diarizacija govornika (pyannote na MPS/CPU)
#
# PREDUVJETI:
#   - Disk DOMOVINA1TB mountan
#   - LM Studio pokrenut na localhost:1234 (za korak 2)
#   - whisper.cpp binary i model dostupni (za korak 3)
#   - Python 3 + pyannote.audio + HuggingFace token (za korak 4)
#
# Primjer:
#   ./run_pipeline.sh --channel domovina_tv --hf-token TVOJ_TOKEN
#   ./run_pipeline.sh --channel domovina_tv --hf-token TVOJ_TOKEN --dry-run
#   ./run_pipeline.sh --hf-token TVOJ_TOKEN  (svi kanali)
#   ./run_pipeline.sh --channel domovina_tv --hf-token TVOJ_TOKEN --threads 8
#

set -e  # Prekini na prvoj grešci

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   🚀 DOMOVINA.TV AUDIO PIPELINE                 ║"
echo "╚══════════════════════════════════════════════════╝"
echo "   ⏱️  Početak: $(date '+%Y-%m-%d %H:%M:%S')"
echo "   📂 Argumenti: $*"
echo ""

# --- PARSIRANJE ARGUMENATA ---
# Razdvajamo argumente po skriptama:
#   --threads     → samo transcribe.js
#   --hf-token    → samo transcribe_diarized.js
#   ostalo        → svima (--channel, --dry-run, --output-dir)

COMMON_ARGS=()
WHISPER_ARGS=()
DIARIZE_ARGS=()
ALL_ARGS=("$@")
i=0
while [ $i -lt ${#ALL_ARGS[@]} ]; do
    arg="${ALL_ARGS[$i]}"
    if [ "$arg" = "--threads" ]; then
        WHISPER_ARGS+=("$arg" "${ALL_ARGS[$((i+1))]}")
        i=$((i + 2))
    elif [ "$arg" = "--hf-token" ]; then
        DIARIZE_ARGS+=("$arg" "${ALL_ARGS[$((i+1))]}")
        i=$((i + 2))
    else
        COMMON_ARGS+=("$arg")
        i=$((i + 1))
    fi
done

# Whisper dobiva common + threads
WHISPER_ARGS=("${COMMON_ARGS[@]}" "${WHISPER_ARGS[@]}")
# Diarize dobiva common + hf-token
DIARIZE_ARGS=("${COMMON_ARGS[@]}" "${DIARIZE_ARGS[@]}")

# --- KORAK 1: PREUZIMANJE I OSVJEŽAVANJE PODCASTA ---
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 1/6: Osvježavanje i preuzimanje podcasta"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

cd "$SCRIPT_DIR/automatic" || exit 1
./refresh_podcasts.sh

git add .
git commit -m "chore(podcasts): refresh podcast lists" || true
cd "$SCRIPT_DIR" || exit 1

node "$SCRIPT_DIR/fetch.js" "${COMMON_ARGS[@]}"

echo ""

# --- KORAK 2: MP3 → WAV ---
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 2/6: Konverzija MP3 → WAV"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/convert_to_wav.js" "${COMMON_ARGS[@]}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 3/6: Generiranje Whisper promptova (LLM)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/generate_whisper_prompt.js" "${COMMON_ARGS[@]}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 4/6: Whisper transkripcija"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/transcribe.js" "${WHISPER_ARGS[@]}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 5/6: Diarizacija govornika (pyannote MPS)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/transcribe_diarized.js" "${DIARIZE_ARGS[@]}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 6/6: Canary Diarizacija govornika (pyannote)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Ekstrakcija output direktorija iz COMMON_ARGS
OUTPUT_DIR="/Volumes/DOMOVINA1TB/fetch_domovina_tv_output"
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--output-dir" ]]; then
        OUTPUT_DIR="${COMMON_ARGS[$((j+1))]}"
        break
    fi
done

# Ekstrakcija HF tokena iz DIARIZE_ARGS
HF_TOKEN=""
for ((j=0; j<${#DIARIZE_ARGS[@]}; j++)); do
    if [[ "${DIARIZE_ARGS[$j]}" == "--hf-token" ]]; then
        HF_TOKEN="${DIARIZE_ARGS[$((j+1))]}"
        break
    fi
done

CANARY_DRY_RUN=""
if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
    CANARY_DRY_RUN="--dry-run"
fi

if [ -n "$HF_TOKEN" ]; then
    python3 "$SCRIPT_DIR/colab_diarize/diarize_canary.py" --input-dir "$OUTPUT_DIR" --hf-token "$HF_TOKEN" $CANARY_DRY_RUN
else
    echo "⚠️ Preskačem Canary Diarizaciju jer nedostaje HuggingFace token (--hf-token TVOJ_TOKEN)"
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✅ PIPELINE ZAVRŠEN                            ║"
echo "╚══════════════════════════════════════════════════╝"
echo "   ⏱️  Kraj: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
