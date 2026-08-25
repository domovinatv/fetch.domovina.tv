# Prompt 02: Global Long-Audio Diarization & Cross-Stream Speaker Clustering

> ## ⚠️ ISPRAVLJENO 2026-08-25 — pročitaj prije nego što slijediš ovaj dokument
>
> Ovo je **izvorna specifikacija**. Zadržana je kao zapis, ali je mjerenjima
> ispravljena u **četiri** točke. Mjerodavan je
> `docs/pipeline_memorija_i_propusnost_2026-08.md` §6.8, a implementacija je
> `02_diarize.py` + `02b_merge_speakers.py`.
>
> | Ovdje piše | Stvarno vrijedi | Zašto |
> |---|---|---|
> | diariziraj **po dijelu** (5,7–6,2 h) | reži na **~2 h komade**, preklapanje 60–120 s, rezovi u tišini | 6 h ≈ 24 000 embeddinga → `pdist` 2,3 GB + `reconstruct` 8,6 GB × 2 poziva. Tijesno. Na 2 h je `pdist` 250 MB. (§6.8 t.1) |
> | korak 2: **drugi prolaz** s `pyannote/embedding` | **ne treba** — `DiarizeOutput.speaker_embeddings` već vraća centroide poravnate s `labels()` | Isti WeSpeaker model kojim je pyannote i klasterirao, pa se skale pragova poklapaju. (§6.4) |
> | prag **0,68** | prag se **MJERI** (`tools/calibrate_threshold.py`), očekivano 0,3–0,5 | Objavljeni pragovi vrijede za pojedinačne 10-sekundne embeddinge; centroidi su sredine preko minuta i znatno čišći. (§6.6–§6.7) |
> | `sklearn.AgglomerativeClustering` bez ograničenja | average/cosine **uz cannot-link** | Dva centroida iz istog komada su po konstrukciji različite osobe; bez toga ih AHC zna slijepiti. (§6.8 t.4) |
>
> Također: „monolitna diarizacija" iz odjeljka niže nije samo rizična nego
> **fizički ne prolazi** na ovom stroju — pokušaj je prekinut nakon 146 min, a
> analiza pokazuje dva neovisna zida (§6.1). Ne pokušavati ponovno.

## 📌 Uloga za Claude Code (Opus 5)
Implementiraj skriptu `sabor_pipeline/02_diarize.py` (i/ili `.mjs` wrapper) koja provodi diarizaciju višesatne saborske sjednice (za pilot sjednicu: **72.074 sekundi = 20 h 01 min 14 s**, izvor: `session_manifest.json` izmjeren u Fazi 01).

Skripta se mora strogo pridržavati pravila repozitorija `fetch.domovina.tv` iz `CLAUDE.md`:
* **Lokalno izvođenje:** Diarizacija se izvodi **isključivo LOKALNO na Mac Mini M4 Pro** (CPU/MPS), NIKAD na Colabu.
* **Model:** `pyannote/speaker-diarization-community-1` (v4.0, licenca CC-BY-4.0) uz `pyannote/embedding` (ili `speechbrain/spkrec-ecapa-voxceleb`).

---

## 🎯 Tehnički problem i arhitektura rješenja

### Problem monolitne diarizacije za 20+ sati
Ako se `pyannote` cjevovod pokrene nad cijelim 2.3 GB 16kHz WAV-om (`full_session_16k.wav`) odjednom, memorijski otisak raste nekontrolirano (izračun distance matrice za stotine tisuća audio okvira na CPU-u) i proces biva terminiran (OOM / memory pressure).

### Preporučena 2-stupanjska arhitektura (Part-level Diarization + Global Centroid Clustering)

Zbog toga što Faza 01 već ima pripremljene pojedinačne dijelove (`part_01_16k.wav` do `part_04_16k.wav`) i globalni spojeni WAV, najstabilniji i najbrži pristup je:

