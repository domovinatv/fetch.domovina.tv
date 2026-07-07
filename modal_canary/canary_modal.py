#!/usr/bin/env python3
"""
canary_modal.py — On-demand Canary 1B v2 transkripcija na Modal serverless GPU-u.

SVRHA (2026-07-07): ad-hoc transkripcija JEDNOG WAV-a (npr. 3h podcast, ~28 GB
VRAM peak) BEZ stalno upaljenog GPU-a. Modal skalira na nulu — plaćaš samo sekunde
izvršavanja. Ovo omogućuje da pipeline.domovina.ai odradi cijelu obradu u JEDNOM
prolasku (fetch → wav → *transkripcija ovdje* → diarize → summary → article → RAG →
upload), umjesto sadašnjeg 2-prolaznog modela gdje se čeka batch Colab transkripcija.

Odnos prema batch Colab putu (colab_canary/*):
  - Colab G4 batch = i dalje ispravan alat za MASOVNE runove (overhead paljenja se
    amortizira preko puno fajlova). NE zamjenjuje ga ovaj app.
  - Modal A100-40 = ispravan alat za AD-HOC / single-file / 24-7 on-demand.
  Isti model (canary-1b-v2.nemo), isti R2 cache (models.domovina.ai), ista
  SRT/CSV logika kao transcribe_canary.py (funkcije su namjerno inline-ane —
  repo pattern je copy-paste, vidi CLAUDE.md "No Shared Module").

GPU: A100-40GB (40 GB VRAM). 3h WAV ima ~28 GB peak → ~12 GB headroom. Za 5h+
     fajlove razmisli o "A100-80GB" (promijeni GPU= niže).

─── Setup (jednom) ──────────────────────────────────────────────────────────
  pip install modal
  modal setup                                   # autentikacija (browser)
  modal run modal_canary/canary_modal.py::download_model   # napuni Volume s R2

─── Ad-hoc transkripcija jednog WAV-a ───────────────────────────────────────
  modal run modal_canary/canary_modal.py --wav /put/do/file.wav
    → zapiše file.wav.canary.srt i file.wav.canary.csv POKRAJ WAV-a (lokalno),
      identično kao transcribe_canary.py. Idempotentno (preskače ako SRT postoji).

  # drugi jezici / prijevod (Canary podržava)
  modal run modal_canary/canary_modal.py --wav file.wav --source-lang en --target-lang hr

─── Iz koda (npr. run_pipeline.sh single-pass, ili pipeline.domovina.ai bridge) ─
  import modal
  fn = modal.Cls.from_name("domovina-canary", "Canary")()
  out = fn.transcribe.remote(open("f.wav","rb").read(), "f.wav", "hr", "hr")
  # out = {"srt": "...", "csv": "...", "segments": N, "elapsed": s}
"""

import datetime
import os
import time

import modal

# ─── Konfiguracija ───────────────────────────────────────────────────────────
APP_NAME             = "domovina-canary"
MODEL_R2_URL         = "https://models.domovina.ai/canary-1b-v2.nemo"
MODEL_EXPECTED_BYTES = 6358958080          # točna veličina .nemo (integ. provjera)
MODEL_VOL_PATH       = "/models"
MODEL_LOCAL          = f"{MODEL_VOL_PATH}/canary-1b-v2.nemo"

# RAZLOG (kopirano iz colab_canary notebooka, cell 4.6): Cloudflare bot-zaštita na
# zoni domovina.ai vraća 403 za default Python-urllib UA. Browser UA prolazi.
DOWNLOAD_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# GPU: A100-40GB pokriva 3h WAV (~28 GB peak). Za 5h+ → "A100-80GB".
GPU_SPEC = "A100-40GB"

# ─── Image ───────────────────────────────────────────────────────────────────
# Isti pinovi kao colab_canary cell 4 (potvrđeno da rade 2026-07-07): numpy<2.0 +
# numba 0.60.x rješava "numba.cuda.types has no attribute NPDatetime" skew.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1", "sox")
    .pip_install(
        "numpy>=1.24,<2.0",
        "numba>=0.60,<0.61",
        "nemo_toolkit[asr]",
        "cuda-python",
    )
)

