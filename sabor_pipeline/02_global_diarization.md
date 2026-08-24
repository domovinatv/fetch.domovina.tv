# Prompt 02: Global Long-Audio Diarization & Speaker Clustering

## 📌 Uloga za Claude Code (Opus 5)
Implementiraj skriptu `sabor_pipeline/02_diarize.py` koja nadograđuje postojeće PyAnnote / NeMo skripte iz `fetch.domovina.tv` (`diarize_canary.py`, `transcribe_diarized.js`) kako bi mogla obraditi audio zapis od 18+ sati na lokalnom Mac Mini M4 Pro bez OOM (Out-of-Memory) rušenja i uz očuvanje globalnog identiteta govornika.

---

## 🎯 Zahtjevi i specifikacija

### 1. Izazov dugotrajnog audio zapisa (18 sati)
Ako se PyAnnote pokrene direktno na 18-satnom WAV-u u jednom komadu, potrošnja RAM-a/VRAM-a eskalira i proces biva ubijen.
Rješenje je **Chunked Processing + Global Embedding Agglomerative Clustering**:

### 2. Algoritam i koraci
1. **Windowing / Chunking:**
   * Podijeli `full_session_16k.wav` u vremenske blokove od po 30 minuta s preklapanjem od 30 sekundi (`overlap_sec = 30`).
2. **Lokalna VAD & Segmentacija (PyAnnote / MPS):**
   * Za svaki 30-minutni prozor detektiraj govorne segmente (start, end).
3. **Ekstrakcija Speaker Embeddinga (Vektora glasa):**
   * Za svaki govor > 1.5 sekundi izvuci embedding vektor (npr. pomoću `pyannote/embedding` ili WeSpeaker/Titanet modela).
   * Svaki segment $i$ u chunku dobiva: `[t_start_global, t_end_global, embedding_vector]`.
4. **Globalno hijerarhijsko klasteriranje (AgglomerativeClustering):**
   * Nakon obrade svih 36 chunkova (18 sati), prikupi sve embeddinge u jednu matricu.
   * Pokreni `AgglomerativeClustering(metric='cosine', linkage='average', distance_threshold=0.68)`.
   * Svaki segment dobiva globalnu oznaku: `SPEAKER_001`, `SPEAKER_002`, ...
5. **Spajanje i čišćenje (Smoothing):**
   * Izgladi prijelaze na granicama chunkova (preklapanja).
   * Spoji segmente istog govornika ako je pauza kraća od 0.7 sekundi.

---

## 📦 Izlazni artefakt: `diarization.json`
Spremi u: `storage/output/sabor/{session_id}/diarization.json`
```json
{
  "session_id": "sabor_11_izvanredna_11_gospic",
  "total_duration_sec": 64800,
  "total_speakers_detected": 46,
  "segments": [
    { "start": 12.3, "end": 45.8, "speaker": "SPEAKER_001" },
    { "start": 46.5, "end": 180.2, "speaker": "SPEAKER_002" }
  ]
}
```
