# Prompt 03: NVIDIA Canary ASR Alignment & Parliamentary Protocol Parser

## 📌 Uloga za Claude Code (Opus 5)
Implementiraj modul `sabor_pipeline/03_transcribe_and_align.js` (uz prateći protocol parser) koji:
1. Povezuje i poravnava NVIDIA Canary 1B v2 transkript (`.canary.srt`) s vremenskim segmentima iz `diarization.json`.
2. Primjenjuje **Post-ASR rječničku normalizaciju** za specifičnu saborsku terminologiju.
3. Koristi **Parliamentary Protocol Parser** nad službenim registrom zastupnika 11. saziva Hrvatskoga sabora (`data/rosters/sabor_mps_11_saziv.json`) za determinističko mapiranje anonimnih `SPEAKER_XX` oznaka u stvarna imena zastupnika i klubova.

---

## ⛔ Tvrda pravila repozitorija (`CLAUDE.md`)
* **ASR model:** Isključivo **NVIDIA Canary 1B v2** (iz `colab_canary/` ili `modal_canary/`), **NIKAD Whisper**.
* **Bez prompt mehanizma u ASR-u:** Canary nema `initial_prompt` mehanizam. Usmjeravanje rječnika i terminologije rješava se **isključivo POST-ASR korekcijom** u ovoj fazi.
* **Nema izmišljanja imena zastupnika:** Svi zastupnici, stranke i dužnosnici moraju potjecati iz provjerenog službenog registra sa `sabor.hr`.

---

## 🎯 Specifikacija implementacije

### 1. Ulazni podaci
* `storage/output/sabor/{session_id}/session_manifest.json` (Faza 01)
* `storage/output/sabor/{session_id}/diarization.json` (Faza 02)
* Transkripti generirani preko Canary 1B v2:
  * `storage/output/sabor/{session_id}/transcripts/part_{NN}.canary.srt` (ili jedan spojeni `.canary.srt`)
* Službeni registar zastupnika:
  * `sabor_pipeline/data/rosters/sabor_mps_11_saziv.json` (s poljima: `id`, `ime`, `prezime`, `puno_ime`, `klub`, `stranka`, `spol`, `duznost`)

---

### 2. Post-ASR rječnička korekcija (Dictionary Normalization)
Implementiraj determinističku zamjenu i fonetsko poravnanje za česte ASR fonetske distorzije u saborskim raspravama:
* **Institucije i zakoni:** `DORH`, `USKOK`, `HZJZ`, `Državni inspektorat`, `Zakon o gospodarenju otpadom`, `Poslovnik Hrvatskoga sabora`.
* **Kemijski spojevi i toponimi:** `PFAS`, `perfluorirane tvari`, `PPK Velebit`, `Bilajska`, `Štikada`, `Gračac`, `Gospić`, `Ličko-senjska županija`.
* **Tvrtke i akteri:** `Tipos Resurs`, `Geotehnički fakultet`.

---

### 3. Parliamentary Protocol Parser (`sabor_pipeline/utils/protocol_parser.js`)

Saborske sjednice vode se prema strogim pravilima Poslovnika. Predsjedatelj (predsjednik ili potpredsjednici Sabora) formalno izgovara najavu govornika prije svakog istupa.

Parser mora prepoznavati sljedeće govorne obrasce:

```javascript
// 1. Pojedinačna rasprava i klubovi
const REGEX_RASPRAVA = /(?:riječ ima|sljedeći je na redu|izvolite)\s+(?:uvaženi|poštovani)?\s*(?:zastupnik|kolega|zastupnica|kolegica)?\s+([A-ZČĆŽŠĐ][a-zčćžšđ]+(?:\s+[A-ZČĆŽŠĐ][a-zčćžšđ]+)+)/iu;

// 2. Klub zastupnika
const REGEX_KLUB = /(?:u ime kluba|klub zastupnika)\s+([A-ZČĆŽŠĐa-zčćžšđ0-9\s-]+)\s+(?:riječ ima|govorit će)\s+([A-ZČĆŽŠĐ][a-zčćžšđ]+(?:\s+[A-ZČĆŽŠĐ][a-zčćžšđ]+)+)/iu;

// 3. Replike i odgovori na repliku
const REGEX_REPLIKA = /(?:replika|prva replika|odgovor na repliku)(?: je)?,?\s*(?:zastupnik|kolega|zastupnica|kolegica)?\s+([A-ZČĆŽŠĐ][a-zčćžšđ]+(?:\s+[A-ZČĆŽŠĐ][a-zčćžšđ]+)+)/iu;

// 4. Povrede poslovnika
const REGEX_POVREDA = /(?:povreda poslovnika|zbog povrede poslovnika),?\s*(?:izvolite)?\s+([A-ZČĆŽŠĐ][a-zčćžšđ]+(?:\s+[A-ZČĆŽŠĐ][a-zčćžšđ]+)+)/iu;
```

---

### 4. Algoritam hibridnog pridruživanja (Speaker Resolution)

1. **Identifikacija Predsjedatelja:** Govornik koji ima najveći broj kratkih segmenata u kojima se pojavljuju proceduralne fraze (*„Hvala lijepa”*, *„Prelazimo na...”*, *„Riječ ima...”*) označava se kao `role: "predsjedatelj"`.
2. **Sidrenje govornika (Anchor Matching):**
   * Kada Predsjedatelj u segmentu $S_i$ izgovori: *„Riječ ima uvaženi zastupnik Ante Deur”*:
   * Sustav parsira ime, radi fuzzy-match protiv `sabor_mps_11_saziv.json`.
   * Prvi sljedeći govorni segment $S_{i+1}$ (gdje je `speaker !== predsedatelj`) dobiva trajno mapiranje:
     $$\text{global\_speaker\_id} \to \text{Ante Deur (HDZ)}$$
3. **Konzistentnost:** Svi ostali segmenti u svih 20 sati koji dijele isti `global_speaker_id` automatski poprimaju to ime i stranku.

---

## 📦 Izlazni artefakt: `aligned_transcript.json`
Spremi u: `storage/output/sabor/{session_id}/aligned_transcript.json`
```json
{
  "session_id": "sabor_11_izvanredna_11_gospic",
  "total_blocks": 384,
  "blocks": [
    {
      "block_id": 42,
      "part": 1,
      "start_global_sec": 1820.400,
      "end_global_sec": 1826.100,
      "speaker_id": "SPEAKER_001",
      "speaker_name": "Gordan Jandroković",
      "role": "predsjedatelj",
      "party": "HDZ",
      "speech_type": "prozivka",
      "text": "Prelazimo na pojedinačnu raspravu. Riječ ima uvaženi zastupnik Zvonimir Troskot, izvolite.",
      "youtube": {
        "part": 1,
        "video_id": "NKT3niyWwaY",
        "timestamp_sec": 1820,
        "url": "https://www.youtube.com/watch?v=NKT3niyWwaY&t=1820s"
      }
    },
    {
      "block_id": 43,
      "part": 1,
      "start_global_sec": 1827.000,
      "end_global_sec": 2125.800,
      "speaker_id": "SPEAKER_007",
      "speaker_name": "Zvonimir Troskot",
      "role": "zastupnik",
      "party": "Most",
      "speech_type": "pojedinacna_rasprava",
      "text": "Hvala lijepa poštovani predsjedniče Sabora. Kolegice i kolege, ono što se dogodilo u Gospiću...",
      "youtube": {
        "part": 1,
        "video_id": "NKT3niyWwaY",
        "timestamp_sec": 1827,
        "url": "https://www.youtube.com/watch?v=NKT3niyWwaY&t=1827s"
      }
    }
  ]
}
```
