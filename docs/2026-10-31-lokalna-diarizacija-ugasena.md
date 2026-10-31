# Lokalna diarizacija trajno ugašena; Soniox/pyannoteAI biraju najstarije prvo (31.10.2026.)

Commit `f782a27c`. Kod KORAKA 6 (lokalni pyannote) ostaje u sourceu — **ne brisati**.

## Zašto

- **Nightly 30.10.:** KORAK 6 blokiran guardom od 12 GB (na disku 6,9 GB), a epizoda
  `RqO3I2RiUT4` ispala je iz Soniox capa 5 (`SONIOX_MAX_FILES`), pa nije imala nijedan put
  do diariziranog prijepisa. KORAK 2.6 (Modal upload) je usput visio 5 h 20 min (`Timeout` u
  transportu), što nije popravljeno.
- **Nightly 31.10.:** isto stanje za `RqO3I2RiUT4` + `e1tuwQJIVek`. Obje su ručno provučene
  kroz Soniox (~$0,28) + pyannoteAI + promociju 2.8 + Opus članak + CDN.
- Lokalni pyannote tjera swap i disk na Macu, a pyannoteAI (2.7c) daje govornike u oblaku.

## Što je promijenjeno

| Mjesto | Prije | Sad |
|---|---|---|
| `--with-local-canary-diarize` (`run_pipeline.sh`, `run_pipeline_video.sh`) | pali KORAK 6 | dodjela zakomentirana, ispiše „ignoriran”; nightly flag i dalje šalje |
| `transcribe_soniox.js`, `diarize_pyannote_ai.js` | prvih N po redu skeniranja | **najstarije prvo** (mtime), pa epizoda pred izlaskom iz prozora ne ispada |
| isti | brojali i epizode s kanonskim `.wav.canary.diarized.srt` | takve se preskaču (osim `--video-id`), inače prozor svježine nosi stari katalog |
| `SONIOX_/PYANNOTE_AI_/GEMINI_REFINE_FRESH_DAYS` | 3 | 14 |
| `..._MAX_FILES` | 5 | 8 |

Bez lokalne diarizacije epizoda koja ispadne iz Soniox/pyannoteAI prozora **nema drugog
puta**, zato su prozor i cap povećani, a redoslijed okrenut.

## Otvoreno

- KORAK 2.6: Modal upload bez vremenskog limita može visjeti satima.
- `audit_pipeline.js` 31.10.: `book.epub` drift iste veličine za `PXh-YeG9qak`, `c2vZO7dHBTE`,
  `Pgfd0KKPXFg` — nije istraženo (prvo provjeriti smjer drifta).
- Ponavljajući neuspjeh screenshota `0qt-wHxiFMY` na 00:26:50.
- Disk: swap tjera Docker VM (14 GB + 24 GB komprimirano); host RAG embedder se od
  31.10. sam gasi (vidi `../domovina-rag/docs/2026-10-31-sync-rc1-embedder-agy-imenovanje.md`).

## Vezano

- `docs/2026-10-24-pipeline-trenutno-stanje.md`
- `docs/2026-10-25-asr-prioritet-soniox.md`
