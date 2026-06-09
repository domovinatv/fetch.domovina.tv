#!/bin/bash
# Offline mermaid syntax validacija za markdown fajl(ove) PRIJE commita.
# Koristi mermaid-cli (npx) + lokalni Chromium-based browser (Brave/Chrome) — bez chromium downloada.
# Uporaba: tools/check_mermaid.sh docs/PIPELINE_FULL.md [drugi.md ...]
set -uo pipefail
# nađi Chromium-based browser
BROWSER=""
for b in "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
         "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
         "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
  [ -x "$b" ] && { BROWSER="$b"; break; }
done
[ -z "$BROWSER" ] && { echo "❌ Nema Chromium-based browsera (Brave/Chrome)"; exit 2; }
PCFG=$(mktemp); printf '{"executablePath":"%s","args":["--no-sandbox"]}' "$BROWSER" > "$PCFG"
TMP=$(mktemp -d); rc=0
for md in "$@"; do
  node -e '
    const fs=require("fs"); const md=fs.readFileSync(process.argv[1],"utf8");
    const re=/```mermaid\n([\s\S]*?)```/g; let m,i=0;
    while((m=re.exec(md))){i++; fs.writeFileSync(`'"$TMP"'/b_${i}.mmd`, m[1]);}
    console.log(i);
  ' "$md" >/dev/null
  for f in "$TMP"/b_*.mmd; do
    [ -e "$f" ] || continue
    i=$(basename "$f" .mmd | sed 's/b_//')
    out=$(npx -y @mermaid-js/mermaid-cli -i "$f" -o "$f.svg" -p "$PCFG" 2>&1)
    if echo "$out" | grep -qiE "parse error|^Error:"; then
      echo "❌ $md blok $i:"; echo "$out" | grep -iE "error|line" | head -2 | sed 's/^/   /'; rc=1
    else echo "✅ $md blok $i"; fi
  done
  rm -f "$TMP"/b_*.mmd "$TMP"/b_*.svg
done
rm -rf "$TMP" "$PCFG"
[ $rc -eq 0 ] && echo "=== SVI MERMAID BLOKOVI VALIDNI ===" || echo "=== GREŠKE — NE COMMITAJ ==="
exit $rc