```
[Part 1 WAV (~5.7h)] → PyAnnote lokalno → Lokalni klasteri (P1_SPK_01..N) + Embedding Centroidi
[Part 2 WAV (~6.1h)] → PyAnnote lokalno → Lokalni klasteri (P2_SPK_01..N) + Embedding Centroidi
[Part 3 WAV (~6.2h)] → PyAnnote lokalno → Lokalni klasteri (P3_SPK_01..N) + Embedding Centroidi
[Part 4 WAV (~1.9h)] → PyAnnote lokalno → Lokalni klasteri (P4_SPK_01..N) + Embedding Centroidi
                                    │
                                    ▼
       Globalno hijerarhijsko spajanje centroida (Agglomerative Clustering / Cosine)
                                    │
                                    ▼
     Mapiranje u jedinstvene globalne oznake: SPEAKER_001, SPEAKER_002, ...
                                    │
                                    ▼
         storage/output/sabor/{session_id}/diarization.json
```

---

## 📋 Koraci implementacije (`02_diarize.py`)

### 1. Inkrementalna diarizacija po dijelovima (Part-level)
* Učitaj `session_manifest.json` koji generira `01_ingest.js`.
* Za svaki `part_{NN}_16k.wav`:
  * Provjeri postoji li već parcijalni `part_{NN}.diarization.json` (idempotentnost).
  * Pokreni PyAnnote diarization pipeline (`exclusive_speaker_diarization` način rada, bez preklapanja govornika unutar segmenta, po uzoru na `colab_diarize/diarize_canary.py`).
  * Izvuci vremenske segmente za taj dio: `[{ start_local, end_local, local_speaker }]`.

### 2. Ekstrakcija Speaker Embeddinga (Glasovnih otisaka)
* Za svaki lokalni govornik `P{k}_SPK_{x}` izvuci reprezentativne audio isječke (minimalno 2.0 s čistog govora).
* Pomoću `pyannote/embedding` izračunaj prosječni embedding vektor (centroid) za svakog lokalnog govornika u tom dijelu.

### 3. Globalno spajanje govornika (Cross-Part Clustering)
* Pretvori lokalne vremenske oznake u globalne sekunde pomoću `offset_global_sec` iz manifesta:
  $$t_{\text{global}} = t_{\text{local}} + \text{offset}_k$$
* Izgradi matricu kosinusne udaljenosti (`scipy.spatial.distance.cdist(centroids, metric='cosine')`).
* Pokreni `sklearn.cluster.AgglomerativeClustering(metric='cosine', linkage='average', distance_threshold=THRESHOLD)`:
  * *Napomena za prag:* Početna preporučena vrijednost je `0.68`. Označi u kodu kao parametar s CLI opcijom `--distance-threshold`.
  * *Verifikacijska naredba:* `python sabor_pipeline/02_diarize.py --session sabor_11_izvanredna_11_gospic --dry-run`

### 4. Post-processing & Čišćenje
* Spoji susjedne segmente istog globalnog govornika ako je razmak manji od 0.7 sekundi.
* Odbaci segmente kraće od 0.3 sekunde kao šum/kašalj/udarac mikrofona.

---

## 📦 Izlazni format: `diarization.json`
Spremi u: `storage/output/sabor/{session_id}/diarization.json`
```json
{
  "session_id": "sabor_11_izvanredna_11_gospic",
  "total_duration_sec": 72074.0,
  "total_speakers_detected": 42,
  "generated_at": "2026-08-24T22:00:00.000Z",
  "segments": [
    {
      "segment_id": 1,
      "part": 1,
      "start_global_sec": 14.500,
      "end_global_sec": 48.200,
      "start_local_sec": 14.500,
      "end_local_sec": 48.200,
      "speaker": "SPEAKER_001",
      "duration_sec": 33.700
    },
    {
      "segment_id": 2,
      "part": 1,
      "start_global_sec": 49.000,
      "end_global_sec": 182.100,
      "start_local_sec": 49.000,
      "end_local_sec": 182.100,
      "speaker": "SPEAKER_002",
      "duration_sec": 133.100
    }
  ]
}
```
