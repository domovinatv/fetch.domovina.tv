# Registry discovery sweep — 2026-07-27

**Rezultat:** `data/podcasts_registry.json` 146 → **273** unosa u jednoj sesiji.
126 iz determinističkog `yt-dlp ytsearch` sweepa + 1 iz GitHub issuea #10.
Svi novi su `tracking.enabled: false` (backlog) — pipeline nije dirnut.

Ovaj dokument drži **mjerenja i pune popise**. Metodologija u sažetom obliku je u
Claude memoriji (`yt-dlp-search-sweep-discovery`); ovdje su brojke koje se ne pamte napamet.

---

## 1. Okidač i dijagnoza

User je pitao je li `https://www.youtube.com/@oasisintempore` u registryju. Nije bio — iako:

| Metrika | Vrijednost |
|---|---|
| Epizode | 45 |
| Sve ≥15 min | da (45/45) |
| Prosječno trajanje | 58 min |
| Pretplatnici | 6 470 |
| Aktivan | 2022-02 → 2026-07 |

Zadovoljavao je **sve** kriterije iz `philosophy.tracking_decision_criteria`.

**Uzrok promašaja** — distribucija izvora postojećih 146 unosa:

| Izvor | Udio |
|---|---|
| `report` | 49 % |
| `claude-opus` | 37 % |
| `current` | 31 % |
| `gemini` | 22 % |
| `yt-dlp-2026-05` | 18 % |
| `perplexity` | 12 % |

Sve osim `yt-dlp-2026-05` (koji je bio *enrichment* postojećih, ne discovery) je
**LLM-recall**. LLM zna ono što je netko o podcastima **napisao** — članke, "top 10" liste,
Netokracijin vodič. Kanal od 1–20 k pretplatnika o kojem nitko nije pisao je tom vektoru
nevidljiv, a YouTube searchu savršeno vidljiv.

**Verifikacija hipoteze u jednom pozivu:**

```
ytsearch40:"podcast razgovor svjedočanstvo vjera"
→ 19 kanala s epizodama ≥30 min
→ 8 NIJE bilo u registryju
→ Oasis in tempore je bio 13. rezultat
```

To je strukturalna rupa, ne slučajni promašaj.

---

## 2. Metoda

Artefakti i skripte: `data/_raw_research/yt_dlp_search_sweep_2026-07-27/`

```
queries.txt (40 upita)
   ↓  sweep.sh — xargs -P 6, yt-dlp --flat-playlist "ytsearch40:$q"
1518 rezultata
   ↓  aggregate.js — filter trajanja ≥1800 s, group by channel_id, dedupe vs registry
330 kanala → 45 poznatih → 285 novih
   ↓  probe.sh — po kanalu zadnjih 60 videa + channel_follower_count
285 profila
   ↓  triage.js — ≥8 ep ≥30 min I ≥35 % kataloga dugo I avg ≥35 min
156 "jakih" + 75 "možda"
   ↓  RUČNA jezična/scope klasifikacija  ← jedini korak s prosudbom
125 hrvatskih podcasta
   ↓  apply.js — tracking.enabled: false, candidate_phase: 1
registry 146 → 272
```

**Trošak:** ~0 € (samo yt-dlp), ~15 min wall clock uključujući sve probe-ove.

Za usporedbu: Faza 1 (2026-05-22) — 5 paralelnih agenata, firecrawl krediti izgorjeli
kod 3 od 5, 128 kandidata koji su **ostali neprimijenjeni** jer je hit rate bio ~65 %.

---

## 3. Rezultati po primarnom tagu

