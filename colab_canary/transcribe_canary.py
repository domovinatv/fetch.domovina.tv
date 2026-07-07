#!/usr/bin/env python3
"""
transcribe_canary.py — NVIDIA Canary 1B v2 transkripcija na Colab/Kaggle GPU

Pokreće Canary 1B v2 model DIREKTNO na GPU (bez HF Space, bez GPU kvote).
Generira .canary.srt i .canary.csv za svaku WAV datoteku.

NIKADA ne briše ili prepisuje postojeće datoteke.

=== Google Colab ===
  1. Upload WAV datoteka na Google Drive
  2. Otvori Colab, odaberi T4 GPU runtime
  3. Pokreni:
     !pip install -U 'nemo_toolkit[asr]'
     !python transcribe_canary.py --input-dir /content/drive/MyDrive/wav_files

=== Kaggle ===
  1. Upload WAV datoteka kao Kaggle Dataset
  2. Kreiraj Notebook s GPU acceleratorom
  3. Pokreni:
     !pip install -U 'nemo_toolkit[asr]'
     !python transcribe_canary.py --input-dir /kaggle/input/my-dataset --output-dir /kaggle/working

Primjeri:
  python transcribe_canary.py --input-dir ./wav_files
  python transcribe_canary.py --input-dir ./wav_files --dry-run
  python transcribe_canary.py --input-dir /content/drive/MyDrive/audio --source-lang hr --target-lang hr
"""

import argparse
import csv
import datetime
import gc
import os
import subprocess
import sys
import threading
import time
from pathlib import Path


# ─── Sufiksi za output (nikada ne prepiši postojeće datoteke) ───
CANARY_SRT_SUFFIX = ".canary.srt"
CANARY_CSV_SUFFIX = ".canary.csv"


# ─── SRT formatiranje (isto kao u HF Space app.py) ───

def format_srt_time(seconds: float) -> str:
    """Pretvara sekunde u SRT time format HH:MM:SS,mmm"""
    sanitized = max(0.0, seconds)
    delta = datetime.timedelta(seconds=sanitized)
    total_int_seconds = int(delta.total_seconds())

    hours = total_int_seconds // 3600
    remainder = total_int_seconds % 3600
    minutes = remainder // 60
    secs = remainder % 60
    milliseconds = delta.microseconds // 1000

    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"


def generate_srt_content(segment_timestamps: list) -> str:
    """Generira SRT formatirani string iz segmentnih timestampova."""
    srt_lines = []
    for i, ts in enumerate(segment_timestamps):
        start_time = format_srt_time(ts['start'])
        end_time = format_srt_time(ts['end'])
        text = ts['segment']
        srt_lines.append(str(i + 1))
        srt_lines.append(f"{start_time} --> {end_time}")
        srt_lines.append(text)
        srt_lines.append("")
    return "\n".join(srt_lines)


def sec_to_hms(seconds: float) -> str:
    """Pretvara sekunde u HH:MM:SS format za CSV."""
    seconds = round(seconds)
    return str(datetime.timedelta(seconds=seconds))


