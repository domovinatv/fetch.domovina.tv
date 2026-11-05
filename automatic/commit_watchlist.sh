#!/bin/bash
# commit_watchlist.sh — commit + push dnevnog osvježenja watchliste i registryja.
#
# Nightly (5b/5b+/5c) i priority tick svaki dan mijenjaju automatic/watchlist/ i
# data/podcasts_registry.*; prije ovoga je sve to ostajalo necommitano dok se ručno
# ne pokupi. Skripta commita SAMO te putanje (pathspec na `git commit`), pa tuđi
# staged fajlovi iz paralelne Claude sesije ne završe u ovom commitu.
#
# Push je ne-fatalan: ako ne prođe (mreža, remote ispred), commit ostaje lokalno i
# idući run ga gurne. Push nosi i druge lokalne commitove na mainu koji još nisu gore.
#
# Ručno:  ./automatic/commit_watchlist.sh [--no-push]
# Gasi u nightlyju: WATCHLIST_COMMIT_OFF=1

set -u
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR" || exit 1

PUSH=true
[ "${1:-}" = "--no-push" ] && PUSH=false

PATHS=(automatic/watchlist data/podcasts_registry.json data/podcasts_registry.csv data/podcasts_registry.md)

# Ne diraj repo usred rebasea/mergea ili tuđe git operacije.
GIT_DIR="$(git rev-parse --git-dir)"
for m in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD index.lock; do
    if [ -e "$GIT_DIR/$m" ]; then
        echo "   ⏭️  git je usred operacije ($m) — preskačem commit watchliste"
        exit 0
    fi
done

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
    echo "   ⏭️  grana je '$BRANCH', ne main — preskačem commit watchliste"
    exit 0
fi

# Novi fajlovi (npr. lista novog kanala) moraju biti dodani prije pathspec commita.
git add -- "${PATHS[@]}"

if git diff --cached --quiet -- "${PATHS[@]}"; then
    echo "   ✅ watchlist/registry bez promjena — nema commita"
else
    N_NEW=0
    if git diff --cached --quiet -- automatic/watchlist/events.jsonl; then :; else
        N_NEW=$(git diff --cached -U0 -- automatic/watchlist/events.jsonl | grep -c '^+[^+]' || true)
    fi
    MSG="chore(watchlist): dnevno osvježenje $(date '+%d.%m.%Y.') (${N_NEW} novih događaja)"
    git commit -q -m "$MSG" -- "${PATHS[@]}" || { echo "   ❌ commit nije uspio"; exit 1; }
    echo "   ✅ $(git log -1 --oneline)"
fi

if [ "$PUSH" = true ]; then
    AHEAD=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
    if [ "$AHEAD" -gt 0 ]; then
        if GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=20" git push -q origin main; then
            echo "   ✅ push: $AHEAD commit(a) na origin/main"
        else
            echo "   ⚠️  push nije prošao — commit ostaje lokalno, idući run pokušava ponovno"
            exit 0
        fi
    fi
fi
exit 0
