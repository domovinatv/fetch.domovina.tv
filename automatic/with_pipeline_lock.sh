#!/usr/bin/env bash
# with_pipeline_lock.sh — pokreni naredbu pod DIJELJENIM pipeline lockom (pipeline_lock.sh).
#
# Za kratke korake koji pišu u isto što i run_pipeline (channel index + R2 meta upload),
# a pokreću se izvan nightly/priority ticka — danas Magisterium runbook korak 7. Čeka da se
# lock oslobodi (prioritetni run ga drži ~15-25 min, između runova ima 90 s rupe), najviše
# PIPELINE_LOCK_WAIT_S sekundi (default 1800). Nakon toga izlazi s 75 BEZ pokretanja
# naredbe, da objava nikad ne ide mimo locka; ponovni pokušaj je siguran (idempotentno).
#
#   automatic/with_pipeline_lock.sh bash -c 'node generate_channel_index.js --channel X && …'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PIPELINE_LOCK="$SCRIPT_DIR/logs/.pipeline.lock.d"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/pipeline_lock.sh"

WAIT_S="${PIPELINE_LOCK_WAIT_S:-1800}"
deadline=$(( $(date +%s) + WAIT_S ))
announced=0
until acquire_pipeline_lock nowait; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "❌ pipeline lock zauzet i nakon ${WAIT_S}s — NE objavljujem. Ponovi kasnije." >&2
        exit 75
    fi
    if [ "$announced" = 0 ]; then
        echo "⏳ pipeline lock zauzet (nightly/priority run) — čekam do ${WAIT_S}s…"
        announced=1
    fi
    sleep 5
done
trap 'release_pipeline_lock' EXIT INT TERM
"$@"
