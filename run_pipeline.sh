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
#   7. summarize_gemini.js  — Gemini sumarizacija diariziranih transkripata
#
# PREDUVJETI:
#   - Disk DOMOVINA1TB mountan
#   - LM Studio pokrenut na localhost:1234 (za korak 3)
#   - whisper.cpp binary i model dostupni (za korak 4)
#   - Python 3 + pyannote.audio + HuggingFace token (za korak 5, 6)
#   - gcloud CLI autentificiran (gcloud auth login) — za korak 7, 8 (Vertex AI OAuth)
#
# Primjer:
#   ./run_pipeline.sh --channel domovina_tv --hf-token TVOJ_TOKEN
#   ./run_pipeline.sh --channel domovina_tv --hf-token TVOJ_TOKEN --dry-run
#   ./run_pipeline.sh --hf-token TVOJ_TOKEN  (svi kanali)
#   ./run_pipeline.sh --channel domovina_tv --hf-token TVOJ_TOKEN --threads 8
#   ./run_pipeline.sh --only-summaries                (samo korak 7: sumarizacija)
#   ./run_pipeline.sh --only-articles                 (samo korak 7+8: sumarizacija + članci)
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
#   --hf-token    → samo transcribe_diarized.js + diarize_canary.py
#   --gemini-key  → samo summarize_gemini.js
#   --only-articles   → preskače sve korake (0-6) i vrti samo korak 7 i 8
#   --only-summaries  → preskače sve korake (0-6) i vrti samo korak 7
#   ostalo            → svima (--channel, --dry-run, --output-dir)

COMMON_ARGS=()
WHISPER_ARGS=()
DIARIZE_ARGS=()
GEMINI_KEY=""
ONLY_ARTICLES=false
ONLY_SUMMARIES=false
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
    elif [ "$arg" = "--gemini-key" ]; then
        GEMINI_KEY="${ALL_ARGS[$((i+1))]}"
        i=$((i + 2))
    elif [ "$arg" = "--only-articles" ]; then
        ONLY_ARTICLES=true
        i=$((i + 1))
    elif [ "$arg" = "--only-summaries" ]; then
        ONLY_SUMMARIES=true
        i=$((i + 1))
    else
        COMMON_ARGS+=("$arg")
        i=$((i + 1))
    fi
done

# Whisper dobiva common + threads
WHISPER_ARGS=("${COMMON_ARGS[@]}" "${WHISPER_ARGS[@]}")
# Diarize dobiva common + hf-token
DIARIZE_ARGS=("${COMMON_ARGS[@]}" "${DIARIZE_ARGS[@]}")

# Ekstrakcija output direktorija iz COMMON_ARGS
OUTPUT_DIR="/Volumes/DOMOVINA1TB/fetch_domovina_tv_output"
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--output-dir" ]]; then
        OUTPUT_DIR="${COMMON_ARGS[$((j+1))]}"
        break
    fi
done

if [ "$ONLY_ARTICLES" = false ] && [ "$ONLY_SUMMARIES" = false ]; then

# --- PRE-KORAK: DOWNLOAD NOVIH DIARIZIRANIH TRANSKRIPATA (rclone) ---
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 0/8: Skidanje novih diarisation fajlova s Google Drive-a"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if command -v rclone &> /dev/null; then
    echo "   ⏬ Preuzimam .canary.diarized.srt s Google Drive-a..."
    rclone copy google_drive_ms:domovina_fetch_data/canary_wav "$OUTPUT_DIR" \
      --filter "- ._*" --filter "+ **.canary.**" --filter "- *" \
      --drive-shared-with-me --progress
else
    echo "   ⚠️ Rclone nije instaliran/dostupan, preskačem download..."
fi
echo ""

# --- KORAK 1: PREUZIMANJE I OSVJEŽAVANJE PODCASTA ---
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 1/8: Osvježavanje i preuzimanje podcasta"
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
echo "   📢 KORAK 2/8: Konverzija MP3 → WAV"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/convert_to_wav.js" "${COMMON_ARGS[@]}"

