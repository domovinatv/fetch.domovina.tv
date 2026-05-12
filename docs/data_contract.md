# Data contract: fetch.domovina.tv → downstream consumers

**Verzija:** 1.0 (2026-05-12)
**Status:** Aktivan
**Cilj:** Formalizirati shape podataka koje pipeline ovdje (data producer) proizvodi, tako da
       downstream consumeri (npr. novi `domovina-rag` repo za RAG/agent backend, ili `domovina.ai`
       frontend) mogu na njih ovisiti **bez čitanja izvornog koda producer skripti**.

Ovo je **stabilni ugovor**. Sve promjene koje breakaju downstream consumere zahtijevaju major
verziju (`v2.0`) i CHANGELOG zapis. Aditivne promjene (novo polje) idu kao minor (`v1.1`).

---

## 1. Hijerarhija outputa

```
storage/output/{channel}/                            # symlink-ana po kanalu
├── {basename}.info.json                             # YouTube metadata
├── {basename}.mp3                                   # izvorni audio download
├── {basename}.wav                                   # 16kHz mono PCM (input za transkripciju)
├── {basename}.wav.canary.srt                        # Canary transkripcija (Colab G4)
├── {basename}.wav.canary.csv                        # Canary CSV (timestamps + tekst)
├── {basename}.wav.canary.diarized.srt               # Canary + pyannote diarizacija
├── {basename}.wav.canary.diarized.embeddings.json   # 🔮 RESERVIRANO (v1.1, nije još implementirano)
├── {basename}.wav.sortformer.srt                    # eksperimentalni Sortformer (v2.1)
├── {basename}.wav.sortformer.diarized.srt           # eksperimentalni Sortformer + diarizacija
├── {basename}.canary.summary.json                   # Gemini sumarizacija
├── {basename}.canary.summary.md                     # Markdown sažetak za čitanje
├── {basename}.canary.summary.blocked.json           # marker ako Gemini blokirao (PROHIBITED_CONTENT)
├── {basename}_{date}_{model}.outline.json           # Article Faza 1 — outline
├── {basename}_{date}_{model}.article.json           # Article Faza 2 — sekcije
├── {basename}_{date}_{model}_raw/                   # raw Gemini odgovori (recovery)
│   ├── faza1_outline.raw.txt
│   └── faza2_iteracija_{N}.raw.txt
├── {basename}.rag.jsonl                             # RAG chunkanje (speaker-aware fixed-size)
├── {basename}.rag_import.jsonl                      # RAG chunkanje (outline-aware)
├── {basename}.rag_combined.jsonl                    # 🟢 PRIMARNA RAG datoteka (hybrid)
└── screenshots/                                     # opcionalno (--with-screenshots)
    └── {timestamp}.jpg
```

**`{basename}` format:** `{YYYYMMDD}_{sanitized_title}_yt_{youtube_id}`

Primjer: `20260411_petra_pinjuh_nije_bitna_velicina_bitna_je_kompatibilnost_podcast_cuspajz_125_yt_v5i_BPH5-Lc`

Pravila za sanitization (vidi `sanitizeDescription()` duplicirano u 6-8 skripti):
- Lowercase
- Strip diakritike (č→c, ć→c, š→s, ž→z, đ→d)
- Non-alphanumeric → underscore
- Collapse višestruke underscore u jedan

**🟢 Single source of truth za RAG consumere:** `*.rag_combined.jsonl` — to je shema koju
downstream backend mora poznavati. Sve ostale RAG datoteke su backup/alternativa.

---

## 2. `*.rag_combined.jsonl` — stabilna shema (v1.0)

JSONL (jedan JSON objekt po liniji, UTF-8). Generira `prepare_rag_combined.js`.

