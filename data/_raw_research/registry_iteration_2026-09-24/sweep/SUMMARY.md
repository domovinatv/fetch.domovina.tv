# yt-dlp search sweep — ciklus 2 (2026-09-24)

Drugi deterministički `ytsearch40:` sweep (prvi: `../../yt_dlp_search_sweep_2026-07-27/`).
Registry **nije diran** — ovo je popis kandidata za ručnu editorial odluku.

## Funnel

| Korak | Broj |
|---|---|
| Upita (`queries.txt`, 70 + 20 kraćih dopuna) | **90** |
| Redaka rezultata | 3 033 |
| … od toga video ≥30 min | 1 793 |
| Kanala s barem jednim ≥30 min pogotkom | 589 |
| − već u registryju (channel_id) | 121 |
| − viđeno u ciklusu 1 (triage + raw) | 45 |
| − poklapanje po imenu | 2 |
| **Novih kanala → probe** | **421** (420 uspješno) |
| Triage (videos + streams) jaki / možda / slabi | 271 / 95 / 53 |
| **Kandidata (`candidates.json`)** | **107** = 90 kanala + 17 playlista |
| … confidence high / medium / low | 15 / 43 / 49 |
| Odbačeno (`rejected.json`) | 315 |

Razlozi odbacivanja: strani jezik 81, srpski 60, TV/radio/medijska kuća 31, institucionalna
događanja/tribine 31, ne prolazi triage 34, bosanski 19, vlog/gameplay 19, audio knjige 13,
AI-generirani „Hrvatski" dokumentarci 9, re-uploadi 6, već u registryju (stub) 6, ostalo 6.

## Top nalazi (high)

| Kandidat | Tip | Pretpl. | Duge ep. (uzorak) | Zadnji upload |
|---|---|---|---|---|
| Prva linija (Jutarnji list) | playlist | 81.6k | 117/182 | 2026-09-23 |
| Sales Mindset (Vedran Šorić) | channel | 80.5k | 56/60 | 2026-09-21 |
| Um&Boom | channel | 11.4k | 33/34 | 2026-07 |
| Podcast s Brezom | channel | 10.6k | 55/60 | 2026-09-24 |
| Podcast 8_24 (Dvajsčetvorka) | channel (live) | 9.3k | 61/120 | 2026-09-22 |
| Vox Medicus | channel | 2.7k | 27/31 | 2026-06 |
| Vetify Podcast | channel | 2.4k | 18/20 | 2026-07 |
| Fraktura BookTalk | channel | 2.0k | 93 | 2026-07 |
| NOVA — O svemiru i svemu ostalom | channel | 1.1k | 60/60 | 2026-07 |
| Freelance Roditelji | channel | 1.1k | 18/22 | 2026-09-04 |
| Izbačene Scene | channel | 846 | 50/60 | 2026-09-16 |
| Vragolasti Tenis | channel | 767 | 46/46 | 2026-09-17 |
| Politički Marketing Podcast | channel | 351 | 16/18 | 2026-06 |
| Filmopedija | channel | 191 | 28/36 | 2026-09-19 |
| Ovisnici o knjigama | channel | 177 | 14/17 | 2026-09-15 |

Jaki medium (veći doseg): MATKO (51k, MMA/boks), eFISHent (27k, ribolov), Best Food Croatia (27k),
Bez dlake na glavi (25k, live), Osvrtnik — Bezimeni filmski podcast (26k, playlista), AFK Show (12k),
Podcast SFERA (arhitektura), Finax Savjetuje, Radio#matura (HRT radio-drame — audio-drama niša).

## Pokrivenost niša

