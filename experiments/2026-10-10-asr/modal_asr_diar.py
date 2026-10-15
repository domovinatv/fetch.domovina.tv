#!/usr/bin/env python3
"""
modal_asr_diar.py — set 10.10.2026.: JEDAN Modal GPU kontejner po epizodi radi
Canary 1B v2 (s vremenom riječi) + pyannote community-1. Kopija iz
experiments/2026-10-11-asr-llm/ bez Parakeeta (najlošiji u fazi 1, jedini ispušta).
i mjeri sekunde po satu zvuka za svaki korak.

Pitanje koje mjerenje zatvara (docs/2026-10-13-procjena-troska-pune-dnevne-obrade.md §191):
je li pyannote na Modal GPU-u ~30–60 s/h audia. Ako jest, diarizacija ide u isti
kontejner kao transkripcija i Mac izlazi iz kritičnog puta.

Namjerno ZASEBNO od produkcijskog modal_canary/canary_modal.py (drugi app, isti
model Volume za Canary samo za čitanje). Ulaz je data/audio/{ID}.mp3 (64k mono) —
isti fajl koji su dobili Speechmatics/Deepgram/AssemblyAI, pa su usporedbe fer;
dekodira se u kontejneru u 16 kHz mono (manje uploada nego WAV).

Izlaz (TRAJAN, README §Trajni izlaz), po epizodi:
  <base>.exp-20261010.canary-1b-v2.prijepis.srt / .rijeci.json
  <base>.exp-20261010.pyannote-c1.govornici.json
  <base>.exp-20261010.canary-1b-v2+pyannote-c1.dijariziran.srt
  <base>.exp-20261010.modal-gpu.meta.json          (vremena po koraku, s/h, VRAM)
  <base>.exp-20261010_raw/modal-gpu.json           (cijeli povrat funkcije)

Pokretanje (eksperimentalni token, ~/.modal.toml se ne dira):
  set -a; . ./.env.experiments; set +a
  MODAL_TOKEN_ID=$MODAL_TOKEN_ID_EXPERIMENT MODAL_TOKEN_SECRET=$MODAL_TOKEN_SECRET_EXPERIMENT \
    modal run experiments/2026-10-10-asr/modal_asr_diar.py::main --ids PlPyI-TPlgw
  # --ids prazno = svih 15; --concurrency 3 = tri kontejnera paralelno; EXP_GPU=L40S za drugi GPU
"""

import json
import os
import time

import modal

APP_NAME = "domovina-exp-asr-20261010"
TAG = "exp-20261010"
CANARY_LOCAL = "/models/canary-1b-v2.nemo"          # produkcijski Volume, samo čitanje
PYANNOTE_ID = "pyannote/speaker-diarization-community-1"
GPU_SPEC = os.environ.get("EXP_GPU", "A100-40GB")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1", "sox")
    .pip_install("nemo_toolkit[asr]", "cuda-python", "pyannote.audio==4.0.4", "soundfile")
    .env({"HF_HOME": "/hf"})
)

model_vol = modal.Volume.from_name("domovina-canary-model")
hf_vol = modal.Volume.from_name("domovina-exp-hf-cache", create_if_missing=True)


def _hf_token():
    p = os.path.expanduser("~/.cache/huggingface/token")
    return open(p).read().strip() if os.path.isfile(p) else ""


hf_secret = modal.Secret.from_dict({"HF_TOKEN": _hf_token()})
app = modal.App(APP_NAME)


def _words(out0):
    rows = []
    for w in (out0.timestamp or {}).get("word") or []:
        t = (w.get("word") or w.get("char") or "").strip()
        if t and w.get("start") is not None and w.get("end") is not None:
            rows.append([round(w["start"], 3), round(w["end"], 3), t])
    return rows


def _segments(out0):
    return [{"start": round(s["start"], 3), "end": round(s["end"], 3), "text": s["segment"].strip()}
            for s in (out0.timestamp or {}).get("segment") or [] if s.get("segment", "").strip()]


@app.cls(image=image, gpu=GPU_SPEC, timeout=3600, scaledown_window=60, secrets=[hf_secret], retries=0,
         volumes={"/models": model_vol, "/hf": hf_vol})
