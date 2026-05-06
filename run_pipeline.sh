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
#   8. generate_article_gemini.js — Gemini generiranje članaka
#   9. prepare_rag_*.js     — RAG priprema (chunkanje i import)
#  10. screenshot_youtube.js — YouTube screenshotovi (samo uz --with-screenshots)
#  11. import_to_vertex.js   — Upload RAG JSONL u Vertex AI Agent Builder
#  12. upload_to_r2.js       — Cloudflare R2 upload (samo uz --with-r2-upload)
#
# PREDUVJETI:
#   - Disk DOMOVINA1TB mountan
#   - LM Studio pokrenut na localhost:1234 (za korak 3)
#   - whisper.cpp binary i model dostupni (za korak 4)
#   - Python 3 + pyannote.audio + HuggingFace token (za korak 5, 6)
#   - gcloud CLI autentificiran (gcloud auth login) — za korak 7, 8 (Vertex AI OAuth)
#
# Primjer:
#   ./run_pipeline.sh --hf-token TVOJ_TOKEN                      (standardni pipeline: fetch + Canary + Gemini)
#   ./run_pipeline.sh --hf-token TVOJ_TOKEN --channel domovina_tv (samo jedan kanal)
#   ./run_pipeline.sh --hf-token TVOJ_TOKEN --dry-run             (prikaz bez obrade)
#   ./run_pipeline.sh --only-summaries                            (samo korak 7: sumarizacija)
#   ./run_pipeline.sh --only-articles                             (samo korak 7+8: sumarizacija + članci)
#   ./run_pipeline.sh --only-articles --with-r2-upload            (članci + R2 upload)
#   ./run_pipeline.sh --hf-token T --with-whisper                 (legacy: uključi Whisper transkripciju)
#   ./run_pipeline.sh --hf-token T --with-local-whisper-diarize    (legacy: uključi lokalnu Whisper diarizaciju)
#

set -e  # Prekini na prvoj grešci

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- PROVJERA STORAGE KONFIGURACIJE ---
if [ ! -f "$SCRIPT_DIR/storage/.storage_ready" ]; then
    echo ""
    echo "❌ Storage nije konfiguriran!"
    echo ""
    echo "   Pokreni:"
    echo "   cp storage.conf.example storage.conf"
    echo "   # Editiraj storage.conf prema svojim diskovima"
    echo "   ./setup_storage.sh"
    echo ""
    exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   🚀 DOMOVINA.TV AUDIO PIPELINE                 ║"
echo "╚══════════════════════════════════════════════════╝"
echo "   ⏱️  Početak: $(date '+%Y-%m-%d %H:%M:%S')"
echo "   📂 Argumenti: $*"
echo "   ☁️  GCP projekt: $(gcloud config get-value project 2>/dev/null || echo 'N/A')"
echo ""

# --- PARSIRANJE ARGUMENATA ---
# Razdvajamo argumente po skriptama:
#   --threads     → samo transcribe.js
#   --hf-token    → samo transcribe_diarized.js + diarize_canary.py
#   --gemini-key  → samo summarize_gemini.js
#   --only-articles       → preskače sve korake (0-6) i vrti samo korak 7 i 8
#   --only-summaries      → preskače sve korake (0-6) i vrti samo korak 7
#   --with-whisper        → uključuje korake 3+4 (legacy Whisper prompt + transkripcija; zahtijeva LM Studio na localhost:1234)
#                            LEGACY: Canary na Google Colab daje značajno bolju kvalitetu transkripcije.
#                            Whisper je zadržan za edge slučajeve kad Colab nije dostupan.
#   --with-local-whisper-diarize → uključuje korak 5 (lokalna Whisper pyannote diarizacija na MPS/Metal; CPU-intenzivno)
#                            UPOZORENJE: Troši značajne resurse na MacMini. Preferirati Canary diarizaciju (korak 6).
#   --with-local-canary-diarize → uključuje korak 6 (lokalna Canary diarizacija putem pyannote; CPU-intenzivno)
#                            Alternativa: Colab T4 GPU diarizacija + rclone sync (korak 0).
#   --with-screenshots    → uključuje korak 10 (YouTube screenshotovi, zahtijeva puno diska)
#   --with-vertex-import  → uključuje korak 11 (Vertex AI RAG import; zahtijeva konfiguriran GCS bucket)
#   --with-r2-upload      → uključuje korak 12 (Cloudflare R2 upload, zahtijeva .env s R2 credentials)
#   --with-magisterium    → uključuje korak 8.5 (Magisterium AI teološko obogaćivanje, zahtijeva MAGISTERIUM_API_KEY)
#   ostalo                → svima (--channel, --dry-run, --output-dir)

