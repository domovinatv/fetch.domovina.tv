# Prompt 03: Speech-to-Text (ASR) & Parliamentary Protocol Parser

## 📌 Uloga za Claude Code (Opus 5)
Implementiraj modul `sabor_pipeline/03_transcribe_and_align.js` (ili `.py`) koji koristi postojeći Whisper.cpp/Canary sustav iz `fetch.domovina.tv` za transkripciju, poravnava tekst s diarizacijom i primjenjuje NLP pravila saborskog protokola kako bi automatski zamijenio apstraktne govornike (`SPEAKER_001`, `SPEAKER_002`) stvarnim imenima i strankama saborskih zastupnika.

---

## 🎯 Zahtjevi i specifikacija

### 1. Transkripcija prilagođena Saboru (Whisper / Canary)
* Koristi Whisper.cpp (Metal/Apple Silicon akceleracija) ili NeMo Canary.
* **Initial Prompt za Whisper:**
  * Postavi saborski kontekst:  
    *„Hrvatski sabor, predsjednik Sabora, poslovnik, replika, uvaženi zastupnik, klub zastupnika, Gospić, Ličko-senjska županija, PPK Velebit, Bilajska, Tipos Resurs, PFAS spojevi, Andrija Mikulić, USKOK, Državni inspektorat, Zoran Milanović, Marija Vučković, Irena Hrstić...”*
* Izlaz: Vremenski označene rečenice/riječi (SRT/JSON format).

### 2. Poravnanje (Word-level Alignment sa `diarization.json`)
* Za svaku transkribiranu rečenicu pronađi odgovarajući `speaker_id` na temelju vremenskog preklapanja s `diarization.json`.
* Spoji uzastopne rečenice istog govornika u koherentne govorne blokove.

### 3. Parser saborskog protokola (The Protocol Superpower)
U saborskim sjednicama predsjedatelj (Gordan Jandroković, Željko Reiner, Furio Radin...) uvijek formalno proziva govornike.

Implementiraj parser (`sabor_pipeline/utils/protocol_parser.js`) koji prepoznaje:
1. **Pojedinačne rasprave:**
   * `/(?:riječ ima|sljedeći je na redu|izvolite)\s+(?:uvaženi|poštovani)?\s*(?:zastupnik|kolega|zastupnica|kolegica)?\s+([A-ZČĆŽŠĐ][a-zčćžšđ]+(?:\s+[A-ZČĆŽŠĐ][a-zčćžšđ]+)+)/iu`
2. **Govore u ime kluba:**
   * `/(?:u ime kluba|klub zastupnika)\s+([A-ZČĆŽŠĐa-zčćžšđ0-9\s-]+)\s+(?:riječ ima|govorit će)\s+([A-ZČĆŽŠĐ][a-zčćžšđ]+(?:\s+[A-ZČĆŽŠĐ][a-zčćžšđ]+)+)/iu`
3. **Replike & odgovore na repliku:**
   * `/(?:replika|prva replika|odgovor na repliku)(?: je)?,?\s*(?:zastupnik|kolega)?\s+([A-ZČĆŽŠĐ][a-zčćžšđ]+(?:\s+[A-ZČĆŽŠĐ][a-zčćžšđ]+)+)/iu`
4. **Povrede poslovnika:**
   * `/(?:povreda poslovnika|zbog povrede poslovnika),?\s*(?:izvolite)?\s+([A-ZČĆŽŠĐ][a-zčćžšđ]+(?:\s+[A-ZČĆŽŠĐ][a-zčćžšđ]+)+)/iu`

### 4. Fuzzy Matching s bazom 151 zastupnika (`data/mps_11_saziv.json`)
* Kreiraj bazu zastupnika 11. saziva Hrvatskog sabora (ime, prezime, stranka, klub, uloga).
* Koristi fuzzy matching (prag sličnosti > 85%) za otklanjanje grešaka u transkripciji ili padežima (npr. *„Troskotu”* -> *„Zvonimir Troskot”*).
* **Automatsko mapiranje:** Kad predsjedatelj prozove osobu $X$, a neposredno nakon toga počne govoriti `SPEAKER_K`, cijeli klaster `SPEAKER_K` u sesiji dobiva identitet $X$.

---

## 📦 Izlazni artefakt: `aligned_transcript.json`
Spremi u: `storage/output/sabor/{session_id}/aligned_transcript.json`
```json
{
  "session_id": "sabor_11_izvanredna_11_gospic",
  "blocks": [
    {
      "block_id": 104,
      "start_sec": 1420.5,
      "end_sec": 1426.8,
      "speaker_id": "SPEAKER_001",
      "speaker_name": "Gordan Jandroković",
      "role": "predsjedatelj",
      "party": "HDZ",
      "speech_type": "prozivka",
      "text": "Prelazimo na replike. Prva replika je uvažena zastupnica Dalija Orešković, izvolite."
    },
    {
      "block_id": 105,
      "start_sec": 1427.5,
      "end_sec": 1547.0,
      "speaker_id": "SPEAKER_008",
      "speaker_name": "Dalija Orešković",
      "role": "zastupnica",
      "party": "DOSIP",
      "speech_type": "replika",
      "text": "Zahvaljujem predsjedniče. Kolega Deur, govorite o procedurama dok se u Gospiću ljudi truju..."
    }
  ]
}
```
