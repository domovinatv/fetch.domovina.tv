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
    → Iznad 1024 MB (MODAL_VOLUME_THRESHOLD_MB) automatski ide preko audio Volumea
      umjesto bytes-argumenta, pa i višesatne snimke prolaze automatskim putem.
      Bez toga klijent umre TIHO na velikom argumentu (2.3 GB WAV → 34 GB peak).

  # drugi jezici / prijevod (Canary podržava)
  modal run modal_canary/canary_modal.py --wav file.wav --source-lang en --target-lang hr

─── Iz koda (npr. run_pipeline.sh single-pass, ili pipeline.domovina.ai bridge) ─
  import modal
  fn = modal.Cls.from_name("domovina-canary", "Canary")()
  out = fn.transcribe.remote(open("f.wav","rb").read(), "f.wav", "hr", "hr")
  # out = {"srt": "...", "csv": "...", "segments": N, "elapsed": s}
"""

import datetime
import json
import os
import time

import modal

# ─── Konfiguracija ───────────────────────────────────────────────────────────
APP_NAME             = "domovina-canary"
MODEL_R2_URL         = "https://models.domovina.ai/canary-1b-v2.nemo"
MODEL_EXPECTED_BYTES = 6358958080          # točna veličina .nemo (integ. provjera)
MODEL_VOL_PATH       = "/models"
# AUDIO VOLUME (2026-08-25): za snimke koje ne stanu u argument funkcije. Modalov
# klijent serijalizira bytes-argument s ~15× memory overheadom (mjereno: 2.3 GB WAV
# → 34 GB peak footprint → proces ubijen na 24 GB Macu). `modal volume put` streama
# datoteku, pa je jedini put za višesatne snimke.
AUDIO_VOL_PATH       = "/audio"
AUDIO_VOL_NAME       = "domovina-audio"
MODEL_LOCAL          = f"{MODEL_VOL_PATH}/canary-1b-v2.nemo"

# AUTO-RUTA NA VOLUME (P4, 2026-08-25). Do ovog praga bytes-argument je dokazano
# siguran (714 MB dijelovi saborske sjednice prošli su bez problema); iznad njega
# klijent umire TIHO — bez tracebacka, EXITCODE=1 nakon ~65 s (mjereno: 2.3 GB WAV
# → 34 GB peak footprint na 24 GB Macu). Automatski put (run_pipeline.sh KORAK 2.6,
# priority poller) zove `::main`, pa prag mora živjeti OVDJE, a ne u pozivatelju —
# inače duga snimka i dalje pada tiho. Override: MODAL_VOLUME_THRESHOLD_MB.
VOLUME_ROUTE_THRESHOLD_MB = float(os.environ.get("MODAL_VOLUME_THRESHOLD_MB", "1024"))

# RAZLOG (kopirano iz colab_canary notebooka, cell 4.6): Cloudflare bot-zaštita na
# zoni domovina.ai vraća 403 za default Python-urllib UA. Browser UA prolazi.
DOWNLOAD_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# GPU: A100-40GB pokriva 3h WAV (~28 GB peak). Za 5h+ → "A100-80GB".
# MODAL_CANARY_GPU (2026-08-24): override bez editiranja koda — potreban za mjerenje
# gdje je stvarni strop na dugim snimkama (saborske sjednice, 6h po dijelu). Utječe
# SAMO na `modal run` (ephemeral app); deployani "domovina-canary" ostaje na svom
# GPU-u dok ga se eksplicitno ne re-deploya.
GPU_SPEC = os.environ.get("MODAL_CANARY_GPU", "A100-40GB")

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
# Rezolucija je ZAMRZNUTA na datum (uv --exclude-newer): nemo_toolkit nije pinan, pa
# je svježi build u novom workspaceu (domovinasync, 23.11.2026.) povukao NeMo 3.0 +
# pyarrow 26 (traži NumPy 2) uz numpy<2 → ImportError na startu containera. 2026-07-07
# = dan kad je izgrađen image koji je radio u starom workspaceu (NeMo 2.7.3, torch 2.9.1).
# Nadogradnja modal klijenta to NE rješava — mijenjaj datum samo uz ponovnu probu.
PIP_FREEZE_DATE = "2026-07-07T00:00:00Z"
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1", "sox")
    .pip_install("uv")
    .run_commands(
        f"uv pip install --system --exclude-newer {PIP_FREEZE_DATE} "
        "'numpy>=1.24,<2.0' 'numba>=0.60,<0.61' 'nemo_toolkit[asr]' cuda-python"
    )
)

# Perzistentni Volume za model — .nemo (6.36 GB) skida se s R2 SAMO jednom, pa
# svaki poziv čita s brzog Modal diska (nema per-call downloada). Ovo je razlog
# zašto je cold start sekunde, ne minute.
model_vol = modal.Volume.from_name("domovina-canary-model", create_if_missing=True)
audio_vol = modal.Volume.from_name(AUDIO_VOL_NAME, create_if_missing=True)

app = modal.App(APP_NAME)

# ─── Dijarizacija na Modalu (14.11.2026.) ────────────────────────────────────
# Lokalna dijarizacija (KORAK 6) je ugašena 31.10. (swap/disk na Macu), pa Canary prijepis
# nije imao govornike i nije mogao biti rezerva kad Soniox/Speechmatics padnu (13.11.:
# svi bez kredita, 2 dana bez ijedne epizode). Isti model kao lokalno
# (pyannote/speaker-diarization-community-1, exclusive mode), ali u vlastitom containeru:
# NeMo i pyannote 4.x traže različite torch/numpy pinove, pa dijele samo app.
# Izlaz: `{wav}.canary.pyannote.json` POKRAJ WAV-a; spaja ga lib/asr/canary_skeleton.js.
# Treba Modal secret `domovina-hf` (HF_TOKEN s prihvaćenim uvjetima modela).
# MODAL_CANARY_DIARIZE=0 gasi; MODAL_DIARIZE_GPU mijenja GPU (default T4, ~10 GB VRAM peak).
DIARIZE_MODEL      = "pyannote/speaker-diarization-community-1"
DIARIZE_GPU        = os.environ.get("MODAL_DIARIZE_GPU", "T4")
DIARIZE_DEFAULT_ON = os.environ.get("MODAL_CANARY_DIARIZE", "1").lower() not in ("0", "false", "off", "no")
HF_CACHE_PATH      = "/hf-cache"

diar_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install("pyannote.audio==4.0.4", "soundfile")
    .env({"HF_HOME": HF_CACHE_PATH})
)
hf_cache_vol = modal.Volume.from_name("domovina-pyannote-cache", create_if_missing=True)


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


def _generate_words(out0):
    """`timestamp["word"]` → `.wav.canary.word_ts.json` (vrijeme po riječi za titl).

    Canary ga vraća uz `timestamps=True` besplatno, uz segmente. Do 06.10.2026. se
    bacao; za stare epizode bi trebao novi GPU prolaz. generate_words_json.js
    (KORAK 9.87) iz ovoga gradi `{base}.words.json` kad nema Speechmatics kostura.
    Format: {"v":1,"source":"canary","words":[[start_ms,end_ms,"riječ"],…]}.
    """
    words = (out0.timestamp or {}).get("word") or []
    rows = []
    for w in words:
        text = (w.get("word") or w.get("char") or "").strip()
        if not text or w.get("start") is None or w.get("end") is None:
            continue
        rows.append([round(w["start"] * 1000), round(w["end"] * 1000), text])
    if not rows:
        return None
    return json.dumps({"v": 1, "source": "canary", "words": rows},
                      ensure_ascii=False, separators=(",", ":"))


def _canary_suffix(out_tag: str = "") -> str:
    """`.canary` ili `.canary.<tag>`. `--out-tag en` uz `--target-lang en` daje
    izvorni engleski titl UZ postojeći en→hr (`.canary.srt` ostaje netaknut).
    Vidi domovina.ai docs/plans/2026-10-29-titlovi-na-dva-jezika.md."""
    return ".canary." + out_tag if out_tag else ".canary"


def _write_words(wav_path: str, res: dict, out_tag: str = "") -> None:
    if res.get("words"):
        with open(wav_path + _canary_suffix(out_tag) + ".word_ts.json", "w", encoding="utf-8") as f:
            f.write(res["words"])


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
    volumes={MODEL_VOL_PATH: model_vol, AUDIO_VOL_PATH: audio_vol},
    timeout=7200,   # 20h snimka: ~6 min inference, ali volume reload + margin          # do 1h po pozivu (3h WAV se transkribira za ~35s, ovo je margin)
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
    def transcribe_volume(self, rel_path: str,
                          source_lang: str = "hr", target_lang: str = "hr") -> dict:
        """Transkribira WAV koji već leži na audio Volumeu (bez bytes argumenta).

        Put za snimke koje ne stanu u argument funkcije — datoteka se uploada
        `modal volume put`-om, a ovdje se samo čita s mounta. Nema serijalizacije,
        pa nema ni memorijskog šiljka na klijentu.
        """
        import torch

        wav_path = rel_path if rel_path.startswith(AUDIO_VOL_PATH) else f"{AUDIO_VOL_PATH}/{rel_path.lstrip('/')}"
        audio_vol.reload()   # vidi zapise nastale nakon što je container startao
        if not os.path.isfile(wav_path):
            listing = ", ".join(sorted(os.listdir(AUDIO_VOL_PATH))[:20]) or "(prazno)"
            return {"status": "error", "reason": f"Nema {wav_path} na volumeu. Sadrži: {listing}"}

        size_mb = os.path.getsize(wav_path) / (1024 * 1024)
        return self._run(wav_path, os.path.basename(wav_path), size_mb, source_lang, target_lang)

    @modal.method()
    def transcribe(self, wav_bytes: bytes, filename: str,
                   source_lang: str = "hr", target_lang: str = "hr") -> dict:
        """Transkribira jedan WAV (bytes) → vraća {'srt','csv','segments','elapsed'}."""
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            tf.write(wav_bytes)
            wav_path = tf.name
        try:
            return self._run(wav_path, filename, len(wav_bytes) / (1024 * 1024),
                             source_lang, target_lang)
        finally:
            try:
                os.remove(wav_path)
            except OSError:
                pass

    def _run(self, wav_path: str, filename: str, size_mb: float,
             source_lang: str, target_lang: str) -> dict:
        """Zajednička inference jezgra za oba ulazna puta (bytes i volume)."""
        import torch

        print(f"🎙️  {filename} ({size_mb:.1f} MB) | {source_lang}→{target_lang}")
        # Peak se mjeri od NULE po pozivu: zanima nas koliko traži OVA snimka povrh
        # već učitanog modela, jer po tome se predviđa strop za duže snimke.
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
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
            peak_gb = (torch.cuda.max_memory_allocated() / 2**30) if torch.cuda.is_available() else None
            total_gb = (torch.cuda.get_device_properties(0).total_memory / 2**30) if torch.cuda.is_available() else None
            print(f"📊 {len(segments)} segmenata za {elapsed:.0f}s"
                  + (f" | peak VRAM {peak_gb:.1f} / {total_gb:.1f} GB ({GPU_SPEC})" if peak_gb else ""))
            return {
                "status": "transcribed",
                "srt": _generate_srt(segments),
                "csv": _generate_csv(segments),
                "words": _generate_words(out[0]),
                "segments": len(segments),
                "elapsed": elapsed,
                "peak_vram_gb": round(peak_gb, 2) if peak_gb else None,
                "total_vram_gb": round(total_gb, 1) if total_gb else None,
                "gpu": GPU_SPEC,
            }
        except torch.cuda.OutOfMemoryError:
            import gc
            gc.collect(); torch.cuda.empty_cache()
            peak_gb = torch.cuda.max_memory_allocated() / 2**30
            return {"status": "error",
                    "reason": f"CUDA OOM na {GPU_SPEC} (peak {peak_gb:.1f} GB) — probaj MODAL_CANARY_GPU=A100-80GB",
                    "peak_vram_gb": round(peak_gb, 2), "gpu": GPU_SPEC,
                    "elapsed": time.time() - t0}
        except Exception as e:
            return {"status": "error", "reason": str(e), "elapsed": time.time() - t0}


# ─── Dijarizacija: pyannote community-1 (vlastiti container, GPU T4) ─────────
@app.cls(
    image=diar_image,
    gpu=DIARIZE_GPU,
    volumes={HF_CACHE_PATH: hf_cache_vol, AUDIO_VOL_PATH: audio_vol},
    secrets=[modal.Secret.from_name("domovina-hf")],
    timeout=7200,
    memory=16384,
    scaledown_window=120,
)
class Diarizer:
    @modal.enter()
    def load(self):
        import torch
        from pyannote.audio import Pipeline

        t0 = time.time()
        self.pipeline = Pipeline.from_pretrained(DIARIZE_MODEL, token=os.environ["HF_TOKEN"])
        if torch.cuda.is_available():
            self.pipeline.to(torch.device("cuda"))
        hf_cache_vol.commit()   # model ostaje u cacheu za idući container
        print(f"✅ pyannote učitan za {time.time() - t0:.0f}s")

    @modal.method()
    def diarize(self, wav_bytes: bytes, filename: str) -> dict:
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            tf.write(wav_bytes)
            wav_path = tf.name
        try:
            return self._run(wav_path, filename)
        finally:
            try:
                os.remove(wav_path)
            except OSError:
                pass

    @modal.method()
    def diarize_volume(self, rel_path: str) -> dict:
        wav_path = rel_path if rel_path.startswith(AUDIO_VOL_PATH) else f"{AUDIO_VOL_PATH}/{rel_path.lstrip('/')}"
        audio_vol.reload()
        if not os.path.isfile(wav_path):
            return {"status": "error", "reason": f"Nema {wav_path} na volumeu"}
        return self._run(wav_path, os.path.basename(wav_path))

    def _run(self, wav_path: str, filename: str) -> dict:
        """Isto kao colab_diarize/diarize_canary.py run_diarization (waveform u RAM-u,
        exclusive mode) — SSOT je ondje."""
        import soundfile as sf
        import torch

        t0 = time.time()
        try:
            data, sr = sf.read(wav_path, dtype="float32")
            if data.ndim > 1:
                data = data.mean(axis=1)
            waveform = torch.from_numpy(data).unsqueeze(0)
            result = self.pipeline({"waveform": waveform, "sample_rate": sr})
            del waveform, data
            diar = getattr(result, "exclusive_speaker_diarization", None) \
                or getattr(result, "speaker_diarization", None) or result
            segs = [{"start": round(t.start, 3), "end": round(t.end, 3), "speaker": spk}
                    for t, _, spk in diar.itertracks(yield_label=True)]
            n = len({s["speaker"] for s in segs})
            el = time.time() - t0
            print(f"🗣️  {filename}: {len(segs)} segmenata, {n} govornika za {el:.0f}s ({DIARIZE_GPU})")
            return {"status": "diarized", "segments": segs, "speakers": n,
                    "elapsed": el, "gpu": DIARIZE_GPU, "model": DIARIZE_MODEL}
        except Exception as e:
            return {"status": "error", "reason": str(e), "elapsed": time.time() - t0}


# ─── Auto-ruta na Volume (P4) ────────────────────────────────────────────────
# `modal volume put` streama datoteku umjesto da je serijalizira u argument, pa
# klijentu ne treba ~15× veličine snimke u RAM-u. Zauzeće volumea se NAPLAĆUJE →
# datoteka se briše čim inference završi (i kad padne).

def _volume_remote_name(wav: str) -> str:
    """Jedinstveno ime na volumeu — dva paralelna runa ne smiju gaziti isti zapis."""
    stamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    return f"/auto_{stamp}_{os.getpid()}_{os.path.basename(wav)}"


def _volume_put(wav: str, remote: str) -> None:
    import subprocess
    print(f"⬆️  modal volume put {AUDIO_VOL_NAME} → {remote}")
    subprocess.run(["modal", "volume", "put", AUDIO_VOL_NAME, wav, remote],
                   check=True)


def _volume_rm(remote: str) -> None:
    import subprocess
    r = subprocess.run(["modal", "volume", "rm", AUDIO_VOL_NAME, remote],
                       capture_output=True, text=True)
    if r.returncode == 0:
        print(f"🧹 Obrisano s volumea: {remote}")
    else:
        # Ne rušimo run zbog čišćenja — ali ISPIŠI, jer zaostatak se naplaćuje.
        print(f"⚠️  Nisam uspio obrisati {remote} s volumea (naplaćuje se zauzeće): "
              f"{(r.stderr or r.stdout or '').strip()[:200]}")


def _diarize_local_wav(wav: str) -> dict:
    """Šalje WAV na Modal Diarizer — bytes ili preko volumea, kao _transcribe_local_wav."""
    size_mb = os.path.getsize(wav) / (1024 * 1024)
    if size_mb <= VOLUME_ROUTE_THRESHOLD_MB:
        data = open(wav, "rb").read()
        print(f"⬆️  Šaljem {len(data) / 1e6:.0f} MB na Modal dijarizaciju ({DIARIZE_GPU})...")
        return Diarizer().diarize.remote(data, os.path.basename(wav))
    remote = _volume_remote_name(wav)
    try:
        _volume_put(wav, remote)
        return Diarizer().diarize_volume.remote(remote)
    finally:
        _volume_rm(remote)


def _diarize_and_write(wav: str) -> bool:
    """`{wav}.canary.pyannote.json`; NE-fatalno (bez govornika ide canary_solo rezerva)."""
    out = wav + ".canary.pyannote.json"
    try:
        res = _diarize_local_wav(wav)
    except Exception as e:  # secret/kvota/mreža — prijepis ne smije pasti zbog ovoga
        res = {"status": "error", "reason": f"{type(e).__name__}: {e}"}
    if res.get("status") != "diarized":
        print(f"⚠️  Dijarizacija nije uspjela (non-fatal): {str(res.get('reason'))[:300]}")
        return False
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"v": 1, "model": res.get("model"), "gpu": res.get("gpu"),
                   "speakers": res.get("speakers"), "elapsed": round(res.get("elapsed") or 0, 1),
                   "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   "segments": res["segments"]}, f, ensure_ascii=False)
    print(f"🗣️  {res.get('speakers')} govornika → {out}")
    return True


def _transcribe_local_wav(wav: str, source_lang: str, target_lang: str) -> dict:
    """Šalje WAV na Modal — bytes-argumentom ili preko volumea, ovisno o veličini."""
    size_mb = os.path.getsize(wav) / (1024 * 1024)

    if size_mb <= VOLUME_ROUTE_THRESHOLD_MB:
        data = open(wav, "rb").read()
        print(f"⬆️  Šaljem {len(data) / 1e6:.0f} MB na Modal ({GPU_SPEC})...")
        return Canary().transcribe.remote(data, os.path.basename(wav),
                                          source_lang, target_lang)

    print(f"📦 {size_mb:.0f} MB > prag {VOLUME_ROUTE_THRESHOLD_MB:.0f} MB → "
          f"idem preko volumea (bytes-argument bi ubio klijent).")
    remote = _volume_remote_name(wav)
    try:
        _volume_put(wav, remote)
        return Canary().transcribe_volume.remote(remote, source_lang, target_lang)
    finally:
        _volume_rm(remote)


# ─── Lokalni CLI: modal run ... --wav /put/do/file.wav ────────────────────────
@app.local_entrypoint()
def main(wav: str, source_lang: str = "hr", target_lang: str = "hr", force: bool = False,
         out_tag: str = "", diarize: str = ""):
    """Transkribira lokalni WAV preko Modala, zapiše .canary.srt/.canary.csv pokraj njega.

    `--diarize 1|0` (default MODAL_CANARY_DIARIZE=1): uz prijepis i pyannote govornici u
    `{wav}.canary.pyannote.json`. Kad SRT već postoji, a govornika nema, radi SAMO
    dijarizaciju (nema drugog GPU prolaza Canaryja). Samo za izvorni prijepis (bez --out-tag).
    """
    if not os.path.isfile(wav):
        raise SystemExit(f"❌ WAV ne postoji: {wav}")

    do_diar = (DIARIZE_DEFAULT_ON if diarize == "" else diarize.lower() not in ("0", "false", "off", "no")) \
        and not out_tag
    diar_out = wav + ".canary.pyannote.json"
    srt_out = wav + _canary_suffix(out_tag) + ".srt"
    csv_out = wav + _canary_suffix(out_tag) + ".csv"
    if os.path.exists(srt_out) and not force:
        if do_diar and not os.path.exists(diar_out):
            print(f"⏭️  {os.path.basename(srt_out)} postoji — radim samo dijarizaciju.")
            _diarize_and_write(wav)
            return
        print(f"⏭️  Već postoji {srt_out} (koristi --force za override). Izlazim.")
        return

    res = _transcribe_local_wav(wav, source_lang, target_lang)

    if res.get("status") != "transcribed":
        raise SystemExit(f"❌ Transkripcija nije uspjela: {res.get('reason')}")

    with open(srt_out, "w", encoding="utf-8") as f:
        f.write(res["srt"])
    with open(csv_out, "w", encoding="utf-8") as f:
        f.write(res["csv"])
    _write_words(wav, res, out_tag)
    vram = (f" | peak VRAM {res['peak_vram_gb']} / {res['total_vram_gb']} GB na {res['gpu']}"
            if res.get("peak_vram_gb") else "")
    print(f"✅ {res['segments']} segmenata | inference {res['elapsed']:.0f}s{vram}")
    print(f"   → {srt_out}")
    print(f"   → {csv_out}")
    if do_diar and (force or not os.path.exists(diar_out)):
        _diarize_and_write(wav)


# ─── Volume put: modal run ...::from_volume --remote full_session_16k.wav ────
# Za snimke koje ne stanu u argument funkcije (mjereno: 2.3 GB WAV → 34 GB peak
# footprint na klijentu → kill). Workflow:
#   modal volume put domovina-audio /put/do/file.wav /file.wav
#   modal run modal_canary/canary_modal.py::from_volume --remote /file.wav --out /put/do/file.wav
@app.local_entrypoint()
def from_volume(remote: str, out: str = "", source_lang: str = "hr",
                target_lang: str = "hr", force: bool = False):
    """Transkribira WAV s audio Volumea; SRT/CSV zapisuje uz `--out` (lokalni WAV)."""
    srt_out = (out or os.path.basename(remote)) + ".canary.srt"
    csv_out = (out or os.path.basename(remote)) + ".canary.csv"
    if os.path.exists(srt_out) and not force:
        print(f"⏭️  Već postoji {srt_out} (koristi --force). Izlazim.")
        return

    print(f"🎬 Transkribiram s volumea: {remote} ({GPU_SPEC})")
    res = Canary().transcribe_volume.remote(remote, source_lang, target_lang)
    if res.get("status") != "transcribed":
        raise SystemExit(f"❌ Transkripcija nije uspjela: {res.get('reason')}")

    with open(srt_out, "w", encoding="utf-8") as f:
        f.write(res["srt"])
    with open(csv_out, "w", encoding="utf-8") as f:
        f.write(res["csv"])
    _write_words(out or os.path.basename(remote), res)
    vram = (f" | peak VRAM {res['peak_vram_gb']} / {res['total_vram_gb']} GB na {res['gpu']}"
            if res.get("peak_vram_gb") else "")
    print(f"✅ {res['segments']} segmenata | inference {res['elapsed']:.0f}s{vram}")
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
          gpu_usd_per_hour: float = 2.10, out_tag: str = ""):
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
            if os.path.exists(wav_path + _canary_suffix(out_tag) + ".srt"):
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
        print(f"      → Ovi NISU izgubljeni: `::main --wav <put>` ih automatski ruta preko"
              f" volumea iznad {VOLUME_ROUTE_THRESHOLD_MB:.0f} MB (jedan po jedan).")
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
        with open(wav_path + _canary_suffix(out_tag) + ".srt", "w", encoding="utf-8") as f:
            f.write(res["srt"])
        with open(wav_path + _canary_suffix(out_tag) + ".csv", "w", encoding="utf-8") as f:
            f.write(res["csv"])
        _write_words(wav_path, res, out_tag)
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


# ─── Noćna serija: modal run ...::batch_list --manifest m.json ───────────────
# DODANO 2026-11-23 (automatic/modal_nightly_batch.js, prekidač MODAL_NIGHTLY_BATCH=1).
# Isto kao `::main` po epizodi (prijepis + pyannote govornici, isti izlazni fajlovi,
# isti _write_words), ali za CIJELU noćnu seriju u JEDNOM ephemeral appu: Canary
# container se digne i model učita jednom, a ne jednom po epizodi (~60 % plaćenog
# A100 vremena po pojedinačnom pozivu). `::main` i `::batch` ostaju netaknuti.
#
# Manifest: [{"wav": "/abs/put.wav", "source_lang": "hr"}, ...]. Idempotentno: SRT koji
# postoji se ne radi ponovno (samo govornici ako fale). Epizoda koja ovdje padne nema
# .canary.srt → njezin job ide starim putem (`::main` u KORAKU 2.6), ništa se ne gubi.
# Fajlovi iznad `--max-mb` (default 400 MB ≈ 3,5 h zvuka) se preskaču — njih obradi job
# (`::main`, po potrebi preko volumea). Rezultat po epizodi ide u `--result-out` (JSON) za izvještaj.
@app.local_entrypoint()
def batch_list(manifest: str, concurrency: int = 2, diar_concurrency: int = 2,
               max_mb: float = 400.0, result_out: str = "", target_lang: str = "hr",
               diarize: str = ""):
    """Prijepis + govornici za popis WAV-ova u jednom appu (topli Canary container)."""

    items = json.load(open(manifest, encoding="utf-8"))
    do_diar = DIARIZE_DEFAULT_ON if diarize == "" else diarize.lower() not in ("0", "false", "off", "no")

    jobs, results = [], []
    for it in items:
        wav = it["wav"]
        r = {"wav": wav, "source_lang": it.get("source_lang") or "hr"}
        if not os.path.isfile(wav):
            r.update(status="missing"); results.append(r); continue
        mb = os.path.getsize(wav) / (1024 * 1024)
        r["mb"] = round(mb, 1)
        # Do concurrency+diar_concurrency WAV-ova je istodobno u RAM-u klijenta (bytes-argument);
        # veće ostavi jobu (`::main` ih po potrebi ruta preko volumea, jedan po jedan).
        if mb > min(max_mb, VOLUME_ROUTE_THRESHOLD_MB):
            r.update(status="too_big"); results.append(r); continue
        need_srt = not os.path.exists(wav + ".canary.srt")
        need_diar = do_diar and not os.path.exists(wav + ".canary.pyannote.json")
        if not need_srt and not need_diar:
            r.update(status="already"); results.append(r); continue
        r.update(need_srt=need_srt, need_diar=need_diar)
        jobs.append(r)

    print(f"📋 batch_list: {len(items)} u manifestu → {len(jobs)} za obradu "
          f"({sum(j['mb'] for j in jobs) / 1024:.1f} GB) | GPU {GPU_SPEC} + {DIARIZE_GPU} | "
          f"concurrency srt {concurrency} / diar {diar_concurrency}")
    t_start = time.time()

    def _write_srt(r, res):
        wav = r["wav"]
        with open(wav + ".canary.srt", "w", encoding="utf-8") as f:
            f.write(res["srt"])
        with open(wav + ".canary.csv", "w", encoding="utf-8") as f:
            f.write(res["csv"])
        _write_words(wav, res, "")
        r.update(segments=res["segments"], infer_s=round(res["elapsed"], 1),
                 peak_vram_gb=res.get("peak_vram_gb"))

    def _write_diar(r, res):
        with open(r["wav"] + ".canary.pyannote.json", "w", encoding="utf-8") as f:
            json.dump({"v": 1, "model": res.get("model"), "gpu": res.get("gpu"),
                       "speakers": res.get("speakers"), "elapsed": round(res.get("elapsed") or 0, 1),
                       "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                       "segments": res["segments"]}, f, ensure_ascii=False)
        r.update(speakers=res.get("speakers"), diar_s=round(res.get("elapsed") or 0, 1))

    # Canary i pyannote idu u ODVOJENIM redovima (dva thread poola): A100 ne smije čekati
    # T4 (govornici ~2,4 s po minuti zvuka, Canary ~0,3 s) — inače topli A100 stoji i
    # naplaćuje se dok pyannote radi, pa serija ne štedi ništa.
    import threading
    from concurrent.futures import ThreadPoolExecutor
    lock = threading.Lock()

    def _call(fn):
        try:
            return fn()
        except Exception as e:
            return {"status": "error", "reason": f"{type(e).__name__}: {e}"}

    def _do_srt(r):
        t = time.time()
        data = open(r["wav"], "rb").read()
        res = _call(lambda: Canary().transcribe.remote(data, os.path.basename(r["wav"]),
                                                       r["source_lang"], target_lang))
        del data
        with lock:
            if res.get("status") == "transcribed":
                _write_srt(r, res); r["srt"] = "ok"
            else:
                r["srt"] = "error"; r["srt_reason"] = str(res.get("reason"))[:300]
            r["srt_wall_s"] = round(time.time() - t, 1)
            print(f"   {'✅' if r['srt'] == 'ok' else '❌'} srt  {r['mb']:5.0f} MB "
                  f"{str(r.get('infer_s', '-')) + 's infer' if r['srt'] == 'ok' else r['srt_reason'][:120]}"
                  f"  {os.path.basename(r['wav'])[:60]}")

    def _do_diar(r):
        t = time.time()
        data = open(r["wav"], "rb").read()
        res = _call(lambda: Diarizer().diarize.remote(data, os.path.basename(r["wav"])))
        del data
        with lock:
            if res.get("status") == "diarized":
                _write_diar(r, res); r["diar"] = "ok"
            else:
                r["diar"] = "error"; r["diar_reason"] = str(res.get("reason"))[:300]
            r["diar_wall_s"] = round(time.time() - t, 1)
            print(f"   {'🗣️ ' if r['diar'] == 'ok' else '❌'} diar {r['mb']:5.0f} MB "
                  f"{str(r.get('speakers')) + ' govornika' if r['diar'] == 'ok' else r['diar_reason'][:120]}"
                  f"  {os.path.basename(r['wav'])[:60]}")

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as srt_pool, \
         ThreadPoolExecutor(max_workers=max(1, diar_concurrency)) as diar_pool:
        futs = [srt_pool.submit(_do_srt, r) for r in jobs if r["need_srt"]]
        futs += [diar_pool.submit(_do_diar, r) for r in jobs if r["need_diar"]]
        for f in futs:
            f.result()

    for r in jobs:
        ok_srt = r.get("srt") in ("ok", None)
        r["status"] = "ok" if ok_srt and r.get("diar") in ("ok", None) else ("partial" if ok_srt else "error")
        results.append(r)

    wall = time.time() - t_start
    n_ok = sum(1 for r in results if r.get("status") == "ok")
    n_err = sum(1 for r in results if r.get("status") in ("error", "partial"))
    infer = sum(r.get("infer_s") or 0 for r in results)
    print("\n" + "─" * 66)
    print(f"   ✅ Gotovo: {n_ok}   ⚠️ Greške/djelomično: {n_err}   ⏭️ Preskočeno: "
          f"{len(results) - n_ok - n_err}")
    print(f"   ⏱️  Wall clock: {wall / 60:.1f} min | suma Canary inference {infer / 60:.1f} min")
    if result_out:
        with open(result_out, "w", encoding="utf-8") as f:
            json.dump({"gpu": GPU_SPEC, "diarize_gpu": DIARIZE_GPU, "wall_s": round(wall, 1),
                       "infer_s": round(infer, 1), "concurrency": concurrency,
                       "files": results}, f, ensure_ascii=False, indent=1)
        print(f"   📄 Rezultat: {result_out}")