class AsrDiar:
    @modal.enter()
    def load(self):
        import torch
        from nemo.collections.asr.models import ASRModel
        from pyannote.audio import Pipeline

        self.load_s = {}
        t = time.time()
        self.canary = ASRModel.restore_from(restore_path=CANARY_LOCAL).eval()
        if torch.cuda.is_bf16_supported():
            self.canary = self.canary.to(torch.bfloat16)
        self.load_s["canary"] = round(time.time() - t, 1)

        t = time.time()
        self.pyannote = Pipeline.from_pretrained(PYANNOTE_ID, token=os.environ["HF_TOKEN"])
        self.pyannote.to(torch.device("cuda"))
        self.load_s["pyannote"] = round(time.time() - t, 1)
        hf_vol.commit()
        print(f"📦 modeli učitani: {self.load_s}")

    def _asr(self, model, wav, **kw):
        import torch
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        t = time.time()
        with torch.inference_mode():
            out = model.transcribe([wav], timestamps=True, **kw)
        return out[0], round(time.time() - t, 2), round(torch.cuda.max_memory_allocated() / 2**30, 2)

    @modal.method()
    def run(self, mp3_bytes: bytes, vid: str) -> dict:
        import subprocess
        import tempfile

        import soundfile as sf
        import torch

        res = {"video_id": vid, "gpu": GPU_SPEC, "gpu_name": torch.cuda.get_device_name(0),
               "model_load_s": self.load_s, "steps": {}}
        tmp = tempfile.mkdtemp()
        mp3 = os.path.join(tmp, f"{vid}.mp3")
        wav = os.path.join(tmp, f"{vid}.wav")
        open(mp3, "wb").write(mp3_bytes)

        t = time.time()
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", mp3,
                        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], check=True)
        data, sr = sf.read(wav, dtype="float32")
        audio_s = len(data) / sr
        res["audio_seconds"] = round(audio_s, 2)
        res["steps"]["decode"] = {"s": round(time.time() - t, 2)}

        def per_h(s):
            return round(s / (audio_s / 3600), 1)

        # 1) Canary 1B v2 — cijela snimka (isto kao produkcija)
        try:
            out, s, peak = self._asr(self.canary, wav, source_lang="hr", target_lang="hr")
            res["canary"] = {"segments": _segments(out), "words": _words(out)}
            res["steps"]["canary"] = {"s": s, "s_per_h": per_h(s), "peak_vram_gb": peak}
        except Exception as e:
            res["steps"]["canary"] = {"error": repr(e)[:500]}

        # 2) pyannote community-1 — waveform u memoriji (nikad putanja, vidi diarize_canary.py)
        try:
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
            t = time.time()
            out = self.pyannote({"waveform": torch.from_numpy(data).unsqueeze(0), "sample_rate": sr})
            s = round(time.time() - t, 2)
            excl = [{"start": round(a.start, 3), "end": round(a.end, 3), "speaker": spk}
                    for a, _, spk in out.exclusive_speaker_diarization.itertracks(yield_label=True)]
            full = [{"start": round(a.start, 3), "end": round(a.end, 3), "speaker": spk}
                    for a, _, spk in out.speaker_diarization.itertracks(yield_label=True)]
            res["pyannote"] = {"exclusive": excl, "full": full, "speakers": len({x["speaker"] for x in excl})}
            res["steps"]["pyannote"] = {"s": s, "s_per_h": per_h(s),
                                        "peak_vram_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2)}
        except Exception as e:
            res["steps"]["pyannote"] = {"error": repr(e)[:500]}

        return res


# ─── Lokalno: spajanje i zapis ────────────────────────────────────────────────
EXP = os.path.dirname(os.path.abspath(__file__))


def _ts(sec):
    ms = int(round(sec * 1000))
    return f"{ms // 3600000:02d}:{ms % 3600000 // 60000:02d}:{ms % 60000 // 1000:02d},{ms % 1000:03d}"


def _srt(segs, with_spk):
    out = []
    for i, s in enumerate(segs, 1):
        pre = f"[{s.get('speaker', 'UNKNOWN')}] " if with_spk else ""
        out += [str(i), f"{_ts(s['start'])} --> {_ts(s['end'])}", pre + s["text"], ""]
    return "\n".join(out)


def _assign_speakers(segs, turns):
    """Najveći overlap — ista logika kao colab_diarize/diarize_canary.py:assign_speakers."""
    res = []
    for seg in segs:
        best, best_ov = "UNKNOWN", 0.0
        for t in turns:
            ov = min(seg["end"], t["end"]) - max(seg["start"], t["start"])
            if ov > best_ov:
                best, best_ov = t["speaker"], ov
        res.append({**seg, "speaker": best})
    return res


def _write(ep, res):
    d = os.path.join(EXP, "data/output", ep["kanal"])
    raw = os.path.join(d, f"{ep['base']}.{TAG}_raw")
    os.makedirs(raw, exist_ok=True)
    stem = os.path.join(d, f"{ep['base']}.{TAG}")
    turns = (res.get("pyannote") or {}).get("exclusive")

    def w(name, text):
        with open(f"{stem}.{name}", "w", encoding="utf-8") as f:
            f.write(text)

    for key, alat in (("canary", "canary-1b-v2"),):
        r = res.get(key)
        if not r:
            continue
        w(f"{alat}.prijepis.srt", _srt(r["segments"], False))
        w(f"{alat}.rijeci.json", json.dumps({"format": "[start_s, end_s, tekst]", "alat": alat,
                                             "words": r["words"]}, ensure_ascii=False))
        if turns:
            w(f"{alat}+pyannote-c1.dijariziran.srt", _srt(_assign_speakers(r["segments"], turns), True))
    if res.get("pyannote"):
        w("pyannote-c1.govornici.json", json.dumps(res["pyannote"], ensure_ascii=False))
    meta = {k: v for k, v in res.items() if k not in ("canary", "pyannote")}
    meta["speakers_pyannote"] = (res.get("pyannote") or {}).get("speakers")
    meta["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    w("modal-gpu.meta.json", json.dumps(meta, ensure_ascii=False, indent=2))
    with open(os.path.join(raw, "modal-gpu.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False)
    return meta


@app.local_entrypoint()
def main(ids: str = "", concurrency: int = 3, force: bool = False):
    from collections import deque

    rows = [l.split("\t") for l in open(os.path.join(EXP, "bases.tsv"), encoding="utf-8").read().strip().split("\n")[1:]]
    eps = [{"id": a, "kanal": b, "base": c} for a, b, c in rows]
    want = [x for x in ids.split(",") if x]
    if want:
        eps = [e for e in eps if e["id"] in want]
    todo = [e for e in eps if force or not os.path.exists(os.path.join(
        EXP, "data/output", e["kanal"], f"{e['base']}.{TAG}.modal-gpu.meta.json"))]
    print(f"📋 {len(todo)} epizoda na {GPU_SPEC}, {concurrency} kontejnera paralelno")

    t0 = time.time()
    queue, inflight, metas = deque(todo), deque(), []
    while queue or inflight:
        while queue and len(inflight) < concurrency:
            ep = queue.popleft()
            mp3 = os.path.join(EXP, "data/audio", f"{ep['id']}.mp3")
            if not os.path.isfile(mp3):
                print(f"❌ {ep['id']}: nema {mp3}")
                continue
            data = open(mp3, "rb").read()
            inflight.append((ep, AsrDiar().run.spawn(data, ep["id"]), time.time()))
        if not inflight:
            break
        ep, h, ts = inflight.popleft()
        try:
            res = h.get()
        except Exception as e:
            print(f"❌ {ep['id']}: {e!r}")
            continue
        res["wall_s_client"] = round(time.time() - ts, 1)
        m = _write(ep, res)
        metas.append(m)
        st = m["steps"]
        fmt = lambda k: (f"{st[k]['s_per_h']} s/h" if "s_per_h" in st.get(k, {}) else f"GREŠKA {st.get(k)}")
        print(f"✅ {ep['id']} {m['audio_seconds'] / 60:.0f} min | canary {fmt('canary')} | "
              f"pyannote {fmt('pyannote')} ({m['speakers_pyannote']} gov.) | "
              f"wall {res['wall_s_client']} s")
    print(f"\nGotovo: {len(metas)}/{len(todo)} za {(time.time() - t0) / 60:.1f} min")
