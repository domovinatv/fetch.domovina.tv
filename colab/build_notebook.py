"""Builds Colab notebooks for this project from structured cell definitions.

Outputs:
  - colab/domovina_tv_batch.ipynb               (combined: transcription + diarization)
  - colab_canary/domovina_tv_fetch.ipynb        (transcription only, batch)
  - colab_sortformer/domovina_tv_sortformer.ipynb              (EXPERIMENTAL: GPU end-to-end Canary+Sortformer)
  - colab_sortformer/domovina_tv_sortformer_diarize_only.ipynb (Pass 2: Sortformer-only nad postojećim .canary.srt — T4-friendly)

Run: python colab/build_notebook.py
"""
import json
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
NB_PATH = REPO_ROOT / "colab" / "domovina_tv_batch.ipynb"
CANARY_NB_PATH = REPO_ROOT / "colab_canary" / "domovina_tv_fetch.ipynb"
SORTFORMER_NB_PATH = REPO_ROOT / "colab_sortformer" / "domovina_tv_sortformer.ipynb"
SORTFORMER_DIARIZE_ONLY_NB_PATH = REPO_ROOT / "colab_sortformer" / "domovina_tv_sortformer_diarize_only.ipynb"


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.lstrip("\n").splitlines(keepends=True)}


def code(text):
    return {
        "cell_type": "code",
        "metadata": {},
        "execution_count": None,
        "outputs": [],
        "source": text.lstrip("\n").splitlines(keepends=True),
    }


def write_notebook(cells, path, display_name):
    nb = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "colab": {"name": path.name, "provenance": [], "toc_visible": True},
            "kernelspec": {"name": "python3", "display_name": "Python 3"},
            "accelerator": "GPU",
            "language_info": {"name": "python"},
        },
        "cells": [{**c, "id": f"cell-{i}"} for i, c in enumerate(cells)],
    }
    path.write_text(json.dumps(nb, indent=1, ensure_ascii=False))
    print(f"Wrote {path} — {display_name} ({len(cells)} cells, {path.stat().st_size} bytes)")


# ─────────────────────────────────────────────────────────────────────────────
# 1) COMBINED NOTEBOOK — transcription + diarization
# ─────────────────────────────────────────────────────────────────────────────

cells = []

cells.append(md(r"""
# Domovina.tv — Canary transkripcija + pyannote diarizacija (BATCH) *(Colab)*

Batch obrada svih `.wav` datoteka koje su uploadane na Google Drive (`canary_wav` folder) — generira `.canary.srt`, `.canary.csv` i `.canary.diarized.srt` za svaki podcast.

## Što ovaj notebook radi

```
Google Drive (canary_wav/)              Google Colab (T4/L4/G4 GPU)
┌────────────────────────────┐          ┌─────────────────────────────────┐
│ kanal_x/                   │  mount   │ FAZA 1: transcribe_canary.py    │
│   ep001.wav        ───────────────►   │   nvidia/canary-1b-v2 (BF16)    │
│                            │          │   → .canary.srt + .canary.csv   │
│   ep001.wav.canary.srt ◄───────────── │                                 │
│                            │          │ FAZA 2: diarize_canary.py       │
│                            │          │   pyannote community-1          │
│                            │          │   exclusive_speaker_diarization │
│   ep001.wav.canary.        │          │   + distributed lock            │
│     diarized.srt   ◄───────────────── │                                 │
└────────────────────────────┘          └─────────────────────────────────┘
```

Obje faze su **idempotentne** — preskaču datoteke koje već imaju output. Možeš pokretati notebook neograničeno; obrađuju se samo nove epizode.

## Kako koristiti (jednom)

1. **GPU runtime**: Runtime → Change runtime type → odaberi `T4` (free), `L4` (Pro) ili `A100` (Pro+).
2. **HF token**: lijevi panel → ključić (Secrets) → dodaj `HF_TOKEN` (uključi *Notebook access*).
   - Token: https://huggingface.co/settings/tokens
   - Prihvati uvjete: https://huggingface.co/pyannote/speaker-diarization-community-1
3. **Drive folder**: WAV-ovi moraju već biti uploadani u `MyDrive/domovina_fetch_data/canary_wav/{kanal}/...wav` (lokalni `run_pipeline.sh` to radi automatski u koraku 2.5).
4. **Runtime → Run all** (⌘/Ctrl+F9). Prvi put će se kernel jednom restartati nakon instalacije — to je očekivano. Klikni *Run all* još jednom.

## Resursi

| GPU | Canary 1B v2 | pyannote community-1 | Per file (75 min audio) |
|---|---|---|---|
| T4 (16 GB) | ~30-50s | ~30-60s VRAM peak ~9.5 GB | ~1.5 min |
| L4 / G4 (24 GB) | ~10-20s | ~20-40s | ~45-60s |
| A100 (40 GB) | ~5-10s | ~15-30s | ~25-40s |

VRAM headroom je dovoljan na T4 jer notebook **prvo skida Canary** prije učitavanja pyannote.

## Multi-machine paralelizam

Ako pokrećeš isti notebook iz više Colaba istovremeno (npr. više besplatnih sesija), svaki worker stvori `.canary.lock` na Drive-u prije obrade fajla — drugi ga preskoče. Uključuje se setanjem `USE_DISTRIBUTED_LOCK = True` u konfiguraciji.

---
"""))

cells.append(md(r"""
## 0. Konfiguracija

Sve postavke koje ćeš mijenjati su ovdje. Niže ćelije čitaju ove varijable.
"""))

cells.append(code(r"""
# ─── Drive locations ─────────────────────────────────────────────────────────
DRIVE_MOUNT_POINT = "/content/drive"
DRIVE_DATA_DIR    = "MyDrive/domovina_fetch_data/canary_wav"   # gdje su WAV-ovi
INPUT_DIR         = f"{DRIVE_MOUNT_POINT}/{DRIVE_DATA_DIR}"

# ─── Što pokrenuti ───────────────────────────────────────────────────────────
RUN_TRANSCRIPTION = True   # Faza 1: WAV → .canary.srt + .canary.csv
RUN_DIARIZATION   = True   # Faza 2: WAV + .canary.srt → .canary.diarized.srt

# ─── Batch limits ────────────────────────────────────────────────────────────
LIMIT             = None   # int ili None — npr. 5 za testiranje, None za sve
DRY_RUN           = False  # True: samo prikaz, bez obrade

# ─── Pyannote speaker hints (opcionalno) ─────────────────────────────────────
# Ako znaš tipičan broj govornika za većinu podcasta, postavi raspon.
# None = auto-detekcija (sigurno za heterogen korpus s različitim formatima).
MIN_SPEAKERS      = None   # npr. 2
MAX_SPEAKERS      = None   # npr. 6

# ─── Multi-machine koordinacija ──────────────────────────────────────────────
# True ako pokrećeš notebook iz više Colab sesija paralelno.
# Stvori .canary.lock na Drive-u; drugi workeri preskoče zaključane fajlove.
USE_DISTRIBUTED_LOCK = False

# ─── Repo ────────────────────────────────────────────────────────────────────
REPO_URL  = "https://github.com/domovinatv/fetch.domovina.tv.git"
REPO_PATH = "/content/fetch.domovina.tv"

print("Konfiguracija učitana.")
print(f"  Input:           {INPUT_DIR}")
print(f"  Transkripcija:   {RUN_TRANSCRIPTION}")
print(f"  Diarizacija:     {RUN_DIARIZATION}")
print(f"  Limit:           {LIMIT if LIMIT else 'sve'}")
print(f"  Dry run:         {DRY_RUN}")
print(f"  Distributed lock:{USE_DISTRIBUTED_LOCK}")
"""))

cells.append(md(r"""
## 1. GPU provjera

Ako padne, idi na *Runtime → Change runtime type → T4 GPU* i pokreni *Run all* ponovo.
"""))

cells.append(code(r"""
import subprocess
try:
    out = subprocess.check_output(["nvidia-smi", "-L"]).decode().strip()
    print(out)
    # Detalji o memoriji
    mem = subprocess.check_output(
        ["nvidia-smi", "--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"]
    ).decode().strip()
    total, free = [int(x.strip()) for x in mem.split(",")]
    print(f"\nVRAM: {free} MB slobodno / {total} MB ukupno ({free/total*100:.0f}%)")
    if total < 14000:
        print("\nUPOZORENJE: Manje od 14 GB VRAM — pyannote community-1 može OOM. Razmisli o L4/A100.")
except Exception as e:
    raise RuntimeError(
        "GPU nije dostupan. Idi na Runtime → Change runtime type → T4/L4/A100 GPU."
    ) from e
"""))

