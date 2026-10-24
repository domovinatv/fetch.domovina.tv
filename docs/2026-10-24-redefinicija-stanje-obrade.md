# re:DEFINICIJA (muzevni_budite): stanje obrade po epizodi (24.10.2026.)

Snimka stanja za 10 epizoda: lokalne datoteke (`generated_at` u JSON-ima, a vrijeme izmjene
samo kad tog polja nema) i CDN (`data/{id}/episode.json`, inline članak i Magisterium).
Pokazuje kako je katalog nastajao slojevito, svaka epizoda alatima svog vremena.

| Ep | ID | Prijepis | Govornici | Sažetak | Servirani članak | Magisterium | EN | words.json |
|---|---|---|---|---|---|---|---|---|
| 1 | LnjTZ39Tsdc | Canary 10.03. (prije Whisper) | pyannote lokalno | Gemini 2.5 Flash | Gemini 2.5 Flash 21.03. | 93 | — | — |
| 2 | -bOmDXC7rlA | Canary 10.03. (prije Whisper) | pyannote lokalno | Gemini 2.5 Flash | Gemini 2.5 Flash 21.03. | 91 | — | — |
| 3 | 1--IUSQILFA | Canary 18.03. | pyannote lokalno | Gemini 2.5 Flash | Gemini 2.5 Flash 21.03. | 93 | — | — |
| 4 | kCa7edJS-Lo | Canary 06.05. | pyannote lokalno | Gemini 2.5 Flash | Gemini 2.5 Flash 12.05. | 98 | — | — |
| 5 | Yoln5fe9RdY | Canary 25.05. | pyannote lokalno | Gemini 2.5 Flash | Gemini 2.5 Flash 26.05. | 92 (Opus 4.7 MCP) | ✅ | — |
| 6 | ouoZvcpBt9Y | Canary 22.06. | pyannote lokalno | Gemini 2.5 Flash | Gemini 2.5 Flash 24.06. | 93 | — | — |
| 7 | ZkMcSRvajCw | Canary 25.07. | pyannote lokalno | Gemini 3.5 Flash | **Opus** 31.07. | 90 ⚠️ nad starim 3.5 člankom | ⚠️ sa starog | — |
| 8 | h_6vqQEL2uc | Canary 17.08. | pyannote lokalno | Gemini 3.5 Flash | **Gemini 3.7 Flash** 25.08. | 86 ⚠️ nad starim 3.5 člankom | ⚠️ sa starog | — |
| 9 | f2HIRJPHHK4 | Canary 15.09. (+ Speechmatics naknadno) | pyannote lokalno | Opus | Opus 15.09. | 78 (23.10.) | — | SM 77 % |
| 10 | DOfcONrRyDY | **Speechmatics + Gemini 3.8 sluh** (promoviran) | Speechmatics | Opus | Opus 18.10. | ❌ nema | — | SM 83 % |

## Otvorene stavke

1. Ep. 7 i 8: CDN servira noviji članak, a Magisterium i EN su iz starog 3.5 članka. Treba ih
   ponovno pustiti nad serviranim člankom (MCP, HR-only).
2. Ep. 10: nema Magisteriuma.
3. Ep. 1–8: nema `words.json`, pa se za njih ne može napraviti reel s titlom. Backfill je
   479 min: kroz Speechmatics ~$6,2, kroz Soniox ~$1 (`docs/2026-10-24-soniox-pyannote-roadmap.md`).
4. Vrijeme izmjene datoteka nije pouzdano: kod ep. 7 prijepis ima kasnije vrijeme od sažetka.

Recompute: danas `node tools/build_processing_manifest.js --channel muzevni_budite --print`
(`{base}.processing.json`, data_contract §16). Prva verzija skripte je bila jednokratna (čita `*.meta.json`, `summary.json`, `article.json`
metadata, `gemini_usage.json` i uspoređuje `.diarized.srt` sa `.speechmatics*.diarized.srt`
da odredi izvor). CDN: `inline["article.json"].metadata.model` i
`inline["article.magisterium.json"].source_article`.


## Soniox + pyannoteAI za svih 10 (24.10. navečer)

Gotovo za svih 10, ništa nije promovirano ni poslano na CDN. Izlaz je
`{audio}.soniox.*`, `{audio}.pyannote_ai.json` i `{audio}.soniox_pyannote.{diarized.srt,words.json}`.