| Niša | Nalaz |
|---|---|
| boks/MMA | MATKO |
| tenis | Vragolasti Tenis, Žuta Loptica, SK PODCAST |
| šah | samo Šah u Hrvatskoj (low) — pravih HR šahovskih podcasta nema |
| jedrenje, rukomet, planinarenje | **ništa HR** (Kostelić = vlog; planinarski su BiH) |
| trčanje/biciklizam | #KiloMetri; biciklizam.net, Cycling Side, M.P.Broadcast |
| auto-moto | AUTOSCENA (srpski Dizel Astronauti/Autopriče odbačeni) |
| ribolov | eFISHent |
| politika lijevo/liberalno | Liberalni podcast (neaktivan), SSSH „Rad po mjeri čovjeka", SkriptaTV, Politološki podkast |
| audio-drama | Radio#matura (HRT), Zmajeva Garaža (D&D) — ostalo su audioknjige/AI priče |
| manjine | SPD Privrednik (srpska zajednica u Zagrebu) — jedini |
| IT/AI/kripto | Digitalna Kultura, Tech Ćakula, Relax Room, Pričajmo o novcu, Press Play |
| gastro/vino | Best Food Croatia, Vinska karantena |
| arhitektura | SFERA, DAZ, Bauštelski podcast, Baucast |
| film | Izbačene Scene, Filmopedija, Filmovi s Ruba, Dokunet, Osvrtnik, Zona Filma, Antonio Šarić |
| knjige | Fraktura BookTalk, Ovisnici o knjigama, Čitanje i Predrasude, Matičin podcast |
| medicina | Vox Medicus, Vetify, Doktor za srce |
| obrazovanje | Koji faks upisati?, StudentskiHR, MIOC, NOVA |
| vojna povijest | Prva linija (Jutarnji) |
| veze | Noći Bez Cenzure, Bokun Neba, Kognitivna Muza |
| dijaspora (BiH Hrvati) | Vrisak.info, FraMiKo, Tau Studio Čapljina |

## Zamke (nove u ovom ciklusu)

1. **`/videos` tab ne vidi live podcaste.** Dodavanje `/streams` taba podiglo je jake s 236 na
   271. Podcast 8_24 ima 3/60 dugih na `/videos`, a 58 live epizoda (#282). Probe uvijek oba taba.
2. **`xargs -I{}` guta navodnike** — upiti `"podcast" "epizoda 1"` izvršeni su bez navodnika.
3. **Dugi upiti s 6+ riječi vraćaju 0–15 rezultata** (manjine, liberalno, ribolov = 0). Kratki
   upiti od 3 riječi rade bolje; dopunjeno s 20 kraćih.
4. **`approximate_date` je grub:** za starije videe daje „prije N godina/mjeseci" preslikano na
   današnji dan (npr. `2025-09-25`). `first_upload`/`last_upload` su točni samo za svježe; `first_upload`
   je najstariji u uzorku od 60, ne početak kanala.
5. **AI-sinkronizirani „… Hrvatski" dokumentarni kanali** (Der Legionär Hrvatski, WW2 Legends Hrvatski,
   Abyx Cosmos Hrvatski, Planetarni Dokumentarac, Mundare Hrvatski, Ljudska Era) prolaze triage
   savršeno (60/60 dugih) — odbacuju se samo ručno.
6. **Re-uploadi Povijesti četvrtkom** (Domaćin, HronosVoxTemporis, Historia magistra vitae est,
   Pere Kozomara) — 4 kanala, original je već u registryju.
7. **Stubovi bez `channel_id`** se ne hvataju dedupeom po ID-u. Nađeno i odbačeno kao „već u
   registryju", ali to su gotovi podaci za enrichment:
   `dan-za-podcast-kontra` = UC311piiPMAUnz08zuLgq9kw, `pametni-ljudi` = playlista
   PLS9hJy-IsPT0ZJM84vvZU1ue_HoqUYYmf (COO Čakovec), `podcast-s-barbarom` = UCTXzwDMchkFFKT2MeVoBnfQ,
   `kisobran-uniri-podcast` = UCCSRlWu3YlcbkIfORjOFpsQ, `split-tech-city-podcast` = UC8lka4Cf-OTBvs7B53C3WpQ
   (razriješeno u `_existing_handle_resolve.txt`).
8. **SK PODCAST (Sportklub Hrvatska)** — prave epizode od 50–60 min, ali bez playliste, a `/videos`
   je 60/60 isječaka. Registry već ima `sportklub-podcast` (playlista na regionalnom Sport Klubu,
   UChpzBje9Ro6CComXe3BgNaw) — prije dodavanja provjeriti preklapanje.
9. Upiti po nišama na engleskom tlu (učitelji, šah, trčanje, arhitektura) povlače velike EN kanale;
   sport/auto-moto/veze povlače srpske. Kao i u ciklusu 1, jezik se ne da filtrirati heuristikom.

## Datoteke

`queries.txt`, `sweep.sh`, `aggregate.js`, `probe.sh`, `probe_streams.sh`, `playlists.sh`,
`triage.js` (+ `triage.json`, `triage_videos_only.json`), `classified.json`,
`classified_playlists.json`, `reject_reasons.json`, `build.js` → `candidates.json`, `rejected.json`.
Sirovi podaci: `raw/`, `probe/`, `probe_streams/`, `playlists/`, `probe_playlists/`.
`suggested_min_duration_sec` = najveći razmak u distribuciji trajanja između 5 i 30 min (clamp 600–1800).
