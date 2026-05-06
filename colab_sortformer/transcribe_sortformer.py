#!/usr/bin/env python3
"""
transcribe_sortformer.py — Canary 1B v2 + NVIDIA Streaming Sortformer (GPU end-to-end)

EXPERIMENTALNI alternativni pipeline za stable `transcribe_canary.py` + `diarize_canary.py`.
Razlika: diarizacija se ovdje radi NVIDIA Streaming Sortformerom — *fully GPU-resident*
neuralni end-to-end model — umjesto pyannote community-1 (CPU-bound clustering).

DIZAJNIRANO ZA SCALE: namijenjeno tisućama dugih WAV fajlova (1-3h podcasti).

────────────────────────────────────────────────────────────────────────────────
LICENCA — NVIDIA Streaming Sortformer 4spk v2.1
────────────────────────────────────────────────────────────────────────────────
Model: nvidia/diar_streaming_sortformer_4spk-v2.1
Licenca: NVIDIA Open Model License Agreement
         https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/

NAPOMENA: starije Sortformer verzije (v1, v2 non-streaming) su CC-BY-NC-4.0
(non-commercial only). v2.1 streaming je pod permisivnijom NVIDIA Open Model
licencom koja **dopušta komercijalnu upotrebu** uz uvjete (atribucija, ne-zlouporaba,
itd.). Korisnik je eksplicitno potvrdio prihvaćanje rizika za ovaj MIT projekt.

Ako prebacuješ na non-streaming Sortformer (`diar_sortformer_4spk-v1` ili
`diar_sortformer_4spk-v2`), preuzimaš CC-BY-NC ograničenje — provjeri prije.

────────────────────────────────────────────────────────────────────────────────
OUTPUT NAMING — RAZLIČIT od stable canary pipeline-a
────────────────────────────────────────────────────────────────────────────────
   .sortformer.srt          — transkripcija (Canary), bez govornika
   .sortformer.csv          — CSV oblik transkripcije
   .sortformer.diarized.srt — transkripcija + [SPEAKER_XX] oznake (Sortformer)

NIKAD ne piše u `.canary.*` namespace — stable `run_pipeline.sh` ostaje funkcionalan.

────────────────────────────────────────────────────────────────────────────────
Idempotentno: preskače WAV-ove koji već imaju .sortformer.diarized.srt.
Heartbeat svakih 60s, ETA na osnovu prosjeka, nastavak pri grešci jednog fajla.
────────────────────────────────────────────────────────────────────────────────
"""

import argparse
import csv
import datetime
import gc
import os
import sys
import threading
import time
from pathlib import Path


# ─── Sufiksi (NIKAD ne kolidira s .canary.*) ───
SORTFORMER_SRT_SUFFIX           = ".sortformer.srt"
SORTFORMER_CSV_SUFFIX           = ".sortformer.csv"
SORTFORMER_DIARIZED_SRT_SUFFIX  = ".sortformer.diarized.srt"

# ─── Modeli ───
CANARY_MODEL_NAME      = "nvidia/canary-1b-v2"
SORTFORMER_MODEL_NAME  = "nvidia/diar_streaming_sortformer_4spk-v2.1"


# ─── SRT formatiranje ───

def format_srt_time(seconds: float) -> str:
    """Pretvara sekunde u SRT format HH:MM:SS,mmm."""
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
    """Generira SRT iz segmentnih timestampova (bez govornika)."""
    lines = []
    for i, ts in enumerate(segment_timestamps):
        lines.append(str(i + 1))
        lines.append(f"{format_srt_time(ts['start'])} --> {format_srt_time(ts['end'])}")
        lines.append(ts['segment'])
        lines.append("")
    return "\n".join(lines)


def generate_diarized_srt_content(segment_timestamps: list) -> str:
    """Generira SRT s [SPEAKER_XX] oznakama ispred teksta."""
    lines = []
    for i, ts in enumerate(segment_timestamps):
        speaker = ts.get("speaker", "UNKNOWN")
        lines.append(str(i + 1))
        lines.append(f"{format_srt_time(ts['start'])} --> {format_srt_time(ts['end'])}")
        lines.append(f"[{speaker}] {ts['segment']}")
        lines.append("")
    return "\n".join(lines)