cells.append(md(r"""
## 2. Mount Google Drive

Tražit će autorizaciju u browseru — odobri.
"""))

cells.append(code(r"""
from google.colab import drive
drive.mount(DRIVE_MOUNT_POINT)

import os
assert os.path.isdir(INPUT_DIR), (
    f"Direktorij ne postoji: {INPUT_DIR}\n"
    f"Provjeri DRIVE_DATA_DIR u konfiguraciji ili da li su WAV-ovi uploadani."
)
print(f"Drive mountan. INPUT_DIR sadrži: {len(os.listdir(INPUT_DIR))} entry-ja.")
"""))

cells.append(md(r"""
## 3. Clone / pull repo

Notebook se oslanja na `colab_canary/transcribe_canary.py` i `colab_diarize/diarize_canary.py` iz repoa — oni su workhorses za batch obradu (lockovi, ETA, idempotentnost).
"""))

cells.append(code(r"""
import os, subprocess

if not os.path.isdir(REPO_PATH):
    print(f"Kloniram repo u {REPO_PATH}...")
    subprocess.run(["git", "clone", REPO_URL, REPO_PATH], check=True)
else:
    print(f"Repo postoji, povlačim najnovije...")
    subprocess.run(["git", "-C", REPO_PATH, "pull", "--ff-only"], check=True)

# Verificiraj da postoje skripte
TRANSCRIBE_SCRIPT = f"{REPO_PATH}/colab_canary/transcribe_canary.py"
DIARIZE_SCRIPT    = f"{REPO_PATH}/colab_diarize/diarize_canary.py"
for s in (TRANSCRIBE_SCRIPT, DIARIZE_SCRIPT):
    assert os.path.isfile(s), f"Nedostaje skripta: {s}"
print(f"Skripte spremne: {os.path.basename(TRANSCRIBE_SCRIPT)}, {os.path.basename(DIARIZE_SCRIPT)}")
"""))

cells.append(md(r"""
## 4. Instalacija dependencija (~2-3 min)

Instalira NeMo (Canary), pyannote.audio (diarizacija), gdown (download helper). Prvi put ova ćelija prisilno gasi kernel kako bi novi numpy/scipy proradili (inače `ImportError: _center` u NeMo). Nakon restarta klikni **Runtime → Run all** ponovno — drugi put preskače instalaciju i sve teče do kraja.
"""))

cells.append(code(r"""
import os

MARKER = "/content/.domovina_deps_ok"

def _have_deps():
    try:
        import nemo.collections.asr  # noqa: F401
        from pyannote.audio import Pipeline  # noqa: F401
        import soundfile  # noqa: F401
        return True
    except Exception as e:
        print(f"deps check: {type(e).__name__}: {e}")
        return False

if os.path.exists(MARKER) and _have_deps():
    print("Dependencies već instalirani i spremni.")
else:
    print("Instaliram dependencies — traje ~2-3 min...")
    get_ipython().system(
        'pip install -qU numpy "nemo_toolkit[asr]" "pyannote.audio>=4.0.0" '
        'soundfile 2>&1 | tail -5'
    )
    open(MARKER, "w").write("ok")
    print("")
    print("=" * 60)
    print(" Instalacija gotova — gasim kernel radi čistog reloada.")
    print(" → Nakon restarta klikni Runtime → Run all ponovno.")
    print("=" * 60)
    import time
    time.sleep(2)
    os.kill(os.getpid(), 9)
"""))

cells.append(code(r"""
# Bezopasni shimovi za starije import path-eve (NeMo + huggingface_hub)
import sys
class _DummyYTTM: pass
sys.modules.setdefault("youtokentome", _DummyYTTM)

import huggingface_hub
if getattr(huggingface_hub, "ModelFilter", None) is None:
    class ModelFilter: pass
    huggingface_hub.ModelFilter = ModelFilter

import torch
print("torch:", torch.__version__,
      "| CUDA:", torch.cuda.is_available(),
      "|", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "NO GPU")
"""))

cells.append(md(r"""
## 5. HuggingFace token

Token se učita iz Colab Secrets (`HF_TOKEN`). Ako secret nije postavljen, pita za upis u runtime (neće se sačuvati).
"""))

cells.append(code(r"""
HF_TOKEN = None
try:
    from google.colab import userdata
    HF_TOKEN = userdata.get("HF_TOKEN")
    if HF_TOKEN:
        print("HF_TOKEN učitan iz Colab Secrets.")
except Exception:
    pass

if not HF_TOKEN:
    from getpass import getpass
    HF_TOKEN = getpass("Upiši HuggingFace token (hf_...): ").strip()

assert HF_TOKEN and HF_TOKEN.startswith("hf_"), "HF_TOKEN nije valjan (mora počinjati s 'hf_')"

# Postavi za subprocess pozive (transcribe_canary.py + diarize_canary.py ga čitaju iz env)
os.environ["HF_TOKEN"] = HF_TOKEN
print("HF_TOKEN spreman za korištenje.")
"""))

cells.append(md(r"""
## 6. Pregled posla (dry run)

Skenira Drive i prikazuje:
- Koliko WAV datoteka postoji ukupno
- Koliko već ima `.canary.srt` (transkripcija gotova)
- Koliko već ima `.canary.diarized.srt` (diarizacija gotova)
- Koliko će se obraditi u ovom runu

Ova ćelija ne radi nikakvu obradu — samo prikazuje.
"""))

cells.append(code(r"""
def scan_progress(input_dir):
    wavs, with_srt, with_diar = [], [], []
    for root, _, files in os.walk(input_dir, followlinks=True):
        for f in files:
            if f.startswith("._") or not f.endswith(".wav"):
                continue
            p = os.path.join(root, f)
            wavs.append(p)
            if os.path.exists(p + ".canary.srt"):
                with_srt.append(p)
            if os.path.exists(p + ".canary.diarized.srt"):
                with_diar.append(p)
    return wavs, with_srt, with_diar

print("Skeniram Drive (može potrajati ~30s za veliki korpus)...")
wavs, with_srt, with_diar = scan_progress(INPUT_DIR)

to_transcribe = [w for w in wavs if not os.path.exists(w + ".canary.srt")]
to_diarize    = [w for w in with_srt if not os.path.exists(w + ".canary.diarized.srt")]

print(f"\n  Ukupno WAV datoteka:        {len(wavs)}")
print(f"  Već transkribirano (.srt):  {len(with_srt)} ({len(with_srt)/max(len(wavs),1)*100:.1f}%)")
print(f"  Već diarized (.diarized):   {len(with_diar)} ({len(with_diar)/max(len(wavs),1)*100:.1f}%)")
print(f"\n  Za transkripciju u ovom runu: {len(to_transcribe)}")
print(f"  Za diarizaciju u ovom runu:   {len(to_diarize)}")

if LIMIT:
    print(f"\n  LIMIT={LIMIT} → obradit će se najviše {LIMIT} datoteka po fazi")

# Procjena trajanja (tipično 75 min audio na T4: ~1.5 min/file za obje faze)
gpu_name = torch.cuda.get_device_name(0).lower() if torch.cuda.is_available() else ""
if "a100" in gpu_name:
    sec_per_file = 30
elif "l4" in gpu_name or "g4" in gpu_name:
    sec_per_file = 50
else:
    sec_per_file = 90  # T4 / V100
n_to_run = min(LIMIT or 10**9, len(to_transcribe) if RUN_TRANSCRIPTION else 0) + \
           min(LIMIT or 10**9, len(to_diarize) if RUN_DIARIZATION else 0)
if n_to_run:
    eta_min = n_to_run * sec_per_file / 60
    print(f"\n  Procjena trajanja na ovom GPU-u: ~{eta_min:.0f} min")
    print(f"  (heuristika: ~{sec_per_file}s po fileu × {n_to_run} obrada)")
"""))

