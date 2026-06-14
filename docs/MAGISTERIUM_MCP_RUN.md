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

### 5. Sastavi finalnu datoteku U STORAGE (per-section, NE full)
```bash
D="storage/output/<channel>"; B="<basename>"
node magisterium_mcp_assemble.js --job "$JOB" --results-dir "$RESULTS" \
  --out "$D/$B.article.magisterium.json"
```
`assemble.js` automatski čita `magisterium_doc_urls.json` (keš) za source_url.

> **NE generiraj `--out-full`.** `_full.json` je HR-only (Flutter `MagisteriumFullData`
> NE čita `evaluation_en`) i njegov primarni "Evaluacija" tab **gazi** per-section tab →
> blokira dvojezični prikaz. Produkcijski standard (vidi `fO7iltytw0I`) je per-section
> `.json` + `.en.json` overlay. Holistički sadržaj ostaje u `overall` bloku per-section
> datoteke (podatkovni ugovor). `--out-full` postoji samo za HR-only ad-hoc preglede.

### 6. Engleski overlay (dvojezičnost)
```bash
node translate_to_english.js --input-dir storage/output --video-id "$VID"
```
Generira `*.article.magisterium.en.json` (+ summary.en, article.en) — puni mirror s `_en`
poljima (`assessment_en`, `enrichment_en`, `concerns_en`, `theme_en`, `subtitle_en`, …),
temperature 0, "no hallucinations". Citati se NE prevode (već su engleski). Flutter ga
učita kao EN overlay kad je jezik engleski. Idempotentno (preskače ako `.en.json` postoji
— za prisilni re-translate obriši stari `.en.json`).

### 7. Channel index + R2 + verifikacija
```bash
node generate_channel_index.js --channel <channel>
node upload_to_r2.js --input-dir storage/output --video-id "$VID"   # .magisterium.json + .en.json
node upload_to_r2.js --meta-dir storage/meta                         # channel index
# GET-verifikacija (NE HEAD — CDN cache-ira 404):
for f in article.magisterium.json article.magisterium.en.json; do
  curl -s -o /dev/null -w "%{http_code} $f\n" "https://cdn.domovina.ai/data/$VID/$f"; done
```

## Kriterij uspjeha
- `assemble` prijavi **sve sekcije ocijenjene** (X/X), root `overall_score` postavljen.
- Channel index: video ima `pipeline.has_magisterium=true` i `magisterium_score`.
- CDN GET vraća **200** za `article.magisterium.json` **i** `article.magisterium.en.json`.
- Vidljivo na `https://domovina.ai/v/<VID>` — per-section prikaz (score+citati po sekciji)
  na hrvatskom, te isti prikaz na engleskom kad je jezik EN.

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

## Bulk backfill (više epizoda) — naučeno 2026-06-13

- **NE radi cijelu sekvencu u jednom chatu.** ~17 epizoda u jednom kontekstu = ~724k/1M tokena. Magisterium `chat` je **stateless** (nema server-side miješanja između epizoda), ali sve-u-jednom-chatu pojede kontekst i nosi orkestracijski rizik (LLM drži sav sadržaj). **Bolje: jedan subagent po epizodi, SEKVENCIJALNO** (chat nije parallel-safe, 15 req/min). Svaki subagent: prep→holistic→batches→assemble→publish; vrati samo score+CDN status.
- **HR-only opcija:** ako se EN preskače (brže pokrivanje), po epizodi: assemble → `publish_hr_episode.sh <VID>` (instant upload+reindex+meta+GET). EN dodaj naknadno (`translate_to_english.js`, ~25-30 min/ep jer je per-field).
- **Instant vidljivost zahtijeva reindex+R2 po epizodi:** `/v/{id}` čita per-video `article.magisterium.json` s CDN-a; `/c/` badge čita channel index. Bez `generate_channel_index.js` + meta upload magisterium ostaje "nevidljiv".
- **Leading-dash YouTube ID gotcha:** VID koji počinje crticom (npr. `-bOmDXC7rlA`) bash tretira kao opciju → zovi `bash publish_hr_episode.sh -- <VID>`. `node ... --video-id <VID>` radi ispravno.
