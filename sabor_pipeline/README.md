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
| **02a** | ✅ Implementirano | [`02_global_diarization.md`](./02_global_diarization.md) (⚠️ ispravljeno) | `02_diarize.py` — diarizacija po komadima od ~2 h s preklapanjem od 90 s, rezovi u tišini. Lokalne oznake + centroidi po komadu. |
| **02b** | ✅ Implementirano | isto | `02b_merge_speakers.py` — globalno spajanje centroida (average/cosine + **cannot-link**) → `diarization.json` s globalnim `SPEAKER_001…`. |
| **03** | ✅ Implementirano | [`03_asr_and_protocol_parser.md`](./03_asr_and_protocol_parser.md) (⚠️ ispravljeno) | `03_transcribe_and_align.js` — poravnanje Canary SRT-a s globalnom diarizacijom, post-ASR rječnik, protokolarno sidrenje nad **scrapeanim** registrom sa `sabor.hr` → `aligned_transcript.json` + `speaker_map.json`. |
| **04** | 🟡 Djelomično (prolaz A) | [`04_llm_structuring_and_export.md`](./04_llm_structuring_and_export.md) (⚠️ nepregledana) | Vertex AI `gemini-3.5-flash` / Claude Opus semantičko strukturiranje, debatna stabla, RAG chunking (`MAX_TOPIC_CHUNK_CHARS = 8000`) i export. |

---

## ⚠️ Faza 02 — jedan prolaz nad 20 h je ODBAČEN

Prva implementacija je pokušala **jedan** prolaz PyAnnotea nad spojenim
`full_session_16k.wav`. Prekinut nakon 146 min; naknadna analiza pokazuje da ne
prolazi ni teoretski, i to na dva neovisna mjesta (AHC `scipy.linkage` ≈ 25 GB,
`reconstruct()` 28–41 GB tranzijentno × 2 poziva, na stroju s 24 GB od kojih
Docker VM drži 14 GiB). **Ne pokušavati ponovno.**

Mjerenja, izvori iz literature i ispravan postupak:
`docs/pipeline_memorija_i_propusnost_2026-08.md` §5–§6 (§6.8 je postupak).

### Kako se pokreće — SVE ODJEDNOM

```bash
# cijela sjednica, od konfiguracije do članka
sabor_pipeline/run_sabor_session.sh --session sabor_11_izvanredna_11_gospic

# što bi se dogodilo, bez ijedne izmjene
sabor_pipeline/run_sabor_session.sh --session <id> --dry-run

# samo dio lanca / drugi backend za članak
sabor_pipeline/run_sabor_session.sh --session <id> --from 03
sabor_pipeline/run_sabor_session.sh --session <id> --article-backend claude --article-model opus
```

Orkestrator **provodi** četiri pravila, ne samo ih dokumentira:

| Pravilo | Kako se provodi |
|---|---|
| Diarizacija je striktan preduvjet za korak 03 | nema `diarization.json` → ABORT |
| Nikad dva pyannote posla paralelno | `ps` provjera prije koraka 02 → ABORT |
| Prag spajanja se MJERI, ne prepisuje | nema `merge_threshold.json` → 02b se ne pokreće |
| Transkripcija je Canary i radi se IZVANA | nedostaje `.canary.srt` → ABORT s uputom za Colab/Modal |

Registar zastupnika se osvježava pri svakom prolazu — sastav Sabora se mijenja
(zamjene, mandati u mirovanju), a stari popis tiho imenuje krivu osobu.

⚠️ Slijepa provjera (`tools/blind_speaker_check.js`) **nije** u lancu jer troši
LLM kvotu; orkestrator ju ispiše kao preporučeni sljedeći korak. Na pilotu je
u pet prozora našla šest defekata koje deterministički pristup ne vidi
(`docs/sabor_faza03_protokol_i_registar_2026-08.md` §7).

### Kako se pokreće — faza 03

```bash
# 0) registar zastupnika — SCRAPEA se sa sabor.hr, nikad iz modela
node sabor_pipeline/tools/fetch_sabor_roster.js
node sabor_pipeline/tools/fetch_sabor_roster.js --dry-run   # samo ispiši

# 1) poravnanje + imenovanje govornika
node sabor_pipeline/03_transcribe_and_align.js --session sabor_11_izvanredna_11_gospic --dry-run
node sabor_pipeline/03_transcribe_and_align.js --session sabor_11_izvanredna_11_gospic

# 2) neovisna provjera broja govornika ODOZDO (protokol vs klasteriranje)
node sabor_pipeline/tools/verify_speaker_count.js --session sabor_11_izvanredna_11_gospic

# testovi (ulazi su doslovni citati iz stvarnog transkripta)
node --test sabor_pipeline/tools/test_protocol_parser.js
```

