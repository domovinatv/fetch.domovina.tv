# Obrada SVIH novih epizoda — projekcija i prvi pilot (01.11.2026.)

Pitanje: možemo li svaku epizodu koju nightly otkrije (praćeni + kandidati iz
registryja, objavljeni na podcast.domovina.ai) provesti kroz punu obradu, i stane li
to u noć. Izvještaj s grafom: <https://claude.ai/artifact/QSPsxxfqGqBSfBEujtFwRo>
(privatan artifact).

## Dotok (daily.json, 31 noć 02.10.–01.11.2026.)

| | vrijednost |
|---|---|
| epizoda/dan | **26,9** prosjek, medijan 25 |
| audio/dan (kandidati) | 25,7 h, prosjek 64 min/ep |
| od toga praćeni (danas se obrađuju) | 2,9/dan (~11 %) |
| vrhovi | utorci 20.10. (56) i 27.10. (70) — noći nadoknade, 0 praćenih |
| trajanje | 7 % ≥ 120 min, 10 % 90–120 min |

## Mjerenja po epizodi (nightly logovi 24.10.–01.11., ~50 min epizode)

| korak | po ep. | napomena |
|---|---|---|
| Soniox 2.7b | 1,4–1,7 min, ~$0,12/h audia | sekvencijalno, može paralelno |
| pyannoteAI 2.7c | 0,5–0,8 min, ~$0,13/h audia | |
| Opus sažetak 7 | 0,3–0,5 min, ~26k ulaz / 3k izlaz | |
| Opus članak 8 | **4,3–6,3 min**, ~100k / 30k u 2–3 poziva | najduži korak |
| reels 9.9 | ~1,6 min, ~28k / 6k | |
| screenshot 10 | 1,7–2,1 min | Apple Vision |
| H.264 12.5 | 1,6–1,8 min | |
| disk | ~300 MB/ep (WAV ~100, yt-dlp fragmenti `.f251/.f396` ~60) | |

Sekvencijalno ~14 min/ep → 27 ep ≈ 7 h (03:00 → ~10:00). Paralelno (3 članka, 4
Soniox/pyannoteAI, preuzimanje ostaje sekvencijalno zbog anti-bota) ≈ 3,5 h.

Claude ≈ $2,2 API-ekvivalenta po epizodi. Kalibracija iz
`claude_subscription_usage_endpoint` memorije (190k-token Opus poziv ≈ 1,25 boda
5h / ~0,2 boda tjednog) daje procjenu **0,3–0,5 tjednog boda po epizodi → sve
epizode = 55–95 % tjedne kvote**. Procjena, nije izmjereno — pilot ju mjeri.
ASR za sve: ~$200/mj.

## Pilot 01.11.2026. (nedjelja)

Korisnik je odlučio: **sve epizode, jednako, bez filtriranja teme**, kroz isti put
kao ručni unos. 19 kandidata noći 01.11. (21,5 h; 2 praćene te noći već su prošle
nightly) poslano je `POST /api/jobs` (⚡ prioritet, Soniox, Claude Opus,
Magisterium uključen, `skip_published`). Popis: `tools/pilot_watch/ids_2026-11-01.txt`.

Praćenje: `tools/pilot_watch/watch.py` (background, javlja samo pad / zastoj >60 min
/ kraj), stanje `tools/pilot_watch/status.py`, prijelazi u
`automatic/logs/pilot_2026-11-01_transitions.tsv` (gitignored).

### Nalazi o zapinjanju (do 08:40)

1. **Interni SSD drži jedan slot.** `priority_pipeline.sh` otvara slot 2+ samo uz
   ≥25 GB slobodnog na `/`; bilo je 11 GB (98 %). Svih 19 ide jedan po jedan
   (~20–25 min/ep + Magisterium iza). Isto stanje (98 %, 11–12 GB) zabilježeno je već
   27.10. pri uvođenju slotova, dakle drugi slot praktički nikad nije radio.
   Oslobađanjem ~15 GB vrijeme se ~prepolovi.
2. **Ograda Claude prozora odgađa članak** svakom prioritetnom jobu koji do koraka
   7+8 dođe prije 08:30 (`ODGODI — nov prozor bi trajao do 13:03`). Bez intervencije
   job čeka idući nightly (~22 h). Za „obradi sve" to pogađa velik dio noćnog posla.
   Riješeno za pilot postavljanjem `llm_force=1` svim jobovima; trajno rješenje je
   otvoreno (ograda propušta nightly-pokrenute jobove, ili auto-requeue nakon 08:30).
