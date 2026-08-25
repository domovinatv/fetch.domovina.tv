#!/usr/bin/env python3
"""
diar_runner.py — pokretanje pyannotea nad JEDNIM isjeckom, u nadziranom djetetu.

Zajednicko za `02_diarize.py` (proizvodni prolaz) i
`tools/calibrate_threshold.py` (mjerenje praga). Bez ovoga bi ista logika
postojala u dvije kopije, a upravo su detalji u njoj oni koji tiho pucaju:
waveform umjesto putanje, `dtype="float32"`, i MPS cap prije prve alokacije.

Dijete radi SAV posao koji trosi memoriju; roditelj samo mjeri i po potrebi
ubija. Tako se gubi najgore jedan komad, a ne stroj.
"""

import json
import multiprocessing as mp
import time
from pathlib import Path

from . import machine_guard as mg
from .audio_chunker import read_slice

MPS_MEMORY_FRACTION = 0.55   # ≈9.8 GiB cap na ovom stroju (§5.6)


# ─── Napredak kroz shared memory ─────────────────────────────────────────────
# Namjerno GOLI sharedctypes objekti, a ne vlastita klasa: pod `spawn`-om se
# argumenti pickleaju, a klasa definirana u `__main__` skripte s vodecom
# znamenkom u imenu ("02_diarize.py") nije uvijek razrjesiva u djetetu.

def make_progress(ctx):
    import ctypes
    return ctx.Array(ctypes.c_char, 64, lock=False), ctx.Value("d", 0.0, lock=False)


def read_progress(step_arr, frac_val):
    return step_arr.value.decode("utf-8", "replace"), frac_val.value


class LogProgressHook:
    """pyannote hook koji pise OBICNE log retke (bez ANSI-ja).

    Knjiznicni `ProgressHook` crta `rich` progress bar; ovaj se ispis cita iz
    loga (i iz launchd nightly loga), gdje su ANSI sekvence smece.
    """

    def __init__(self, duration_s=None, min_interval_s=60, sink=None, prefix=""):
        self.duration_s = duration_s
        self.min_interval_s = min_interval_s
        self.sink = sink
        self.prefix = prefix
        self.t0 = time.time()
        self._step = None
        self._step_t0 = self.t0
        self._last_print = 0.0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def __call__(self, step_name, step_artifact, file=None, total=None, completed=None):
        now = time.time()
        if step_name != self._step:
            self._step = step_name
            self._step_t0 = now
            self._last_print = 0.0
            if self.sink:
                self.sink(step_name, 0.0)
            print(f"{self.prefix}   ▶ korak: {step_name} "
                  f"(+{mg.hms(now - self.t0)} od starta komada)", flush=True)
        if not total or completed is None:
            return
        frac = min(1.0, max(0.0, completed / total))
        if self.sink:
            self.sink(step_name, frac)
        if frac < 1.0 and (now - self._last_print) < self.min_interval_s:
            return
        self._last_print = now
        el = now - self._step_t0
        eta = (el / frac - el) if frac > 0 else 0
        where = ""
        if step_name == "segmentation" and self.duration_s:
            where = (f" | u komadu ≈ {mg.hms(frac * self.duration_s)}"
                     f"/{mg.hms(self.duration_s)}")
        print(f"{self.prefix}     {step_name} {frac*100:5.1f}% ({completed}/{total})"
              f"{where} | ETA koraka {mg.hms(eta)}", flush=True)


# ─── Child ───────────────────────────────────────────────────────────────────

