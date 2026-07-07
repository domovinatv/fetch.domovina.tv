#!/usr/bin/env bash
# Dijeljeni mutex između noćnog bulka (nightly_pipeline.sh) i prioritetnog fast-patha
# (priority_pipeline.sh): da dva run_pipeline.sh procesa NIKAD ne rade istovremeno nad
# istim _unlisted/ + state datotekama (convert/diarize/state race).
#
# Portabilno: koristi `mkdir` kao atomični test-and-set (macOS NEMA `flock`). Holder PID
# se piše u lock/pid pa se mrtvi (stale) lock automatski preuzima.
#
# Zahtijeva env PIPELINE_LOCK = putanja do lock DIREKTORIJA.
#   acquire_pipeline_lock wait    → blokira dok se ne oslobodi (noćni bulk)
#   acquire_pipeline_lock nowait  → vrati 1 ako je zauzet (prioritetni tick preskače)
#   release_pipeline_lock         → otpusti (pozovi iz trap-a)

acquire_pipeline_lock() {   # $1 = wait|nowait (default wait)
    local mode="${1:-wait}"
    while true; do
        if mkdir "$PIPELINE_LOCK" 2>/dev/null; then
            echo "$$" > "$PIPELINE_LOCK/pid" 2>/dev/null || true
            return 0
        fi
        # Zauzet — je li holder još živ?
        local holder
        holder="$(cat "$PIPELINE_LOCK/pid" 2>/dev/null || echo "")"
        if [ -z "$holder" ] || ! kill -0 "$holder" 2>/dev/null; then
            echo "ℹ️  stale pipeline lock (PID '${holder:-?}' mrtav) — preuzimam."
            rm -rf "$PIPELINE_LOCK"
            continue
        fi
        [ "$mode" = "nowait" ] && return 1
        sleep 5
    done
}

release_pipeline_lock() { rm -rf "$PIPELINE_LOCK" 2>/dev/null || true; }
