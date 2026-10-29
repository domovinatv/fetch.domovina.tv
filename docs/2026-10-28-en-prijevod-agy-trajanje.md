# EN prijevod kroz agy: izmjereno trajanje na jednoj epizodi (28.10.2026.)

Prvo mjerenje `translate_to_english.js` na cijeloj epizodi otkad je Vertex isključen
(`docs/2026-10-28-vertex-iskljucen-agy-jedini-gemini.md`). Epizoda `QkcpHsj43rE`
(domovina_tv, „AI u praksi: Claude Code uživo“, 2 h 05 min, 3 iteracije, 42 sekcije).

## Zaključak

**EN prijevod jedne epizode kroz agy traje 3 h 41 min** (13 280 s), naspram ~7 min kroz
Vertex. Uzrok nije veličina zahtjeva nego **serijalizacija**: sve ide kroz jednu tmux
sesiju `agyen`, pa `TRANSLATE_CONCURRENCY=4` ne pomaže (pozivi čekaju jedan drugoga,
razmak između poziva ≈ 0 s). Svaki poziv je ~2 min agy „razmišljanja“ nad 4–7 KB ulaza.

## Mjerenja

| Faza | Poziva | Trajanje |
|---|---|---|
| summary | 1 | 391 s |
| article (3 zaglavlja + 42 sekcije) | ~45 | 6 686 s (1 h 51 min) |
| magisterium (zaglavlje + 3 + 42 sekcije s prosudbom) | ~46 | 6 202 s (1 h 43 min) |
| **ukupno** | ~92 | **13 280 s** |

Po pozivu (84 izmjerena, bilježnik nad `~/git/.agy-tmux/agyen/req-*.md`):

| | p10 | medijan | p90 | max |
|---|---|---|---|---|
| trajanje | 72 s | 124 s | 266 s | 363 s |
| ulaz (req .md) | 4,2 KB | 5,3 KB | 6,8 KB | — |

Ulaz < 5 KB: medijan 109 s; ≥ 5 KB: 132 s. Veličina gotovo ne utječe, fiksni trošak
po pozivu (`/clear`, čitanje datoteke, „Thought for …“, pisanje JSON-a) dominira.
U pane-u se vidi da model dugo razmišlja o sitnicama (npr. čuvanje hrvatskih navodnika).

Ostali koraci iste epizode za usporedbu:

| Korak | Trajanje |
|---|---|
| Magisterium HR (`tools/magisterium_mcp_episode.js`, 43 chat poziva) | 1 447 s chat + 42 s jezik + 32 s objava ≈ 25 min |
| RAG sync (`domovina-rag/scripts/sync-cron.sh`, s 89 epizoda zaostatka) | 21 min |
| og-sections EN (42 slike) | 10 s |
| objava EN (`publish_hr_episode.sh`) | 31 s |

## Kandidati za ubrzanje (neprovjereno)

1. **Više agy sesija paralelno** (`agyen1..4`, round-robin u `lib/agy_tmux.js`) — ako
   pretplata dopušta, ~4× brže (≈ 55 min). Prvo provjeriti limite Google AI Pro.
2. **Veći blok po pozivu** — cijela iteracija (14 sekcija) umjesto sekcije: ~10 poziva
   umjesto 92. Fiksni trošak dominira, pa bi ovo moglo biti najveći dobitak; rizik je
   dulji izlaz i provjera oblika JSON-a.
3. **Niži „thinking“** — `gemini-3.8-flash` umjesto `-high` (`AGY_MODEL`) za doslovan
   prijevod; mjeriti kvalitetu na jednoj epizodi.
4. Magisterium EN ponovno šalje i sekciju članka (`sectionSpecs(sec)`) — taj dio je već
   preveden u article fazi; preuzeti ga iz `article.en.json` skraćuje ulaz magisterium faze.

## Izmjereno 29.10.2026.: jedan poziv po dokumentu, `-low` → 5 min

Kandidati 2, 3 i 4 su provjereni na istoj epizodi i ugrađeni u `translate_to_english.js`.
Kandidat 1 (više sesija) više nije potreban.

| Dokument | Prije (`-high`, poziv po bloku) | Sada (`-low`, 1 poziv) |
|---|---|---|
| sažetak | 391 s | 21 s |
| članak (42 sekcije, 92 KB ulaza) | 6 686 s | 180 s |
| Magisterium (zaglavlje + 42 prosudbe, 54 KB) | 6 202 s | 99 s |
| **ukupno** (`translate_to_english.js`, cijeli prolaz) | **13 280 s** | **300 s** |

Iteracija 1 (13 sekcija) u jednom pozivu po razini razmišljanja: `-high` 325 s,
`-medium` 199 s. Cijeli članak s `-low` je brži od jedne iteracije s `-medium`.

Kvaliteta naspram objavljenog prijevoda (`-high`, poziv po sekciji):

- oblik JSON-a ispravan u svim prolazima (`batchShapeError`), struktura ključeva
  izlaznih datoteka identična objavljenima
- rečenica: HR izvor 856, stari EN 850, `-low` 853 — ništa nije izostavljeno
- riječi 3–5 % manje (`-low` sažetije: „hasn't“, „Calls can thus be processed“);
  `-medium`/`-high` su na iteraciji 1 unutar 1 % starog
- bez hrvatskih ostataka, Markdown i vlastita imena sačuvani

Magisterium sekcije su doslovna kopija sekcija članka (42/42 iste), a dvostruki EN
prijevod se razlikovao u svih 42. Sada se preuzimaju iz `article.en.json` (ključ: HR
`subtitle` + `content`), pa su oba taba ista.

Postavke: `TRANSLATE_AGY_MODEL` (default `gemini-3.8-flash-low`, sesija `agyen-low`),
`TRANSLATE_AGY_TIMEOUT_SEC` (default 1800). Ako cijeli dokument dvaput ne prođe
provjeru oblika, skripta se vraća na poziv po sekciji. Vertex put je nepromijenjen.

## EN za sve nove epizode (29.10.2026.)

Uz ~5 min/ep EN više nije ograničen na `+EN` kanale. `automatic/enqueue_en_new.js` se
vrti u EN traci Magisterium ticka i enqueuea EN za svaku epizodu čiji je najnoviji HR
članak datiran od 29.10. nadalje, objavljen i bez `.article.en.json`. Kanali s HR
Magisteriumom čekaju ga, da EN prevede i Magisterium u istom prolazu.

Poller (`pipeline.domovina.ai` 5f9e2a7): EN bez HR Magisteriuma je gotov kad je
`article.en.json` na CDN-u (prije je takav job uvijek bio `failed`); rok EN joba
30 min + 1 min/sekciji, max 2 h. `translate_to_english.js` (b3b8162a): ako cijeli
dokument ne prođe, ide po iteraciji, tek onda po sekciji.
