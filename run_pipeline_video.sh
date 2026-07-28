#!/bin/bash

#
# run_pipeline_video.sh
#
# Pokreće cijeli pipeline za OBRADU JEDNOG VIDEA identificiranog po YouTube
# video ID-u. Za razliku od run_pipeline.sh koji batcha cijeli korpus, ova
# skripta filtrira svaki korak (--video-id) da procesira samo taj jedan video.
#
# Preduvjet: video mora postojati u nekoj automatic/podcasts/*-lista.txt
# datoteci (upiši ručno ako nije tamo). fetch.js skenira sve liste, filtrira
# po video-id i preuzima samo taj.
#
# Koraci (ovisno o flagovima):
#   1. fetch.js               — MP3 + metadata + thumbnail + MKV
#   2. convert_to_wav.js      — MP3 → 16kHz mono WAV
#   6. diarize_canary.py      — lokalna pyannote diarizacija (opt-in --with-local-canary-diarize)
#   7. summarize_gemini.js    — Gemini summary
#   8. generate_article_gemini.js — Gemini članak (outline + sekcije)
#   8.5 enrich_magisterium_full.js — teološka evaluacija v2 (opt-in --with-magisterium)
#   9. prepare_rag_combined.js — RAG chunking
#   10. screenshot_youtube.js  — YouTube frame screenshots (opt-in --with-screenshots)
#   12. upload_to_r2.js        — Cloudflare R2 upload (opt-in --with-r2-upload)
#
# Canary diarizacija: ako SRT ne postoji lokalno, trebaš ili:
#   a) pokrenuti Colab notebook i rclone copy ručno, ili
#   b) proslijediti --with-local-canary-diarize --hf-token TOKEN
#
# Primjeri:
#   ./run_pipeline_video.sh --video-id AaLcQoCunWE
#   ./run_pipeline_video.sh --video-id AaLcQoCunWE --with-magisterium --with-r2-upload
#   ./run_pipeline_video.sh --video-id AaLcQoCunWE --with-screenshots --with-magisterium --with-r2-upload
#   ./run_pipeline_video.sh --video-id AaLcQoCunWE --only-articles --with-magisterium
#   ./run_pipeline_video.sh --video-id AaLcQoCunWE --hf-token TOKEN --with-local-canary-diarize
#   ./run_pipeline_video.sh --video-id AaLcQoCunWE --dry-run
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- STORAGE PROVJERA ---
if [ ! -f "$SCRIPT_DIR/storage/.storage_ready" ]; then
    echo "❌ Storage nije konfiguriran. Pokreni ./setup_storage.sh"
    exit 1
fi

# --- PARSIRANJE ARGUMENATA ---
VIDEO_ID=""
HF_TOKEN=""
ONLY_ARTICLES=false
ONLY_SUMMARIES=false
WITH_LOCAL_CANARY_DIARIZE=false
WITH_SCREENSHOTS=false
WITH_MAGISTERIUM=false
WITH_R2_UPLOAD=false
DRY_RUN=false

ALL_ARGS=("$@")
i=0
while [ $i -lt ${#ALL_ARGS[@]} ]; do
    arg="${ALL_ARGS[$i]}"
    case "$arg" in
        --video-id)
            VIDEO_ID="${ALL_ARGS[$((i+1))]}"
            i=$((i + 2))
            ;;
        --hf-token)
            HF_TOKEN="${ALL_ARGS[$((i+1))]}"
            i=$((i + 2))
            ;;
        --only-articles)
            ONLY_ARTICLES=true
            i=$((i + 1))
            ;;
        --only-summaries)
            ONLY_SUMMARIES=true
            i=$((i + 1))
            ;;
        --with-local-canary-diarize)
            WITH_LOCAL_CANARY_DIARIZE=true
            i=$((i + 1))
            ;;
        --with-screenshots)
            WITH_SCREENSHOTS=true
            i=$((i + 1))
            ;;
        --with-magisterium)
            WITH_MAGISTERIUM=true
            i=$((i + 1))
            ;;
        --with-r2-upload)
            WITH_R2_UPLOAD=true
            i=$((i + 1))
            ;;
        --dry-run)
            DRY_RUN=true
            i=$((i + 1))
            ;;
        *)
            echo "❌ Nepoznat argument: $arg"
            echo "   Pokreni bez argumenata za help."
            exit 1
            ;;
    esac
