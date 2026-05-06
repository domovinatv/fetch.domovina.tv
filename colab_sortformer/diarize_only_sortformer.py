#!/usr/bin/env python3
"""
diarize_only_sortformer.py — Standalone Sortformer diarizacija nad postojećim .canary.srt

DRUGI PROLAZ scale workflow-a:

  Pass 1:  colab_canary/transcribe_canary.py    na G4 (Pro+)   → .canary.srt
  Pass 2:  ovaj script (colab_sortformer)        na T4 (FREE)   → .sortformer.diarized.srt

Razlika od `transcribe_sortformer.py` (combined pipeline): NE pokreće Canary.
Reusea postojeće `.canary.srt` (~25-30 GB VRAM peak izbjegnut), jedino učitava
Streaming Sortformer 4spk v2.1 (~2 GB VRAM peak) → STAJE NA FREE T4 (16 GB).

Logika: parsiraj `.canary.srt` → Sortformer diarize WAV → assign_speakers
(best-overlap) → spremi `.sortformer.diarized.srt`.

Output je BIT-IDENTIČAN onome što `transcribe_sortformer.py` proizvede
(Canary tekst + Sortformer speaker labels), pa je drop-in kompatibilan
s ostalim alatima koji čitaju `.sortformer.diarized.srt`.

────────────────────────────────────────────────────────────────────────────────
LICENCA — NVIDIA Streaming Sortformer 4spk v2.1
────────────────────────────────────────────────────────────────────────────────
Model: nvidia/diar_streaming_sortformer_4spk-v2.1
Licenca: NVIDIA Open Model License Agreement (komercijalno OK uz uvjete).
NE mijenjati na CC-BY-NC v1/v2 varijantu bez provjere.

────────────────────────────────────────────────────────────────────────────────
Idempotentno: preskače WAV-ove koji već imaju .sortformer.diarized.srt.
Preskače WAV-ove koji NEMAJU .canary.srt (preduvjet — pokreni prvo Pass 1).
Heartbeat svakih 60s, ETA na osnovu prosjeka, nastavak pri grešci jednog fajla.
────────────────────────────────────────────────────────────────────────────────
"""

import argparse
import datetime
import gc
import os
import re
import sys
import threading
import time


# ─── Sufiksi ───
CANARY_SRT_SUFFIX               = ".canary.srt"
SORTFORMER_DIARIZED_SRT_SUFFIX  = ".sortformer.diarized.srt"

# ─── Model ───
SORTFORMER_MODEL_NAME = "nvidia/diar_streaming_sortformer_4spk-v2.1"


# ─── SRT parsing (kopija iz diarize_canary.py — isti format) ───

def timestamp_to_seconds(ts: str) -> float:
    """Konvertira HH:MM:SS.mmm ili HH:MM:SS,mmm u sekunde."""
    ts = ts.replace(",", ".")
    parts = ts.split(":")
    h = int(parts[0])
    m = int(parts[1])
    s = float(parts[2])
    return h * 3600 + m * 60 + s