cells.append(md(r"""
## 7. FAZA 1 — Canary 1B v2 transkripcija

Pokreće `transcribe_canary.py` u batch modu. Skripta:
- Učita Canary 1B v2 model (BF16 ako GPU podržava — pola memorije, brži)
- Skenira `INPUT_DIR` rekurzivno za `.wav` datoteke
- Preskače sve koje već imaju `.canary.srt`
- Za svaku generira `.canary.srt` i `.canary.csv`
- Heartbeat svakih 60s tijekom dugačkih datoteka

Output ide u **isti folder** kao WAV (na Drive-u), tako da se odmah vidi i sinkronizira nazad lokalno preko `rclone`.
"""))

cells.append(code(r"""
import shlex

if not RUN_TRANSCRIPTION:
    print("Preskačem FAZU 1 (RUN_TRANSCRIPTION=False).")
else:
    cmd = [
        "python", "-u", TRANSCRIBE_SCRIPT,
        "--input-dir", INPUT_DIR,
    ]
    if LIMIT:
        cmd += ["--limit", str(LIMIT)]
    if DRY_RUN:
        cmd += ["--dry-run"]

    print(">", " ".join(shlex.quote(c) for c in cmd))
    print()
    # Stream output u realnom vremenu
    get_ipython().system(" ".join(shlex.quote(c) for c in cmd))
"""))

cells.append(md(r"""
## 8. Oslobodi VRAM između faza

Canary model više nije potreban — pyannote treba ~9.5 GB VRAM peak. Restart kernela bio bi sigurniji ali bi izgubio sve varijable; umjesto toga čistimo cache i puštamo OS da reclaim-a memoriju kad sljedeći subprocess (`diarize_canary.py`) startuje.
"""))

cells.append(code(r"""
import gc, torch
gc.collect()
if torch.cuda.is_available():
    torch.cuda.empty_cache()
    free_gb = torch.cuda.mem_get_info()[0] / 1024**3
    print(f"VRAM slobodno: {free_gb:.2f} GB")
"""))

cells.append(md(r"""
## 9. FAZA 2 — pyannote community-1 diarizacija

Pokreće `diarize_canary.py`. Skripta:
- Učita pyannote/speaker-diarization-community-1 (~9.5 GB VRAM)
- Skenira `INPUT_DIR` za WAV-ove koji imaju `.canary.srt` ali nemaju `.canary.diarized.srt`
- Koristi **exclusive_speaker_diarization** mode → jedan govornik u svakom trenutku (bez overlapa, idealno za SRT alignment)
- Spaja govornike s SRT segmentima preko najveće vremenske preklapanosti
- Ako je `USE_DISTRIBUTED_LOCK=True`, koordinira s drugim Colab sesijama preko `.canary.lock` fajlova

Output: `{wav_basename}.canary.diarized.srt` u istom folderu.
"""))

cells.append(code(r"""
import shlex

if not RUN_DIARIZATION:
    print("Preskačem FAZU 2 (RUN_DIARIZATION=False).")
else:
    cmd = [
        "python", "-u", DIARIZE_SCRIPT,
        "--input-dir", INPUT_DIR,
    ]
    if LIMIT:
        cmd += ["--limit", str(LIMIT)]
    if DRY_RUN:
        cmd += ["--dry-run"]
    if MIN_SPEAKERS is not None:
        cmd += ["--min-speakers", str(MIN_SPEAKERS)]
    if MAX_SPEAKERS is not None:
        cmd += ["--max-speakers", str(MAX_SPEAKERS)]
    if USE_DISTRIBUTED_LOCK:
        # --drive-mount: lock fajlovi se stvaraju direktno na mountanom Drive-u
        cmd += ["--drive-mount", INPUT_DIR]

    print(">", " ".join(shlex.quote(c) for c in cmd))
    print()
    get_ipython().system(" ".join(shlex.quote(c) for c in cmd))
"""))

cells.append(md(r"""
## 10. Sažetak — što je novo na Drive-u

Ponovno skenira Drive i pokazuje delta — koliko `.canary.srt` i `.canary.diarized.srt` je generirano u ovom runu. Ovaj broj odgovara onome što ćeš dobiti lokalno kad sljedeći put pokreneš `run_pipeline.sh` (korak 0 ih `rclone`-om povuče).
"""))

cells.append(code(r"""
wavs2, with_srt2, with_diar2 = scan_progress(INPUT_DIR)

new_srt  = len(with_srt2)  - len(with_srt)
new_diar = len(with_diar2) - len(with_diar)

print("─" * 60)
print(f"  Novih .canary.srt:           +{new_srt}")
print(f"  Novih .canary.diarized.srt:  +{new_diar}")
print("─" * 60)
print(f"  Stanje na Drive-u:")
print(f"    {len(wavs2)} WAV ukupno")
print(f"    {len(with_srt2)}/{len(wavs2)} transkribirano ({len(with_srt2)/max(len(wavs2),1)*100:.1f}%)")
print(f"    {len(with_diar2)}/{len(wavs2)} diarized   ({len(with_diar2)/max(len(wavs2),1)*100:.1f}%)")
print()
print("Sljedeći korak na lokalnom stroju:")
print("  ./run_pipeline.sh   # korak 0 rclone-om povuče nove .canary.diarized.srt")
"""))

write_notebook(cells, NB_PATH, "combined")


# ─────────────────────────────────────────────────────────────────────────────
# 2) CANARY-ONLY NOTEBOOK — batch transcription only
# ─────────────────────────────────────────────────────────────────────────────

cells = []

cells.append(md(r"""
# Domovina.tv — Canary 1B v2 BATCH transkripcija *(Colab)*

Batch transkripcija svih `.wav` datoteka uploadanih na Google Drive — generira `.canary.srt` i `.canary.csv` za svaki podcast. **Bez diarizacije** — diarizacija se radi odvojeno (vidi `colab/domovina_tv_batch.ipynb` ili `colab_diarize/domovina_tv_diarize.ipynb`).

## Što ovaj notebook radi

```
Google Drive (canary_wav/)              Google Colab (G4 / L4 / T4)
┌────────────────────────────┐          ┌─────────────────────────────────┐
│ kanal_x/                   │  mount   │  transcribe_canary.py           │
│   ep001.wav        ───────────────►   │    nvidia/canary-1b-v2          │
│                            │          │    BF16 inference (2× brže)     │
│   ep001.wav.canary.srt ◄───────────── │    + .canary.csv                │
│   ep001.wav.canary.csv ◄───────────── │                                 │
└────────────────────────────┘          └─────────────────────────────────┘
```

Skripta je **idempotentna** — preskače WAV-ove koji već imaju `.canary.srt`. Možeš pokretati neograničeno; obrade se samo nove epizode.

## GPU tablica (testirano 2026-03-10)

| GPU | VRAM | units/h | sec/file | Napomena |
|---|---|---|---|---|
| **G4** (RTX PRO 6000 Blackwell) | **96 GB** | **8.71** | **~13s (BF16)** | Optimalno: najbrže + najjeftinije po fajlu |
| A100 80GB | 80 GB | 7.52 | ~70s | OK ali skuplje od G4 po fajlu |
| L4 | 24 GB | 1.71 | ~60s | Sporo, OOM na fajlovima >150 MB |
| T4 (free) | 16 GB | 1.67 | — | **OOM** za Canary 1B v2 (model ~19 GB FP32) |

**Preporuka**: G4 (Colab Pro+). T4 ne može učitati model — koristi L4 minimum, idealno G4.

## Kako koristiti

1. **GPU runtime**: Runtime → Change runtime type → `L4` (Pro) ili `G4` (Pro+).
2. **Drive folder**: WAV-ovi moraju biti u `MyDrive/domovina_fetch_data/canary_wav/{kanal}/...wav` (lokalni `run_pipeline.sh` ih tamo uploadira u koraku 2.5).
3. **Runtime → Run all** (⌘/Ctrl+F9). Prvi put restart kernela nakon instalacije — pokreni *Run all* još jednom.

## Procjena za 2545 podcasta

```
2545 fajlova × 13s (G4 BF16) = ~9.2 h
9.2 h × 8.71 units/h ≈ 80 units (Colab Pro+ ima ~500 units/mjesec)
```

---
"""))

cells.append(md(r"""
## 0. Konfiguracija
"""))