| ep | zvuk | Soniox | pyannoteAI | govornika Soniox / pyannote |
|---|---|---|---|---|
| 1 | 64:41 | $0,129 | $0,139 | 2 / 2 |
| 2 | 55:17 | $0,111 | $0,118 | 2 / 3 |
| 3 | 43:02 | $0,086 | $0,092 | 2 / 2 |
| 4 | 48:35 | $0,097 | $0,104 | 2 / 3 |
| 5 | 62:53 | $0,126 | $0,135 | 2 / 3 |
| 6 | 63:40 | $0,127 | $0,137 | 3 / 3 |
| 7 | 68:41 | $0,137 | $0,147 | 2 / 3 |
| 8 | 71:41 | $0,143 | $0,153 | 2 / 3 |
| 9 | 51:21 | $0,103 | $0,109 | 3 / 3 |
| 10 | 61:59 | $0,124 | $0,132 | 3 / 3 |

Soniox obrađuje ~39× brže od realnog vremena. Treći pyannote govornik na ep. 2, 4, 5, 7 i 8 nije
preslušan: vjerojatno je to uvodni isječak ili kratka upadica, a obrazac odgovara onome da
Soniox spaja govornike.

Ep. 9 već ima Gemini prepis nad tim kosturom (`.soniox_pyannote.gemini.diarized.srt`,
7528 → 7593 riječi, 8 min, $0,17), također nepromoviran.

**Sljedeći prolaz (dogovoren 24.10.):** svih 10 epizoda kao referentna obrada. Redom:

1. Gemini prepis i promocija.
2. Novi sažetak i članak s poglavljima.
3. words.json iz Sonioxa, pa CDN i bundle.
4. Magisterium MCP, HR **i** EN, za svih 10.

Plan i stanje pipelinea: `docs/2026-10-24-pipeline-trenutno-stanje.md`.

## Referentna obrada — napredak (24.10.2026., dan)

| korak | stanje |
|---|---|
| 1. Gemini sluh nad Soniox+pyannote kosturom + `--force-promote` | ✅ 10/10 · ~$0,17–0,21/ep, ~8–27 min/ep · stari kanonski SRT kao `.bak` |
| 2. `--reprocess-article` (Claude Opus, pretplata) → sažetak, članak, screenshotovi, epub, CDN | ✅ 10/10 · **~7 min/ep** (12:24–13:40), ne 20 kako je procijenjeno |
| 3. `generate_words_json.js --with-soniox --force` + `force_upload --targets diarized,words,sponsors` | ✅ 10/10 · CDN GET md5 = disk za diarized.srt, words.json, article.json |
| 4. Magisterium MCP HR | ep. 1 ✅ (25 sekcija, score 86) · ostalo u tijeku, jedan subagent po epizodi |
| 4. EN (`translate_to_english.js`) | u tijeku od ep. 1 |

Zamke naučene usput:

- **`CLAUDE_WINDOW_GUARD=1` u ručnom runu odgodi korake 7+8**, a `--reprocess-article` je
  stari članak već sklonio u `.reprocess_bak/` → epizoda ostane bez članka na disku (CDN
  netaknut jer 12.1 nema što uploadati). Za ručni reprocess pusti bez ograde.
- **`--reprocess-article` NE prepisuje `diarized.srt` ni `words.json`** na CDN-u (samo
  article, summary, outline, epub). Uz novi prijepis treba zaseban `force_upload`.
- **`publish_hr_episode.sh` sam nije dovoljan** kad stari `magisterium.json` već postoji na
  R2: dodaj `force_upload --targets magisterium` i provjeri md5, ne samo status 200.
- **Magisterium `chat` pada na timeout** kod dugih promptova; prep s `--batch-size 2
  --max-words 45`. Ručno skraćivanje promptova na ep. 1 izmislilo je sadržaj u 4 batcha
  (subagent je to sam uhvatio i ponovio) — promptove slati doslovno.
- Prvi nightly na Soniox putu (24.10.): 5 epizoda, 0 grešaka. Tri epizode od 20.–22.10.
  već su imale Speechmatics kanonski SRT pa ih je 2.7b/2.7c/2.8 ponovno obradio (unutar
  prozora od 3 dana) bez promocije — jednokratni trošak prijelaza ~$1,5.
