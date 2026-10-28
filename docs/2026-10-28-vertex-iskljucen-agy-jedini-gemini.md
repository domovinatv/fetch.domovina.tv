# Vertex AI isključen po defaultu, agy jedini put za Gemini (28.10.2026.)

**Odluka (Matija, 28.10.2026.):** Vertex AI se u ovom repou **ne koristi osim kad se
eksplicitno upali** (`VERTEX_ENABLED=1`). Implementacija ostaje u kodu. Gemini pozivi idu
samo kroz **agy (Antigravity CLI) u tmux sesiji**, na Google AI Pro pretplati ($0).
Sažetak i članak pišu se kroz **Claude Code pretplatu (Opus)**.

Povod: istog dana je Vertex na `bimbo-sync-prod` za svaki model i regiju vraćao
`403 Request rejected in accordance with our terms of use and policies`, a Gemini je i
prije toga bio usko grlo (429, DSQ kvota). Vidi i
`docs/2026-10-28-bez-gemini-sluha-i-speechmaticsa.md`.

## Ograda

`lib/vertex_auth.js` → `vertexEnabled()` čita `VERTEX_ENABLED` (`1|true|on|yes`).
`vertexAccessToken()` **baca grešku** kad je Vertex isključen. Kroz tu funkciju idu svi
Vertex pozivi u repou, pa ograda vrijedi i za skripte koje ne pitaju unaprijed. Dvije
skripte koje token uzimaju same (`generate_article_vertexai_express.js`,
`tools/diarization_comparison_2026-05-11/compare_llm_judge.js`) imaju istu provjeru na vrhu.

## Što koristi što bez Vertexa

| Mjesto | Bez `VERTEX_ENABLED=1` |
|---|---|
| `run_pipeline.sh` | default `--gemini-backend` = `claude` (prije `vertex`); log kaže „Vertex AI: ISKLJUČEN" |
| `summarize_gemini.js`, `generate_article_gemini.js`, `select_reels.js` | default backend `claude`; eksplicitni `GEMINI_BACKEND=vertex` izlazi s porukom |
| `refine_diarized_gemini.js` (2.8) | ponaša se kao `--no-gemini`: kostur se promovira, 0 poziva |
| `screenshot_youtube.js` (izbor kadra) | odmah agy (tmux `agyss`); ako agy ne odluči → običan kadar, **nikad Vertex** |
| `translate_to_english.js` (EN, Magisterium EN lane) | agy kroz `lib/agy_tmux.js`, tmux sesija `agyen`; `model` u izlazu = `agy:<model>` |
| `import_to_vertex.js` (KORAK 11, Discovery Engine) | i prije opt-in (`--with-vertex-import`), nije diran |

`lib/agy_tmux.js` je generički JSON poziv: upit se zapiše u datoteku u
`~/git/.agy-tmux/<sesija>/`, agy dobije jednu rečenicu („pročitaj X, zapiši JSON u Y"),
čeka se da Y nastane. Pozivi kroz istu sesiju su serijalizirani. Izmjereno 28.10.:
kratki prijevod ~23 s po pozivu (uključuje `/clear` i pokretanje sesije prvi put).
Gledanje: `tmux attach -t agyen -r`.

## Zamke

- agy nema `promptFeedback.blockReason`, pa grana „PROHIBITED_CONTENT → reframe" u
  prijevodu tamo nikad ne okine; odbijen upit izgleda kao timeout (`AGY_TIMEOUT_SEC`, 600).
- agy je sporiji od Vertexa i serijaliziran — EN prijevod epizode traje 3 h 41 min umjesto ~7 min (izmjereno, vidi dolje)
  s Vertexa.
- `--gemini-backend cli` (gemini CLI) i `agy` za korake 7+8 i dalje postoje kao eksplicitni izbor.

## Povratak

`VERTEX_ENABLED=1` u okolišu (npr. `env VERTEX_ENABLED=1` ispred poziva u
`automatic/nightly_pipeline.sh`). Ništa drugo ne treba mijenjati.

## Vezani dokumenti

- `docs/2026-10-28-en-prijevod-agy-trajanje.md` — izmjereno: EN prijevod jedne epizode kroz agy traje 3 h 41 min (92 serijalizirana poziva, medijan 124 s), kandidati za ubrzanje