cells.append(code(r"""
# ─── Drive locations ─────────────────────────────────────────────────────────
DRIVE_MOUNT_POINT = "/content/drive"
DRIVE_DATA_DIR    = "MyDrive/domovina_fetch_data/canary_wav"
INPUT_DIR         = f"{DRIVE_MOUNT_POINT}/{DRIVE_DATA_DIR}"

# ─── Batch limits ────────────────────────────────────────────────────────────
LIMIT             = None   # int ili None — npr. 5 za testiranje, None za sve
DRY_RUN           = False  # True: samo prikaz, bez transkripcije

# ─── Jezik (Canary podržava multilingual + translation) ─────────────────────
SOURCE_LANG       = "hr"   # ISO kod izvornog jezika
TARGET_LANG       = "hr"   # isti kao source = transkripcija (bez prijevoda)

# ─── Repo ────────────────────────────────────────────────────────────────────
REPO_URL  = "https://github.com/domovinatv/fetch.domovina.tv.git"
REPO_PATH = "/content/fetch.domovina.tv"

print("Konfiguracija učitana.")
print(f"  Input:    {INPUT_DIR}")
print(f"  Limit:    {LIMIT if LIMIT else 'sve'}")
print(f"  Dry run:  {DRY_RUN}")
print(f"  Lang:     {SOURCE_LANG} → {TARGET_LANG}")
"""))

cells.append(md(r"""
## 1. GPU provjera

Canary 1B v2 model zauzima ~19 GB FP32 ili ~10 GB BF16. **T4 nije dovoljan** — koristi L4 (24 GB) ili G4 (96 GB).
"""))

cells.append(code(r"""
import subprocess
out = subprocess.check_output(["nvidia-smi", "-L"]).decode().strip()
print(out)

mem = subprocess.check_output(
    ["nvidia-smi", "--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"]
).decode().strip()
total, free = [int(x.strip()) for x in mem.split(",")]
print(f"\nVRAM: {free} MB slobodno / {total} MB ukupno ({free/total*100:.0f}%)")

if total < 22000:
    print(f"\nUPOZORENJE: Manje od 22 GB VRAM ({total} MB) — Canary 1B v2 može OOM.")
    print("Idi na Runtime → Change runtime type → L4 (Pro) ili G4 (Pro+).")
"""))

cells.append(md(r"""
## 2. Mount Google Drive
"""))

cells.append(code(r"""
from google.colab import drive
drive.mount(DRIVE_MOUNT_POINT)

import os
assert os.path.isdir(INPUT_DIR), (
    f"Direktorij ne postoji: {INPUT_DIR}\n"
    f"Provjeri DRIVE_DATA_DIR ili da li su WAV-ovi uploadani."
)
n_entries = len(os.listdir(INPUT_DIR))
print(f"Drive mountan. INPUT_DIR sadrži: {n_entries} entry-ja (kanala/foldera).")
"""))

cells.append(md(r"""
## 3. Clone / pull repo
"""))

cells.append(code(r"""
import os, subprocess

if not os.path.isdir(REPO_PATH):
    print(f"Kloniram repo u {REPO_PATH}...")
    subprocess.run(["git", "clone", REPO_URL, REPO_PATH], check=True)
else:
    print("Repo postoji, povlačim najnovije...")
    subprocess.run(["git", "-C", REPO_PATH, "pull", "--ff-only"], check=True)

TRANSCRIBE_SCRIPT = f"{REPO_PATH}/colab_canary/transcribe_canary.py"
assert os.path.isfile(TRANSCRIBE_SCRIPT), f"Nedostaje skripta: {TRANSCRIBE_SCRIPT}"
print(f"Skripta spremna: {os.path.basename(TRANSCRIBE_SCRIPT)}")
"""))

cells.append(md(r"""
## 4. Instalacija dependencija (~2 min)

Instalira NeMo toolkit (sadrži Canary). Prvi put prisilno gasi kernel kako bi novi numpy/scipy proradili (inače `ImportError: _center` u NeMo). Nakon restarta klikni **Runtime → Run all** ponovno.
"""))

cells.append(code(r"""
import os

MARKER = "/content/.canary_deps_ok"

def _have_deps():
    try:
        import nemo.collections.asr  # noqa: F401
        return True
    except Exception as e:
        print(f"deps check: {type(e).__name__}: {e}")
        return False

if os.path.exists(MARKER) and _have_deps():
    print("Dependencies već instalirani i spremni.")
else:
    print("Instaliram NeMo (sadrži Canary) — traje ~2 min...")
    get_ipython().system(
        'pip install -qU numpy "nemo_toolkit[asr]" 2>&1 | tail -5'
    )
    open(MARKER, "w").write("ok")
    print("")
    print("=" * 60)
    print(" Instalacija gotova — gasim kernel radi čistog reloada.")
    print(" → Nakon restarta klikni Runtime → Run all ponovno.")
    print("=" * 60)
    import time
    time.sleep(2)
    os.kill(os.getpid(), 9)
"""))

cells.append(code(r"""
# Bezopasni shimovi za starije NeMo import path-eve
import sys
class _DummyYTTM: pass
sys.modules.setdefault("youtokentome", _DummyYTTM)

import huggingface_hub
if getattr(huggingface_hub, "ModelFilter", None) is None:
    class ModelFilter: pass
    huggingface_hub.ModelFilter = ModelFilter

import torch
print("torch:", torch.__version__,
      "| CUDA:", torch.cuda.is_available(),
      "|", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "NO GPU")
print("BF16 supported:", torch.cuda.is_bf16_supported() if torch.cuda.is_available() else False)
"""))

cells.append(md(r"""
## 5. Pregled posla (dry run)

Skenira Drive i prikazuje koliko WAV-ova je već transkribirano vs. koliko će se obraditi u ovom runu. Ne radi nikakvu obradu.
"""))

cells.append(code(r"""
def scan_progress(input_dir):
    wavs, with_srt = [], []
    for root, _, files in os.walk(input_dir, followlinks=True):
        for f in files:
            if f.startswith("._") or not f.endswith(".wav"):
                continue
            p = os.path.join(root, f)
            wavs.append(p)
            if os.path.exists(p + ".canary.srt"):
                with_srt.append(p)
    return wavs, with_srt

print("Skeniram Drive (može potrajati ~30s za veliki korpus)...")
wavs, with_srt = scan_progress(INPUT_DIR)
to_transcribe = [w for w in wavs if not os.path.exists(w + ".canary.srt")]

print(f"\n  Ukupno WAV datoteka:     {len(wavs)}")
print(f"  Već transkribirano:      {len(with_srt)} ({len(with_srt)/max(len(wavs),1)*100:.1f}%)")
print(f"  Za transkripciju (novo): {len(to_transcribe)}")

if LIMIT:
    print(f"\n  LIMIT={LIMIT} → obradit će se najviše {LIMIT} datoteka")

# ETA po GPU-u
gpu_name = torch.cuda.get_device_name(0).lower() if torch.cuda.is_available() else ""
if "rtx pro 6000" in gpu_name or "g4" in gpu_name:
    sec_per_file = 13
elif "a100" in gpu_name:
    sec_per_file = 25
elif "l4" in gpu_name:
    sec_per_file = 60
else:
    sec_per_file = 90
n_to_run = min(LIMIT or 10**9, len(to_transcribe))
if n_to_run:
    eta_min = n_to_run * sec_per_file / 60
    print(f"\n  Procjena trajanja na ovom GPU-u: ~{eta_min:.0f} min")
    print(f"  (heuristika: ~{sec_per_file}s/file × {n_to_run} file × BF16)")
"""))

cells.append(md(r"""
## 6. Pokreni batch transkripciju

Poziva `transcribe_canary.py` koji:
- Učita Canary 1B v2 (BF16 ako GPU podržava → ~10 GB VRAM, 2× brže od FP32)
- Skenira `INPUT_DIR` rekurzivno za `.wav` datoteke
- Preskače sve koje već imaju `.canary.srt` (idempotentno)
- Generira `.canary.srt` i `.canary.csv` u istom folderu kao WAV (na Drive-u)
- Heartbeat svakih 60s tijekom dugačkih datoteka

Output ide odmah na Drive — sljedeći put kad pokreneš `run_pipeline.sh` lokalno, korak 0 (rclone) povuče nove `.canary.srt` na Mac.
"""))