```json
{
  "chunk_id": "yt_v5i_BPH5-Lc_chunk_03",
  "youtube_id": "v5i_BPH5-Lc",
  "channel": "podcast_cuspajz",
  "basename": "20260411_petra_pinjuh_...",
  "episode_title": "Petra Pinjuh: Nije bitna veličina, bitna je kompatibilnost — Podcast Cuspajz 125",
  "upload_date": "2026-04-11",
  "chunk_index": 3,
  "chunk_strategy": "combined",
  "start_ts": 1247.5,
  "end_ts": 1389.2,
  "speakers": ["SPEAKER_00", "SPEAKER_01"],
  "speaker_hints": {
    "SPEAKER_00": "Petra Pinjuh",
    "SPEAKER_01": "Domagoj Dalbello"
  },
  "text": "[SPEAKER_00] Mislim da kompatibilnost ovisi o tome...\n[SPEAKER_01] Ali kako definiraš...",
  "char_count": 1834,
  "outline_iteration": 2,
  "outline_theme": "Definicija kompatibilnosti u modernim vezama",
  "source_youtube_url": "https://www.youtube.com/watch?v=v5i_BPH5-Lc&t=1247s"
}
```

### Stabilna polja (`v1.0`, garantirana)

| Polje | Tip | Opis |
|---|---|---|
| `chunk_id` | string | Unique ID, format `yt_{youtube_id}_chunk_{NNN}`. Stabilan kroz re-generaciju. |
| `youtube_id` | string | 11-char YouTube ID |
| `channel` | string | Slug kanala (lowercase snake_case, vidi §3) |
| `basename` | string | File basename bez sufiksa |
| `episode_title` | string | YouTube naslov |
| `upload_date` | string (ISO 8601 date) | `YYYY-MM-DD` |
| `chunk_index` | integer | Pozicija chunka u epizodi, 0-based |
| `chunk_strategy` | string enum | `"combined"` \| `"fixed"` \| `"outline"` |
| `start_ts` | number (seconds) | Početak chunka u audiu |
| `end_ts` | number (seconds) | Kraj chunka u audiu |
| `speakers` | array of string | **Episode-local** speaker tagovi (`SPEAKER_00` itd.) |
| `speaker_hints` | object | **Geminijev guess** SPEAKER → ime; **NIJE kanonska istina** (vidi §5) |
| `text` | string | Chunk tekst s `[SPEAKER_XX]` prefiksima |
| `char_count` | integer | `text.length` |
| `source_youtube_url` | string | Deep-link na YouTube s `t=` parametrom |

### Opcionalna polja (mogu nedostajati)

| Polje | Tip | Kad postoji |
|---|---|---|
| `outline_iteration` | integer | Ako je chunk povezan s konkretnom iteracijom članka |
| `outline_theme` | string | Theme iz outline-a (Faza 1 članka) |
| `summary_snippet` | string | Kratki sažetak chunka (rijetko, kao bonus signal) |

---

## 3. Kanali — slugovi i registar

Channel slugovi su **stabilne** identifikatorske vrijednosti — koriste se u svim datotekama,
URL-ovima, ClickHouse `channel` koloni. Promjena = breaking change.

Trenutni registar (2026-05-12): vidi `automatic/podcasts/*-channel.json`.

Format sluga: lowercase, snake_case, bez dijakritika i razmaka.

Primjer: `bozanstvena_komedija`, `podcast_cuspajz`, `zeljka_markic_i_narod_hr`.

**Pravilo za nove kanale:** dodaj u `automatic/podcasts/` slijedeći postojeću konvenciju.
Slug ne mijenjaj nakon prvog importa — postoji historijat datoteka po njemu.

---

## 4. `*.canary.summary.json` — shema (v1.0)

Generira `summarize_gemini.js`.