done

if [ -z "$VIDEO_ID" ]; then
    cat <<EOF
❌ Obavezan argument: --video-id <YouTube_ID>

Primjeri:
  ./run_pipeline_video.sh --video-id AaLcQoCunWE
  ./run_pipeline_video.sh --video-id AaLcQoCunWE --with-magisterium --with-r2-upload
  ./run_pipeline_video.sh --video-id AaLcQoCunWE --with-screenshots --with-magisterium --with-r2-upload
  ./run_pipeline_video.sh --video-id AaLcQoCunWE --only-articles --with-magisterium
  ./run_pipeline_video.sh --video-id AaLcQoCunWE --hf-token TOKEN --with-local-canary-diarize

Flagovi:
  --video-id ID              [obavezno] YouTube 11-znamenkasti video ID
  --hf-token TOKEN           [opcionalno] HuggingFace token (potreban uz --with-local-canary-diarize)
  --with-local-canary-diarize  Lokalna pyannote diarizacija (MPS/CPU intenzivno)
  --with-screenshots         Ekstrakcija frameova iz YouTube videa
  --with-magisterium         Magisterium AI teološka evaluacija v2
  --with-r2-upload           Upload na cdn.domovina.ai
  --only-articles            Preskači korake 1-6, kreni od summarizacije
  --only-summaries           Samo summary (preskoči article, RAG, ostalo)
  --dry-run                  Prikaz bez obrade
EOF
    exit 1
fi

# Validacija video-id formata (11 znakova, alfanum + _ i -)
if ! [[ "$VIDEO_ID" =~ ^[a-zA-Z0-9_-]{11}$ ]]; then
    echo "❌ Nevažeći video ID format: $VIDEO_ID"
    echo "   YouTube video ID ima točno 11 znakova (slova, brojke, _, -)."
    exit 1
fi

OUTPUT_DIR="$SCRIPT_DIR/storage/output"

# Zajednički argumenti za sve node skripte
COMMON_ARGS=("--input-dir" "$OUTPUT_DIR" "--video-id" "$VIDEO_ID")
if [ "$DRY_RUN" = true ]; then
    COMMON_ARGS+=("--dry-run")
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   🎬 SINGLE-VIDEO PIPELINE                      ║"
echo "╚══════════════════════════════════════════════════╝"
echo "   🎯 Video ID:     $VIDEO_ID"
echo "   ⏱️  Početak:      $(date '+%Y-%m-%d %H:%M:%S')"
echo "   📂 Output:       $OUTPUT_DIR"
FLAGS=""
[ "$ONLY_ARTICLES" = true ] && FLAGS="$FLAGS --only-articles"
[ "$ONLY_SUMMARIES" = true ] && FLAGS="$FLAGS --only-summaries"
[ "$WITH_LOCAL_CANARY_DIARIZE" = true ] && FLAGS="$FLAGS --with-local-canary-diarize"
[ "$WITH_SCREENSHOTS" = true ] && FLAGS="$FLAGS --with-screenshots"
[ "$WITH_MAGISTERIUM" = true ] && FLAGS="$FLAGS --with-magisterium"
[ "$WITH_R2_UPLOAD" = true ] && FLAGS="$FLAGS --with-r2-upload"
[ "$DRY_RUN" = true ] && FLAGS="$FLAGS --dry-run"
[ -n "$FLAGS" ] && echo "   🚩 Flagovi:     $FLAGS"
echo ""

