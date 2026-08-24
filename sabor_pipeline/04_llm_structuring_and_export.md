# Prompt 04: LLM Semantic Structuring, RAG Chunking & YouTube Deep-Link Export

## 📌 Uloga za Claude Code (Opus 5)
Implementiraj skriptu `sabor_pipeline/04_structure_and_export.js` koja provodi semantičku analizu i strukturiranje saborske sjednice pomoću Vertex AI Gemini modela (ili Claude Opusa), priprema RAG chunkove prema standardima `prepare_rag_combined.js` i generira završne datoteke s preciznim YouTube deep linkovima.

---

## ⚙️ Postavke LLM Backend-a (`gemini.conf` & `CLAUDE.md`)
Skripta mora poštovati postavke iz `gemini.conf` i `CLAUDE.md`:
* **Primarni backend (default):** Vertex AI REST (`gemini-3.5-flash`, global endpoint).
  * Projekt: `VERTEX_PROJECT=project-a275a620-ef0c-45ae-99e`
  * Auth token: `gcloud auth print-access-token --account=stepanic.matija@gmail.com`
  * Cjenik (sidecar tracking): `$1.50` in / `$9.00` out po 1M tokena.
* **Alternativni backend:** `claude -p --model opus --tools ''` (pod Claude Code pretplatom) preko `GEMINI_BACKEND=claude`.

---

## 🎯 Zahtjevi i specifikacija

### 1. Dvofazno strukturiranje (Two-Phase Processing)

Po uzoru na `generate_article_gemini.js`, obrada 20-satne sjednice provodi se u dvije faze kako bi se izbjeglo probijanje konteksta i osigurala visoka dubina analize:

#### Faza 1: Tematski Outline i faze sjednice (`outline.json`)
LLM analizira sažete blokove sjednice i dijeli je na logičke cjeline:
* **Uvodni dio:** Predstavljanje prijedloga predsjednika Milanovića.
* **Izlaganja klubova zastupnika:** Kronološki pregled stajališta klubova (HDZ, DP, SDP, Možemo!, Most, IDS, Centar...).
* **Pojedinačne rasprave i serije replika:** Grupirane po glavnim temama (vještačenje vode/PFAS, uloga Županije i dozvole, odgovornost inspekcije i Andrije Mikulića, Zakon o javnoj nabavi).
* **Završna rasprava i glasovanje:** Pojedinačno izjašnjavanje i prebrojavanje glasova.

#### Faza 2: Rekonstrukcija debatnih stabala i argumentacije (`article.json`)
Za svaku tematsku cjelinu generira se dubinska raščlamba:
* **Debatno stablo:** Povezivanje izvornog govora s replikama i odgovorima na replike.
* **Ključni sukobi:** Sučeljavanje teza vladajućih (sigurnost pitke vode, redoviti natječaji Fonda, izvoz u inozemstvo) i oporbe (hitnost sanacije, zataškavanje, politička odgovornost).
* **Rezultat glasovanja:** Detaljno bilježenje ishoda (78 glasova PROTIV Milanovićevih zaključaka, 81 ZA zaključke većine).

---

### 2. RAG Chunking standard (`rag_chunks.jsonl`)

Slijedi stroga pravila iz `prepare_rag_combined.js`:
* `MAX_TOPIC_CHUNK_CHARS = 8000`: Ako je rasprava dulja od 8000 znakova, reže se isključivo na **granicama govornih segmenata** (nikad usred rečenice).
* **Speaker Name Replacement:** U tekstu chunka obavezno koristiti stvarna imena zastupnika i njihove klubove (npr. *„[Zvonimir Troskot (Most)]: ...”*).
* **Metapodaci:** Svaki chunk mora sadržavati:
  * `session_id`, `date`, `part`, `video_id`, `start_global_sec`, `end_global_sec`, `start_yt_sec`, `end_yt_sec`, `deep_link_url`, `speakers[]`, `topic_title`.

---

### 3. YouTube Deep Linking
Pomoću `time_mapper.js` (`globalToYoutube(manifest, sec)`), svaki govor, replika i ključni trenutak dobiva točan link na YouTube:
$$\text{url} = \text{https://www.youtube.com/watch?v=} + \text{video\_id} + \text{\&t=} + \text{timestamp\_sec} + \text{s}$$

---

## 📦 Izlazni artefakti:
Spremi u `storage/output/sabor/{session_id}/`:
1. `sabor_session_dataset.json` — potpuni JSON dataset za frontend pretraživač i timeline.
2. `session_summary.md` — urednički sažetak s tablicama, dijagramima i deep linkovima.
3. `rag_chunks.jsonl` — JSONL datoteka pripremljena za Vertex AI Agent Builder / Vector DB.
4. `{session_id}.gemini_usage.json` — evidencija utrošenih tokena i troška.
