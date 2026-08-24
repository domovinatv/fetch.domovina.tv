# Sabor AI Pipeline (fetch.domovina.tv extension)

Ova mapa sadrži specifikacije i promptove za proširenje postojećeg pipelinea `fetch.domovina.tv` za podršku saborskim sjednicama (višedijelnim live streamovima s cross-video diarizacijom).

---

## 🏛️ Kontekst & Zašto se ovo gradi u `fetch.domovina.tv`
U `fetch.domovina.tv` imamo produkcijski 12-stupanjski pipeline za obradu podcasta (NVIDIA Canary 1B v2, PyAnnote community-1, Vertex AI Gemini 3.5 Flash, RAG, Cloudflare R2).
Međutim, **saborske sjednice** imaju specifičnosti koje podcast pipeline ne pokriva:
1. **Višedijelni YouTube streamovi (1 sjednica = N streamova):** Npr. 11. izvanredna sjednica (Gospić, 20.–21.8.2026.) trajala je **72.074 s (20 h 01 min 14 s)** i podijeljena je u 4 YouTube live streama:
   * `NKT3niyWwaY` (Part 1 - 20.681 s = 5h 44m 41s)
   * `xrZ4FHQSZec` (Part 2 - 22.125 s = 6h 08m 45s)
   * `i-wvlWqLcJ0` (Part 3 - 22.297 s = 6h 11m 37s)
   * `Pmg2XI-qnWo` (Part 4 - 6.971 s = 1h 56m 11s)
2. **Konzistentnost govornika:** `SPEAKER_XX` mora biti ista osoba kroz svih 20 sati i sva 4 videa.
3. **Protokolarno mapiranje (Predsjedatelj):** Rečenice poput *„Riječ ima uvaženi zastupnik Zvonimir Troskot”* služe kao deterministički sidreni signali za identifikaciju zastupnika iz službenog registra sa `sabor.hr`.
4. **YouTube Deep-Linking:** Generiranje točnih timestampova za svaki pojedinačni video stream pomoću `sabor_pipeline/utils/time_mapper.js`.

---

## 📋 Plan faza za Claude Code (Opus 5)

| Faza | Status | Datoteka prompta | Opis zadatka |
| :--- | :--- | :--- | :--- |
| **01** | ✅ Implementirano | [`01_ingest_and_stitch.md`](./01_ingest_and_stitch.md) | `01_ingest.js` preuzima 4 dijela, konvertira u 16kHz mono WAV, lossless spaja u `full_session_16k.wav` i generira `session_manifest.json` + `time_mapper.js`. |
| **02** | ⏳ Sljedeći korak | [`02_global_diarization.md`](./02_global_diarization.md) | Lokalna diarizacija 20h audija na Mac Mini M4 Pro (part-level PyAnnote + global centroid clustering) bez OOM rušenja. |
| **03** | ⏳ Na čekanju | [`03_asr_and_protocol_parser.md`](./03_asr_and_protocol_parser.md) | Canary 1B v2 ASR poravnanje + Post-ASR rječnička korekcija + Parliamentary Protocol Parser nad službenim registrom zastupnika 11. saziva. |
| **04** | ⏳ Na čekanju | [`04_llm_structuring_and_export.md`](./04_llm_structuring_and_export.md) | Vertex AI `gemini-3.5-flash` / Claude Opus semantičko strukturiranje, debatna stabla, RAG chunking (`MAX_TOPIC_CHUNK_CHARS = 8000`) i export. |

---

## 🛠️ Ponovna uporaba postojećih alata u `fetch.domovina.tv`
Novi kod u `sabor_pipeline/` izravno se naslanja na postojeće module i postavke:
* `convert_to_wav.js` i `yt-dlp` cookie mehanizam iz `fetch.js`.
* `colab_diarize/diarize_canary.py` i lokalno izvođenje na Mac Mini M4 Pro (isključivo CPU/MPS).
* `colab_canary/` / `modal_canary/` za NVIDIA Canary 1B v2 transkripciju (nikad Whisper).
* `gemini.conf` postavke (`VERTEX_PROJECT`, `gemini-3.5-flash`, global endpoint).
* RAG i R2 upload module (`prepare_rag_combined.js`, `upload_to_r2.js`).