cells.append(code(r"""
import shlex

cmd = [
    "python", "-u", TRANSCRIBE_SCRIPT,
    "--input-dir", INPUT_DIR,
    "--source-lang", SOURCE_LANG,
    "--target-lang", TARGET_LANG,
]
if LIMIT:
    cmd += ["--limit", str(LIMIT)]
if DRY_RUN:
    cmd += ["--dry-run"]

print(">", " ".join(shlex.quote(c) for c in cmd))
print()
get_ipython().system(" ".join(shlex.quote(c) for c in cmd))
"""))

cells.append(md(r"""
## 7. Sažetak — što je novo na Drive-u

Delta novih `.canary.srt` u ovom runu. Ovaj broj je input za diarizaciju (sljedeći Colab notebook ili lokalno).
"""))

cells.append(code(r"""
wavs2, with_srt2 = scan_progress(INPUT_DIR)
new_srt = len(with_srt2) - len(with_srt)

print("─" * 60)
print(f"  Novih .canary.srt:  +{new_srt}")
print("─" * 60)
print(f"  Stanje na Drive-u:")
print(f"    {len(wavs2)} WAV ukupno")
print(f"    {len(with_srt2)}/{len(wavs2)} transkribirano ({len(with_srt2)/max(len(wavs2),1)*100:.1f}%)")
print()
print("Sljedeći koraci:")
print("  1. Diarizacija: otvori colab_diarize/domovina_tv_diarize.ipynb")
print("     ili colab/domovina_tv_batch.ipynb (RUN_TRANSCRIPTION=False)")
print("  2. Lokalno: ./run_pipeline.sh (korak 0 rclone povuče nove .canary.srt)")
"""))

write_notebook(cells, CANARY_NB_PATH, "canary-only")


# ─────────────────────────────────────────────────────────────────────────────
# 3) SORTFORMER NOTEBOOK — EXPERIMENTAL GPU end-to-end (Canary + Sortformer)
# ─────────────────────────────────────────────────────────────────────────────

