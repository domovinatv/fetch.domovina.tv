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
#  12.5 backfill_video_h264.js — H.264 cross-platform video → video_h264.mp4 (uz --with-r2-upload)
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
#   ./run_pipeline.sh --hf-token TVOJ_TOKEN --channel domovina_tv (samo jedan kanal — VAŽNO: fetch.js IGNORIRA --channel,
#                                                                  proslijeđuje se samo downstream koracima 7+; korak 1
#                                                                  uvijek obrađuje sve `*-lista.txt`, ali je idempotentan)
#   ./run_pipeline.sh --hf-token TVOJ_TOKEN --dry-run             (prikaz bez obrade)
#   ./run_pipeline.sh --only-summaries                            (samo korak 7: sumarizacija)
#   ./run_pipeline.sh --only-articles                             (samo korak 7+8: sumarizacija + članci)
#   ./run_pipeline.sh --only-articles --with-r2-upload            (članci + R2 upload)
#   ./run_pipeline.sh --hf-token T --with-whisper                 (legacy: uključi Whisper transkripciju)
#   ./run_pipeline.sh --hf-token T --with-local-whisper-diarize    (legacy: uključi lokalnu Whisper diarizaciju)
#   ./run_pipeline.sh --only-articles --gemini-backend cli         (koraci 7+8 preko gemini CLI umjesto Vertex API-ja)
#
# BACKFILL / CATCH-UP WORKFLOW (kad Canary transkripcija ide na Colab batch):
#
#   FAZA A — sada, prije Colab batcha (samo download + WAV):
#     ./run_pipeline.sh --with-screenshots --with-r2-upload
#
#       Bitno: NE dodavati --with-vertex-import u ovoj fazi! Vertex import (korak 11) ima
#       hard chain dependency: Canary `.canary.diarized.srt` → Gemini summary → Gemini
#       article → RAG prep → tek tada vertex import ima što importati. Bez transkripcije
#       svi RAG koraci skipaju nove file-ove, pa je --with-vertex-import no-op ili waste.
#
#       Što se događa u Fazi A: nove epizode prolaze samo do WAV (koraci 0-2). Koraci 7+8
#       su default-on ali skipaju file-ove bez SRT-a, pa rade catch-up za starije epizode
#       kojima nedostaje summary/article. --with-screenshots i --with-r2-upload su
#       independent od transkripcije — rade catch-up za sve epizode koje već imaju article
#       output (screenshots za nedostajuće frameove, R2 push + CDN index refresh).
#
#   FAZA B — nakon što Colab vrati `.canary.srt` u Drive (puni pipeline + publish):
#     ./run_pipeline.sh --hf-token <HF> --with-local-canary-diarize \
#                       --with-screenshots --with-vertex-import --with-r2-upload
#
#       Korak 0 rclone povuče SRT-ove → korak 6 lokalno diarizira → 7+8 generiraju
#       summary i article → 9.5 og-share + 9.7 WebP varijante → 10 thumbnails
#       → 11 RAG u Vertex Agent Builder → 12 R2 publish.
#       Sve idempotentno.
#
# NAPOMENA: korak 1 (refresh + fetch) radi `git add . && git commit -m "chore(podcasts):
# refresh podcast lists" || true` nakon `refresh_podcasts.sh` — to je expected (vidi
# desetke takvih commita u git logu). Ako u trenutku pokretanja imaš uncommit-ane
# promjene koje NE ŽELIŠ pomiješati s podcast list refresh-om, commit ih prije.
#

set -e  # Prekini na prvoj grešci

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── VREMENSKA OS LOGA ────────────────────────────────────────────
# Svaki KORAK banner nosi sat + proteklo vrijeme od početka prolaza.
# Bez ovoga log nema vremensku os pa se ne može utvrditi koji korak troši
# vrijeme: 2026-08-14 su KORAK 0+1 zajedno uzeli 2 h 24 min, a to se moglo
# samo naslutiti iz broja redaka jer timestampa nije bilo.
PIPELINE_T0=$(date +%s)
korak() {
    local el=$(( $(date +%s) - PIPELINE_T0 ))
    printf '   📢 [%s +%02d:%02d:%02d] %s\n' "$(date '+%H:%M:%S')" \
        $((el/3600)) $((el%3600/60)) $((el%60)) "$1"
}

# --- PYTHON INTERPRETER ---
# Pod launchd-om bare `python3` resolva na /usr/bin/python3 (Xcode CLT) koji NEMA
# torch/pyannote → KORAK 6 (diarize_canary.py) pukne s ModuleNotFoundError, a faza B
# stane (nema .diarized.srt → nema summary/article/RAG). Zato eksplicitno biramo
# interpreter koji vidi torch (framework python3.13), s fallbackom na default python3.
PYTHON_BIN="$(command -v python3)"
for _py_cand in \
    /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 \
    "$PYTHON_BIN"; do
    if [ -x "$_py_cand" ] && "$_py_cand" -c "import torch" 2>/dev/null; then
        PYTHON_BIN="$_py_cand"
        break
    fi
done
echo "   🐍 Python interpreter: $PYTHON_BIN"

# --- GCP PROJEKT ZA GEMINI (Vertex AI) ---
# VERTEX_PROJECT env var ima PREDNOST nad gemini.conf u summarize_gemini.js /
# generate_article_gemini.js (proces.env.VERTEX_PROJECT || conf || default).
# Postavljen ovdje da koraci 7+8 (sumarizacija + članci) koriste ovaj projekt.
export VERTEX_PROJECT="project-a275a620-ef0c-45ae-99e"

# --- PROVJERA STAROSTI yt-dlp ---
# yt-dlp se mijenja ~mjesečno prateći YouTube promjene. Zastarjela verzija ne pada
# čitljivo — 2026-08-17 je verzija stara 72 dana davala `HTTP Error 403: Forbidden`
# na video streamu DOK je metadata prolazila normalno. To ne odgovara nijednoj klasi
# u anti-bot dijagnostici i lako se pogrešno pripiše IP bloku (potrošeno vrijeme na
# iPhone tether, koji nije pomogao — update yt-dlp-a je riješio iz prve).
# Zato: provjeri starost PRIJE bilo kakve mrežne dijagnoze.
YT_DLP_MAX_AGE_DAYS="${YT_DLP_MAX_AGE_DAYS:-30}"
YT_DLP_VER="$(yt-dlp --version 2>/dev/null | head -1)"
if [ -n "$YT_DLP_VER" ]; then
    # Verzija je datumska: YYYY.MM.DD[.HHMMSS] → uzmi prva 3 polja.
    YT_DLP_DATE="$(echo "$YT_DLP_VER" | cut -d. -f1-3 | tr '.' '-')"
    YT_DLP_EPOCH="$(date -j -f "%Y-%m-%d" "$YT_DLP_DATE" "+%s" 2>/dev/null || echo "")"
    if [ -n "$YT_DLP_EPOCH" ]; then
        YT_DLP_AGE=$(( ( $(date "+%s") - YT_DLP_EPOCH ) / 86400 ))
        if [ "$YT_DLP_AGE" -gt "$YT_DLP_MAX_AGE_DAYS" ]; then
            echo ""
            echo "   ⚠️  yt-dlp je star $YT_DLP_AGE dana (verzija $YT_DLP_VER, prag ${YT_DLP_MAX_AGE_DAYS}d)."
            echo "      Zastarjeli yt-dlp daje 403 na video stream uz ISPRAVNU metadata —"
            echo "      izgleda kao anti-bot, ali NIJE. Ako KORAK 1/10 padaju, prvo:"
            echo "      /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 -m pip install -U --pre 'yt-dlp[default]'"
            echo ""
        fi
    fi