# ─── KORACI 1-6 (preskočeni u --only-articles / --only-summaries) ────
if [ "$ONLY_ARTICLES" = false ] && [ "$ONLY_SUMMARIES" = false ]; then

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "   📢 KORAK 1: fetch.js (preuzimanje MP3 + metadata)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    node "$SCRIPT_DIR/fetch.js" "${COMMON_ARGS[@]}"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "   📢 KORAK 2: convert_to_wav.js (MP3 → WAV)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    # convert_to_wav.js koristi --output-dir umjesto --input-dir
    CONVERT_ARGS=("--output-dir" "$OUTPUT_DIR" "--video-id" "$VIDEO_ID")
    [ "$DRY_RUN" = true ] && CONVERT_ARGS+=("--dry-run")
    if ! node "$SCRIPT_DIR/convert_to_wav.js" "${CONVERT_ARGS[@]}"; then
        # Skripta obrađuje točno jedan video — bez WAV-a nema smisla nastavljati
        # (incident 2026-07-28: pun disk → krnji WAV → odrezan transkript i article).
        echo "❌ KORAK 2 nije uspio (konverzija u WAV) — prekidam." >&2
        exit 1
    fi

    # Korak 6: Lokalna Canary diarizacija (opt-in)
    if [ "$WITH_LOCAL_CANARY_DIARIZE" = true ]; then
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "   📢 KORAK 6: Lokalna Canary diarizacija"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        if [ -z "$HF_TOKEN" ]; then
            echo "⚠️  Preskačem Canary diarizaciju — treba --hf-token TOKEN"
        else
            CANARY_DRY=""
            [ "$DRY_RUN" = true ] && CANARY_DRY="--dry-run"
            # diarize_canary.py ne podržava --video-id, ali je idempotentan
            # (provjerava postojanje .canary.diarized.srt). Ako je SRT već tamo
            # preskačen je; inače obradi sve pending WAV-ove u OUTPUT_DIR.
            python3 "$SCRIPT_DIR/colab_diarize/diarize_canary.py" \
                --input-dir "$OUTPUT_DIR" --hf-token "$HF_TOKEN" $CANARY_DRY
        fi
    else
        echo ""
        echo "   ⏭️  Preskačem Canary diarizaciju (nema --with-local-canary-diarize)"
        echo "       Ako nema lokalnog SRT-a, pokreni Colab + rclone ili dodaj flag."
    fi
fi # ONLY_ARTICLES/ONLY_SUMMARIES end

# ─── KORAK 7: SUMMARIZE ─────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 7: summarize_gemini.js"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
node "$SCRIPT_DIR/summarize_gemini.js" "${COMMON_ARGS[@]}"

if [ "$ONLY_SUMMARIES" = true ]; then
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║   ✅ PIPELINE ZAVRŠEN (--only-summaries)         ║"
    echo "╚══════════════════════════════════════════════════╝"
    echo "   ⏱️  Kraj: $(date '+%Y-%m-%d %H:%M:%S')"
    exit 0
fi

# ─── KORAK 8: ARTICLE ───────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 8: generate_article_gemini.js"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
node "$SCRIPT_DIR/generate_article_gemini.js" "${COMMON_ARGS[@]}" || {
    echo "   ⚠️  Greška pri generiranju članka, nastavljam..."
}

# ─── KORAK 8.5: MAGISTERIUM (opt-in) ────────────────────────────────
if [ "$WITH_MAGISTERIUM" = true ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "   📢 KORAK 8.5: enrich_magisterium_full.js (v2)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    node "$SCRIPT_DIR/enrich_magisterium_full.js" "${COMMON_ARGS[@]}" || {
        echo "   ⚠️  Greška pri Magisterium obogaćivanju, nastavljam..."
    }
fi

# ─── KORAK 9: RAG ───────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 9: prepare_rag_combined.js"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
node "$SCRIPT_DIR/prepare_rag_combined.js" "${COMMON_ARGS[@]}"

# ─── KORAK 10: SCREENSHOTS (opt-in) ─────────────────────────────────
if [ "$WITH_SCREENSHOTS" = true ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "   📢 KORAK 10: screenshot_youtube.js"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    node "$SCRIPT_DIR/screenshot_youtube.js" "${COMMON_ARGS[@]}" || {
        echo "   ⚠️  Greška pri screenshotanju, nastavljam..."
    }
fi

# ─── KORAK 12: R2 UPLOAD (opt-in) ───────────────────────────────────
if [ "$WITH_R2_UPLOAD" = true ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "   📢 KORAK 12: upload_to_r2.js"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    node "$SCRIPT_DIR/upload_to_r2.js" "${COMMON_ARGS[@]}" || {
        echo "   ⚠️  Greška pri R2 uploadu, nastavljam..."
    }
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✅ SINGLE-VIDEO PIPELINE ZAVRŠEN              ║"
echo "╚══════════════════════════════════════════════════╝"
echo "   🎯 Video ID: $VIDEO_ID"
echo "   ⏱️  Kraj:     $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