```json
{
  "version": 1,
  "generated_at": "2026-05-11T14:23:45Z",
  "model": "gemini-2.5-flash",
  "source": {
    "filename": "20260411_petra_pinjuh_..._yt_v5i_BPH5-Lc",
    "channel": "podcast_cuspajz",
    "youtube_id": "v5i_BPH5-Lc",
    "title": "...",
    "upload_date": "2026-04-11"
  },
  "title_hr": "Petra Pinjuh o kompatibilnosti u vezama",
  "summary_short": "...",
  "summary_long": "...",
  "key_topics": ["kompatibilnost", "veze", "samospoznaja"],
  "key_quotes": [
    {"speaker_local": "SPEAKER_00", "speaker_hint": "Petra Pinjuh", "quote": "...", "ts": 1247.5}
  ],
  "speakers_identified": [
    {"local_tag": "SPEAKER_00", "name_hint": "Petra Pinjuh", "confidence": "high"},
    {"local_tag": "SPEAKER_01", "name_hint": "Domagoj Dalbello", "confidence": "medium"}
  ]
}
```

**Ključno za downstream:** `speakers_identified[].name_hint` je **Geminijev guess**, ne kanonska
istina. Downstream entity resolution treba ovo tretirati kao **kandidat ime**, ne kao deterministički
mapping.

---

## 5. `*.article.json` — shema (v1.0)

Generira `generate_article_gemini.js`. Long-form journalistic članak razbijen u sekcije.

```json
{
  "version": 1,
  "generated_at": "2026-05-11T14:23:45Z",
  "model": "gemini-2.5-flash",
  "source": { /* isti kao summary */ },
  "title_hr": "...",
  "lead_paragraph": "...",
  "sections": [
    {
      "iteration_number": 1,
      "start_ts": 0,
      "end_ts": 1024.5,
      "heading": "...",
      "body_markdown": "...",
      "key_speakers": ["Petra Pinjuh", "Domagoj Dalbello"],
      "screenshots_suggested": [{"ts": 567.0, "caption": "..."}]
    }
  ],
  "all_speakers": ["Petra Pinjuh", "Domagoj Dalbello"]
}
```

`all_speakers` je **flat lista imena koje je Gemini izvukao**, opet — **kandidatska, ne kanonska**.

---

## 6. SRT konvencije (`*.canary.diarized.srt`, `*.sortformer.diarized.srt`)

Standard SRT format s dodatkom: **prvi redak teksta uvijek počinje s `[SPEAKER_XX]`** gdje je
`XX` zero-padded 2-digit broj (`SPEAKER_00`, `SPEAKER_01`, ..., `SPEAKER_99`).

```
1
00:00:02,150 --> 00:00:05,820
[SPEAKER_00] Dobrodošli u novi podcast Cuspajz.

2
00:00:05,820 --> 00:00:08,440
[SPEAKER_00] Danas razgovaramo s Petrom Pinjuh.

3
00:00:08,440 --> 00:00:12,100
[SPEAKER_01] Hvala na pozivu.
```

Pravila:
- Timestamp format: `HH:MM:SS,mmm` (zarez kao decimal separator, ISO 8601 SubRip)
- Indeksi: 1-based, sequential
- Speaker tag uvijek na početku TEKSTA, ne u indeksu ili timestamp liniji
- Jedna sekvenca = jedan kontinuirani govor jednog speakera
- Tagovi su **episode-local** (`SPEAKER_00` u epizodi A nema veze sa `SPEAKER_00` u epizodi B)

---

## 7. `*.{source}.diarized.embeddings.{model_key}.json` — multi-model speaker embeddings (v1.1)

**Status:** Implementacija u `colab_speaker_embeddings/extract_speaker_embeddings.py`. Output
nije obavezan dio pipelinea, ali ga downstream domovina-rag importer očekuje za speaker entity
resolution (vidi `docs/rag_clickhouse_postgres_plan.md` §15).

### Filename pattern

```
{basename}.wav.{source}.diarized.embeddings.{model_key}.json
```

- `{source}` ∈ {`canary`, `sortformer`}
- `{model_key}` ∈ {`titanet`, `pyannote_wespeaker34`, ...} — proširivo, novi modeli se dodaju
  bez breakanja postojećih outputa
