#!/bin/bash
#
# nightly_pipeline.sh — End-to-end overnight pipeline wrapper
#
# Pokreće cijeli pipeline za fetch.domovina.tv u jednom prolazu:
#
#   FAZA A — priprema za Colab Canary transkripciju:
#     • automatic/refresh_podcasts.sh  (KORAK 0 unutar run_pipeline.sh, rclone diarized.srt-ova)
#     • fetch.js                       (KORAK 1, novi videi s YouTube-a)
#     • convert_to_wav.js              (KORAK 2, MP3 → WAV 16kHz mono)
#     • upload WAV-ova na Google Drive (KORAK 2.5, za Colab batch)
#
#   FAZA B — post-Colab catch-up za prethodno transkribirane videe:
#     • diarize_canary.py              (KORAK 6, pyannote lokalno na M4 Pro)
#     • summarize_gemini.js            (KORAK 7)
#     • generate_article_gemini.js     (KORAK 8)
#     • prepare_rag_combined.js        (KORAK 9)
#     • generate_og_image.js           (KORAK 9.5)
#     • generate_og_sections.py        (KORAK 9.6)
#     • screenshot_youtube.js          (KORAK 10, --with-screenshots)
#     • upload_to_r2.js                (KORAK 12, --with-r2-upload)
#
#   ZAVRŠNI KORACI (samostalni, run_pipeline.sh ih ne zove):
#     • generate_channel_index.js                       — refresh channels/data/index.json
#     • upload_to_r2.js --meta-dir storage/meta         — upload index na CDN
#
# Sve je idempotentno — script može se vrtjeti svaki dan, svaki korak skipa već dovršeno.
#
# NAMJERNO NIJE UKLJUČENO:
#   --with-vertex-import — chain dependency na završenu Canary transkripciju; ne pokreći
#                          automatski dok Canary visi na Colabu (vidi MEMORY: pipeline_catchup_pass).
#
# iPHONE PROXY (auto-probe):
#   Prije fetcha, nightly probe-a iPhone mobile-phone-proxy (Tailscale
#   http://100.71.146.11:8888). Ako je živ I daje egress IP različit od Ethernet
#   IP-a, prosljeđuje --proxy run_pipeline.sh-u → yt-dlp ide kroz iPhone cellular
#   i zaobilazi anti-bot. Da bi to radilo noću: iPhone na punjaču + mobile-phone-proxy
#   app upaljen + WiFi UGAŠEN na iPhonu (inače egress curi kroz WiFi = isti IP =
#   probe odbacuje proxy). Vidi MEMORY: iphone-http-proxy-via-tailscale.
#
# OČEKIVANI FAILURE-i (kad iPhone proxy NIJE dostupan):
#   YouTube anti-bot na direct connection (Mac na Ethernet/WiFi bez residential proxy-ja).
#   fetch.js / screenshot_youtube.js exit-aju 0 čak i kod ABORT-a (vidi MEMORY:
#   pipeline_anti_bot_silent_continue). Failed videi će biti pokupljeni sljedećim
#   runom kad je iPhone proxy gore (auto) ili manualnim re-runom na tethering-u.
#
# Pokretanje:
#   Ručno:    ./automatic/nightly_pipeline.sh
#   launchd:  automatic/launchd/tv.domovina.fetch.nightly.plist  (svaki dan u 03:00)
#

set -uo pipefail

# ─── REPO ROOT ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

# ─── ENVIRONMENT ──────────────────────────────────────────────────
# launchd ne nasljedjuje user shell PATH — moramo eksplicitno.
export HOME="${HOME:-/Users/$USER}"

# nvm (za node)
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    nvm use default >/dev/null 2>&1 || true
fi

# gcloud SDK (za Vertex AI OAuth token refresh)
if [ -d "$HOME/google-cloud-sdk/bin" ]; then
    export PATH="$HOME/google-cloud-sdk/bin:$PATH"
fi

# Python 3.13 Framework (drži Pillow za generate_og_sections.py — brew/system pythoni ga nemaju)
if [ -d "/Library/Frameworks/Python.framework/Versions/3.13/bin" ]; then
    export PATH="/Library/Frameworks/Python.framework/Versions/3.13/bin:$PATH"
fi

# Homebrew (rclone, ffmpeg, jq)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# ─── LOGGING ──────────────────────────────────────────────────────
LOG_DIR="$REPO_DIR/automatic/logs"
mkdir -p "$LOG_DIR"

