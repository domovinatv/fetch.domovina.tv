#!/bin/bash
# agy piše članke (sažetak + outline + iteracije) kroz N paralelnih tmux sesija.
#   run_agy_articles.sh <N> <model-slug> <ulaz> [ID,ID,...]
#   run_agy_articles.sh 4 agy-gemini-3-8-flash canary-1b-v2+pyannote-c1+agy-gemini-3-8-flash
# Epizode se dijele na N redova po trajanju (najdulja ide u najkraći red); unutar reda sekvencijalno.
# Idempotentno (llm_opus.js preskače gotove i nastavlja po iteraciji).
# Gledanje: tmux attach -t agycN -r   (agy hvata Ctrl-b; izlaz = zatvori prozor)
#
# agy svakih ~30 s pokrene GitKraken `gk mcp` i ne ugasi ga (255 procesa / 2,2 GB nakon 8 h na
# 4 sesije, 15.10.2026.), pa ih ovdje periodično čistimo — samo potomke naših agy procesa i siročad.
set -u
N="$1"; MODEL="$2"; INP="$3"; ONLY="${4:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
unset ANTHROPIC_API_KEY
W="$HERE/data/agy_work"; mkdir -p "$W"; W="$(cd "$W" && pwd)"
L="$HERE/data/logs/llm"; mkdir -p "$L"
AGY_MODEL=$(node -e 'const s=require("fs").readFileSync("llm_opus.js","utf8");const m=s.match(new RegExp("\""+process.argv[1]+"\":\\s*\\{[^}]*model: \"([^\"]+)\""));if(!m)process.exit(1);console.log(m[1])' "$MODEL") \
    || { echo "nepoznat model $MODEL"; exit 2; }

# ── redovi: najdulji SRT prvi, svaki u trenutno najkraći red ──
QUEUES=$(node -e '
const fs=require("fs"),[n,inp,only]=[+process.argv[1],process.argv[2],process.argv[3]];
const rows=fs.readFileSync("bases.tsv","utf8").trim().split("\n").slice(1).map(l=>l.split("\t"))
  .filter(r=>!only||only.split(",").includes(r[0]))
  .map(([id,k,b])=>({id,sz:fs.statSync(`data/output/${k}/${b}.exp-20261010.${inp}.dijariziran.srt`).size}))
  .sort((a,b)=>b.sz-a.sz);
const q=Array.from({length:n},()=>({sz:0,ids:[]}));
for(const r of rows){const t=q.reduce((a,b)=>a.sz<=b.sz?a:b);t.ids.push(r.id);t.sz+=r.sz;}
console.log(q.map(x=>x.ids.join(",")).join("\n"));' "$N" "$INP" "$ONLY")

start_session() {
    local s="$1"
    tmux has-session -t "$s" 2>/dev/null && return
    tmux new-session -d -s "$s" -x 180 -y 50 -c "$W"
    tmux send-keys -t "$s" "agy --model $AGY_MODEL --dangerously-skip-permissions" Enter
    for _ in $(seq 1 30); do
        sleep 2
        tmux capture-pane -p -t "$s" | grep -q "for shortcuts" && return
    done
    echo "[$s] agy se nije pokrenuo (prijava? povjerenje za $W?)"; tmux capture-pane -p -t "$s" | tail -8
    return 1
}

reap_gk() {
    while sleep 60; do
        for s in $(tmux ls -F '#S' 2>/dev/null | grep '^agyc'); do
            for p in $(tmux list-panes -t "$s" -F '#{pane_pid}'); do
                for a in $(pgrep -P "$p"); do pkill -f -P "$a" "gk mcp" 2>/dev/null; done
            done
        done
        # siročad (roditelj ugašen → ppid 1)
        ps -axo pid=,ppid=,command= | awk '$2==1 && /gk mcp/ {print $1}' | xargs kill 2>/dev/null
    done
}
reap_gk & REAPER=$!
trap 'kill $REAPER 2>/dev/null' EXIT

i=0
while IFS= read -r ids; do
    i=$((i + 1)); s="agyc$i"
    [ -z "$ids" ] && continue
    start_session "$s" < /dev/null || continue
    (
        for id in $(echo "$ids" | tr , ' '); do
            node llm_opus.js --model "$MODEL" --input "$INP" --id "$id" --session "$s" --work-dir "$W" \
                < /dev/null > "$L/$id.$INP.$MODEL.log" 2>&1
            echo "[$s] $id exit=$? $(grep -c '✅' "$L/$id.$INP.$MODEL.log")✅"
        done
        echo "[$s] red gotov"
    ) &
done <<< "$QUEUES"   # ne cijev: while u podljusci, pa wait ne bi čekao redove
wait
echo "GOTOVO"