| Tag | Dodano | Tag | Dodano |
|---|---|---|---|
| religious-catholic | 15 | women | 3 |
| health | 9 | film | 3 |
| culture | 9 | political | 3 |
| sport | 8 | domovinski-rat | 3 |
| business | 8 | finance | 2 |
| gaming | 6 | mystery | 2 |
| comedy | 5 | education | 2 |
| music | 5 | philosophy | 2 |
| regional | 5 | diaspora | 2 |
| personal-development | 5 | lifestyle | 2 |
| religious-other | 4 | agriculture | 2 |
| talk-show | 4 | technology | 1 |
| fitness | 4 | history | 1 |
| science | 4 | media | 1 |
| geopolitics | 4 | parenting | 1 |

**Pokrivene rupe iz `research_gaps`:** comedy (bilo 1 unos → +5), znanost/edukativno,
regionalno (Istra, Dalmacija, Slavonija), true crime, dijaspora, sport nezavisni,
gaming (bilo 1 → +6).

**Veličina otkrivenih kanala** — median **2 380** pretplatnika, max 143 000, min 16.
Median potvrđuje dijagnozu: sweep vadi upravo srednji/mali sloj koji recall ne vidi.

---

## 4. Što je odbačeno i zašto

Od 285 novih kanala, 160 nije ušlo:

| Razlog | Primjeri |
|---|---|
| **Srpski** | Miloš Živković – Profa Podcast, Nikola Radin, Fajter, dijalog, Jao Mile, Biznis Priče, Prava Priča, Happy TV, Senzal Capital, Agelast, Socijalna Fobija, Institut za moderno obrazovanje, AgroManager |
| **Bosanski (nehrvatski)** | Plenum_ba, 3SOMA, Erudit, Naratorium |
| **Strani** | Lex Fridman, Lila Rose, Grant Sanderson, The Origins Podcast, Dr Tevin Naidu, Max Planck PhDnet, Foresight Institute, Disciples of Hope (tamilski), Comedy Club News (bugarski) |
| **TV/radio postaje, ne podcast** | HRT vijesti, N1, RTL, 24sata, Večernji TV, TV Jadran, Osječka TV, posavinatv, Plava vinkovačka, Novi radio Zadar, Televizija Slavonije i Baranje, Dalmacija Danas |
| **Institucionalna predavanja/webinari** | HAZU kanal, Festival znanosti, INSTITUTzaFIZIKU, Studentska sekcija za neuroznanost, KONT Masterclass, Hrvatski Telekom, dm Hrvatska, Savez društava MS |
| **Vlog / gameplay / marketing** | SandraVuceticTV, Ygslvian, Kuky Review, GymBeam HR |
| **Arhiva lokalnih emisija** | Veterani 145. brigade Dubrava, Dražen Jurmanović, Mladen Cetinja |
| **Stranački kanal** | Hrvatska demokratska zajednica |

**Ključni nalaz o filtriranju:** jezična bliskost znači da srpski/bosanski kanali
**masovno** ulaze u rezultate hrvatskih upita. Nijedna heuristika (ekavica markeri,
ćirilica) nije bila dovoljno pouzdana — trebalo je čitati imena i naslove epizoda.
Ovo je jedini korak sweepa koji se ne da automatizirati.

Granični slučajevi koji **jesu** ušli: Radio Marija u BiH, AGAPE RTV, Bljesak.info —
hrvatski jezik i hrvatska publika u BiH, konzistentno s postojećim `@HercegovinaInfo2`.

---

## 5. Puni popis dodanih (125)

Sortirano po broju pretplatnika. `ep≥30m` = uzorak zadnjih do 60 videa.

