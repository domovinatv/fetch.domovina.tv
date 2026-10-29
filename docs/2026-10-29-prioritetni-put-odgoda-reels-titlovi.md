# Prioritetni put: odgođeni članak, reels.json i ručni titlovi (29.10.2026.)

Tri rupe prioritetnog (ad-hoc, pipeline.domovina.ai) puta naspram nightlyja, nađene na
MNk-eEpDb3E („AI u javnim službama? | S7.EP4”, Netokracija, `_unlisted`).

## 1. Članak odgođen ogradom Claude prozora

`priority_worker.sh` vrti run uz `CLAUDE_WINDOW_GUARD=1` (`lib/claude_window.js` → arbitar
`claude-window`). Između ~03:30 i 08:30 nov Opus poziv otvorio bi 5h prozor kvote živ u
08:30, pa koraci 7+8 ispišu `⏸️ [ODGOĐENO] … ODGODI — nov prozor bi trajao do …, preko 08:30`.
Run prođe (R2, H.264, bundle) **bez članka**, a job ostane u `processing` dok nightly ne
napiše članak, ~22 h kasnije. U adminu se to nije vidjelo.

Izmjereno: prijepis gotov za 3,5 min (Soniox 56 s, pyannoteAI ~30 s), članak odgođen u 05:10.

Rješenje (pipeline.domovina.ai `839ab97`, D1 migracija 0016):
- bridge nakon runa bez `article.json` pita `claude-window check`, razlog ide u `jobs.llm_deferred`
- admin: badge „⏸ članak odgođen” + gumb **▶ Članak ipak sada** (`llm-now`, uz confirm)
- job se vraća u prioritetni red s `llm_force=1`; `plan.js` tada postavi `CLAUDE_WINDOW_GUARD=0`
- ponovna obrada (`reprocess=1`) s `llm_force` ide kao `--reprocess-article`, da ne sklanja
  svježi prijepis i ne plaća Soniox/pyannoteAI dvaput

Prvi stvarni prolaz: klik 05:40:37, claim 05:41:58, sažetak 05:42:08, članak ✅,
`PIPELINE ZAVRŠEN` 05:47:37, done 05:48 (run 5 min 38 s; koraci 0–6 preskočeni za ~10 s).
Gumb otvara nov 5h prozor kvote (ovdje do ~10:42), zato je odluka admina.

## 2. reels.json nije stizao na CDN

KORAK 9.9 piše `reels.json` lokalno, a na CDN ga nosi samo launchd reels tick
(`automatic/reels_render.sh`, svakih 30 min), koji se **preskače dok radi bilo koji
`run_pipeline.sh`** (`pgrep`). Ad-hoc epizoda je stajala bez istaknutih trenutaka pod
playerom; frontend je pokazivao fallback popis poglavlja.

Rješenje (`61bcac29`): KORAK 12.68 u prioritetnom putu,
`render_reels.js --publish-only --candidates-only --video-id <id>`. `--candidates-only`
je nova zastavica: `--video-id` inače znači i pristanak za video reela, a ovdje se
objavljuje samo `reels.json`, nikad video bez `reel.auto` kanala.

## 3. Ručni YouTube titlovi

`fetch_youtube_subs.js` je radio samo za originale praćenih kanala (`backfill.json`).
KORAK 12.8 ga zove za prioritetni video; za video izvan `backfill.json` naslov i datum
čita iz `_unlisted/*.info.json`, slug `_unlisted` (katalog titlove traži po ID-u).
1 jedinica Data API kvote; yt-dlp samo kad autor ima ručni HR/EN titl. Non-fatal.
MNk-eEpDb3E nema ručni titl; download put na ad-hoc videu s titlom još nije prošao.

## Što ad-hoc i dalje NEMA (namjerno)

- renderirani video reela (traži `brand.json` s `reel.auto` kanala; `_unlisted` ga nema)
- kanalski indeks `/c/<kanal>` (`_unlisted` je neindeksiran); `auto_reuse_adhoc.js` ga
  kopira u kanal ako je video s praćenog kanala

## Vezani dokumenti

- `docs/2026-08-26-claude-window-ograda.md`
- `docs/2026-10-25-reels-kandidati.md`, `docs/2026-10-29-reels-en.md`
- `docs/2026-10-28-rucni-youtube-titlovi.md`
- pipeline.domovina.ai `docs/2026-10-27-paralelna-obrada.md`
