#!/usr/bin/env bash
# priority_worker.sh — JEDAN prioritetni slot (pokreće ga priority_pipeline.sh, setsid).
#
# Claima najviše 1 prioritetni job i vrti puni single-video pipeline (priority_poller.js →
# run_pipeline.sh --modal-only <id>). Slot (logs/.priority.d/slot-N) drži dok radi i miče
# ga na izlazu; mrtav PID dispatcher prepozna kao stale i slot ponovno koristi.
# Okolina (PATH, nvm, .env, yt-dlp) dolazi od dispatchera. Svaki redak loga nosi [sN]
# jer više slotova piše u isti dnevni priority log.

: "${PRIORITY_SLOT:?}" "${PRIORITY_SLOT_LOCK:?}" "${PRIORITY_LOG_FILE:?}" "${BRIDGE:?}"
echo "$$" > "$PRIORITY_SLOT_LOCK/pid"
trap 'rm -rf "$PRIORITY_SLOT_LOCK"' EXIT INT TERM

run_slot() {
    echo "$(date '+%F %T') ⚡ ─── SLOT $PRIORITY_SLOT START (PID $$) ───"
    # CLAUDE_WINDOW_GUARD se nasljeđuje kroz priority_poller.js do koraka 7+8 (vidi
    # launchd-menubar/SCHEDULING.md). Poller po uspjehu zove auto_reuse_adhoc.js, čiji
    # reindex ide kroz with_pipeline_lock.sh (publish lock).
    if [ -f "$BRIDGE/priority_poller.js" ]; then
        PRIORITY_MAX=1 CLAUDE_WINDOW_GUARD=1 node "$BRIDGE/priority_poller.js"
    else
        echo "   ⚠️ nema priority_poller.js — preskačem."
    fi
    echo "$(date '+%F %T') ⚡ ─── SLOT $PRIORITY_SLOT DONE ───"
}

run_slot 2>&1 | perl -ne 'BEGIN { $| = 1 } print "[s'"$PRIORITY_SLOT"'] $_"' >> "$PRIORITY_LOG_FILE"