3. **Nova opcija „Forsiraj članak”** (pipeline.domovina.ai `4f94003`, deployano
   01.11.): checkbox u admin formi, gumb ▶ Forsiraj na ne-odgođenom jobu,
   `llm_force: true` u `POST /api/jobs`, `enqueue_playlist.js --force-llm`.
4. Admin Basic Auth lozinka iz memorije je rotirana (401); status skriptom ide
   preko Bearer `INGEST_KEY` na `GET /api/jobs`.

### Otvoreno

- ~~Dovršiti pilot~~ → vidi „Rezultat pilota” niže.
- KORAK 10 tiho uspije s 0 kadrova kad dohvat streama ne vrati URL (`3K4LbmUnX-A`):
  treba glasan pad ili retry, i audit „ima article, nema screenshots_webp.json”.
- Magisterium ide i nogometnim epizodama (default ručnog unosa): ~8 min/ep, prazni
  nalazi.
- Odluka o trajnom modelu: razina B (kandidati: agy članak, Opus sažetak) vs sve na
  Opusu, gornja granica po noći (npr. 40), max trajanje (npr. 4 h), brisanje WAV-a i
  fragmenata nakon obrade, obrada kroz dan umjesto samo noću.
- Uredničko: članci za kanale bez dogovora; reelsi i dalje traže `reel.auto`.

## Rezultat pilota (01.11.2026., 07:59 → 15:35)

**19/19 epizoda objavljeno u cijelosti**: HR članak + sažetak, words.json, EPUB,
reels.json, EN prijevod (članak, sažetak, reels, EPUB) i Magisterium HR. Provjereno
iz točke potrošača: `data/{id}/episode.json` na CDN-u za svaku epizodu i
`domovina.ai/v/{id}` → 200.

### Trajanje

| faza | ukupno | po epizodi |
|---|---|---|
| obrada (fetch → CDN), 1 slot | 07:59 → 13:58, **6 h** za 21,3 h audia | prosjek 19 min; prve 4 (57–198 min audia) 30–44 min, zadnjih 13 ~12 min (medijan audia 47 min) |
| EN prijevod (agy) | 56 min, ide odmah iza objave HR članka | medijan 2,7 min, max 6,3 |
| Magisterium HR (MCP, sekvencijalno) | 204 min rada, zadnji gotov 15:34 | medijan 8,1 min, max 34,2 (198-min epizoda); čekanje u redu medijan 47 min, max 83 |

Trajanje po epizodi mjereno je iz `transitions.tsv` (stanje uzorkovano svakih 5 min,
pa ±5 min). Magisterium je rep: obrada je gotova u 14 h, a Magisterium tek u 15:35,
jer ide jedan po jedan (`chat` propušta ~2,5 poziva/min).

### Kvota Claude pretplate (`api/oauth/usage`)

| | prije (06:52) | 10:41 (6 ep) | kraj (15:35) |
|---|---|---|---|
| tjedni | 8 % | 13 % | **15 %** |
| 5h | 9 % | 34 % | 8 % (novi prozor od 13:10) |

**+7 bodova tjednog za 19 epizoda ≈ 0,37 boda/ep** (uključuje i ovu sesiju, koja je
mala; API vraća cijele postotke, pa je raspon 0,32–0,42). To je donji rub procjene
od 0,3–0,5. Prvih 6 epizoda izgledalo je kao 0,8/ep, ali to su bile najduže epizode i
uzorak je bio premalen. 5-satni prozor najviše je došao do ~34 %, nijedna ograda se
nije aktivirala.

Projekcija: 27 ep/dan × 0,37 ≈ **10 bodova tjednog dnevno ≈ 70 % tjedne kvote**
(raspon 60–80 %) samo za obradu, uz sve ostalo što se radi na istoj pretplati.

### Padovi i uzroci

1. **Magisterium HR `-VAs93ZWwEE` (nogometna epizoda) → failed.** Za odlomak bez
   ikakvog katoličkog sadržaja `chat` vrati `structuredContent` s odgovorom, ali bez
   polja `references`; `resp.references.length` je bacao, odgovor se ponovio 4× i
   epizoda je pala. Popravak u `tools/magisterium_mcp_client.js` (`66106ca6`): bez
   `references` → `[]`. Requeue je preskočio 14 gotovih poziva i prošao za 33 s.