| slug | naziv | tagovi | subs | ep≥30m | avg min | zadnja |
|---|---|---|---|---|---|---|
| atma-podcast | Atma | mystery, philosophy | 143.000 | 12/60 | 77 | 2026-07 |
| podcast-o-zdravlju | Podcast o zdravlju | health, personal-development | 102.000 | 34/48 | 50 | 2026-07 |
| vida-podcast | VIDA | culture, debate | 72.800 | 5/60 | 46 | 2026-07 |
| duhovna-obnova | Duhovna Obnova | religious-catholic | 63.300 | 9/60 | 47 | 2026-07 |
| agape-rtv | AGAPE RTV | religious-catholic, evangelization | 63.200 | 40/60 | 72 | 2026-07 |
| na-rubu-znanosti | Na Rubu Znanosti | mystery, science | 37.500 | 60/60 | 51 | 2025-07 |
| mame-kod-lane | Mame kod Lane | parenting, women, lifestyle | 33.300 | 59/60 | 73 | 2026-07 |
| seksoteka | Seksoteka | health, lifestyle, education | 28.700 | 7/60 | 64 | 2026-07 |
| radio-marija-bih | Radio Marija u BiH | religious-catholic, diaspora | 22.900 | 21/59 | 46 | 2026-07 |
| ril-tok-podcast | Ril Tok Podcast | talk-show, sport | 18.200 | 9/60 | 166 | 2026-07 |
| hopecast | HopeCast | religious-catholic, testimonies | 15.700 | 54/54 | 93 | 2026-07 |
| agroklub-podcast | Agroklub Podcast | agriculture, business | 15.600 | 5/60 | 65 | 2026-07 |
| zupa-sv-ilije-metkovic | Župa sv. Ilije proroka Metković | religious-catholic, institutional | 14.900 | 26/60 | 43 | 2026-07 |
| maria-vision-medjugorje | Maria Vision Medjugorje | religious-catholic, evangelization | 14.700 | 24/60 | 65 | 2026-07 |
| podcast-hrvatska-uzivo | PODCAST HRVATSKA UŽIVO | political, media | 14.700 | 20/60 | 76 | 2026-07 |
| actualitica-podcast | Actualitica Podcast | geopolitics, political, regional | 13.400 | 36/60 | 74 | 2026-07 |
| kyrios-books | Kyrios Books | religious-catholic, theology | 12.200 | 28/60 | 70 | 2026-07 |
| podcast-sekstant | Podcast Sekstant | philosophy, mystery, regional | 12.200 | 10/60 | 110 | 2026-07 |
| ogistra | OGISTRA | fitness, personal-development | 11.200 | 19/60 | 48 | 2026-06 |
| urlaona | Urlaona | comedy, pop-culture | 10.600 | 39/51 | 53 | 2026-07 |
| knjiga-govori | Knjiga Govori | personal-development, culture | 10.600 | 18/49 | 33 | 2026-07 |
| sportske-novosti-mundocast | Sportske novosti (Mundocast) | sport, football, media | 10.500 | 24/60 | 45 | 2026-07 |
| covik-s-mora | Čovik S Mora | talk-show, regional, sport | 10.400 | 17/60 | 67 | 2022-12 |
| tipsy-podcast | Tipsy Podcast | lifestyle, tourism, business | 9.950 | 37/60 | 83 | 2026-07 |
| denis-podcast | Denis Podcast | sport, football | 9.390 | 42/60 | 49 | 2026-07 |
| psihologija-hrt | PSIHOLOGiJA (HRT) | science, health, institutional | 8.970 | 7/9 | 62 | 2026-03 |
| srednja-hr-podcast | srednja.hr Podcast | education, media | 8.730 | 24/60 | 66 | 2026-07 |
| vecernji-podcast | Večernji podcast | media, talk-show | 8.600 | 18/60 | 69 | 2024-02 |
| fire-podcast-tetka-skrti | FIRE Podcast (Tetka & Škrti Otočanin) | finance, personal-development | 8.580 | 24/60 | 40 | 2026-07 |
| salesiana-hr | Salesiana HR | religious-catholic, evangelization | 8.360 | 15/60 | 70 | 2026-07 |
| ofenziva-sportski-podcast | Ofenziva - Sportski podcast | sport, football, regional | 7.880 | 58/60 | 76 | 2026-07 |
| lider-podcast | Lider | business, media | 7.730 | 31/60 | 36 | 2026-07 |
| becar-price | Bećar priče | regional, diaspora, culture | 6.210 | 11/60 | 35 | 2026-07 |
| zasto-cista-istina | Zašto Čista Istina | religious-other, philosophy | 6.150 | 59/60 | 59 | 2026-07 |
| podkast-kviz-duel | PodKaST | comedy, regional | 6.020 | 9/60 | 36 | 2023-06 |
| bez-pardona | Bez pardona | women, health, talk-show | 6.010 | 15/15 | 78 | 2026-07 |
| glazbena-kuca | Glazbena Kuća Podcast | music, culture | 5.880 | 46/60 | 80 | 2026-07 |
| la-vie-podcast | La Vie Podcast | lifestyle, culture | 5.870 | 16/16 | 60 | 2026-06 |
| treci-element | Treći element | science, education | 5.740 | 44/60 | 33 | 2023-06 |
| kliker-podcast | Kliker Podcast | comedy, talk-show | 5.660 | 16/44 | 68 | 2026-07 |
| poduzetnicki-mindset | Poduzetnički Mindset | business, entrepreneurship | 5.590 | 9/60 | 57 | 2026-04 |
| bossy-podcast | Bossy. | women, science, personal-development | 5.560 | 11/12 | 88 | 2024-11 |
| alt-tab-good-game-show | Alt+Tab (Good Game Show) | gaming, pop-culture | 5.310 | 41/60 | 60 | 2024-06 |
| don-stipe-mustapic | don Stipe Mustapić | religious-catholic, testimonies | 5.100 | 45/60 | 77 | 2026-07 |
| drustvo-promocija-znanosti | Društvo za promociju znanosti i kritičkog mišljenja | science, education | 5.070 | 60/60 | 51 | 2026-06 |
| heroji-vukovara | Heroji Vukovara | domovinski-rat, history | 4.760 | 10/29 | 52 | 2021-09 |
| felix-contras | Felix Contras | geopolitics, political | 4.150 | 10/38 | 43 | 2026-07 |
| ask-frapriest | Ask FraPriest | religious-catholic, franciscan | 4.140 | 18/40 | 65 | 2024-02 |
| gram-kulture | Podcast Gram kulture | culture | 4.020 | 29/60 | 34 | 2025-11 |
| infinity-podcast-milojevic | INFINITY Podcast (Poliklinika Milojević) | health, fitness | 3.860 | 30/60 | 40 | 2026-07 |
| stjepan-belosa | Stjepan Beloša | personal-development, entrepreneurship | 3.770 | 6/52 | 45 | 2025-11 |
| sime-show | Šime Show | comedy, talk-show | 3.680 | 48/60 | 76 | 2025-10 |
| marijana-perinic-zenska-prica | Ženska priča (Marijana Perinić) | women, talk-show | 3.360 | 47/60 | 64 | 2026-06 |
| zaja-mind | Zaja Mind | personal-development, fitness | 3.280 | 33/55 | 68 | 2026-07 |
| skac-palma | SKAC Palma | religious-catholic, evangelization | 3.270 | 49/60 | 47 | 2026-05 |
| mirta-fraisman-cobanov | Mirta Fraisman Čobanov | health, personal-development | 3.160 | 10/18 | 39 | 2025-09 |
| metabolic-friendly | Metabolic Friendly | health | 2.960 | 9/13 | 96 | 2026-06 |
| tonecast-music-shop-no1 | Tonecast (Music Shop No1) | music, culture | 2.950 | 20/38 | 59 | 2026-07 |
| mrtvi-piksel-popcast | Mrtvi Piksel (POPCAST) | film, pop-culture, gaming | 2.950 | 30/60 | 41 | 2022-12 |
| fima-podcast | FIMA | finance, business | 2.860 | 5/60 | 47 | 2026-07 |
| gozba-jaganjceva | Gozba Jaganjčeva | religious-catholic, testimonies | 2.830 | 17/44 | 51 | 2026-06 |
| rpasd-hrvatska | RPASD Hrvatska | religious-other, evangelization | 2.790 | 31/60 | 38 | 2026-07 |
| poslovni-dnevnik-podcast | Poslovni dnevnik | business, media | 2.380 | 50/60 | 62 | 2026-07 |
| myfitworld | MyFitWorld | fitness, health | 2.370 | 21/60 | 47 | 2025-02 |
| pik-as-podcast | Pik As Podcast | political, geopolitics | 2.350 | 13/13 | 70 | 2026-07 |
| podcast-besida | Podcast Besida | regional, talk-show | 2.260 | 49/60 | 71 | 2026-07 |
| bijelo-plavi-podcast | Bijelo-plavi podcast | sport, football, regional | 2.210 | 56/60 | 78 | 2026-06 |
| geopolitika-i-sigurnost | Geopolitika i sigurnost | geopolitics, history | 2.020 | 22/30 | 78 | 2025-05 |
| pulse-podcast-zuljevic | PULS.E Podcast (Sanja Žuljević) | health, women, fitness | 1.980 | 16/52 | 72 | 2026-01 |
| dr-podcast | dr. Podcast | health, science | 1.950 | 13/23 | 61 | 2025-03 |
| 2pogled-povijest | 2Pogled na povijest Hrvatske i svijeta | history | 1.890 | 24/60 | 43 | 2026-07 |
| casopis-obnova | Časopis Obnova | culture, religious-catholic, media | 1.840 | 33/60 | 60 | 2026-05 |
| podcast-u-pubu | Podcast u Pubu | talk-show, culture | 1.600 | 10/39 | 75 | 2023-02 |
| islam-i-krscanstvo-analiza | Islam i Kršćanstvo Analiza | religious-other, debate, theology | 1.570 | 5/60 | 73 | 2026-05 |
| podcast-bez-pauze | Podcast Bez pauze | health, science | 1.560 | 37/60 | 130 | 2026-03 |
| pp-podcast-pero-pavlovic | PP podcast (Pero Pavlović) | music, talk-show | 1.440 | 31/60 | 71 | 2026-05 |
| nominis-ecommerce-hrvatska | Nominis (Udruga eCommerce Hrvatska) | business, digital, technology | 1.290 | 39/60 | 59 | 2026-06 |
| tado-juric-migracije | Tado Jurić - Migracije i demografija | diaspora, political, science | 1.280 | 21/60 | 56 | 2026-07 |
| u-zoni-podcast | Podcast U Zoni | sport, media | 1.240 | 24/60 | 56 | 2025-12 |
| fit-through-science | Fit Through Science | fitness, science, health | 1.080 | 36/60 | 81 | 2024-04 |
| marijeta-martic | Marijeta Martić | religious-catholic, testimonies | 1.060 | 9/16 | 51 | 2026-01 |
| stronger-talks | Stronger Talks Podcast | fitness, health | 971 | 7/7 | 94 | 2026-06 |
| podcast-svjedok | Podcast Svjedok | domovinski-rat, history, testimonies | 924 | 7/9 | 69 | 2026-07 |
| prica-sa-zapadne-strane | Priča sa zapadne strane | geopolitics, political | 783 | 5/5 | 67 | 2026-07 |
| libertas-talks | Libertas Talks podcast | business, education | 781 | 54/60 | 46 | 2026-06 |
| vez-sv-antuna | VEZ sv. Antuna | religious-catholic, testimonies | 745 | 8/8 | 60 | 2025-12 |
| overthinkeri | Overthinkeri | science, health, education | 630 | 31/39 | 42 | 2026-07 |
| stemi-education | STEMI education | technology, entrepreneurship, education | 605 | 17/60 | 56 | 2026-07 |
| zeleno-zuti-korner | Zeleno-Žuti Korner (NK Istra 1961) | sport, football, regional | 604 | 14/51 | 72 | 2026-05 |
| chelsea-croatia | Chelsea Croatia | sport, football | 551 | 42/60 | 62 | 2023-04 |
| podcast-thegame | Podcast theGame | gaming | 516 | 30/60 | 60 | 2023-09 |
| podcast-posrednik | Podcast Posrednik | business, regional | 498 | 33/33 | 80 | 2026-07 |
| bookaravision | bookaravision | culture, education | 475 | 54/60 | 69 | 2025-01 |
| kroativ-tv | KROATIV TV | regional, society | 475 | 14/60 | 44 | 2022-03 |
| poljoprivrednica-hr | poljoprivrednica.hr Podcast | agriculture, entrepreneurship | 437 | 5/12 | 47 | 2026-05 |
| digilab-nsk | DigiLab NSK Podcasti | culture, education, institutional | 411 | 44/46 | 48 | 2022-12 |
| sindikalni-megafon | Sindikalni megafon (Sindikat!) | political, society, education | 387 | 21/40 | 54 | 2026-07 |
| filozof-i-ja | Podcast Filozof i ja | philosophy, culture | 380 | 8/23 | 86 | 2023-10 |
| podcast-ucka | Podcast Učka | regional, culture | 353 | 26/60 | 37 | 2026-01 |
| glazbene-price | Podcast Glazbene priče | music, history | 329 | 30/60 | 79 | 2025-06 |
| uki-podcast | UKI podcast | religious-catholic, theology | 313 | 18/18 | 53 | 2023-04 |
| pod-haubom | POD HAUBOM | talk-show, sport, health | 292 | 19/28 | 64 | 2026-02 |
| osjecki-glas-podcast | Osječki Glas Podcast | regional, talk-show | 289 | 14/14 | 61 | 2025-07 |
| topfightingzone | Top Fighting Zone Podcast | sport, mma | 269 | 11/58 | 50 | 2026-06 |
| hrvatski-branitelj | Hrvatski branitelj | domovinski-rat, history | 230 | 15/21 | 39 | 2022-08 |
| etvos-osijek | Evanđeosko teološko veleučilište u Osijeku | religious-other, theology, institutional | 222 | 31/60 | 76 | 2026-07 |
| in-medias-res | In medias res | film, pop-culture | 218 | 8/60 | 40 | 2023-04 |
| budi-heroj-svoje-price | Budi heroj svoje priče | personal-development, health | 217 | 6/60 | 42 | 2026-07 |
| pod-mikroskopom | Podcast Pod mikroskopom | health, science | 207 | 16/20 | 45 | 2025-06 |
| morina-kutija | Morina Kutija | culture, talk-show | 202 | 54/60 | 48 | 2026-07 |
| fondovske-bajke | Fondovske bajke | business, finance | 200 | 9/10 | 51 | 2026-07 |
| osoba-s-pogledom | OSOBA S POGLEDOM Podcast | culture, talk-show | 194 | 18/20 | 40 | 2026-06 |
| games-croatia | Games Croatia | gaming, technology | 193 | 25/31 | 44 | 2026-06 |
| zabavni-radio-na-ti | Zabavni radio (NA TI Podcast) | comedy, talk-show, regional-media | 188 | 13/60 | 59 | 2026-07 |
| hrvatska-knjiznica-za-slijepe | Hrvatska knjižnica za slijepe (Eho) | culture, institutional | 146 | 58/60 | 52 | 2026-07 |
| rock-portal-podcast | Rock Portal | music, media | 129 | 13/28 | 57 | 2026-07 |
| goodgamehr | GoodGameHR Gaming Portal | gaming, media | 106 | 15/60 | 45 | 2021-12 |
| mlgp-podcast | MLGP Podcast | gaming | 79 | 11/19 | 83 | 2020-07 |
| veza-dom | VEZA DOM | diaspora, political | 72 | 34/49 | 50 | 2024-11 |
| tri-strane-obrazovanje | Tri strane - podcast o obrazovanju | education | 69 | 42/51 | 56 | 2025-06 |
| retronauti | Retronauti | film, pop-culture | 39 | 25/39 | 56 | 2021-05 |
| price-iz-skrovista | Priče iz Skrovišta | gaming, fantasy | 33 | 52/52 | 37 | 2023-10 |
| knjizara-ljevak-kul-u-gradu | Knjižara Ljevak (KUL U GRADU) | culture, institutional | 24 | 11/13 | 55 | 2026-07 |
| you-go-you-grow | You go You grow Podcast | personal-development, women | 16 | 6/6 | 55 | 2023-07 |
| karlo-cast | Karlo cast | business, personal-development | ? | 15/18 | 74 | 2026-07 |
---

