# Tier 2: sažetak, članak i reels kroz agy + ograda 5-satnog prozora (07.11.2026.)

## Odluka

Tier 2 su sve nove epizode nepraćenih kanala, koje šalje `automatic/enqueue_all_new.js` i koje
obrađuje `pipeline.domovina.ai`. Od 07.11.2026. oko 09:00 njihovi LLM koraci idu kroz **agy u
tmuxu** (`lib/agy_tmux.js` `agyJson()`), model **`gemini-3.8-flash-low`**, na Google AI Pro
pretplati. Claude Opus više ih ne radi. Na agy su prebačeni:

- KORAK 7, sažetak (`summarize_gemini.js`);
- KORAK 8, dvofazni članak (`generate_article_gemini.js`);
- KORAK 9.9, reels kandidati (`select_reels.js`).

Tier 1 (praćeni kanali, nightly) ostaje na Claude Opusu.

## Zašto

Noću 06./07.11. Tier 2 serija (48 epizoda, Opus, `llm_force`) podigla je 5-satni prozor pretplate na
**91 %**. `llm_force` zaobilazi `claude_window` ogradu, a jedina druga ograda bila je tjedna (85 %).
Tier 2 je volumen (40–50 epizoda dnevno), pa ne smije trošiti kvotu koju trebaju interaktivne sesije
i Tier 1.

## Kako je izvedeno

| Gdje | Što |
|---|---|
| `pipeline.domovina.ai/bridge/plan.js` `planFor` | Za Tier 2 job pregazi `job.llm_backend` u `TIER2_LLM_BACKEND` (default `agy`). `TIER2_LLM_BACKEND=claude` vraća stari put. Backend (`types.ts` `LLM_BACKENDS`) i dalje ne zna za `agy`, pa job nastaje kao `claude:opus`, a override radi bridge. |
| `bridge/priority_poller.js` | Log `🤖 koraci 7+8: agy (job traži claude; Tier 2 → agy)`. Stvarni izvor ide u `llm_provider` (`agy:gemini-3.8-flash-low`) u PATCH-u `state:'transcribing'`. Admin od v0.22.0 to prikazuje amber pillom „🤖 agy · … (tmux)” s naslovom „Traženo: claude:opus”. |
| `summarize_gemini.js`, `generate_article_gemini.js` | `callAgyCli` više ne zove `agy -p`, koji ne vraća odgovor, nego `agyJson()` u tmux sesiji `agyllm-s<PRIORITY_SLOT>-low`: jedna sesija po slotu, pa se dva paralelna slota ne sudaraju. `AGY_MODEL` je po defaultu `gemini-3.8-flash-low`. Agy grana članka vraća `{parsed, raw}`, isti oblik kao Claude grana; prije je vraćala goli JSON i FAZA 1 je pucala na „data argument must be of type string”. |
| `select_reels.js` | Novi backend `agy`, ista tmux sesija. |
| `bridge/priority_poller.js` | **Ograda 5-satnog prozora:** prije claima čita `readUsage()` (keš 5 min, `~/.cache/domovina-pipeline/usage_cache.json`). Na `five_hour ≥ PRIORITY_MAX_5H` (default 80) ne claima: `⏸️ 5h prozor …`. Ako se kvota ne može pročitati, claima normalno. |
| `~/Library/LaunchAgents/tv.domovina.fetch.priority.plist` | `PRIORITY_DAILY_MAX` 40 → **50**. Tier 2 više ne troši Claude kvotu, a 48 epizoda u noći prelazilo je 40. |

Ručna pauza pollera ostaje ista: datoteka `~/.cache/domovina-pipeline/priority_hold`.

## Slug i dedup

Agy članak se zove `…_<datum>_agy.article.json`. Po leksikografskom dedupu (`opus` > `gemini-*` > `agy`)
agy nikad ne pregazi postojeći Opus članak. Ako se epizoda kasnije prebaci u praćeni kanal i dobije
Opus, Opus pobjeđuje bez ikakvog brisanja.

## Mjerenja (prvih 10 agy jobova, 07.11.)

| Korak | Trajanje |
|---|---|
| Sažetak | ~20 s |
| Outline (FAZA 1) | 22–28 s |
| Iteracija članka (FAZA 2) | 39–78 s |
| Reels | ~40 s |
| Job od claima do `done` | 6–19 min (Opus prije: 13–25 min) |

Svih 10 je `done`, bez nijedne greške. Kod `hkvq0MOIdNo` reels je od 8 kandidata zadržao samo 1.
Je li Flash-low prestrog u odbacivanju, još nije uspoređeno s Opusom.

## Otvoreno

- Kvaliteta agy članka i reelsa u odnosu na Opus još nije sustavno uspoređena.
- `llm_provider` se šalje tek s `state:'transcribing'` (nakon ASR-a), pa job koji se još obrađuje
  pokazuje traženi model.

## Ostali nalazi 07.11. (ništa nije popravljeno)

Nalazi s jutarnjeg pregleda nightlyja i usporedbe kataloga za 06.11. Za svaki je predložen popravak,
ali nijedan nije izveden.

1. **Datum u katalogu nije isti kao na /dani.** podcast.domovina.ai `/dani/2026-11-06` pokazuje 38
   epizoda, a katalog (`domovina.ai/api/katalog/v1/days/2026-11-06`) 12. Od razlike: 20 ih je u
   trenutku provjere (~08:00) još bilo u Tier 2 redu, a 3 imaju drugi dan
   (`otd_t_hHu4c`, `nToZnW8RHP4`, `onRqdjdtoKU`). Katalog uzima yt-dlp `upload_date`, koji je UTC,
   a /dani `published_at` po Europe/Zagreb. Epizoda objavljena između 00:00 i 01:00 po našem vremenu
   zato u katalogu padne na prethodni dan. Popravak ide u katalog ingest, repo `domovina.ai`.
2. **Tri epizode nikad nisu ušle u `events.jsonl`**, pa ih Tier 2 nije ni poslao:
   `SGDEtqqLrHc` (hrt-otvoreno), `5grG3YMQsrk` (sbs-croatian), `Lm5_0TYzCLQ`
   (tribina-europski-nogomet). Svi su kanali `tracking.enabled:false`. Rupa je u
   `watch_candidates.js` i još nije istražena.
3. **Members-only video se ponavlja uzalud.** `LGJRjT7p960` (Frankopani) pada s „members-only
   content”. Proxy tu ne pomaže, a automatski retry u `enqueue_all_new.js` pokuša do 3 puta.
   Prijedlog: bridge takvu grešku označi kao trajnu.
4. **Audit nightlyja 07.11. završio je s exit 1** zbog drifta `book.epub` za `WRE248YCIeI`
   (domovina_tv). Popravak: `node force_upload.js --video-id WRE248YCIeI --channel domovina_tv`,
   ali prvo provjeri smjer drifta.

## Procjena za 07.11. (u 09:47)

| Što | Kad gotovo |
|---|---|
| Tier 2 članci (8 preostalih) | oko 11:00–11:30 |
| HR Magisterium (~33, ~3 na sat, jedan po jedan) | oko 20:30–21:30 |
| EN prijevodi (~2,5 min po epizodi, odmah iza HR-a) | oko 21–22 h |
