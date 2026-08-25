#!/usr/bin/env python3
"""
diarize_canary.py — pyannote community-1 speaker diarization na Google Colab GPU

Koristi pyannote/speaker-diarization-community-1 (v4.0, CC-BY-4.0 licenca)
s exclusive_speaker_diarization modom za čist SRT alignment (jedan govornik
u svakom trenutku — nema overlapa, idealno za titlove).

Diarizacija WAV datoteka koje imaju postojeće .canary.srt transkripte.
Generira .canary.diarized.srt sa [SPEAKER_XX] oznakama ispred svakog segmenta.

NIKADA ne briše ili prepisuje postojeće datoteke.

=== Google Colab ===
  1. WAV datoteke i .canary.srt već na Google Drive (iz transcribe_canary.py)
  2. Otvori Colab, odaberi GPU runtime (T4 je dovoljno za diarizaciju, ~9.5 GB VRAM)
  3. Pokreni:
     !pip install pyannote.audio
     !python diarize_canary.py --input-dir /content/drive/MyDrive/domovina_fetch_data/canary_wav

Primjeri:
  python diarize_canary.py --input-dir ./wav_files --dry-run
  python diarize_canary.py --input-dir ./wav_files --limit 5
  python diarize_canary.py --file /path/to/audio.wav
"""

import argparse
import multiprocessing
import os
import re
import signal
import sys
import time
from datetime import timedelta
from pathlib import Path


# ─── Sufiksi ───
CANARY_SRT_SUFFIX = ".canary.srt"
DIARIZED_SRT_SUFFIX = ".canary.diarized.srt"


# ─── SRT parsing ───

