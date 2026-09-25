# Registry discovery — mjesečni prolaz

Registry (`data/podcasts_registry.json`) raste organski: novi hrvatski podcasti na
YouTubeu nastaju svaki tjedan, pa se jednom mjesečno pokreće prolaz koji ih nađe,
provjeri i klasificira. Prolaz je **višekratan**: svaka presuda se sprema u git,
pa idući mjesec obrađuje samo ono što još nije presuđeno.

Dva alata, dvije brzine:

| Alat | Ritam | Što radi |
|---|---|---|
| `automatic/watch_candidates.js` + `discover.js exact-dates` + `activity` | svaku noć (nightly korak 5b, egress kao fetch) | za nepraćene kandidate povuče popis videa, odvoji originale od derivata, zapiše nove epizode |
| `data/discovery/discover.js` | jednom mjesečno, ručno | nađe nove kanale/playliste, klasificira ih i upiše u registry; iz watch podataka osvježi status postojećih |

Nijedan ne skida medije ni ne pokreće obradu. Promocija kandidata u pravi pipeline
ostaje ručna (vidi [channel onboarding](../automatic/refresh_podcasts.sh) i
tri sloja registryja: katalog → `tracking.enabled` → `refresh_podcasts.sh`).

## Mjesečni prolaz

```bash
# 1. (opcionalno) vanjski izvori — web research, Podscan, ručne liste
node data/discovery/discover.js seed --file <candidates.json> --source web-research
node data/discovery/discover.js ledger-import --file <rejected.json> --by web-research

# 2. sweep → podcasts-tab → aggregate → probe → triage → LLM klasifikacija
node data/discovery/discover.js all
# (podcasts-tab s --include-registry pregleda i /podcasts tab svih kanala iz registryja)

# 3. pregledaj data/discovery/runs/<datum>/classification.json, pa
node data/discovery/discover.js apply --dry-run
node data/discovery/discover.js apply

# 4. točan datum zadnjeg originala (flat liste daju samo „prije N godina") → status
node data/discovery/discover.js exact-dates
# 5. aktivnost postojećih kandidata iz nightly watch podataka
node data/discovery/discover.js activity --update-status

# 6. commit + deploy javnog registryja (dashboard/public, vidi niže): registry + ledger + query_stats + runs/<datum>/ + watchlist/rules.json
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

## Score v2 — aktivnost ispred veličine (2026-09-25)

`data/score_podcasts.js`: svježina (dana od zadnjeg originala) 30 + ritam (originala u
90 d) 25 + format 15 + supstanca 10 + katalog 10 + doseg 10. v1 je davao 35 bodova
veličini a 5 svježini, pa je napušten kanal sa 112k pratitelja nadjačavao živ mali
podcast. Oznake: 🌱 `rising` (<5k pratitelja, ≥4 originala/90 d, zadnji ≤30 d) i 💤
`dormant` (>365 d, score ≤39). Ulaz za score je `activity` (`discover.js activity`):
nepraćeni iz watch-statea + `exact-dates`, praćeni iz imena datoteka u
`storage/output/<kanal>/` i pratitelja iz `automatic/podcasts/<slug>-channel.json`.
Javni landing prikazuje „Zadnja ep.", „Ep. 90 d", „Pratitelji" i filtre Aktivni/U usponu.

Osvježavanje (npr. s iPhoneom na USB-u, `--via-iphone` zaobilazi anti-bot):

```bash
node automatic/watch_candidates.js --via-iphone
node data/discovery/discover.js exact-dates --via-iphone
node data/discovery/discover.js activity
node dashboard/server.js --snapshot dashboard/public/registry.json   # + wrangler deploy
```

## Izvori kandidata

| Izvor | Korak | Prinos 2026-09-24 (prihvaćeno od 216) |
|---|---|---|
| YouTube search po `queries.txt` | `sweep` | 127 (sam ili uz agente) |
| YouTube tab `/podcasts` kanala iz `media_channels.txt` (+ registry) | `podcasts-tab` | 50 |
| web research agent (liste, chartovi, medijske kuće) | `seed` | 69 (većinom i kroz podcasts-tab) |

Tab `/podcasts` je najjači izvor za PLAYLISTE unutar većih kanala (medijske kuće,
institucije): YouTube ga sam puni podcast playlistama. Handle URL zna javiti „nema
podcasts taba", pa alat ide preko `/channel/<UC…>/podcasts`. Novi medij → redak u
`media_channels.txt`.

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

## Zamke (naučeno u prolazima)

- **Broj pratitelja ≠ doseg podcasta, ≠ aktivnost.** „Big Podcast" (112k) je mini-serijal
  od 20 epizoda na vlog kanalu influencerice kojoj je glavna platforma Instagram; kanal
  je napušten 14.12.2022. Status se određuje ISKLJUČIVO po točnom datumu zadnjeg originala
  (`exact-dates`), a u sažetke nalaza idu samo aktivni.
- **Približni datumi lažu za stare kanale**: „prije 3 godine" → danas − 3 god. (Big Podcast
  je ispao 2023-09 umjesto 2022-12). `exact-dates` radi jedan ne-flat poziv po unosu.
- **Anti-bot na ne-flat pozivima**: nakon ~400 poziva YouTube traži prijavu. `exact-dates`
  staje nakon 5 takvih odgovora, koristi približni datum samo kad je NOVIJI od zapisanog i
  označi `last_episode_date_approx: true` — idući run ih ponovno pokuša.
- **`seed --force`** zaobilazi ledger i filtar podskupa — za ručno odabrane playliste
  (npr. Z1 Press klub, Laudato Nota bene, VIDA Zavidavanje unutar kanala koji su u
  registryju kao cjelina).
- **Idempotentnost**: `triage` i `apply` se smiju ponoviti nad istim runom — triage ne
  izbacuje ono što je u međuvremenu ušlo u registry (`in_registry`), ledger čuva `slug`/`merged_into`.

- **`/streams`**: podcasti koji izlaze kao livestream/premijera ne vide se na `/videos`
  (Podcast 8_24: 3 duga na /videos, 58 uživo). `probe` zato uvijek čita i `/streams`,
  a watch pravilo ima `extra_source_urls`.
- **`-J` vs `-j`**: yt-dlp `--flat-playlist -J` daje `timestamp`, a ne `upload_date`
  (s `-j` je obrnuto). Bez pretvorbe su svi datumi prazni.
- **Podskup kanala**: playliste kanala koji je u registryju kao cijeli kanal (sezone,
  highlightsi, Q&A) `aggregate` preskače — osim kad je kanal presuđen kao ne-podcast
  (TV/medij), jer je tada baš playlista pravi podcast.
- **Blizanci**: isti podcast pod drugim ID-em (unos bez `channel_id`, mrtav handle,
  kanal vs playlista, sezone iste emisije). `apply` ga ne dodaje nego zapiše u
  `youtube_alternatives` postojećeg unosa; ako je postojeći `dead-url`/`not-podcast`,
  zamijeni mu URL. Match: isti slug ili normalizirano ime s ≤1 slovom razlike.
- **Približni datumi**: flat liste daju „prije N mjeseci" → skokovi mjesec/godina.
  Za granice 60/180 dana to je dovoljno; točan datum otkrića bilježi watch.
- **Jezik**: srpski (latinica) i bosanski masovno ulaze u rezultate. Ćirilicu odbacuje
  kod, ostalo LLM. EN kanali ulaze preko upita s hrvatskim riječima koje su i engleske.

## Prolaz 2026-09-24 (prvi s alatom)

- Registry 291 → **491** (+200 novih, 16 spojeno s postojećim unosima kao alternativni izvor).
- Revizija 227 postojećih nepraćenih (`revise-apply`): živih 114, a registry je tvrdio 181;
  44 nisu podcast, 9 URL-ova prebačeno na pravu playlistu/kanal, 224 watch pravila.
- Ledger: 1760 presuda (341 podcast_hr, 821 not_podcast, 292 not_hr, 187 institutional,
  35 too_small, 84 uncertain) → idući prolaz ih preskače.
- Funnel: 130 upita + 240 /podcasts tabova + 194 seeda agenata → 1776 jedinstvenih →
  922 probe → 603 LLM-u (16 batcheva, sonnet) → 216 podcast_hr.
- Watch nakon prolaza: 375 kanala, 🟢 133 aktivno, 🟡 65, 🔴 174.

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