# Perzistentni Volume za model — .nemo (6.36 GB) skida se s R2 SAMO jednom, pa
# svaki poziv čita s brzog Modal diska (nema per-call downloada). Ovo je razlog
# zašto je cold start sekunde, ne minute.
model_vol = modal.Volume.from_name("domovina-canary-model", create_if_missing=True)

app = modal.App(APP_NAME)


# ─── SRT / CSV formatiranje (inline iz transcribe_canary.py — SSOT ondje) ─────
def _format_srt_time(seconds: float) -> str:
    sanitized = max(0.0, seconds)
    delta = datetime.timedelta(seconds=sanitized)
    total = int(delta.total_seconds())
    h, rem = total // 3600, total % 3600
    m, s = rem // 60, rem % 60
    ms = delta.microseconds // 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _generate_srt(segments: list) -> str:
    lines = []
    for i, ts in enumerate(segments):
        lines.append(str(i + 1))
        lines.append(f"{_format_srt_time(ts['start'])} --> {_format_srt_time(ts['end'])}")
        lines.append(ts["segment"])
        lines.append("")
    return "\n".join(lines)


def _sec_to_hms(seconds: float) -> str:
    return str(datetime.timedelta(seconds=round(seconds)))


def _generate_csv(segments: list) -> str:
    import csv as _csv
    import io as _io
    buf = _io.StringIO()
    w = _csv.writer(buf)
    w.writerow(["Start (HH:MM:SS)", "End (HH:MM:SS)", "Segment"])
    for ts in segments:
        w.writerow([_sec_to_hms(ts["start"]), _sec_to_hms(ts["end"]), ts["segment"]])
    return buf.getvalue()


# ─── Populacija modela na Volume (pokreni jednom) ─────────────────────────────
@app.function(image=image, volumes={MODEL_VOL_PATH: model_vol}, timeout=1800)
def download_model():
    """Skine canary-1b-v2.nemo s R2 cachea na Volume. Idempotentno."""
    import shutil
    import urllib.request

    if os.path.isfile(MODEL_LOCAL) and os.path.getsize(MODEL_LOCAL) == MODEL_EXPECTED_BYTES:
        print(f"✓ Model već na Volumeu: {MODEL_LOCAL}")
        return

    if os.path.isfile(MODEL_LOCAL):
        os.remove(MODEL_LOCAL)  # nepotpun ostatak

    print(f"📥 Skidam model s R2: {MODEL_R2_URL}")
    t0 = time.time()
    req = urllib.request.Request(MODEL_R2_URL, headers={"User-Agent": DOWNLOAD_UA})
    with urllib.request.urlopen(req, timeout=120) as resp, open(MODEL_LOCAL, "wb") as fh:
        shutil.copyfileobj(resp, fh, length=8 * 1024 * 1024)
    dt = time.time() - t0
    mb = os.path.getsize(MODEL_LOCAL) / 1e6
    print(f"   ✅ {mb:.0f} MB za {dt:.0f}s ({mb / max(dt, 1):.0f} MB/s)")

    got = os.path.getsize(MODEL_LOCAL)
    assert got == MODEL_EXPECTED_BYTES, f"Veličina ne odgovara: {got} != {MODEL_EXPECTED_BYTES}"
    model_vol.commit()  # perzistiraj promjene na Volumeu
    print("   → Volume commitан. Model spreman za inference.")