def format_duration(seconds: float) -> str:
    """Formatira trajanje u čitljiv format."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h}h {m}m {s}s"


# ─── GPU utilizacija (mjerenje bottlenecka) ───
#
# RAZLOG (2026-07-07): na G4 (96 GB VRAM) peak VRAM je ~26 GB → ~70 GB neiskorišteno.
# Pitanje je isplati li se paralelno obrađivati više WAV-ova (--shard-count) ili je
# GPU COMPUTE (SM) već zasićen pa bi paralelizacija samo trošila VRAM bez dobitka na
# throughputu. To se ne može znati bez mjerenja: SM utilization je metrika koja to
# razrješava. Uzorkujemo u pozadinskoj niti (NVML ako je dostupan, inače nvidia-smi)
# i izvještavamo po fajlu + globalno, s interpretacijom na kraju.

class GpuSampler:
    """Uzorkuje GPU SM utilizaciju (%) i VRAM (MB) u pozadinskoj niti.

    Backend: pynvml (NVML) ako je importabilan, inače `nvidia-smi` subprocess.
    Low-overhead (~interval s). Ako ni jedno nije dostupno (npr. CPU-only),
    tiho se deaktivira (start/stop/window su no-op → None)."""

    def __init__(self, interval: float = 0.5):
        self.interval = interval
        self._samples = []            # lista (sm_util_pct, mem_used_mb); index-based window
        self._stop = threading.Event()
        self._thread = None
        self._backend = None          # "nvml" | "smi" | None
        self._nvml = None
        self._handle = None
        self.mem_total_mb = None
        self._init_backend()

    def _init_backend(self):
        try:
            import pynvml
            pynvml.nvmlInit()
            self._handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            self._nvml = pynvml
            self._backend = "nvml"
            self.mem_total_mb = pynvml.nvmlDeviceGetMemoryInfo(self._handle).total / (1024 * 1024)
            return
        except Exception:
            pass
        # Fallback: nvidia-smi (uvijek prisutan na Colab GPU runtimeu)
        try:
            import shutil
            if shutil.which("nvidia-smi"):
                self._backend = "smi"
                out = subprocess.check_output(
                    ["nvidia-smi", "--query-gpu=memory.total",
                     "--format=csv,noheader,nounits"], timeout=5
                ).decode().strip().splitlines()[0]
                self.mem_total_mb = float(out.strip())
        except Exception:
            self._backend = None

    def _read(self):
        """Vrati (sm_util_pct, mem_used_mb) ili None."""
        if self._backend == "nvml":
            u = self._nvml.nvmlDeviceGetUtilizationRates(self._handle)
            m = self._nvml.nvmlDeviceGetMemoryInfo(self._handle)
            return float(u.gpu), m.used / (1024 * 1024)
        if self._backend == "smi":
            out = subprocess.check_output(
                ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used",
                 "--format=csv,noheader,nounits"], timeout=5
            ).decode().strip().splitlines()[0]
            gpu, mem = [p.strip() for p in out.split(",")]
            return float(gpu), float(mem)
        return None

    def _loop(self):
        while not self._stop.wait(self.interval):
            try:
                r = self._read()
                if r is not None:
                    self._samples.append(r)
            except Exception:
                pass

    def start(self):
        if self._backend is None:
            return self
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    @property
    def active(self) -> bool:
        return self._backend is not None

    def mark(self) -> int:
        """Vrati index trenutnog kraja liste — početak prozora za jedan fajl.
        (Nit samo append-a → slice od ovog indexa je thread-safe.)"""
        return len(self._samples)

    def window(self, start_idx: int):
        """Statistika (sm_avg, sm_peak, mem_peak_mb, n) za uzorke od start_idx nadalje."""
        s = self._samples[start_idx:]
        if not s:
            return None
        sm = [x[0] for x in s]
        mem = [x[1] for x in s]
        return {"sm_avg": sum(sm) / len(sm), "sm_peak": max(sm),
                "mem_peak": max(mem), "n": len(s)}

    def overall(self):
        """Globalna statistika preko svih uzoraka (svaki uzorak = jednak vremenski odsječak)."""
        return self.window(0)


def _gb(mb):
    return mb / 1024.0 if mb is not None else None


# ─── Glavni program ───

def parse_args():
    parser = argparse.ArgumentParser(
        description="🐤 NVIDIA Canary 1B v2 — Transkripcija na Colab/Kaggle GPU",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Primjeri:
  # Google Colab (nakon mount Google Drive)
  !python transcribe_canary.py --input-dir /content/drive/MyDrive/wav_files

  # Kaggle
  !python transcribe_canary.py --input-dir /kaggle/input/my-dataset --output-dir /kaggle/working

  # Lokalno
  python transcribe_canary.py --input-dir ./wav_files --dry-run
"""
    )

    parser.add_argument(
        "--input-dir", required=True,
        help="Direktorij s WAV datotekama za transkripciju"
    )
    parser.add_argument(
        "--output-dir", default=None,
        help="Direktorij za output (default: isti kao input-dir)"
    )
    parser.add_argument(
        "--source-lang", default="hr",
        help="Izvorni jezik — ISO kod (default: hr za Hrvatski)"
    )
    parser.add_argument(
        "--target-lang", default="hr",
        help="Ciljni jezik — ISO kod (default: hr za Hrvatski)"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Samo prikaz datoteka, bez transkripcije"
    )
    parser.add_argument(
        "--file", default=None,
        help="Transkribira samo jednu specifičnu WAV datoteku"
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Ograniči broj datoteka za obradu (korisno za testiranje)"
    )
    parser.add_argument(
        "--shard-index", type=int, default=0,
        help="0-based indeks ovog workera za paralelno pokretanje više procesa"
    )
    parser.add_argument(
        "--shard-count", type=int, default=1,
        help="Ukupan broj paralelnih workera; svaki obrađuje disjunktan podskup (i::N)"
    )
    # RAZLOG (2026-06-25): HuggingFace download canary-1b-v2.nemo (6.36 GB) zna zapeti
    # nasred preuzimanja na Colabu (viđeno zaglavljivanje na ~6%), što ubije cijeli batch.
    # Zato model držimo i kao cache na vlastitom R2 (models.domovina.ai). Ako je --model-path
    # zadan (notebook ga skine s R2 prije pokretanja), učitavamo lokalnu .nemo kopiju
    # preko restore_from i potpuno preskačemo HF. Bez --model-path → fallback na HF (vidi load_model).
    parser.add_argument(
        "--model-path", type=str, default=None,
        help="Lokalna putanja do canary-1b-v2.nemo (npr. skinuta s R2 cachea models.domovina.ai). "
             "Ako je zadana, učitava se preko restore_from umjesto HF from_pretrained."
    )

    return parser.parse_args()


