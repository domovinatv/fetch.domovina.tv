# Dan objave na podcast.domovina.ai vs. nightly queue (05.11.2026.)

## Pitanje

Na `podcast.domovina.ai/dani/2026-11-04/` je bila **31** epizoda, a nightly 04.11. je primio
**22** (18 Tier 2 + 4 Tier 1). Ima li ih više nego što ih je ušlo u obradu, i zašto?

## Odgovor

Većina razlike nije greška: stranica broji **dan objave** (YouTube Data API,
`automatic/watchlist/backfill.json`, lokalni datum), a nightly broji **noć u kojoj je
epizodu vidio**. Nightly 04.11. u 03:00 obrađuje ono što je izašlo 03.11., a epizode
objavljene 04.11. ulaze u nightly 05.11.

| 31 epizoda s 04.11. | Tier 2 | Tier 1 | ukupno |
|---|---|---|---|
| nightly 04.11. (izašle prije 03:00 ili premijera) | 2 | 1 | 3 |
| nightly 05.11. | 22 | 3 | 25 |
| **nisu ušle nigdje** | 1 | 2 | **3** |

Premijera (f1-puls `fUFlhmqBVMs`) ima `upload_date` 03.11., ali Data API kao vrijeme
objave daje početak premijere 04.11., pa je na stranici pod 04.11., a obrađena je već u
noći 04.11.

## Tri stvarne rupe i popravci (samo naprijed, bez backfilla)

### 1. Playliste složene od najstarijih (Tier 2 kandidati)

`watch_candidates.js` je čitao `--playlist-items 1:30`. Kod playliste složene od
najstarijih (Radio Marija BiH, Laudato, HRT „Nedjeljom u 2”) nova epizoda dolazi na
**kraj**, pa je kanal nakon baselinea mogao javiti samo nulu. Od 20.10. do 04.11. to je
7 promašaja, a među njima je i `Vjw0bTQyaJM`.

**Popravak:** za `list=` izvore čitaju se oba kraja (`1:N,-N:`). Pri prvom prolazu s
krajem (`tail_baseline_at` u `watch-state.json`) sve zatečeno na kraju upisuje se kao
baseline, bez događaja, pa stari videi ne ulaze u Tier 2 queue.

Praćene playliste u `refresh_podcasts.sh` imale su istu zamku (`--break-on-existing`
staje na prvoj, staroj stavci). Sada se playlista čita **cijela** u prvom krugu, bez
prekida, a arhiva preskače poznato. Danas nijedna praćena playlista nema
neuhvaćenu epizodu, pa promjena ništa ne povlači unatrag.

### 2. Livestreamovi praćenih kanala (Tier 1)

`refresh_podcasts.sh` je čitao samo `/videos`, a livestreamovi su samo na `/streams`.
Od 01.10. su tako promaknuli: 40-dana-za-zivot (Straža sv. Josipa, „Molitva za
Domovinu”), budi-frajer (klanjanja), muzevni-budite (krunica) i eho-projekt.

**Odluka korisnika:** obrađuju se **svi** livestreamovi praćenih kanala, bez filtra
naslova.

**Popravak:** svaki `/videos` kanal se skenira i na `/streams` (ista arhiva, ista
lista). Postojećih 717 streamova je jednokratno upisano u arhive
(`automatic/tools/seed_streams_archive.sh`; najavljeni i živi streamovi su izuzeti),
pa ulaze samo novi. **Kod onboardinga novog praćenog kanala** pokreni
`tools/seed_streams_archive.sh <ime>` ako se ne želi cijela povijest streamova.

### 3. Launched (Beamly)

Launched ne ide kroz YouTube refresh nego kroz `ingest_beamly.mjs` (KORAK 1b), koji čita
Beamly katalog iz `~/git/revenuecat/subclub`. Katalog se osvježavao **u 06:00**, nakon
nightlyja, pa je nova epizoda kasnila ~1,5 dan, a enrich (02:00) je nije stigao spojiti
s YouTube ID-em. `launched-lista.txt` nije izvor za ingest i zato zaostaje.

**Popravak:** launchd `com.revenuecat.podcast.subclub` ide u 01:30, a `…launched` u 01:35,
dakle prije enricha (02:00) i ingesta (03:00). Plistovi su u `~/Library/LaunchAgents`
(nisu u repou). Epizoda 103 (`TmrpIoKXN2c`) je već u katalogu i ući će u idući nightly s
pravim YouTube ID-em.

## Kako provjeriti idućih dana

Za praćene kanale usporedi `backfill.json` (originali zadnjih N dana) s
`automatic/podcasts/<slug>-lista.txt` + `-arhiva.txt`. Za kandidate ga usporedi s
`watch-state.json` `seen` i `events.jsonl`. Nakon 05.11. te razlike trebaju biti prazne,
osim epizoda objavljenih nakon zadnjeg nightlyja.