def build_sortformer_notebook():
    """Builds the experimental GPU-end-to-end pipeline notebook.

    Differs from canary-only:
      - Uses NVIDIA Streaming Sortformer 4spk v2.1 for diarization (GPU-resident)
      - Output namespace .sortformer.* (NOT .canary.*) to avoid collision
      - Single workhorse script does Canary + Sortformer + merge in one pass
    """
    cells = []

    cells.append(md(r"""
# Domovina.tv — 🧪 EKSPERIMENTALNI Sortformer GPU pipeline *(Colab)*

End-to-end **GPU-resident** transkripcija + diarizacija na Google Colab G4. Koristi:

- **NVIDIA Canary 1B v2** za transkripciju (proven na G4, ista skripta family kao stable pipeline)
- **NVIDIA Streaming Sortformer 4spk v2.1** za diarizaciju — **fully GPU end-to-end**, bez CPU clusteringa

---

## ⚠️ LICENCA — PROČITAJ PRIJE KORIŠTENJA

| Model | Licenca | Komercijalno? |
|---|---|---|
| Canary 1B v2 | CC-BY-4.0 | ✅ Da |
| **Streaming Sortformer 4spk v2.1** | **NVIDIA Open Model License** | ✅ Uz uvjete (atribucija, bez zlouporabe) |
| Sortformer v1 / non-streaming v2 | CC-BY-NC-4.0 | ❌ **Ne** — ne mijenjati varijantu bez provjere |

Korisnik (ovaj repo, MIT) eksplicitno je prihvatio uvjete NVIDIA Open Model License-a. Ako forkaš ovaj projekt za drugu namjenu — **provjeri svoju licencnu situaciju**.

Detalji: [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/) · [Sortformer model card](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1)

---

## Zašto eksperimentalan?

Stable produkcijski pipeline je **Canary na Colab G4 + pyannote DIARIZACIJA na Mac Mini lokalno** (`run_pipeline.sh --with-local-canary-diarize`). Razlog: pyannote je CPU-bound (sklearn clustering), pa Colab G4 nema benefit za diarizaciju → plaćaš premium GPU za posao gdje GPU sjedi idle. Vidi [`docs/diarization_research_2026-05.md`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/docs/diarization_research_2026-05.md).

**Ovaj notebook mijenja tu računicu**: Sortformer je *istinski* GPU end-to-end (~5870× realtime u istraživanju, <2 GB VRAM), pa Colab G4 sad **ima** benefit za diarizaciju — sve teče na GPU-u, jedan model load, jedan pass per fajl.

| Aspekt | Stable (Canary + pyannote local) | Eksperiment (Canary + Sortformer Colab) |
|---|---|---|
| Gdje teče | Colab (transkripcija) + Mac (diarizacija) | Colab in toto |
| GPU iskorištenost | Samo transkripcija | Cijeli pipeline |
| Mac Mini opterećenje | Visoko (sati pyannote) | Nula |
| Latencija handoff | rclone delay (Drive → Mac) | Trenutna (sve na Drive-u odmah) |
| Max govornika | Neograničen (clustering) | **4** (Sortformer ograničenje) |
| Output namespace | `.canary.diarized.srt` | `.sortformer.diarized.srt` |
| Licenca | CC-BY-4.0 (sve) | NVIDIA Open Model License (Sortformer) |
| Dokazano u produkciji | ✅ Da, mjesecima | 🧪 Ne — testira se |

## Output naming — NIKAD ne kolidira sa stable

Ovaj notebook generira **novi namespace** koji NE prepisuje canary outpute:

```
ep001.wav.canary.srt              ← stable pipeline (ostaje netaknuto)
ep001.wav.canary.diarized.srt     ← stable pipeline (ostaje netaknuto)

ep001.wav.sortformer.srt          ← OVAJ notebook
ep001.wav.sortformer.csv          ← OVAJ notebook
ep001.wav.sortformer.diarized.srt ← OVAJ notebook
```

`run_pipeline.sh` i `count_progress.js` ignoriraju `.sortformer.*` outpute — ovaj eksperiment *ne utječe* na produkciju.

## Kako koristiti

1. **GPU runtime**: Runtime → Change runtime type → **G4** (Pro+) ili A100. T4 OOM (Canary ne stane).
2. **HF token**: Secrets panel → `HF_TOKEN` (potrebno za skidanje Sortformer modela).
3. **Drive folder**: WAV-ovi u `MyDrive/domovina_fetch_data/canary_wav/{kanal}/...wav` (isto kao stable).
4. **Runtime → Run all** (⌘/Ctrl+F9). Prvi put restart kernela nakon instalacije — pokreni opet.

---
"""))

    cells.append(md(r"""
## 0. Konfiguracija
"""))

    cells.append(code(r"""
# ─── Drive locations (isto kao stable canary pipeline) ──────────────────────
DRIVE_MOUNT_POINT = "/content/drive"
DRIVE_DATA_DIR    = "MyDrive/domovina_fetch_data/canary_wav"
INPUT_DIR         = f"{DRIVE_MOUNT_POINT}/{DRIVE_DATA_DIR}"

# ─── Batch limits ────────────────────────────────────────────────────────────
LIMIT             = None   # int ili None — npr. 3 za testiranje
DRY_RUN           = False  # True: samo prikaz, bez obrade

# ─── Jezik ───────────────────────────────────────────────────────────────────
SOURCE_LANG       = "hr"
TARGET_LANG       = "hr"

# ─── Repo ────────────────────────────────────────────────────────────────────
REPO_URL  = "https://github.com/domovinatv/fetch.domovina.tv.git"
REPO_PATH = "/content/fetch.domovina.tv"

print("Konfiguracija učitana.")
print(f"  Input:    {INPUT_DIR}")
print(f"  Limit:    {LIMIT if LIMIT else 'sve'}")
print(f"  Dry run:  {DRY_RUN}")
print(f"  Lang:     {SOURCE_LANG} → {TARGET_LANG}")
print(f"  Output namespace: .sortformer.* (NE kolidira s .canary.*)")
"""))

    cells.append(md(r"""
## 1. GPU provjera

**G4 mandatory** zbog Canary VRAM zahtjeva. Sortformer sam treba <2 GB, ali Canary peak-a na ~26 GB.
"""))

    cells.append(code(r"""
import subprocess
out = subprocess.check_output(["nvidia-smi", "-L"]).decode().strip()
print(out)

mem = subprocess.check_output(
    ["nvidia-smi", "--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"]
).decode().strip()
total, free = [int(x.strip()) for x in mem.split(",")]
print(f"\nVRAM: {free} MB slobodno / {total} MB ukupno ({free/total*100:.0f}%)")

if total < 22000:
    print(f"\nUPOZORENJE: Manje od 22 GB VRAM ({total} MB) — Canary može OOM.")
    print("Idi na Runtime → Change runtime type → L4 (Pro) ili G4 (Pro+).")
"""))

    cells.append(md(r"""
## 2. Mount Google Drive
"""))

    cells.append(code(r"""
from google.colab import drive
drive.mount(DRIVE_MOUNT_POINT)

import os
assert os.path.isdir(INPUT_DIR), (
    f"Direktorij ne postoji: {INPUT_DIR}\n"
    f"Provjeri DRIVE_DATA_DIR ili da li su WAV-ovi uploadani."
)
n_entries = len(os.listdir(INPUT_DIR))
print(f"Drive mountan. INPUT_DIR sadrži: {n_entries} entry-ja.")
"""))

    cells.append(md(r"""
## 3. Clone / pull repo
"""))

    cells.append(code(r"""
import os, subprocess

if not os.path.isdir(REPO_PATH):
    print(f"Kloniram repo u {REPO_PATH}...")
    subprocess.run(["git", "clone", REPO_URL, REPO_PATH], check=True)
else:
    print("Repo postoji, povlačim najnovije...")
    subprocess.run(["git", "-C", REPO_PATH, "pull", "--ff-only"], check=True)

WORKHORSE_SCRIPT = f"{REPO_PATH}/colab_sortformer/transcribe_sortformer.py"
assert os.path.isfile(WORKHORSE_SCRIPT), f"Nedostaje skripta: {WORKHORSE_SCRIPT}"
print(f"Skripta spremna: {os.path.basename(WORKHORSE_SCRIPT)}")
"""))

    cells.append(md(r"""
## 4. Instalacija dependencija (~2-3 min)

NeMo toolkit sadrži i Canary i Sortformer. Prvi put gasi kernel radi reloada — nakon restarta klikni **Runtime → Run all** ponovno.
"""))

    cells.append(code(r"""
import os

MARKER = "/content/.sortformer_deps_ok"

def _have_deps():
    try:
        import nemo.collections.asr  # noqa: F401
        from nemo.collections.asr.models import SortformerEncLabelModel  # noqa: F401
        return True
    except Exception as e:
        print(f"deps check: {type(e).__name__}: {e}")
        return False

if os.path.exists(MARKER) and _have_deps():
    print("Dependencies već instalirani i spremni.")
else:
    print("Instaliram NeMo (sadrži Canary + Sortformer) — traje ~2-3 min...")
    get_ipython().system(
        'pip install -qU numpy "nemo_toolkit[asr]" 2>&1 | tail -5'
    )
    open(MARKER, "w").write("ok")
    print("")
    print("=" * 60)
    print(" Instalacija gotova — gasim kernel radi čistog reloada.")
    print(" → Nakon restarta klikni Runtime → Run all ponovno.")
    print("=" * 60)
    import time
    time.sleep(2)
    os.kill(os.getpid(), 9)
"""))

    cells.append(code(r"""
# Bezopasni shimovi za starije NeMo import path-eve
import sys
class _DummyYTTM: pass
sys.modules.setdefault("youtokentome", _DummyYTTM)

import huggingface_hub
if getattr(huggingface_hub, "ModelFilter", None) is None:
    class ModelFilter: pass
    huggingface_hub.ModelFilter = ModelFilter

import torch
print("torch:", torch.__version__,
      "| CUDA:", torch.cuda.is_available(),
      "|", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "NO GPU")
print("BF16 supported:", torch.cuda.is_bf16_supported() if torch.cuda.is_available() else False)
"""))

    cells.append(md(r"""
## 5. HuggingFace token

Sortformer model card zahtijeva prihvaćanje uvjeta — login s HF tokenom je potreban za `from_pretrained`. Token se učita iz Colab Secrets ili pita interaktivno.
"""))

    cells.append(code(r"""
HF_TOKEN = None
try:
    from google.colab import userdata
    HF_TOKEN = userdata.get("HF_TOKEN")
    if HF_TOKEN:
        print("HF_TOKEN učitan iz Colab Secrets.")
except Exception:
    pass

if not HF_TOKEN:
    from getpass import getpass
    HF_TOKEN = getpass("Upiši HuggingFace token (hf_...): ").strip()

assert HF_TOKEN and HF_TOKEN.startswith("hf_"), "HF_TOKEN nije valjan (mora počinjati s 'hf_')"
os.environ["HF_TOKEN"] = HF_TOKEN
os.environ["HUGGING_FACE_HUB_TOKEN"] = HF_TOKEN
print("HF_TOKEN spreman.")
"""))

    cells.append(md(r"""
## 6. Pregled posla (dry run)

Skenira Drive i prikazuje koliko WAV-ova je već obrađeno (ima `.sortformer.diarized.srt`) vs. koliko će se obraditi u ovom runu. Ne radi nikakvu obradu.

**Bitno**: ova ćelija broji `.sortformer.*` outpute, NE `.canary.*`. WAV-ovi koji su već obrađeni stable pipeline-om i dalje će biti procesirani ovdje (ako nemaju `.sortformer.diarized.srt`).
"""))

    cells.append(code(r"""
def scan_progress(input_dir):
    wavs, with_canary, with_sortformer = [], [], []
    for root, _, files in os.walk(input_dir, followlinks=True):
        for f in files:
            if f.startswith("._") or not f.endswith(".wav"):
                continue
            p = os.path.join(root, f)
            wavs.append(p)
            if os.path.exists(p + ".canary.diarized.srt"):
                with_canary.append(p)
            if os.path.exists(p + ".sortformer.diarized.srt"):
                with_sortformer.append(p)
    return wavs, with_canary, with_sortformer

print("Skeniram Drive (može potrajati ~30s za veliki korpus)...")
wavs, with_canary, with_sortformer = scan_progress(INPUT_DIR)
to_process = [w for w in wavs if w not in set(with_sortformer)]

print(f"\n  Ukupno WAV datoteka:                {len(wavs)}")
print(f"  Imaju .canary.diarized.srt (stable):  {len(with_canary)}")
print(f"  Imaju .sortformer.diarized.srt (ovo): {len(with_sortformer)}")
print(f"  Za obradu u ovom runu:                {len(to_process)}")

if LIMIT:
    print(f"\n  LIMIT={LIMIT} → obradit će se najviše {LIMIT} fajlova")

# ETA heuristika — Sortformer je vrlo brz (~realtime/N), Canary dominira
gpu_name = torch.cuda.get_device_name(0).lower() if torch.cuda.is_available() else ""
if "rtx pro 6000" in gpu_name or "g4" in gpu_name:
    sec_per_file = 25  # Canary ~13s + Sortformer ~10s + merge
elif "a100" in gpu_name:
    sec_per_file = 40
elif "l4" in gpu_name:
    sec_per_file = 90
else:
    sec_per_file = 150
n_to_run = min(LIMIT or 10**9, len(to_process))
if n_to_run:
    eta_min = n_to_run * sec_per_file / 60
    print(f"\n  Procjena trajanja na ovom GPU-u: ~{eta_min:.0f} min")
    print(f"  (heuristika: ~{sec_per_file}s/file × {n_to_run} fajla)")
"""))

    cells.append(md(r"""
## 7. Pokreni batch (Canary + Sortformer end-to-end)

Poziva `transcribe_sortformer.py` koji u jednom prolazu po fajlu:

1. Učita Canary 1B v2 (BF16) i Streaming Sortformer 4spk v2.1 (jednom, na početku)
2. Za svaki WAV: Canary transkripcija → Sortformer diarizacija → merge speakera u SRT (best-overlap)
3. Spremi `.sortformer.srt`, `.sortformer.csv`, `.sortformer.diarized.srt` na Drive
4. Heartbeat svakih 60s, ETA na osnovu prosjeka, nastavak pri grešci jednog fajla

Output ide odmah na Drive — ako želiš povući lokalno, dodaj odgovarajući rclone filter za `.sortformer.*`.
"""))

    cells.append(code(r"""
import shlex

cmd = [
    "python", "-u", WORKHORSE_SCRIPT,
    "--input-dir", INPUT_DIR,
    "--source-lang", SOURCE_LANG,
    "--target-lang", TARGET_LANG,
]
if LIMIT:
    cmd += ["--limit", str(LIMIT)]
if DRY_RUN:
    cmd += ["--dry-run"]

print(">", " ".join(shlex.quote(c) for c in cmd))
print()
get_ipython().system(" ".join(shlex.quote(c) for c in cmd))
"""))

    cells.append(md(r"""
## 8. Sažetak — što je novo na Drive-u

Delta novih `.sortformer.diarized.srt` u ovom runu.
"""))

    cells.append(code(r"""
wavs2, with_canary2, with_sortformer2 = scan_progress(INPUT_DIR)
new_sortformer = len(with_sortformer2) - len(with_sortformer)

print("─" * 60)
print(f"  Novih .sortformer.diarized.srt:  +{new_sortformer}")
print("─" * 60)
print(f"  Stanje na Drive-u:")
print(f"    {len(wavs2)} WAV ukupno")
print(f"    {len(with_canary2)}/{len(wavs2)} canary diarized (stable)")
print(f"    {len(with_sortformer2)}/{len(wavs2)} sortformer diarized (ovo)")
print()
print("Sljedeći koraci:")
print("  • Usporedi kvalitetu: pogledaj nekoliko ep001.wav.sortformer.diarized.srt")
print("    vs ep001.wav.canary.diarized.srt — koja je bolja za Croatian?")
print("  • Ako prihvatljiva: dodaj .sortformer.* u rclone sync filter")
print("  • Ako ne: stable pipeline (.canary.*) ostaje primarni")
"""))

    write_notebook(cells, SORTFORMER_NB_PATH, "sortformer-experimental")