# Dijeljeni mutex s prioritetnim fast-pathom (priority_pipeline.sh) — da dva run_pipeline
# procesa ne rade istovremeno nad _unlisted/. Noćni bulk čeka (wait) ako prioritet drži lock.
PIPELINE_LOCK="$LOG_DIR/.pipeline.lock.d"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/pipeline_lock.sh"

DATESTAMP="$(date +%Y-%m-%d)"
LOG_FILE="$LOG_DIR/nightly_${DATESTAMP}.log"

# Pipeline output ide u per-day log. Ako smo u tty (manual run), tee-aj i u terminal;
# inače (launchd context) samo redirect — bez tee-a izbjegavamo dupliciranje istog
# sadržaja u launchd.out.log (koje launchd inherit-a kao stdout/stderr).
if [ -t 1 ]; then
    exec > >(tee -a "$LOG_FILE") 2>&1
else
    exec >> "$LOG_FILE" 2>&1
fi

# yt-dlp: NE prepuštaj PATH redoslijedu koji od dva installa pobjeđuje — biraj po
# verziji. (Stari ekstraktor daje 403 na medijskom streamu; vidi resolve_ytdlp.sh.)
# Ide NAKON exec-redirecta da poruka završi u nightly logu, a ne u launchd.out.
# shellcheck source=/dev/null
. "$SCRIPT_DIR/resolve_ytdlp.sh"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   🌙  NIGHTLY PIPELINE                                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "   Start:        $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "   Repo:         $REPO_DIR"
echo "   Log:          $LOG_FILE"
echo "   Caller PID:   $$"
echo "   PATH:         $PATH"
echo "   Node:         $(command -v node || echo MISSING) $(node --version 2>/dev/null || true)"
echo "   gcloud:       $(command -v gcloud || echo MISSING)"
echo "   rclone:       $(command -v rclone || echo MISSING)"
echo "   ffmpeg:       $(command -v ffmpeg || echo MISSING)"
echo "   yt-dlp:       $(command -v yt-dlp || echo MISSING) $(yt-dlp --version 2>/dev/null || true)"
echo ""

# ─── LOCKFILE ─────────────────────────────────────────────────────
# Spriječi paralelne run-ove (manual + launchd kolizija ili dugo trajanje
# prethodnog run-a koje preklopi sljedeći schedule).
LOCK_FILE="$LOG_DIR/.nightly.lock"

if [ -e "$LOCK_FILE" ]; then
    LOCK_PID="$(cat "$LOCK_FILE" 2>/dev/null || echo "")"
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
        echo "⚠️  Prethodni pipeline (PID $LOCK_PID) još radi — izlazim."
        exit 0
    else
        echo "ℹ️  Stale lockfile pronađen (PID $LOCK_PID neaktivan) — preuzimam."
        rm -f "$LOCK_FILE"
    fi
fi

echo "$$" > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT INT TERM

# ─── LOG ROTACIJA ─────────────────────────────────────────────────
# Tri sloja loga:
#   1. nightly_YYYY-MM-DD.log         — per-day pipeline log. Brisanje > 30 dana.
#   2. launchd.{out,err}.log          — append-only kroz sve runove (launchd capture).
#                                       Truncate kad pređu prag, .1 backup za diagnostiku.
#   3. nightly_*.log.gz arhiva        — gzip-anje starije od 7 dana (čuvaj forensic).
#
# Sve rotacije rade tijekom početka run-a (nakon lockfile-a, prije pipeline koraka).
LAUNCHD_LOG_MAX_SIZE_MB=5
LOG_GZIP_AGE_DAYS=7
LOG_DELETE_AGE_DAYS=30

# 1. Brisanje starih per-day logova (svejedno gzip ili plain)
find "$LOG_DIR" -name 'nightly_*.log' -type f -mtime +$LOG_DELETE_AGE_DAYS -delete 2>/dev/null || true
find "$LOG_DIR" -name 'nightly_*.log.gz' -type f -mtime +$LOG_DELETE_AGE_DAYS -delete 2>/dev/null || true

# 2. Gzip per-day logova starijih od 7 dana (još nije gzip-an)
find "$LOG_DIR" -name 'nightly_*.log' -type f -mtime +$LOG_GZIP_AGE_DAYS \
    ! -name "nightly_${DATESTAMP}.log" -exec gzip -f {} \; 2>/dev/null || true

