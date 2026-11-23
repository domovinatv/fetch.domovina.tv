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

## Provedeno (23. 11. 2026., ~09 h)

1. **/streams za sve kanale.** Potvrđeno pregledom kartica: `h8qR80bc5VY` i
   `tW71sjw4Lr4` su na `/streams` (`live_status: was_live`), a ne na `/videos`. Isto
   vrijedi za `O5zlcJhXHE0` (hrt-nedjeljom-u-2, 23. 11.). `watch_candidates.js` sada uz
   izvor `…/videos` čita i `…/streams` za svaki kanal (dosad samo za 75 kanala s
   `extra_source_urls` u `rules.json`; novih je 216). Automatski izvor nije dio ključa
   izvora, pa kanali ne dobivaju novi baseline. Prvo čitanje kartice upisuje se kao
   baseline (`streams_baseline_at`), dakle bez backfilla starih prijenosa. Kanal bez
   kartice (`This channel does not have a streams tab`) dobiva `no_streams_at` i ne
   provjerava se 7 dana. Testovi: `automatic/watch_candidates.test.js`.
2. **`automatic/missing_report.js`** (nightly iza `backfill_days.js`, `--enqueue
   --telegram`) → `automatic/watchlist/missing.json`. Razlozi: `never_seen`, `queued`
   (s napomenom `pauza anti-bot do HH:MM` dok poller stoji), `failed:<korak>`
   (download/asr/clanak/magisterium/bez_zvuka/ostalo), `gave_up` (3 pokušaja zbrojena s
   `enqueue_all_new.js`, ili pad koji se ne ponavlja), `tier1` (praćeni kanal; samo se
   prijavljuje, ne šalje se). Isključeno: obrađeno, postavke kanala (Ora et Labora),
   `process:false`, [PROMO]/derivat iz `watch-state`, te objavljeno prije manje od 3 h.
   Prvi stvarni prolaz poslao je 3 joba (tri `never_seen` s /streams).
3. **Provjera na stvarnim podacima, 16.–23. 11.** Svaku razliku između
   podcast.domovina.ai/dani i kataloga domovina.ai objašnjava jedno od ovoga: ora-et-labora,
   [PROMO] (`UPnlK2aS8JU`), `missing.json` (`queued`, `never_seen`, sad poslano) ili
   ispravak ispod.

## Usput nađeno

- **Pojačalo: promjena naslova razbila je pravilo kanala.** Kanal je naslove promijenio
  iz „… Pojačalo podcast EP 39x” u „… | Pojačalo EP 39x”, a `exclude_title_regex`
  traži „Pojačalo podcast”. Zato su EP 394 (`kQAalz5pbLw`, 8. 11.) i EP 396
  (`FIOKwc7vxDs`, 22. 11.) označeni kao derivati. Regex sada prihvaća i
  `Pojačalo (podcast )?EP`. EP 396 je već u redu. EP 394 je izvan prozora od 14 dana pa
  se, po pravilu bez backfilla, ne šalje.
- **Anti-bot pauza 06:05–08:05 nije pokrenuo screenshot.** U 06:04 je **download**
  `R7qNz2Il4RU` pao na YouTube anti-bot (`fetch.js`, „poller pauzira 120 min”). Minutu
  kasnije `screenshot_youtube.js` (`WRdnlhq-pI8`) naletio je na isti blok, otišao na
  lokalni ffmpeg fallback i prepisao marker `~/.cache/domovina-pipeline/youtube_antibot.json`
  svojim imenom. Pauza je zato bila opravdana (IP je stvarno bio blokiran). Krivo je bilo
  samo ime izvora u logu, a trajanje je produljeno za 1 min. Mogući popravak (nije
  napravljen): screenshot s lokalnim fallbackom neka ne piše marker, ili neka ne prepisuje
  svježiji marker downloada.
- **Soniox saldo iscrpljen.** `H4u9IuBBBtg` (ril-tok-podcast) je u 05:38 pao s
  `Soniox greška: organization_balance_exhausted`, a Speechmatics za Tier 2 također nije
  uspio. Retry ga je vratio u red, ali bez nadoplate Sonioxa pada opet.