## 6. Tehničke zamke (sve su nas koštale kruga)

### 6.1 `\t` u `yt-dlp --print` ostaje literal

```bash
yt-dlp --print "%(channel)s\t%(url)s"   # ispisuje dvoznakovni "\t", NE tab
```

Parsiraj s ``line.split(String.raw`\t`)``. Otkriveno tek kad je agregator vratio
`0 kanala` iz 1518 redaka. Alternativa: koristi `;;` ili neki drugi separator koji
se ne pokušava escapati.

### 6.2 `--flat-playlist` gasi `%(channel_id)s`

```bash
yt-dlp --flat-playlist --playlist-end 1 --print "%(channel_id)s" <kanal>   # → NA
yt-dlp -I 1 --print "%(channel_id)s" <kanal>                              # → UC…
```

`-I 1` (item spec) radi, `--flat-playlist` ne. Za bulk resolve handleova ovo je razlika
između "radi" i "119 puta NA".

### 6.3 Dedupe MORA ići po `channel_id`

Registry je držao `@handle`-ove, sweep vraća `UC…` ID-eve. Match po display imenu je
nepouzdan jer se imena razlikuju:

| Sweep vraća | Registry ima |
|---|---|
| `Projekt Velebit` | `Podcast Velebit (Projekt Velebit)` |
| `Ana Radišić` | `Ana Radišić Podcast` |
| `Radio Mrežnica` | `Radio Mrežnica (Podcast Mrežnica)` |
| `Željka Markić & Narod` | `Željka Markić i Narod.hr` |