COMMON_ARGS=()
WHISPER_ARGS=()
DIARIZE_ARGS=()
GEMINI_KEY=""
ONLY_ARTICLES=false
ONLY_SUMMARIES=false
WITH_WHISPER=false
WITH_LOCAL_WHISPER_DIARIZE=false
WITH_LOCAL_CANARY_DIARIZE=false
WITH_SCREENSHOTS=false
WITH_VERTEX_IMPORT=false
WITH_R2_UPLOAD=false
WITH_MAGISTERIUM=false
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
    elif [ "$arg" = "--with-whisper" ]; then
        WITH_WHISPER=true
        i=$((i + 1))
    elif [ "$arg" = "--with-local-whisper-diarize" ]; then
        WITH_LOCAL_WHISPER_DIARIZE=true
        i=$((i + 1))
    elif [ "$arg" = "--with-local-canary-diarize" ]; then
        WITH_LOCAL_CANARY_DIARIZE=true
        i=$((i + 1))
    elif [ "$arg" = "--with-screenshots" ]; then
        WITH_SCREENSHOTS=true
        i=$((i + 1))
    elif [ "$arg" = "--with-vertex-import" ]; then
        WITH_VERTEX_IMPORT=true
        i=$((i + 1))
    elif [ "$arg" = "--with-r2-upload" ]; then
        WITH_R2_UPLOAD=true
        i=$((i + 1))
    elif [ "$arg" = "--with-magisterium" ]; then
        WITH_MAGISTERIUM=true
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
OUTPUT_DIR="$SCRIPT_DIR/storage/output"
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--output-dir" ]]; then
        OUTPUT_DIR="${COMMON_ARGS[$((j+1))]}"
        break
    fi
done

if [ "$ONLY_ARTICLES" = false ] && [ "$ONLY_SUMMARIES" = false ]; then

# --- PRE-KORAK: DOWNLOAD NOVIH DIARIZIRANIH TRANSKRIPATA (rclone) ---
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 0/10: Skidanje novih diarisation fajlova s Google Drive-a"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if command -v rclone &> /dev/null; then
    echo "   ⏬ Preuzimam .canary.* i .sortformer.* s Google Drive-a..."
    rclone copy google_drive_ms:domovina_fetch_data/canary_wav "$OUTPUT_DIR" \
      -L --filter "- ._*" \
      --filter "+ **.canary.**" \
      --filter "+ **.sortformer.**" \
      --filter "- *" \
      --drive-shared-with-me --progress
else
    echo "   ⚠️ Rclone nije instaliran/dostupan, preskačem download..."
fi
echo ""

# --- KORAK 1: PREUZIMANJE I OSVJEŽAVANJE PODCASTA ---
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 1/10: Osvježavanje i preuzimanje podcasta"
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
echo "   📢 KORAK 2/10: Konverzija MP3 → WAV"
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
      -L --filter "- ._*" --filter "+ *.wav" --filter "- *" \
      --drive-shared-with-me --progress
else
    echo "   ⚠️ Rclone nije instaliran/dostupan, preskačem upload..."
fi