2. **Screenshotovi `3K4LbmUnX-A` → 0/40, a pipeline je javio uspjeh.** U KORAKU 10
   dohvat stream URL-a tiho nije vratio ništa (bez poruke u logu), svi kadrovi ❌, a
   `_manifest.json` je ipak zapisan. Epizoda je objavljena bez `screenshots_webp.json`.
   Ponovno `tools/refresh_screenshots.sh _unlisted 3K4LbmUnX-A` → 40 kadrova na CDN-u.
   Uzrok tišine nije nađen; vidi Otvoreno.
3. Odgođeni članci: 4 `ODGOĐENO` u logu ujutro, sve riješeno s `llm_force=1`
   (watcher), nijedan job nije čekao idući nightly.

### Preporuka za trajni model

- **Sve na Opusu je izvedivo, ali uz cap.** ~70 % tjedne kvote za sve epizode je
  previše uz ostali rad. Predlažem **cap ~20 epizoda po noći na Opusu** (~50 %
  tjednog), a ostatak (najduže/najnovije po redu) kroz **razinu B: agy članak + Opus
  sažetak**. Slug `agy` < `opus`, pa se kasnije Opus prolaz može dodati bez
  degradacije.
- **Vrijeme nije problem.** 27 ep ≈ 7–8 h na jednom slotu (03:00 → ~10:30), uz drugi
  slot ~4 h. Drugi slot traži ≥25 GB slobodnog na `/`; cijeli dan je bilo 12–13 GB.
  Najjeftinija poluga je **brisanje WAV-a i `.fNNN` fragmenata** nakon objave
  (~160 MB/ep).
- **Ograda 08:30 mora propustiti nightly/pilot jobove** (ili ih sama requeueati iza
  08:30). Bez `llm_force` bi ujutro odgođeni članci čekali 22 h.
- **Magisterium za sve epizode**: ~11 min/ep × 27 ≈ 5 h sekvencijalno, kroz dan.
  Stane, ali nogometne/glazbene epizode daju prazne nalaze. Razmisliti o preskakanju
  po temi (odluka o „jednako za sve” je korisnikova).
- **Watcher mora pratiti i Magisterium stanje**: pad Magisteriuma pilot watcher nije
  javio (gleda samo `state`), a pad je uhvaćen ručno.

## Uključeno u nightly (01.11.2026. navečer)

Korisnik je nakon pilota odlučio: **od 02.11. nightly obrađuje sve nove epizode**, a
izvještaj potrošnje se prati ~10 dana.

- `automatic/enqueue_all_new.js` (nightly, odmah iza `daily_snapshot.js`): originali iz
  `events.jsonl` zadnja 3 dana (od 01.11.) → `POST /api/jobs` kao u pilotu (⚡, Soniox,
  Opus, Magisterium, `skip_published`, `llm_force`). Stanje `automatic/watchlist/all_episodes.json`,
  najviše 3 pokušaja, pun red (429) se ne broji kao pokušaj. Ograda: tjedni ≥ 85 %
  (`ALL_EPISODES_MAX_WEEKLY`) → ne šalje ništa. `ALL_EPISODES_OFF=1` gasi.
- **Praćeni kanali se ne dupliraju**: `events.jsonl` sadrži samo nepraćene kanale; na
  cijeloj povijesti (842 originala naspram 3402 ID-a iz 52 liste praćenih) preklapanje
  je 0. Uz to backend preskače objavljene i deduplicira aktivne jobove. Nightly KORAK 1
  zato ostaje uključen.
- `automatic/all_episodes_report.js`: `sample` iz `priority_pipeline.sh` (svaki tick,
  sam se prorijedi na 1 u 10 min) → `quota_samples.jsonl`; `report` u nightlyju prije
  slanja zaključi jučerašnju seriju → `automatic/watchlist/ALL_EPISODES_REPORT.md` +
  `all_episodes_daily.json`. Pilot je prvi redak (uzorci kvote upisani ručno).
- Limiti backenda: `PRIORITY_DAILY_MAX` 30, `MAX_QUEUED_TOTAL` 50. Noći s >30 originala
  (29.10. ih je bilo 29) prelijevaju se u idući dan kroz lookback.

## Vezani dokumenti

