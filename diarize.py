#!/usr/bin/env python3
"""
diarize.py

Hibridna diarizacija: koristi pyannote.audio (na MPS/Metal GPU) za
prepoznavanje govornika, a postojeći whisper.cpp SRT za tekst transkripcije.

Ulaz:
  - WAV datoteka (audio)
  - SRT datoteka (generirana whisper.cpp-om)

Izlaz:
  - .diarized.srt datoteka s oznakom govornika ispred svakog segmenta

Korištenje:
  python3 diarize.py \\
    --wav /put/do/audio.wav \\
    --srt /put/do/audio.wav.srt \\
    --output /put/do/audio.wav.diarized.srt \\
    --hf-token TVOJ_HUGGINGFACE_TOKEN

Preduvjeti:
  pip install pyannote.audio torch
  (Prihvati uvjete za pyannote modele na huggingface.co)
"""

import argparse
import re
import sys
import os
from datetime import timedelta

def parse_args():
    parser = argparse.ArgumentParser(description="Hibridna diarizacija: pyannote + whisper.cpp SRT")
    parser.add_argument("--wav", required=True, help="Putanja do WAV audio datoteke")
    parser.add_argument("--srt", required=True, help="Putanja do postojećeg SRT fajla (whisper.cpp)")
    parser.add_argument("--output", required=True, help="Putanja za izlazni diarized SRT")
    parser.add_argument("--hf-token", required=True, help="HuggingFace access token za pyannote modele")
    parser.add_argument("--device", default="auto", help="PyTorch device: auto, mps, cpu (default: auto)")
    parser.add_argument("--min-speakers", type=int, default=None, help="Minimalan broj govornika")
    parser.add_argument("--max-speakers", type=int, default=None, help="Maksimalan broj govornika")
    return parser.parse_args()


# --- SRT PARSING ---

def parse_srt(srt_path):
    """Parsira SRT datoteku i vraća listu segmenata."""
    with open(srt_path, "r", encoding="utf-8") as f:
        content = f.read()

    # SRT format: indeks\ntimestamp --> timestamp\ntekst\n\n
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


def seconds_to_timestamp(sec):
    """Konvertira sekunde u SRT format HH:MM:SS,mmm."""
    td = timedelta(seconds=sec)
    total_seconds = int(td.total_seconds())
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    millis = int((sec - int(sec)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


# --- DIARIZACIJA ---

def run_diarization(wav_path, hf_token, device="auto", min_speakers=None, max_speakers=None):
    """Pokreće pyannote diarizaciju na MPS (Metal GPU) ili CPU."""
    import torch
    import soundfile as sf
    from pyannote.audio import Pipeline

    # Automatski odabir uređaja
    if device == "auto":
        if torch.backends.mps.is_available():
            device = "mps"
            print(f"   🖥️  Koristim Metal GPU (MPS)")
        elif torch.cuda.is_available():
            device = "cuda"
            print(f"   🖥️  Koristim CUDA GPU")
        else:
            device = "cpu"
            print(f"   🖥️  Koristim CPU (nema GPU akceleracije)")
    else:
        print(f"   🖥️  Koristim: {device}")

    print(f"   📥 Učitavam pyannote model...")
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        token=hf_token
    )
    pipeline.to(torch.device(device))

    # Učitaj audio putem soundfile (nativno čita WAV, ne treba FFmpeg)
    print(f"   🔊 Učitavam audio s soundfile...")
    data, sample_rate = sf.read(wav_path)
    waveform = torch.from_numpy(data).float().unsqueeze(0)  # (1, num_samples)

    print(f"   🔊 Pokrećem diarizaciju...")
    
    # Parametri za diarizaciju
    diarize_params = {}
    if min_speakers is not None:
        diarize_params["min_speakers"] = min_speakers
    if max_speakers is not None:
        diarize_params["max_speakers"] = max_speakers

    # Proslijedi waveform dict umjesto file patha (zaobilazi AudioDecoder)
    audio_input = {"waveform": waveform, "sample_rate": sample_rate}
    result = pipeline(audio_input, **diarize_params)

    # pyannote 4.x vraća DiarizeOutput, starije verzije vraćaju Annotation
    # DiarizeOutput ima .speaker_diarization atribut koji je Annotation
    if hasattr(result, 'speaker_diarization'):
        diarization = result.speaker_diarization
    else:
        diarization = result

    # Konvertiraj u listu segmenata
    speaker_segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        speaker_segments.append({
            "start": turn.start,
            "end": turn.end,
            "speaker": speaker
        })

    print(f"   ✅ Diarizacija gotova: {len(speaker_segments)} segmenata, "
          f"{len(set(s['speaker'] for s in speaker_segments))} govornika")

    return speaker_segments


def assign_speakers(srt_segments, speaker_segments):
    """
    Za svaki SRT segment, pronađi govornika koji ima najveći
    overlap s tim vremenskim rasponom.
    """
    for seg in srt_segments:
        best_speaker = "UNKNOWN"
        best_overlap = 0.0

        for spk in speaker_segments:
            # Izračunaj overlap
            overlap_start = max(seg["start"], spk["start"])
            overlap_end = min(seg["end"], spk["end"])
            overlap = max(0, overlap_end - overlap_start)

            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = spk["speaker"]

        seg["speaker"] = best_speaker

    return srt_segments


def write_diarized_srt(segments, output_path):
    """Zapisuje SRT s oznakom govornika."""
    with open(output_path, "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, 1):
            start_ts = seconds_to_timestamp(seg["start"])
            end_ts = seconds_to_timestamp(seg["end"])
            speaker = seg.get("speaker", "UNKNOWN")

            f.write(f"{i}\n")
            f.write(f"{start_ts} --> {end_ts}\n")
            f.write(f"[{speaker}] {seg['text']}\n")
            f.write("\n")


# --- MAIN ---

def main():
    args = parse_args()

    # Provjera ulaznih datoteka
    if not os.path.exists(args.wav):
        print(f"❌ WAV datoteka ne postoji: {args.wav}")
        sys.exit(1)
    if not os.path.exists(args.srt):
        print(f"❌ SRT datoteka ne postoji: {args.srt}")
        sys.exit(1)

    print(f"   📄 WAV: {os.path.basename(args.wav)}")
    print(f"   📄 SRT: {os.path.basename(args.srt)}")

    # 1. Parsiraj postojeći SRT (od whisper.cpp)
    srt_segments = parse_srt(args.srt)
    print(f"   📝 Parsirano {len(srt_segments)} SRT segmenata")

    if len(srt_segments) == 0:
        print("❌ SRT datoteka je prazna ili neispravan format!")
        sys.exit(1)

    # 2. Pokreni pyannote diarizaciju (na MPS/Metal GPU)
    speaker_segments = run_diarization(
        args.wav,
        args.hf_token,
        device=args.device,
        min_speakers=args.min_speakers,
        max_speakers=args.max_speakers
    )

    # 3. Pridruži govornika svakom SRT segmentu
    srt_segments = assign_speakers(srt_segments, speaker_segments)

    # 4. Zapiši novi SRT s oznakama govornika
    write_diarized_srt(srt_segments, args.output)
    print(f"   💾 Spremljeno: {args.output}")


if __name__ == "__main__":
    main()
