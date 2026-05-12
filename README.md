# Domovina.tv Audio Pipeline

*Ažurirano: 12. svibnja 2026.*

> **Downstream consumer:** Pretragu i AI agent backend nad ovim podacima implementira sibling repo
> **[domovinatv/domovina-rag](https://github.com/domovinatv/domovina-rag)** —
> ClickHouse + PostgreSQL + MCP server za Claude Desktop / Claude.ai / ChatGPT klijente.
>
> Format ulaznih datoteka koje proizvodi ovaj repo definiran je u
> [`docs/data_contract.md`](./docs/data_contract.md). Arhitekturni plan downstream consumer-a u
> [`docs/rag_clickhouse_postgres_plan.md`](./docs/rag_clickhouse_postgres_plan.md).

## 🚀 Arhitektura Sustava

Glavna skripta za orkestraciju cijelog procesa je `run_pipeline.sh`. Proces se sastoji od 12 koraka:

0. **Sync diariziranih transkripata (`rclone`)**
   - Preuzima `.canary.diarized.srt` s Google Drivea (remote: `google_drive_ms:domovina_fetch_data/canary_wav`).
   - Canary diarizacija se odvija na Cloud GPU-u (Colab T4); rezultati se syncaju ovdje.

1. **Osvježavanje Podcasta (`automatic/refresh_podcasts.sh`)**
   - Skenira definirane YouTube kanale i traži nove videozapise (`yt-dlp --flat-playlist --break-on-existing`).
   - Ažurira tekstualne liste u `automatic/podcasts/*.txt` (format: `YYYYMMDD|Naziv|URL`).

2. **Preuzimanje Audio Zapisa (`fetch.js`)**
   - Skida audio zapise koristeći `yt-dlp` (360p video + visokokvalitetni audio).
   - Koristi Brave cookies za anti-bot zaštitu. Three-tier state: `completed[]`, `failed[]`, `private[]`.

3. **Konverzija u WAV (`convert_to_wav.js`)**
   - Konvertira MP3 → WAV (16kHz, mono, 16-bit PCM) potreban za ASR modele.

4. **Generiranje Whisper Promptova (`generate_whisper_prompt.js`)**
   - Komunicira s lokalnim LLM-om (LM Studio `localhost:1234`, `qwen2.5-7b-instruct`) za ekstrakciju ključnih riječi.
   - Poboljšava prepoznavanje specifičnih pojmova u Whisperu.

5. **Whisper Transkripcija (`transcribe.js`)**
   - Koristi `whisper.cpp` s Metal GPU akceleracijom za generiranje `.wav.srt` titlova.

6. **Whisper Diarizacija Govornika (`transcribe_diarized.js`)**
   - Koristi HuggingFace `pyannote/speaker-diarization-3.1` na MPS/Metal za `.diarized.srt`.

7. **Canary Diarizacija (`diarize_canary.py`)**
   - Cloud pyannote diarizacija na Colab T4 GPU; lokalno samo orkestrira.
   - Rezultat: `.canary.diarized.srt` (sinkronizira se via rclone u koraku 0).

8. **Gemini Sumarizacija (`summarize_gemini.js`)**
   - Generira sažetak pomoću `gemini-2.5-flash` (Vertex AI OAuth).
   - Output: `.canary.summary.json`. Blokirani sadržaj → `.canary.summary.blocked.json`.

9. **Gemini Generiranje Članaka (`generate_article_gemini.js`)**
   - **Faza 1**: Dijeli transkript u logične tematske blokove po ~35-45 min → `.outline.json`.
   - **Faza 2**: Piše dublji novinarski tekst za svaki blok → `.article.json`.
   - Multi-region Vertex AI rotacija (9 regija) za zaobilaženje 429 rate limita.

10. **RAG Priprema (`prepare_rag_combined.js` + `prepare_rag_import.js` + `prepare_rag.js`)**
    - Chunking transkripata za semantičko pretraživanje.
    - Output: `.rag_combined.jsonl` (preporučena strategija), `.rag_import.jsonl`, `.rag_chunks.jsonl`.

11. **YouTube Screenshotovi (`screenshot_youtube.js`)** *(opcionalno, `--with-screenshots`)*
    - Izvlači frameove iz videa na vremenskim oznakama iz članaka.

12. **Vertex AI RAG Import (`import_to_vertex.js`)**
    - Uploadira `.rag_combined.jsonl` u Vertex AI Agent Builder (Discovery Engine).

13. **Cloudflare R2 Upload (`upload_to_r2.js`)** *(opcionalno, `--with-r2-upload`)*
    - Uploadira finalne datoteke (SRT, JSON, screenshotovi, video) na `cdn.domovina.ai`.
    - MKV→MP4 remux (ffmpeg, copy stream) prije uploada za Flutter app kompatibilnost.

---

## 💾 Storage Arhitektura (Multi-Disk)

Pipeline koristi `storage/output/` kao logički direktorij sa symlinkovima prema fizičkim diskovima:

```
storage/output/domovina_tv  →  /Volumes/DOMOVINA1TB/fetch_domovina_tv_output/domovina_tv
storage/output/lood_podcast →  /Volumes/DOMOVINA2TB/fetch_domovina_tv_output/lood_podcast
```

Konfigurira se u `storage.conf` (kopirati iz `storage.conf.example`):

```bash
DEFAULT=/Volumes/DOMOVINA1TB/fetch_domovina_tv_output
# Veliki kanali na drugi disk:
lood_podcast=/Volumes/DOMOVINA2TB/fetch_domovina_tv_output/lood_podcast
```

```bash
# Inicijalna konfiguracija:
cp storage.conf.example storage.conf
# Uredi storage.conf
./setup_storage.sh

# Premještanje kanala na drugi disk (rsync + verify + ažurira storage.conf):
./move_to_disk.sh lood_podcast /Volumes/DOMOVINA2TB/fetch_domovina_tv_output
./move_to_disk.sh --dry-run lood_podcast /Volumes/DOMOVINA2TB/fetch_domovina_tv_output

# Pregled disk usage po kanalu:
node count_progress.js
```

---

## 🛠️ Preduvjeti

- **Mac s Apple Silicon (M1/M2/M3/M4)** — Metal/MPS akceleracija za diarizaciju i Whisper.
- **Montiran vanjski disk** — konfiguriraj u `storage.conf` (default: `/Volumes/DOMOVINA1TB/fetch_domovina_tv_output`).
- **Node.js** + `npm install` (ovisnosti iz `package.json`).
- **Python 3** s `pyannote.audio`, `torch` (MPS podrška).
- **HuggingFace Token** — za preuzimanje `pyannote/speaker-diarization-3.1`.
- **Google Cloud / Vertex AI** — `gcloud auth login` + projekt u `gemini.conf`. Koristi OAuth token, ne API key.
- **LM Studio** na `localhost:1234` s `qwen2.5-7b-instruct` — za korak 4 (Whisper promptovi).
- **whisper.cpp** binary i `ggml-large-v3-turbo` model — za korak 5.
- **rclone** s konfiguriranim Google Drive remoteom (`google_drive_ms`) — za korak 0 i 2.5.
- **ffmpeg** — za WAV konverziju i MKV→MP4 remux.
- **yt-dlp** s Brave cookies (`--cookies-from-browser brave`).
- **Cloudflare R2 credentials** u `.env` — za korak 13 (`--with-r2-upload`).

---

## 💻 Pokretanje

```bash
# Puni pipeline
./run_pipeline.sh --hf-token TVOJ_TOKEN

# Samo sumarizacija i članci (preskoči download, WAV, transkripciju)
./run_pipeline.sh --only-articles
./run_pipeline.sh --only-summaries

# Samo jedan kanal
./run_pipeline.sh --channel domovina_tv --hf-token TVOJ_TOKEN

# Dry run (bez API poziva i pisanja datoteka)
./run_pipeline.sh --hf-token TVOJ_TOKEN --dry-run

# S opcionalni koracima
./run_pipeline.sh --only-articles --with-screenshots
./run_pipeline.sh --only-articles --with-r2-upload

# Više CPU niti za Whisper
./run_pipeline.sh --hf-token TVOJ_TOKEN --threads 8
```

---

## 🗃️ Struktura Repozitorija

| Putanja | Opis |
|---------|------|
| `automatic/podcasts/*.txt` | Liste URL-ova YouTube kanala (format: `YYYYMMDD\|Naziv\|URL`) |
| `automatic/refresh_podcasts.sh` | Ažuriranje listi novih videozapisa |
| `storage/output/` | Logički output dir (symlinks → fizički diskovi) |
| `storage.conf` | Mapiranje kanala → fizički diskovi |
| `colab_diarize/` | Canary diarizacija za Cloud GPU (Google Colab/Kaggle T4) |
| `colab_canary/` | Canary transkripcija skripte |
| `*.js` / `*.py` / `*.mjs` | Pipeline skripte (svaka je standalone, bez shared modula) |

### Dijagnostika

```bash
# Progress svih kanala + disk usage
node count_progress.js

# Detekcija anomalija i koruptiranih datoteka
node inspect_pipeline.js --input-dir storage/output
```
