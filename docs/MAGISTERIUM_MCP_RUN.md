# MAGISTERIUM_MCP_RUN — autonomni hibridni Magisterium za jedan video

> **Kako se koristi:** u Claude Code chatu napiši `@docs/MAGISTERIUM_MCP_RUN.md <YOUTUBE_ID>`
> (npr. `@docs/MAGISTERIUM_MCP_RUN.md lFQh5i6EyUU`). Claude tada **autonomno** provede
> cijeli hibridni Magisterium MCP workflow za taj video i objavi rezultat na CDN.
> Ne pitaj korisnika kako nastaviti; stani samo na pravom blockeru (nema article.json,
> GCP/R2 auth fail, ili svi `chat` pozivi time-outaju i nakon retry-ja).

Ovo je izvršni runbook. Pozadina/arhitektura: [`magisterium_ai_integration.md`](./magisterium_ai_integration.md).
Detaljni nalazi: [`magisterium_mcp_hybrid_2026-05.md`](./magisterium_mcp_hybrid_2026-05.md).

## Preduvjeti (provjeri, ne pretpostavljaj)
- Magisterium AI MCP dostupan u sesiji (`mcp__..._Magisterium_AI__chat` / `__search`).
  **Samo MCP, NIKAD API ključevi** (vidi memoriju `magisterium_mcp_only_never_api_keys`).
- Postoji `*.article.json` za video (leksikografski najnoviji `_{date}_{model}`).
- `chat` je **sekvencijalan-only** (paralelno → greške); `search` **je parallel-safe**.
  Rate limit **15 req/min** dijeljen.

## Koraci

### 1. Nađi article + pripremi promptove
```bash
VID=<YOUTUBE_ID>
ART=$(find -L storage/output -name "*_yt_${VID}*.article.json" | grep -v '/\._' | sort | tail -1)
node magisterium_mcp_prep.js --article "$ART" --batch-size 4   # default --max-words 60 (timeout-safe)
```
Zapamti `basename`, `RESULTS=/tmp/mag_hybrid/<basename>.results` (napravi `mkdir -p`),
`PROMPTS=/tmp/mag_hybrid/<basename>.prompts`. Iz ispisa znaš koliko batchova.

### 2. SLOJ 1 — holistički (1× `chat`)
Pošalji sadržaj `PROMPTS/holistic.txt` kroz `chat`. (Smiješ zamijeniti ružni basename-naslov
čistim naslovom epizode radi kvalitete.) Spremi **cijeli sirovi odgovor** (JSON blok +
`References:` lista) u `RESULTS/holistic.raw.txt`.

### 3. SLOJ 2 — granularno (⌈sekcija/4⌉× `chat`, SEKVENCIJALNO)
Za svaki `PROMPTS/batch_NN.txt`: pošalji kroz `chat`, spremi sirovi odgovor u
`RESULTS/batch_NN.raw.txt`. **Jedan `chat` po poruci** (ne paralelno).
- Ako `chat` **time-outa**: ponovi s **kraćim sadržajem** (sažmi svaku sekciju na 1–2
  rečenice). Ako i to time-outa: razdvoji batch na 2 manja. Tek onda odustani.

### 4. SLOJ 3 — citat→URL (najprije keš, pa `search` za nepoznato)
Sastavi probno (bez `--url-map`) da vidiš koje dokumente keš ne pokriva:
```bash
node magisterium_mcp_assemble.js --job "$JOB" --results-dir "$RESULTS" --out /tmp/probe.json
```
Za svaki **nerazriješeni dokument** koji assemble prijavi: pokreni `search` (smiješ
paralelno, ≤15/min), uzmi doc UUID iz vraćenog URL-a (`.../docs/{uuid}/ref/...`) i
**dodaj `{ "match": "<jedinstveni substring naslova>", "uuid": "<uuid>" }` u
`magisterium_doc_urls.json`** (keš trajno raste → idući videi su jeftiniji).

### 5. Sastavi finalne datoteke U STORAGE
```bash
D="storage/output/<channel>"; B="<basename>"
node magisterium_mcp_assemble.js --job "$JOB" --results-dir "$RESULTS" \
  --out "$D/$B.article.magisterium.json" --out-full "$D/$B.article.magisterium_full.json"
# prompt md (transparentnost / "Prompt" tab):
{ echo "# Magisterium MCP hibrid — promptovi"; for f in "$PROMPTS"/holistic.txt "$PROMPTS"/batch_*.txt; do
    echo; echo "## $(basename "$f" .txt)"; echo; echo '```'; cat "$f"; echo '```'; done
} > "$D/$B.article.magisterium_full_prompt.md"
```
`assemble.js` automatski čita `magisterium_doc_urls.json` (keš) za source_url.

### 6. Channel index + R2 + verifikacija
```bash
node generate_channel_index.js --channel <channel>
node upload_to_r2.js --input-dir storage/output --video-id "$VID"   # 3 nova magisterium filea
node upload_to_r2.js --meta-dir storage/meta                         # channel index
# GET-verifikacija (NE HEAD — CDN cache-ira 404):
for f in article.magisterium.json article.magisterium_full.json article.magisterium_full_prompt.md; do
  curl -s -o /dev/null -w "%{http_code} $f\n" "https://cdn.domovina.ai/data/$VID/$f"; done
```

## Kriterij uspjeha
- `assemble` prijavi **sve sekcije ocijenjene** (X/X), root `overall_score` postavljen.
- Channel index: video ima `pipeline.has_magisterium=true` i `magisterium_score`.
- Sva 3 CDN GET-a vraćaju **200**; `overall_score` čita se s CDN-a.
- Vidljivo na `https://domovina.ai/v/<VID>` ("Evaluacija" + "Prompt" tab).

## Prompt-predlošci (referenca — generira ih `prep.js`, ne tipkaj ručno)

**Holistički** (ulaz = teme + podteme iz outline-a):
```
Ti si stručni teološki analitičar Katoličke Crkve. … daj JEDNU sveobuhvatnu evaluaciju …
Vrati ISKLJUČIVO JSON: {"overall_score":<0-100>,"assessment":"…","seeds_of_logos":["…"],
"concerns":["…"],"theological_context":"…"}   [+ skala 90-100…0-29]
```

**Batch (per-sekciju, N=4)** (ulaz = trimani sadržaj sekcija):
```
Ti si teološki analitičar. Evaluiraj usklađenost sljedećih N odlomaka … Vrati ISKLJUČIVO JSON:
{"results":[{"index":0,"score":<0-100>,"assessment":"…","concerns":["…"],"enrichment":"…"}]}
[+ skala]
```

## Bitno (iz empirije)
- root `overall_score` = **prosjek sekcija** (apples-to-apples s legacy datotekama).
  Holistički score živi u `overall.holistic_score`.
- NE prepisuj postojeće; piši nove datoteke (`assemble` to i radi).
- `chat` uvijek doda markdown `References` — `assemble.js` ih robusno parsira (`[^N]`).