def parse_srt(srt_path):
    """Parsira SRT datoteku i vraća listu segmenata."""
    with open(srt_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    pattern = re.compile(
        r"(\d+)\s*\n"
        r"(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*\n"
        r"((?:(?!\n\n|\n\d+\s*\n).)*)",
        re.DOTALL
    )

    segments = []
    for match in pattern.finditer(content):
        idx = int(match.group(1))
        start_str = match.group(2).replace(",", ".")
        end_str = match.group(3).replace(",", ".")
        text = match.group(4).strip()

        start_sec = timestamp_to_seconds(start_str)
        end_sec = timestamp_to_seconds(end_str)

        segments.append({
            "index": idx,
            "start": start_sec,
            "end": end_sec,
            "text": text
        })

    return segments


def timestamp_to_seconds(ts):
    """Konvertira HH:MM:SS.mmm u sekunde."""
    parts = ts.split(":")
    h = int(parts[0])
    m = int(parts[1])
    s_parts = parts[2].split(".")
    s = int(s_parts[0])
    ms = int(s_parts[1]) if len(s_parts) > 1 else 0
    return h * 3600 + m * 60 + s + ms / 1000.0


def seconds_to_srt_timestamp(sec):
    """Konvertira sekunde u SRT format HH:MM:SS,mmm."""
    sec = max(0.0, sec)
    td = timedelta(seconds=sec)
    total_seconds = int(td.total_seconds())
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    millis = int((sec - int(sec)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def format_duration(seconds):
    """Formatira trajanje u čitljiv format."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h}h {m}m {s}s"


# ─── Indikator napretka (P2) + nadzornik stroja (P3) ───
# SSOT obrasca: sabor_pipeline/02_diarize.py. Ovdje je kopiran namjerno — ova
# skripta se pokreće standalone (Colab, GCP VM, Mac Mini), pa ne smije ovisiti
# o drugom modulu iz repoa.

class LogProgressHook:
    """pyannote hook koji piše OBIČNE log retke (bez ANSI-ja).

    Zašto ne `pyannote.audio.pipelines.utils.hook.ProgressHook`: on crta `rich`
    progress bar, a nightly ide u launchd log koji se poslije čita grepom — ANSI
    escape sekvence ondje su smeće (docs/pipeline_observability_2026-07.md).

    `completed`/`total` za korak "segmentation" su redni brojevi PROZORA nad
    snimkom, pa se iz njih čita stvarna pozicija u snimci. Za ostale korake
    (embeddings) to su batchevi, pa se ispisuje samo postotak — nije pozicija i
    ne smije se tako predstaviti.
    """

    def __init__(self, prefix="", duration_s=None, min_interval_s=60, sink=None):
        self.prefix = prefix
        self.duration_s = duration_s
        self.min_interval_s = min_interval_s
        self.sink = sink                  # callback(step_name, fraction) — za nadzornika
        self.t0 = time.time()
        self._step = None
        self._step_t0 = self.t0
        self._last_print = 0.0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    @staticmethod
    def _hms(sec):
        sec = max(0, int(sec))
        return f"{sec // 3600}:{(sec % 3600) // 60:02d}:{sec % 60:02d}"

    def __call__(self, step_name, step_artifact, file=None, total=None, completed=None):
        now = time.time()

        if step_name != self._step:
            self._step = step_name
            self._step_t0 = now
            self._last_print = 0.0
            print(f"{self.prefix}   ▶ korak: {step_name} "
                  f"(+{self._hms(now - self.t0)} od starta)", flush=True)

        if not total or completed is None:
            return

        frac = min(1.0, max(0.0, completed / total))
        if self.sink:
            try:
                self.sink(step_name, frac)
            except Exception:
                pass

        if frac < 1.0 and (now - self._last_print) < self.min_interval_s:
            return
        self._last_print = now

        step_elapsed = now - self._step_t0
        eta = (step_elapsed / frac - step_elapsed) if frac > 0 else 0
        where = ""
        if step_name == "segmentation" and self.duration_s:
            where = f" | pozicija ≈ {self._hms(frac * self.duration_s)} / {self._hms(self.duration_s)}"
        print(f"{self.prefix}     {step_name} {frac * 100:5.1f}% "
              f"({completed}/{total}){where} | ETA koraka {self._hms(eta)}", flush=True)


def wav_duration_s(wav_file):
    """Trajanje WAV-a iz zaglavlja (bez učitavanja uzoraka). None ako ne uspije."""
    try:
        import soundfile as sf
        info = sf.info(wav_file)
        return info.frames / float(info.samplerate)
    except Exception:
        return None


# ─── Nadzornik stroja (P3) ───
# Nightly diarizira u 03:00 bez ikoga za tipkovnicom. Kad alokacija prelije RAM,
# macOS raste swap NA SISTEMSKOM DISKU; kad se on napuni, ruše se i nevezani
# procesi (Docker daemon zna ostati u stanju iz kojeg se diže samo restartom
# stroja). Obrana ne mijenja rezultat — samo pretvara najgori ishod iz
# "stroj traži restart" u "epizoda nije diarizirana".
# Obrazac je preuzet iz sabor_pipeline/02_diarize.py (ondje je SSOT).

GUARD_MIN_FREE_DISK_GB = 12.0     # ispod ovoga slobodno na `/` → prekid
GUARD_RSS_CAP_GB = 15.0           # RSS nadziranih procesa iznad ovoga → prekid
GUARD_CHECK_INTERVAL_S = 30
PROGRESS_INTERVAL_S = 60          # postavlja main() / _worker_init iz --progress-interval


def free_disk_gb(path="/"):
    import shutil
    return shutil.disk_usage(path).free / 2**30


def rss_gb(pid):
    """RSS procesa u GB. 0.0 ako proces više ne postoji."""
    import subprocess
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=5)
        return int(out.stdout.strip()) / 2**20   # ps daje KB
    except Exception:
        return 0.0


def swap_usage():
    """(total_gb, used_gb) na macOS-u; (0, 0) drugdje — nije fatalno."""
    import subprocess
    if sys.platform != "darwin":
        return 0.0, 0.0
    try:
        out = subprocess.run(["sysctl", "-n", "vm.swapusage"],
                             capture_output=True, text=True, timeout=5)
        tot = used = 0.0
        parts = out.stdout.replace("=", " ").split()
        for i, part in enumerate(parts):
            if part == "total" and i + 1 < len(parts):
                tot = float(parts[i + 1].rstrip("M")) / 1024
            if part == "used" and i + 1 < len(parts):
                used = float(parts[i + 1].rstrip("M")) / 1024
        return tot, used
    except Exception:
        return 0.0, 0.0


class MachineGuard:
    """Dretva koja mjeri disk i RSS, pa ispod praga prekida posao.

    `pids_fn()` vraća listu PID-ova koje treba mjeriti (self kod sekvencijalnog
    puta, workeri kod paralelnog). `abort_fn(reason)` obavlja stvarni prekid —
    razlikuje se po putu, pa ga zna samo pozivatelj.
    """

    def __init__(self, pids_fn, abort_fn, min_free_disk_gb=GUARD_MIN_FREE_DISK_GB,
                 rss_cap_gb=GUARD_RSS_CAP_GB, interval_s=GUARD_CHECK_INTERVAL_S):
        import threading
        self.pids_fn = pids_fn
        self.abort_fn = abort_fn
        self.min_free_disk_gb = min_free_disk_gb
        self.rss_cap_gb = rss_cap_gb
        self.interval_s = interval_s
        self.peak_rss_gb = 0.0
        self.min_free_disk_seen_gb = free_disk_gb()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def start(self):
        print(f"   Nadzornik stroja: disk >= {self.min_free_disk_gb:.0f} GB, "
              f"RSS <= {self.rss_cap_gb:.0f} GB, provjera svakih {self.interval_s}s", flush=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()

    def _loop(self):
        while not self._stop.wait(self.interval_s):
            disk = free_disk_gb()
            self.min_free_disk_seen_gb = min(self.min_free_disk_seen_gb, disk)
            rss_total = sum(rss_gb(pid) for pid in self.pids_fn())
            self.peak_rss_gb = max(self.peak_rss_gb, rss_total)

            if disk < self.min_free_disk_gb:
                sw_tot, sw_used = swap_usage()
                self.abort_fn(
                    f"slobodno na / palo na {disk:.1f} GB (prag {self.min_free_disk_gb:.0f} GB)"
                    f" | RSS {rss_total:.1f} GB | swap {sw_used:.1f}/{sw_tot:.1f} GB")
                return
            if rss_total > self.rss_cap_gb:
                self.abort_fn(
                    f"RSS diarizacije {rss_total:.1f} GB premasio prag {self.rss_cap_gb:.0f} GB"
                    f" | slobodno na / {disk:.1f} GB")
                return


def guard_enabled(mode):
    """auto = ukljuceno na macOS-u (ondje swap ide na sistemski disk)."""
    if mode == "on":
        return True
    if mode == "off":
        return False
    return sys.platform == "darwin"


# ─── Diarizacija ───

def install_dependencies():
    """Provjerava i instalira pyannote.audio ako nije prisutan."""
    try:
        import pyannote.audio  # noqa: F401
        print("   pyannote.audio je već instaliran")
    except ImportError:
        print("   Instaliram pyannote.audio...")
        os.system("pip install pyannote.audio")
        print("   pyannote.audio instaliran")


def get_hf_token(args_token):
    """Dohvaća HuggingFace token iz argumenata, Colab secrets, ili env varijable."""
    # 1. CLI argument
    if args_token:
        return args_token

    # 2. Colab secrets (userdata)
    try:
        from google.colab import userdata
        token = userdata.get("HF_TOKEN")
        if token:
            print("   HF token učitan iz Colab Secrets")
            return token
    except (ImportError, Exception):
        pass

    # 3. Environment varijabla
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if token:
        print("   HF token učitan iz environment varijable")
        return token

    # 4. Cached HuggingFace token (~/.cache/huggingface/token) — isti file koji
    #    huggingface_hub koristi. Omogućava nightly diarizaciju bez --hf-token flaga.
    try:
        cached = os.path.expanduser("~/.cache/huggingface/token")
        if os.path.exists(cached):
            with open(cached) as f:
                token = f.read().strip()
            if token:
                print("   HF token učitan iz ~/.cache/huggingface/token")
                return token
    except Exception:
        pass

    print("   HuggingFace token nije pronađen!")
    print("   Opcije:")
    print("     1. Colab Secrets: dodaj HF_TOKEN u Secrets (lijevi panel)")
    print("     2. CLI: --hf-token TVOJ_TOKEN")
    print("     3. Environment: export HF_TOKEN=TVOJ_TOKEN")
    print("")
    print("   Token je potreban za pyannote/speaker-diarization-community-1 model.")
    print("   Kreiraj ga na: https://huggingface.co/settings/tokens")
    print("   Prihvati uvjete na: https://huggingface.co/pyannote/speaker-diarization-community-1")
    sys.exit(1)


def load_diarization_pipeline(hf_token):
    """Učitava pyannote community-1 diarization pipeline na GPU (~9.5 GB VRAM)."""
    import torch
    from pyannote.audio import Pipeline

    if torch.cuda.is_available():
        device = "cuda"
        vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        gpu_name = torch.cuda.get_device_name(0)
        print(f"   Uređaj: CUDA — {gpu_name} ({vram_gb:.1f} GB VRAM)")
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = "mps"
        print(f"   Uređaj: MPS (Apple Silicon)")
    else:
        device = "cpu"
        print("   Uređaj: CPU")
        print("   UPOZORENJE: GPU nije dostupan! Diarizacija će biti spora.")
        print("   Na Colabu: Runtime > Change runtime type > T4 GPU")

    print("   Učitavam pyannote/speaker-diarization-community-1 model...")
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-community-1",
        token=hf_token
    )
    pipeline.to(torch.device(device))
    print("   Model učitan (community-1, exclusive diarization mode)")

    return pipeline, device


def run_diarization(pipeline, wav_file, min_speakers=None, max_speakers=None,
                    audio_input_mode="waveform", progress_prefix="",
                    progress_interval=None):
    """Pokreće pyannote community-1 diarizaciju na jednom WAV fajlu.

    Koristi exclusive_speaker_diarization mode koji daje točno jednog govornika
    u svakom trenutku (bez overlapa), idealno za alignment s SRT titlovima.

    `audio_input_mode` (P1, uveden i POVUČEN istog dana 2026-08-25):
      "waveform" — ISPRAVAN put i jedini koji se koristi. Cijela snimka se učita u
                   RAM (`sf.read(..., dtype="float32")` — bez `dtype` je float64 pa
                   `.float()` radi drugu kopiju, 3× memorije) i preda kao dict.
                   To je SLUŽBENA preporuka pyannotea: model card za community-1
                   („Pre-loading audio files in memory may result in faster
                   processing") i odgovor tima u issueu #1955, gdje je prijavitelj
                   izmjerio 1053.9 s → 49.8 s (21×).
      "path"     — POVUČENO. Izgledalo je kao ušteda memorije; nije. `Inference.
                   __call__` ionako zove `decoder.get_all_samples()` i učita cijeli
                   waveform za segmentaciju, pa je memorija ista. Uz to `Audio.crop()`
                   stvara NOVI AudioDecoder po pozivu, a torchcodec < 0.14 premotava
                   na početak datoteke (PR #1449; mi imamo 0.10.0) — mjereno na 20 h
                   WAV-u: crop na 0 h = 4.3 ms, na 15 h = 3508 ms, integrirano 8–15 h
                   samo dekodiranja. Zastavica ostaje samo radi ponovljivosti mjerenja.
                   Vidi docs/pipeline_memorija_i_propusnost_2026-08.md §5.1–§5.3.
    """
    import torch
    import soundfile as sf

    # Parametri
    diarize_params = {}
    if min_speakers is not None:
        diarize_params["min_speakers"] = min_speakers
    if max_speakers is not None:
        diarize_params["max_speakers"] = max_speakers

    hook = LogProgressHook(prefix=progress_prefix,
                           duration_s=wav_duration_s(wav_file),
                           min_interval_s=progress_interval or PROGRESS_INTERVAL_S)

    if audio_input_mode == "path":
        # ⚠️ POVUCENI put — ista ograda kao u diarize.py. Na 20 h snimci put preko
        # putanje znaci 8-15 h SAMO dekodiranja (torchcodec < 0.14 premotava na
        # pocetak datoteke pri svakom cropu), a memoriju ne stedi jer `Inference`
        # svejedno zove `get_all_samples()`. Vidi §5.1-5.3.
        _dur = wav_duration_s(wav_file) or 0.0
        if _dur > PATH_MODE_MAX_DURATION_S and not os.environ.get("DIARIZE_ALLOW_SLOW_PATH"):
            raise RuntimeError(
                f"--audio-input path odbijen: snimka je {_dur/3600:.2f} h, granica "
                f"{PATH_MODE_MAX_DURATION_S/3600:.0f} h. Taj put je POVUCEN — koristi "
                f"default (waveform). Za ponavljanje mjerenja: DIARIZE_ALLOW_SLOW_PATH=1")
        with hook:
            result = pipeline(wav_file, hook=hook, **diarize_params)
        data = waveform = audio_input = None
    else:
        # Učitaj audio
        # dtype="float32" — bez njega sf.read vraća float64 pa .float() radi drugu kopiju
        # (3× memorije). Vidi isti komentar u diarize.py; mjereno 2026-08-25.
        data, sample_rate = sf.read(wav_file, dtype="float32")
        waveform = torch.from_numpy(data).float().unsqueeze(0)

        # Pokreni diarizaciju
        audio_input = {"waveform": waveform, "sample_rate": sample_rate}
        with hook:
            result = pipeline(audio_input, hook=hook, **diarize_params)

    # Oslobodi waveform iz memorije (100+ MB za velike fajlove)
    del waveform, data, audio_input

    # community-1 (pyannote 4.x) vraća DiarizeOutput dataclass:
    #   result.speaker_diarization          — puna diarizacija s overlapima
    #   result.exclusive_speaker_diarization — jedan govornik u svakom trenutku
    # Koristimo exclusive mode za čist SRT alignment
    if hasattr(result, 'exclusive_speaker_diarization'):
        diarization = result.exclusive_speaker_diarization
    elif hasattr(result, 'speaker_diarization'):
        # Fallback na regularnu diarizaciju ako exclusive nije dostupan
        diarization = result.speaker_diarization
    else:
        # Legacy pyannote (<4.0) vraća Annotation direktno
        diarization = result

    # Konvertiraj u listu segmenata
    speaker_segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        speaker_segments.append({
            "start": turn.start,
            "end": turn.end,
            "speaker": speaker
        })

    # Broj govornika iz pune diarizacije (za statistiku)
    num_speakers = len(set(s["speaker"] for s in speaker_segments))

    return speaker_segments, num_speakers


def assign_speakers(srt_segments, speaker_segments):
    """Za svaki SRT segment, pronađi govornika s najvećim overlapom."""
    for seg in srt_segments:
        best_speaker = "UNKNOWN"
        best_overlap = 0.0

        for spk in speaker_segments:
            overlap_start = max(seg["start"], spk["start"])
            overlap_end = min(seg["end"], spk["end"])
            overlap = max(0, overlap_end - overlap_start)

            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = spk["speaker"]

        seg["speaker"] = best_speaker

    return srt_segments


def write_diarized_srt(segments, output_path):
    """Zapisuje SRT s oznakama govornika."""
    with open(output_path, "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, 1):
            start_ts = seconds_to_srt_timestamp(seg["start"])
            end_ts = seconds_to_srt_timestamp(seg["end"])
            speaker = seg.get("speaker", "UNKNOWN")

            f.write(f"{i}\n")
            f.write(f"{start_ts} --> {end_ts}\n")
            f.write(f"[{speaker}] {seg['text']}\n")
            f.write("\n")


# ─── Parallel worker ───

_worker_pipeline = None
_worker_min_speakers = None
_worker_max_speakers = None
# Iznad ove duljine se povuceni `--audio-input path` odbija.
PATH_MODE_MAX_DURATION_S = 7200.0   # 2 h

_worker_audio_input_mode = "waveform"
_worker_rclone_dest = None
_worker_drive_mount = None
_worker_input_dir = None


def _worker_init(hf_token, min_speakers, max_speakers, threads_per_worker=2,
                 rclone_dest=None, drive_mount=None, input_dir=None,
                 audio_input_mode="waveform", progress_interval=PROGRESS_INTERVAL_S):
    """Inicijalizacija worker procesa — svaki učitava vlastiti pyannote pipeline.

    Na CPU-only stroju, ograničava PyTorch/MKL/OMP threadove po workeru
    da spriječi oversubscription (npr. 40 workera × 80 threadova = 3200 threadova na 80 CPU).
    """
    global _worker_pipeline, _worker_min_speakers, _worker_max_speakers
    global _worker_audio_input_mode

    # Suppress torchcodec/pyannote warnings u worker procesima
    import warnings
    warnings.filterwarnings("ignore", message="torchcodec is not installed")
    warnings.filterwarnings("ignore", message="std\\(\\): degrees of freedom")

    # VAŽNO: env vars moraju biti postavljene PRIJE import torch,
    # jer PyTorch/OMP/MKL čitaju ih pri inicijalizaciji
    os.environ["OMP_NUM_THREADS"] = str(threads_per_worker)
    os.environ["MKL_NUM_THREADS"] = str(threads_per_worker)
    os.environ["OPENBLAS_NUM_THREADS"] = str(threads_per_worker)
    os.environ["NUMEXPR_NUM_THREADS"] = str(threads_per_worker)

    import torch
    from pyannote.audio import Pipeline

    torch.set_num_threads(threads_per_worker)
    torch.set_num_interop_threads(1)

    if torch.cuda.is_available():
        device = "cuda"
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-community-1",
        token=hf_token
    )
    pipeline.to(torch.device(device))

    _worker_pipeline = pipeline
    _worker_min_speakers = min_speakers
    _worker_max_speakers = max_speakers
    _worker_audio_input_mode = audio_input_mode
    global PROGRESS_INTERVAL_S
    PROGRESS_INTERVAL_S = progress_interval
    global _worker_rclone_dest, _worker_drive_mount, _worker_input_dir
    _worker_rclone_dest = rclone_dest
    _worker_drive_mount = drive_mount
    _worker_input_dir = input_dir


def _worker_diarize(wav_file):
    """Worker funkcija: diarizira jedan fajl. Vraća (wav_file, result)."""
    global _worker_pipeline, _worker_min_speakers, _worker_max_speakers
    global _worker_rclone_dest, _worker_drive_mount, _worker_input_dir
    global _worker_audio_input_mode
    import threading

    wav_dir = os.path.dirname(wav_file)
    basename = os.path.basename(wav_file)
    srt_input = os.path.join(wav_dir, basename + CANARY_SRT_SUFFIX)
    diarized_output = os.path.join(wav_dir, basename + DIARIZED_SRT_SUFFIX)
    pid = os.getpid()

    if os.path.exists(diarized_output):
        return wav_file, {"status": "skipped", "reason": "already exists"}
    if not os.path.exists(srt_input):
        return wav_file, {"status": "skipped", "reason": "no .canary.srt"}

    # Distributed lock provjera u workeru
    use_lock = bool(_worker_rclone_dest or _worker_drive_mount)
    if use_lock:
        lock_status = None
        if _worker_rclone_dest:
            lock_status = _lock_exists_remote(wav_file, _worker_input_dir, _worker_rclone_dest)
        elif _worker_drive_mount:
            lock_status = _lock_exists_mount(wav_file, _worker_drive_mount)

        if lock_status == "diarized":
            return wav_file, {"status": "skipped", "reason": "already diarized on Drive"}
        elif lock_status == "locked":
            return wav_file, {"status": "skipped", "reason": "locked by another worker"}

        if _worker_rclone_dest:
            _create_lock_remote(wav_file, _worker_input_dir, _worker_rclone_dest)
        elif _worker_drive_mount:
            _create_lock_mount(wav_file)

    file_size_mb = os.path.getsize(wav_file) / (1024 * 1024)
    print(f"      [W{pid}] START {basename} ({file_size_mb:.0f} MB)", flush=True)

    start_time = time.time()
    # Heartbeat: ispiši napredak svake 60 sekundi dok traje diarizacija
    heartbeat_stop = threading.Event()

    def _heartbeat():
        while not heartbeat_stop.wait(60):
            elapsed = time.time() - start_time
            print(f"      [W{pid}] ...   {basename} {elapsed:.0f}s", flush=True)

    hb_thread = threading.Thread(target=_heartbeat, daemon=True)
    hb_thread.start()

    try:
        srt_segments = parse_srt(srt_input)
        if not srt_segments:
            heartbeat_stop.set()
            if use_lock:
                if _worker_rclone_dest:
                    _remove_lock_remote(wav_file, _worker_input_dir, _worker_rclone_dest)
                elif _worker_drive_mount:
                    _remove_lock_mount(wav_file)
            return wav_file, {"status": "error", "reason": "empty .canary.srt", "elapsed": 0}

        speaker_segments, num_speakers = run_diarization(
            _worker_pipeline, wav_file,
            min_speakers=_worker_min_speakers,
            max_speakers=_worker_max_speakers,
            audio_input_mode=_worker_audio_input_mode,
            progress_prefix=f"      [W{pid}]"
        )

        srt_segments = assign_speakers(srt_segments, speaker_segments)
        elapsed = time.time() - start_time
        heartbeat_stop.set()

        if not os.path.exists(diarized_output):
            write_diarized_srt(srt_segments, diarized_output)

        # Upload + ukloni lock
        if _worker_rclone_dest:
            _bg_rclone_upload(diarized_output, _worker_rclone_dest, _worker_input_dir)
            _remove_lock_remote(wav_file, _worker_input_dir, _worker_rclone_dest)
        elif _worker_drive_mount:
            _remove_lock_mount(wav_file)

        print(f"      [W{pid}] DONE  {basename} {elapsed:.0f}s {num_speakers}spk", flush=True)
        return wav_file, {
            "status": "diarized", "elapsed": elapsed,
            "segments": len(srt_segments), "speakers": num_speakers
        }
    except Exception as e:
        elapsed = time.time() - start_time
        heartbeat_stop.set()
        # Ukloni lock pri grešci
        if use_lock:
            if _worker_rclone_dest:
                _remove_lock_remote(wav_file, _worker_input_dir, _worker_rclone_dest)
            elif _worker_drive_mount:
                _remove_lock_mount(wav_file)
        print(f"      [W{pid}] ERROR {basename}: {e}", flush=True)
        return wav_file, {"status": "error", "reason": str(e), "elapsed": elapsed}


# ─── Distributed lock (Google Drive koordinacija) ───

LOCK_SUFFIX = ".canary.lock"
LOCK_STALE_SECONDS = 7200  # 2 sata — stariji lockovi se smatraju stale (worker crashao)


def _get_hostname():
    """Vraća hostname za lock identifikaciju."""
    import socket
    return socket.gethostname()


def _remote_path_for_wav(wav_file, input_dir, rclone_dest):
    """Izračunaj rclone remote path za dati WAV fajl."""
    rel = os.path.relpath(wav_file, input_dir)
    return f"{rclone_dest}/{rel}"


def _lock_exists_remote(wav_file, input_dir, rclone_dest):
    """Provjeri postoji li .lock ili .diarized.srt na remote-u (rclone).
    Vraća: 'diarized', 'locked', ili None.
    """
    import subprocess

    basename = os.path.basename(wav_file)
    rel_dir = os.path.relpath(os.path.dirname(wav_file), input_dir)
    remote_dir = f"{rclone_dest}/{rel_dir}" if rel_dir != "." else rclone_dest

    # Provjeri .canary.diarized.srt
    diarized_remote = f"{remote_dir}/{basename}{DIARIZED_SRT_SUFFIX}"
    ret = subprocess.run(
        ["rclone", "ls", diarized_remote, "--max-depth", "1"],
        capture_output=True, text=True, timeout=30
    )
    if ret.returncode == 0 and ret.stdout.strip():
        return "diarized"

    # Provjeri .canary.lock
    lock_remote = f"{remote_dir}/{basename}{LOCK_SUFFIX}"
    ret = subprocess.run(
        ["rclone", "ls", lock_remote, "--max-depth", "1"],
        capture_output=True, text=True, timeout=30
    )
    if ret.returncode == 0 and ret.stdout.strip():
        # Provjeri starost locka — dohvati sadržaj
        ret2 = subprocess.run(
            ["rclone", "cat", lock_remote],
            capture_output=True, text=True, timeout=30
        )
        if ret2.returncode == 0:
            try:
                lock_ts = float(ret2.stdout.strip().split("\n")[0])
                if time.time() - lock_ts > LOCK_STALE_SECONDS:
                    print(f"      Lock stale (>{LOCK_STALE_SECONDS//3600}h), ignoriram: {basename}", flush=True)
                    return None
            except (ValueError, IndexError):
                pass
        return "locked"

    return None


def _lock_exists_mount(wav_file, drive_mount):
    """Provjeri postoji li .lock ili .diarized.srt na mountanom Drive-u.
    Vraća: 'diarized', 'locked', ili None.
    """
    basename = os.path.basename(wav_file)
    # Pronađi odgovarajući direktorij na mountu — koristi isti relativni path
    # wav_file path sadrži kanal/filename, trebamo mapirati to na drive_mount
    # drive_mount je root dir na Drive-u, wav_file struktura je input_dir/kanal/file.wav
    # Za mount mode: wav_file JE na Drive-u, pa lock i diarized su u istom direktoriju
    wav_dir = os.path.dirname(wav_file)

    diarized_path = os.path.join(wav_dir, basename + DIARIZED_SRT_SUFFIX)
    if os.path.exists(diarized_path):
        return "diarized"

    lock_path = os.path.join(wav_dir, basename + LOCK_SUFFIX)
    if os.path.exists(lock_path):
        try:
            with open(lock_path, "r") as f:
                lock_ts = float(f.readline().strip())
            if time.time() - lock_ts > LOCK_STALE_SECONDS:
                print(f"      Lock stale (>{LOCK_STALE_SECONDS//3600}h), ignoriram: {basename}", flush=True)
                return None
        except (ValueError, OSError):
            pass
        return "locked"

    return None


def _create_lock_remote(wav_file, input_dir, rclone_dest):
    """Stvori .lock fajl na remote-u."""
    import subprocess
    import tempfile

    basename = os.path.basename(wav_file)
    rel_dir = os.path.relpath(os.path.dirname(wav_file), input_dir)
    remote_dir = f"{rclone_dest}/{rel_dir}" if rel_dir != "." else rclone_dest
    lock_remote = f"{remote_dir}/{basename}{LOCK_SUFFIX}"

    # Stvori privremeni lock fajl sa timestamp + hostname
    with tempfile.NamedTemporaryFile(mode="w", suffix=".lock", delete=False) as f:
        f.write(f"{time.time()}\n{_get_hostname()}\n")
        tmp_path = f.name

    try:
        subprocess.run(
            ["rclone", "copyto", tmp_path, lock_remote, "--quiet"],
            capture_output=True, timeout=30
        )
    finally:
        os.unlink(tmp_path)


def _create_lock_mount(wav_file):
    """Stvori .lock fajl na mountanom Drive-u."""
    basename = os.path.basename(wav_file)
    lock_path = os.path.join(os.path.dirname(wav_file), basename + LOCK_SUFFIX)
    with open(lock_path, "w") as f:
        f.write(f"{time.time()}\n{_get_hostname()}\n")


def _remove_lock_remote(wav_file, input_dir, rclone_dest):
    """Obriši .lock fajl s remote-a."""
    import subprocess

    basename = os.path.basename(wav_file)
    rel_dir = os.path.relpath(os.path.dirname(wav_file), input_dir)
    remote_dir = f"{rclone_dest}/{rel_dir}" if rel_dir != "." else rclone_dest
    lock_remote = f"{remote_dir}/{basename}{LOCK_SUFFIX}"

    subprocess.run(
        ["rclone", "deletefile", lock_remote, "--quiet"],
        capture_output=True, timeout=30
    )


def _remove_lock_mount(wav_file):
    """Obriši .lock fajl s mountanog Drive-a."""
    basename = os.path.basename(wav_file)
    lock_path = os.path.join(os.path.dirname(wav_file), basename + LOCK_SUFFIX)
    try:
        os.remove(lock_path)
    except OSError:
        pass


# ─── Background rclone upload ───

def _bg_rclone_upload(diarized_srt_path, rclone_dest, input_dir):
    """Spawna background rclone process za upload jednog diarized SRT fajla."""
    import subprocess

    # Izračunaj relativni path unutar input_dir-a
    rel_path = os.path.relpath(os.path.dirname(diarized_srt_path), input_dir)
    dest = f"{rclone_dest}/{rel_path}" if rel_path != "." else rclone_dest

    subprocess.Popen(
        ["rclone", "copyto", diarized_srt_path, f"{dest}/{os.path.basename(diarized_srt_path)}",
         "--quiet"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )


# ─── Batch obrada ───

def has_diarized_transcript(wav_file):
    """Provjerava postoji li diarized transkript za WAV datoteku."""
    wav_dir = os.path.dirname(wav_file)
    basename = os.path.basename(wav_file)
    return os.path.exists(os.path.join(wav_dir, basename + DIARIZED_SRT_SUFFIX))


def diarize_single_file(pipeline, wav_file, min_speakers=None, max_speakers=None,
                        audio_input_mode="waveform"):
    """Diarizira jednu WAV datoteku. NIKADA ne prepisuje postojeće datoteke."""
    import torch
    import gc

    wav_dir = os.path.dirname(wav_file)
    basename = os.path.basename(wav_file)
    srt_input = os.path.join(wav_dir, basename + CANARY_SRT_SUFFIX)
    diarized_output = os.path.join(wav_dir, basename + DIARIZED_SRT_SUFFIX)

    # Sigurnosna provjera
    if os.path.exists(diarized_output):
        return {"status": "skipped", "reason": "diarized SRT already exists"}

    if not os.path.exists(srt_input):
        return {"status": "skipped", "reason": "no .canary.srt found"}

    file_size_mb = os.path.getsize(wav_file) / (1024 * 1024)
    print(f"      Diarizing ({file_size_mb:.1f} MB)...")

    start_time = time.time()

    try:
        # 1. Parsiraj .canary.srt
        srt_segments = parse_srt(srt_input)
        if not srt_segments:
            return {"status": "error", "reason": "empty .canary.srt", "elapsed": 0}
        print(f"      Parsirano {len(srt_segments)} SRT segmenata")

        # 2. Pokreni pyannote community-1 diarizaciju (exclusive mode)
        speaker_segments, num_speakers = run_diarization(
            pipeline, wav_file,
            min_speakers=min_speakers,
            max_speakers=max_speakers,
            audio_input_mode=audio_input_mode,
            progress_prefix="   "
        )
        print(f"      Pronađeno {num_speakers} govornika, {len(speaker_segments)} exclusive segmenata")

        # 3. Pridruži govornika svakom SRT segmentu
        srt_segments = assign_speakers(srt_segments, speaker_segments)

        elapsed = time.time() - start_time

        # 4. Zapiši diarized SRT
        if not os.path.exists(diarized_output):  # Dvostruka provjera
            write_diarized_srt(srt_segments, diarized_output)
            srt_size_kb = os.path.getsize(diarized_output) / 1024
            print(f"      SRT: {os.path.basename(diarized_output)} ({srt_size_kb:.1f} KB)")

        return {
            "status": "diarized",
            "elapsed": elapsed,
            "segments": len(srt_segments),
            "speakers": num_speakers
        }

    except torch.cuda.OutOfMemoryError:
        elapsed = time.time() - start_time
        gc.collect()
        torch.cuda.empty_cache()
        print(f"      CUDA Out of Memory!")
        return {"status": "error", "reason": "CUDA OOM", "elapsed": elapsed}

    except Exception as e:
        elapsed = time.time() - start_time
        print(f"      Greška: {e}")
        return {"status": "error", "reason": str(e), "elapsed": elapsed}


# ─── CLI ───

def parse_args():
    parser = argparse.ArgumentParser(
        description="pyannote speaker diarization za Canary transkripte na Colab GPU",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Primjeri:
  # Google Colab (nakon mount Google Drive)
  !python diarize_canary.py --input-dir /content/drive/MyDrive/domovina_fetch_data/canary_wav

  # Samo prikaz
  !python diarize_canary.py --input-dir /content/drive/MyDrive/domovina_fetch_data/canary_wav --dry-run

  # Lokalno
  python diarize_canary.py --input-dir ./wav_files --hf-token hf_xxx
"""
    )

    parser.add_argument(
        "--input-dir", required=True,
        help="Direktorij s WAV i .canary.srt datotekama (rekurzivno)"
    )
    parser.add_argument(
        "--hf-token", default=None,
        help="HuggingFace token za pyannote model (ili koristi Colab Secrets / env HF_TOKEN)"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Samo prikaz datoteka, bez diarizacije"
    )
    parser.add_argument(
        "--file", default=None,
        help="Diarizi samo jednu specifičnu WAV datoteku"
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Ograniči broj datoteka za obradu"
    )
    parser.add_argument(
        "--min-speakers", type=int, default=None,
        help="Minimalan broj govornika"
    )
    parser.add_argument(
        "--max-speakers", type=int, default=None,
        help="Maksimalan broj govornika"
    )
    parser.add_argument(
        "--workers", type=int, default=1,
        help="Broj paralelnih procesa (default: 1). Svaki koristi ~3 GB RAM + 2 CPU threada. Za CPU VM: --workers $(($(nproc)/2))"
    )
    parser.add_argument(
        "--rclone-dest", default=None,
        help="rclone destinacija za background upload + distributed lock (npr. google_drive_ms:domovina_fetch_data/canary_wav)"
    )
    parser.add_argument(
        "--drive-mount", default=None,
        help="Path do mountanog Google Drive-a za distributed lock (npr. /content/drive/MyDrive/domovina_fetch_data/canary_wav). Za Colab."
    )
    parser.add_argument(
        "--audio-input", choices=["waveform", "path"], default="waveform",
        help="'waveform' (ISPRAVNO, sluzbena preporuka pyannotea, default) ili 'path' "
             "(POVUCENO — ne stedi memoriju i 8-15 h sporije na 20 h snimci; zadrzano "
             "samo radi ponovljivosti mjerenja)"
    )
    parser.add_argument(
        "--guard", choices=["auto", "on", "off"], default="auto",
        help="Nadzornik stroja (disk + RSS). auto = ukljucen na macOS-u, gdje swap "
             "raste na sistemskom disku i rusi nevezane procese."
    )
    parser.add_argument(
        "--min-free-disk-gb", type=float, default=GUARD_MIN_FREE_DISK_GB,
        help=f"Prag slobodnog prostora na / (default: {GUARD_MIN_FREE_DISK_GB:.0f} GB)"
    )
    parser.add_argument(
        "--rss-cap-gb", type=float, default=GUARD_RSS_CAP_GB,
        help=f"Prag RSS-a diarizacije (default: {GUARD_RSS_CAP_GB:.0f} GB)"
    )
    parser.add_argument(
        "--guard-interval", type=int, default=GUARD_CHECK_INTERVAL_S,
        help=f"Razmak provjera nadzornika u sekundama (default: {GUARD_CHECK_INTERVAL_S})"
    )
    parser.add_argument(
        "--progress-interval", type=int, default=60,
        help="Razmak ispisa napretka diarizacije u sekundama (default: 60)"
    )

    return parser.parse_args()


def main():
    args = parse_args()
    input_dir = args.input_dir

    print("╔══════════════════════════════════════════════════╗")
    print("║   PYANNOTE DIARIZACIJA — CANARY TRANSKRIPTI     ║")
    print("╚══════════════════════════════════════════════════╝")
    print(f"   Input:  {input_dir}")
    if args.workers > 1:
        print(f"   Workers: {args.workers} (paralelno, ~{args.workers * 3} GB RAM)")
    if args.min_speakers:
        print(f"   Min govornika: {args.min_speakers}")
    if args.max_speakers:
        print(f"   Max govornika: {args.max_speakers}")
    if args.rclone_dest:
        print(f"   rclone upload: {args.rclone_dest} (background, nakon svakog fajla)")
    if args.drive_mount:
        print(f"   Drive mount:  {args.drive_mount} (distributed lock via mount)")
    use_distributed_lock = bool(args.rclone_dest or args.drive_mount)
    if use_distributed_lock:
        print(f"   Distributed lock: AKTIVAN (stale timeout: {LOCK_STALE_SECONDS//3600}h)")
    if args.audio_input == "path":
        print("   UPOZORENJE: audio ulaz PATH je POVUCEN put — sporiji, bez ustede memorije.")
    guard_on = guard_enabled(args.guard)
    if guard_on:
        print(f"   Nadzornik stroja: AKTIVAN (disk >= {args.min_free_disk_gb:.0f} GB, "
              f"RSS <= {args.rss_cap_gb:.0f} GB)")
    if args.dry_run:
        print("   DRY RUN — samo prikaz, bez diarizacije")
    print("")

    # Predpolet: ako je disk vec ispod praga, ne krecemo uopce. Diarizacija bi
    # napunila swap na sistemskom disku i srusila nevezane procese.
    if guard_on and not args.dry_run:
        _free = free_disk_gb()
        if _free < args.min_free_disk_gb:
            _swt, _swu = swap_usage()
            print(f"   PREKID PRIJE STARTA: samo {_free:.1f} GB slobodno na / "
                  f"(prag {args.min_free_disk_gb:.0f} GB), swap {_swu:.1f}/{_swt:.1f} GB.")
            print("   macOS ovdje drzi swap — diarizacija bi ga napunila i srusila druge procese.")
            print("   Oslobodi prostor pa pokreni ponovno.")
            sys.exit(2)

    # Provjeri direktorij
    if not os.path.isdir(input_dir):
        print(f"Input direktorij ne postoji: {input_dir}")
        sys.exit(1)

    # Pronađi datoteke za diarizaciju
    if args.file:
        if not os.path.isfile(args.file):
            print(f"Datoteka ne postoji: {args.file}")
            sys.exit(1)
        to_process = [args.file] if not has_diarized_transcript(args.file) else []
        total_wav = 1
    else:
        # Sve WAV datoteke (followlinks=True potrebno za symlinke u storage/output/)
        all_wav = sorted([
            os.path.join(root, f)
            for root, _, files in os.walk(input_dir, followlinks=True)
            for f in files
            if f.endswith(".wav") and not f.startswith("._")
        ])
        total_wav = len(all_wav)

        # WAV-ovi koji imaju .canary.srt
        has_canary = [f for f in all_wav
                      if os.path.exists(os.path.join(
                          os.path.dirname(f),
                          os.path.basename(f) + CANARY_SRT_SUFFIX))]

        # WAV-ovi koji nemaju .canary.diarized.srt
        to_process = [f for f in has_canary if not has_diarized_transcript(f)]

        print(f"   Ukupno WAV datoteka: {total_wav}")
        print(f"   S Canary transkriptom (.canary.srt): {len(has_canary)}")
        print(f"   Već diarized: {len(has_canary) - len(to_process)}")

    if args.limit and args.limit < len(to_process):
        to_process = to_process[:args.limit]
        print(f"   Ograničeno na: {args.limit} datoteka (--limit)")
    print(f"   Za diarizaciju: {len(to_process)}")
    print("")

    if len(to_process) == 0:
        print("   Sve datoteke su već diarized (ili nemaju .canary.srt)!")
        return

    if args.dry_run:
        print("   Datoteke koje bi bile diarized:")
        for wav_file in to_process:
            size_mb = os.path.getsize(wav_file) / (1024 * 1024)
            basename = os.path.basename(wav_file)
            print(f"      {basename} ({size_mb:.1f} MB)")
            print(f"         {basename}{CANARY_SRT_SUFFIX} -> {basename}{DIARIZED_SRT_SUFFIX}")
        print("")
        print("   Pokreni bez --dry-run za stvarnu diarizaciju.")
        return

    # ─── Instaliraj dependencies ───
    install_dependencies()
    hf_token = get_hf_token(args.hf_token)

    global PROGRESS_INTERVAL_S
    PROGRESS_INTERVAL_S = args.progress_interval

    total_diarized = 0
    total_skipped = 0
    total_errors = 0
    total_elapsed = 0.0
    batch_start = time.time()

    if args.workers > 1:
        # ─── Paralelna obrada ───
        from concurrent.futures import ProcessPoolExecutor, as_completed

        # Izračunaj threadove po workeru: cilj je workers × threads ≈ CPU count
        cpu_count = os.cpu_count() or args.workers
        threads_per_worker = max(1, cpu_count // args.workers)
        # Cap na 4 — više threadova nema smisla za pyannote inference
        threads_per_worker = min(threads_per_worker, 4)

        print(f"   Pokrećem {args.workers} worker procesa × {threads_per_worker} thread(s) = "
              f"{args.workers * threads_per_worker} ukupno threadova (CPU: {cpu_count})")
        print("")

        ctx = multiprocessing.get_context("spawn")
        with ProcessPoolExecutor(
            max_workers=args.workers,
            mp_context=ctx,
            initializer=_worker_init,
            initargs=(hf_token, args.min_speakers, args.max_speakers, threads_per_worker,
                      args.rclone_dest, args.drive_mount, input_dir,
                      args.audio_input, args.progress_interval)
        ) as executor:
            # Nadzornik mjeri ZBROJ RSS-a svih workera — na 24 GB stroju granicu
            # probija ukupna alokacija, ne pojedini worker.
            if guard_on:
                def _abort_pool(reason):
                    print(f"\n   PREKID: {reason}", flush=True)
                    print("   Ubijam diarizacijske workere da stroj ne ode u swap-thrash.", flush=True)
                    for _p in list(executor._processes.values()):
                        try:
                            os.kill(_p.pid, signal.SIGKILL)
                        except Exception:
                            pass
                    print("   Vec zavrsene epizode su zapisane na disk; ova nije.", flush=True)
                    os._exit(3)

                _guard = MachineGuard(
                    pids_fn=lambda: list(executor._processes.keys()),
                    abort_fn=_abort_pool,
                    min_free_disk_gb=args.min_free_disk_gb,
                    rss_cap_gb=args.rss_cap_gb,
                    interval_s=args.guard_interval).start()

            futures = {executor.submit(_worker_diarize, f): f for f in to_process}
            done_count = 0

            for future in as_completed(futures):
                wav_file, result = future.result()
                done_count += 1
                basename = os.path.basename(wav_file)

                if result["status"] == "diarized":
                    total_diarized += 1
                    total_elapsed += result["elapsed"]
                    wall_elapsed = time.time() - batch_start
                    wall_per_file = wall_elapsed / done_count
                    wall_remaining = (len(to_process) - done_count) * wall_per_file
                    print(f"   [{done_count}/{len(to_process)}] {basename}"
                          f"  {format_duration(result['elapsed'])}"
                          f"  {result['speakers']} spk"
                          f"  |  ETA: {format_duration(wall_remaining)}")
                    # Background upload ako je konfigurirano
                    if args.rclone_dest:
                        diarized_path = os.path.join(
                            os.path.dirname(wav_file),
                            os.path.basename(wav_file) + DIARIZED_SRT_SUFFIX)
                        _bg_rclone_upload(diarized_path, args.rclone_dest, input_dir)
                elif result["status"] == "skipped":
                    total_skipped += 1
                elif result["status"] == "error":
                    total_errors += 1
                    print(f"   [{done_count}/{len(to_process)}] {basename}  ERROR: {result.get('reason')}")
    else:
        # ─── Sekvencijalna obrada (1 worker, default) ───
        pipeline, device = load_diarization_pipeline(hf_token)
        print("")

        # Ovdje diarizacija tece U OVOM procesu, pa je "ubij dijete" nemoguce —
        # prekid je izlazak samog procesa. Vec zapisani .canary.diarized.srt
        # ostaju; gubi se samo epizoda u letu. To je i cilj obrane.
        if guard_on:
            def _abort_serial(reason):
                print(f"\n   PREKID: {reason}", flush=True)
                print("   Izlazim da stroj ne ode u swap-thrash. Vec zavrsene epizode "
                      "su zapisane; ova nije.", flush=True)
                sys.stdout.flush()
                os._exit(3)

            MachineGuard(
                pids_fn=lambda: [os.getpid()],
                abort_fn=_abort_serial,
                min_free_disk_gb=args.min_free_disk_gb,
                rss_cap_gb=args.rss_cap_gb,
                interval_s=args.guard_interval).start()

        for i, wav_file in enumerate(to_process):
            basename = os.path.basename(wav_file)
            print(f"   ─────────────────────────────────────────────")
            print(f"   [{i+1}/{len(to_process)}] {basename}")

            # ─── Distributed lock provjera ───
            if use_distributed_lock:
                lock_status = None
                if args.rclone_dest:
                    lock_status = _lock_exists_remote(wav_file, input_dir, args.rclone_dest)
                elif args.drive_mount:
                    lock_status = _lock_exists_mount(wav_file, args.drive_mount)

                if lock_status == "diarized":
                    total_skipped += 1
                    print(f"      Preskočeno: već diarized na Drive-u")
                    continue
                elif lock_status == "locked":
                    total_skipped += 1
                    print(f"      Preskočeno: drugi worker radi (lock)")
                    continue

                # Claim: stvori lock
                if args.rclone_dest:
                    _create_lock_remote(wav_file, input_dir, args.rclone_dest)
                elif args.drive_mount:
                    _create_lock_mount(wav_file)

            result = diarize_single_file(
                pipeline, wav_file,
                min_speakers=args.min_speakers,
                max_speakers=args.max_speakers,
                audio_input_mode=args.audio_input
            )

            if result["status"] == "diarized":
                total_diarized += 1
                total_elapsed += result["elapsed"]
                avg_per_file = total_elapsed / total_diarized
                remaining = (len(to_process) - i - 1) * avg_per_file
                print(f"      Trajalo: {format_duration(result['elapsed'])}  |  ETA: {format_duration(remaining)}")
                # Upload diarized SRT + ukloni lock
                if args.rclone_dest:
                    diarized_path = os.path.join(
                        os.path.dirname(wav_file),
                        os.path.basename(wav_file) + DIARIZED_SRT_SUFFIX)
                    _bg_rclone_upload(diarized_path, args.rclone_dest, input_dir)
                    _remove_lock_remote(wav_file, input_dir, args.rclone_dest)
                elif args.drive_mount:
                    _remove_lock_mount(wav_file)
            elif result["status"] == "skipped":
                total_skipped += 1
                print(f"      Preskočeno: {result['reason']}")
                # Ukloni lock ako smo ga stvorili
                if use_distributed_lock:
                    if args.rclone_dest:
                        _remove_lock_remote(wav_file, input_dir, args.rclone_dest)
                    elif args.drive_mount:
                        _remove_lock_mount(wav_file)
            elif result["status"] == "error":
                total_errors += 1
                # Ukloni lock pri grešci — da drugi worker može probati
                if use_distributed_lock:
                    if args.rclone_dest:
                        _remove_lock_remote(wav_file, input_dir, args.rclone_dest)
                    elif args.drive_mount:
                        _remove_lock_mount(wav_file)
                if result.get("reason") == "CUDA OOM":
                    print("      Preskačem na sljedeću datoteku...")

    # ─── Sažetak ───
    wall_total = time.time() - batch_start
    print("")
    print("╔══════════════════════════════════════════════════╗")
    print("║   SAŽETAK                                        ║")
    print("╚══════════════════════════════════════════════════╝")
    print(f"   Diarized:    {total_diarized}")
    print(f"   Preskočeno:  {total_skipped}")
    print(f"   Grešaka:     {total_errors}")
    print(f"   Wall clock:  {format_duration(wall_total)}")
    if total_diarized > 0:
        print(f"   CPU vrijeme:  {format_duration(total_elapsed)} (suma svih fajlova)")
        print(f"   Prosjek/fajl: {format_duration(total_elapsed / total_diarized)}")
        if args.workers > 1:
            speedup = total_elapsed / wall_total if wall_total > 0 else 0
            print(f"   Speedup:      {speedup:.1f}x ({args.workers} workera)")
    print("")


if __name__ == "__main__":
    main()