def diarize_chunk_child(wav_path, chunk, hf_token, device, min_spk, max_spk,
                        out_json, out_npy, q, step_arr, frac_val,
                        progress_interval, mps_fraction):
    """Diariziraj [read_start, read_stop) iz `wav_path` i zapisi JSON + centroide."""
    try:
        import numpy as np
        import torch
        from pyannote.audio import Pipeline

        if device == "auto":
            device = "mps" if torch.backends.mps.is_available() else "cpu"

        # ⚠️ MORA prije prve MPS alokacije. Default high watermark je 1.7×
        # recommended_max_memory() → 30.2 GiB na stroju s 22.35 GiB fizicki, pa
        # PyTorch nikad ne baci OOM prije nego macOS pocne swapati. S ovim
        # dobijemo cist RuntimeError umjesto rusenja stroja (§5.6).
        # NIKAD ne dirati PYTORCH_MPS_HIGH_WATERMARK_RATIO sam — LOW mora biti
        # <= HIGH pa puca s "invalid low watermark ratio"; a `=0.0` (sto internet
        # preporuca kao "fix za OOM") je upravo ono sto obara stroj.
        if device == "mps" and mps_fraction:
            torch.mps.set_per_process_memory_fraction(mps_fraction)
            cap = torch.mps.recommended_max_memory() * mps_fraction / 2**30
            print(f"   🧯 MPS cap {mps_fraction:.2f} × recommended = {cap:.1f} GiB",
                  flush=True)

        t_load = time.time()
        # float32 iz `sf.read` je OBAVEZAN — bez njega float64 + kopija = 3× memorije.
        data, sr = read_slice(wav_path, chunk["read_start"], chunk["read_stop"])
        waveform = torch.from_numpy(data).unsqueeze(0)      # (1, N)
        print(f"   🔊 waveform {data.nbytes/2**20:.0f} MB float32, "
              f"{len(data)/sr/3600:.2f} h (ucitan za {time.time()-t_load:.1f}s)",
              flush=True)

        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-community-1", token=hf_token)
        pipeline.to(torch.device(device))

        kwargs = {}
        if min_spk:
            kwargs["min_speakers"] = min_spk
        if max_spk:
            kwargs["max_speakers"] = max_spk

        def sink(name, frac):
            step_arr.value = name.encode("utf-8")[:63]
            frac_val.value = frac

        hook = LogProgressHook(duration_s=len(data) / sr,
                               min_interval_s=progress_interval, sink=sink)

        t0 = time.time()
        # KLJUCNO: waveform, NE putanja. Putanja ne stedi memoriju (`Inference`
        # svejedno zove `get_all_samples()`), a torchcodec < 0.14 premotava na
        # pocetak datoteke pri svakom cropu → 8-15 h samo dekodiranja na 20 h
        # snimci. Vidi §5.1-5.3.
        with hook:
            out = pipeline({"waveform": waveform, "sample_rate": sr},
                           hook=hook, **kwargs)
        elapsed = time.time() - t0
        del waveform, data

        # pyannote 4.x → DiarizeOutput; centroidi su poravnati s
        # speaker_diarization.labels() (speaker_diarization.py:745-780).
        diar = getattr(out, "speaker_diarization", None)
        excl = getattr(out, "exclusive_speaker_diarization", None)
        centroids = getattr(out, "speaker_embeddings", None)
        if diar is None:                      # legacy=True ili starija verzija
            diar, excl, centroids = out, None, None
        labels = list(diar.labels())

        # Segmenti idu iz `exclusive` (bez preklapajucih govornih zavoja) jer ih
        # faza 03 lijepi na ASR. Oznake su ISTE u obje anotacije — pyannote
        # primjenjuje isti `mapping` na obje — pa se poklapaju s centroidima.
        src = excl if excl is not None else diar
        segments = [
            {"start": round(float(t.start), 3), "end": round(float(t.end), 3),
             "speaker": spk}
            for t, _, spk in src.itertracks(yield_label=True)
        ]

        dim = None
        if centroids is not None:
            arr = np.asarray(centroids, dtype=np.float32)
            np.save(out_npy, arr)
            dim = int(arr.shape[1])

        Path(out_json).write_text(json.dumps({
            "wav": str(wav_path),
            "chunk": chunk,
            "labels": labels,                 # redoslijed = redovi centroida
            "n_speakers_local": len(labels),
            "segments": segments,             # sekunde LOKALNE za komad
            "elapsed_s": round(elapsed, 1),
            "device": device,
            "centroids_file": Path(out_npy).name if dim else None,
            "centroid_dim": dim,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }, ensure_ascii=False, indent=2) + "\n")

        q.put({"status": "ok", "n_segments": len(segments), "n_speakers": len(labels),
               "elapsed": elapsed, "centroids": dim is not None})
    except Exception as e:
        import traceback
        q.put({"status": "error", "reason": f"{type(e).__name__}: {e}",
               "traceback": traceback.format_exc()[-2500:]})


def run_guarded_chunk(wav_path, chunk, hf_token, device, min_spk, max_spk,
                      out_json, out_npy, guard, interval_s=20,
                      progress_interval=60, mps_fraction=MPS_MEMORY_FRACTION):
    """Pokreni dijete i nadziri ga. Vraca dict s `status` ∈ {ok, aborted, error}."""
    ctx = mp.get_context("spawn")
    q = ctx.Queue()
    step_arr, frac_val = make_progress(ctx)
    proc = ctx.Process(target=diarize_chunk_child,
                       args=(str(wav_path), chunk, hf_token, device, min_spk, max_spk,
                             str(out_json), str(out_npy), q, step_arr, frac_val,
                             progress_interval, mps_fraction))
    proc.start()
    print(f"   🛡️  nadzornik (PID {proc.pid}): swap-rast ≤ {guard.swap_growth_gb:.1f} GB, "
          f"disk ≥ {guard.min_free_disk_gb:.1f} GB, "
          f"footprint ≤ {guard.footprint_cap_gb:.1f} GB", flush=True)

    t0 = time.time()
    dur = chunk.get("duration_s")
    while proc.is_alive():
        time.sleep(interval_s)
        s = guard.sample(proc.pid)
        step, frac = read_progress(step_arr, frac_val)
        if step == "segmentation" and dur:
            where = f" | {step} {frac*100:4.1f}% ≈ {mg.hms(frac*dur)}/{mg.hms(dur)}"
        elif step:
            where = f" | {step} {frac*100:4.1f}%"
        else:
            where = " | ucitavam"
        print(mg.format_sample(s, (time.time() - t0) / 60, where), flush=True)

        reason = guard.verdict(s)
        if reason:
            print(f"\n   🛑 PREKID: {reason}", flush=True)
            print("      Ubijam dijete da stroj ne ode u swap-thrash.", flush=True)
            mg.kill_child(proc)
            return {"status": "aborted", "reason": reason, **guard.summary()}

    proc.join()
    res = q.get() if not q.empty() else {
        "status": "error",
        "reason": f"dijete izaslo bez rezultata (exitcode={proc.exitcode}) — "
                  f"exitcode -9 znaci da ga je ubio macOS zbog memorije"}
    res.update(guard.summary())
    return res


def hf_token():
    import os
    import sys
    tok = os.environ.get("HF_TOKEN")
    if not tok:
        cached = Path.home() / ".cache" / "huggingface" / "token"
        if cached.is_file():
            tok = cached.read_text().strip()
    if not tok:
        sys.exit("❌ Nema HF tokena (HF_TOKEN env ili ~/.cache/huggingface/token)")
    return tok
