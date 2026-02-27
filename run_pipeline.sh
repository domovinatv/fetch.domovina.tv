#!/bin/bash

#
# run_pipeline.sh
#
# Pokreće cijeli pipeline za obradu audio zapisa:
#   1. convert_to_wav.js    — MP3 → WAV (16kHz, mono, PCM 16-bit LE)
#   2. generate_whisper_prompt.js — Ekstrakcija ključnih riječi putem LLM-a
#   3. transcribe.js        — Whisper transkripcija → SRT titlovi
#
# PREDUVJETI:
#   - Disk DOMOVINA1TB mountan
#   - LM Studio pokrenut na localhost:1234 (za korak 2)
#   - whisper.cpp binary i model dostupni (za korak 3)
#
# Primjer:
#   ./run_pipeline.sh --channel domovina_tv
#   ./run_pipeline.sh --channel domovina_tv --dry-run
#   ./run_pipeline.sh  (svi kanali)
#   ./run_pipeline.sh --channel domovina_tv --threads 8
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

# --- KORAK 1: MP3 → WAV ---
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 1/3: Konverzija MP3 → WAV"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Proslijedi sve argumente osim --threads (koji je samo za whisper)
WAV_ARGS=()
WHISPER_ARGS=()
ALL_ARGS=("$@")
i=0
while [ $i -lt ${#ALL_ARGS[@]} ]; do
    arg="${ALL_ARGS[$i]}"
    if [ "$arg" = "--threads" ]; then
        WHISPER_ARGS+=("$arg" "${ALL_ARGS[$((i+1))]}")
        i=$((i + 2))
    else
        WAV_ARGS+=("$arg")
        WHISPER_ARGS+=("$arg")
        i=$((i + 1))
    fi
done

node "$SCRIPT_DIR/convert_to_wav.js" "${WAV_ARGS[@]}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 2/3: Generiranje Whisper promptova (LLM)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/generate_whisper_prompt.js" "${WAV_ARGS[@]}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 3/3: Whisper transkripcija"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/transcribe.js" "${WHISPER_ARGS[@]}"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✅ PIPELINE ZAVRŠEN                            ║"
echo "╚══════════════════════════════════════════════════╝"
echo "   ⏱️  Kraj: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
