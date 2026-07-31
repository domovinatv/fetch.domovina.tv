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

# MODAL_CANARY_MAX_CONTAINERS (2026-07-29): tvrdi strop broja GPU containera.
# Modal naplaćuje UPTIME containera, ne inference — pa kod bulk runa gdje je uzak
# grlo upload s Maca, više containera znači više GPU-a koji čeka na input (skuplje
# za istu količinu posla). Postavi na 1 za najjeftiniji bulk (upload se preklapa s
# inferenceom jednog toplog containera). Nepostavljeno = Modal default (autoscale),
# tj. ad-hoc/pipeline put ostaje nepromijenjen.
_MAX_CONTAINERS = int(os.environ.get("MODAL_CANARY_MAX_CONTAINERS", "0")) or None

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
    max_containers=_MAX_CONTAINERS,
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


# ─── Bulk eksperiment: modal run ...::batch --input-dir storage/output ────────
# DODANO 2026-07-29 (eksperiment "koliko Modal STVARNO košta za backlog"):
# batch entrypoint drži JEDAN ephemeral app kroz cijeli run → container ostaje
# topao (scaledown_window=120s) i model se učita jednom, umjesto jednom po fajlu
# kao kod `::main`. Ovo je jedina razlika u odnosu na ad-hoc put; sve ostalo
# (SRT/CSV logika, idempotencija, imenovanje) je identično.
#
# Scope je EKSPLICITAN (--input-dir/--channels) — nema defaulta na cijeli disk
# bez limita: `--limit 0` znači "svi pronađeni", pa uvijek prvo pokreni s
# --dry-run da vidiš popis i procjenu.
@app.local_entrypoint()
def batch(input_dir: str = "storage/output", channels: str = "", limit: int = 0,
          concurrency: int = 2, source_lang: str = "hr", target_lang: str = "hr",
          max_mb: float = 320.0, stats_out: str = "", dry_run: bool = False,
          gpu_usd_per_hour: float = 2.10):
    """Bulk transkripcija svih WAV-ova bez .canary.srt (idempotentno, warm container)."""
    import json
    from collections import deque

    root = os.path.abspath(input_dir)
    wanted = [c.strip() for c in channels.split(",") if c.strip()]

    pending = []
    for chan in sorted(os.listdir(root)):
        if chan.startswith("."):
            continue
        cdir = os.path.join(root, chan)
        if not os.path.isdir(cdir):          # isdir slijedi symlink (storage arhitektura)
            continue
        if wanted and chan not in wanted:
            continue
        for name in sorted(os.listdir(cdir)):
            if not name.endswith(".wav") or name.startswith("._") or ".loudnorm." in name:
                continue
            wav_path = os.path.join(cdir, name)
            if os.path.exists(wav_path + ".canary.srt"):
                continue
            size_mb = os.path.getsize(wav_path) / (1024 * 1024)
            pending.append((size_mb, chan, wav_path))

    pending.sort()                            # najmanji prvi → rane greške su jeftine
    skipped_big = [p for p in pending if p[0] > max_mb]
    pending = [p for p in pending if p[0] <= max_mb]
    if limit > 0:
        pending = pending[:limit]

    total_mb = sum(p[0] for p in pending)
    print(f"📋 Za transkripciju: {len(pending)} WAV-ova | {total_mb / 1024:.1f} GB uploada")
    if skipped_big:
        print(f"   ⚠️ Preskačem {len(skipped_big)} > {max_mb:.0f} MB (OOM rizik na {GPU_SPEC}):")
        for mb, chan, p in skipped_big:
            print(f"      {mb:6.0f} MB  {chan}/{os.path.basename(p)[:70]}")
    if dry_run or not pending:
        for mb, chan, p in pending:
            print(f"   {mb:6.0f} MB  {chan}/{os.path.basename(p)[:70]}")
        return

    stats, t_start = [], time.time()
    inflight = deque()
    queue = list(pending)

    def _drain_one():
        handle, mb, chan, wav_path, t_sub = inflight.popleft()
        res = handle.get()
        wall = time.time() - t_sub
        if res.get("status") != "transcribed":
            print(f"   ❌ {os.path.basename(wav_path)[:60]}: {res.get('reason')}")
            stats.append({"file": wav_path, "channel": chan, "mb": round(mb, 1),
                          "status": "error", "reason": res.get("reason"),
                          "wall_s": round(wall, 1)})
            return
        with open(wav_path + ".canary.srt", "w", encoding="utf-8") as f:
            f.write(res["srt"])
        with open(wav_path + ".canary.csv", "w", encoding="utf-8") as f:
            f.write(res["csv"])
        done = len([s for s in stats if s["status"] == "transcribed"]) + 1
        infer = res["elapsed"]
        print(f"   ✅ [{done}/{len(pending)}] {mb:6.0f} MB  {infer:5.0f}s infer / {wall:5.0f}s wall  "
              f"{res['segments']:4d} seg  {chan}/{os.path.basename(wav_path)[:50]}")
        stats.append({"file": wav_path, "channel": chan, "mb": round(mb, 1),
                      "status": "transcribed", "segments": res["segments"],
                      "infer_s": round(infer, 1), "wall_s": round(wall, 1)})

    while queue or inflight:
        while queue and len(inflight) < max(1, concurrency):
            mb, chan, wav_path = queue.pop(0)
            data = open(wav_path, "rb").read()
            handle = Canary().transcribe.spawn(data, os.path.basename(wav_path),
                                               source_lang, target_lang)
            inflight.append((handle, mb, chan, wav_path, time.time()))
        if inflight:
            _drain_one()

    ok = [s for s in stats if s["status"] == "transcribed"]
    infer_total = sum(s["infer_s"] for s in ok)
    wall_total = time.time() - t_start
    print("\n" + "─" * 66)
    print(f"   ✅ Transkribirano: {len(ok)}/{len(pending)}   ❌ Grešaka: {len(stats) - len(ok)}")
    print(f"   ⏱️  Wall clock:     {wall_total / 60:.1f} min")
    print(f"   🔥 Suma inference: {infer_total / 60:.1f} min "
          f"({infer_total / max(len(ok), 1):.0f}s po fajlu)")
    print(f"   💵 Donja granica troška (samo inference @ ${gpu_usd_per_hour}/h GPU): "
          f"${infer_total / 3600 * gpu_usd_per_hour:.2f}")
    print(f"      Gornja granica (cijeli wall clock naplaćen kao GPU): "
          f"${wall_total / 3600 * gpu_usd_per_hour:.2f}")
    print("      → Stvarni iznos očitaj s modal.com dashboarda (billing = uptime containera,")
    print("        uključuje cold start i čekanje na upload, ne samo inference).")

    if stats_out:
        with open(stats_out, "w", encoding="utf-8") as f:
            json.dump({"files": stats, "wall_s": round(wall_total, 1),
                       "infer_s": round(infer_total, 1), "gpu": GPU_SPEC,
                       "concurrency": concurrency}, f, ensure_ascii=False, indent=2)
        print(f"   📄 Statistika: {stats_out}")
