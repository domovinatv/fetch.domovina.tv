# Sabor AI Pipeline (fetch.domovina.tv extension)

Ova mapa sadrži specifikacije i promptove za proširenje postojećeg pipelinea `fetch.domovina.tv` za podršku saborskim sjednicama (višedijelnim live streamovima s cross-video diarizacijom).

---

## 🏛️ Kontekst & Zašto se ovo gradi u `fetch.domovina.tv`
U `fetch.domovina.tv` imamo produkcijski 12-stupanjski pipeline za obradu podcasta (Whisper, PyAnnote, Vertex AI Gemini, RAG, R2).
Međutim, **saborske sjednice** imaju specifičnosti koje podcast pipeline ne pokriva:
1. **Višedijelni YouTube streamovi (1 sjednica = N streamova):** Npr. 11. izvanredna sjednica (Gospić, 20.–21.8.2026.) trajala je 18 sati i podijeljena je u 4 YouTube live streama:
   * `NKT3niyWwaY` (Part 1 - prijepodne)
   * `xrZ4FHQSZec` (Part 2 - poslijepodne)
   * `i-wvlWqLcJ0` (Part 3 - noć)
   * `Pmg2XI-qnWo` (Part 4 - sutradan & glasanje)
2. **Konzistentnost govornika:** `SPEAKER_01` mora biti ista osoba kroz svih 18 sati i sva 4 videa.
3. **Protokolarno mapiranje (Predsjedatelj):** Rečenice poput *„Riječ ima uvaženi zastupnik Zvonimir Troskot”* služe kao deterministički sidreni signali za identifikaciju zastupnika.
4. **YouTube Deep-Linking:** Generiranje točnih timestampova za svaki pojedinačni video stream.

---

## 📋 Plan faza za Claude Code (Opus 5)

| Faza | Datoteka prompta | Opis zadatka |
| :--- | :--- | :--- |
| **01** | [`01_ingest_and_stitch.md`](./01_ingest_and_stitch.md) | `yt-dlp` download 4 dijela, `ffmpeg` konverzija u 16kHz mono WAV, lossless spajanje u continuous audio + `manifest.json` s tablicom vremenskih pomaka. |
| **02** | [`02_global_diarization.md`](./02_global_diarization.md) | Dugotrajna diarizacija 18h audija (chunked windowing + global agglomerative clustering speaker embeddinga). |
| **03** | [`03_asr_and_protocol_parser.md`](./03_asr_and_protocol_parser.md) | Whisper/Canary ASR prilagođen saborskom rječniku + NLP parser saborskog protokola (*„Riječ ima...”*, *„Replika...”*) za automatsko imenovanje 151 zastupnika. |
| **04** | [`04_llm_structuring_and_export.md`](./04_llm_structuring_and_export.md) | Gemini/Vertex AI strukturiranje (teme, debatna stabla replika, argumenti, glasanje) i export u R2/JSON s YouTube deep linkovima. |

---

## 🛠️ Ponovna uporaba postojećih alata u `fetch.domovina.tv`
Novi kod u `sabor_pipeline/` treba se naslanjati na postojeće module i postavke:
* `convert_to_wav.js` i `yt-dlp` cookie mehanizam iz `fetch.js`.
* `diarize_canary.py` i MPS/Metal ubrzanje na Mac Mini M4 Pro.
* Gemini Vertex AI integraciju iz `summarize_gemini.js` i `generate_article_gemini.js`.
* RAG i R2 upload module (`prepare_rag_combined.js`, `upload_to_r2.js`).
