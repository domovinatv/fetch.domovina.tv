# Registry discovery — mjesečni prolaz

Registry (`data/podcasts_registry.json`) raste organski: novi hrvatski podcasti na
YouTubeu nastaju svaki tjedan, pa se jednom mjesečno pokreće prolaz koji ih nađe,
provjeri i klasificira. Prolaz je **višekratan**: svaka presuda se sprema u git,
pa idući mjesec obrađuje samo ono što još nije presuđeno.

Dva alata, dvije brzine:

| Alat | Ritam | Što radi |
|---|---|---|
| `automatic/watch_candidates.js` | svaku noć (nightly korak 5b) | za nepraćene kandidate povuče popis videa, odvoji originale od derivata, zapiše nove epizode |
| `data/discovery/discover.js` | jednom mjesečno, ručno | nađe nove kanale/playliste, klasificira ih i upiše u registry; iz watch podataka osvježi status postojećih |

Nijedan ne skida medije ni ne pokreće obradu. Promocija kandidata u pravi pipeline
ostaje ručna (vidi [channel onboarding](../automatic/refresh_podcasts.sh) i
tri sloja registryja: katalog → `tracking.enabled` → `refresh_podcasts.sh`).

## Mjesečni prolaz

```bash
# 1. (opcionalno) vanjski izvori — web research, Podscan, ručne liste
node data/discovery/discover.js seed --file <candidates.json> --source web-research

# 2. sweep → aggregate → probe → triage → LLM klasifikacija
node data/discovery/discover.js all

# 3. pregledaj data/discovery/runs/<datum>/classification.json, pa
node data/discovery/discover.js apply --dry-run
node data/discovery/discover.js apply

# 4. aktivnost postojećih kandidata iz nightly watch podataka
node data/discovery/discover.js activity --update-status

# 5. commit: registry + ledger + query_stats + runs/<datum>/ + watchlist/rules.json
```

Svaki korak je idempotentan i kešira po datoteci u `runs/<datum>/` — prekinuti prolaz
nastavlja se istom naredbom (`--run <datum>` za prolaz od drugog dana).

## Što je deterministično, a što LLM

| Korak | Tko odlučuje | Trag u gitu |
|---|---|---|
| sweep, aggregate, probe | yt-dlp + kod | `runs/<datum>/sweep/`, `probe/`, `targets.json` |
| triage „je li format podcast" | kod: ≥8 originala ≥30 min i prosjek ≥30 min → `candidate`; 4+ → `maybe`; inače `not_podcast` | `runs/<datum>/triage.json` |
| original vs derivat | kod: `automatic/watch_candidates.js` `classify()` (shorts ≤3 min, adaptivni prag trajanja, naslovi) | isti `classify()` u nightlyju i ovdje |
| hrvatski? podcast ili emisija/propovijed? tagovi, pravilo za derivate | **LLM** (`claude -p --model sonnet`, pretplata, bez toolova) | `runs/<datum>/classify/batch_NN.input.json` + `.raw.txt` + `classification.json` |
| upis u registry i ledger | kod | `podcasts_registry.json`, `ledger.json`, `query_stats.json` |

LLM dobiva samo `candidate` i `maybe` redove — ono što je po trajanjima očito
ne-podcast odbacuje kod, bez LLM poziva. `--classifier manual` umjesto CLI poziva
napiše prompt i čeka da `classify/batch_NN.raw.txt` popuni netko drugi (npr. Claude
Code sesija ili subagent), pa je i taj put reproducibilan iz datoteka.

## Ledger — zašto je svaki prolaz pametniji

`data/discovery/ledger.json` drži presudu za svaki pregledani kanal/playlistu
(ključ = `channel_id` ili `playlist_id`):

| Presuda | Ponovna provjera |
|---|---|
| `podcast_hr` | nikad (u registryju je) |
| `not_hr` | nikad |
| `institutional` | 365 dana (medij/institucija — možda otvori podcast playlistu) |
| `not_podcast` | 180 dana |
| `too_small` | 120 dana (možda tek kreće) |
| `uncertain` | 60 dana |

Bootstrap iz ciklusa 2026-07-27: 125 `podcast_hr`, 90 `not_podcast`, 70 `uncertain`
(ručno odbačeni, ali razlog nije bio zapisan — zato ih prvi idući prolaz ponovno presudi).

`query_stats.json` bilježi koliko je koji upit donio kanala i prihvaćenih podcasta
kroz prolaze. Upit koji dvaput zaredom ne donese ništa novo je kandidat za zamjenu
u `queries.txt`; upiti tipa „epizoda 1" / „#1 podcast" hvataju podcaste na startu.

## Watch-only praćenje (nightly)

`automatic/watch_candidates.js` — detalji u zaglavlju skripte. Izlaz u
`automatic/watchlist/`:

- `REPORT.md` — 🟢 aktivno / 🟡 usporava / 🔴 uspavano / ⛔ bez originala / ⚠️ greška
- `events.jsonl` — jedna linija po novoj epizodi, s točnim datumom otkrića
- `lists/<slug>-lista.txt` — samo originali, format `automatic/podcasts/` → promocija
  kanala = premjesti datoteku + redak u `refresh_podcasts.sh`
- `rules.json` — pravila za izolaciju originala po kanalu (izlaz LLM klasifikacije ili
  ručno); registry polje `watch` ima prednost
- `watch-state.json` — viđeni ID-jevi (gitignored, strojno lokalno)

⚠️ Piše namjerno izvan `automatic/podcasts/`: `fetch.js` čita sve `*-lista.txt` u tom
direktoriju i skinuo bi sve otkriveno.

Datumi uploada iz flat liste su približni („prije 3 tjedna"); datum otkrića u
`events.jsonl` je točan, pa kadenca postaje precizna nakon par tjedana praćenja.