fi

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
#   --with-speaker-embeddings → uključuje korak 6.5 (TitaNet-Large per-speaker embedding extraction)
#                            Output: *.canary.diarized.embeddings.json pored postojećih SRT-ova.
#                            Konzumira downstream domovina-rag importer za globalnu speaker
#                            entity rezoluciju. Zahtijeva: pip install 'nemo_toolkit[asr]'.
#                            Trošak: ~30-60s po epizodi na M4 Pro MPS.
#   --with-screenshots    → uključuje korak 10 (YouTube screenshotovi, zahtijeva puno diska)
#   --proxy <url>         → proxy za yt-dlp pozive (korak 1 fetch + korak 10 screenshot).
#                            Zaobilazi YouTube IP-level anti-bot block.
#                            Format: socks5://host:port, http://user:pass@host:port.
#
#                            VAŽNO: --proxy treba SAMO ako želiš da konkretno yt-dlp
#                            promet ide preko alternativne IP-e dok ostatak Mac-a
#                            ostaje na Ethernetu. Za sve druge slučajeve postoje
#                            jednostavnije alternative:
#
#                              (A) Najlakše — privremeno prebaci sav Mac promet preko
#                                  iPhone USB tethera (Personal Hotspot via USB):
#                                  System Settings → Network → kotačić → "Set Service
#                                  Order…" → diži iPhone USB iznad Etherneta. Pokreni
#                                  pipeline bez --proxy. Vrati Service Order nakon runa.
#                                  Bez ikakve aplikacije; ~200-500 MB cellular potrošnje
#                                  za 32 epizode na 360p.
#
#                              (B) Per-app proxy preko iPhonea (sav ostatak Mac-a ostaje
#                                  na Ethernetu): iSH Shell (App Store, free) na iPhonu:
#                                    1. apk add microsocks
#                                    2. microsocks -i 0.0.0.0 -p 1080 -q
#                                    3. iPhone Personal Hotspot via USB, WiFi off na iPhonu
#                                    4. Mac vidi iPhone na 172.20.10.1
#                                    5. Verify route nije switchala default na iPhone tether:
#                                       curl -s https://api.ipify.org              # Ethernet IP
#                                       curl -s --socks5 172.20.10.1:1080 https://api.ipify.org   # cellular IP
#                                    6. ./run_pipeline.sh --proxy socks5://172.20.10.1:1080 ...
#                                  iSH može biti suspended u backgroundu — drži iPhone screen on
#                                  ili Guided Access da spriječi sleep tijekom dugih runova.
#   --with-vertex-import  → uključuje korak 11 (Vertex AI RAG import; zahtijeva konfiguriran GCS bucket)
#                            CHAIN DEPENDENCY: traži kompletan upstream lanac
#                            (Canary `.canary.diarized.srt` → Gemini summary → article → RAG prep).
#                            Bez transkripcije nema novih RAG chunkova → flag postaje no-op.
#                            NIKAD ne dodavati u "catch-up while waiting for Colab" pokretanje.
#   --with-r2-upload      → uključuje korak 12 (Cloudflare R2 upload, zahtijeva .env s R2 credentials)
#                            Independent od transkripcije za starije epizode (one koje već imaju
#                            article output) — siguran za "Faza A" catch-up pass uz --with-screenshots.
#   --with-magisterium    → uključuje korak 8.5 (Magisterium AI teološko obogaćivanje, zahtijeva MAGISTERIUM_API_KEY)
#   --with-modal-transcribe → NADOGRADNJA (single-pass): uključuje KORAK 2.6 — transkribira lokalne
#                            WAV-ove na Modal serverless A100-40 GPU-u (modal_canary/canary_modal.py) i
#                            piše .canary.srt lokalno, pa KORAK 6 diarizira odmah u istom runu (bez
#                            Colab/rclone round-tripa). Cap MODAL_MAX_FILES (default 20).
#                            Setup: pip install modal && modal setup &&
#                            modal run modal_canary/canary_modal.py::download_model. Bez flaga = stari put.
#   --modal-scope <s>     → što Modal smije uzeti: unlisted (default, ad-hoc jobovi) |
#                            channels (praćeni kanali: SVAKI WAV bez .canary.srt) | all.
#                            channels = single-pass nightly. Iznad capa → najnovijih MODAL_MAX_FILES
#                            sada, ostatak sljedeći run ili Colab (konvergira, ne odustaje).
#   --with-speechmatics   → EKSPERIMENT (KORAK 2.7): cloud transkripcija + diarizacija u
#                            JEDNOM pozivu preko Speechmatics Batch API-ja, iz .mp3.
#                            Izlaz je odvojen namespace (.speechmatics.*) — produkcijski
#                            .canary.* put se ne dira, korak je non-fatal. Ograđen prozorom
#                            svježine (SPEECHMATICS_FRESH_DAYS=3) i capom
#                            (SPEECHMATICS_MAX_FILES=3). Traži SPEECHMATICS_API_KEY u .env.
#                            Mjerenja: docs/speechmatics_evaluation_2026-09.md
#   --via-iphone          → bind yt-dlp socket na iPhone USB tether IP (172.20.10.x)
#                            bez diranja default route. Auto-detektira IP iz ifconfig-a.
#                            Use case: Ethernet je primarni link (gigabit za rad), ali
#                            YouTube anti-bot block traži drugu izvornu IP-u. Samo yt-dlp
#                            pozivi (fetch.js KORAK 1, screenshot_youtube.js KORAK 10)
#                            idu kroz iPhone; rclone/gcloud/Vertex AI ostaju na Ethernetu.
#                            Alternativa za --proxy bez aplikacije na iPhonu (microsocks).
#                            Napomena: --source-address ne pokriva DNS; DNS ide preko
#                            default resolvera (OK za YouTube anti-bot, njih zanima samo IP).
#   --source-address <IP> → eksplicitni bind na lokalnu IP-u (override za --via-iphone)
#   --gemini-backend <b>  → backend za korake 7+8 (Gemini sumarizacija + članci):
#                            "vertex" (default) — Vertex AI REST + 9-region rotacija, gcloud OAuth.
#                            "cli"             — gemini CLI non-interactive (`gemini -p ...`); koristi
#                                                user-level google login (browser auth). Nema region rotacije.
#                                                Bez 429/5xx retry petlje — CLI ima vlastiti.
#                            "claude"          — Claude Code CLI (`claude -p --model opus`) pod PRETPLATOM.
#                                                Znatno kvalitetniji članci/sažeci, ali sporije i troši
#                                                subscription kvotu (~50-400k input tok/epizoda).
#                                                Koristi za prioritetne/ad-hoc videe, NE za nightly batch.
#                                                Override: CLAUDE_MODEL=opus CLAUDE_EFFORT=high
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
WITH_SPEAKER_EMBEDDINGS=false
WITH_SCREENSHOTS=false
WITH_VERTEX_IMPORT=false
WITH_R2_UPLOAD=false
WITH_MAGISTERIUM=false
# EPUB e-knjige: default ON (nula API troška, ~1.5 s/ep) — gasi se s --no-ebook.
WITH_EBOOK=true
WITH_EBOOK_TRANSCRIPT=false
WITH_MODAL_TRANSCRIBE=false
MODAL_ONLY_ID=""
# --with-speechmatics (2026-09-01): EKSPERIMENTALNI cloud ASR+diarizacija (KORAK 2.7).
# Default OFF. Izlaz ide u odvojen namespace (.speechmatics.*) i NE dira produkciju.
# Dvije tvrde financijske ograde, jer je ovo evaluacija a ne obavezan korak:
#   SPEECHMATICS_FRESH_DAYS (3) — samo svjež priljev; NAMJERNO ne konvergira nad katalogom
#   SPEECHMATICS_MAX_FILES  (3) — pokriva tipičnu noć (medijan priljeva je 2-3 epizode)
# Worst case ≈ 3 × 45 min × $0.80/h ≈ $1.80/noć.
WITH_SPEECHMATICS=false
SPEECHMATICS_FRESH_DAYS="${SPEECHMATICS_FRESH_DAYS:-3}"
SPEECHMATICS_MAX_FILES="${SPEECHMATICS_MAX_FILES:-3}"
# --modal-scope (2026-07-31): koje WAV-ove Modal smije transkribirati.
#   unlisted → samo _unlisted/ (ad-hoc jobovi) — DEFAULT, staro ponašanje, nula regresije
#   channels → praćeni kanali, svaki WAV bez .canary.srt — single-pass nightly
#   all      → oboje
MODAL_SCOPE="${MODAL_SCOPE:-unlisted}"
# DEPRECATED (2026-08-28): mtime prozor je zamijenjen kriterijem stanja ("nema .canary.srt")
# jer je propuštena noć bila trajna — pipeline se nikad nije vraćao na vlastite rupe.
# Varijabla ostaje samo da stari pozivi ne puknu; scan je više ne čita.
MODAL_FRESH_DAYS="${MODAL_FRESH_DAYS:-2}"
SCREENSHOT_PROXY=""
SCREENSHOT_SOURCE_ADDR=""
VIA_IPHONE=false
GEMINI_BACKEND="vertex"
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
    elif [ "$arg" = "--with-speaker-embeddings" ]; then
        WITH_SPEAKER_EMBEDDINGS=true
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
    elif [ "$arg" = "--no-ebook" ]; then
        WITH_EBOOK=false
        i=$((i + 1))
    elif [ "$arg" = "--with-ebook-transcript" ]; then
        # Doslovan prijepis kao dodatak knjige. Opt-in: knjiga time prestaje biti
        # sažetak i postaje potpuni prijepis tuđe snimke.
        WITH_EBOOK_TRANSCRIPT=true
        i=$((i + 1))
    elif [ "$arg" = "--with-modal-transcribe" ]; then
        WITH_MODAL_TRANSCRIBE=true
        i=$((i + 1))
    elif [ "$arg" = "--with-speechmatics" ]; then
        WITH_SPEECHMATICS=true
        i=$((i + 1))
    elif [ "$arg" = "--modal-scope" ]; then
        # unlisted (default, staro ponašanje) | channels (praćeni kanali) | all
        MODAL_SCOPE="${ALL_ARGS[$((i+1))]}"
        i=$((i + 2))
    elif [ "$arg" = "--modal-only" ]; then
        # Prioritetni fast-path: Modal transkribira SAMO ovaj youtube_id (single-video),
        # a Drive-exclude izuzima točno taj WAV (ostali _unlisted i dalje idu na Colab).
        MODAL_ONLY_ID="${ALL_ARGS[$((i+1))]}"
        i=$((i + 2))
    elif [ "$arg" = "--proxy" ]; then
        # --proxy ide ISTODOBNO u screenshot_youtube.js (preko SCREENSHOT_ARGS)
        # I u fetch.js (preko COMMON_ARGS) jer obje yt-dlp pozive treba proxy-jati
        # zbog YouTube IP-level anti-bot blocka. Vidi automatic/cookies_proxy_setup.md.
        SCREENSHOT_PROXY="${ALL_ARGS[$((i+1))]}"
        COMMON_ARGS+=("--proxy" "${ALL_ARGS[$((i+1))]}")
        i=$((i + 2))
    elif [ "$arg" = "--via-iphone" ]; then
        # Auto-detect iPhone USB tether interface (172.20.10.x/28) i bind yt-dlp
        # na tu IP-u preko --source-address. Kernel rutira promet kroz pripadajući
        # interface bez diranja default route — Ethernet ostaje za sav ostali rad.
        # Alternativa za --proxy kad NE želiš dodatnu aplikaciju na iPhonu (microsocks).
        VIA_IPHONE=true
        i=$((i + 1))
    elif [ "$arg" = "--source-address" ]; then
        # Eksplicitni bind na konkretnu lokalnu IP-u (override za --via-iphone auto-detect)
        SCREENSHOT_SOURCE_ADDR="${ALL_ARGS[$((i+1))]}"
        COMMON_ARGS+=("--source-address" "${ALL_ARGS[$((i+1))]}")
        i=$((i + 2))
    elif [ "$arg" = "--gemini-backend" ]; then
        GEMINI_BACKEND="${ALL_ARGS[$((i+1))]}"
        i=$((i + 2))
    else
        COMMON_ARGS+=("$arg")
        i=$((i + 1))
    fi
