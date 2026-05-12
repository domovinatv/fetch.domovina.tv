# Speaker Embedding Extraction

Ekstrahira **per-speaker voice embeddings** iz već dijariziranih WAV-ova koristeći **više modela
paralelno** (ensemble). Output: `*.{source}.diarized.embeddings.{model_key}.json` pored
postojećih SRT-ova — jedan fajl po modelu.

### Trenutno podržani modeli

| `--model` ključ | Model ID | Arhitektura | Embedding dim | Dependency |
|---|---|---|---|---|
| `titanet` (default) | `nvidia/speakerverification_en_titanet_large` | Conformer hybrid (NeMo) | 192 | `nemo_toolkit[asr]` |
| `pyannote_wespeaker34` | `pyannote/wespeaker-voxceleb-resnet34-LM` | ResNet34 (pyannote) | 256 | `pyannote.audio` (već instalirano za diarizaciju) |

**Zašto više modela?** Različite arhitekture imaju različite *failure modes*. Downstream
domovina-rag importer kombinira rezultate kroz **Reciprocal Rank Fusion (RRF)** — boostaš
kandidate koji su top kod oba modela, detektaš disagreement kao signal za review queue. Vidi
[`../docs/rag_clickhouse_postgres_plan.md` §15.5](../docs/rag_clickhouse_postgres_plan.md#155-pipeline-modifikacija--embedding-extraction).

Embeddings su input za **speaker entity resolution** u domovina-rag repu — globalno
povezivanje istih osoba kroz različite podcast epizode (vidi
[`docs/rag_clickhouse_postgres_plan.md` §15](../docs/rag_clickhouse_postgres_plan.md#15-speaker-entity-resolution--globalni-identitet-osoba)).

## Output format

```json
{
  "version": 1,
  "generated_at": "2026-05-12T14:23:45Z",
  "model": "nvidia/speakerverification_en_titanet_large",
  "embedding_dim": 192,
  "source_diarization": "canary",
  "embeddings": {
    "SPEAKER_00": {
      "vector": [0.0234, -0.1567, ..., 0.0892],   // 192 floats, L2-normalized
      "total_speech_sec": 642.3,
      "num_segments": 87,
      "confidence": 0.94
    },
    "SPEAKER_01": { /* ... */ }
  }
}
```

Vektori su **L2-normalizirani** pa cosine similarity = dot product. Confidence raste s brojem
segmenata (max 1.0 kod 50+ segmenata, manje za speakere koji govore malo).

Speakeri s **<3s ukupnog govora** se preskaču (premalo signala za pouzdan embedding).

## Dva načina pokretanja

### A) Backfill svih starih epizoda — Colab G4

Najbrži put za one-time backfill 2 559+ epizoda. Otvori `domovina_tv_speaker_embeddings.ipynb` u
Google Colab Pro+:

1. Mount Drive
2. Pip install NeMo (~2-3 min)
3. Wget workhorse script iz Github main brancha
4. Smoke test na 3 epizode
5. Full run s `--max-runtime-hours 11` (cleano izlazi prije Colab 12h limita)

**Trajanje:** ~3-5h za 2 559 epizoda na G4. **Trošak:** ~$0.50-1.00 u Pro+ compute units.

**GPU zahtjevi:**
| GPU | Status |
|---|---|
| G4 (RTX PRO 6000 Blackwell, 95 GB VRAM) | ✅ Optimalno — Pro+ |
| L4 (24 GB VRAM) | ✅ Radi |
| T4 (16 GB VRAM) | ✅ Radi (TitaNet je mali, ~150 MB) |
| CPU | ⚠️ Radi ali ~10× sporiji |

### B) Inkrementalno za nove epizode — Mac Mini (run_pipeline.sh)

Forward-only za novopridošle epizode. Integrirano u glavnu pipeline kao **KORAK 6.5** nakon
Canary diarizacije, vrti **sve konfigurirane modele paralelno**.

Aktiviraj s flagom:
```bash
./run_pipeline.sh --hf-token TOKEN --with-speaker-embeddings
```

Default modeli: `titanet pyannote_wespeaker34`. Override-aj env varom:
```bash
SPEAKER_EMBEDDING_MODELS="titanet" ./run_pipeline.sh ... --with-speaker-embeddings
```

Trošak: ~30-60s po epizodi po modelu na M4 Pro MPS. Za default 2 modela ~60-120s per epizoda.

**Python deps:** instaliraj jednokratno:
```bash
pip3 install 'nemo_toolkit[asr]==2.0.0' soundfile librosa
# pyannote.audio bi već trebao biti instaliran ako vrtiš lokalnu diarizaciju
```

Ako neki model nije dostupan (dep missing), skripta ga preskoči s warningom i nastavi s ostalima.

## CLI argumenti (`extract_speaker_embeddings.py`)

| Flag | Default | Opis |
|---|---|---|
| `--input-dir` | (required) | Root direktorij s WAV + diarized SRT |
| `--model` | `titanet` | `titanet` ili `pyannote_wespeaker34`. Pokreni više puta s različitim modelom za ensemble. |
| `--source` | `canary` | Koji output: `canary` ili `sortformer` |
| `--channel` | (svi) | Filter po stringu u path-u (npr. `lood_podcast`) |
| `--limit` | (svi) | Maks. epizoda (za smoke test) |
| `--dry-run` | off | Pregled jobova bez izvršavanja |
| `--max-runtime-hours` | (∞) | Wall-clock budget; čist izlazak |

## Idempotentnost

Skripta uvijek skipa datoteke s postojećim `.embeddings.json`. Bezopasno je:
- Restartati prekinut Colab session
- Pokrenuti više puta uzastopno
- Vrti se paralelno na Colabu i Mac Mini-ju (rclone sync ih posloži)

## Verifikacija nakon backfill-a

```bash
# Koliko je obrađeno
find storage/output -name '*.canary.diarized.embeddings.json' | wc -l

# Inspektiraj jednu
jq '.embeddings | keys, length' \\
   storage/output/lood_podcast/*_yt_*.canary.diarized.embeddings.json | head -10
```

## Veza s ostatkom pipeline-a

```
                        run_pipeline.sh
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
        Korak 6           Korak 6.5         Korak 9+
       Canary             Speaker            RAG prep
       diarize            embeddings         (chunking)
            │                 │                 │
            ▼                 ▼                 ▼
   *.canary.        *.canary.diarized.    *.rag_combined.jsonl
   diarized.srt     embeddings.json       (samo SRT, embedinge konzumira
                                           import u domovina-rag-u)
```

Speaker embeddings **NE ulaze u RAG chunkove** direktno — koristi ih downstream
[domovina-rag import](../docs/rag_clickhouse_postgres_plan.md#15-speaker-entity-resolution--globalni-identitet-osoba)
za globalnu speaker identity rezoluciju (PostgreSQL `speakers` tablica + pgvector).

## Reference

- TitaNet model card: https://huggingface.co/nvidia/speakerverification_en_titanet_large
- NeMo speaker recognition docs: https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/asr/speaker_recognition/intro.html
- Data contract format: [`../docs/data_contract.md`](../docs/data_contract.md#7-reserved-canarydiarizedembeddingsjson-v11-planning)
- Entity resolution plan: [`../docs/rag_clickhouse_postgres_plan.md` §15](../docs/rag_clickhouse_postgres_plan.md#15-speaker-entity-resolution--globalni-identitet-osoba)
