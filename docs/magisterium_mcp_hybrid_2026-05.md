# Magisterium MCP — hibridni workflow (SSOT)

**Datum:** 2026-05-29 · **Status:** validirano na demo epizodi, NIJE još uvezano u `run_pipeline.sh`

Rješava napetost koju je korisnik opisao: **per-section MCP pozivi su presporo**
(npr. 26 sporih `chat` poziva), a **jedan whole-podcast poziv ne daje granularnost**.
Hibrid daje oboje, uz dramatično manje *sporih* poziva.

> **Zašto MCP, ne API.** Magisterium MCP (`chat`/`search`/`fetch`) je besplatan pod Pro
> pretplatom (15 req/min); API ključevi su skupi zaseban plan. Vidi memoriju
> `magisterium_mcp_only_never_api_keys`. MCP toolovi su dostupni **samo unutar Claude
> Code chata**, ne iz standalone Node skripte → workflow je "Claude-in-the-loop":
> dvije deterministicke skripte + Claude koji izvodi MCP pozive između.

---

## Empirijski nalazi o Magisterium MCP toolovima (2026-05-29)

| Tool | Što vraća | Brzina | Uloga |
|---|---|---|---|
| `chat` | Traženi JSON **+ uvijek doda** markdown analizu + `References` listu (`[^N] → dokument, paragraf`) | **Sporo** — usko grlo | Scoring (sloj 1 + 2) |
| `search` | `[{id, url, title}]` | Trenutno | Citat → URL (sloj 3) |
| `fetch` | Puni tekst dokumenta + `metadata.ref` | Trenutno | Dohvat izvora |
| `get_saint`/`get_pope`/`get_person`/`get_diocese`/`get_martyrology`/`get_mass_readings` | Strukturirani lookup | Brzo | Enrichment entiteta (opcionalno) |

**Ključno o batch-veličini i timeoutu:**
- `chat` je **sekvencijalan-only**. 3 paralelna poziva → 1 OK + 2 `[object Object]`.
  Paralelni subagenti se za `chat` **sudaraju** + dijele 15 req/min → ne pomažu.
- **Timeout je djelomično stohastičan** i ovisi o **dubini generacije po sekciji**,
  ne (samo) o broju sekcija:
  - batch-of-8 *one-linera* → prošlo
  - batch-of-6 stvarnog sadržaja → **TIMEOUT**
  - batch-of-4 stvarnog sadržaja (~107 rij./sekciji) → uglavnom prolazi, ali **i to zna time-outati**
  - batch-of-4 **komprimiranog** sadržaja (~30 rij./sekciji) → pouzdano i brzo
- **Glavna poluga protiv timeouta = KRATAK sadržaj po sekciji**, ne manji batch.
  Zato `magisterium_mcp_prep.js` trima agresivno; ako batch ipak time-outa: **retry
  s još kraćim sadržajem**, pa tek onda split batcha na 2.

**Citat → URL (`search`) je best-effort:** kanonski dokumenti (KKC, velike enciklike)
se razrješavaju egzaktno (`CCC 2293` → `.../ref/2293`), ali niši/vrlo novi dokumenti
(npr. *Antiqua et Nova*) znaju promašiti. Zato **uvijek zadrži `document`+`ref` tekst**,
a URL priloži samo kad `search` vrati high-confidence title match.

---

## Troslojni hibrid

1. **SLOJ 1 — Holistički pass (1× `chat`):** ulaz = `outline.json` (teme + podteme,
   NE puni sadržaj) → `overall_score`, sveobuhvatna procjena, "Sjeme Logosa",
   cross-cutting concerns, teološki kontekst. Jeftino (outline-level), jedan poziv.
2. **SLOJ 2 — Granularni batch scoring (⌈sekcija/N⌉× `chat`, N=4):** sekcije u
   grupama → per-sekciju `{score, assessment, concerns, enrichment, citati}`.
   **Ovo hvata ono što holistički pass promaši** (npr. SaintChat/Rasprava-svetaca
   dobiju niže ocjene 85/80 zbog rizika antropomorfizacije i anakronih zaključaka).
3. **SLOJ 3 — Citat → URL (`search`, jeftino, best-effort):** jedinstveni citirani
   dokumenti → `search` → `{id, url}` za clickable izvore. Nijedan postojeći pristup
   (`enrich_magisterium*.js`) ovo nema.