**⛔ Registar se NIKAD ne generira iz modela.** Izvor je javni JSON API
službenog rasporeda (`sabor.hr/api/interaktivna-sabornica-new`). Izmišljena
imena i stranke tiho bi zalijepila krivi identitet na govornika kroz cijelu
sjednicu, a fuzzy matching to ne bi ni prijavio.

**Registar ne sadrži članove Vlade** — ministrica je na pilot-sjednici najveći
pojedinačni govornik (87 min). Takve oznake dobivaju `role_hint: "clan_vlade"`
umjesto imena; matcher za njih vraća `null` umjesto „najbližeg" zastupnika.
Njih rješava **sloj ljudskih odluka** (dolje): jedan unos za tu ministricu
podigao je imenovano vrijeme za **8.1 postotni bod**.

Mjerenja, ograde i otvorene rupe: `docs/sabor_faza03_protokol_i_registar_2026-08.md`.

### Sloj ljudskih odluka + aplikacija za pregled

Protokolarno sidrenje staje na ~66 % govornog vremena i to je **strop, ne bug**
(19 od 28 preostalih govornika predsjedavajući nikad ne imenuje). Ostatak
zatvara čovjek, ali **nikad upisom u transkript** — odluke idu u zaseban
`human_overrides.json` koji faza 03 pri svakom prolazu primijeni kao sidro
najvišeg prioriteta. Zato run ostaje ponovljiv.

```bash
# aplikacija za pregled — red čekanja po pouzdanosti, odluka, pa faza 03
node sabor_review/server.js            # → http://localhost:8788

# referentni prolaz BEZ ljudskog sloja (za mjerenje ljudskog doprinosa)
node sabor_pipeline/03_transcribe_and_align.js --session <id> --no-human --suffix .protokol
node sabor_pipeline/tools/diff_naming.js --session <id> \
     --before storage/output/sabor/<id>/aligned_transcript.protokol.json

# neovisna revizija ljudskog sloja (ljudska odluka ulazi s pouzdanošću 1.0!)
node sabor_pipeline/tools/audit_overrides.js --session <id>

# TREĆI izvor identiteta: ime koje režija ispisuje na ekranu (offline OCR)
# Ne ovisi ni o čijem govoru, pa dohvaća upadice i replike koje protokol ne zna.
node sabor_pipeline/tools/ocr_captions.js --session <id>              # prijedlozi
node sabor_pipeline/tools/ocr_captions.js --session <id> --validate   # provjera na 68 poznatih

# je li tvrdnja „ove dvije oznake su ista osoba" akustički održiva
python3 sabor_pipeline/tools/audit_merge_cohesion.py --session <id> --cross SPEAKER_A,SPEAKER_B

node --test sabor_pipeline/utils/human_overrides.test.js
```

Detalji, zamke i mjerenja: `docs/sabor_human_in_the_loop_2026-08.md`.
Natpis s ekrana kao izvor: `docs/sabor_ocr_imena_s_ekrana_2026-08.md`
(45 od 49 neimenovanih oznaka dobilo prijedlog; 67/67 slaganja s protokolom).

⚠️ `ocr_captions.js` traži prevedeni `tools/ocr/vision_ocr` — vidi
`sabor_pipeline/tools/ocr/README.md`. Bez njega ne radi.

### Kako se pokreće

```bash
# 1) diariziraj po komadima (idempotentno — nastavlja gdje je stalo)
python3 sabor_pipeline/02_diarize.py --session sabor_11_izvanredna_11_gospic --dry-run
python3 sabor_pipeline/02_diarize.py --session sabor_11_izvanredna_11_gospic

# 2) IZMJERI prag (ne prepisuj 0.68 iz specifikacije!)
python3 sabor_pipeline/tools/calibrate_threshold.py --session sabor_11_izvanredna_11_gospic

# 3) spoji identitete govornika kroz komade
python3 sabor_pipeline/02b_merge_speakers.py --session sabor_11_izvanredna_11_gospic --sweep-only
python3 sabor_pipeline/02b_merge_speakers.py --session sabor_11_izvanredna_11_gospic

# 4) validiraj protokolom (predsjedavajući: rotacija, ne rascjep)
python3 sabor_pipeline/tools/validate_chair.py --session sabor_11_izvanredna_11_gospic

# provjera ograničenog AHC-a (mora biti identičan scipy-ju bez ograničenja)
python3 sabor_pipeline/tools/test_merge_speakers.py
```

