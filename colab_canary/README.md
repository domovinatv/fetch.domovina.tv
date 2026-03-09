# 🐤 Canary 1B v2 — Transkripcija na Colab/Kaggle

Pokreni NVIDIA Canary 1B v2 model **direktno na besplatnom GPU** — bez HuggingFace Space GPU kvote.

| Platforma | GPU | Sesija | Cijena |
|-----------|-----|--------|--------|
| **Google Colab** | T4 (15 GB) | ~12h | Besplatno |
| **Kaggle** | P100/T4 (16 GB) | ~9h (30h/tjedan) | Besplatno |

## Što ovo radi

Za svaku `.wav` datoteku generira:
- `*.wav.canary.srt` — titlovi s timestampovima
- `*.wav.canary.csv` — segmenti u CSV formatu

**Nikada ne briše ili prepisuje postojeće datoteke.**

---

## 🚀 Google Colab

### 1. Upload WAV datoteka na Google Drive

Kopiraj WAV datoteke u folder na Google Drive, npr. `My Drive/wav_files/`.

### 2. Otvori novi Colab notebook

Idi na [colab.research.google.com](https://colab.research.google.com) → New notebook.

**Obavezno odaberi GPU runtime**: Runtime → Change runtime type → **T4 GPU**

### 3. Pokreni u ćelijama

**Ćelija 1 — Mount Drive i upload skripte:**
```python
from google.colab import drive
drive.mount('/content/drive')

# Upload transcribe_canary.py ili ga kopiraj s Drive-a
```

**Ćelija 2 — Instaliraj NeMo:**
```python
!pip install -U 'nemo_toolkit[asr]'
```

**Ćelija 3 — Pokreni transkripciju:**
```python
# Dry run (pregled bez transkripcije)
!python transcribe_canary.py --input-dir /content/drive/MyDrive/wav_files --dry-run

# Prava transkripcija
!python transcribe_canary.py --input-dir /content/drive/MyDrive/wav_files
```

Rezultati (`.canary.srt` i `.canary.csv`) se spremaju u isti folder na Drive.

---

## 🟦 Kaggle

### 1. Upload WAV datoteka kao Dataset

Na [kaggle.com](https://www.kaggle.com) → Datasets → New Dataset → Upload WAV datoteke.

### 2. Kreiraj Notebook s GPU

New Notebook → Settings → **Accelerator: GPU T4 x2** (ili P100).

### 3. Pokreni

**Ćelija 1 — Instaliraj NeMo:**
```python
!pip install -U 'nemo_toolkit[asr]'
```

**Ćelija 2 — Upload skripte i pokreni:**
```python
# Dry run
!python transcribe_canary.py --input-dir /kaggle/input/my-dataset --output-dir /kaggle/working --dry-run

# Prava transkripcija
!python transcribe_canary.py --input-dir /kaggle/input/my-dataset --output-dir /kaggle/working
```

> ⚠️ Na Kaggle-u input direktorij (`/kaggle/input/`) je **read-only**, pa moraš koristiti `--output-dir /kaggle/working` za outpute.

### 4. Download rezultata

Rezultati su u `/kaggle/working/` — preuzmi ih iz Output taba.

---

## CLI opcije

```
python transcribe_canary.py --help

Opcije:
  --input-dir DIR       Direktorij s WAV datotekama (obavezno)
  --output-dir DIR      Direktorij za output (default: isti kao input-dir)
  --source-lang LANG    Izvorni jezik ISO kod (default: hr)
  --target-lang LANG    Ciljni jezik ISO kod (default: hr)
  --file PATH           Transkribira samo jednu WAV datoteku
  --dry-run             Samo prikaz, bez transkripcije
```

### Podržani jezici

`bg` `hr` `cs` `da` `nl` `en` `et` `fi` `fr` `de` `el` `hu` `it` `lv` `lt` `mt` `pl` `pt` `ro` `sk` `sl` `es` `sv` `ru` `uk`