def sec_to_hms(seconds: float) -> str:
    """Pretvara sekunde u HH:MM:SS format za CSV."""
    seconds = round(seconds)
    return str(datetime.timedelta(seconds=seconds))


def format_duration(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h}h {m}m {s}s"


# ─── Speaker assignment (best-overlap, isto kao diarize_canary.py:assign_speakers) ───

def assign_speakers(srt_segments: list, speaker_segments: list) -> list:
    """Za svaki SRT segment, pronađi govornika s najvećim overlapom.

    speaker_segments: lista dict-ova {start, end, speaker}
    srt_segments: lista dict-ova {start, end, segment}  (in-place dodaje 'speaker')
    """
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


# ─── Glavni program ───

def parse_args():
    parser = argparse.ArgumentParser(
        description="🧪 Canary 1B v2 + Streaming Sortformer (GPU end-to-end pipeline)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Primjeri:
  # Google Colab (nakon mount Google Drive)
  !python transcribe_sortformer.py --input-dir /content/drive/MyDrive/domovina_fetch_data/canary_wav

  # Lokalno (test)
  python transcribe_sortformer.py --input-dir ./wav_files --dry-run

  # Jedan fajl
  python transcribe_sortformer.py --file /path/to/audio.wav

  # Limit za testiranje
  python transcribe_sortformer.py --input-dir ./wav_files --limit 3
"""
    )
    parser.add_argument("--input-dir", required=True,
                        help="Direktorij s WAV datotekama (rekurzivno)")
    parser.add_argument("--output-dir", default=None,
                        help="Direktorij za output (default: pored WAV-a)")
    parser.add_argument("--source-lang", default="hr",
                        help="Izvorni jezik za Canary — ISO kod (default: hr)")
    parser.add_argument("--target-lang", default="hr",
                        help="Ciljni jezik za Canary — ISO kod (default: hr)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Samo prikaz, bez obrade")
    parser.add_argument("--file", default=None,
                        help="Obradi samo jedan specifičan WAV fajl")
    parser.add_argument("--limit", type=int, default=None,
                        help="Ograniči broj fajlova (testiranje)")
    return parser.parse_args()


def find_wav_files(input_dir: str) -> list:
    """Pronalazi sve WAV-ove rekurzivno (followlinks zbog storage/output/ symlinka)."""
    wav_files = []
    for root, _, files in os.walk(input_dir, followlinks=True):
        for f in files:
            if f.endswith(".wav") and not f.startswith("._"):
                wav_files.append(os.path.join(root, f))
    return sorted(wav_files)


def has_sortformer_output(wav_file: str) -> bool:
    """Postoji li već diarized output za ovaj WAV (idempotentnost)."""
    wav_dir = os.path.dirname(wav_file)
    basename = os.path.basename(wav_file)
    diar_path = os.path.join(wav_dir, basename + SORTFORMER_DIARIZED_SRT_SUFFIX)
    return os.path.exists(diar_path)


def install_dependencies():
    """Provjerava NeMo (sadrži Canary + Sortformer)."""
    try:
        import nemo.collections.asr  # noqa: F401
        print("   ✅ NeMo toolkit prisutan")
    except ImportError:
        print("   📦 Instaliram NeMo toolkit...")
        os.system("pip install -U 'nemo_toolkit[asr]'")
        print("   ✅ NeMo instaliran")


def load_canary_model():
    """Učitava Canary 1B v2 transcription model (BF16 ako GPU podržava)."""
    import torch
    from nemo.collections.asr.models import ASRModel

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"   🖥️  Uređaj: {device.upper()}")
    if device == "cpu":
        print("   ⚠️  GPU nije dostupan — bit će JAKO sporo.")
        print("      💡 Colab: Runtime → Change runtime type → G4 (Pro+)")

    print(f"   📥 Učitavam {CANARY_MODEL_NAME} (~1-2 min prvi put)...")
    model = ASRModel.from_pretrained(model_name=CANARY_MODEL_NAME)
    model.eval()

    if device == "cuda" and torch.cuda.is_bf16_supported():
        model = model.to(torch.bfloat16)
        print("   ⚡ Canary BF16 aktivan")
    print("   ✅ Canary učitan")
    return model, device


def load_sortformer_model():
    """Učitava Streaming Sortformer 4spk v2.1 — GPU diarization."""
    import torch
    from nemo.collections.asr.models import SortformerEncLabelModel

    print(f"   📥 Učitavam {SORTFORMER_MODEL_NAME} (~30s prvi put)...")
    diar_model = SortformerEncLabelModel.from_pretrained(SORTFORMER_MODEL_NAME)
    diar_model.eval()

    # Streaming parametri za duge fajlove (1-3h podcasti).
    # Vrijednosti iz NVIDIA preporuke za "very high latency" scenario (30.4s) —
    # idealno za batch (latencija nebitna, kvaliteta i memorija prioritet).
    # Vidi: https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1
    diar_model.sortformer_modules.chunk_len = 340
    diar_model.sortformer_modules.chunk_right_context = 40
    diar_model.sortformer_modules.fifo_len = 40
    diar_model.sortformer_modules.spkcache_update_period = 300
    diar_model.sortformer_modules.spkcache_len = 188

    if torch.cuda.is_available():
        diar_model = diar_model.to(torch.device("cuda"))
    print("   ✅ Sortformer učitan (streaming, max 4 govornika)")
    return diar_model


def run_canary_transcription(canary_model, wav_file: str,
                             source_lang: str, target_lang: str) -> list:
    """Pokreće Canary transkripciju, vraća listu segmenata s timestampovima."""
    import torch
    with torch.inference_mode():
        output = canary_model.transcribe(
            [wav_file],
            timestamps=True,
            source_lang=source_lang,
            target_lang=target_lang,
        )
    if (not output or not isinstance(output, list) or not output[0]
            or not hasattr(output[0], 'timestamp') or not output[0].timestamp
            or 'segment' not in output[0].timestamp):
        raise RuntimeError("Canary: neočekivan output format")
    return output[0].timestamp['segment']


def run_sortformer_diarization(diar_model, wav_file: str) -> tuple:
    """Pokreće Sortformer na WAV-u. Vraća (speaker_segments, num_speakers).

    Sortformer.diarize() vraća listu listi tupleova: [[(begin_s, end_s, "speaker_0"), ...]]
    NeMo formatira speaker_index kao string "speaker_0", "speaker_1"...
    Mi normaliziramo na "SPEAKER_00", "SPEAKER_01"... za kompatibilnost s
    postojećim Croatian RAG/article skriptama (regex /^\\[(\\w+)\\]\\s*/).
    """
    import torch
    with torch.inference_mode():
        predicted = diar_model.diarize(audio=wav_file, batch_size=1)

    # predicted je lista po batch elementu — uzimamo prvi (jedini)
    if not predicted or not predicted[0]:
        return [], 0
    raw_segments = predicted[0]

    speaker_segments = []
    speaker_set = set()
    for seg in raw_segments:
        # Format može biti tuple (begin, end, speaker_label) ili string "begin end label"
        if isinstance(seg, (list, tuple)) and len(seg) >= 3:
            begin, end, label = seg[0], seg[1], seg[2]
        elif isinstance(seg, str):
            parts = seg.strip().split()
            if len(parts) < 3:
                continue
            begin, end, label = float(parts[0]), float(parts[1]), parts[2]
        else:
            continue

        # Normaliziraj label: speaker_0 → SPEAKER_00, speaker_1 → SPEAKER_01...
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


def process_single_file(canary_model, diar_model, wav_file: str,
                        source_lang: str, target_lang: str) -> dict:
    """End-to-end obrada jednog WAV-a: Canary → SRT → Sortformer → merged diarized SRT.

    NIKAD ne prepisuje postojeće datoteke. Heartbeat tijekom dugačke obrade.
    """
    import torch

    wav_dir = os.path.dirname(wav_file)
    basename = os.path.basename(wav_file)
    srt_out = os.path.join(wav_dir, basename + SORTFORMER_SRT_SUFFIX)
    csv_out = os.path.join(wav_dir, basename + SORTFORMER_CSV_SUFFIX)
    diar_out = os.path.join(wav_dir, basename + SORTFORMER_DIARIZED_SRT_SUFFIX)

    # Dvostruka idempotentnost provjera
    if os.path.exists(diar_out):
        return {"status": "skipped", "reason": "diarized output already exists"}

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
        # ─── 1. Canary transkripcija ───
        print(f"      🐤 Canary transkripcija...")
        canary_start = time.time()
        segment_timestamps = run_canary_transcription(
            canary_model, wav_file, source_lang, target_lang
        )
        canary_elapsed = time.time() - canary_start
        print(f"      📊 Canary: {len(segment_timestamps)} segmenata "
              f"({canary_elapsed:.1f}s)")

        # Spremi raw transkripciju (bez govornika) — useful za debugging
        if not os.path.exists(srt_out):
            with open(srt_out, 'w', encoding='utf-8') as f:
                f.write(generate_srt_content(segment_timestamps))
        if not os.path.exists(csv_out):
            with open(csv_out, 'w', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                writer.writerow(["Start (HH:MM:SS)", "End (HH:MM:SS)", "Segment"])
                for ts in segment_timestamps:
                    writer.writerow([sec_to_hms(ts['start']),
                                     sec_to_hms(ts['end']),
                                     ts['segment']])

        # ─── 2. Sortformer diarizacija ───
        print(f"      🎭 Sortformer diarizacija...")
        diar_start = time.time()
        speaker_segments, num_speakers = run_sortformer_diarization(diar_model, wav_file)
        diar_elapsed = time.time() - diar_start

        if not speaker_segments:
            heartbeat_stop.set()
            return {"status": "error", "reason": "Sortformer vratio prazne segmente",
                    "elapsed": time.time() - start_time}

        print(f"      📊 Sortformer: {num_speakers} govornika, "
              f"{len(speaker_segments)} segmenata ({diar_elapsed:.1f}s)")

        # ─── 3. Merge: pridruži svakom Canary segmentu govornika s max overlapom ───
        merged = assign_speakers(
            [{"start": ts['start'], "end": ts['end'], "segment": ts['segment']}
             for ts in segment_timestamps],
            speaker_segments,
        )

        # ─── 4. Spremi diarized SRT ───
        if not os.path.exists(diar_out):
            with open(diar_out, 'w', encoding='utf-8') as f:
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
            "canary_s": canary_elapsed,
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


def main():
    args = parse_args()

    input_dir = args.input_dir
    source_lang = args.source_lang
    target_lang = args.target_lang

    print("╔══════════════════════════════════════════════════╗")
    print("║   🧪 SORTFORMER GPU END-TO-END PIPELINE         ║")
    print("║   Canary 1B v2 + Streaming Sortformer 4spk v2.1 ║")
    print("╚══════════════════════════════════════════════════╝")
    print(f"   📂 Input:  {input_dir}")
    print(f"   🗣️  Jezik: {source_lang} → {target_lang}")
    print(f"   📜 Licenca Sortformer: NVIDIA Open Model License")
    if args.dry_run:
        print("   ⚠️  DRY RUN — samo prikaz, bez obrade")
    print("")

    if not os.path.isdir(input_dir):
        print(f"❌ Input direktorij ne postoji: {input_dir}")
        sys.exit(1)

    # Pronađi WAV-ove
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

    to_process = [f for f in wav_files if not has_sortformer_output(f)]
    already_done = len(wav_files) - len(to_process)
    if already_done > 0:
        print(f"   ⏭️  Preskočeno (već diarized): {already_done}")
    if args.limit and args.limit < len(to_process):
        to_process = to_process[:args.limit]
        print(f"   🔢 Ograničeno na: {args.limit} (--limit)")
    print(f"   🔄 Za obradu: {len(to_process)}")
    print("")

    if len(to_process) == 0:
        print("   ✅ Sve datoteke su već obrađene!")
        return

    if args.dry_run:
        print("   📋 Datoteke koje bi bile obrađene:")
        for wav_file in to_process:
            size_mb = os.path.getsize(wav_file) / (1024 * 1024)
            basename = os.path.basename(wav_file)
            print(f"      🔄 {basename} ({size_mb:.1f} MB)")
            print(f"         → {basename}{SORTFORMER_DIARIZED_SRT_SUFFIX}")
        print("")
        print("   ℹ️  Pokreni bez --dry-run za stvarnu obradu.")
        return

    # ─── Setup: install + load both models ───
    install_dependencies()
    canary_model, device = load_canary_model()
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

        result = process_single_file(
            canary_model, diar_model, wav_file, source_lang, target_lang
        )

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

    # ─── Sažetak ───
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
