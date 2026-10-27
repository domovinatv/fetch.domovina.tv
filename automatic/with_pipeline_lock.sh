#!/usr/bin/env bash
# with_pipeline_lock.sh — pokreni kratku OBJAVU (channel index + R2 meta upload) pod uskim
# publish lockom (logs/.publish.lock.d).
#
# Do 27.10.2026. ovo je uzimalo dijeljeni pipeline lock koji je prioritetni run držao cijelim
# trajanjem (30–60 min po videu), pa je Magisterium objava čekala i padala nakon 30 min.
# Prioritetni fast-path channel index ne dira, pa objava čeka samo:
#   • drugu objavu (sekunde) — .publish.lock.d
#   • nightly / ručni bulk koji drži .pipeline.lock.d (on legitimno prepisuje pola stabla)
# Redoslijed: prvo publish lock, PA provjera globalnog. nightly_pipeline.sh radi obrnuto
# (globalni, pa čeka da publish nestane), pa barem jedna strana uvijek vidi drugu.
# Najviše PIPELINE_LOCK_WAIT_S sekundi (default 1800); nakon toga exit 75 BEZ pokretanja
# naredbe (ponovni pokušaj je siguran, idempotentno).
#
#   automatic/with_pipeline_lock.sh bash -c 'node generate_channel_index.js --channel X && …'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL_LOCK="$SCRIPT_DIR/logs/.pipeline.lock.d"
export PIPELINE_LOCK="$SCRIPT_DIR/logs/.publish.lock.d"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/pipeline_lock.sh"

# Živ holder globalnog locka (prazan pid u postojećem direktoriju = upravo uzet).
global_busy() {
    [ -d "$GLOBAL_LOCK" ] || return 1
    local holder
    holder="$(cat "$GLOBAL_LOCK/pid" 2>/dev/null || echo "")"
    [ -z "$holder" ] && return 0
    # Nightly drži globalni lock i SAM poziva objavu (auto_reuse_adhoc.js --sweep) → nije
    # blokada za vlastitu djecu (PIPELINE_GLOBAL_HOLDER izvozi nightly_pipeline.sh).
    [ "$holder" = "${PIPELINE_GLOBAL_HOLDER:-}" ] && return 1
    kill -0 "$holder" 2>/dev/null
}

WAIT_S="${PIPELINE_LOCK_WAIT_S:-1800}"
deadline=$(( $(date +%s) + WAIT_S ))
announced=0
while true; do
    if acquire_pipeline_lock nowait; then
        global_busy || break
        release_pipeline_lock
        why="nightly/bulk drži pipeline lock"
    else
        why="druga objava u tijeku"
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "❌ objava blokirana i nakon ${WAIT_S}s ($why) — NE objavljujem. Ponovi kasnije." >&2
        exit 75
    fi
    if [ "$announced" = 0 ]; then
        echo "⏳ $why — čekam do ${WAIT_S}s…"
        announced=1
    fi
    sleep 5
done
trap 'release_pipeline_lock' EXIT INT TERM
"$@"
