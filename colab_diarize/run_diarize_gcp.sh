#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# run_diarize_gcp.sh — Batch diarizacija na GCP Compute Engine VM
#
# Preduvjeti:
#   - GCP VM: c2-standard-60 ili n2-standard-80 spot, 250 GB disk
#   - Ubuntu 22.04 LTS, us-central1
#   - rclone.conf s lokalnog stroja (google_drive_ms remote)
#
# Spot-safe + disk-safe: obrađuje kanal po kanal:
#   1. Download WAV + .canary.srt za jedan kanal
#   2. Diarizi
#   3. Upload .canary.diarized.srt na Drive
#   4. Obriši WAV-ove tog kanala (oslobodi disk)
#   5. Sljedeći kanal
#
# Korištenje:
#   ./run_diarize_gcp.sh --hf-token hf_xxx [--workers 40]
#
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ─── Parametri ───
HF_TOKEN=""
RCLONE_REMOTE="google_drive_ms"
DRIVE_PATH="domovina_fetch_data/canary_wav"
LOCAL_DIR="/data/canary_wav"
WORKERS=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --hf-token) HF_TOKEN="$2"; shift 2 ;;
        --remote) RCLONE_REMOTE="$2"; shift 2 ;;
        --workers) WORKERS="$2"; shift 2 ;;
        *) echo "Nepoznat argument: $1"; exit 1 ;;
    esac
done

if [[ -z "$HF_TOKEN" ]]; then
    echo "Korištenje: ./run_diarize_gcp.sh --hf-token hf_xxx [--workers 40] [--remote google_drive_ms]"
    exit 1
fi

# ─── Auto-detect optimalan broj workera ───
# Svaki worker koristi ~2 CPU threada za pyannote inference,
# pa je optimalan broj workera = CPU_COUNT / 2 (ne CPU_COUNT).
# Više od toga uzrokuje oversubscription i dramatičan pad performansi.
CPU_COUNT=$(nproc)
MEM_GB=$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo)
if [[ -z "$WORKERS" ]]; then
    WORKERS_BY_CPU=$((CPU_COUNT / 2))
    WORKERS_BY_MEM=$((MEM_GB / 3))
    WORKERS=$((WORKERS_BY_CPU < WORKERS_BY_MEM ? WORKERS_BY_CPU : WORKERS_BY_MEM))
    if [[ $WORKERS -lt 1 ]]; then WORKERS=1; fi
fi

echo "═══════════════════════════════════════════════════"
echo "  DIARIZACIJA NA GCP VM (kanal po kanal)"
echo "═══════════════════════════════════════════════════"
echo "  CPU:     $CPU_COUNT cores"
echo "  RAM:     ${MEM_GB} GB"
echo "  Workers: $WORKERS"
echo "  Remote:  $RCLONE_REMOTE:$DRIVE_PATH"
echo "  Lokalno: $LOCAL_DIR"
echo ""

# ─── 1. Instaliraj dependencies ───
echo "[1/4] Instaliram dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq python3-pip python3-venv rclone git libsndfile1

if [[ ! -d /data/venv ]]; then
    sudo mkdir -p /data
    sudo chown "$(whoami)" /data
    python3 -m venv /data/venv
fi
source /data/venv/bin/activate
pip install -q pyannote.audio soundfile
echo "  Dependencies instalirani."
echo ""

# ─── 2. Provjeri rclone config ───
echo "[2/4] Provjeravam rclone config..."
if ! rclone listremotes | grep -q "${RCLONE_REMOTE}:"; then
    echo "  GREŠKA: rclone remote '$RCLONE_REMOTE' nije pronađen!"
    echo "  Kopiraj config s lokalnog stroja:"
    echo "    gcloud compute scp ~/.config/rclone/rclone.conf VM:~/.config/rclone/"
    exit 1
fi
echo "  rclone remote '$RCLONE_REMOTE' pronađen."
echo ""

# ─── 3. Kloniraj repo ───
echo "[3/4] Kloniram repo..."
if [[ -d /data/fetch.domovina.tv ]]; then
    cd /data/fetch.domovina.tv && git pull
    cd /data
else
    git clone https://github.com/domovinatv/fetch.domovina.tv.git /data/fetch.domovina.tv
fi
echo ""

# ─── 4. Obradi kanal po kanal ───
echo "[4/4] Dohvaćam listu kanala s Drive-a..."
CHANNELS=$(rclone lsd "${RCLONE_REMOTE}:${DRIVE_PATH}" | awk '{print $NF}' | sort)
TOTAL_CHANNELS=$(echo "$CHANNELS" | wc -l)
echo "  Pronađeno kanala: $TOTAL_CHANNELS"
echo ""

export HF_TOKEN="$HF_TOKEN"
GLOBAL_START=$(date +%s)
CHANNEL_NUM=0
TOTAL_DIARIZED=0
TOTAL_SKIPPED=0

mkdir -p "$LOCAL_DIR"

