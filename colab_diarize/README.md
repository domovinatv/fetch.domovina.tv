# Pyannote Community-1 Diarizacija — Google Colab GPU

Speaker diarization za WAV datoteke koje već imaju Canary transkripte (`.canary.srt`).

Koristi [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) model (v4.0, CC-BY-4.0 licenca) s **exclusive speaker diarization** modom — jedan govornik u svakom trenutku, bez overlapa, idealno za SRT alignment.

**Jupyter Notebook:** domovina_tv_diarize.ipynb (otvori na Google Colab)

## Arhitektura

```
Google Drive                          Google Colab (GPU)
┌─────────────────────────┐           ┌──────────────────────────────┐
│ canary_wav/             │   mount   │ diarize_canary.py            │
│   kanal1/               │ ────────> │                              │
│     ep001.wav           │           │ 1. Nađi WAV + .canary.srt   │
│     ep001.wav.canary.srt│           │ 2. pyannote diarizacija      │
│     ep001.wav.canary.csv│           │ 3. Spoji govornike + SRT     │
│                         │ <──────── │ 4. Spremi .canary.diarized.srt│
│     ep001.wav.canary.   │           │                              │
│       diarized.srt  NEW │           │                              │
└─────────────────────────┘           └──────────────────────────────┘
```

## Preduvjeti

1. **Canary transkripti** — WAV datoteke moraju imati `.canary.srt` (generirane s `transcribe_canary.py`)
2. **HuggingFace token** — potreban za pyannote model
   - Kreiraj na: https://huggingface.co/settings/tokens
   - Prihvati uvjete na: https://huggingface.co/pyannote/speaker-diarization-community-1
3. **Google Colab** s GPU runtime-om (T4 je dovoljan — community-1 koristi ~9.5 GB VRAM peak)

## Workflow

### 1. Upload WAV datoteka na Google Drive (rclone)

Prije pokretanja diarizacije u oblaku, potrebno je prebaciti WAV datoteke (i pripadajuće `.canary.srt` ako postoje) s lokalnog diska na Google Drive.

```bash
rclone copy /Volumes/DOMOVINA1TB/fetch_domovina_tv_output/ \
  google_drive_ms:domovina_fetch_data/canary_wav \
  --filter "- ._*" --filter "+ *.wav" --filter "- *" \
  --drive-shared-with-me --progress
```

### 2. HuggingFace token u Colab Secrets

U Google Colabu:
1. Klikni ikonu ključa (Secrets) u lijevom panelu
2. Dodaj novi secret: `HF_TOKEN` = tvoj HuggingFace token
3. Uključi "Notebook access"

### 3. Diarizacija na Google Colab

Otvori `domovina_tv_diarize.ipynb` na Colabu i pokreni cellove:

```python
# Cell 0 - kloniraj repo
!git clone https://github.com/domovinatv/fetch.domovina.tv.git /content/fetch.domovina.tv

# Cell 1 - mount Drive
from google.colab import drive
drive.mount('/content/drive')

# Cell 2 - pull najnoviji kod
!cd /content/fetch.domovina.tv && git pull

# Cell 3 - pokreni diarizaciju
!python /content/fetch.domovina.tv/colab_diarize/diarize_canary.py \
  --input-dir "/content/drive/MyDrive/domovina_fetch_data/canary_wav"
```

### 4. Download diariziranih transkripata lokalno (rclone)

Nakon što Google Colab (ili GCP VM, npr. G4 grafičke kartice) izvođenjem Python skripti obradi datoteke i stvori diarizirane `.canary.diarized.srt` datoteke, vraćamo ih nazad u lokalni path koristeći rclone:

```bash
rclone copy google_drive_ms:domovina_fetch_data/canary_wav \
  /Volumes/DOMOVINA1TB/fetch_domovina_tv_output \
  --filter "- ._*" --filter "+ **.canary.**" --filter "- *" \
  --drive-shared-with-me \
  --transfers 4 --progress
```

## CLI opcije

```
python diarize_canary.py --help

Opcije:
  --input-dir DIR       Direktorij s WAV i .canary.srt datotekama (rekurzivno)
  --hf-token TOKEN      HuggingFace token (ili koristi Colab Secrets / env HF_TOKEN)
  --file PATH           Diarizi samo jednu WAV datoteku
  --limit N             Ograniči broj datoteka za obradu
  --min-speakers N      Minimalan broj govornika
  --max-speakers N      Maksimalan broj govornika
  --dry-run             Samo prikaz, bez diarizacije
```

## Output format

Za svaku `xyz.wav` koja ima `xyz.wav.canary.srt`, generira se:
- `xyz.wav.canary.diarized.srt` — SRT titlovi s oznakama govornika

Primjer outputa:
```
1
00:00:00,000 --> 00:00:05,120
[SPEAKER_00] Dobrodošli u emisiju, danas razgovaramo o...

2
00:00:05,120 --> 00:00:10,450
[SPEAKER_01] Hvala na poziv, drago mi je biti ovdje.
```

## Model: pyannote community-1 vs 3.1

| Benchmark | 3.1 (legacy) | community-1 |
|-----------|-------------|-------------|
| AISHELL-4 | 12.2% DER | 11.7% DER |
| AliMeeting | 24.5% | 20.3% |
| AMI (IHM) | 18.8% | 17.0% |
| AMI (SDM) | 22.7% | 19.9% |
| VoxConverse | 11.2% | 11.2% |

Community-1 je bolji na svakom benchmarku + ima `exclusive_speaker_diarization` mode.

## GPU zahtjevi

Community-1 koristi ~9.5 GB VRAM peak (više od 3.1 koji koristi ~2.6 GB):
- **T4 (16 GB)** — dovoljan (~6 GB headroom)
- **L4 (24 GB)** — komforno
- **G4 (96 GB)** — overkill za diarizaciju, ali radi ako već imaš runtime

## Pipeline je idempotent

1. `transcribe_canary.py` — generira `.canary.srt` (preskače postojeće)
2. `diarize_canary.py` — generira `.canary.diarized.srt` (preskače postojeće)
3. `rclone copy Drive -> lokalno` — preuzima samo nove `.canary.*` datoteke

Svaki korak se može ponavljati neograničeno bez duplikacija.
