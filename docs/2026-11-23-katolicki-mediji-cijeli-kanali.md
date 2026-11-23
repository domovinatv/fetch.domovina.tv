# Katolički mediji: od playlista do cijelih kanala (23.11.2026.)

Nastavak `docs/2026-10-14-katolicki-mediji-playliste.md`. Cilj (odluka 23.11.): sve
razgovorno što svaki dan izađe na Laudato TV, HKR, Radio Mariji HR, Radio Mariji BiH i
Radio MIR Međugorje mora biti na popisu podcast.domovina.ai i ići u Tier 2 obradu.
Samo nove epizode, bez backfilla (pravilo #4).

## Stanje prije promjene

- 50 playlista-djece u registryju od 14.10. Sve su u watchu, a od 02.11. idu i u Tier 2.
  Svaki original koji je watch otkrio od 01.11. dobio je job (31 job do 23.11.).
- **HKR nema svoj YouTube kanal.** Emisije izlaze na kanalu HKM-a (`hkm`, `UCrfV3uhCoHNBaqiva1wCB4Q`).
  Argumenti, Živjeti Evanđelje i U zdravlju i bolesti pokrivaju sve razgovorno, pa tu nije trebalo ništa mijenjati.

## Mjerenje (YouTube Data API, uploads playlista kanala, 26.10.–22.11. = 4 tjedna)

| Kanal | Objava | Liturgija/molitva | Razgovor ≥15 min | Već pokriveno | Fali / tj. |
|---|---|---|---|---|---|
| Laudato TV | 294 | 95 | 46 | 13 | 8,3 |
| Radio Marija BiH | 59 | 16 | 36 | 6 | 7,5 |
| Radio MIR Međugorje | 91 | 39 | 14 | 5 | 2,2 |
| Radio Marija HR | 28 | 3 | 5 | 0 | 1,25 |
| HKM / HKR | 40 | 0 | 11 | 9 | ~0 |
| **Ukupno** | 512 | 153 | 112 | 33 (~8/tj) | **~20/tj (2,8/dan, ~13 h)** |

**Zašto playliste nisu dovoljne.** Radio Marija HR i BiH emitiraju emisije kao prijenose uživo
s naslovom teme: kod RM BiH to je 105 od 120 objava u 8 tjedana. U playlistu takav prijenos
dođe kasno ili nikad, pa 12 playlista RM HR u 4 tjedna nije uhvatilo nijednu epizodu. Laudato
i MIR imaju emisije bez playliste (Izdvojeno, Nova Misija, Kako dalje?, Svi za stol, Svijet očima
Vatikana, Put srca, Nada koja liječi, homilije…).

## Promjena: 4 unosa koji prate cijeli kanal

`laudato-tv-emisije`, `radio-marija-hr-emisije`, `radio-marija-bih-emisije` i
`radio-mir-medjugorje-emisije` su obični unosi tipa `channel` s `parent_slug` krovnog unosa i
`tracking.enabled: false`. Svaki ima `watch.min_duration_sec: 901` i vlastiti
`watch.exclude_title_regex` (mise, krunice, klanjanja, novene, cenakuli, Egzamen, papinska
putovanja, MIR-ov dnevni molitveni prijenos, glazba, audio-knjige). Watch od 23.11. sam čita i
karticu `/streams`. Baseline je napravljen 23.11. ručno (`watch_candidates.js --slug`), pa su
nove epizode one objavljene od 23.11. nadalje.

Suho pokretanje filtara na ista 4 tjedna:

| Unos | Originala / tj. | Sati / tj. |
|---|---|---|
| laudato-tv-emisije | 17 | 12,9 |
| radio-marija-bih-emisije | 9 | 5,5 |
| radio-mir-medjugorje-emisije | 6,2 | 2,6 |
| radio-marija-hr-emisije | 2 | 1,5 |
| **Ukupno** | **~34/tj (~4,9/dan)** | **~22,5** |

Od toga je oko 8 tjedno već dolazilo preko playlista, pa je stvarni dodatak **~26 epizoda
tjedno (~3,7 dnevno)**. Tier 2 trenutno radi ~22 epizode dnevno, a dnevni limit je 50.

Playliste-djeca ostaju. Ista epizoda zato stoji pod dva sluga, ali feed kataloga
(`build-catalog.mjs`, `seenIds`) i Tier 2 (`enqueue_all_new.js`, `seen` + `state.episodes[id]`)
dedupliciraju po YouTube ID-u.

## Zamke i otvoreno

- Laudato ponekad objavi isti sadržaj dvaput: kao prijenos uživo („[UŽIVO] Radost ljubavi u
  braku”) i kasnije kao montiranu verziju, odnosno pod dva naslova („[NOVI ŽIVOT] …” i „… │Novi
  Život”). To su različiti ID-jevi, pa se obrade obje verzije. Vrijedi pratiti prvih tjedan dana.
- MIR je većinom 15–25 min (homilije, Put srca, Nada koja liječi). To je svjesno uključeno.
- RM BiH „Cenakul” (nagovor + molitva + posveta) je isključen kao molitva.
- Izvan YouTubea:
  - Radio Marija HR ima mp3 arhivu po danima (`radiomarija.hr/program/arhiva/YYYY-MM-DD`,
    ~30 mp3 tjedno, bez RSS-a, traži browserski User-Agent). Treba scraper, ništa nije napravljeno.
  - Radio MIR ima RSS `radio-medjugorje.com/feed/`, ali s kratkim prilozima.
  - HKR, Laudato i RM BiH nemaju ništa što bi se dalo automatski preuzimati.
