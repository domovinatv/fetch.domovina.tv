#!/usr/bin/env bash
# pipeline_log_digest.sh — čisti "ružne" logove (script(1)/tee output s ANSI + \r
# progress redraw spamom) i ispisuje KOMPAKTAN digest namijenjen tome da ga Claude
# pokrene umjesto da učitava cijeli sirovi log u kontekst (minimalno tokena).
#
# Korištenje:
#   ./pipeline_log_digest.sh                 # auto-uzme najnoviji pipeline_run_*.log
#   ./pipeline_log_digest.sh putanja.log     # konkretan log
#   ./pipeline_log_digest.sh --full [log]    # zapiše OČIŠĆEN cijeli log u <log>.clean (ne na stdout)
#   ./pipeline_log_digest.sh --errors [log]  # samo sekcija problema
#   ./pipeline_log_digest.sh --tail N [log]  # promijeni broj linija "zadnje aktivnosti" (default 12)
#
# Dizajn: bash 3 kompatibilno (macOS). Čišćenje preko perl-a (uvijek prisutan na macOS).

set -u

TAIL_N=12
MODE="digest"
LOG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --full)    MODE="full"; shift ;;
    --errors)  MODE="errors"; shift ;;
    --tail)    TAIL_N="${2:-12}"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         LOG="$1"; shift ;;
  esac
done

# Auto-detekcija najnovijeg loga ako nije zadan
if [ -z "$LOG" ]; then
  LOG=$(ls -t pipeline_run_*.log 2>/dev/null | head -1)
fi
if [ -z "$LOG" ] || [ ! -f "$LOG" ]; then
  echo "✗ Nema loga (zadaj putanju ili pokreni iz mape s pipeline_run_*.log)" >&2
  exit 1
fi

# --- ČIŠĆENJE ---
# 1) makni ANSI CSI (\e[...m, cursor moves) i OSC (\e]...BEL) sekvence
# 2) makni backspace
# 3) collapse carriage-return redraw: zadrži samo sadržaj iza zadnjeg \r u retku
# 4) makni script(1) "Script started/done on ..." header/footer
clean() {
  perl -pe '
    s/\e\[[0-9;?]*[ -\/]*[@-~]//g;   # CSI
    s/\e\][^\a\e]*(?:\a|\e\\)//g;    # OSC
    s/\x08//g;                       # backspace
    s/.*\r(?!\n)//;                  # collapse do zadnjeg CR u retku
  ' "$LOG" | grep -vE '^Script (started|done) on '
}

if [ "$MODE" = "full" ]; then
  OUT="${LOG%.log}.clean.log"
  clean > "$OUT"
  echo "✓ Očišćen log → $OUT ($(wc -l < "$OUT" | tr -d ' ') linija). Grep-aj ovaj file umjesto sirovog."
  exit 0
fi

CLEAN=$(clean)

# Patterni
ERR_PAT='ABORT|anti-bot|❌|\bgreška\b|\bGreška\b|\berror\b|\bError\b|\bERROR\b|\bfail|\bFAIL|Traceback|Exception|OOM|\b429\b|PROHIBITED|blocked|Neuspjel'
STEP_PAT='📢|KORAK'
DONE_PAT='ZAVRŠEN|Završen|Neuspjelih:|Uspješno|Gotovo|completed|✅'

SIZE=$(du -h "$LOG" | cut -f1)
MTIME=$(date -r "$LOG" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "?")

echo "═══ LOG: $LOG  ($SIZE, zadnja izmjena $MTIME) ═══"

# --- PROBLEMI ---
ERRORS=$(printf '%s\n' "$CLEAN" | grep -nE "$ERR_PAT" | grep -vE 'ABORT_ON|# ' )
ERR_COUNT=$(printf '%s' "$ERRORS" | grep -c . )
echo
echo "── Problemi (ABORT/error/fail/429/OOM/blocked) — nađeno: ${ERR_COUNT} ──"
if [ "$ERR_COUNT" -gt 0 ]; then
  # dedup po tekstu (bez line-num prefiksa), zadrži prvih 30
  printf '%s\n' "$ERRORS" | awk '{key=$0; sub(/^[0-9]+:/,"",key); if(!seen[key]++) print}' | head -30
  [ "$ERR_COUNT" -gt 30 ] && echo "   … (+$((ERR_COUNT-30)) više; --errors za sve)"
else
  echo "   (nema)"
fi

[ "$MODE" = "errors" ] && exit 0

# --- ZADNJI KORAK ---
echo
echo "── Zadnji korak ──"
printf '%s\n' "$CLEAN" | grep -E "$STEP_PAT" | tail -1 | sed 's/^[[:space:]]*//' || echo "   (nijedan KORAK marker)"

# --- ZAVRŠNI STATUS ---
DONE=$(printf '%s\n' "$CLEAN" | grep -E "$DONE_PAT" | tail -5)
if [ -n "$DONE" ]; then
  echo
  echo "── Završni / status linije (zadnjih 5) ──"
  printf '%s\n' "$DONE" | sed 's/^[[:space:]]*//'
fi

# --- ZADNJA AKTIVNOST ---
echo
echo "── Zadnjih ${TAIL_N} linija aktivnosti ──"
printf '%s\n' "$CLEAN" | grep -vE '^[[:space:]]*$' | tail -"$TAIL_N" | sed 's/^[[:space:]]*//'
