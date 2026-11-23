# Epizode koje fale na domovina.ai: dijagnoza i plan reda ponovnih pokušaja (23. 11. 2026.)

## Povod

Brojač na domovina.ai/dani/<d> (katalog, odluka 1208 u
`domovina.ai/katalog/docs/decisions.md`) treba davati isto što i
podcast.domovina.ai/dani/<d>, umanjeno samo za namjerno isključeni kanal
**Ora et Labora** (povučen 13. 11.). Drugih isključenih kanala nema. Svaka druga
razlika je epizoda koju pipeline nije obradio.

## Usporedba 16.–22. 11. (izmjereno 23. 11. oko 06 h)

Brojke za podcast.domovina.ai su bez Ora et Labora.

| dan | podcast.domovina.ai | domovina.ai | razlog razlike |
|---|---|---|---|
| 16. 11. | 29 ep | 27 | `UPnlK2aS8JU` [PROMO] preskočen; `h8qR80bc5VY` nikad viđen |
| 17. 11. | 25 | 25 | — |
| 18. 11. | 16 | 16 | — |
| 19. 11. | 30 | 29 | `tW71sjw4Lr4` nikad viđen |
| 20. 11. | 30 | 30 | — |
| 21. 11. | 14 | 8 | 6 u redu (poslano 23. 11. 02:34, `all_episodes.json`) |
| 22. 11. | 30 | 15 | u redu (14 poslano 02:34) + 1 [PROMO] |

Reprodukcija: ID-eve iz HTML-a podcast stranice (`<li class="ep" data-slug=…>`,
link `/v/<id>` ili `watch?v=<id>`) usporediti s
`https://domovina.ai/api/katalog/v1/days/<d>?limit=100`.

## Tri uzroka

1. **Nikad viđeno.** `hrt-nedjeljom-u-2` i `digitalna-kultura` imaju
   `tracking.enabled: false`. `watch_candidates.js` ih čita svaki dan (`last_check`
   23. 11., `errors: 0`), ali samo iz `source: …/videos`. Epizoda nije u
   `watch-state.json` `seen`, a ni u `events.jsonl` ni u `all_episodes.json`.
   `backfill.json` je ima (YouTube Data API). `tW71sjw4Lr4` traje 6 h, pa je gotovo
   sigurno prijenos uživo, a YouTube ih drži na kartici **/streams**. Isto se
   pretpostavlja za `h8qR80bc5VY` (objava u 02:01). Nije potvrđeno pregledom kartice.
   `enqueue_all_new.js` ponavlja samo ono što je jednom ušlo u `events.jsonl`, pa
   takva epizoda nikad ne dobije ni prvi pokušaj.
2. **[PROMO] je namjerno preskočen.** `watch_candidates.js` ga zbog naslova
   označava kao `cls: "derivative"`, a `backfill_days.js` ga drži među originalima.
   Odluka 23. 11.: pipeline ga i dalje preskače, a podcast.domovina.ai ga zasad
   broji. Ideja za kasnije usklađivanje je u
   `podcast.domovina.ai/docs/2026-11-23-ideja-promo-epizode-izvan-brojaca.md`.
3. **Red postoji, ali je kratak.** `enqueue_all_new.js` ima najviše 3 pokušaja i
   gleda zadnja 3 dana (`ALL_EPISODES_LOOKBACK_DAYS`). Epizoda koja padne i četvrti
   dan nestane bez traga. Ne postoji jedan popis „što fali i zašto”.

## Plan (za implementaciju, nije napravljeno)

1. `watch_candidates.js` uz `/videos` čita i `/streams` (i provjeri `/videos` za
   premijere). Test na `h8qR80bc5VY` i `tW71sjw4Lr4`.
2. **Dnevno uspoređivanje** (nightly, iza backfilla): originali iz
   `backfill.json` za zadnjih 14 dana, minus obrađeni (`data/<id>/article.json` u
   `.r2_keys_cache.json`), minus povučeni ili isključeni kanali (postavke kanala),
   minus [PROMO]/derivati. Ostatak ide u `automatic/watchlist/missing.json`, za
   svaku epizodu `{id, slug, date, reason, attempts, last_error, last_try}`.
   `reason` je jedno od: `never_seen` | `queued` | `failed:<korak>` |
   `gave_up`.
3. `never_seen` i `failed` se šalju u isti red (`POST /api/jobs`, isti parametri kao
   `enqueue_all_new.js`). Prozor je 14 dana umjesto 3, a granica pokušaja ostaje.
4. `node automatic/missing_report.js` ispisuje popis, grupiran po razlogu. Sažetak
   ide u Telegram kroz `telegram-notify` putanju, nikad `curl` izravno.