- **Multi-model paralelizam:** ista epizoda može imati više `.embeddings.{model}.json` fajlova,
  jedan po modelu, idempotentno per-model. Downstream koristi ih za ensemble retrieval (RRF).

Primjer za jednu epizodu (oba modela):
```
20260411_..._yt_v5i.wav.canary.diarized.srt
20260411_..._yt_v5i.wav.canary.diarized.embeddings.titanet.json              # NVIDIA TitaNet
20260411_..._yt_v5i.wav.canary.diarized.embeddings.pyannote_wespeaker34.json # pyannote baseline
```

### Format

```json
{
  "version": 2,
  "generated_at": "2026-05-12T14:23:45Z",
  "model_key": "titanet",
  "model_id": "nvidia/speakerverification_en_titanet_large",
  "embedding_dim": 192,
  "source_diarization": "canary",
  "embeddings": {
    "SPEAKER_00": {
      "vector": [0.0234, -0.1567, ..., 0.0892],
      "total_speech_sec": 642.3,
      "num_segments": 87,
      "confidence": 0.94
    },
    "SPEAKER_01": { /* ... */ }
  }
}
```

### Polja

| Polje | Tip | Opis |
|---|---|---|
| `version` | integer | Schema version (currently 2) |
| `model_key` | string | Kratki identifikator modela (`titanet`, `pyannote_wespeaker34`, ...) |
| `model_id` | string | Puni HF/registry ID modela |
| `embedding_dim` | integer | Dimenzionalnost vektora (varira: 192 za TitaNet, 256 za WeSpeaker R34) |
| `source_diarization` | string | `canary` ili `sortformer` (koji dijarizacijski izlaz je input) |
| `embeddings.<tag>.vector` | array float | **L2-normaliziran** embedding → cosine sim = dot product |
| `embeddings.<tag>.total_speech_sec` | float | Ukupne sekunde govora za ovog speakera u epizodi |
| `embeddings.<tag>.num_segments` | integer | Broj usable segmenata koji su ušli u prosjek |
| `embeddings.<tag>.confidence` | float | Confidence ovog embedinga (raste s brojem segmenata, max 1.0 kod 50+) |

### Tko ovo proizvodi

- **Going-forward** (nove epizode): `run_pipeline.sh --with-speaker-embeddings` poziva
  `extract_speaker_embeddings.py` za svaki konfigurirani model
- **Backfill** (postojeće epizode): `colab_speaker_embeddings/domovina_tv_speaker_embeddings.ipynb`
  na Colab G4

### Stari format (v1, NE koristi se)

Ranija specifikacija ovog dokumenta predlagala je jedan `.embeddings.json` per episode bez model
tag-a. Zamijenjena s v2 multi-model formatom prije nego što je itko proizveo v1 datoteke. Nema
migracije.

---

## 8. R2 CDN URL struktura (`https://cdn.domovina.ai`)

Generira `upload_to_r2.js` (korak 12 pipelinea). Public, content-addressable.

```
https://cdn.domovina.ai/data/{youtube_id}/diarized.srt
https://cdn.domovina.ai/data/{youtube_id}/outline.json
https://cdn.domovina.ai/data/{youtube_id}/article.json
https://cdn.domovina.ai/data/{youtube_id}/summary.json
```

**Note:** R2 namespace **NE koristi basename**, samo `youtube_id` kao ključ — kraći URL-ovi,
deterministički cache key. Downstream koji želi koristiti CDN kao izvor mora moći mapirati
`youtube_id → basename` (npr. preko fetch.domovina.tv `state.json` datoteka u svakom kanalu).

---

## 9. Channel state datoteke (`automatic/podcasts/{channel}-state.json`)

Generira `fetch.js`. Tri-tier state za svaki kanal:

```json
{
  "completed": ["VIDEO_ID_1", "VIDEO_ID_2", ...],
  "failed": ["VIDEO_ID_X"],
  "private": ["VIDEO_ID_Y"],
  "archived": ["VIDEO_ID_Z"]
}
```

- `completed[]` — uspješno preuzeto, **skip on rerun**
- `failed[]` — greška, **retry on next run**
- `private[]` — video unavailable/private, **never retry** (trajno)
- `archived[]` — ručno arhivirano, **pipeline preskače**

Downstream consumeri trebaju gledati samo `completed[]` + `archived[]` (= cijeli korpus do trenutka).

---

## 10. Channel list format (`automatic/podcasts/{channel}-lista.txt`)

Pipe-delimited, line-based, comments allowed:

```
# Comment
YYYYMMDD|Naslov epizode|https://youtu.be/VIDEO_ID
NA|Bez datuma|https://www.youtube.com/watch?v=VIDEO_ID
```

Parsiranje: vidi `extractDataFromLine()` (duplicirano u nekoliko skripti).

---

## 11. Verzioniranje

Semantic versioning ovog kontrakta:

- **major** (`v1.0` → `v2.0`): breaking — npr. promjena imena postojećeg polja, uklanjanje polja,
  promjena tipa, promjena semantike
- **minor** (`v1.0` → `v1.1`): aditivno — novo polje, novi tip datoteke
- **patch** (`v1.0` → `v1.0.1`): dokumentacijska ispravka, ne dira shape

Sve promjene idu u `docs/data_contract_CHANGELOG.md` (TODO: kreirati pri prvoj minor promjeni).

**Trenutna pravila kompatibilnosti:**
- Downstream consumer testira **postojanje + tip** polja (defensivno parsiranje)
- Nove opcionalne polja ne smiju breakati postojeće consumere
- Brisanje polja = major bump

---

## 12. Što ovaj contract NE garantira

Da bude jasno što nije pokriveno:

- **Točnost imena speakera** u `speaker_hints` / `speakers_identified[].name_hint` / `all_speakers`.
  To je Geminijev guess i može biti pogrešno (vidi §15 u `rag_clickhouse_postgres_plan.md` za
  downstream entity resolution).
- **Stabilnost SPEAKER_XX → ista osoba** kroz epizode. Episode-local samo.
- **Idempotentnost re-generacije `*.article.json`** ako se model promijeni — različiti modeli/datumi
  rade različite članke. Filename uključuje datum + model za disambiguaciju.
- **Točnost `summary_long` / `body_markdown`** — to su Geminijevi outputi koji mogu sadržavati
  halucinacije (ublažene system promptom ali ne eliminirane).

---

## 13. Referenca implementacijskih skripti (data producer)

| Output file pattern | Producirana od |
|---|---|
| `*.info.json`, `*.mp3` | `fetch.js` |
| `*.wav` | `convert_to_wav.js` |
| `*.wav.canary.srt`, `*.wav.canary.csv` | `colab_canary/transcribe_canary.py` (na Colab G4) |
| `*.wav.canary.diarized.srt` | `colab_diarize/diarize_canary.py` (lokalno na M4 Pro) |
| `*.wav.sortformer.*.srt` | `colab_sortformer/transcribe_sortformer.py` (eksperimentalno) |
| `*.canary.summary.json/md` | `summarize_gemini.js` |
| `*.outline.json`, `*.article.json` | `generate_article_gemini.js` |
| `*.rag*.jsonl` | `prepare_rag.js`, `prepare_rag_import.js`, `prepare_rag_combined.js` |
| `*.canary.summary.blocked.json` | `summarize_gemini.js` (marker za Gemini block) |
| R2 CDN | `upload_to_r2.js` |

---

**Kraj kontrakta.** Svako pitanje o ovom dokumentu otvori kao issue u ovom repu;
breaking promjene kao PR s bumpom verzije i CHANGELOG zapisom.