done

# --- --via-iphone: auto-detect iPhone USB tether IP (172.20.10.0/28) ---
# Apple personal hotspot uvijek dodjeljuje klijentima 172.20.10.2-14 (gateway = .1).
# Ako user pass-a i --via-iphone i --source-address, eksplicitni --source-address pobjeđuje.
if [ "$VIA_IPHONE" = true ]; then
    if [ -n "$SCREENSHOT_SOURCE_ADDR" ]; then
        echo "   📡 --via-iphone ignoriran (eksplicitni --source-address $SCREENSHOT_SOURCE_ADDR ima prednost)"
    else
        # Nađi prvu inet adresu u 172.20.10.x rangeu iz ifconfig outputa
        IPHONE_IP=$(ifconfig 2>/dev/null | awk '/inet 172\.20\.10\./ {print $2; exit}')
        if [ -z "$IPHONE_IP" ]; then
            echo "❌ --via-iphone: nisam našao 172.20.10.x interface u ifconfig outputu."
            echo "   Provjeri:"
            echo "     1. iPhone Personal Hotspot uključen (Settings → Personal Hotspot → Allow Others)"
            echo "     2. iPhone spojen USB-om na Mac (ili 'WiFi: ON' ako koristiš WiFi tether)"
            echo "     3. Sustav vidi interface: ifconfig | grep -B1 172.20.10"
            exit 1
        fi
        SCREENSHOT_SOURCE_ADDR="$IPHONE_IP"
        COMMON_ARGS+=("--source-address" "$IPHONE_IP")
        echo "   📡 --via-iphone: yt-dlp bind-an na $IPHONE_IP (iPhone tether)"
        echo "      Ostatak prometa (rclone, gcloud, Vertex AI) ostaje na default route-u (Ethernet)."
    fi
fi

# Validacija --gemini-backend ("vertex", "cli" ili "claude")
if [ "$GEMINI_BACKEND" != "vertex" ] && [ "$GEMINI_BACKEND" != "cli" ] && [ "$GEMINI_BACKEND" != "claude" ] && [ "$GEMINI_BACKEND" != "agy" ]; then
    echo "❌ Nepoznat --gemini-backend: '$GEMINI_BACKEND' (dozvoljeno: vertex, cli, claude, agy)"
    exit 1
fi

# Ako je --gemini-backend cli, provjeri da je gemini binary dostupan
if [ "$GEMINI_BACKEND" = "cli" ]; then
    if ! command -v gemini &> /dev/null; then
        echo "❌ --gemini-backend cli traži 'gemini' CLI u PATH-u, ali ga nema."
        echo "   Instaliraj: npm install -g @google/gemini-cli"
        exit 1
    fi
    echo "   🤖 Gemini backend: CLI (gemini $(gemini --version 2>/dev/null | head -1))"
elif [ "$GEMINI_BACKEND" = "claude" ]; then
    # Koraci 7+8 idu preko lokalno prijavljenog Claude Code CLI-ja (PRETPLATA, ne API key).
    # Namijenjeno prioritetnim/ad-hoc videima — jedna epizoda troši ~50-400k input tokena,
    # pa cijeli nightly batch na ovome pojede tjednu kvotu.
    if ! command -v claude &> /dev/null; then
        echo "❌ --gemini-backend claude traži 'claude' CLI u PATH-u, ali ga nema."
        exit 1
    fi
    if [ -n "$ANTHROPIC_API_KEY" ]; then
        echo '   ⚠️  ANTHROPIC_API_KEY je postavljen — claude CLI bi mogao naplaćivati per-token'
        echo '      umjesto da koristi pretplatu. Ukloni ga: unset ANTHROPIC_API_KEY'
    fi
    echo "   🧠 LLM backend: Claude Code CLI ($(claude --version 2>/dev/null | head -1)), model=${CLAUDE_MODEL:-opus}"
    echo "      Kvaliteta > brzina. Preporuka: koristi s --priority-video-id / ad-hoc scopeom."
elif [ "$GEMINI_BACKEND" = "agy" ]; then
    if ! command -v agy &> /dev/null; then
        echo "❌ --gemini-backend agy traži 'agy' CLI u PATH-u, ali ga nema."
        exit 1
    fi
    echo "   🧠 LLM backend: Antigravity CLI, model=${AGY_MODEL:-Gemini 3.1 Pro (High)}"
else
    echo "   🤖 Gemini backend: Vertex AI REST (multi-region rotacija)"
fi

# Skripte koraka 7+8 čitaju GEMINI_BACKEND iz okoliša
export GEMINI_BACKEND
# Opcionalni override modela/efforta za --gemini-backend claude (default: opus / high)
[ -n "$CLAUDE_MODEL" ]  && export CLAUDE_MODEL
[ -n "$CLAUDE_EFFORT" ] && export CLAUDE_EFFORT

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

# ─── PRIORITETNI FAST-PATH (single-video ad-hoc) ───────────────────────────────
# MODAL_ONLY_ID postavlja ISKLJUČIVO priority_poller.js (pipeline.domovina.ai bridge)
# za JEDAN enqueani video — nightly bulk ga NIKAD ne postavlja. Kad je aktivan,
# cijeli run je O(1) u tom videu umjesto O(n) skeniranja cijelog kataloga:
#   • preskačemo batch-wide rclone Drive round-tripove (KORAK 0 download, KORAK 2.5
#     upload) — za Modal single-video SRT nastaje lokalno, Drive nema što dati ni primiti
#     (KORAK 2.5 uz --modal-only ionako izuzima baš taj WAV → bio je čista praznina);
#   • preskačemo refresh_podcasts.sh + git commit (KORAK 1) i beamly ingest (1b) —
#     URL je već poznat, 43-kanalni yt-dlp playlist scan je irelevantan;
#   • SVE downstream korake scope-amo na _unlisted/<video-id> (--video-id / --file /
#     --channel _unlisted) → diarize/summary/article/rag/screenshot/r2 diraju 1 fajl,
#     ne stat-aju ~3000.
# Nightly (bez MODAL_ONLY_ID) prolazi kroz sve grane nepromijenjeno.
PRIORITY_FAST_PATH=false
PRIORITY_SCOPE_ARGS=()      # za skripte koje podržavaju --video-id (+ --channel)
PRIORITY_CHANNEL_ARGS=()    # za skripte koje scope-aju samo po --channel
if [ -n "$MODAL_ONLY_ID" ]; then
    PRIORITY_FAST_PATH=true
    PRIORITY_SCOPE_ARGS=(--channel _unlisted --video-id "$MODAL_ONLY_ID")
    PRIORITY_CHANNEL_ARGS=(--channel _unlisted)
    # Screenshotovi su UVIJEK dio single-video fast-patha: članak (KORAK 8) generira
    # timestamp-ove sekcija, a KORAK 10 im vadi frame-ove — bez toga video ide live bez
    # slika. Bulk gate --with-screenshots je opt-in zbog diska/anti-bota na tisućama videa;
    # za JEDAN ad-hoc video taj trošak je zanemariv, pa ga ovdje prisilno palimo (bridge
    # priority_poller.js ne šalje --with-screenshots). Vidi KORAK 10 gate ~L968.
    WITH_SCREENSHOTS=true
    echo ""
    echo "   ⚡ PRIORITETNI FAST-PATH: single-video ad-hoc ($MODAL_ONLY_ID)"
    echo "      → preskačem batch rclone Drive round-tripove + refresh_podcasts (O(n))"
    echo "      → scope-am sve korake na _unlisted/$MODAL_ONLY_ID (O(1))"
    echo "      → screenshotovi (KORAK 10) prisilno ON za ovaj video"
fi

if [ "$ONLY_ARTICLES" = false ] && [ "$ONLY_SUMMARIES" = false ]; then

# --- PRE-KORAK: DOWNLOAD NOVIH DIARIZIRANIH TRANSKRIPATA (rclone) ---
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 0/10: Skidanje novih diarisation fajlova s Google Drive-a"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$PRIORITY_FAST_PATH" = true ]; then
    echo "   ⏭️  FAST-PATH: preskačem Drive download (Modal SRT nastaje lokalno; ~60s + 676 remote checkova za 0 B)."
elif command -v rclone &> /dev/null; then
    echo "   ⏬ Preuzimam .canary.* i .sortformer.* s Google Drive-a..."
    # rclone bypass-a HTTPS_PROXY (telefon-residential-proxy) jer Drive traffic
    # ne treba i ne smije ići kroz cellular tunel — kvari throughput i nije
    # ono što proxy postoji da pruža (proxy je za yt-dlp YouTube IP fingerprint).
    # PERFORMANCE (nightly): --fast-list radi jedno rekurzivno listanje umjesto
    # poziva-po-direktoriju (drastično manje Drive API round-tripova na ~50k objekata).
    # --max-age 30d: nightly samo popunjava NAJNOVIJE (svježi Colab diarized output);
    # stare već-lokalne fajlove ni ne gledamo (nema checking/transfer faze za njih).
    # ZA BACKFILL starijih epizoda: pokreni ručno s RCLONE_MAX_AGE=100y (efektivno
    # bez gornje granice, gleda cijeli Drive).
    env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
    rclone copy google_drive_ms:domovina_fetch_data/canary_wav "$OUTPUT_DIR" \
      -L --filter "- ._*" \
      --filter "- **.loudnorm.**" \
      --filter "+ **.canary.**" \
      --filter "+ **.sortformer.**" \
      --filter "+ **.embeddings.*.json" \
      --filter "- *" \
      --fast-list --max-age "${RCLONE_MAX_AGE:-30d}" \
      --drive-shared-with-me --stats 30s --stats-one-line --stats-log-level NOTICE \
      || echo "   ⚠️ rclone Drive DOWNLOAD nije uspio (kvota/mreža?) — NE-FATALNO (2026-06-08): nastavljam. Publish put (H.264 + reindex) ne smije ovisiti o Colab/Drive syncu."