echo ""
# --- POST-KORAK 2: UPLOAD NOVIH WAV I SRT NA DRIVE (rclone) ---
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 2.5: Upload WAV datoteka na Google Drive"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if command -v rclone &> /dev/null; then
    echo "   ⏫ Uploadam nove .wav datoteke na Google Drive..."
    rclone copy "$OUTPUT_DIR/" google_drive_ms:domovina_fetch_data/canary_wav \
      --filter "- ._*" --filter "+ *.wav" --filter "- *" \
      --drive-shared-with-me --progress
else
    echo "   ⚠️ Rclone nije instaliran/dostupan, preskačem upload..."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 3/8: Generiranje Whisper promptova (LLM)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if curl -s --max-time 3 http://localhost:1234/v1/models > /dev/null 2>&1; then
    node "$SCRIPT_DIR/generate_whisper_prompt.js" "${COMMON_ARGS[@]}"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "   📢 KORAK 4/8: Whisper transkripcija"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    node "$SCRIPT_DIR/transcribe.js" "${WHISPER_ARGS[@]}"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "   📢 KORAK 5/8: Diarizacija govornika (pyannote MPS)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    node "$SCRIPT_DIR/transcribe_diarized.js" "${DIARIZE_ARGS[@]}"
else
    echo "⚠️ LM Studio nije pokrenut na localhost:1234 — preskačem korake 3, 4 i 5 (Whisper prompt, transkripcija, diarizacija)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 6/8: Canary Diarizacija govornika (pyannote)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# OUTPUT_DIR je sada ekstraktiran na vrhu skripte znatno ranije.

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

fi # Kraj ONLY_ARTICLES=false && ONLY_SUMMARIES=false bloka

# --- KORAK 7: GEMINI SUMARIZACIJA (Vertex AI OAuth) ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 7/8: Gemini Sumarizacija transkripata"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Vertex AI koristi gcloud OAuth token — ne treba API key
SUMMARIZE_ARGS=("--input-dir" "$OUTPUT_DIR")

# Proslijedi --channel ako postoji u COMMON_ARGS
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--channel" ]]; then
        SUMMARIZE_ARGS+=("--channel" "${COMMON_ARGS[$((j+1))]}")
        break
    fi
done

if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
    SUMMARIZE_ARGS+=("--dry-run")
fi

node "$SCRIPT_DIR/summarize_gemini.js" "${SUMMARIZE_ARGS[@]}"

if [ "$ONLY_SUMMARIES" = true ]; then
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║   ✅ PIPELINE ZAVRŠEN (--only-summaries)         ║"
    echo "╚══════════════════════════════════════════════════╝"
    echo "   ⏱️  Kraj: $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""
    exit 0
fi

# --- KORAK 8: GEMINI GENERIRANJE ČLANAKA (Vertex AI OAuth) ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 8/8: Gemini Generiranje članaka"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Vertex AI koristi gcloud OAuth token — ne treba API key
for CHANNEL_DIR in "$OUTPUT_DIR"/*/; do
    [ -d "$CHANNEL_DIR" ] || continue
    CHANNEL_NAME=$(basename "$CHANNEL_DIR")
    echo "   📂 Kanal: $CHANNEL_NAME"

    for SRT_FILE in "$CHANNEL_DIR"*.canary.diarized.srt; do
        [ -f "$SRT_FILE" ] || continue
        # Preskoči macOS resource fork datoteke
        case "$(basename "$SRT_FILE")" in ._*) continue ;; esac

        echo "   🔄 Generiram članak za: $(basename "$SRT_FILE")"
        node "$SCRIPT_DIR/generate_article_gemini.js" --file "$SRT_FILE" || {
            echo "   ⚠️  Greška pri generiranju članka za $(basename "$SRT_FILE"), nastavljam..."
        }
    done
done

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✅ PIPELINE ZAVRŠEN                            ║"
echo "╚══════════════════════════════════════════════════╝"
echo "   ⏱️  Kraj: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