# ─────────────────────────────────────────────────────────────────────────────
# 4) SORTFORMER DIARIZE-ONLY NOTEBOOK — Pass 2 of 2-pass scale workflow
# ─────────────────────────────────────────────────────────────────────────────

def build_sortformer_diarize_only_notebook():
    """Builds the Sortformer-only diarization notebook (Pass 2).

    Differs from the combined sortformer notebook:
      - Skips Canary entirely (reuses existing .canary.srt)
      - Calls diarize_only_sortformer.py instead of transcribe_sortformer.py
      - VRAM peak ~2 GB → fits free Colab T4 (16 GB), zero compute units cost
      - Same output: .sortformer.diarized.srt (drop-in compatible)
    """
    cells = []

    cells.append(md(r"""
# Domovina.tv — 🎭 Sortformer DIARIZE-ONLY *(Colab T4-friendly)*

**Pass 2 od 2-pass scale workflow-a.** Pokreće SAMO Sortformer diarizaciju nad postojećim `.canary.srt` datotekama.

```
Pass 1  (G4 / Pro+):  colab_canary/domovina_tv_fetch.ipynb        → .canary.srt        (~13s/file)
Pass 2  (T4 / FREE):  OVAJ NOTEBOOK                                → .sortformer.diarized.srt  (~3-5s/file)
```

## Zašto T4 staje (a u kombiniranom notebook-u nije)?

| Komponenta | VRAM peak | Staje na T4 (16 GB)? |
|---|---|---|
| Canary 1B v2 (transkripcija) | ~26 GB | ❌ OOM |
| Streaming Sortformer 4spk v2.1 | **~2 GB** | ✅ Lako |

Canary je taj koji zahtijeva G4. Bez njega — sve teče na free Colab T4 instanci. Ovo te troši **0 compute units** (T4 je free tier).

## Kad koristiti Pass 2 vs combined notebook (`domovina_tv_sortformer.ipynb`)

| Slučaj | Notebook |
|---|---|
| Imaš `.canary.srt` na Drive-u (već si pokrenuo Pass 1 ili stable canary pipeline) | **Ovaj** (jeftinije, brže) |
| Nemaš `.canary.srt` (greenfield batch) | `domovina_tv_sortformer.ipynb` (sve u jednom prolasku na G4) |
| Skaliranje na tisuće fajlova: razdvojeni runtime-ovi | Pass 1 + Pass 2 (paralelno na 2 računa) |

## Output

`{wav}.sortformer.diarized.srt` — **bit-identičan** onome što generira combined notebook (isti Canary tekst iz `.canary.srt`, isti Sortformer speakeri, isti merge algoritam). Drop-in kompatibilan s ostalim alatima.

## ⚠️ LICENCA

Streaming Sortformer 4spk v2.1 je pod [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/) (komercijalno OK uz uvjete). NE mijenjati na CC-BY-NC v1/v2 varijantu.

## Kako koristiti

1. **Runtime**: Runtime → Change runtime type → **T4** (free) — A100/L4/G4 rade ali su skuplji bez razloga.
2. **HF token**: Secrets panel → `HF_TOKEN` (potreban za skidanje Sortformer modela).
3. **Drive folder**: WAV+`.canary.srt` u `MyDrive/domovina_fetch_data/canary_wav/{kanal}/...`.
4. **Runtime → Run all**. Prvi put restart kernela nakon instalacije — pokreni opet.

---
"""))

    cells.append(md(r"""
## 0. Konfiguracija
"""))

    cells.append(code(r"""
# ─── Drive locations (isto kao stable canary pipeline) ─────────────────────
DRIVE_MOUNT_POINT = "/content/drive"
DRIVE_DATA_DIR    = "MyDrive/domovina_fetch_data/canary_wav"
INPUT_DIR         = f"{DRIVE_MOUNT_POINT}/{DRIVE_DATA_DIR}"

# ─── Batch limits ────────────────────────────────────────────────────────────
LIMIT             = None   # int ili None — npr. 5 za testiranje
DRY_RUN           = False  # True: samo prikaz, bez obrade

# ─── Repo ────────────────────────────────────────────────────────────────────
REPO_URL  = "https://github.com/domovinatv/fetch.domovina.tv.git"
REPO_PATH = "/content/fetch.domovina.tv"

print("Konfiguracija učitana.")
print(f"  Input:    {INPUT_DIR}")
print(f"  Limit:    {LIMIT if LIMIT else 'sve'}")
print(f"  Dry run:  {DRY_RUN}")
print(f"  Output:   .sortformer.diarized.srt (drop-in kompatibilan s combined notebookom)")
"""))

    cells.append(md(r"""
## 1. GPU provjera

**T4 (16 GB) je dovoljan** — Sortformer peak-a na ~2 GB. Ako runtime ima G4/A100, radit će ali bezveze plaćanje units-a.
"""))

    cells.append(code(r"""
import subprocess
out = subprocess.check_output(["nvidia-smi", "-L"]).decode().strip()
print(out)

mem = subprocess.check_output(
    ["nvidia-smi", "--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"]
).decode().strip()
total, free = [int(x.strip()) for x in mem.split(",")]
print(f"\nVRAM: {free} MB slobodno / {total} MB ukupno ({free/total*100:.0f}%)")

if total < 6000:
    print(f"\nUPOZORENJE: Manje od 6 GB VRAM ({total} MB) — može biti tijesno.")
elif total > 24000:
    print(f"\nℹ️  Imamo {total} MB VRAM-a — više nego dovoljno za Sortformer (~2 GB).")
    print("   Razmisli o downgrade-u na T4 (free) za skaliranje na tisućama fajlova.")
"""))

    cells.append(md(r"""
## 2. Mount Google Drive
"""))

    cells.append(code(r"""
from google.colab import drive
drive.mount(DRIVE_MOUNT_POINT)

import os
assert os.path.isdir(INPUT_DIR), (
    f"Direktorij ne postoji: {INPUT_DIR}\n"
    f"Provjeri DRIVE_DATA_DIR ili da li su WAV+canary.srt uploadani."
)
n_entries = len(os.listdir(INPUT_DIR))
print(f"Drive mountan. INPUT_DIR sadrži: {n_entries} entry-ja.")
"""))

    cells.append(md(r"""
## 3. Clone / pull repo
"""))

    cells.append(code(r"""
import os, subprocess

if not os.path.isdir(REPO_PATH):
    print(f"Kloniram repo u {REPO_PATH}...")
    subprocess.run(["git", "clone", REPO_URL, REPO_PATH], check=True)
else:
    print("Repo postoji, povlačim najnovije...")
    subprocess.run(["git", "-C", REPO_PATH, "pull", "--ff-only"], check=True)

WORKHORSE_SCRIPT = f"{REPO_PATH}/colab_sortformer/diarize_only_sortformer.py"
assert os.path.isfile(WORKHORSE_SCRIPT), f"Nedostaje skripta: {WORKHORSE_SCRIPT}"
print(f"Skripta spremna: {os.path.basename(WORKHORSE_SCRIPT)}")
"""))

    cells.append(md(r"""
## 4. Instalacija dependencija (~2-3 min)

NeMo toolkit (sadrži Sortformer). Prvi put gasi kernel radi reloada — nakon restarta klikni **Runtime → Run all** ponovno.
"""))

    cells.append(code(r"""
import os

MARKER = "/content/.sortformer_diarize_only_deps_ok"

def _have_deps():
    try:
        import nemo.collections.asr  # noqa: F401
        from nemo.collections.asr.models import SortformerEncLabelModel  # noqa: F401
        return True
    except Exception as e:
        print(f"deps check: {type(e).__name__}: {e}")
        return False

if os.path.exists(MARKER) and _have_deps():
    print("Dependencies već instalirani i spremni.")
else:
    print("Instaliram NeMo — traje ~2-3 min...")
    get_ipython().system(
        'pip install -qU numpy "nemo_toolkit[asr]" 2>&1 | tail -5'
    )
    open(MARKER, "w").write("ok")
    print("")
    print("=" * 60)
    print(" Instalacija gotova — gasim kernel radi čistog reloada.")
    print(" → Nakon restarta klikni Runtime → Run all ponovno.")
    print("=" * 60)
    import time
    time.sleep(2)
    os.kill(os.getpid(), 9)
"""))

    cells.append(code(r"""
# Bezopasni shimovi za starije NeMo import path-eve
import sys
class _DummyYTTM: pass
sys.modules.setdefault("youtokentome", _DummyYTTM)

import huggingface_hub
if getattr(huggingface_hub, "ModelFilter", None) is None:
    class ModelFilter: pass
    huggingface_hub.ModelFilter = ModelFilter

import torch
print("torch:", torch.__version__,
      "| CUDA:", torch.cuda.is_available(),
      "|", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "NO GPU")
"""))

    cells.append(md(r"""
## 5. HuggingFace token

Sortformer model card zahtijeva prihvaćanje uvjeta — login s HF tokenom je potreban za `from_pretrained`.
"""))

    cells.append(code(r"""
HF_TOKEN = None
try:
    from google.colab import userdata
    HF_TOKEN = userdata.get("HF_TOKEN")
    if HF_TOKEN:
        print("HF_TOKEN učitan iz Colab Secrets.")
except Exception:
    pass

if not HF_TOKEN:
    from getpass import getpass
    HF_TOKEN = getpass("Upiši HuggingFace token (hf_...): ").strip()

assert HF_TOKEN and HF_TOKEN.startswith("hf_"), "HF_TOKEN nije valjan (mora počinjati s 'hf_')"
os.environ["HF_TOKEN"] = HF_TOKEN
os.environ["HUGGING_FACE_HUB_TOKEN"] = HF_TOKEN
print("HF_TOKEN spreman.")
"""))

    cells.append(md(r"""
## 6. Pregled posla (dry run)

Skenira Drive i prikazuje:
- Koliko WAV-ova ima `.canary.srt` (preduvjet za Pass 2)
- Koliko ima `.sortformer.diarized.srt` (već gotovo)
- Koliko će se obraditi u ovom runu

**WAV-ovi bez `.canary.srt` se ignoriraju** — prvo pokreni Pass 1 (`colab_canary/domovina_tv_fetch.ipynb`) za njih.
"""))

    cells.append(code(r"""
def scan_progress(input_dir):
    wavs, with_canary, with_sortformer = [], [], []
    for root, _, files in os.walk(input_dir, followlinks=True):
        for f in files:
            if f.startswith("._") or not f.endswith(".wav"):
                continue
            p = os.path.join(root, f)
            wavs.append(p)
            if os.path.exists(p + ".canary.srt"):
                with_canary.append(p)
            if os.path.exists(p + ".sortformer.diarized.srt"):
                with_sortformer.append(p)
    return wavs, with_canary, with_sortformer

print("Skeniram Drive (može potrajati ~30s za veliki korpus)...")
wavs, with_canary, with_sortformer = scan_progress(INPUT_DIR)
without_canary = len(wavs) - len(with_canary)
to_process = [w for w in with_canary if w not in set(with_sortformer)]

print(f"\n  Ukupno WAV datoteka:                  {len(wavs)}")
print(f"  Imaju .canary.srt (preduvjet):        {len(with_canary)}")
if without_canary > 0:
    print(f"  ⚠️  Bez .canary.srt (treba Pass 1):  {without_canary}")
print(f"  Imaju .sortformer.diarized.srt:       {len(with_sortformer)}")
print(f"  Za obradu u ovom runu:                {len(to_process)}")

if LIMIT:
    print(f"\n  LIMIT={LIMIT} → obradit će se najviše {LIMIT} fajlova")

# ETA — Sortformer alone vrlo brz (~3-5s/file na T4 za podcast 1-3h)
gpu_name = torch.cuda.get_device_name(0).lower() if torch.cuda.is_available() else ""
if "t4" in gpu_name:
    sec_per_file = 6   # T4 je sporiji za neuralni inference, ~realtime/N
elif "l4" in gpu_name:
    sec_per_file = 4
elif "a100" in gpu_name or "rtx pro 6000" in gpu_name or "g4" in gpu_name:
    sec_per_file = 3
else:
    sec_per_file = 10
n_to_run = min(LIMIT or 10**9, len(to_process))
if n_to_run:
    eta_min = n_to_run * sec_per_file / 60
    print(f"\n  Procjena trajanja na ovom GPU-u: ~{eta_min:.0f} min")
    print(f"  (heuristika: ~{sec_per_file}s/file × {n_to_run} fajla)")
"""))

    cells.append(md(r"""
## 7. Pokreni Sortformer batch (diarize-only)

Poziva `diarize_only_sortformer.py` koji:

1. Učita Streaming Sortformer 4spk v2.1 (jednom, na početku) — **NE učitava Canary**
2. Za svaki WAV: parsira postojeći `.canary.srt` → Sortformer diarizacija → merge speakera
3. Spremi `.sortformer.diarized.srt` na Drive
4. Heartbeat svakih 60s, ETA na osnovu prosjeka, nastavak pri grešci jednog fajla
"""))

    cells.append(code(r"""
import shlex

cmd = [
    "python", "-u", WORKHORSE_SCRIPT,
    "--input-dir", INPUT_DIR,
]
if LIMIT:
    cmd += ["--limit", str(LIMIT)]
if DRY_RUN:
    cmd += ["--dry-run"]

print(">", " ".join(shlex.quote(c) for c in cmd))
print()
get_ipython().system(" ".join(shlex.quote(c) for c in cmd))
"""))

    cells.append(md(r"""
## 8. Sažetak — što je novo na Drive-u

Delta novih `.sortformer.diarized.srt` u ovom runu.
"""))

    cells.append(code(r"""
wavs2, with_canary2, with_sortformer2 = scan_progress(INPUT_DIR)
new_sortformer = len(with_sortformer2) - len(with_sortformer)

print("─" * 60)
print(f"  Novih .sortformer.diarized.srt:  +{new_sortformer}")
print("─" * 60)
print(f"  Stanje na Drive-u:")
print(f"    {len(wavs2)} WAV ukupno")
print(f"    {len(with_canary2)}/{len(wavs2)} ima .canary.srt")
print(f"    {len(with_sortformer2)}/{len(with_canary2)} sortformer diarized")
print()
remaining = len(with_canary2) - len(with_sortformer2)
if remaining > 0:
    print(f"  Još {remaining} fajlova s .canary.srt čeka diarizaciju —")
    print(f"  pokreni notebook ponovno (idempotentno).")
else:
    print("  ✅ Sve .canary.srt datoteke su diarized!")
"""))

    write_notebook(cells, SORTFORMER_DIARIZE_ONLY_NB_PATH, "sortformer-diarize-only")


build_sortformer_notebook()
build_sortformer_diarize_only_notebook()
