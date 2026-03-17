# Domovina.tv Audio Pipeline

*Ažurirano: 17. ožujka 2026.*

## 🚀 Arhitektura Sustava

Glavna skripta za orkestraciju cijelog procesa je `run_pipeline.sh`. Proces se sastoji od 8 logičkih koraka:

1. **Osvježavanje Podcasta (`automatic/refresh_podcasts.sh`)**
   - Skenira definirane YouTube kanale i traži nove videozapise.
   - Ažurira tekstualne liste s novim URL-ovima i preskače već obrađene zapise automatski sortirajući.
2. **Preuzimanje Audio Zapisa (`fetch.js`)**
   - Skida audio zapise koristeći `yt-dlp`.
   - Koristi specifične argumente (ograničenje na 360p video, kvalitetan audio) te čuva kolačiće iz preglednika (anti-bot mjere).
3. **Konverzija u WAV (`convert_to_wav.js`)**
   - Konvertira preuzete datoteke u standardni WAV format potreban za prepoznavanje govora (16kHz, mono, 16-bit PCM).
4. **Generiranje Promptova (`generate_whisper_prompt.js`)**
   - Komunicira s lokalnim LLM-om (putem izloženog API-ja iz LM Studia na `localhost:1234`) kako bi izvukao ključne riječi za Whisper prompt, uvelike poboljšavajući prepoznavanje specifičnih termina u tom trenutku.
5. **Whisper Transkripcija (`transcribe.js` / `transcribe_nvidia_canary.mjs`)**
   - Koristi modele i sustave kao `whisper.cpp` ili nVidia Canary za generiranje osnovne tekstualne transkripcije u ispravnom formatu.
6. **Diarizacija Govornika (`transcribe_diarized.js` / `diarize.py` / `diarize_canary.py`)**
   - Koristi HuggingFace `pyannote/speaker-diarization-3.1` model za prepoznavanje tko govori i kada (Speaker Diarization).
   - Sustav automatski koristi MPS (Metal GPU na Macu) ubrzanje ako je dostupno, s tolerancijom do par stotina govornika.
   - Rezultat je datoteka s ukomponiranim oznakama govornika.
7. **Sumarizacija (`summarize_gemini.js`)**
   - Opcionalan korak koji generira brzi sažetak pomoću Gemini API-ja.
8. **Generiranje Članaka (`generate_article_gemini.js`)**
   - Dvofazna inteligentna skripta koja rabi Google Gemini modele (`gemini-3.1-pro-preview` ili `gemini-3-flash-preview`).
   - **Faza 1**: Analizira cijeli transkript i dijeli ga u logične tematske blokove od po otprilike 35-45 minuta (generira pametni JSON nacrt/outline baziran na točnoj rezoluciji svake teme i promjene teme).
   - **Faza 2**: Iterativno čita nacrt, za svaki blok piše dublji novinarski tekst u stručnom trećem licu i identificira te pridaje prava imena sudionika/govornika.

---

## 🛠️ Preduvjeti

Za ispravno funkcioniranje pipeline-a potrebno je ispunjenje osnovnih tehnoloških uvjeta:
- **Mac s Apple Silicon (M1/M2/M3/M4)** arhitekturom preporučeno zbog MPS/Metal akceleracije.
- Montiran vanjski/eksterni radni disk (default: `/Volumes/DOMOVINA1TB/fetch_domovina_tv_output`).
- Instaliran **Node.js** i zadovoljeni njegovi uvjeti iz `package.json` zapisa (`npm install`).
- Instaliran **Python 3** s paketima za AI rad, primarno `pyannote.audio` i `torch` podrška.
- Aktivan **HuggingFace Token** (za preuzimanje modernih i zaštićenih Pyannote modela).
- Aktivan **Gemini API Key** (Sredstvo verifikacije za AI pozive pametnog generiranja finalnih tekstova).
- Opcionalno za dodatan AI input: **LM Studio** ili sl. servis pokrenut na lokalnom hostu `localhost:1234` s pokrenutim LLM-om (za precizne Whisper promptove).
- Zasebno postavljeni, dostupni alati putanja u konzoli na os sustavu, konkretno: `yt-dlp` za YouTube, kao i popularni `rclone` (Google Drive remote mapirana sinhronizacija).

## 💻 Pokretanje Radnog Sustava (Pipeline)

Pokretanje cjelokupnog procesa i serijska sinkronizacija svih etapa obavlja se putem glavne .sh skripte smještene na baznoj/root grani sustava:

```bash
./run_pipeline.sh --hf-token TVOJ_HF_TOKEN --gemini-key TVOJ_GEMINI_KEY
```

**Dodatni korisni argumenti pri inicijaciji:**
- `--dry-run`: Siguran način pretraživanja - samo ispisuje što bi se uistinu dogodilo (posebno korisno u Canary ili Gemini skriptama), ali program nema moć trajne prepiske fajlova i generiranja greški prema API poslužiteljima.
- `--channel <ime_kanala>`: Filtrira rednu izvedbu tako da pretražuje samo striktan određeni kanal na temelju podudaranja ulazne mape i zadatih parametara u polju automatic osvježivača.
- `--threads <broj>`: Određuje dodijeljen broj CPU operacijskih niti za izvođenje obuhvatne i lokalne Whisper transkripcije.
- `--only-articles`: Potpuno preskače sve ulazne korake preuzimanja s web okruženja, kao i sve faze rudimentarne transkripcije, te odmah pokreće Fazu 8 (tzv. "Gemini članci") na oslanjanju isključivo na pre-stojećim i kompletno stvorenim datotekama na spojenom storage mediju.

### 🗃️ Struktura i Organizacija Skladišta Koda
* `automatic/podcasts/` - Ciljne organizacijske mape i radna polja s postepenim i stalno ažuriranim tekstualnim format listama URL-ova videozapisa i podcasta snimljenih na kanalu za preuzimanje.
* `automatic/refresh_podcasts.sh` - Srž automatizma sustava: skripta za ažuriranje i usporedbu listi s YouTube izvorima.
* `*.js` / `*.py` / `*.mjs` - Mikro-skripte koje služe obavljanju točno određenog logičkog tehnološkog koraka u masivnom cjevovodu podataka na sustavu.
* `colab_canary/` / `colab_diarize/` - Udaljeno prilagođene skripte i metode programirane suštinski za prenašanje i udaljeno robusno izvođenje obrade podataka na snažnim strojevima i resursima oblačnih infrastruktura (primjerice Google Colab ili Kaggle platforme koje sadrže T4 i moćnije grafičke GPU procesne farme).
