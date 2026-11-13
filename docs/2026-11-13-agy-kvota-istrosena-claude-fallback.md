# agy kvota istrošena → Claude fallback za Tier 2 i EN (12.–13.11.2026.)

**Vezani dokumenti:** [`2026-11-07-tier2-agy-i-5h-ograda.md`](./2026-11-07-tier2-agy-i-5h-ograda.md),
[`2026-10-28-en-prijevod-agy-trajanje.md`](./2026-10-28-en-prijevod-agy-trajanje.md),
[`2026-11-13-asr-krediti-istroseni.md`](./2026-11-13-asr-krediti-istroseni.md).

## 1. Što se dogodilo

- 12.11. oko 05:20 tjedna Gemini kvota agy pretplate došla je na 100 % (reset 14.11. 04:07 CET).
  U tmux paneu agy piše „⚠ Individual quota reached…”, ali `agyJson()` to nije čitao.
  Svaki poziv je zato čekao 600/1200 s × 3 pokušaja („agy: nema odgovora nakon 600 s”).
- Tier 2 nije imao fallback. 10 epizoda ostalo je bez članka, a C2350w77Fa8 s krnjim člankom
  (`metadata.complete=false`). EN traka je dan i pol samo padala.
- Nightly Tier 1 (Opus) nije bio pogođen.
- Telegram report za 12.11. otišao je tek na rok u 21:10, s `ready:false`.

## 2. Popravci

| Gdje | Što | Commit |
|---|---|---|
| `lib/agy_tmux.js` | `quotaMessage()` čita pane ispod našeg zahtjeva (~9 s i na timeout) → `err.code="AGY_QUOTA"` | `1de73cad`, `16d21ff0` |
| `summarize_gemini.js`, `generate_article_gemini.js` | retry petlje odmah propuštaju `AGY_QUOTA` | `1de73cad` |
| `generate_article_gemini.js` `hasCompleteArticle` | `metadata.complete === false` = nije gotov. Prije: na Claude backendu se `_agy` outline nije našao, pa je krnji članak ušao u `articles-done.json` | `16d21ff0` |
| `pipeline.domovina.ai/bridge/plan.js` + `priority_poller.js` | Gemini 5h ili tjedni ≥ `AGY_GEMINI_MAX_PCT` (98) → `caps.agyExhausted` → Tier 2 backend `claude` (Opus). Log: „🔋 agy Gemini kvota istrošena … → Tier 2 piše Claude” | `d4df8af` |
| `translate_to_english.js` | `TRANSLATE_BACKEND=auto\|agy\|claude`. Auto prelazi na Claude na `AGY_QUOTA` ili kad je kvota pri startu ≥ `TRANSLATE_AGY_MAX_PCT` (98). Ograda: samo dok je Claude 5h < `TRANSLATE_CLAUDE_MAX_5H` (70). Nečitljiva kvota = bez fallbacka | `90cdf62e` |

Claude poziv za EN koristi iste flagove kao koraci 7+8: `claude -p --model sonnet --effort low`
`--output-format json --setting-sources "" --strict-mcp-config --max-turns 1 --tools ""`.
cwd je `$TMPDIR/domovina_claude_cli`, nikad `--bare`. Metadata nosi `claude-code:sonnet`.

## 3. Mjerenje: EN kroz Sonnet/low (zzEY5jQeZDY)

Članak 60 KB, 28 sekcija, s Magisteriumom:

| Poziv | Trajanje |
|---|---|
| sažetak | 13 s |
| članak | 121 s |
| Magisterium | 76 s |
| reels | 19 s |
| **ukupno (4 poziva)** | **229 s** |

- Ulaz: 58k tokena (uglavnom cache write). Izlaz: 43k tokena. Ekvivalent ≈ $0,65.
- Claude 5h prozor +2 pp, tjedni nepromijenjen. 24 epizode procijenjeno ≈ +45 pp 5h prozora,
  pa je ograda na 70 %.
- Kvaliteta je dobra. Jedan doslovan promašaj: „kružok na Svetom Duhu” → „on the Holy Spirit”.

## 4. Zamke

- `GET /api/oauth/usage` vraća **429** kad se često zove. Zato `readUsage()` prvo čita bridgeov
  `~/.cache/domovina-pipeline/usage_cache.json` (≤15 min), a odluka o fallbacku je memoizirana 5 min.
- API PATCH ne dopušta `state='queued'`. Requeue ide ravno u D1
  (`wrangler d1 execute pipeline_domovina --remote`, iz `pipeline.domovina.ai/backend`).
  Prije toga treba ubiti lokalni proces koji job još drži.
- Magisterium EN jobovi koji su pali 3× ne pokreću se ponovno sami (`enqueue_en_new.js`).
  Oni od 12.–13.11. ostaju rupe dok netko ne odluči drukčije.
- EN traka uzima najnovije epizode prve, 10 po ticku. Nema reda „prvo jučer, pa danas”.

## 5. Rezultat

Svih 10 slomljenih epizoda od 12.11. requeueano je 13.11. ujutro i završeno kroz Claude Opus,
C2350w77Fa8 s potpunim člankom. Nightly 13.11.: 6/6, 0 grešaka.
Tier 2 za 13.11. od ~07:30 stoji iz drugog razloga, ASR kredita (vidi vezani dokument).
