#!/usr/bin/env python3
"""
extract_speaker_embeddings.py

Backfill skripta koja iz postojećih dijariziranih SRT-ova + WAV-ova ekstrahira
**average voice embedding po lokalnom speaker tag-u**.

Podržani modeli (multi-model registry, pokreće se s `--model`):
  • `titanet`              → nvidia/speakerverification_en_titanet_large (NeMo, default)
  • `pyannote_wespeaker34` → pyannote/wespeaker-voxceleb-resnet34-LM (pyannote.audio)

Multi-model strategija: svaki model ima svoj output fajl
(`*.canary.diarized.embeddings.{model_key}.json`) — idempotentni per-model imamo
mogućnost dodavati nove modele kasnije bez re-procesiranja postojećih. Ensemble
retrieval (Reciprocal Rank Fusion preko više modela) radi se u downstream
domovina-rag importu, NE ovdje (vidi rag plan §15.5).

Output filename: `*.<source>.diarized.embeddings.<model_key>.json`
Format definiran u `docs/data_contract.md` §7.

PRINCIP RADA:
  1. Rekurzivno skenira --input-dir za `*.<source>.diarized.srt` datoteke
  2. Za svaku provjerava postoji li već `.embeddings.json` → preskače (idempotentno)
  3. Pronalazi pripadajući `.wav` (16kHz mono)
  4. Parsira SRT, izvuče vremenske segmente po speakeru
  5. Za svaki speaker s dovoljno govora (>=3s ukupno) extrahira embeddinge per segment,
     prosjek + L2 normalize
  6. Spremi JSON, ažuriraj done cache

OUTPUT FORMAT (per fajl):
  {
    "version": 2,
    "generated_at": "2026-05-12T14:23:45Z",
    "model_key": "titanet",
    "model_id": "nvidia/speakerverification_en_titanet_large",
    "embedding_dim": 192,
    "source_diarization": "canary",  // ili "sortformer"
    "embeddings": {
      "SPEAKER_00": {
        "vector": [N floats, L2-normalized],
        "total_speech_sec": 642.3,
        "num_segments": 87,
        "confidence": 0.94  // monotono raste s broj segmenata, max 1.0
      },
      ...
    }
  }

PRIMJERI:
  # Backfill default modela (TitaNet) za canary diarizaciju
  python extract_speaker_embeddings.py --input-dir /content/drive/MyDrive/domovina_fetch_data/canary_wav

  # Drugi model (pyannote-wespeaker baseline) — paralelno za ensemble
  python extract_speaker_embeddings.py --input-dir ... --model pyannote_wespeaker34

  # Sortformer outputs (eksperimentalno)
  python extract_speaker_embeddings.py --input-dir ... --source sortformer

  # Samo jedan kanal, dry-run (lokalno na Mac Mini)
  python extract_speaker_embeddings.py --input-dir /Volumes/DOMOVINA1TB/.../canary_wav \\
      --channel lood_podcast --dry-run

  # Limit na prvih 10 datoteka (smoke test)
  python extract_speaker_embeddings.py --input-dir ... --limit 10
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch

# Heuristika za audio loading — pokušaj soundfile, fallback na librosa
try:
    import soundfile as sf
except ImportError:
    sf = None
import librosa


# ─── KONFIGURACIJA ──────────────────────────────────────────────────

TARGET_SR = 16000
MIN_SEGMENT_SEC = 1.0          # ignoriraj segmente kraće od 1s
MIN_TOTAL_SPEECH_SEC = 3.0     # ignoriraj speakere s ukupno < 3s govora
HEARTBEAT_SEC = 60             # progress update svakih N sekundi


# ─── MODEL REGISTRY ─────────────────────────────────────────────────

class TitaNetWrapper:
    """NVIDIA NeMo TitaNet-Large speaker embedding extractor."""

    model_key = "titanet"
    model_id = "nvidia/speakerverification_en_titanet_large"
    embedding_dim = 192

    def __init__(self, device):
        try:
            from nemo.collections.asr.models import EncDecSpeakerLabelModel
        except ImportError:
            raise ImportError(
                "NeMo nije instaliran za --model=titanet. "
                "Pokreni: pip install 'nemo_toolkit[asr]'"
            )
        self.model = EncDecSpeakerLabelModel.from_pretrained(self.model_id).to(device).eval()
        self.device = device

    def embed(self, segment_audio: np.ndarray) -> np.ndarray:
        """Vraća 1-D embedding vector za audio segment (mono float32, 16kHz)."""
        seg_tensor = torch.tensor(segment_audio, dtype=torch.float32).unsqueeze(0).to(self.device)
        length_tensor = torch.tensor([seg_tensor.shape[1]], dtype=torch.long).to(self.device)
        with torch.no_grad():
            _, emb = self.model.forward(input_signal=seg_tensor, input_signal_length=length_tensor)
        return emb.squeeze(0).cpu().numpy()


class PyannoteWeSpeaker34Wrapper:
    """Pyannote-integrirani wespeaker-voxceleb-resnet34-LM (baseline, Apache 2.0)."""

    model_key = "pyannote_wespeaker34"
    model_id = "pyannote/wespeaker-voxceleb-resnet34-LM"
    embedding_dim = 256

    def __init__(self, device):
        try:
            from pyannote.audio import Model
            from pyannote.audio.pipelines.speaker_verification import PretrainedSpeakerEmbedding
        except ImportError:
            raise ImportError(
                "pyannote.audio nije instaliran za --model=pyannote_wespeaker34. "
                "Pokreni: pip install pyannote.audio"
            )
        # Pyannote vraća Inference-like callable
        self.model = PretrainedSpeakerEmbedding(self.model_id, device=torch.device(device))
        self.device = device

    def embed(self, segment_audio: np.ndarray) -> np.ndarray:
        # pyannote očekuje (1, 1, samples) za mono
        seg_tensor = torch.tensor(segment_audio, dtype=torch.float32).reshape(1, 1, -1).to(self.device)
        with torch.no_grad():
            emb = self.model(seg_tensor)
        return np.asarray(emb).squeeze()


MODEL_REGISTRY = {
    "titanet": TitaNetWrapper,
    "pyannote_wespeaker34": PyannoteWeSpeaker34Wrapper,
}


# ─── SRT PARSING ────────────────────────────────────────────────────

SRT_TIMESTAMP_RE = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[,\.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,\.](\d{3})"
)
SPEAKER_TAG_RE = re.compile(r"^\[(SPEAKER_\d+)\]")


def timestamp_to_seconds(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def parse_srt_for_speakers(srt_path):
    """
    Parsira SRT, vraća dict[speaker_tag] -> list of (start_sec, end_sec).
    """
    speaker_segments = {}
    with open(srt_path, "r", encoding="utf-8") as f:
        content = f.read()

    # SRT blokovi su razdvojeni dvostrukim newline-om
    blocks = re.split(r"\n\n+", content.strip())
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 3:
            continue

        # Linija 0: indeks, Linija 1: timestamps, Linija 2+: tekst
        ts_match = SRT_TIMESTAMP_RE.search(lines[1])
        if not ts_match:
            continue

        start = timestamp_to_seconds(*ts_match.groups()[:4])
        end = timestamp_to_seconds(*ts_match.groups()[4:])
        if end <= start:
            continue

        text_first_line = lines[2] if len(lines) > 2 else ""
        speaker_match = SPEAKER_TAG_RE.match(text_first_line)
        if not speaker_match:
            continue

        speaker = speaker_match.group(1)
        speaker_segments.setdefault(speaker, []).append((start, end))

    return speaker_segments


# ─── AUDIO LOADING ──────────────────────────────────────────────────

def load_wav_16k_mono(wav_path):
    """
    Vraća (np.array float32, sr=16000). Reseempla ako treba.
    """
    if sf is not None:
        wav, sr = sf.read(str(wav_path), dtype="float32", always_2d=False)
    else:
        wav, sr = librosa.load(str(wav_path), sr=None, mono=False)

    if wav.ndim > 1:
        wav = wav.mean(axis=-1)  # mono mix

    if sr != TARGET_SR:
        wav = librosa.resample(wav, orig_sr=sr, target_sr=TARGET_SR)
        sr = TARGET_SR

    return wav.astype(np.float32), sr


# ─── EMBEDDING EXTRACTION ───────────────────────────────────────────

def extract_embeddings_for_file(srt_path, wav_path, model_wrapper, source_label):
    """
    Glavna logika: parsira SRT, ekstrahira embeddinge po speakeru, vraća dict za JSON spremanje.
    """
    speaker_segments = parse_srt_for_speakers(srt_path)
    if not speaker_segments:
        return None

    wav, sr = load_wav_16k_mono(wav_path)

    speaker_embeddings = {}
    for speaker_tag, segments in speaker_segments.items():
        usable = [(s, e) for s, e in segments if (e - s) >= MIN_SEGMENT_SEC]
        total_sec = sum(e - s for s, e in usable)
        if total_sec < MIN_TOTAL_SPEECH_SEC:
            continue

        embeds = []
        for start, end in usable:
            i0 = int(start * sr)
            i1 = min(int(end * sr), len(wav))
            if i1 - i0 < sr * 0.5:  # safety: pre-kratak segment u praksi
                continue
            segment_audio = wav[i0:i1]
            embeds.append(model_wrapper.embed(segment_audio))

        if not embeds:
            continue

        avg = np.mean(embeds, axis=0)
        norm = np.linalg.norm(avg)
        if norm < 1e-8:
            continue
        avg = avg / norm  # L2 normalize → cosine sim postaje dot product

        speaker_embeddings[speaker_tag] = {
            "vector": [float(x) for x in avg],
            "total_speech_sec": float(total_sec),
            "num_segments": len(embeds),
            "confidence": float(min(1.0, len(embeds) / 50.0)),
        }

    return {
        "version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "model_key": model_wrapper.model_key,
        "model_id": model_wrapper.model_id,
        "embedding_dim": model_wrapper.embedding_dim,
        "source_diarization": source_label,
        "embeddings": speaker_embeddings,
    }


# ─── FILE DISCOVERY ─────────────────────────────────────────────────

def find_jobs(input_dir, source_label, model_key, channel_filter=None, limit=None):
    """
    Vraća listu (srt_path, wav_path, output_path) parova koje treba obraditi.
    Skipa one koji već imaju model-specific .embeddings.{model_key}.json (idempotentno per-model).
    """
    srt_suffix = f".{source_label}.diarized.srt"
    out_suffix = f".{source_label}.diarized.embeddings.{model_key}.json"

    jobs = []
    input_path = Path(input_dir)

    for srt_path in input_path.rglob(f"*{srt_suffix}"):
        if channel_filter and channel_filter not in str(srt_path):
            continue

        # WAV je pored, bez .{source}.diarized.srt sufiksa
        base = str(srt_path).removesuffix(srt_suffix)
        wav_path = Path(base + ".wav")
        if not wav_path.exists():
            print(f"   ⚠️  Preskačem (nema WAV): {srt_path.name}")
            continue

        output_path = Path(base + out_suffix)
        if output_path.exists():
            continue  # idempotent skip

        jobs.append((srt_path, wav_path, output_path))

    # Sort by upload date (newest first, pretpostavljamo basename počinje s YYYYMMDD)
    jobs.sort(key=lambda j: j[0].name, reverse=True)

    if limit:
        jobs = jobs[:limit]

    return jobs


# ─── MAIN ───────────────────────────────────────────────────────────

def format_duration(seconds):
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m {s}s"
    return f"{m}m {s}s"


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--input-dir", required=True,
                        help="Root direktorij s WAV + diarized SRT datotekama")
    parser.add_argument("--model", choices=list(MODEL_REGISTRY.keys()), default="titanet",
                        help=f"Speaker embedding model. Dostupni: {', '.join(MODEL_REGISTRY.keys())}. "
                             "Pokreni više puta s različitim --model za ensemble.")
    parser.add_argument("--source", choices=["canary", "sortformer"], default="canary",
                        help="Koji diarization output koristiti (default: canary)")
    parser.add_argument("--channel", default=None,
                        help="Filter po stringu u path-u (npr. 'lood_podcast')")
    parser.add_argument("--limit", type=int, default=None,
                        help="Maksimalan broj epizoda (za smoke test)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Lista posao bez izvršavanja")
    parser.add_argument("--max-runtime-hours", type=float, default=None,
                        help="Wall-clock budget; izađe kad istekne")
    args = parser.parse_args()

    model_cls = MODEL_REGISTRY[args.model]

    print("╔══════════════════════════════════════════════════════╗")
    print("║   🎤 SPEAKER EMBEDDING EXTRACTOR (multi-model)      ║")
    print("╚══════════════════════════════════════════════════════╝")
    print(f"   🤖 Model:     {args.model} → {model_cls.model_id} ({model_cls.embedding_dim}-dim)")
    print(f"   📂 Input:     {args.input_dir}")
    print(f"   🎭 Source:    {args.source}.diarized.srt")
    if args.channel:
        print(f"   🔍 Kanal:     {args.channel}")
    print()

    print("   🔍 Skeniram datoteke...")
    jobs = find_jobs(args.input_dir, args.source, args.model,
                     channel_filter=args.channel, limit=args.limit)
    print(f"   📊 Za obradu: {len(jobs)} epizoda")
    print()

    if not jobs:
        print(f"   ✨ Nema novih datoteka za --model={args.model}.")
        print(f"      (Već postoje .{args.source}.diarized.embeddings.{args.model}.json fajlovi)")
        return

    if args.dry_run:
        print("   🧪 DRY RUN — popis prvih 20 jobs:")
        for i, (srt, wav, out) in enumerate(jobs[:20]):
            print(f"      [{i+1}] {srt.name}")
        return

    # Load model
    device_name = "cuda" if torch.cuda.is_available() else (
        "mps" if torch.backends.mps.is_available() else "cpu"
    )
    print(f"   🖥️  Device:    {device_name}")
    print(f"   ⏳ Loading {args.model}...")
    t0 = time.time()
    model_wrapper = model_cls(device_name)
    print(f"   ✅ Model loaded ({time.time() - t0:.1f}s)")
    print()

    start_time = time.time()
    deadline = (start_time + args.max_runtime_hours * 3600) if args.max_runtime_hours else None

    completed = 0
    failed = 0
    skipped = 0
    last_heartbeat = start_time

    for i, (srt_path, wav_path, output_path) in enumerate(jobs, start=1):
        if deadline and time.time() > deadline:
            print(f"   ⏰ MAX_RUNTIME istekao — izlaz s {completed} obrađenih.")
            break

        try:
            ep_start = time.time()
            result = extract_embeddings_for_file(srt_path, wav_path, model_wrapper, args.source)
            if result is None or not result["embeddings"]:
                print(f"   ⏭️  [{i}/{len(jobs)}] {srt_path.name}: nema usable speakera, preskočeno")
                skipped += 1
                continue

            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)

            ep_elapsed = time.time() - ep_start
            n_speakers = len(result["embeddings"])
            print(f"   ✅ [{i}/{len(jobs)}] {srt_path.name}: {n_speakers} spk ({ep_elapsed:.1f}s)")
            completed += 1

        except Exception as e:
            print(f"   ❌ [{i}/{len(jobs)}] {srt_path.name}: {type(e).__name__}: {e}")
            failed += 1

        # Heartbeat
        now = time.time()
        if now - last_heartbeat > HEARTBEAT_SEC:
            elapsed = now - start_time
            avg_per_file = elapsed / max(completed, 1)
            remaining = (len(jobs) - i) * avg_per_file
            print(f"   💓 Progress: {completed}/{len(jobs)} | "
                  f"avg {avg_per_file:.1f}s/fajl | ETA {format_duration(remaining)}")
            last_heartbeat = now

    # Sažetak
    total_elapsed = time.time() - start_time
    print()
    print("╔══════════════════════════════════════════════════════╗")
    print("║   📊 SAŽETAK                                         ║")
    print("╚══════════════════════════════════════════════════════╝")
    print(f"   ✅ Uspješno:          {completed}")
    print(f"   ⏭️  Preskočeno:       {skipped}")
    print(f"   ❌ Grešaka:           {failed}")
    print(f"   ⏱️  Ukupno vrijeme:    {format_duration(total_elapsed)}")
    if completed > 0:
        print(f"   ⚡ Prosjek po fajlu:  {total_elapsed / completed:.1f}s")
    print()


if __name__ == "__main__":
    main()
