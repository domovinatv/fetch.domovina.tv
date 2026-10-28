#!/bin/bash
# Markdown s mermaidom → PDF: mermaid-cli (SVG) → pandoc (samostalni HTML) → Brave headless (PDF).
# Upotreba: ./build.sh clanci.md "Ora_et_Labora_x_DOMOVINA_ai_clanci_120_121.pdf"
set -euo pipefail
cd "$(dirname "$0")"
IN="$1"; OUT="$2"; B="${IN%.md}"
BRAVE="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
npx -y @mermaid-js/mermaid-cli -i "$IN" -o "$B.rendered.md" -p pcfg.json -c mcfg.json -e svg
# mmdc piše alt "diagram", a pandoc ga pretvori u natpis ispod slike
sed -i '' 's/!\[diagram\]/![]/' "$B.rendered.md"
pandoc "$B.rendered.md" -s --embed-resources --css style.css --metadata title=" " -o "$B.html"
"$BRAVE" --headless --disable-gpu --no-pdf-header-footer --virtual-time-budget=5000 \
  --print-to-pdf="$PWD/$OUT" "file://$PWD/$B.html"
rm -f "$B".rendered*.md "$B".rendered-*.svg "$B.html"
echo "→ $OUT"
