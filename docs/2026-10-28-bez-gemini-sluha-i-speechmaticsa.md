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

## Mjerenja 28.10.2026.

**Novi tok, jedna epizoda** (mreze_rijeci ep. 64 `cWOFhFN03dM`, 32:47 zvuka, koraci ručno
s `--channel --video-id`): Soniox 66 s · pyannoteAI 32 s · 2.8 promocija 0 s · sažetak Opus
25 s · članak Opus 162 s (2 poziva) · screenshotovi 93 s · reels Opus 90 s · R2 + bundle +
channel index ~50 s · **ukupno 518 s**. Soniox→članak 4 min 45 s.

**Stari tok, isti dan:** 2.8 je u nightlyju (start 10:58) trajao **65 min za 5 epizoda**
(11:23–12:28) i nijedan prozor nije uspio (Vertex 403); domovina_tv `QkcpHsj43rE`
(2:05:18) sama 19 min 18 s, s istim izlazom koji `--no-gemini` daje za 0 s.

## Zamke uočene usput

- **Soniox prozor bira po mtime-u datoteke, cap 5** (`transcribe_soniox.js` collectCandidates).
  27.10. je popravljen Beamly refresh (subclub/launched, mrtav 15.09.–27.10.), pa je 28.10.
  u 03:03 stiglo 7 starih EN epizoda; HR epizode od 27.10. skinute minutu ranije (03:01–03:02)
  ispale su iz petice. budi_frajer je zato dobila kanonski SRT iz Canary + lokalnog pyannotea.
  Nije popravljeno — prijedlog: prednost HR/Magisterium kanalima ili sort po datumu epizode.
- **`reels.json` na CDN nosi samo `render_reels.js`** (launchd tick svakih 30 min), a tick
  se preskače dok radi nightly. Ručna obrada epizode mora završiti s
  `node render_reels.js --publish-only --channel <ch> --video-id <id>`.
- **`run_pipeline.sh` / `nightly_pipeline.sh` dok se vrte mijenjaj kopijom + `mv`** (novi
  inode); bash čita skriptu inkrementalno iz otvorenog fd-a.
