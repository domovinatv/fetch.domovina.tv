#!/bin/bash
# Jedna agy tmux sesija + red epizoda kroz agy_refine.js (sekvencijalno unutar sesije).
#   run_agy_queue.sh <sesija> <agy-trusted-dir> <ID> [<ID> ...]
# Više paralelnih redova = više poziva ove skripte s različitim imenom sesije.
# Gledanje: tmux attach -t <sesija> -r   (agy hvata Ctrl-b; izlaz = zatvori prozor)
set -u
S="$1"; W="$2"; shift 2
HERE="$(cd "$(dirname "$0")" && pwd)"
if ! tmux has-session -t "$S" 2>/dev/null; then
    tmux new-session -d -s "$S" -x 180 -y 50 -c "$W"
    tmux send-keys -t "$S" "agy --model gemini-3.8-flash-high --dangerously-skip-permissions" Enter
    sleep 20
    tmux send-keys -t "$S" Escape
    sleep 2
fi
for id in "$@"; do
    node "$HERE/agy_refine.js" --id "$id" --session "$S" --work-dir "$W" || echo "[$S] $id PAO (exit $?)"
done
echo "[$S] red gotov"
