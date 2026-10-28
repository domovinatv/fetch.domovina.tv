# Bez Gemini sluha i Speechmaticsa (28.10.2026.)

**Odluka (Matija, 28.10.2026.):** prijepis i govornici = samo **Soniox + pyannoteAI**,
sažetak i članak = **Opus 5.5 kroz Claude Code pretplatu**. Gemini sluh (KORAK 2.8) i
Speechmatics (KORAK 2.7 i fallback u 2.7b) su isključeni u nightlyju i u prioritetnom
putu (pipeline.domovina.ai `bridge/plan.js`).

Razlozi:

- Soniox+pyannoteAI prijepis je dovoljno dobar sam (presuda iz
  `docs/2026-10-25-asr-prioritet-soniox.md`: „Soniox+pyannote super").
- Gemini je više puta bio usko grlo (429, kvota, sporost — 2.8 je blokirajući korak).
- 28.10. je Vertex na cijelom projektu `bimbo-sync-prod` vraćao
  `403 Request rejected in accordance with our terms of use and policies` za svaki model
  i svaku regiju; 2.8 je trošio 7 pokušaja po prozoru i ništa nije dobio.

## Zastavice

| Zastavica (`run_pipeline.sh`) | Env | Učinak |
|---|---|---|
| `--no-gemini-ear` | `GEMINI_EAR=0` | 2.8 i dalje radi, ali **bez ijednog Vertex poziva**: `refine_diarized_gemini.js --no-gemini` piše kostur kakav jest i promovira ga u `.wav.canary.diarized.srt` |
| `--no-speechmatics` | `SPEECHMATICS=0` | gasi KORAK 2.7 i Soniox→Speechmatics fallback (`transcribe_soniox.js --no-fallback`). Padne li Soniox, mreža je Canary (2.6) + lokalni pyannote (6) |

## Zašto 2.8 nije jednostavno ugašen

2.8 s `--promote` je **jedini** korak koji Soniox+pyannoteAI kostur pretvara u kanonski
`.wav.canary.diarized.srt` koji čitaju koraci 7–12. Bez njega bi kanonski SRT radio
lokalni pyannote nad Canaryjem, tj. Soniox bi se platio i bacio. Zato `--no-gemini-ear`
ide **uz** `--gemini-refine-promote`, ne umjesto njega.

Izlaz zadržava imena `{audio}.soniox_pyannote.gemini.{diarized.srt,meta.json}` jer po
njima `isPromotedRefine` (5 kopija: summarize, article, prepare_rag×3) zna da Sortformer
ne smije zasjeniti kanonski SRT (`soniox_refine_sortformer_shadow_bug`). Istinu nosi
meta: `gemini_ear: false`, `model: null`, `source: "soniox+pyannote"`, a
`lib/processing_manifest.js` tada kanonski izvor zove `soniox+pyannote_ai` (bez `+gemini`).

## Što i dalje koristi Vertex/Gemini

Nije dio ove odluke, pa ostaje ovisno o Vertexu: izbor najljepšeg kadra (KORAK 10, ima agy
fallback samo na 429), EN prijevod (`translate_to_english.js`, Magisterium EN lane),
`select_reels.js` uz Vertex backend. Koraci 7+8 u nightlyju već idu na `claude` (Opus).

## Povratak

Makni `--no-gemini-ear --no-speechmatics` iz `automatic/nightly_pipeline.sh` i iz
`CLOUD_FLOW_ARGS` u `../pipeline.domovina.ai/bridge/plan.js`.
