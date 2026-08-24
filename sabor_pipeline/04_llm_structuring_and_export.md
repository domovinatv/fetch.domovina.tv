# Prompt 04: LLM Semantic Structuring & YouTube Deep-Link Export

## 📌 Uloga za Claude Code (Opus 5)
Implementiraj modul `sabor_pipeline/04_structure_and_export.js` koji koristi Vertex AI Gemini (koristeći postojeće klijente iz `generate_article_gemini.js` i `summarize_gemini.js`) za semantičku obradu saborske sjednice te generira završni JSON dataset i Markdown analizu s točnim YouTube deep linkovima.

---

## 🎯 Zahtjevi i specifikacija

### 1. YouTube Deep-Link pretvorba
Za svaki govorni blok u `aligned_transcript.json` pozovi funkciju `globalToYoutube(manifest, block.start_sec)`:
* Izračunaj kojem YouTube dijelu (Part 1, 2, 3 ili 4) pripada govor i točnu sekundu $t_{\text{yt}}$.
* Dodaj u blok:
  ```json
  "youtube": {
    "part": 2,
    "video_id": "xrZ4FHQSZec",
    "timestamp_sec": 1427,
    "url": "https://www.youtube.com/watch?v=xrZ4FHQSZec&t=1427s"
  }
  ```

### 2. Semantička obrada preko Gemini (Vertex AI)
Koristi chunking po tematskim cjelinama ili satima rasprave za poziv Gemini 2.5 Flash / Pro modela:
1. **Debatna stabla replika (Argument threads):**
   * Poveži koji govor je bio izvorni, tko je replicirao i tko je odgovorio na repliku.
2. **Ekstrakcija ključnih tvrdnji i argumenata:**
   * Pregled argumentacije po klubovima zastupnika (HDZ/DP vs SDP/Možemo/Most).
3. **Analiza glasanja:**
   * Strukturiranje točaka glasanja, broja glasova (ZA, PROTIV, SUZDRŽAN) i ključnih trenutaka.
4. **Key Moments & Prekretnice:**
   * Ekstrakcija 10–15 najvažnijih trenutaka (sukobi, opomene, iznošenje novih podataka o PFAS-u, glasanje) s točnim YouTube linkovima.

### 3. Integracija s postojećim R2 i RAG modulima u `fetch.domovina.tv`
* Prilagodi izlaz tako da se može pripremiti za RAG import (`prepare_rag_combined.js`) i uploadati na Cloudflare R2 (`upload_to_r2.js`) pod putanjom: `cdn.domovina.ai/sabor/sabor_11_izvanredna_11/`.

---

## 📦 Izlazni artefakti:
1. `storage/output/sabor/{session_id}/sabor_session_dataset.json` (potpuni strukturirani dataset).
2. `storage/output/sabor/{session_id}/session_summary.md` (detaljan urednički sažetak s tablicama, dijagramima i YouTube linkovima).
3. `storage/output/sabor/{session_id}/rag_chunks.jsonl` (pripremljeno za Vertex AI / RAG pretragu).