### Datoteke

| Datoteka | Uloga |
|---|---|
| `02_diarize.py` | faza 02a — plan rezanja + diarizacija po komadu, u nadziranom djetetu |
| `02b_merge_speakers.py` | faza 02b — globalno spajanje centroida, `diarization.json` |
| `utils/audio_chunker.py` | plan komada, rezovi u tišini (RMS VAD), čitanje isječka kao `float32` |
| `utils/diar_runner.py` | pokretanje PyAnnotea nad isječkom (waveform, MPS cap) |
| `utils/machine_guard.py` | mjerenje pritiska (`phys_footprint`, swap-rast, disk) + nadzornik |
| `tools/calibrate_threshold.py` | mjerenje praga po §6.7 → `merge_threshold.json` |
| `tools/validate_chair.py` | validacija protokolom — rotacija predsjedavajućih + kontinuitet preko videa |
| `tools/test_merge_speakers.py` | test ograničenog AHC-a i post-obrade |
| `03_transcribe_and_align.js` | faza 03 — poravnanje ASR ↔ diarizacija, sidrenje, `aligned_transcript.json` |
| `tools/fetch_sabor_roster.js` | scrape službenog registra zastupnika sa `sabor.hr` |
| `utils/protocol_parser.js` | najave predsjedavajućeg — rečenica PREDAJE riječi, ne posljednje ime u bloku |
| `utils/roster_match.js` | ime iz najave → zastupnik (Jaro-Winkler + Levenshtein, rod titule kao razbijač) |
| `utils/asr_dictionary.js` | post-ASR rječnik — samo pravila s izmjerenim brojem pojava |
| `tools/verify_speaker_count.js` | donja granica broja govornika iz protokola (neovisna o klasteriranju) |
| `tools/test_protocol_parser.js` | testovi faze 03 nad doslovnim citatima iz transkripta |
| `run_sabor_session.sh` | **orkestrator** — jedan ulaz od konfiguracije do članka, s tvrdim preduvjetima |
| `04_article_sliding_window.js` | faza 04 (prolaz A) — dugi članak map-reduce kliznim prozorom |
| `tools/blind_speaker_check.js` | slijepa provjera imenovanja modelom (gole oznake, bez registra) |
| `tools/audit_article.js` | revizija članka — izmišljena imena i timestampovi |
| `tools/crosscheck_speakers.js` | usporedba bilježaka faze 04 s fazom 03 (⚠️ kružno, vidi §7.1) |
| `tools/ocr_captions.js` | natpis s ekrana → prijedlozi identiteta (sličice + Vision OCR + registar) |
| `tools/ocr/vision_ocr.swift` | offline OCR sličica preko macOS Vision frameworka (55 ms/sličica) |

---

## 📊 Zaključak pilota

Nakon 48 h i jedne cijele sjednice (20 h, 4 streama): **`docs/sabor_pilot_zakljucak_2026-08.md`**
— što je proizvedeno, četiri neovisne provjere kvalitete, usporedba Opus 5 vs
Gemini 3.7 Flash i što još nije automatizirano.

Kratko: **68 imenovanih zastupnika, 66 % govornog vremena, 98.4 % slaganja u
slijepoj provjeri, 0 izmišljenih imena u člancima.** Za produkciju je dovoljan
Gemini 3.7 Flash; Opus se isplati kad treba sinteza kroz cijelu sjednicu.

## 🛠️ Ponovna uporaba postojećih alata u `fetch.domovina.tv`
Novi kod u `sabor_pipeline/` izravno se naslanja na postojeće module i postavke:
* `convert_to_wav.js` i `yt-dlp` cookie mehanizam iz `fetch.js`.
* `colab_diarize/diarize_canary.py` i lokalno izvođenje na Mac Mini M4 Pro (isključivo CPU/MPS).
* `colab_canary/` / `modal_canary/` za NVIDIA Canary 1B v2 transkripciju (nikad Whisper).
* `gemini.conf` postavke (`VERTEX_PROJECT`, `gemini-3.5-flash`, global endpoint).
* RAG i R2 upload module (`prepare_rag_combined.js`, `upload_to_r2.js`).
