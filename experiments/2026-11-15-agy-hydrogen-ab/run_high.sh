#!/bin/bash
# Dopuna A/B-a: hydrogen-high na iste 3 epizode (pokreće se kad run.sh završi, isti tmux slot 9).
cd "$(dirname "$0")" || exit 1
while pgrep -f "experiments/2026-11-15-agy-hydrogen-ab/run.sh" >/dev/null; do sleep 20; done
MODELS=hydrogen-high ./run.sh