def find_wav_files(input_dir: str) -> list:
    """Pronalazi sve WAV datoteke rekurzivno u direktoriju i poddirektorijima."""
    wav_files = sorted([
        str(p) for p in Path(input_dir).rglob("*.wav")
        if not p.name.startswith("._")
        and ".loudnorm." not in p.name  # izvedeni audio (normalizacija), NE transkribirati
    ])
    return wav_files


def has_canary_transcript(wav_file: str, output_dir: str) -> bool:
    """Provjerava postoji li canary transkript za danu WAV datoteku.
    Traži SRT pored WAV fajla (u istom direktoriju)."""
    wav_dir = os.path.dirname(wav_file)
    basename = os.path.basename(wav_file)
    srt_path = os.path.join(wav_dir, basename + CANARY_SRT_SUFFIX)
    return os.path.exists(srt_path)


def install_dependencies():
    """Provjerava i instalira NeMo ako nije prisutan."""
    try:
        import nemo.collections.asr  # noqa: F401
        print("   ✅ NeMo toolkit je već instaliran")
    except ImportError:
        print("   📦 Instaliram NeMo toolkit...")
        os.system("pip install -U 'nemo_toolkit[asr]'")
        print("   ✅ NeMo instaliran")


def load_model(model_path=None):
    """Učitava Canary 1B v2 model s BF16 optimizacijom.

    Ako je `model_path` zadan (lokalna .nemo datoteka, npr. skinuta s R2 cachea
    models.domovina.ai), učitava se preko restore_from i HF download se preskače.
    Inače fallback na HF from_pretrained.
    """
    import torch
    from nemo.collections.asr.models import ASRModel

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"   🖥️  Uređaj: {device.upper()}")

    if device == "cpu":
        print("   ⚠️  UPOZORENJE: GPU nije dostupan! Transkripcija će biti JAKO spora.")
        print("      💡 Na Colab/Kaggle: Runtime → Change runtime type → T4 GPU")

    if model_path and os.path.isfile(model_path):
        # RAZLOG (2026-06-25): HF preuzimanje .nemo (6.36 GB) zna zapeti na Colabu i
        # ubiti batch → primarni put je lokalna kopija s R2 cachea (models.domovina.ai).
        print(f"   📦 Učitavam model iz lokalne .nemo kopije (R2 cache): {model_path}")
        model = ASRModel.restore_from(restore_path=model_path)
    else:
        # Fallback: izravni HF download (zadržano namjerno — radi i bez R2 cachea,
        # samo je nepouzdanije na Colabu jer download zna zapeti nasred preuzimanja).
        print("   📥 Učitavam nvidia/canary-1b-v2 model s HuggingFace (ovo traje ~1-2min prvi put)...")
        model = ASRModel.from_pretrained(model_name="nvidia/canary-1b-v2")
    model.eval()

    # BF16 optimizacija — pola memorije, brži compute na modernim GPU-ima
    if device == "cuda" and torch.cuda.is_bf16_supported():
        model = model.to(torch.bfloat16)
        print("   ⚡ BF16 optimizacija aktivna")
    print("   ✅ Model učitan")

    return model, device