def parse_canary_srt(srt_path: str) -> list:
    """Parsira .canary.srt i vraća listu segmenata {start, end, segment}."""
    with open(srt_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    pattern = re.compile(
        r"(\d+)\s*\n"
        r"(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*\n"
        r"((?:(?!\n\n|\n\d+\s*\n).)*)",
        re.DOTALL,
    )

    segments = []
    for match in pattern.finditer(content):
        start_sec = timestamp_to_seconds(match.group(2))
        end_sec = timestamp_to_seconds(match.group(3))
        text = match.group(4).strip()
        if not text:
            continue
        segments.append({
            "start": start_sec,
            "end": end_sec,
            "segment": text,
        })
    return segments


# ─── SRT formatiranje ───

def format_srt_time(seconds: float) -> str:
    sanitized = max(0.0, seconds)
    delta = datetime.timedelta(seconds=sanitized)
    total = int(delta.total_seconds())
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    ms = delta.microseconds // 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def generate_diarized_srt_content(segments: list) -> str:
    lines = []
    for i, seg in enumerate(segments):
        speaker = seg.get("speaker", "UNKNOWN")
        lines.append(str(i + 1))
        lines.append(f"{format_srt_time(seg['start'])} --> {format_srt_time(seg['end'])}")
        lines.append(f"[{speaker}] {seg['segment']}")
        lines.append("")
    return "\n".join(lines)


def format_duration(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h}h {m}m {s}s"


# ─── Speaker assignment (best-overlap, isto kao transcribe_sortformer.py) ───

def assign_speakers(srt_segments: list, speaker_segments: list) -> list:
    for seg in srt_segments:
        best_speaker = "UNKNOWN"
        best_overlap = 0.0
        for spk in speaker_segments:
            overlap_start = max(seg["start"], spk["start"])
            overlap_end = min(seg["end"], spk["end"])
            overlap = max(0.0, overlap_end - overlap_start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = spk["speaker"]
        seg["speaker"] = best_speaker
    return srt_segments


# ─── Sortformer ───

def load_sortformer_model():
    """Učitava Streaming Sortformer 4spk v2.1 — ~2 GB VRAM, staje na T4."""
    import torch
    from nemo.collections.asr.models import SortformerEncLabelModel

    print(f"   📥 Učitavam {SORTFORMER_MODEL_NAME} (~30s prvi put)...")
    diar_model = SortformerEncLabelModel.from_pretrained(SORTFORMER_MODEL_NAME)
    diar_model.eval()

    # Streaming parametri za duge fajlove (1-3h podcasti) — "very high latency".
    diar_model.sortformer_modules.chunk_len = 340
    diar_model.sortformer_modules.chunk_right_context = 40
    diar_model.sortformer_modules.fifo_len = 40
    diar_model.sortformer_modules.spkcache_update_period = 300
    diar_model.sortformer_modules.spkcache_len = 188

    if torch.cuda.is_available():
        diar_model = diar_model.to(torch.device("cuda"))
    print("   ✅ Sortformer učitan (streaming, max 4 govornika)")
    return diar_model


def run_sortformer_diarization(diar_model, wav_file: str) -> tuple:
    """Pokreće Sortformer. Vraća (speaker_segments, num_speakers).

    Normalizira labele speaker_0 → SPEAKER_00 (kompatibilno s
    Croatian RAG/article skriptama, regex /^\\[(\\w+)\\]\\s*/).
    """
    import torch
    with torch.inference_mode():
        predicted = diar_model.diarize(audio=wav_file, batch_size=1)

    if not predicted or not predicted[0]:
        return [], 0
    raw_segments = predicted[0]

    speaker_segments = []
    speaker_set = set()
    for seg in raw_segments:
        if isinstance(seg, (list, tuple)) and len(seg) >= 3:
            begin, end, label = seg[0], seg[1], seg[2]
        elif isinstance(seg, str):
            parts = seg.strip().split()
            if len(parts) < 3:
                continue
            begin, end, label = float(parts[0]), float(parts[1]), parts[2]
        else:
            continue

        label_str = str(label)
        if label_str.lower().startswith("speaker_"):
            try:
                idx = int(label_str.split("_")[1])
                normalized = f"SPEAKER_{idx:02d}"
            except (ValueError, IndexError):
                normalized = label_str.upper()
        elif label_str.isdigit():
            normalized = f"SPEAKER_{int(label_str):02d}"
        else:
            normalized = label_str.upper()

        speaker_set.add(normalized)
        speaker_segments.append({
            "start": float(begin),
            "end": float(end),
            "speaker": normalized,
        })

    return speaker_segments, len(speaker_set)


# ─── Per-file orchestration ───

def process_single_file(diar_model, wav_file: str) -> dict:
    """Diarize-only obrada: postojeći .canary.srt → Sortformer → merged diarized SRT."""
    import torch

    wav_dir = os.path.dirname(wav_file)
    basename = os.path.basename(wav_file)
    canary_srt_path = os.path.join(wav_dir, basename + CANARY_SRT_SUFFIX)
    diar_out = os.path.join(wav_dir, basename + SORTFORMER_DIARIZED_SRT_SUFFIX)

    if os.path.exists(diar_out):
        return {"status": "skipped", "reason": "diarized output already exists"}
    if not os.path.exists(canary_srt_path):
        return {"status": "skipped",
                "reason": "no .canary.srt (run Pass 1 first)"}

    file_size_mb = os.path.getsize(wav_file) / (1024 * 1024)
    print(f"      ⏳ Obrada ({file_size_mb:.1f} MB)...")

    start_time = time.time()
    pid = os.getpid()
    heartbeat_stop = threading.Event()

    def _heartbeat():
        while not heartbeat_stop.wait(60):
            elapsed = time.time() - start_time
            print(f"      ... [W{pid}] {basename} {elapsed:.0f}s elapsed", flush=True)

    hb = threading.Thread(target=_heartbeat, daemon=True)
    hb.start()

    try:
        # ─── 1. Učitaj postojeći .canary.srt ───
        print(f"      📄 Učitavam postojeći .canary.srt...")
        canary_segments = parse_canary_srt(canary_srt_path)
        if not canary_segments:
            heartbeat_stop.set()
            return {"status": "error",
                    "reason": ".canary.srt prazan ili neparsabilan",
                    "elapsed": time.time() - start_time}
        print(f"      📊 Canary: {len(canary_segments)} segmenata (reused)")

        # ─── 2. Sortformer diarizacija ───
        print(f"      🎭 Sortformer diarizacija...")
        diar_start = time.time()
        speaker_segments, num_speakers = run_sortformer_diarization(diar_model, wav_file)
        diar_elapsed = time.time() - diar_start

        if not speaker_segments:
            heartbeat_stop.set()
            return {"status": "error",
                    "reason": "Sortformer vratio prazne segmente",
                    "elapsed": time.time() - start_time}

        print(f"      📊 Sortformer: {num_speakers} govornika, "
              f"{len(speaker_segments)} segmenata ({diar_elapsed:.1f}s)")

        # ─── 3. Merge: pridruži svakom Canary segmentu govornika s max overlapom ───
        merged = assign_speakers(canary_segments, speaker_segments)

        # ─── 4. Spremi diarized SRT ───
        with open(diar_out, "w", encoding="utf-8") as f:
            f.write(generate_diarized_srt_content(merged))
        srt_size_kb = os.path.getsize(diar_out) / 1024
        print(f"      ✅ {os.path.basename(diar_out)} ({srt_size_kb:.1f} KB)")

        elapsed = time.time() - start_time
        heartbeat_stop.set()
        return {
            "status": "processed",
            "elapsed": elapsed,
            "segments": len(merged),
            "speakers": num_speakers,
            "sortformer_s": diar_elapsed,
        }

    except torch.cuda.OutOfMemoryError:
        elapsed = time.time() - start_time
        heartbeat_stop.set()
        gc.collect()
        torch.cuda.empty_cache()
        print(f"      ❌ CUDA OOM!")
        return {"status": "error", "reason": "CUDA OOM", "elapsed": elapsed}
    except Exception as e:
        elapsed = time.time() - start_time
        heartbeat_stop.set()
        print(f"      ❌ Greška: {e}")
        return {"status": "error", "reason": str(e), "elapsed": elapsed}


# ─── File discovery ───

def find_wav_files(input_dir: str) -> list:
    wav_files = []
    for root, _, files in os.walk(input_dir, followlinks=True):
        for f in files:
            if f.endswith(".wav") and not f.startswith("._"):
                wav_files.append(os.path.join(root, f))
    return sorted(wav_files)


def has_canary_srt(wav_file: str) -> bool:
    return os.path.exists(wav_file + CANARY_SRT_SUFFIX)


def has_sortformer_output(wav_file: str) -> bool:
    return os.path.exists(wav_file + SORTFORMER_DIARIZED_SRT_SUFFIX)


def install_dependencies():
    try:
        import nemo.collections.asr  # noqa: F401
        print("   ✅ NeMo toolkit prisutan")
    except ImportError:
        print("   📦 Instaliram NeMo toolkit...")
        os.system("pip install -U 'nemo_toolkit[asr]'")
        print("   ✅ NeMo instaliran")


# ─── CLI ───

def parse_args():
    parser = argparse.ArgumentParser(
        description="🎭 Sortformer-only diarizacija nad postojećim .canary.srt (T4-friendly)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Primjeri:
  # Colab T4 (free) nakon mount Drive-a
  !python diarize_only_sortformer.py \\
      --input-dir /content/drive/MyDrive/domovina_fetch_data/canary_wav

  # Test 3 fajla
  python diarize_only_sortformer.py --input-dir ./wav_files --limit 3

  # Jedan fajl
  python diarize_only_sortformer.py --file /path/to/audio.wav
"""
    )
    parser.add_argument("--input-dir", required=True,
                        help="Direktorij s WAV+canary.srt datotekama (rekurzivno)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Samo prikaz, bez obrade")
    parser.add_argument("--file", default=None,
                        help="Obradi samo jedan specifičan WAV fajl")
    parser.add_argument("--limit", type=int, default=None,
                        help="Ograniči broj fajlova (testiranje)")
    return parser.parse_args()


def main():
    args = parse_args()
    input_dir = args.input_dir

    print("╔══════════════════════════════════════════════════╗")
    print("║   🎭 SORTFORMER DIARIZE-ONLY (Pass 2)           ║")
    print("║   Reuse .canary.srt + Sortformer 4spk v2.1      ║")
    print("║   T4-FRIENDLY (~2 GB VRAM peak)                 ║")
    print("╚══════════════════════════════════════════════════╝")
    print(f"   📂 Input:  {input_dir}")
    print(f"   📜 Licenca Sortformer: NVIDIA Open Model License")
    if args.dry_run:
        print("   ⚠️  DRY RUN — samo prikaz, bez obrade")
    print("")

    if not os.path.isdir(input_dir):
        print(f"❌ Input direktorij ne postoji: {input_dir}")
        sys.exit(1)

    if args.file:
        if not os.path.isfile(args.file):
            print(f"❌ Datoteka ne postoji: {args.file}")
            sys.exit(1)
        wav_files = [args.file]
    else:
        wav_files = find_wav_files(input_dir)

    print(f"   📋 Pronađeno WAV: {len(wav_files)}")

    if len(wav_files) == 0:
        print("   ℹ️  Nema WAV datoteka.")
        return

    # Filter: imaju .canary.srt (preduvjet) AND nemaju .sortformer.diarized.srt
    with_canary = [f for f in wav_files if has_canary_srt(f)]
    without_canary = len(wav_files) - len(with_canary)
    if without_canary > 0:
        print(f"   ⚠️  Bez .canary.srt (treba Pass 1 prvo): {without_canary}")

    to_process = [f for f in with_canary if not has_sortformer_output(f)]
    already_done = len(with_canary) - len(to_process)
    if already_done > 0:
        print(f"   ⏭️  Već diarized: {already_done}")
    if args.limit and args.limit < len(to_process):
        to_process = to_process[:args.limit]
        print(f"   🔢 Ograničeno na: {args.limit} (--limit)")
    print(f"   🔄 Za obradu: {len(to_process)}")
    print("")

    if len(to_process) == 0:
        print("   ✅ Nema posla.")
        return

    if args.dry_run:
        print("   📋 Datoteke koje bi bile obrađene:")
        for wav_file in to_process[:20]:
            size_mb = os.path.getsize(wav_file) / (1024 * 1024)
            basename = os.path.basename(wav_file)
            print(f"      🔄 {basename} ({size_mb:.1f} MB)")
            print(f"         → {basename}{SORTFORMER_DIARIZED_SRT_SUFFIX}")
        if len(to_process) > 20:
            print(f"      ... i još {len(to_process) - 20}")
        print("")
        print("   ℹ️  Pokreni bez --dry-run za stvarnu obradu.")
        return

    # Setup: NeMo + Sortformer (NEMA Canary — to štedi 25+ GB VRAM-a → T4 staje)
    install_dependencies()
    diar_model = load_sortformer_model()
    print("")

    total_processed = 0
    total_skipped = 0
    total_errors = 0
    total_elapsed = 0.0
    batch_start = time.time()

    for i, wav_file in enumerate(to_process):
        basename = os.path.basename(wav_file)
        print(f"   ─────────────────────────────────────────────")
        print(f"   [{i+1}/{len(to_process)}] 🎙️  {basename}")

        result = process_single_file(diar_model, wav_file)

        if result["status"] == "processed":
            total_processed += 1
            total_elapsed += result["elapsed"]
            wall_elapsed = time.time() - batch_start
            wall_per_file = wall_elapsed / (i + 1)
            wall_remaining = (len(to_process) - i - 1) * wall_per_file
            print(f"      ⏱️  Trajalo: {format_duration(result['elapsed'])}"
                  f"  |  Govornici: {result['speakers']}"
                  f"  |  ETA: {format_duration(wall_remaining)}")
        elif result["status"] == "skipped":
            total_skipped += 1
            print(f"      ⏭️  Preskočeno: {result['reason']}")
        elif result["status"] == "error":
            total_errors += 1
            if result.get("reason") == "CUDA OOM":
                print("      💡 Preskačem na sljedeću...")

    wall_total = time.time() - batch_start
    print("")
    print("╔══════════════════════════════════════════════════╗")
    print("║   📊 SAŽETAK                                    ║")
    print("╚══════════════════════════════════════════════════╝")
    print(f"   ✅ Obrađeno:    {total_processed}")
    print(f"   ⏭️  Preskočeno:  {already_done + total_skipped}")
    print(f"   ❌ Grešaka:     {total_errors}")
    print(f"   ⏱️  Wall clock:  {format_duration(wall_total)}")
    if total_processed > 0:
        avg = total_elapsed / total_processed
        print(f"   📊 Prosjek/fajl: {format_duration(avg)}")
    print("")


if __name__ == "__main__":
    main()