# --- KORACI 3+4: WHISPER PROMPT + TRANSKRIPCIJA (legacy, opcionalno --with-whisper) ---
# LEGACY: Lokalni Whisper daje značajno lošiju kvalitetu od Canary diarizacije na Google Colab.
# Zadržano za edge slučajeve kad Colab nije dostupan ili za usporedbu kvalitete.
# Zahtijeva: LM Studio na localhost:1234 (za prompt) + whisper.cpp binary (za transkripciju)
if [ "$WITH_WHISPER" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 3/10: Generiranje Whisper promptova (LLM) [--with-whisper]"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if curl -s --max-time 3 http://localhost:1234/v1/models > /dev/null 2>&1; then
    node "$SCRIPT_DIR/generate_whisper_prompt.js" "${COMMON_ARGS[@]}"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "   📢 KORAK 4/10: Whisper transkripcija [--with-whisper]"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    node "$SCRIPT_DIR/transcribe.js" "${WHISPER_ARGS[@]}"
else
    echo "⚠️ LM Studio nije pokrenut na localhost:1234 — preskačem Whisper korake (3+4)"
fi
else
    echo ""
    echo "   ⏭️  Preskačem korake 3+4 (Whisper) — nije zadan --with-whisper (legacy, Canary je bolji)"
fi

# --- KORAK 5: LOKALNA WHISPER DIARIZACIJA (legacy, opcionalno --with-local-whisper-diarize) ---
# LEGACY: Lokalna pyannote diarizacija na MPS/Metal troši značajne CPU/GPU resurse na MacMini.
# Preferirati Canary diarizaciju (korak 6) koja se izvršava na Google Colab T4 GPU.
# Zahtijeva: --hf-token + pyannote.audio + MPS/Metal GPU
if [ "$WITH_LOCAL_WHISPER_DIARIZE" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 5/10: Lokalna Whisper diarizacija (pyannote MPS) [--with-local-whisper-diarize]"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

    node "$SCRIPT_DIR/transcribe_diarized.js" "${DIARIZE_ARGS[@]}"
else
    echo "   ⏭️  Preskačem korak 5 (Whisper diarizacija) — nije zadan --with-local-whisper-diarize (CPU-intenzivno)"
fi

# --- KORAK 6: CANARY DIARIZACIJA (opcionalno --with-local-canary-diarize) ---
# Lokalna Canary diarizacija putem pyannote na MPS/CPU. Troši značajne resurse.
# Alternativa: pokrenuti diarizaciju na Google Colab T4 GPU i rclone-om sinkronizirati rezultate (korak 0).
# Zahtijeva: --hf-token + pyannote.audio
if [ "$WITH_LOCAL_CANARY_DIARIZE" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 6/10: Canary Diarizacija govornika (pyannote) [--with-local-canary-diarize]"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

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
else
    echo ""
    echo "   ⏭️  Preskačem korak 6 (Canary diarizacija) — nije zadan --with-local-canary-diarize"
fi

fi # Kraj ONLY_ARTICLES=false && ONLY_SUMMARIES=false bloka

# --- KORAK 7: GEMINI SUMARIZACIJA (Vertex AI OAuth) ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 7/10: Gemini Sumarizacija transkripata"
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
echo "   📢 KORAK 8/10: Gemini Generiranje članaka"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Vertex AI koristi gcloud OAuth token — ne treba API key
# Round-robin obrada: najnoviji videi prvo, ravnomjerno po kanalima
node "$SCRIPT_DIR/generate_article_gemini.js" --input-dir "$OUTPUT_DIR" || {
    echo "   ⚠️  Greška pri batch generiranju članaka, nastavljam..."
}

# --- KORAK 8.5: MAGISTERIUM AI TEOLOŠKO OBOGAĆIVANJE (opcionalno, --with-magisterium) ---
if [ "$WITH_MAGISTERIUM" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 8.5: Magisterium AI — teološko obogaćivanje"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

MAGISTERIUM_ARGS=("--input-dir" "$OUTPUT_DIR")

for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--channel" ]]; then
        MAGISTERIUM_ARGS+=("--channel" "${COMMON_ARGS[$((j+1))]}")
        break
    fi
done

if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
    MAGISTERIUM_ARGS+=("--dry-run")
fi

node "$SCRIPT_DIR/enrich_magisterium_full.js" "${MAGISTERIUM_ARGS[@]}" || {
    echo "   ⚠️  Greška pri Magisterium obogaćivanju, nastavljam..."
}
fi

# --- KORAK 9: RAG PRIPREMA ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 9/11: RAG priprema (chunkanje i import)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/prepare_rag_combined.js" --input-dir "$OUTPUT_DIR"
node "$SCRIPT_DIR/prepare_rag_import.js" --input-dir "$OUTPUT_DIR"
node "$SCRIPT_DIR/prepare_rag.js" --input-dir "$OUTPUT_DIR"

# --- KORAK 10: YOUTUBE SCREENSHOTOVI (opcionalno, --with-screenshots) ---
if [ "$WITH_SCREENSHOTS" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 10/11: YouTube screenshotovi (yt-dlp + ffmpeg)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

SCREENSHOT_ARGS=("--input-dir" "$OUTPUT_DIR")

# Proslijedi --channel ako postoji
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--channel" ]]; then
        SCREENSHOT_ARGS+=("--channel" "${COMMON_ARGS[$((j+1))]}")
        break
    fi
done

if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
    SCREENSHOT_ARGS+=("--dry-run")
fi

node "$SCRIPT_DIR/screenshot_youtube.js" "${SCREENSHOT_ARGS[@]}" || {
    echo "   ⚠️  Greška pri screenshotanju, nastavljam..."
}
fi

# --- KORAK 11: VERTEX AI RAG IMPORT (opcionalno, --with-vertex-import) ---
# Zahtijeva konfiguriran GCS bucket i Vertex AI Data Store.
# Još nije potpuno konfigurirano — uključiti tek kad je infrastruktura spremna.
if [ "$WITH_VERTEX_IMPORT" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 11/11: Vertex AI RAG import (Discovery Engine) [--with-vertex-import]"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -f "$SCRIPT_DIR/.env" ]; then
    VERTEX_IMPORT_ARGS=("--input-dir" "$OUTPUT_DIR")

    # Proslijedi --channel ako postoji
    for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
        if [[ "${COMMON_ARGS[$j]}" == "--channel" ]]; then
            VERTEX_IMPORT_ARGS+=("--channel" "${COMMON_ARGS[$((j+1))]}")
            break
        fi
    done

    if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
        VERTEX_IMPORT_ARGS+=("--dry-run")
    fi

    node "$SCRIPT_DIR/import_to_vertex.js" "${VERTEX_IMPORT_ARGS[@]}" || {
        echo "   ⚠️  Greška pri Vertex AI importu, nastavljam..."
    }
else
    echo "   ⚠️ Preskačem Vertex AI import jer .env nije konfiguriran (vidi .env.example)"
fi
else
    echo ""
    echo "   ⏭️  Preskačem korak 11 (Vertex AI RAG import) — nije zadan --with-vertex-import"
fi

# --- KORAK 12: CLOUDFLARE R2 UPLOAD (opcionalno, --with-r2-upload) ---
if [ "$WITH_R2_UPLOAD" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 12: Cloudflare R2 upload (cdn.domovina.ai)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

R2_UPLOAD_ARGS=("--input-dir" "$OUTPUT_DIR")

# Proslijedi --channel ako postoji
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--channel" ]]; then
        R2_UPLOAD_ARGS+=("--channel" "${COMMON_ARGS[$((j+1))]}")
        break
    fi
done

if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
    R2_UPLOAD_ARGS+=("--dry-run")
fi

node "$SCRIPT_DIR/upload_to_r2.js" "${R2_UPLOAD_ARGS[@]}" || {
    echo "   ⚠️  Greška pri R2 uploadu, nastavljam..."
}
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✅ PIPELINE ZAVRŠEN                            ║"
echo "╚══════════════════════════════════════════════════╝"
echo "   ⏱️  Kraj: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
