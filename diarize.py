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
import time
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
    parser.add_argument("--audio-input", choices=["waveform", "path"], default="waveform",
                        help="'waveform' (ISPRAVNO, default) ili 'path' (POVUCENO — sporije i "
                             "ne stedi memoriju; vidi docs/pipeline_memorija_i_propusnost_2026-08.md 5.1-5.3)")
    parser.add_argument("--progress-interval", type=int, default=60,
                        help="Razmak ispisa napretka diarizacije u sekundama (default: 60)")
    return parser.parse_args()


# --- SRT PARSING ---

def parse_srt(srt_path):
    """Parsira SRT datoteku i vraća listu segmenata."""
    with open(srt_path, "r", encoding="utf-8", errors="replace") as f:
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

class LogProgressHook:
    """pyannote hook koji pise obicne log retke (bez ANSI-ja).

    Knjiznicni `ProgressHook` crta `rich` progress bar; ovaj ispis zavrsava u
    pipeline logu koji se cita grepom, pa ANSI escape sekvence ondje smetaju.
    `completed`/`total` za korak "segmentation" su prozori nad snimkom, pa je
    pozicija stvarna; za ostale korake (embeddings) su batchevi — samo postotak.
    """

    def __init__(self, prefix="   ", duration_s=None, min_interval_s=60):
        self.prefix = prefix
        self.duration_s = duration_s
        self.min_interval_s = min_interval_s
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
        if frac < 1.0 and (now - self._last_print) < self.min_interval_s:
            return
        self._last_print = now
        step_elapsed = now - self._step_t0
        eta = (step_elapsed / frac - step_elapsed) if frac > 0 else 0
        where = ""
        if step_name == "segmentation" and self.duration_s:
            where = (f" | pozicija ≈ {self._hms(frac * self.duration_s)} / "
                     f"{self._hms(self.duration_s)}")
        print(f"{self.prefix}     {step_name} {frac * 100:5.1f}% ({completed}/{total})"
              f"{where} | ETA koraka {self._hms(eta)}", flush=True)


def wav_duration_s(wav_path):
    """Trajanje WAV-a iz zaglavlja (bez ucitavanja uzoraka). None ako ne uspije."""
    try:
        import soundfile as sf
        info = sf.info(wav_path)
        return info.frames / float(info.samplerate)
    except Exception:
        return None


def run_diarization(wav_path, hf_token, device="auto", min_speakers=None, max_speakers=None,
                    audio_input_mode="waveform", progress_interval=60):
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

    # Parametri za diarizaciju
    diarize_params = {}
    if min_speakers is not None:
        diarize_params["min_speakers"] = min_speakers
    if max_speakers is not None:
        diarize_params["max_speakers"] = max_speakers

    hook = LogProgressHook(duration_s=wav_duration_s(wav_path),
                           min_interval_s=progress_interval)

    if audio_input_mode == "path":
        # ⚠️ POVUCENO 2026-08-25 (isti dan kad je i uvedeno). Putanja je izgledala kao
        # ustedа memorije, ali NIJE: `Inference.__call__` ionako zove
        # `decoder.get_all_samples()` i ucita CIJELI waveform za segmentaciju. "Ravan
        # RSS" bio je waveform kratke datoteke, ne dokaz ustede.
        # Uz to je dramaticno sporija: `Audio.crop()` stvara NOVI AudioDecoder po
        # pozivu, a torchcodec < 0.14 premotava na pocetak datoteke (PR #1449; mi
        # imamo 0.10.0). Mjereno na 20 h WAV-u: crop na 0 h = 4.3 ms, na 15 h =
        # 3508 ms → 8-15 h samo dekodiranja. Waveform je SLUZBENA preporuka
        # (model card + pyannote #1955, izmjereno 21x ubrzanje), ne workaround.
        # Zastavica je zadrzana samo da mjerenje bude ponovljivo. NE koristiti u radu.
        # Detalji: docs/pipeline_memorija_i_propusnost_2026-08.md 5.1-5.3.
        print(f"   ⚠️  audio ulaz PATH je POVUCEN put — sporiji, bez ustede memorije.")
        with hook:
            result = pipeline(wav_path, hook=hook, **diarize_params)
    else:
        # Učitaj audio putem soundfile (nativno čita WAV, ne treba FFmpeg)
        print(f"   🔊 Učitavam audio s soundfile...")
        # dtype="float32" NIJE kozmetika: bez njega sf.read vraća float64, pa .float()
        # radi drugu kopiju — 3× memorije (za 3h WAV ~2 GB umjesto 0.7 GB, za 20h ~14 GB
        # umjesto 4.6 GB). Kad to prelije RAM, macOS raste swap na SISTEMSKOM disku i ruši
        # nevezane procese (Docker). Mjereno 2026-08-25. S float32 je from_numpy bez kopije
        # i .float() no-op.
        data, sample_rate = sf.read(wav_path, dtype="float32")
        waveform = torch.from_numpy(data).float().unsqueeze(0)  # (1, num_samples)

        print(f"   🔊 Pokrećem diarizaciju (audio ulaz: WAVEFORM)...")
        # Proslijedi waveform dict umjesto file patha (zaobilazi AudioDecoder)
        audio_input = {"waveform": waveform, "sample_rate": sample_rate}
        with hook:
            result = pipeline(audio_input, hook=hook, **diarize_params)
        del waveform, data, audio_input

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
        max_speakers=args.max_speakers,
        audio_input_mode=args.audio_input,
        progress_interval=args.progress_interval
    )

    # 3. Pridruži govornika svakom SRT segmentu
    srt_segments = assign_speakers(srt_segments, speaker_segments)

    # 4. Zapiši novi SRT s oznakama govornika
    write_diarized_srt(srt_segments, args.output)
    print(f"   💾 Spremljeno: {args.output}")


if __name__ == "__main__":
    main()
