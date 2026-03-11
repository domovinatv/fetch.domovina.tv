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
    with open(srt_path, "r", encoding="utf-8") as f:
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

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"   Uređaj: {device.upper()}")

    if device == "cpu":
        print("   UPOZORENJE: GPU nije dostupan! Diarizacija će biti spora.")
        print("   Na Colabu: Runtime > Change runtime type > T4 GPU")

    if device == "cuda":
        vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        gpu_name = torch.cuda.get_device_name(0)
        print(f"   GPU: {gpu_name} ({vram_gb:.1f} GB VRAM)")

    print("   Učitavam pyannote/speaker-diarization-community-1 model...")
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-community-1",
        token=hf_token
    )
    pipeline.to(torch.device(device))
    print("   Model učitan (community-1, exclusive diarization mode)")

    return pipeline, device


def run_diarization(pipeline, wav_file, min_speakers=None, max_speakers=None):
    """Pokreće pyannote community-1 diarizaciju na jednom WAV fajlu.

    Koristi exclusive_speaker_diarization mode koji daje točno jednog govornika
    u svakom trenutku (bez overlapa), idealno za alignment s SRT titlovima.
    """
    import torch
    import soundfile as sf

    # Učitaj audio
    data, sample_rate = sf.read(wav_file)
    waveform = torch.from_numpy(data).float().unsqueeze(0)

    # Parametri
    diarize_params = {}
    if min_speakers is not None:
        diarize_params["min_speakers"] = min_speakers
    if max_speakers is not None:
        diarize_params["max_speakers"] = max_speakers

    # Pokreni diarizaciju
    audio_input = {"waveform": waveform, "sample_rate": sample_rate}
    result = pipeline(audio_input, **diarize_params)

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


def _worker_init(hf_token, min_speakers, max_speakers):
    """Inicijalizacija worker procesa — svaki učitava vlastiti pyannote pipeline."""
    global _worker_pipeline, _worker_min_speakers, _worker_max_speakers
    import torch
    from pyannote.audio import Pipeline

    device = "cuda" if torch.cuda.is_available() else "cpu"
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-community-1",
        token=hf_token
    )
    pipeline.to(torch.device(device))

    _worker_pipeline = pipeline
    _worker_min_speakers = min_speakers
    _worker_max_speakers = max_speakers


def _worker_diarize(wav_file):
    """Worker funkcija: diarizira jedan fajl. Vraća (wav_file, result)."""
    global _worker_pipeline, _worker_min_speakers, _worker_max_speakers

    wav_dir = os.path.dirname(wav_file)
    basename = os.path.basename(wav_file)
    srt_input = os.path.join(wav_dir, basename + CANARY_SRT_SUFFIX)
    diarized_output = os.path.join(wav_dir, basename + DIARIZED_SRT_SUFFIX)
    pid = os.getpid()

    if os.path.exists(diarized_output):
        return wav_file, {"status": "skipped", "reason": "already exists"}
    if not os.path.exists(srt_input):
        return wav_file, {"status": "skipped", "reason": "no .canary.srt"}

    file_size_mb = os.path.getsize(wav_file) / (1024 * 1024)
    print(f"      [W{pid}] START {basename} ({file_size_mb:.0f} MB)", flush=True)

    start_time = time.time()
    try:
        srt_segments = parse_srt(srt_input)
        if not srt_segments:
            return wav_file, {"status": "error", "reason": "empty .canary.srt", "elapsed": 0}

        speaker_segments, num_speakers = run_diarization(
            _worker_pipeline, wav_file,
            min_speakers=_worker_min_speakers,
            max_speakers=_worker_max_speakers
        )

        srt_segments = assign_speakers(srt_segments, speaker_segments)
        elapsed = time.time() - start_time

        if not os.path.exists(diarized_output):
            write_diarized_srt(srt_segments, diarized_output)

        print(f"      [W{pid}] DONE  {basename} {elapsed:.0f}s {num_speakers}spk", flush=True)
        return wav_file, {
            "status": "diarized", "elapsed": elapsed,
            "segments": len(srt_segments), "speakers": num_speakers
        }
    except Exception as e:
        elapsed = time.time() - start_time
        print(f"      [W{pid}] ERROR {basename}: {e}", flush=True)
        return wav_file, {"status": "error", "reason": str(e), "elapsed": elapsed}


# ─── Batch obrada ───

def has_diarized_transcript(wav_file):
    """Provjerava postoji li diarized transkript za WAV datoteku."""
    wav_dir = os.path.dirname(wav_file)
    basename = os.path.basename(wav_file)
    return os.path.exists(os.path.join(wav_dir, basename + DIARIZED_SRT_SUFFIX))


def diarize_single_file(pipeline, wav_file, min_speakers=None, max_speakers=None):
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
            max_speakers=max_speakers
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
        help="Broj paralelnih procesa (default: 1). Svaki koristi ~3 GB RAM. Za CPU VM: --workers $(nproc)"
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
    if args.dry_run:
        print("   DRY RUN — samo prikaz, bez diarizacije")
    print("")

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
        # Sve WAV datoteke
        all_wav = sorted([
            str(p) for p in Path(input_dir).rglob("*.wav")
            if not p.name.startswith("._")
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

    total_diarized = 0
    total_skipped = 0
    total_errors = 0
    total_elapsed = 0.0
    batch_start = time.time()

    if args.workers > 1:
        # ─── Paralelna obrada ───
        from concurrent.futures import ProcessPoolExecutor, as_completed

        print(f"   Pokrećem {args.workers} worker procesa (svaki učitava vlastiti model)...")
        print("")

        ctx = multiprocessing.get_context("spawn")
        with ProcessPoolExecutor(
            max_workers=args.workers,
            mp_context=ctx,
            initializer=_worker_init,
            initargs=(hf_token, args.min_speakers, args.max_speakers)
        ) as executor:
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
                elif result["status"] == "skipped":
                    total_skipped += 1
                elif result["status"] == "error":
                    total_errors += 1
                    print(f"   [{done_count}/{len(to_process)}] {basename}  ERROR: {result.get('reason')}")
    else:
        # ─── Sekvencijalna obrada (1 worker, default) ───
        pipeline, device = load_diarization_pipeline(hf_token)
        print("")

        for i, wav_file in enumerate(to_process):
            basename = os.path.basename(wav_file)
            print(f"   ─────────────────────────────────────────────")
            print(f"   [{i+1}/{len(to_process)}] {basename}")

            result = diarize_single_file(
                pipeline, wav_file,
                min_speakers=args.min_speakers,
                max_speakers=args.max_speakers
            )

            if result["status"] == "diarized":
                total_diarized += 1
                total_elapsed += result["elapsed"]
                avg_per_file = total_elapsed / total_diarized
                remaining = (len(to_process) - i - 1) * avg_per_file
                print(f"      Trajalo: {format_duration(result['elapsed'])}  |  ETA: {format_duration(remaining)}")
            elif result["status"] == "skipped":
                total_skipped += 1
                print(f"      Preskočeno: {result['reason']}")
            elif result["status"] == "error":
                total_errors += 1
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
