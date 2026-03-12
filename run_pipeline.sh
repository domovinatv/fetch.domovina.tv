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
echo "   📢 KORAK 1/5: Osvježavanje i preuzimanje podcasta"
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
echo "   📢 KORAK 2/5: Konverzija MP3 → WAV"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/convert_to_wav.js" "${COMMON_ARGS[@]}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 3/5: Generiranje Whisper promptova (LLM)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/generate_whisper_prompt.js" "${COMMON_ARGS[@]}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 4/5: Whisper transkripcija"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/transcribe.js" "${WHISPER_ARGS[@]}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 5/5: Diarizacija govornika (pyannote MPS)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/transcribe_diarized.js" "${DIARIZE_ARGS[@]}"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✅ PIPELINE ZAVRŠEN                            ║"
echo "╚══════════════════════════════════════════════════╝"
echo "   ⏱️  Kraj: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