else
    echo "   ⚠️ Rclone nije instaliran/dostupan, preskačem download..."
fi
echo ""

# --- KORAK 1: PREUZIMANJE I OSVJEŽAVANJE PODCASTA ---
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 1/10: Osvježavanje i preuzimanje podcasta"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$PRIORITY_FAST_PATH" = true ]; then
    echo "   ⏭️  FAST-PATH: preskačem refresh_podcasts.sh + git commit (43-kanalni yt-dlp playlist scan irelevantan za poznati ad-hoc URL)."
else
    cd "$SCRIPT_DIR/automatic" || exit 1
    ./refresh_podcasts.sh

    # Scope-aj git add SAMO na podcast liste — inače bi se launchd plistovi, logovi
    # i drugi runtime artefakti unutar automatic/ kupili u "podcast refresh" commit.
    git add podcasts/
    git commit -m "chore(podcasts): refresh podcast lists" || true
    cd "$SCRIPT_DIR" || exit 1
fi

# fetch.js radi u OBA moda: fast-path preuzima taj jedan --unlisted-url video.
node "$SCRIPT_DIR/fetch.js" "${COMMON_ARGS[@]}"

# --- KORAK 1b: beamly direct-MP3 izvori (Sub Club, Launched) ---
# Ovi RevenueCat podcasti nisu na YouTubeu (slaba pokrivenost), pa idu mimo
# fetch.js: ingest_beamly.mjs čita kataloge iz ~/git/revenuecat/subclub i skida
# direktni MP3 (soundLink) u storage/output/{subclub,launched} u IDENTIČNOM
# formatu kao yt-dlp, pa ostatak pipelinea (od KORAK 2) radi nepromijenjeno.
# NE-FATALNO: ako padne (mreža/repo nedostupan), nastavi s ostalim kanalima.
if [ "$PRIORITY_FAST_PATH" = true ]; then
  echo ""
  echo "   ⏭️  FAST-PATH: preskačem KORAK 1b beamly ingest (ad-hoc job je jedan YouTube URL)."
elif [ -f "$SCRIPT_DIR/ingest_beamly.mjs" ]; then
  echo ""
  echo "   📥 KORAK 1b: beamly direct-MP3 (Sub Club, Launched)"
  node "$SCRIPT_DIR/ingest_beamly.mjs" || echo "   ⚠️ ingest_beamly nije uspio — NE-FATALNO, nastavljam."
fi

echo ""

# --- KORAK 2: MP3 → WAV ---
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 2/10: Konverzija MP3 → WAV"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if ! node "$SCRIPT_DIR/convert_to_wav.js" "${COMMON_ARGS[@]}" "${PRIORITY_SCOPE_ARGS[@]}"; then
    # Fast-path obrađuje točno jedan video — bez njegovog WAV-a svi daljnji
    # koraci su besmisleni (incident 2026-07-28: pun disk → krnji WAV → odrezan
    # transkript i article). U punom runu ne rušimo ostale kanale zbog jednog videa.
    if [ "$PRIORITY_FAST_PATH" = true ]; then
        echo "❌ KORAK 2 nije uspio (konverzija u WAV) — prekidam fast-path run." >&2
        exit 1
    fi
    echo "   ⚠️ KORAK 2 imao grešaka — pogođeni videi neće ići na transkripciju, nastavljam s ostalima."
fi

echo ""

# ─── PRE-2.5: SKUPLJANJE MODAL KANDIDATA (jedini izvor istine) ──────────────────
# RAZLOG (2026-07-31): lista se gradi JEDNOM, prije KORAKA 2.5, pa je koriste i
# rclone exclude (2.5) i Modal petlja (2.6). Bez toga bi 2.5 i 2.6 radili dva
# neovisna scana → WAV koji Modal uzme može u međuvremenu otići i na Drive →
# Colab ga transkribira paralelno (dupli GPU trošak). D1 transcribe claim NE
# pokriva videe praćenih kanala, pa je ovaj filter jedina stvarna zaštita.

