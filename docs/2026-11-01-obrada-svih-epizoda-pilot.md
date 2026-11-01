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
   (~20–25 min/ep + Magisterium iza). Isto stanje (98 %%, 11–12 GB) zabilježeno je već
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

- Dovršiti pilot i dopisati: trajanje po fazi i epizodi (iz `transitions.tsv` i
  `automatic/logs/priority_2026-11-01.log`), padove, stvarni pomak tjedne kvote
  (`api/oauth/usage`: prije pilota 8 % tjedni / 9 % 5h, 01.11. 06:52).
- Magisterium ide i nogometnim epizodama (default ručnog unosa) — vidjeti trošak/vrijeme.
- Odluka o trajnom modelu: razina B (kandidati: agy članak, Opus sažetak) vs sve na
  Opusu, gornja granica po noći (npr. 40), max trajanje (npr. 4 h), brisanje WAV-a i
  fragmenata nakon obrade, obrada kroz dan umjesto samo noću.
- Uredničko: članci za kanale bez dogovora; reelsi i dalje traže `reel.auto`.

## Vezani dokumenti

- `docs/2026-08-26-claude-window-ograda.md` — ograda prozora kvote
- `docs/claude_code_backend_2026-07.md` — Claude backend koraka 7+8
- `docs/2026-10-09-arhiva-po-danima-i-tocni-datumi.md` — watch/backfill dotoka
- `../pipeline.domovina.ai/docs/2026-10-27-paralelna-obrada.md` — prioritetni slotovi (disk prag 25 GB)