Prvi prolaz je prijavio 296 "novih" od kojih je 11 već bilo u registryju.
**Sanirano trajno:** `youtube.channel_id` popunjen za 112 postojećih unosa
(127/147 sada ima ID; ostatak su stubovi bez URL-a).

### 6.4 CF Pages custom domena kasni minutama, ne sekundama

`channel-onboarding-checklist` kaže "~20 s". Stvarnost 2026-07-27: produkcijski alias
`domovina-registry.pages.dev` je bio svjež odmah, a `podcast-registry.domovina.ai`
je servirao stari sadržaj još **nekoliko minuta** nakon uspješnog purge-a.

Dijagnostika koja razlikuje cache od pogrešnog routinga:

```bash
curl -sI https://podcast-registry.domovina.ai/registry.json | grep -i cf-cache-status
# DYNAMIC  → NIJE edge cache; čekaj propagaciju ili provjeri routing
# HIT/EXPIRED → jest cache; purge pomaže
```

Purge token: `DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE` u `.env`
(zone `domovina.ai` = `2eaa51e7e6896da6e92bde2ddd879cd8`).

**Verificiraj usporedbom, ne vjerom:**

```bash
curl -s https://domovina-registry.pages.dev/registry.json | jq .funnel.total   # prod alias
curl -s https://podcast-registry.domovina.ai/registry.json | jq .funnel.total  # custom domena
```