for CHANNEL in $CHANNELS; do
    CHANNEL_NUM=$((CHANNEL_NUM + 1))
    CHANNEL_DIR="$LOCAL_DIR/$CHANNEL"

    echo "═══════════════════════════════════════════════════"
    echo "  [$CHANNEL_NUM/$TOTAL_CHANNELS] $CHANNEL"
    echo "═══════════════════════════════════════════════════"

    # Provjeri ima li uopće .canary.srt fajlova za ovaj kanal
    SRT_COUNT_REMOTE=$(rclone ls "${RCLONE_REMOTE}:${DRIVE_PATH}/${CHANNEL}" \
        --filter "- ._*" --filter "+ *.canary.srt" --filter "- *" 2>/dev/null | wc -l)

    if [[ "$SRT_COUNT_REMOTE" -eq 0 ]]; then
        echo "  Nema .canary.srt fajlova — preskačem."
        echo ""
        continue
    fi

    # Provjeri koliko je već diarized na Drive-u
    DIARIZED_REMOTE=$(rclone ls "${RCLONE_REMOTE}:${DRIVE_PATH}/${CHANNEL}" \
        --filter "- ._*" --filter "+ *.canary.diarized.srt" --filter "- *" 2>/dev/null | wc -l)

    if [[ "$DIARIZED_REMOTE" -ge "$SRT_COUNT_REMOTE" ]]; then
        echo "  Svi fajlovi već diarized ($DIARIZED_REMOTE/$SRT_COUNT_REMOTE) — preskačem."
        TOTAL_SKIPPED=$((TOTAL_SKIPPED + DIARIZED_REMOTE))
        echo ""
        continue
    fi

    echo "  SRT na Drive-u: $SRT_COUNT_REMOTE, već diarized: $DIARIZED_REMOTE"

    # A) Dohvati listu već diarized fajlova, generiraj rclone filter-file
    mkdir -p "$CHANNEL_DIR"
    FILTER_FILE="/tmp/rclone_filter_${CHANNEL}.txt"

    # Osnovna pravila
    echo "- ._*" > "$FILTER_FILE"

    # Exclude WAV+SRT za fajlove koji već imaju diarized SRT na Drive-u
    rclone ls "${RCLONE_REMOTE}:${DRIVE_PATH}/${CHANNEL}" \
        --filter "- ._*" --filter "+ *.canary.diarized.srt" --filter "- *" 2>/dev/null \
        | awk '{print $NF}' | sed 's/\.canary\.diarized\.srt$//' | while read -r DONE; do
            echo "- ${DONE}" >> "$FILTER_FILE"
            echo "- ${DONE}.canary.srt" >> "$FILTER_FILE"
        done

    # Include pravila
    echo "+ *.wav" >> "$FILTER_FILE"
    echo "+ *.canary.srt" >> "$FILTER_FILE"
    echo "- *" >> "$FILTER_FILE"

    TO_DOWNLOAD=$((SRT_COUNT_REMOTE - DIARIZED_REMOTE))
    echo "  Downloadam $TO_DOWNLOAD nediarized fajlova (skip $DIARIZED_REMOTE)..."
    rclone copy "${RCLONE_REMOTE}:${DRIVE_PATH}/${CHANNEL}" "$CHANNEL_DIR" \
        --filter-from "$FILTER_FILE" \
        --transfers 16 --quiet
    rm -f "$FILTER_FILE"

    WAV_COUNT=$(find "$CHANNEL_DIR" -name "*.wav" 2>/dev/null | wc -l)
    DISK_USED=$(du -sh "$CHANNEL_DIR" 2>/dev/null | cut -f1)
    echo "  Downloaded: $WAV_COUNT WAV ($DISK_USED)"

    # B) Diarizi
    if [[ "$WAV_COUNT" -gt 0 ]]; then
        echo "  Diarizing s $WORKERS workera..."
        python3 /data/fetch.domovina.tv/colab_diarize/diarize_canary.py \
            --input-dir "$CHANNEL_DIR" \
            --workers "$WORKERS" 2>&1 | tail -20

        # Broji nove diarized
        NEW_DIARIZED=$(find "$CHANNEL_DIR" -name "*.canary.diarized.srt" 2>/dev/null | wc -l)
        TOTAL_DIARIZED=$((TOTAL_DIARIZED + NEW_DIARIZED))
        echo "  Diarized u ovom kanalu: $NEW_DIARIZED"
    fi

    # C) Upload .canary.diarized.srt natrag na Drive
    echo "  Uploadam diarized na Drive..."
    rclone copy "$CHANNEL_DIR" "${RCLONE_REMOTE}:${DRIVE_PATH}/${CHANNEL}" \
        --filter "- ._*" --filter "+ *.canary.diarized.*" --filter "- *" \
        --transfers 8 --quiet

    # D) Obriši lokalne fajlove (oslobodi disk)
    rm -rf "$CHANNEL_DIR"
    echo "  Disk oslobođen."
    echo ""
done

# ─── Sažetak ───
GLOBAL_END=$(date +%s)
GLOBAL_ELAPSED=$((GLOBAL_END - GLOBAL_START))
HOURS=$((GLOBAL_ELAPSED / 3600))
MINS=$(( (GLOBAL_ELAPSED % 3600) / 60 ))

echo "═══════════════════════════════════════════════════"
echo "  GOTOVO!"
echo "═══════════════════════════════════════════════════"
echo "  Kanala:        $TOTAL_CHANNELS"
echo "  Diarized:      $TOTAL_DIARIZED"
echo "  Već bilo:      $TOTAL_SKIPPED"
echo "  Wall clock:    ${HOURS}h ${MINS}m"
echo ""
echo "  Sada možeš ugasiti VM:"
echo "    sudo shutdown -h now"
echo "═══════════════════════════════════════════════════"