# ─── Inference klasa — model se učita jednom po containeru (@enter) ───────────
@app.cls(
    image=image,
    gpu=GPU_SPEC,
    volumes={MODEL_VOL_PATH: model_vol},
    timeout=3600,          # do 1h po pozivu (3h WAV se transkribira za ~35s, ovo je margin)
    scaledown_window=120,  # ostani topao 120s nakon poziva → back-to-back fajlovi reuse-aju model
)
class Canary:
    @modal.enter()
    def load(self):
        """Učita model jednom kad se container digne (traje ~20-40s)."""
        import torch
        from nemo.collections.asr.models import ASRModel

        assert os.path.isfile(MODEL_LOCAL), (
            f"Model nije na Volumeu ({MODEL_LOCAL}). "
            f"Pokreni: modal run modal_canary/canary_modal.py::download_model"
        )
        print(f"📦 Učitavam model: {MODEL_LOCAL}")
        t0 = time.time()
        self.model = ASRModel.restore_from(restore_path=MODEL_LOCAL)
        self.model.eval()
        if torch.cuda.is_available() and torch.cuda.is_bf16_supported():
            self.model = self.model.to(torch.bfloat16)
            print("⚡ BF16 aktivan")
        print(f"✅ Model učitan za {time.time() - t0:.0f}s")

    @modal.method()
    def transcribe(self, wav_bytes: bytes, filename: str,
                   source_lang: str = "hr", target_lang: str = "hr") -> dict:
        """Transkribira jedan WAV (bytes) → vraća {'srt','csv','segments','elapsed'}."""
        import tempfile
        import torch

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            tf.write(wav_bytes)
            wav_path = tf.name

        size_mb = len(wav_bytes) / (1024 * 1024)
        print(f"🎙️  {filename} ({size_mb:.1f} MB) | {source_lang}→{target_lang}")
        t0 = time.time()
        try:
            with torch.inference_mode():
                out = self.model.transcribe(
                    [wav_path], timestamps=True,
                    source_lang=source_lang, target_lang=target_lang,
                )
            elapsed = time.time() - t0

            if (not out or not isinstance(out, list) or not out[0]
                    or not hasattr(out[0], "timestamp") or not out[0].timestamp
                    or "segment" not in out[0].timestamp):
                return {"status": "error", "reason": "Unexpected output format", "elapsed": elapsed}

            segments = out[0].timestamp["segment"]
            print(f"📊 {len(segments)} segmenata za {elapsed:.0f}s")
            return {
                "status": "transcribed",
                "srt": _generate_srt(segments),
                "csv": _generate_csv(segments),
                "segments": len(segments),
                "elapsed": elapsed,
            }
        except torch.cuda.OutOfMemoryError:
            import gc
            gc.collect(); torch.cuda.empty_cache()
            return {"status": "error", "reason": "CUDA OOM — probaj A100-80GB", "elapsed": time.time() - t0}
        except Exception as e:
            return {"status": "error", "reason": str(e), "elapsed": time.time() - t0}
        finally:
            try:
                os.remove(wav_path)
            except OSError:
                pass


# ─── Lokalni CLI: modal run ... --wav /put/do/file.wav ────────────────────────
@app.local_entrypoint()
def main(wav: str, source_lang: str = "hr", target_lang: str = "hr", force: bool = False):
    """Transkribira lokalni WAV preko Modala, zapiše .canary.srt/.canary.csv pokraj njega."""
    if not os.path.isfile(wav):
        raise SystemExit(f"❌ WAV ne postoji: {wav}")

    srt_out = wav + ".canary.srt"
    csv_out = wav + ".canary.csv"
    if os.path.exists(srt_out) and not force:
        print(f"⏭️  Već postoji {srt_out} (koristi --force za override). Izlazim.")
        return

    data = open(wav, "rb").read()
    print(f"⬆️  Šaljem {len(data) / 1e6:.0f} MB na Modal ({GPU_SPEC})...")
    res = Canary().transcribe.remote(data, os.path.basename(wav), source_lang, target_lang)

    if res.get("status") != "transcribed":
        raise SystemExit(f"❌ Transkripcija nije uspjela: {res.get('reason')}")

    with open(srt_out, "w", encoding="utf-8") as f:
        f.write(res["srt"])
    with open(csv_out, "w", encoding="utf-8") as f:
        f.write(res["csv"])
    print(f"✅ {res['segments']} segmenata | inference {res['elapsed']:.0f}s")
    print(f"   → {srt_out}")
    print(f"   → {csv_out}")