# 3. launchd.{out,err}.log — size-bound truncate s .1 backup
for launchd_log in "$LOG_DIR/launchd.out.log" "$LOG_DIR/launchd.err.log"; do
    if [ -f "$launchd_log" ]; then
        size_mb=$(du -m "$launchd_log" 2>/dev/null | cut -f1)
        if [ -n "$size_mb" ] && [ "$size_mb" -gt "$LAUNCHD_LOG_MAX_SIZE_MB" ]; then
            # Backup → .1 (overwrite stari .1). Nova writes idu na novi inode
            # jer launchd otvori fresh file na svakom run-u.
            mv -f "$launchd_log" "${launchd_log}.1" 2>/dev/null || true
            : > "$launchd_log" 2>/dev/null || true
        fi
    fi
done

# ─── FAZE PIPELINE-A ──────────────────────────────────────────────

FAILED_STEPS=()

run_step() {
    local label="$1"
    shift
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "   ▶️  $label"
    echo "   $ $*"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if "$@"; then
        echo "   ✅ $label"
        return 0
    else
        local rc=$?
        echo "   ❌ $label (exit $rc) — nastavljam dalje"
        FAILED_STEPS+=("$label (exit $rc)")
        return $rc
    fi
}

# ─── iPhone proxy auto-probe ──────────────────────────────────────
# Nightly ide unattended. Ako je iPhone mobile-phone-proxy (Tailscale
# 100.71.146.11:8888) ŽIV *I* daje egress IP različit od Ethernet IP-a, dodaj
# --proxy za yt-dlp pozive (fetch + screenshot) da zaobiđemo YouTube IP-level
# anti-bot. Inače fallback na direktno — fetch/screenshot tiho fail-aju na
# anti-bot (isto kao i dosad), pipeline nastavlja dalje.
#
# Egress-IP usporedba hvata i slučaj kad user zaboravi UGASITI WiFi na iPhonu:
# tada iOS egress-a kroz WiFi (home NAT) → isti public IP kao Mac Ethernet →
# proxy ne donosi ništa anti-botu, pa ga ne koristimo. Vidi MEMORY:
# iphone-http-proxy-via-tailscale (KRITIČNO: WiFi off na iPhonu za cellular egress).
IPHONE_PROXY_URL="http://100.71.146.11:8888"
PROXY_ARGS=()

# --via-iphone (CLI): forsiraj yt-dlp egress kroz iPhone USB tether (172.20.10.x,
# residential mobile IP). Kad je zadan, PRESKAČEMO Tailscale proxy probe — to je drugi,
# sporiji egress put (DERP+cellular ~0.8 MB/s); USB tether je ~10 MB/s i bolji za video.
# Flag se prosljeđuje run_pipeline.sh-u (koji ga već parsira i auto-detektira tether IP).
# Vidi MEMORY: yt-dlp-source-address-via-iphone, iphone-http-proxy-via-tailscale.
VIA_IPHONE=false
for arg in "$@"; do
    [ "$arg" = "--via-iphone" ] && VIA_IPHONE=true
done