- `docs/2026-08-26-claude-window-ograda.md` — ograda prozora kvote
- `docs/claude_code_backend_2026-07.md` — Claude backend koraka 7+8
- `docs/2026-10-09-arhiva-po-danima-i-tocni-datumi.md` — watch/backfill dotoka
- `../pipeline.domovina.ai/docs/2026-10-27-paralelna-obrada.md` — prioritetni slotovi (disk prag 25 GB)

## Vidljivost Tier 2 epizoda (05.11.2026.)

Tier 2 epizode objavljuju se kroz `_unlisted`, pa su na CDN-u i na `domovina.ai/v/<id>`,
ali nisu ni u jednom listingu domovina.ai (`generate_channel_index.js` preskače `_`-dirove:
0 pogodaka u `index_bundle.json`, `home.json`, `search.json`). Nalaze se samo kroz
`/search` (Meili) i semantičku pretragu (ClickHouse).

Javni katalog podcast.domovina.ai ih je vodio na YouTube bez oznake D, jer je `dom` ovisio
o `tracking.enabled` kanala. Popravak:

- `podcast.domovina.ai` `58fb664`: epizoda s `data/<id>/article.json` u
  `.r2_keys_cache.json` ovog repoa dobiva `dom: true` → D + `/v/<id>` (feed, kanal, /dani/).
  Mjereno: 107/109 poslanih epizoda ima članak u cacheu; 04.11. D na 28/31 umjesto 6/33.
- `18612cf5`: `tools/nightly_step_report/auto.py` nakon slanja reporta pokreće
  `refresh.sh` (drugi deploy u danu, nakon zadnjeg Magisteriuma). Nightly 5c ostaje prvi.

Stranica je potpuno statična: na `/dani/<datum>/` preglednik ne dohvaća ništa s
`cdn.domovina.ai` (izmjereno u Braveu: same-origin + 33 sličice s `i.ytimg.com`). Runtime
HEAD provjera po epizodi je odbačena: do 30 zahtjeva po stranici i rizik keširanog 404
(vidi memoriju o `Vary: Origin` / HEAD≠GET).

## 06.11.2026. — prva noć kad je ograda tjedne kvote zaustavila Tier 2

Nightly 06.11. je Tier 1 obradio normalno (5 epizoda, na naslovnici u „Najnovije
epizode”), a `enqueue_all_new.js` nije poslao ništa:

```
🌐 Obrada svih novih epizoda: 83 originala 2026-11-03…2026-11-06, za slanje 14
   📊 kvota: tjedni 88 %, 5h 19 %
   ⛔ tjedni 88 % ≥ 85 % — ne šaljem ništa, epizode čekaju idući nightly
```

Zato je `/admin` za 06.11. bio prazan. Brojke:

- Tjedni prozor je u jednom danu narastao s 61 % (nightly 05.11.) na 88 %. Najveći dio
  odnijela je serija od 32 Tier 2 epizode s Magisteriumom, poslana 05.11. (izvještaj:
  `32/32 gotovo, Mag 32, tjedni +25 (0.78/ep)`). Oko 11:30 kvota je bila na 94 %.
- `seven_day.resets_at` = petak 23:59:59 UTC, dakle u subotu u 01:00 po CET-u (02:00 po
  CEST-u). Reset je prije nightlyja u 03:00.
- Svih 14 zadržanih epizoda objavljeno je 05. ili 06.11., pa ostaju u prozoru
  `LOOKBACK=3` i idu same iduće noći. Nijedna ne ispada. To se provjerava s
  `ALL_EPISODES_MAX_WEEKLY=101 node automatic/enqueue_all_new.js --dry-run`, koji ne šalje
  ništa nego samo ispiše popis.

Ručno slanje s `ALL_EPISODES_MAX_WEEKLY=101` je namjerno odbijeno: pri 94 % bi 14 epizoda
s Opusom i Magisteriumom vjerojatno potrošilo ostatak tjedne kvote prije reseta.

Zamka kod čitanja: `/dani/<datum>/` grupira po **datumu objave**, a `/admin` po **noći
slanja**. Tribina NFL/NBA (`BqJ67OO-FVA`, `_YOkTkbrh_k`) su na `/dani/2026-11-05/` s punom
obradom, ali su Tier 2 iz nightlyja 05.11. (objavljene na granici 4. i 5.11.), a ne
iz noći 06.11.