**Bilans za 26 sekcija:** 1 (holistički) + 7 (batch) = **8 sporih `chat`** + N brzih
`search`. Vs 26 sporih `chat` per-section. Sekvencijalno, ≤15 req/min → ~2–3 min.

---

## Postupak (korak po korak)

```bash
# KORAK 1 — priprema promptova (deterministicki)
node magisterium_mcp_prep.js \
  --article storage/output/<ch>/<basename>.article.json \
  --batch-size 4
# → /tmp/mag_hybrid/<basename>.job.json + <basename>.prompts/{holistic,batch_NN}.txt

# KORAK 2 — Claude izvodi MCP pozive (u ovom chatu), SEKVENCIJALNO:
#   • 1× mcp__..._Magisterium_AI__chat s holistic.txt
#   • za svaki batch_NN.txt: 1× chat (komprimiraj sadržaj ako time-outa; retry)
#   • spremi SIROVI odgovor (JSON blok + References) u:
#       /tmp/mag_hybrid/<basename>.results/holistic.raw.txt
#       /tmp/mag_hybrid/<basename>.results/batch_NN.raw.txt
#   • (opcionalno SLOJ 3) search za top citirane dokumente → URL-ovi

# KORAK 3 — sastavljanje finalnog JSON-a (deterministicki)
node magisterium_mcp_assemble.js \
  --job /tmp/mag_hybrid/<basename>.job.json \
  --results-dir /tmp/mag_hybrid/<basename>.results \
  --out /tmp/mag_hybrid/<basename>.article.magisterium_mcp_hybrid.json
```

**Ne piši u `storage/output/` izravno** — output ide u `/tmp` na pregled; korisnik
A/B usporedi s postojećim `.magisterium*.json` prije usvajanja (vidi memoriju
`audio_fix_scripts_output_new_files` — isti princip: nove datoteke, original netaknut).

---

## Output oblik (`.article.magisterium_mcp_hybrid.json`)

Superset postojećeg batch-formata, downstream-kompatibilan:

- `overall_score` (root) = **prosjek sekcija** — namjerno isto kao postojeći
  `.magisterium.json` da `generate_channel_index.js` agregacija ostane apples-to-apples
  (vidi memoriju `magisterium_json_root_overall_score_required`).
- `overall` = **NOVI holistički blok**: `holistic_score`, `assessment`,
  `seeds_of_logos[]`, `concerns[]`, `theological_context`, `citations[]`.
- `score_breakdown[]`, `total_concerns`, `iterations[].sections[].magisterium`
  `{score, assessment, concerns, enrichment, citations[]}`.

`generated_at` je `null` u skripti (Date.now() namjerno izbjegnut radi
reproducibilnosti) — stampaj izvana pri usvajanju.

---

## Demo: "Building Magisterium AI" (Catholic Futurist, gost Matthew H. Sanders)

`catholic_futurist/...KtMMSnQ7SP0...` — 2 iteracije, 26 sekcija. Meta-demonstracija:
CEO Longbearda (tvorca Magisteriuma) o gradnji Magisteriuma, analiziran **samim
Magisteriumom**.

- **overall_score 96** (= holistički 96), 8 poziva, 33 sekcijskih citata.
- Granularnost: SaintChat **85**, Rasprava-svetaca **80** (rizik antropomorfizacije /
  anakronih zaključaka) — holistički pass ih sam ne bi izdvojio.
- Citirani stvarni vatikanski AI-dokumenti: *Antiqua et Nova*, *Fides et Ratio*,
  *Magnifica Humanitas* (Leo XIV), USCCB *Guidelines for Evaluating Reiki*.

---

## Otvorene refinement-točke (prije uvezivanja u pipeline)

1. **Citat-markeri:** kad model citira *imenom u tekstu* umjesto `[^N]`, assemble ih
   ne poveže strojno (citat ostaje čitljiv u tekstu). Pojačati batch-prompt da traži
   `[^N]` markere, ili u assemble fallback heuristika.
2. **Reference bez `(Author)`** (npr. `Catechism..., 2293`) — `ref` se zalijepi u
   `document`. Kozmeticki; popraviti split kad nema zagrada.
3. **Uvezivanje:** dodati `count_progress.js`/`generate_channel_index.js`/`upload_to_r2.js`
   matchere za `.article.magisterium_mcp_hybrid.json`, te (ako se usvoji kao kanonsko)
   odlučiti odnos prema `--with-magisterium` koraku 8.5 u `run_pipeline.sh`.