probe_iphone_proxy() {
    local direct_ip proxy_ip
    direct_ip="$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || echo "")"
    proxy_ip="$(curl -s --max-time 15 -x "$IPHONE_PROXY_URL" https://api.ipify.org 2>/dev/null || echo "")"
    if [ -z "$proxy_ip" ]; then
        echo "   📡 iPhone proxy nedostupan ($IPHONE_PROXY_URL) — fetch ide direktno (anti-bot očekivan)."
        return 1
    fi
    if [ "$proxy_ip" = "$direct_ip" ]; then
        echo "   ⚠️  iPhone proxy egress ($proxy_ip) == Ethernet IP — WiFi na iPhonu vjerojatno NIJE ugašen. Ne koristim proxy."
        return 1
    fi
    echo "   📡 iPhone proxy ŽIV: egress $proxy_ip (Ethernet $direct_ip) — yt-dlp ide kroz iPhone (cellular)."
    PROXY_ARGS=("--proxy" "$IPHONE_PROXY_URL")
    return 0
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$VIA_IPHONE" = true ]; then
    echo "   📡 --via-iphone zadan → yt-dlp bind na iPhone USB tether (172.20.10.x). Preskačem Tailscale proxy probe."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    PROXY_ARGS=("--via-iphone")
else
    echo "   📡 iPhone proxy probe ($IPHONE_PROXY_URL)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    probe_iphone_proxy || true
fi

# ─── 0. PIPELINE QUEUE CLAIM (ad-hoc/unlisted videi) ────────────────
# Povuci .env (PIPELINE_QUEUE_INGEST_KEY) pa claim queued jobove iz pipeline.domovina.ai →
# fetch.js --unlisted-url → _unlisted/. run_pipeline ih dalje obradi automatski
# (convert_to_wav auto-discoverira _unlisted; diarize/summary/article su dir-driven).
# Soft-fail (exit 0) bez PIPELINE_QUEUE_INGEST_KEY pa ne ruši nightly. Vidi docs/UNLISTED_PIPELINE.md.
set -a; [ -f "$REPO_DIR/.env" ] && . "$REPO_DIR/.env"; set +a
PIPELINE_QUEUE_BRIDGE="${PIPELINE_QUEUE_BRIDGE_DIR:-$REPO_DIR/../pipeline.domovina.ai/bridge}"
if [ -f "$PIPELINE_QUEUE_BRIDGE/claim_and_dispatch.js" ]; then
    run_step "pipeline claim (unlisted queue)" \
        node "$PIPELINE_QUEUE_BRIDGE/claim_and_dispatch.js" || true
fi

# ─── 1. GLAVNI PIPELINE (faze A + B) ──────────────────────────────
# --with-local-canary-diarize: pyannote diarizacija lokalno na Macu (gdje nightly
# ionako trči); token se resolve-a iz ~/.cache/huggingface/token (ne treba --hf-token).
# Diarize ide PRIJE summary/article u istom prolazu → nove epizode s pristiglim
# .canary.srt (Colab) dobiju .canary.diarized.srt pa odmah idu kroz AI sloj.
# PROXY_ARGS je prazan ako probe nije našao živ iPhone proxy (guard za set -u + bash 3).
# Dijeljeni mutex: pričekaj da prioritetni fast-path (ako radi) završi run_pipeline, pa preuzmi.
acquire_pipeline_lock wait
# --gemini-backend claude + CLAUDE_MODEL=opus (2026-07-29): koraci 7+8 za SVE nove
# epizode idu preko Claude Opusa (pretplata) umjesto Gemini Flasha — odluka nakon
# incidenta atribucije imena (Ivan Voras / cb4CsFDCDho): Flash je prekršio strict
# uputu i imenovao voditelja iz općeg znanja; Opus/Haiku u slijepom testu nisu.
# Epizoda je trajni statični sadržaj → premium output. PREDUVJET: claude CLI u
# PATH-u launchd job-a (~/.local/bin u tv.domovina.fetch.nightly.plist).
# --with-modal-transcribe --modal-scope channels (2026-07-31): SINGLE-PASS.
# Nove epizode se transkribiraju na Modalu u istom prolazu umjesto da čekaju ručno
# pokretanje Colab notebooka (dvoprolazni put: WAV → Drive → notebook → rclone natrag).
# Odluka od 2026-07-25 ("nightly ostaje Colab") počivala je na procjeni $0.06/ep za Modal;
# izmjereno u batch režimu 2026-07-29 je $0.0087-0.0116/ep, pa za dnevni priljev od 1-5
# epizoda ovo košta centе po noći. Vidi docs/transcription_colab_vs_modal_cost_2026-07.md §4.6.
# Trostruka ograda protiv troška: MODAL_FRESH_DAYS=2 (nikad backlog), MODAL_MAX_FILES=20
# (iznad → soft-skip na Colab), rclone exclude po videu (Colab ne vidi iste WAV-ove).
# CLAUDE_WINDOW_GUARD (2026-08-26): koraci 7+8 pitaju `claude-window` prije svake
# epizode smiju li zvati `claude`. Nightly je pomaknut na 01:00 (bio 03:00), ali
# trajanje mu je dugorepo — medijan ~20 min, a 14.8. je trajao 6h37m i 16.8. 4h31m.
# U takvom runu su se Opus sessioni spawnali u 07:35/08:31 i otvarali svjež 5h prozor
# kvote tik prije 08:30, pa je jutro počinjalo s već potrošenom kvotom.
# Arbitar pušta sve dok smo unutar prozora otvorenog na početku noći (tipično do
# ~05:10) i odbija poziv koji bi otvorio nov prozor živ u 08:30. Odbijene epizode se
# ODGAĐAJU u sljedeći nightly (ne degradiraju na Flash — vidi lib/claude_window.js).
# Ne-AI koraci ispod (transcribe, upload, index) nastavljaju normalno.
run_step "run_pipeline.sh (faza A + faza B)" \
    env CLAUDE_MODEL=opus CLAUDE_WINDOW_GUARD=1 "$REPO_DIR/run_pipeline.sh" ${PROXY_ARGS[@]+"${PROXY_ARGS[@]}"} --with-local-canary-diarize --with-screenshots --with-r2-upload --gemini-backend claude --with-modal-transcribe --modal-scope channels || true

# ─── 1.5 AUTO-REUSE SWEEP (ad-hoc _unlisted → praćeni kanali) ─────
# Edge case prioritetnog fast-patha: ad-hoc obrada se često dogodi PRIJE nego
# što nightly fetcha video u channel dir → reuse u trenutku obrade nema kamo
# kopirati. Ovaj sweep (nakon fetch.js gore, prije KORAKA 2/3 dolje) pokupi
# takve videe čim su fetchani: dovršene _unlisted obrade → reuse u channel dir.
# No-op u <1s kad ad-hoc obrada nema; publish ne radi — KORAK 2 (channel index)
# i KORAK 3 (meta upload) slijede odmah ispod. Pod istim pipeline lockom kao
# run_pipeline jer piše u channel direktorije.
run_step "auto_reuse_adhoc.js --sweep" \
    node "$REPO_DIR/auto_reuse_adhoc.js" --sweep || true
release_pipeline_lock

# ─── 2. CHANNEL INDEX REGEN ───────────────────────────────────────
run_step "generate_channel_index.js" \
    node "$REPO_DIR/generate_channel_index.js" || true

# ─── 3. META UPLOAD (channels/data/* na CDN) ──────────────────────
run_step "upload_to_r2.js --meta-dir storage/meta" \
    node "$REPO_DIR/upload_to_r2.js" --meta-dir storage/meta || true

# ─── 4. PIPELINE RECONCILE (javi gotove unlisted jobove) ────────────
# Za jobove u transcribing/processing: CDN data/{id}/article.json 200 → done + /v/{id}.
if [ -f "$PIPELINE_QUEUE_BRIDGE/reconcile.js" ]; then
    run_step "pipeline reconcile (unlisted queue)" \
        node "$PIPELINE_QUEUE_BRIDGE/reconcile.js" || true
fi

# ─── 5. OTKRIVENI VIDEI (dnevna podlista u pipeline.domovina.ai) ────
# Prijavi što je OVAJ run novo povukao (info.json mlađi od prozora) kao "otkrivene videe".
# NE queuea obradu — samo vidljivost: /admin/discovered pokaže podlistu po danu, a klik
# "⚡ Prioritet" tek tada stvori pravi job i pokrene punu prioritetnu obradu.
# Ide ZADNJE, nakon reconcilea, da `stage` odražava finalno stanje diska poslije runa.
if [ -f "$PIPELINE_QUEUE_BRIDGE/report_discovered.js" ]; then
    run_step "pipeline discovered (dnevna podlista novih videa)" \
        node "$PIPELINE_QUEUE_BRIDGE/report_discovered.js" || true
fi

# ─── 6. POTROŠNJA TOKENA (Claude Code sesije → pipeline queue) ──────
# Zbroji tokene headless `claude -p` runova po videu (Magisterium MCP runbook,
# --gemini-backend claude) iz ~/.claude/projects i pošalji u queue servis, gdje se
# prikazuju uz pipeline korake. Čita samo session logove — ne dira obradu.
if [ -f "$PIPELINE_QUEUE_BRIDGE/report_token_usage.js" ]; then
    run_step "pipeline token usage (Claude Code sesije)" \
        node "$PIPELINE_QUEUE_BRIDGE/report_token_usage.js" || true
fi

# ─── SAŽETAK ──────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   🌙  NIGHTLY PIPELINE — SAŽETAK                             ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "   Kraj:    $(date '+%Y-%m-%d %H:%M:%S %Z')"

if [ ${#FAILED_STEPS[@]} -eq 0 ]; then
    echo "   Status:  ✅ Svi koraci OK"
else
    echo "   Status:  ⚠️  ${#FAILED_STEPS[@]} korak/a vraćao nenula:"
    for s in "${FAILED_STEPS[@]}"; do
        echo "            • $s"
    done
    echo ""
    echo "   ℹ️  Pipeline ne aborta na nenula iz pojedinog koraka — failed videi"
    echo "      bit će pokupljeni sljedećim manualnim re-runom (vjerojatno preko"
    echo "      iPhone tethering-a, ako se radi o YouTube anti-bot blokovima)."
fi
echo ""