Mid-propagacijski curl može vratiti **novi `funnel.total` uz stari `_snapshot_at`** —
različiti edge čvorovi. Ponovi poziv prije nego zaključiš da nešto ne valja.

---

## 7. GitHub issue #10 — Explora (HRT)

Otvoren 2026-07-02 od korisnika **i1E (Ivan Grce)**, stajao ~4 tjedna neobrađen.

| Metrika | Vrijednost |
|---|---|
| Epizode | 161 |
| ≥30 min | 60/60 uzorkovanih |
| Prosjek | 52 min (median 52 — praktički nema varijance) |
| Pretplatnici | 17 300 |
| Zadnja | 2026-06-16, tjedni format |
| Voditelji | Elvis Mileta, Korado Korlević |
| Score | 72/100 (✅ strong), tier 2 |

Dodan kao `explora-hrt` u backlog. **Blokada prije aktivacije:** HRT produkcija =
sadržaj javnog servisa, licenciranje nije isto kao kod nezavisnih kanala.
Zabilježeno u `tracking.reason_disabled`.

Odgovoreno korisniku u
[issue #10 komentaru](https://github.com/domovinatv/fetch.domovina.tv/issues/10#issuecomment-5092128772);
issue namjerno **ostavljen otvoren** kao tracking stavka dok kanal stvarno ne uđe u pipeline.

Ostali issue-i provjereni: #9 (enhancement, HR/EN metrika — nije zahtjev za kanal),
#4 i #5 (zatvoreni, oba kanala u registryju i `tracked` — uredno odrađeni), #2/#3 (probni).

---

## 8. Sljedeći ciklus

### 8.1 Kategorije koje ovaj sweep NIJE pokrio

sport niche (boks, šah, sailing, motoring, tenis, rukomet) · politika lijevo/centar
(trenutni registry je nagnut desno) · audio-drama · gastro/kuhanje · auto-moto ·
LGBT i manjine · IT niche (security, data, devops) · roditeljstvo (samo 1 dodan) ·
umjetnost/dizajn · religija nekatolička (pravoslavlje, islam u HR, judaizam, sekularno)

### 8.2 Neisprobani query obrasci

| Obrazac | Što hvata |
|---|---|
| `ytsearch:"<ime gosta>" podcast` | Gost kruži po više podcasta — jedan poznati gost otkriva 3-5 kanala |
| `ytsearch:"epizoda 1"` / `"#1"` + kategorija | Podcaste **na startu**, prije nego ih itko spomene |
| `ytsearch:"<ime podcasta>" gostovanje` | Cross-promo mreže |

### 8.3 Što sweep NE može

Non-YouTube platforme (Spotify/Apple/web-only), voditelje, opise, povijest emitiranja.
Za to i dalje treba agentni research — vidi Claude memoriju
`bulk-category-discovery-workflow`. **Podjela posla:** yt-dlp za širinu i verifikaciju
formata, agenti za metapodatke i platforme izvan YouTubea.

### 8.4 Backlog higijena

127 unosa je sada `candidate_phase: 1`. Prije nego se ijedan promovira u `tracking.enabled: true`,
vrijedi proći `node data/count_registry.js --list-ready` — 22 unosa je već tracked ali
**nije u `refresh_podcasts.sh`**, što je starija rupa od ove.

---

## Povezano

- `data/_raw_research/yt_dlp_search_sweep_2026-07-27/` — skripte + sirovi artefakti
- `docs/registry_vision.md` — vizija javnog kataloga
- `docs/podscan_integration.md` — **treći vektor otkrivanja (2026-08-26)**: RSS
  indeks Podscan.fm. Komplementaran ovom sweepu jer gleda audio/RSS stranu, ne
  YouTube: 1 693 feeda kojih nema u registru (121 stvarno hrvatskih i aktivnih).
  Trijažni popis: `docs/podscan_candidates_2026-08-26.md`.
- Claude memorije: `yt-dlp-search-sweep-discovery`, `registry-three-layer-model`,
  `registry-as-public-catalog-vision`, `channel-onboarding-checklist`,
  `bulk-category-discovery-workflow`