def transcribe_single_file(model, wav_file: str, output_dir: str,
                           source_lang: str, target_lang: str) -> dict:
    """
    Transkribira jednu WAV datoteku i sprema SRT + CSV.
    NIKADA ne prepisuje postojeće datoteke.
    """
    import torch

    wav_dir = os.path.dirname(wav_file)
    basename = os.path.basename(wav_file)
    srt_output = os.path.join(wav_dir, basename + CANARY_SRT_SUFFIX)
    csv_output = os.path.join(wav_dir, basename + CANARY_CSV_SUFFIX)

    # Sigurnosna provjera
    if os.path.exists(srt_output):
        return {"status": "skipped", "reason": "canary SRT already exists"}

    file_size_mb = os.path.getsize(wav_file) / (1024 * 1024)
    print(f"      ⏳ Transkribriram ({file_size_mb:.1f} MB)...")

    start_time = time.time()

    try:
        # Pokreni transkripciju s timestampovima (inference_mode smanjuje overhead)
        with torch.inference_mode():
            output = model.transcribe(
                [wav_file],
                timestamps=True,
                source_lang=source_lang,
                target_lang=target_lang
            )

        elapsed = time.time() - start_time

        # Provjeri output format
        if (not output or not isinstance(output, list) or not output[0]
                or not hasattr(output[0], 'timestamp') or not output[0].timestamp
                or 'segment' not in output[0].timestamp):
            return {"status": "error", "reason": "Unexpected output format", "elapsed": elapsed}

        segment_timestamps = output[0].timestamp['segment']
        print(f"      📊 Pronađeno {len(segment_timestamps)} segmenata")

        # ─── Spremi SRT ───
        if not os.path.exists(srt_output):  # Dvostruka provjera
            srt_content = generate_srt_content(segment_timestamps)
            with open(srt_output, 'w', encoding='utf-8') as f:
                f.write(srt_content)
            srt_size_kb = os.path.getsize(srt_output) / 1024
            print(f"      ✅ SRT: {os.path.basename(srt_output)} ({srt_size_kb:.1f} KB)")

        # ─── Spremi CSV ───
        if not os.path.exists(csv_output):  # Dvostruka provjera
            with open(csv_output, 'w', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                writer.writerow(["Start (HH:MM:SS)", "End (HH:MM:SS)", "Segment"])
                for ts in segment_timestamps:
                    writer.writerow([
                        sec_to_hms(ts['start']),
                        sec_to_hms(ts['end']),
                        ts['segment']
                    ])
            csv_size_kb = os.path.getsize(csv_output) / 1024
            print(f"      ✅ CSV: {os.path.basename(csv_output)} ({csv_size_kb:.1f} KB)")

        return {"status": "transcribed", "elapsed": elapsed, "segments": len(segment_timestamps)}

    except torch.cuda.OutOfMemoryError:
        elapsed = time.time() - start_time
        gc.collect()
        torch.cuda.empty_cache()
        print(f"      ❌ CUDA Out of Memory! Datoteka je prevelika za GPU.")
        return {"status": "error", "reason": "CUDA OOM", "elapsed": elapsed}

    except Exception as e:
        elapsed = time.time() - start_time
        print(f"      ❌ Greška: {e}")
        return {"status": "error", "reason": str(e), "elapsed": elapsed}


def main():
    args = parse_args()

    input_dir = args.input_dir
    output_dir = args.output_dir or input_dir
    source_lang = args.source_lang
    target_lang = args.target_lang

    print("╔══════════════════════════════════════════════════╗")
    print("║   🐤 CANARY 1B v2 — DIRECT GPU TRANSKRIPCIJA    ║")
    print("║   Google Colab / Kaggle                         ║")
    print("╚══════════════════════════════════════════════════╝")
    print(f"   📂 Input:  {input_dir}")
    print(f"   💾 Output: {output_dir}")
    print(f"   🗣️  Izvorni jezik: {source_lang}")
    print(f"   💬 Ciljni jezik: {target_lang}")
    if args.dry_run:
        print("   ⚠️  DRY RUN — samo prikaz, bez transkripcije")
    print("")

    # Provjeri direktorije
    if not os.path.isdir(input_dir):
        print(f"❌ Input direktorij ne postoji: {input_dir}")
        sys.exit(1)

    os.makedirs(output_dir, exist_ok=True)

    # Pronađi WAV datoteke
    if args.file:
        if not os.path.isfile(args.file):
            print(f"❌ Datoteka ne postoji: {args.file}")
            sys.exit(1)
        wav_files = [args.file]
    else:
        wav_files = find_wav_files(input_dir)

    print(f"   📋 Pronađeno WAV datoteka: {len(wav_files)}")

    if len(wav_files) == 0:
        print("   ℹ️  Nema WAV datoteka za obradu.")
        return

    # Filtriraj već transkribirane
    to_process = [f for f in wav_files if not has_canary_transcript(f, output_dir)]
    already_done = len(wav_files) - len(to_process)

    if already_done > 0:
        print(f"   ⏭️  Preskočeno (transkript već postoji): {already_done}")

    # Sharding: za paralelno pokretanje N procesa na istom GPU-u (G4 ima ~70 GB
    # slobodne VRAM nakon ~27 GB modela → stane 2-3 instance). Svaki worker uzima
    # interleave-an podskup (i::N) pa se različite veličine fajlova ravnomjerno
    # raspodijele. Idempotentnost + provjera postojanja SRT-a štite od kolizija.
    if args.shard_count > 1:
        if not (0 <= args.shard_index < args.shard_count):
            print(f"❌ --shard-index mora biti 0..{args.shard_count - 1}")
            sys.exit(1)
        before = len(to_process)
        to_process = to_process[args.shard_index::args.shard_count]
        print(f"   🧩 Shard {args.shard_index + 1}/{args.shard_count}: {len(to_process)} od {before} pending")

    if args.limit and args.limit < len(to_process):
        to_process = to_process[:args.limit]
        print(f"   🔢 Ograničeno na: {args.limit} datoteka (--limit)")
    print(f"   🔄 Za obradu: {len(to_process)}")
    print("")

    if len(to_process) == 0:
        print("   ✅ Sve datoteke su već transkribirane!")
        return

    if args.dry_run:
        print("   📋 Datoteke koje bi bile transkribirane:")
        for wav_file in to_process:
            size_mb = os.path.getsize(wav_file) / (1024 * 1024)
            basename = os.path.basename(wav_file)
            print(f"      🔄 {basename} ({size_mb:.1f} MB)")
            print(f"         → {basename}{CANARY_SRT_SUFFIX}")
            print(f"         → {basename}{CANARY_CSV_SUFFIX}")
        print("")
        print("   ℹ️  Pokreni bez --dry-run za stvarnu transkripciju.")
        return

    # ─── Instaliraj dependencies i učitaj model ───
    install_dependencies()
    model, device = load_model(args.model_path)
    print("")

    # GPU sampler — mjeri SM utilizaciju + VRAM da odgovori "isplati li se paralelizirati".
    gpu = GpuSampler(interval=0.5).start()
    if gpu.active:
        mt = f"{_gb(gpu.mem_total_mb):.1f} GB" if gpu.mem_total_mb else "?"
        print(f"   📈 GPU metrics ON (backend: {gpu._backend}, VRAM total {mt})")
        print("")

    total_transcribed = 0
    total_skipped = 0
    total_errors = 0
    total_elapsed = 0.0

    for i, wav_file in enumerate(to_process):
        basename = os.path.basename(wav_file)
        print(f"   ─────────────────────────────────────────────")
        print(f"   [{i+1}/{len(to_process)}] 🎙️  {basename}")

        win0 = gpu.mark()
        result = transcribe_single_file(model, wav_file, output_dir,
                                        source_lang, target_lang)

        if result["status"] == "transcribed":
            total_transcribed += 1
            total_elapsed += result["elapsed"]
            print(f"      ⏱️  Trajalo: {format_duration(result['elapsed'])}")
            st = gpu.window(win0)
            if st:
                mem_g = _gb(st["mem_peak"])
                mtot = f"/{_gb(gpu.mem_total_mb):.0f}" if gpu.mem_total_mb else ""
                print(f"      📈 GPU: SM avg {st['sm_avg']:.0f}% / peak {st['sm_peak']:.0f}% "
                      f"| VRAM peak {mem_g:.1f}{mtot} GB")
        elif result["status"] == "skipped":
            total_skipped += 1
            print(f"      ⏭️  Preskočeno: {result['reason']}")
        elif result["status"] == "error":
            total_errors += 1
            if result.get("reason") == "CUDA OOM":
                print("      💡 Preskačem na sljedeću datoteku...")

    # ─── Sažetak ───
    print("")
    print("╔══════════════════════════════════════════════════╗")
    print("║   📊 SAŽETAK                                    ║")
    print("╚══════════════════════════════════════════════════╝")
    print(f"   ✅ Transkribirano:   {total_transcribed}")
    print(f"   ⏭️  Preskočeno:      {already_done + total_skipped} (transkript već postoji)")
    print(f"   ❌ Grešaka:          {total_errors}")
    if total_elapsed > 0:
        print(f"   ⏱️  Ukupno vrijeme:  {format_duration(total_elapsed)}")
        if total_transcribed > 0:
            avg = total_elapsed / total_transcribed
            print(f"   📊 Prosjek po datoteci: {format_duration(avg)}")

    # ─── GPU utilizacija: interpretacija (paralelizacija da/ne) ───
    gpu.stop()
    ov = gpu.overall() if gpu.active else None
    if ov and ov["n"] >= 3:
        sm = ov["sm_avg"]
        mem_g = _gb(ov["mem_peak"])
        mtot = _gb(gpu.mem_total_mb) if gpu.mem_total_mb else None
        head = f"{mem_g:.1f} GB" + (f" / {mtot:.0f} GB ({mem_g/mtot*100:.0f}%)" if mtot else "")
        print("")
        print("   ── GPU utilizacija (cijeli run) ──────────────")
        print(f"   📈 SM avg {sm:.0f}% / peak {ov['sm_peak']:.0f}%  |  VRAM peak {head}")
        if sm >= 85:
            print("   → COMPUTE-BOUND (SM ~zasićen). Paralelizacija više WAV-ova NEMA smisla:")
            print("     druge instance samo time-slice-aju isti compute + troše VRAM. Ostani na 1.")
        elif sm < 60:
            print("   → GPU ČESTO IDLE (I/O / dataloader bubbles). Slobodni VRAM se ISPLATI iskoristiti.")
            print("     Redoslijed poteza (od najjeftinijeg): 1) pre-stage WAV-ove na lokalni /content")
            print("     disk umjesto čitanja s Drive FUSE mounta; 2) batch više fajlova po transcribe()")
            print("     pozivu; tek 3) --shard-count 2-3 (pazi na Drive I/O kontenciju).")
        else:
            print("   → DJELOMIČNO iskorišten. Marginalan dobitak: prvo probaj lokalni staging + batching,")
            print("     shardanje tek ako SM ostane < 60% (inače Drive I/O postane usko grlo).")
    print("")


if __name__ == "__main__":
    main()
