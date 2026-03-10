# Canary 1B v2 — Transkripcija na Google Colab Pro (G4 GPU)

NVIDIA Canary 1B v2 model za batch transkripciju hrvatskih podcast WAV datoteka na Google Colab Pro.

**Jupyter Notebook:** [domovina_tv_fetch.ipynb na Google Colab](https://colab.research.google.com/drive/1Fjs75qxPDlEObUS5GO-yU8xBBsoKfada#scrollTo=ADxKfSt8EgMj)

## Arhitektura

```
Lokalni disk (DOMOVINA1TB)          Google Drive              Google Colab (G4 GPU)
┌──────────────────────┐     rclone copy     ┌─────────────┐    mount    ┌──────────────────┐
│ fetch_domovina_tv_   │ ──────────────────> │ canary_wav/ │ ────────> │ transcribe_      │
│ output/              │   --include *.wav   │   kanal1/   │           │ canary.py        │
│   kanal1/*.wav       │                     │   kanal2/   │           │                  │
│   kanal2/*.wav       │ <────────────────── │   ...       │ ────────> │ .canary.srt/csv  │
│   ...                │   --include         │             │           │ pored WAV fajla  │
│                      │   *.canary.*        │             │           │                  │
└──────────────────────┘                     └─────────────┘           └──────────────────┘
```

## GPU benchmark (testirano 2026-03-10)

| GPU | VRAM | units/h | prosjek/fajl | units/fajl | OOM? |
|-----|------|---------|-------------|------------|------|
| T4 | 16 GB | 1.67 | - | - | **DA** (16GB < 19GB model) |
| L4 | 24 GB | 1.71 | ~60s | ~0.029 | **DA** (>150MB fajlovi) |
| A100 80GB | 80 GB | 7.52 | ~70s | 0.146 | NE |
| **G4 (RTX PRO 6000 Blackwell)** | **96 GB** | **8.71** | **~13s (BF16)** | **0.031** | **NE** |

**G4 je optimalan** — najbrzi i najjeftiniji po fajlu zahvaljujuci Blackwell arhitekturi (2.5 GHz clock) i BF16 optimizaciji.

### BF16 optimizacija

Model se loada u `bfloat16` umjesto `float32` + `torch.inference_mode()`:
- **FP32**: ~24s/fajl prosjek
- **BF16**: ~13s/fajl prosjek (2x brze)
- Kvaliteta transkripata je identicna

### Projekcija za 2335 WAV datoteka (~245 GB)

```
2335 fajlova x 13s = ~8.4h
8.4h x 8.71 units/h = ~73 units (od 100 units/mjesec na Colab Pro)
```

## Workflow

### 1. Upload WAV-ova na Google Drive (lokalno, rclone)

```bash
# Upload samo WAV datoteka (bez macOS ._* metadataa)
rclone copy /Volumes/DOMOVINA1TB/fetch_domovina_tv_output \
  google_drive_ms:domovina_fetch_data/canary_wav \
  --filter "- ._*" --filter "+ *.wav" --filter "- *" \
  --drive-shared-with-me \
  --transfers 8 --progress
```

- Uploadira samo nove fajlove (diff po imenu + velicini)
- Sigurno za prekidanje (Ctrl+C) i ponovno pokretanje
- `rclone copy` nikad ne brise fajlove na destinaciji

### 2. Transkripcija na Google Colab (G4 GPU)

Otvori [domovina_tv_fetch.ipynb](https://colab.research.google.com/drive/1Fjs75qxPDlEObUS5GO-yU8xBBsoKfada#scrollTo=ADxKfSt8EgMj) i pokreni cellove:

```python
# Cell 0 - kloniraj repo (samo prvi put ili nakon runtime restarta)
!git clone https://github.com/domovinatv/fetch.domovina.tv.git /content/fetch.domovina.tv

# Cell 1 - mount Drive
from google.colab import drive
drive.mount('/content/drive')

# Cell 2 - pull najnoviji kod
!cd /content/fetch.domovina.tv && git pull

# Cell 3 - pokreni transkripciju
!python /content/fetch.domovina.tv/colab_canary/transcribe_canary.py \
  --input-dir "/content/drive/MyDrive/domovina_fetch_data/canary_wav"
```

- Runtime: **G4 GPU** (Runtime > Change runtime type > G4 GPU)
- Skripta preskace WAV-ove koji vec imaju `.canary.srt` pored sebe
- Sigurno za restart — samo ponovo pokreni istu naredbu
- Lista fajlova se loada jednom na pocetku; novi fajlovi uploadani za vrijeme runa se uhvate pri sljedecem pokretanju

### 3. Download transkripata lokalno (rclone)

```bash
# Preuzmi samo .canary.srt i .canary.csv s Drive-a
rclone copy google_drive_ms:domovina_fetch_data/canary_wav \
  /Volumes/DOMOVINA1TB/fetch_domovina_tv_output \
  --filter "- ._*" --filter "+ *.canary.*" --filter "- *" \
  --drive-shared-with-me \
  --transfers 4 --progress
```

### Cijeli pipeline je idempotent

1. `rclone copy lokalno -> Drive` — uploadira samo nove WAV-ove
2. `transcribe_canary.py na Colabu` — preskace WAV-ove s postojecim .canary.srt
3. `rclone copy Drive -> lokalno` — preuzima samo nove .canary.* fajlove

Svaki korak se moze ponavljati neograniceno bez duplikacija ili gubitka podataka.

## CLI opcije

```
python transcribe_canary.py --help

Opcije:
  --input-dir DIR       Direktorij s WAV datotekama (rekurzivno pretrazuje poddirektorije)
  --output-dir DIR      Direktorij za output (default: isti kao input-dir)
  --source-lang LANG    Izvorni jezik ISO kod (default: hr)
  --target-lang LANG    Ciljni jezik ISO kod (default: hr)
  --file PATH           Transkribira samo jednu WAV datoteku
  --limit N             Ogranici broj datoteka za obradu (korisno za testiranje)
  --dry-run             Samo prikaz, bez transkripcije
```

## Output format

Za svaku `xyz.wav` generira se:
- `xyz.wav.canary.srt` — SRT titlovi s timestampovima
- `xyz.wav.canary.csv` — CSV sa stupcima: Start (HH:MM:SS), End (HH:MM:SS), Segment

**Nikada ne brise ili prepisuje postojece datoteke.**

## rclone konfiguracija

```bash
# Instalacija
brew install rclone

# Konfiguracija Google Drive remote-a
rclone config
# Ime: google_drive_ms
# Tip: Google Drive
# OAuth: vlastiti GCP OAuth client (besplatno, bez API troskova)

# Omoguci pristup shared folderima trajno
rclone config update google_drive_ms drive-shared-with-me true
```

Google Drive storage se trosi na accountu koji je **Owner** foldera, ne na accountu koji uploada.