# Zadnji _yt_<id> u imenu (naslov SAM može sadržavati _yt_ → greedy .* forsira ZADNJI).
_yt_id_from_name() {
    local name="$1"
    if [[ "$name" =~ .*_yt_([A-Za-z0-9_-]{11})([._]|$) ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
    fi
}

MODAL_PENDING=()
if [ "$WITH_MODAL_TRANSCRIBE" = true ]; then
    MODAL_MAX_FILES="${MODAL_MAX_FILES:-20}"

    # SKEN IDE KROZ NODE, NE KROZ `find` (2026-08-28). Shell `find` je pod launchd-om
    # vraćao `Operation not permitted` na SVAKOM kanalskom direktoriju — macOS TCC ne
    # da `/bin/bash` agentu na vanjske volumene na koje kanali pokazuju symlinkovima.
    # Rezultat: `Modal kandidata: 0` u 26 uzastopnih nightlyja (02.08.–27.08.), a korak
    # je non-fatal pa se rupa tiho gomilala. Node (nvm binary) te iste direktorije čita
    # bez problema — `convert_to_wav.js` ih je cijelo vrijeme uredno skenirao u istom runu.
    #
    # Uz to je maknut mtime gate: kriterij je sada STANJE ("WAV bez .canary.srt"), ne
    # VRIJEME. Stari `-mtime -${MODAL_FRESH_DAYS}` značio je da je propuštena noć trajna —
    # epizoda starija od dva dana više se nikad nije ponudila, pa se pipeline nikad nije
    # vraćao na vlastite rupe. Trošak i dalje ograničava cap (najnovije prvo), a vječno
    # ponavljanje na neispravnom fajlu ograničava brojač pokušaja u storage/.modal_attempts.json.
    # Vidi tools/scan_modal_candidates.js i docs/2026-08-27-nightly-modal-nula-kandidata.md.
    _modal_only_args=()
    [ -n "$MODAL_ONLY_ID" ] && _modal_only_args=(--only-id "$MODAL_ONLY_ID")
    while IFS= read -r w; do
        [ -z "$w" ] && continue
        MODAL_PENDING+=("$w")
    done < <(node "$SCRIPT_DIR/tools/scan_modal_candidates.js" \
                --output-dir "$OUTPUT_DIR" --scope "$MODAL_SCOPE" \
                --max "$MODAL_MAX_FILES" "${_modal_only_args[@]+"${_modal_only_args[@]}"}")

    if [ "${#MODAL_PENDING[@]}" -gt 0 ]; then
        echo "   🎯 Modal scope='$MODAL_SCOPE': ${#MODAL_PENDING[@]} kandidata (cap $MODAL_MAX_FILES)"
        # Pokušaj se broji PRIJE poziva: run koji padne ili bude prekinut mora se
        # svejedno pribrojiti, inače bi crash vječno resetirao brojač.
        # --dry-run ne smije dirati brojač (inače tri dry-runa iscrpe kandidata).
        if [[ ! " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
            node "$SCRIPT_DIR/tools/scan_modal_candidates.js" --record "${MODAL_PENDING[@]}" || true
        fi
    fi
fi

# --- POST-KORAK 2: UPLOAD NOVIH WAV I SRT NA DRIVE (rclone) ---
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 2.5: Upload WAV datoteka na Google Drive"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$PRIORITY_FAST_PATH" = true ]; then
    echo "   ⏭️  FAST-PATH: preskačem WAV upload na Drive (Colab ne obrađuje ovaj video; --modal-only ga je ionako izuzimao → ~60s scan za 0 korisnog transfera)."
elif command -v rclone &> /dev/null; then
    echo "   ⏫ Uploadam nove .wav datoteke na Google Drive..."
    # BELT-AND-SUSPENDERS (2026-07-07): kad je Modal transkripcija aktivna, _unlisted/ WAV-ove
    # transkribira Modal (lokalni A100), a NE Colab batch. Zato ih ISKLJUČI iz Drive uploada da
    # ih Colab fizički ni ne vidi (uz D1 transcribe claim). Bez flaga: default put nepromijenjen.
    # Filter mora doći PRIJE "+ *.wav" (rclone: prvi match pobjeđuje).
    # EXCLUDE SE GRADI IZ MODAL_PENDING (ista lista koju 2.6 stvarno obrađuje) —
    # po videu, ne paušalno po direktoriju. Colab tako fizički ne vidi WAV koji Modal drži.
    RCLONE_MODAL_FILTER=()
    if [ -n "$MODAL_ONLY_ID" ]; then
        # Prioritetni single-video run: izuzmi SAMO taj video (ostali _unlisted → Colab kao inače).
        RCLONE_MODAL_FILTER=(--filter "- *_yt_${MODAL_ONLY_ID}*")
        echo "   🔒 --modal-only ${MODAL_ONLY_ID}: izuzimam samo taj WAV iz Drive uploada (drži ga Modal)."
    elif [ "$WITH_MODAL_TRANSCRIBE" = true ] && [ "${#MODAL_PENDING[@]}" -gt 0 ]; then
        for _w in "${MODAL_PENDING[@]}"; do
            _yid="$(_yt_id_from_name "$(basename "$_w")")"
            if [ -n "$_yid" ]; then
                RCLONE_MODAL_FILTER+=(--filter "- *_yt_${_yid}*")
            else
                # Bez _yt_ ID-a (npr. sintetički beamly nazivi) → izuzmi po punom imenu.
                RCLONE_MODAL_FILTER+=(--filter "- $(basename "$_w")")
            fi
        done
        echo "   🔒 Izuzimam ${#MODAL_PENDING[@]} WAV-ova iz Drive uploada (drži ih Modal, scope='$MODAL_SCOPE')."
    elif [ "$WITH_MODAL_TRANSCRIBE" = true ]; then
        echo "   ↩️  Modal nema kandidata → svi WAV-ovi idu na Drive za Colab kao inače."
    fi
    env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
    rclone copy "$OUTPUT_DIR/" google_drive_ms:domovina_fetch_data/canary_wav \
      -L "${RCLONE_MODAL_FILTER[@]}" --filter "- ._*" --filter "- **.loudnorm.**" --filter "+ *.wav" --filter "- *" \
      --fast-list --max-age "${RCLONE_MAX_AGE:-30d}" \
      --drive-shared-with-me --stats 30s --stats-one-line --stats-log-level NOTICE \
      || echo "   ⚠️ rclone Drive UPLOAD (WAV za Colab) nije uspio (kvota/mreža?) — NE-FATALNO (2026-06-08): nastavljam. Svježi videi svejedno dobiju video_h264.mp4 + reindex u ovom prolazu (Colab Canary samo kasni dok se Drive ne oslobodi)."
else
    echo "   ⚠️ Rclone nije instaliran/dostupan, preskačem upload..."
fi

# --- KORAK 2.6: MODAL ON-DEMAND CANARY TRANSKRIPCIJA (opcionalno --with-modal-transcribe) ---
# NADOGRADNJA (2026-07-07), potpuno backward-compatible: bez ovog flaga ništa se ne
# mijenja (default false → korak se preskače, postojeći Colab/rclone put ostaje netaknut).
#
# Svrha: SINGLE-PASS ad-hoc obrada. Umjesto Colab/rclone round-tripa (upload WAV na
# Drive → čekaj Colab → rclone SRT natrag → sljedeći run), transkribira lokalne WAV-ove
# na Modal serverless A100-40 GPU-u (modal_canary/canary_modal.py) i piše .canary.srt
# POKRAJ WAV-a. KORAK 6 (diarizacija) ga odmah nađe → cijeli run je jednoprolazan.
#
# SIGURNOST OD TROŠKA (bitno): default scope je i dalje SAMO _unlisted (ad-hoc jobovi).
# `--modal-scope channels` (2026-07-31) proširuje ga na praćene kanale, ali TROSTRUKO ograđeno:
#   1. cap MODAL_MAX_FILES (default 20) po runu — bulk nikad ne prođe odjednom
#   2. najnovije-prvo — svjež priljev ima prednost, backlog se troši ostatkom capa
#   3. brojač pokušaja (storage/.modal_attempts.json, 3) — fajl na kojem Modal uvijek
#      puca ispada iz igre umjesto da svaku noć troši mjesto u capu
#   4. rclone exclude iz iste MODAL_PENDING liste (KORAK 2.5) — Colab fizički ne vidi te WAV-ove
# Bulk backlog (tisuće WAV-ova) i dalje ide na Colab G4 — jeftiniji po fajlu na skali;
# Modal ga grize po 20 po runu dok Colab batch ne odradi ostatak.
# PROMJENA 2026-08-28: prije je ovdje bio mtime gate (samo WAV mlađi od 2 dana). Kriterij je
# sada stanje ("nema .canary.srt"), pa svaki run ponovno pokuša ono što prethodni nije uspio.
if [ "$WITH_MODAL_TRANSCRIBE" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 2.6: Modal on-demand Canary transkripcija [--with-modal-transcribe]"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

MODAL_APP="$SCRIPT_DIR/modal_canary/canary_modal.py"

# TRANSCRIBE CLAIM (2026-07-07): prije Modala uzmi lock u pipeline.domovina.ai (D1) da Colab
# Canary batch ne transkribira isti _unlisted WAV paralelno. Sve NE-fatalno: bez key-a ili
# nedostupnog queuea → ponaša se točno kao dosad (transkribira sve pending WAV-ove).
# NAPOMENA: claim NE pokriva videe praćenih kanala (tracked:false → uvijek claimed), pa je
# za scope=channels stvarna zaštita rclone exclude iz KORAKA 2.5 (ista MODAL_PENDING lista).
PIPELINE_QUEUE_BASE="${PIPELINE_QUEUE_BASE:-https://pipeline.domovina.ai}"
# Token: isti PIPELINE_QUEUE_INGEST_KEY koji koristi bridge (claim_and_dispatch.js). Prazan → bez claima.

# Izvorni jezik po kanalu (automatic/channel_languages.conf). Canary NEMA auto-detect —
# default hr→hr; engleski kanali moraju ići en→hr, inače model dobije krivu pretpostavku.
CHANNEL_LANG_CONF="$SCRIPT_DIR/automatic/channel_languages.conf"
_source_lang_for_path() {
    local chan; chan="$(basename "$(dirname "$1")")"
    local lang="hr"
    if [ -f "$CHANNEL_LANG_CONF" ]; then
        local hit
        hit="$(grep -E "^${chan}=" "$CHANNEL_LANG_CONF" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')"
        [ -n "$hit" ] && lang="$hit"
    fi
    printf '%s' "$lang"
}

if ! command -v modal &> /dev/null; then
    echo "   ⚠️ 'modal' CLI nije dostupan — preskačem Modal transkripciju."
    echo "      Setup: pip install modal && modal setup && modal run $MODAL_APP::download_model"
elif [ ! -f "$MODAL_APP" ]; then
    echo "   ⚠️ Nema $MODAL_APP — preskačem Modal transkripciju."
else
    # MODAL_PENDING je izgrađen PRIJE koraka 2.5 (jedini izvor istine — vidi ondje).
    MODAL_N=${#MODAL_PENDING[@]}
    echo "   📋 Modal kandidata (scope='$MODAL_SCOPE'): $MODAL_N"
    if [ "$MODAL_N" -eq 0 ]; then
        echo "   ✅ Ništa za transkribirati (svi WAV-ovi imaju .canary.srt ili su iscrpili pokušaje)."
    elif [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
        echo "   ⚠️ DRY RUN — bili bi transkribirani (bez Modal poziva):"
        for w in "${MODAL_PENDING[@]}"; do echo "      🔄 $(basename "$w")"; done
    else
        for w in "${MODAL_PENDING[@]}"; do
            bn="$(basename "$w")"
            # Claim transcribe lock (samo ako je queue key konfiguriran). Ako ga drži drugi
            # backend (Colab) → preskoči ovaj WAV da izbjegnemo dupli GPU trošak.
            if [ -n "$PIPELINE_QUEUE_INGEST_KEY" ]; then
                yid="$(_yt_id_from_name "$bn")"
                if [ -n "$yid" ]; then
                    claim_resp="$(curl -sS -m 15 -X POST "$PIPELINE_QUEUE_BASE/api/transcription/claim" \
                        -H "Authorization: Bearer $PIPELINE_QUEUE_INGEST_KEY" \
                        -H "content-type: application/json" \
                        -d "{\"youtube_id\":\"$yid\",\"backend\":\"modal\"}" 2>/dev/null || true)"
                    # Preskoči SAMO na eksplicitni claimed:false (Colab drži). Prazan/greška → nastavi (fallback).
                    if printf '%s' "$claim_resp" | grep -q '"claimed":false'; then
                        echo "   ⏭️  Preskačem $bn — transcribe lock drži drugi backend (Colab). [$yid]"
                        continue
                    fi
                fi
            fi
            src_lang="$(_source_lang_for_path "$w")"
            echo "   ⬆️  Modal transkripcija: $bn [${src_lang}→hr]"
            # ::main je OBAVEZAN — canary_modal.py ima više local entrypointa (main/batch/
            # download_model), pa `modal run <file>` bez njega puca s "Specify a Modal Function
            # or local entrypoint". Poziv je non-fatal (|| echo), pa bi inače tiho padao.
            modal run "$MODAL_APP"::main --wav "$w" --source-lang "$src_lang" --target-lang hr \
              || echo "   ⚠️ Modal nije uspio za $bn — nastavljam (non-fatal, KORAK 6 će ga preskočiti bez .canary.srt)."
        done
        echo "   ✅ Modal transkripcija gotova — .canary.srt su lokalno, KORAK 6 (diarize) ih hvata."
    fi
fi
else
    echo ""
    echo "   ⏭️  Preskačem KORAK 2.6 (Modal transkripcija) — nije zadan --with-modal-transcribe (default: Colab/rclone put)"
fi

# --- KORAK 2.7: SPEECHMATICS CLOUD ASR + DIARIZACIJA (eksperiment, --with-speechmatics) ---
# Speechmatics radi transkripciju I diarizaciju u JEDNOM HTTP pozivu, iz .mp3 (bez WAV
# konverzije, bez lokalnog GPU/CPU tereta). Ovo je jedini korak koji bi Mac Mini mogao
# osloboditi kao obavezan stroj — pyannote diarizacija je CPU-bound i vezana za njega.
#
# ⚠️ OVO JE MJERNI INSTRUMENT, NE PRODUKCIJSKI PUT.
#   • Izlaz ide u odvojen namespace .speechmatics.* — `upload_to_r2.js` mapira samo
#     `.canary.diarized.srt`, pa ništa od ovoga ne može završiti na CDN-u.
#   • Korak je NON-FATAL i ne blokira nijedan sljedeći korak.
#   • Nema li SPEECHMATICS_API_KEY → tiho se preskače.
#
# 💰 DVIJE OGRADE, obje financijske (Speechmatics naplaćuje ~$0.80 po satu zvuka):
#   1. prozor svježine (SPEECHMATICS_FRESH_DAYS=3) — NAMJERNO ne konvergira nad
#      katalogom. Bez njega bi po 3 epizode/noć progrizao svih 3 200 epizoda ≈ $2 500.
#      (Suprotno od KORAKA 2.6, gdje je mtime prozor ukinut jer transkripcija MORA
#      konvergirati — vidi docs/2026-08-28-konvergencija-pipelinea.md.)
#   2. cap (SPEECHMATICS_MAX_FILES=3) — medijan noćnog priljeva je 2-3 epizode, pa cap
#      pokriva tipičnu noć i omeđuje skok kad se vuče backlog (viđeno 11-12/dan).
#
# Sken kandidata je u NODEU, ne u shell `find`-u — pod launchd-om `opendir()` na
# vanjskim volumenima pada na macOS TCC-u i tiho vraća nula pogodaka.
# Vidi CLAUDE.md "Ne piši nove shell find/ls petlje nad storage/output/".
if [ "$WITH_SPEECHMATICS" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 2.7: Speechmatics cloud ASR + diarizacija [--with-speechmatics] (EKSPERIMENT)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

SM_SCRIPT="$SCRIPT_DIR/transcribe_speechmatics.js"
# Ključ dolazi iz .env (skripta ga sama učita); ovdje samo provjeravamo postoji li,
# da korak ne bi svaku noć besmisleno prijavljivao grešku na stroju bez ključa.
if ! grep -qE '^\s*SPEECHMATICS_API_KEY\s*=\s*\S' "$SCRIPT_DIR/.env" 2>/dev/null; then
    echo "   ⏭️  Nema SPEECHMATICS_API_KEY u .env — preskačem (eksperiment nije konfiguriran)."
elif [ ! -f "$SM_SCRIPT" ]; then
    echo "   ⚠️ Nema $SM_SCRIPT — preskačem."
else
    SM_ARGS=(--input-dir "$OUTPUT_DIR"
             --fresh-days "$SPEECHMATICS_FRESH_DAYS"
             --limit "$SPEECHMATICS_MAX_FILES")
    if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
        SM_ARGS+=(--dry-run)
    fi
    echo "   🧪 Prozor ${SPEECHMATICS_FRESH_DAYS}d, cap ${SPEECHMATICS_MAX_FILES} epizoda (~\$0.60/ep pri 45 min)"
    node "$SM_SCRIPT" "${SM_ARGS[@]}" \
      || echo "   ⚠️ Speechmatics korak nije uspio — nastavljam (non-fatal, produkcija ne ovisi o njemu)."
fi
else
    echo ""
    echo "   ⏭️  Preskačem KORAK 2.7 (Speechmatics) — nije zadan --with-speechmatics (eksperiment, default OFF)"
fi

# --- KORACI 3+4: WHISPER PROMPT + TRANSKRIPCIJA (legacy, opcionalno --with-whisper) ---
# LEGACY: Lokalni Whisper daje značajno lošiju kvalitetu od Canary diarizacije na Google Colab.
# Zadržano za edge slučajeve kad Colab nije dostupan ili za usporedbu kvalitete.
# Zahtijeva: LM Studio na localhost:1234 (za prompt) + whisper.cpp binary (za transkripciju)
if [ "$WITH_WHISPER" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 3/10: Generiranje Whisper promptova (LLM) [--with-whisper]"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if curl -s --max-time 3 http://localhost:1234/v1/models > /dev/null 2>&1; then
    node "$SCRIPT_DIR/generate_whisper_prompt.js" "${COMMON_ARGS[@]}"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    korak "KORAK 4/10: Whisper transkripcija [--with-whisper]"
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
korak "KORAK 5/10: Lokalna Whisper diarizacija (pyannote MPS) [--with-local-whisper-diarize]"
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
korak "KORAK 6/10: Canary Diarizacija govornika (pyannote) [--with-local-canary-diarize]"
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

# Nadzornik stroja (P3, 2026-08-25). Nightly diarizira u 03:00 bez ikoga za
# tipkovnicom; kad pyannoteova alokacija prelije RAM, macOS raste swap NA
# SISTEMSKOM DISKU i s njim padaju nevezani procesi (Docker daemon zna ostati u
# stanju iz kojeg se diže samo restartom stroja). Nadzornik pretvara najgori
# ishod u "epizoda nije diarizirana". Pragove mijenja env, ne edit koda:
#   DIARIZE_GUARD=off|on|auto   DIARIZE_MIN_FREE_DISK_GB=..   DIARIZE_RSS_CAP_GB=..
# --audio-input (P1) je iza zastavice dok A/B ne potvrdi putanju kao default:
#   DIARIZE_AUDIO_INPUT=path
CANARY_GUARD_ARGS=(--guard "${DIARIZE_GUARD:-auto}")
[ -n "$DIARIZE_MIN_FREE_DISK_GB" ] && CANARY_GUARD_ARGS+=(--min-free-disk-gb "$DIARIZE_MIN_FREE_DISK_GB")
[ -n "$DIARIZE_RSS_CAP_GB" ] && CANARY_GUARD_ARGS+=(--rss-cap-gb "$DIARIZE_RSS_CAP_GB")
[ -n "$DIARIZE_AUDIO_INPUT" ] && CANARY_GUARD_ARGS+=(--audio-input "$DIARIZE_AUDIO_INPUT")

# FAST-PATH: diariziraj SAMO taj jedan WAV (--file) umjesto os.walk cijelog storage/output
# (u batchu "Već diarized: 3047" — stat-a tisuće fajlova samo da nađe jedan novi).
DIARIZE_SCOPE_ARGS=()
if [ "$PRIORITY_FAST_PATH" = true ]; then
    PRIORITY_WAV=$(find -L "$OUTPUT_DIR/_unlisted" -maxdepth 1 -type f -name "*_yt_${MODAL_ONLY_ID}*.wav" ! -name '._*' ! -name '*.loudnorm.*' 2>/dev/null | head -1)
    if [ -n "$PRIORITY_WAV" ]; then
        DIARIZE_SCOPE_ARGS=(--file "$PRIORITY_WAV")
        echo "   ⚡ FAST-PATH: diariziram samo $(basename "$PRIORITY_WAV") (--file, bez skeniranja stabla)."
    else
        echo "   ⚠️ FAST-PATH: nisam našao WAV za $MODAL_ONLY_ID u _unlisted — fallback na puni scan."
    fi
fi

if [ -n "$HF_TOKEN" ]; then
    "$PYTHON_BIN" "$SCRIPT_DIR/colab_diarize/diarize_canary.py" --input-dir "$OUTPUT_DIR" "${DIARIZE_SCOPE_ARGS[@]}" "${CANARY_GUARD_ARGS[@]}" --hf-token "$HF_TOKEN" $CANARY_DRY_RUN
else
    # Bez CLI tokena — diarize_canary.py sam resolve-a token (env HF_TOKEN ili
    # cached ~/.cache/huggingface/token). Omogućava nightly diarizaciju bez da
    # token stoji na command-lineu. Ako baš nema tokena nigdje, skripta sama
    # izađe s uputama (get_hf_token sys.exit).
    "$PYTHON_BIN" "$SCRIPT_DIR/colab_diarize/diarize_canary.py" --input-dir "$OUTPUT_DIR" "${DIARIZE_SCOPE_ARGS[@]}" "${CANARY_GUARD_ARGS[@]}" $CANARY_DRY_RUN
fi
else
    echo ""
    echo "   ⏭️  Preskačem korak 6 (Canary diarizacija) — nije zadan --with-local-canary-diarize"
fi

# --- KORAK 6.5: SPEAKER EMBEDDING EXTRACTION (opcionalno, --with-speaker-embeddings) ---
# Ekstrahira per-speaker voice embeddinge (TitaNet-Large, 192-dim L2-normalized) iz dijariziranih
# WAV-ova. Forward-only inkrementalna obrada — preskače datoteke s postojećim .embeddings.json.
# Output konzumira downstream domovina-rag importer za globalnu speaker entity rezoluciju (vidi
# docs/rag_clickhouse_postgres_plan.md §15).
# Za bulk backfill 2000+ starih epizoda koristi colab_speaker_embeddings/ Jupyter notebook na Colab G4.
if [ "$WITH_SPEAKER_EMBEDDINGS" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 6.5: Speaker embedding extraction (TitaNet-Large) [--with-speaker-embeddings]"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

SPEAKER_EMB_DRY_RUN=""
if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
    SPEAKER_EMB_DRY_RUN="--dry-run"
fi

SPEAKER_EMB_CHANNEL_ARG=""
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--channel" ]]; then
        SPEAKER_EMB_CHANNEL_ARG="--channel ${COMMON_ARGS[$((j+1))]}"
        break
    fi
done

# Modeli koje pokrećemo paralelno (ensemble). Override-aj env varom SPEAKER_EMBEDDING_MODELS.
# Default: titanet + pyannote_wespeaker34 (jedan NeMo + jedan pyannote, različite arhitekture)
SPEAKER_MODELS="${SPEAKER_EMBEDDING_MODELS:-titanet pyannote_wespeaker34}"

run_speaker_embedding_for_source() {
    local source_label="$1"
    for model_key in $SPEAKER_MODELS; do
        echo ""
        echo "   🤖 Model: $model_key (source: $source_label)"
        # Provjera dependency-ja po modelu
        case "$model_key" in
            titanet)
                if ! "$PYTHON_BIN" -c "import nemo.collections.asr" 2>/dev/null; then
                    echo "   ⚠️  NeMo nije instaliran — preskačem $model_key."
                    echo "      Instaliraj: pip3 install 'nemo_toolkit[asr]==2.0.0' soundfile librosa"
                    continue
                fi
                ;;
            pyannote_wespeaker34)
                if ! "$PYTHON_BIN" -c "import pyannote.audio" 2>/dev/null; then
                    echo "   ⚠️  pyannote.audio nije instaliran — preskačem $model_key."
                    continue
                fi
                ;;
        esac

        "$PYTHON_BIN" "$SCRIPT_DIR/colab_speaker_embeddings/extract_speaker_embeddings.py" \
            --input-dir "$OUTPUT_DIR" --source "$source_label" --model "$model_key" \
            $SPEAKER_EMB_CHANNEL_ARG $SPEAKER_EMB_DRY_RUN || {
            echo "   ⚠️  Greška pri $model_key/$source_label, nastavljam s idućim modelom..."
        }
    done
}

# Canary embeddings (sva 2 modela)
run_speaker_embedding_for_source canary

# Sortformer embeddings (ako sortformer SRT-ovi postoje)
if find "$OUTPUT_DIR" -name "*.sortformer.diarized.srt" -print -quit | grep -q .; then
    echo ""
    echo "   🧪 Pronađen sortformer output — ekstrahirаm i tamo embedinge..."
    run_speaker_embedding_for_source sortformer
fi

# Upload novih .embeddings.{model}.json na Drive (paralelno s ostalim canary outputima)
if command -v rclone &> /dev/null; then
    echo ""
    echo "   ⏫ Uploadam .embeddings.*.json na Google Drive..."
    env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
    rclone copy "$OUTPUT_DIR/" google_drive_ms:domovina_fetch_data/canary_wav \
      -L --filter "- ._*" --filter "+ **.embeddings.*.json" --filter "- *" \
      --fast-list --max-age "${RCLONE_MAX_AGE:-30d}" \
      --drive-shared-with-me --stats 30s --stats-one-line --stats-log-level NOTICE
fi
else
    echo ""
    echo "   ⏭️  Preskačem korak 6.5 (speaker embeddings) — nije zadan --with-speaker-embeddings"
fi

fi # Kraj ONLY_ARTICLES=false && ONLY_SUMMARIES=false bloka

# --- KORAK 7: GEMINI SUMARIZACIJA (Vertex AI OAuth) ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 7/10: Gemini Sumarizacija transkripata"
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

node "$SCRIPT_DIR/summarize_gemini.js" "${SUMMARIZE_ARGS[@]}" "${PRIORITY_SCOPE_ARGS[@]}"

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
korak "KORAK 8/10: Gemini Generiranje članaka"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Vertex AI koristi gcloud OAuth token — ne treba API key
# Round-robin obrada: najnoviji videi prvo, ravnomjerno po kanalima
node "$SCRIPT_DIR/generate_article_gemini.js" --input-dir "$OUTPUT_DIR" "${PRIORITY_SCOPE_ARGS[@]}" || {
    echo "   ⚠️  Greška pri batch generiranju članaka, nastavljam..."
}

# --- KORAK 8.5: MAGISTERIUM AI TEOLOŠKO OBOGAĆIVANJE (opcionalno, --with-magisterium) ---
if [ "$WITH_MAGISTERIUM" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 8.5: Magisterium AI — teološko obogaćivanje"
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
korak "KORAK 9/11: RAG priprema (chunkanje i import)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/prepare_rag_combined.js" --input-dir "$OUTPUT_DIR" "${PRIORITY_SCOPE_ARGS[@]}"
node "$SCRIPT_DIR/prepare_rag_import.js" --input-dir "$OUTPUT_DIR" "${PRIORITY_SCOPE_ARGS[@]}"
node "$SCRIPT_DIR/prepare_rag.js" --input-dir "$OUTPUT_DIR" "${PRIORITY_SCOPE_ARGS[@]}"

# --- KORAK 9.4: BEAMLY VIDEO DOWNLOAD (matchane subclub/launched epizode) ---
# Beamly epizode dolaze kao direktni MP3 (audio), bez videa. Matchane (info.json
# _yt_matched===true → _yt_ u imenu je PRAVI YouTube ID) trebaju biti kao normalne
# nightly epizode: video_h264.mp4 + thumbnail.png + og-share. Ova skripta yt-dlp-om
# skine YouTube {base}.mp4 (cap 360p) + {base}.png thumbnail za nove matchane.
#
# RANO (prije 9.5) namjerno: .png/.mp4 moraju postojati prije og-share (9.5),
# thumbnail uploada (12) i H.264 transcode-a (12.5) → SVE u JEDNOM nightlyju (bez
# 1-dnevnog laga). Gateano --with-r2-upload (kao 12.5/12.6) — bez R2 nema smisla.
# Idempotentno (R2 video keys-cache skip + lokalni .mp4 skip + self-clean stale source).
# yt-dlp anti-bot: noću bez tethera očekuj poneki fail — NE-FATALNO (exit 0), retry sutra.
if [ "$WITH_R2_UPLOAD" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 9.4: Beamly video download (matchane subclub/launched)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

BEAMLY_DL_ARGS=("--input-dir" "$OUTPUT_DIR" "--max-height" "360")

# Proslijedi --channel ako postoji (no-op za ne-beamly kanale: nemaju _yt_matched===true)
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--channel" ]]; then
        BEAMLY_DL_ARGS+=("--channel" "${COMMON_ARGS[$((j+1))]}")
        break
    fi
done

if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
    BEAMLY_DL_ARGS+=("--dry-run")
fi

node "$SCRIPT_DIR/download_matched_beamly_video.js" "${BEAMLY_DL_ARGS[@]}" "${PRIORITY_SCOPE_ARGS[@]}" || {
    echo "   ⚠️  Greška pri beamly video downloadu, nastavljam..."
}
fi

# --- KORAK 9.5: OG-SHARE IMAGE GENERIRANJE (social sharing thumbnail varijanta) ---
# Generira {base}.og-share.jpg (1200×630 progressive JPEG q=85, 4:2:0, sRGB, stripped)
# iz postojećeg {base}.png thumbnaila. WhatsApp odbija og:image > 600 KB;
# raw YouTube PNG thumbnaili često idu preko. Cloudflare Worker (web app) preferira
# og-share.jpg, fallback na thumbnail.png.
# Zahtijeva ImageMagick (`magick` binary). Idempotentno.
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 9.5: Generiranje OG-share varijante (1200×630 progressive JPEG q=85)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

OG_IMAGE_ARGS=("--input-dir" "$OUTPUT_DIR")
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--channel" ]]; then
        OG_IMAGE_ARGS+=("--channel" "${COMMON_ARGS[$((j+1))]}")
        break
    fi
done
if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
    OG_IMAGE_ARGS+=("--dry-run")
fi

node "$SCRIPT_DIR/generate_og_image.js" "${OG_IMAGE_ARGS[@]}" "${PRIORITY_CHANNEL_ARGS[@]}" || {
    echo "   ⚠️  Greška pri generiranju OG image varijanti, nastavljam..."
}

# --- KORAK 9.7: IN-APP WEBP THUMBNAIL VARIJANTE ---
# thumbnail.png je 1280×720 PNG (~800 KB) — lista od 20 epizoda u Flutter appu
# povlači ~16 MB. Ista slika kao WebP q80 @320px je ~13 KB (61× manje, mjereno).
# Generiramo 3 fiksne širine unaprijed umjesto on-the-fly resize servisa: katalog
# je fiksan, slike su immutable, a trebaju nam samo 3 dimenzije.
# Vidi docs/2026-08-25-webp-thumbnails.md.
#
# Za razliku od KORAK 9.5 (og-share.jpg) ovo je ISKLJUČIVO za in-app prikaz —
# og:image NAMJERNO ostaje JPEG jer link-preview crawleri WebP ne dokumentiraju.
#
# Zahtijeva ImageMagick (`magick`). Idempotentno.
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 9.7: WebP thumbnail varijante (320/640/1280 q80)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

WEBP_THUMB_ARGS=("--input-dir" "$OUTPUT_DIR")
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--channel" ]]; then
        WEBP_THUMB_ARGS+=("--channel" "${COMMON_ARGS[$((j+1))]}")
        break
    fi
done
if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
    WEBP_THUMB_ARGS+=("--dry-run")
fi

node "$SCRIPT_DIR/generate_webp_thumbs.js" "${WEBP_THUMB_ARGS[@]}" "${PRIORITY_CHANNEL_ARGS[@]}" || {
    echo "   ⚠️  Greška pri generiranju WebP thumbnail varijanti, nastavljam..."
}

# NAPOMENA: KORAK 9.6 (OG-sections) PREMJEŠTEN je NAKON KORAK 10 (screenshotovi) jer
# og-t sekcije reuse-aju screenshot frame-ove. Na single-pass ad-hoc runu 9.6 je prije
# radio PRIJE nego što KORAK 10 proizvede frame-ove → sve sekcije "no-png" → prazan
# manifest → nema og-sections. Sada 9.6 ide poslije 10 pa radi u istom prolazu. Vidi niže.

# --- KORAK 10: YOUTUBE SCREENSHOTOVI (opcionalno, --with-screenshots) ---
if [ "$WITH_SCREENSHOTS" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 10/11: YouTube screenshotovi (yt-dlp + ffmpeg)"
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

if [ -n "$SCREENSHOT_PROXY" ]; then
    SCREENSHOT_ARGS+=("--proxy" "$SCREENSHOT_PROXY")
fi

if [ -n "$SCREENSHOT_SOURCE_ADDR" ]; then
    SCREENSHOT_ARGS+=("--source-address" "$SCREENSHOT_SOURCE_ADDR")
fi

node "$SCRIPT_DIR/screenshot_youtube.js" "${SCREENSHOT_ARGS[@]}" "${PRIORITY_SCOPE_ARGS[@]}" || {
    echo "   ⚠️  Greška pri screenshotanju, nastavljam..."
}
fi

# --- KORAK 9.6: OG-SECTIONS COMPOSITE GENERIRANJE (Tier B per-section social images) ---
# (Premješteno NAKON KORAK 10 — vidi napomenu gore.) Generira
# {channel}/{base}.og-sections/og-t-{sec}.jpg za svaki section iz article.json.
# Worker u domovina.ai (web/_worker.js) koristi ih za /v/<ytId>/t/<sec> share URL-ove —
# bira section-start ključ <= tSec iz og-sections.json manifest-a i override-a og:image.
# Reuse-a {base}_screenshots/{base}_{HH-MM-SS}.png frame-ove (KORAK 10 output, sada gotovi);
# composite dodaje gradient + section subtitle + episode title + DOMOVINA brand bar.
# 1200×630 progressive JPEG q=85, idempotent (mtime check vs article.json + source PNG).
# Skip kriteriji: no article, no sections, duration<60s, >250 sections, missing source PNG.
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 9.6: Generiranje OG-sections composite-a (per-section Tier B)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

OG_SECTIONS_ARGS=("--input-dir" "$OUTPUT_DIR")
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--channel" ]]; then
        OG_SECTIONS_ARGS+=("--channel" "${COMMON_ARGS[$((j+1))]}")
        break
    fi
done
if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
    OG_SECTIONS_ARGS+=("--dry-run")
fi

"$PYTHON_BIN" "$SCRIPT_DIR/generate_og_sections.py" "${OG_SECTIONS_ARGS[@]}" "${PRIORITY_CHANNEL_ARGS[@]}" || {
    echo "   ⚠️  Greška pri generiranju OG-sections composite-a, nastavljam..."
}

# --- KORAK 9.8: EPUB E-KNJIGA (generate_ebook.js) ---
# Slaže {channel}/{base}.epub iz onoga što KORACI 7-10 već ostavili na disku:
# article.json (poglavlja + sekcije), summary.json (sažetak, govornici),
# magisterium.json (teološki dodatak) i {base}_screenshots/ (ilustracije).
# NULA API poziva — čist CPU, ~1.5 s po epizodi, ~1.8 MB izlaza. Zato je
# bezuvjetan kao 9.5/9.6/9.7, a ne iza --with-* gatea; gasi se s --no-ebook.
# MORA ići nakon KORAK 10 (screenshotovi) — bez frame-ova knjiga izađe bez slika,
# a .epub postoji pa se idući run preskoči. Isti razlog zbog kojeg je 9.6 premješten.
# Doslovan prijepis NIJE u knjizi po defaultu (--with-ebook-transcript) — vidi
# docs/ebook_epub_pipeline.md §4 zašto je to opt-in.
if [ "$WITH_EBOOK" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 9.8: EPUB e-knjige (article.json + screenshotovi → .epub)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

EBOOK_ARGS=("--input-dir" "$OUTPUT_DIR")
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--channel" ]]; then
        EBOOK_ARGS+=("--channel" "${COMMON_ARGS[$((j+1))]}")
        break
    fi
done
if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
    EBOOK_ARGS+=("--dry-run")
fi
if [ "$WITH_EBOOK_TRANSCRIPT" = true ]; then
    EBOOK_ARGS+=("--with-transcript")
fi

node "$SCRIPT_DIR/generate_ebook.js" "${EBOOK_ARGS[@]}" "${PRIORITY_SCOPE_ARGS[@]}" || {
    echo "   ⚠️  Greška pri generiranju EPUB-a, nastavljam..."
}
else
    echo ""
    echo "   ⏭️  Preskačem KORAK 9.8 (EPUB e-knjige) — zadan je --no-ebook"
fi

# --- KORAK 11: VERTEX AI RAG IMPORT (opcionalno, --with-vertex-import) ---
# Zahtijeva konfiguriran GCS bucket i Vertex AI Data Store.
# Još nije potpuno konfigurirano — uključiti tek kad je infrastruktura spremna.
if [ "$WITH_VERTEX_IMPORT" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 11/11: Vertex AI RAG import (Discovery Engine) [--with-vertex-import]"
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
korak "KORAK 12: Cloudflare R2 upload (cdn.domovina.ai)"
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

# R2 upload eksplicitno zaobilazi telefon-residential-proxy. @aws-sdk/client-s3
# ionako ne honora HTTPS_PROXY env var po defaultu, ali ako se ikad zamijeni
# transport sloj, ovaj env -u garantira da R2 put nije ovisan o proxyju.
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
node "$SCRIPT_DIR/upload_to_r2.js" "${R2_UPLOAD_ARGS[@]}" "${PRIORITY_SCOPE_ARGS[@]}" || {
    echo "   ⚠️  Greška pri R2 uploadu, nastavljam..."
}
fi

# --- KORAK 12.5: H.264 CROSS-PLATFORM VIDEO (video_h264.mp4) ---
# upload_to_r2.js (KORAK 12) puni LEGACY data/{id}/video.mp4 remuxom `-c:v copy` koji
# zadrži izvorni VP9/AV1 codec → ne svira na Safari/iOS web ni starijim TV-ima bez AV1 HW
# (~84% kataloga). Ovaj korak transkodira u STVARNI H.264 (Main L3.1, yuv420p, AAC + faststart;
# libx264 crf30 + EQ + loudnorm) i uploada pod VERZIONIRANI ključ data/{id}/video_h264.mp4 —
# isti koji Flutter probe-a (cdn_config.dart videoH264Url, fallback na video.mp4 ako 404).
# Idempotentno (HEAD-skip + web.mp4 mtime). BEZ --delete-old (additivno; legacy video.mp4
# ostaje fallback dok backfill ne bude validiran catalog-wide). SSOT recepta = ova skripta.
# Vidi docs/video_crossplatform_strategy_2026-06.md.
if [ "$WITH_R2_UPLOAD" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 12.5: H.264 cross-platform video (video_h264.mp4)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# --rm-local-after-upload: web.mp4 je tranzijentan (R2 je durable); briše se odmah po
# uploadu da ne napuni disk (DOMOVINA1TB je tijesan). Re-run idempotentan preko R2 HEAD-skipa.
# --web-output-dir: transcode piše web.mp4 na LOKALNI SSD, ne pored sourcea na DOMOVINA*TB
# (USB). Source čitanje s USB + web pisanje na USB pri concurrency 2 = I/O thrashing (memory
# ffmpeg_batch_low_concurrency_on_usb); pisanje na SSD to izbjegava. Transijentan (--rm-local).
H264_WEB_TMP="${H264_WEB_TMP_DIR:-$HOME/.cache/domovina_web_mp4_tmp}"
mkdir -p "$H264_WEB_TMP"
H264_ARGS=("--input-dir" "$OUTPUT_DIR" "--rm-local-after-upload" "--web-output-dir" "$H264_WEB_TMP")

# Proslijedi --channel ako postoji (isti pattern kao KORAK 12)
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--channel" ]]; then
        H264_ARGS+=("--channel" "${COMMON_ARGS[$((j+1))]}")
        break
    fi
done

if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
    H264_ARGS+=("--dry-run")
fi

# Isti proxy-bypass kao R2 upload (S3 PUT ne smije kroz telefon-residential-proxy).
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
node "$SCRIPT_DIR/backfill_video_h264.js" "${H264_ARGS[@]}" "${PRIORITY_SCOPE_ARGS[@]}" || {
    echo "   ⚠️  Greška pri H.264 transcode/uploadu, nastavljam..."
}
fi

# --- KORAK 12.6: AUDIO-ONLY .mp3 UPLOAD (uz --with-r2-upload) ---
# Audio-only epizode (info.json _yt_matched===false — beamly subclub/launched bez
# YouTube matcha) NEMAJU video → backfill_video_h264 im ne može napraviti video_h264.mp4.
# Da player ima što svirati, ova skripta uploada izvorni .mp3 → data/{id}/audio.mp3.
# Idempotentno (keys-cache skip). No-op za YouTube kanale (nemaju _yt_matched===false).
# CONSUMER (domovina.ai): treba audio fallback u data_service.dart. Vidi docs/data_contract.md.
if [ "$WITH_R2_UPLOAD" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 12.6: Audio-only .mp3 upload (data/{id}/audio.mp3)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

AUDIO_ONLY_ARGS=("--input-dir" "$OUTPUT_DIR")
for ((j=0; j<${#COMMON_ARGS[@]}; j++)); do
    if [[ "${COMMON_ARGS[$j]}" == "--channel" ]]; then
        AUDIO_ONLY_ARGS+=("--channel" "${COMMON_ARGS[$((j+1))]}")
        break
    fi
done
if [[ " ${COMMON_ARGS[*]} " =~ " --dry-run " ]]; then
    AUDIO_ONLY_ARGS+=("--dry-run")
fi

env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
node "$SCRIPT_DIR/upload_audio_only.js" "${AUDIO_ONLY_ARGS[@]}" "${PRIORITY_SCOPE_ARGS[@]}" || {
    echo "   ⚠️  Greška pri audio-only uploadu, nastavljam..."
}
fi

# --- KORAK 13: CHANNEL INDEX REGEN + META UPLOAD (uz --with-r2-upload) ---
# Bez ovog koraka novi videi (s kompletiranim article.json-om) ne ulaze u
# channels/data/*.json pa se ne pojavljuju na www.domovina.ai/c/<channel>.
# Idempotentno: ako se ništa nije promijenilo, upload je no-op (HEAD-skip).
if [ "$PRIORITY_FAST_PATH" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 13: Channel index regen + meta upload"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   ⏭️  FAST-PATH: preskačem channel index regen + meta upload."
echo "      _unlisted je neindeksiran (memory: unlisted_adhoc_ingestion) — video je već"
echo "      per-video na CDN (KORAK 12), reconcile.js ga flipa u done preko article.json"
echo "      detail_url-a. Puni index rebuild čita ~3000 videa (O(n)) i tu ništa ne dodaje."
elif [ "$WITH_R2_UPLOAD" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
korak "KORAK 13: Channel index regen + meta upload"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node "$SCRIPT_DIR/generate_channel_index.js" --input-dir "$OUTPUT_DIR" || {
    echo "   ⚠️  Greška pri generate_channel_index.js, nastavljam..."
}

env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
node "$SCRIPT_DIR/upload_to_r2.js" --meta-dir "$SCRIPT_DIR/storage/meta" || {
    echo "   ⚠️  Greška pri meta uploadu, nastavljam..."
}
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✅ PIPELINE ZAVRŠEN                            ║"
echo "╚══════════════════════════════════════════════════╝"
echo "   ⏱️  Kraj: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
