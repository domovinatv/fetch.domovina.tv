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

Recompute: skripta je bila jednokratna (čita `*.meta.json`, `summary.json`, `article.json`
metadata, `gemini_usage.json` i uspoređuje `.diarized.srt` sa `.speechmatics*.diarized.srt`
da odredi izvor). CDN: `inline["article.json"].metadata.model` i
`inline["article.magisterium.json"].source_article`.
