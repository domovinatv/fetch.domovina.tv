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
#       summary i article → 10 thumbnails → 11 RAG u Vertex Agent Builder → 12 R2 publish.
#       Sve idempotentno.
#
# NAPOMENA: korak 1 (refresh + fetch) radi `git add . && git commit -m "chore(podcasts):
# refresh podcast lists" || true` nakon `refresh_podcasts.sh` — to je expected (vidi
# desetke takvih commita u git logu). Ako u trenutku pokretanja imaš uncommit-ane
# promjene koje NE ŽELIŠ pomiješati s podcast list refresh-om, commit ih prije.
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

# Validacija --gemini-backend (samo "vertex" ili "cli")
if [ "$GEMINI_BACKEND" != "vertex" ] && [ "$GEMINI_BACKEND" != "cli" ]; then
    echo "❌ Nepoznat --gemini-backend: '$GEMINI_BACKEND' (dozvoljeno: vertex, cli)"
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
else
    echo "   🤖 Gemini backend: Vertex AI REST (multi-region rotacija)"
fi

# Skripte koraka 7+8 čitaju GEMINI_BACKEND iz okoliša
export GEMINI_BACKEND

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
    # rclone bypass-a HTTPS_PROXY (telefon-residential-proxy) jer Drive traffic
    # ne treba i ne smije ići kroz cellular tunel — kvari throughput i nije
    # ono što proxy postoji da pruža (proxy je za yt-dlp YouTube IP fingerprint).
    env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
    rclone copy google_drive_ms:domovina_fetch_data/canary_wav "$OUTPUT_DIR" \
      -L --filter "- ._*" \
      --filter "+ **.canary.**" \
      --filter "+ **.sortformer.**" \
      --filter "+ **.embeddings.*.json" \
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

# Scope-aj git add SAMO na podcast liste — inače bi se launchd plistovi, logovi
# i drugi runtime artefakti unutar automatic/ kupili u "podcast refresh" commit.
git add podcasts/
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
    env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
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

# --- KORAK 6.5: SPEAKER EMBEDDING EXTRACTION (opcionalno, --with-speaker-embeddings) ---
# Ekstrahira per-speaker voice embeddinge (TitaNet-Large, 192-dim L2-normalized) iz dijariziranih
# WAV-ova. Forward-only inkrementalna obrada — preskače datoteke s postojećim .embeddings.json.
# Output konzumira downstream domovina-rag importer za globalnu speaker entity rezoluciju (vidi
# docs/rag_clickhouse_postgres_plan.md §15).
# Za bulk backfill 2000+ starih epizoda koristi colab_speaker_embeddings/ Jupyter notebook na Colab G4.
if [ "$WITH_SPEAKER_EMBEDDINGS" = true ]; then
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 6.5: Speaker embedding extraction (TitaNet-Large) [--with-speaker-embeddings]"
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
                if ! python3 -c "import nemo.collections.asr" 2>/dev/null; then
                    echo "   ⚠️  NeMo nije instaliran — preskačem $model_key."
                    echo "      Instaliraj: pip3 install 'nemo_toolkit[asr]==2.0.0' soundfile librosa"
                    continue
                fi
                ;;
            pyannote_wespeaker34)
                if ! python3 -c "import pyannote.audio" 2>/dev/null; then
                    echo "   ⚠️  pyannote.audio nije instaliran — preskačem $model_key."
                    continue
                fi
                ;;
        esac

        python3 "$SCRIPT_DIR/colab_speaker_embeddings/extract_speaker_embeddings.py" \
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
      --drive-shared-with-me --progress
fi
else
    echo ""
    echo "   ⏭️  Preskačem korak 6.5 (speaker embeddings) — nije zadan --with-speaker-embeddings"
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

# --- KORAK 9.5: OG-SHARE IMAGE GENERIRANJE (social sharing thumbnail varijanta) ---
# Generira {base}.og-share.jpg (1200×630 progressive JPEG q=85, 4:2:0, sRGB, stripped)
# iz postojećeg {base}.png thumbnaila. WhatsApp odbija og:image > 600 KB;
# raw YouTube PNG thumbnaili često idu preko. Cloudflare Worker (web app) preferira
# og-share.jpg, fallback na thumbnail.png.
# Zahtijeva ImageMagick (`magick` binary). Idempotentno.
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 9.5: Generiranje OG-share varijante (1200×630 progressive JPEG q=85)"
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

node "$SCRIPT_DIR/generate_og_image.js" "${OG_IMAGE_ARGS[@]}" || {
    echo "   ⚠️  Greška pri generiranju OG image varijanti, nastavljam..."
}

# --- KORAK 9.6: OG-SECTIONS COMPOSITE GENERIRANJE (Tier B per-section social images) ---
# Generira {channel}/{base}.og-sections/og-t-{sec}.jpg za svaki section iz article.json.
# Worker u domovina.ai (web/_worker.js) koristi ih za /v/<ytId>/t/<sec> share URL-ove —
# bira section-start ključ <= tSec iz og-sections.json manifest-a i override-a og:image.
# Reuse-a postojeće {base}_screenshots/{base}_{HH-MM-SS}.png frame-ove (KORAK 10 output);
# composite dodaje gradient + section subtitle + episode title + DOMOVINA brand bar.
# 1200×630 progressive JPEG q=85, idempotent (mtime check vs article.json + source PNG).
# Skip kriteriji: no article, no sections, duration<5min, >50 sections, missing source PNG.
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   📢 KORAK 9.6: Generiranje OG-sections composite-a (per-section Tier B)"
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

python3 "$SCRIPT_DIR/generate_og_sections.py" "${OG_SECTIONS_ARGS[@]}" || {
    echo "   ⚠️  Greška pri generiranju OG-sections composite-a, nastavljam..."
}

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

if [ -n "$SCREENSHOT_PROXY" ]; then
    SCREENSHOT_ARGS+=("--proxy" "$SCREENSHOT_PROXY")
fi

if [ -n "$SCREENSHOT_SOURCE_ADDR" ]; then
    SCREENSHOT_ARGS+=("--source-address" "$SCREENSHOT_SOURCE_ADDR")
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

# R2 upload eksplicitno zaobilazi telefon-residential-proxy. @aws-sdk/client-s3
# ionako ne honora HTTPS_PROXY env var po defaultu, ali ako se ikad zamijeni
# transport sloj, ovaj env -u garantira da R2 put nije ovisan o proxyju.
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
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
