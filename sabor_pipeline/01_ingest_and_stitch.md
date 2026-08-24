# Prompt 01: Ingestion, Multi-Stream Audio Stitching & Time Mapping

## 📌 Uloga za Claude Code (Opus 5)
Implementiraj skriptu `sabor_pipeline/01_ingest.js` (ili `.py`) koja se integrira s postojećim sustavom pohrane i alatima u `fetch.domovina.tv`. Skripta preuzima više povezanih YouTube videa jedne saborske sjednice, priprema audio zapise, spaja ih u jedan kontinuirani audio stream i kreira `session_manifest.json` s tablicom vremenskih pomaka.

---

## 🎯 Zahtjevi i specifikacija

### 1. Ulazna konfiguracija sjednice (`sabor_pipeline/data/sessions/sabor_11_izvanredna_11.json`)
```json
{
  "session_id": "sabor_11_izvanredna_11_gospic",
  "title": "11. izvanredna sjednica Hrvatskoga sabora — Otpad u Gospiću",
  "date": "2026-08-20",
  "channel": "InternetTVHrvatskogasabora",
  "videos": [
    { "part": 1, "url": "https://www.youtube.com/watch?v=NKT3niyWwaY", "label": "Dio 1 - Otvaranje i uvod" },
    { "part": 2, "url": "https://www.youtube.com/watch?v=xrZ4FHQSZec", "label": "Dio 2 - Rasprava popodne" },
    { "part": 3, "url": "https://www.youtube.com/watch?v=i-wvlWqLcJ0", "label": "Dio 3 - Noćni maraton" },
    { "part": 4, "url": "https://www.youtube.com/watch?v=Pmg2XI-qnWo", "label": "Dio 4 - Završetak i glasanje" }
  ]
}
```

### 2. Koraci implementacije
1. **Dohvat audija (`yt-dlp`):**
   * Koristi provjerene `yt-dlp` postavke iz `fetch.js` (uključujući Brave cookies po potrebi za zaobilaženje bot zaštite).
   * Preuzmi m4a/opus/best audio u radnu mapu: `storage/output/sabor/sabor_11_izvanredna_11_gospic/raw/part_01.m4a`, `part_02.m4a`...
2. **Konverzija i mjerenje trajanja (`ffmpeg` & `ffprobe`):**
   * Koristi logiku iz `convert_to_wav.js` za konverziju u 16kHz mono 16-bit PCM WAV (`part_01_16k.wav`).
   * Zabilježi točno trajanje u sekundama (`duration_sec`) za svaki dio preko `ffprobe`.
3. **Lossless spajanje (Concatenation):**
   * Preko `ffmpeg concat demuxer` spoji sve dijelove u `full_session_16k.wav`.
4. **Generiranje `session_manifest.json` (Time Offset Table):**
   * Za svaki dio izračunaj:
     * `offset_global_sec`: zbroj trajanja svih prethodnih dijelova.
     * `start_global_sec` i `end_global_sec`.
   * Kreiraj i eksportiraj helper funkciju:
     ```javascript
     function globalToYoutube(manifest, globalSec) {
       // Pronalazi part i vraća { part, yt_id, yt_sec, url }
     }
     ```

---

## 🧮 Matematički model mapiranja
Za bilo koji globalni timestamp $t_{\text{global}}$ u spojenom audiju:
Pronalazimo dio $k$ gdje vrijedi: $\text{offset}_k \le t_{\text{global}} < \text{offset}_k + \text{duration}_k$
$$t_{\text{yt}} = \lfloor t_{\text{global}} - \text{offset}_k \rfloor$$
$$\text{Deep link} = \text{https://www.youtube.com/watch?v=} + \text{yt\_id}_k + \text{\&t=} + t_{\text{yt}} + \text{s}$$

---

## 📦 Izlazni artefakti:
* `storage/output/sabor/{session_id}/audio/full_session_16k.wav`
* `storage/output/sabor/{session_id}/session_manifest.json`
* `sabor_pipeline/utils/time_mapper.js` (s unit testovima)
