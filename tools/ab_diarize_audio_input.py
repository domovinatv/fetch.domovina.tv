#!/usr/bin/env python3
"""ab_diarize_audio_input.py — A/B: waveform-u-RAM-u vs putanja (P1).

⚠️ PITANJE JE ZATVORENO 2026-08-25 — WAVEFORM POBJEĐUJE, I TO UVJERLJIVO.
Ovaj alat je odigrao samo prvu epizodu (17.5 min: 100 % poklapanje govornika, ali
putanja 0.9 vs 0.7 min i 1.51 vs 1.45 GB RSS) prije nego je pun run prekinut.
Presuda nije stigla odavde nego iz uzvodne provjere: putanja NE štedi memoriju
(`Inference.__call__` ionako zove `get_all_samples()`), a `Audio.crop()` stvara novi
AudioDecoder po pozivu uz torchcodec < 0.14 koji premotava na početak datoteke —
mjereno 4.3 ms na 0 h vs 3508 ms na 15 h, integrirano 8–15 h samo dekodiranja.
Detalji: docs/pipeline_memorija_i_propusnost_2026-08.md §5.1–§5.3.

Alat je zadržan jer mjeri poklapanje particija govornika između dvije konfiguracije,
što je i dalje korisno — npr. za validaciju chunk+merge postupka iz §6.8 protiv
jednoprolaznog referentnog rezultata. Za odabir audio ulaza više ga NE treba pokretati.

Zasto postoji: `diarize.py` je godinama pyannoteu predavao WAVEFORM uz komentar
da to "zaobilazi AudioDecoder". Putanja je 2026-08-25 dokazano radila na
pyannote 4.0.4 s community-1 modelom (sabor_pipeline/02_diarize.py), ali to je
DRUGA snimka i drugi poziv — pa se default ne mijenja bez mjerenja na stvarnim
nightly epizodama.

Sto mjeri, po epizodi i po nacinu ulaza:
  - peak RSS procesa koji radi diarizaciju (uzorkovan iz roditelja)
  - wall clock
  - broj govornika i broj segmenata
  - poklapanje granica: udio SRT redaka kojima oba nacina dodijele ISTOG
    govornika, nakon optimalnog preslikavanja oznaka (SPEAKER_XX su proizvoljne)

Svaka ruka ide u SVJEZ child proces (spawn) — inace bi drugi prolaz naslijedio
memoriju prvog i mjerenje RSS-a ne bi znacilo nista.

NIKAD ne pise u pipeline izlaz: rezultati idu u --out JSON.

    python3 tools/ab_diarize_audio_input.py --out ab.json \
        storage/output/kanal/epizoda.wav ...
"""

import argparse
import ctypes
import json
import multiprocessing as mp
import os
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "colab_diarize"))

CANARY_SRT_SUFFIX = ".canary.srt"


def rss_gb(pid):
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=5)
        return int(out.stdout.strip()) / 2**20
    except Exception:
        return 0.0


def _arm_child(wav, mode, hf_token, out_q):
    """Jedna ruka mjerenja: ucitaj model, diariziraj, vrati segmente."""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "diarize_canary", REPO_ROOT / "colab_diarize" / "diarize_canary.py")
        dc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dc)

        t_load = time.time()
        pipeline, device = dc.load_diarization_pipeline(hf_token)
        load_s = time.time() - t_load

        t0 = time.time()
        segments, n_speakers = dc.run_diarization(
            pipeline, wav, audio_input_mode=mode, progress_prefix=f"   [{mode}]",
            progress_interval=120)
        out_q.put({"status": "ok", "mode": mode, "segments": segments,
                   "n_speakers": n_speakers, "diarize_s": time.time() - t0,
                   "model_load_s": load_s, "device": device})
    except Exception as e:
        import traceback
        out_q.put({"status": "error", "mode": mode, "reason": f"{type(e).__name__}: {e}",
                   "traceback": traceback.format_exc()[-2000:]})


def run_arm(wav, mode, hf_token, sample_interval_s=2.0):
    """Pokrene jednu ruku u svjezem procesu i uzorkuje njegov RSS."""
    ctx = mp.get_context("spawn")
    q = ctx.Queue()
    proc = ctx.Process(target=_arm_child, args=(wav, mode, hf_token, q))
    t0 = time.time()
    proc.start()

    peak = 0.0
    while proc.is_alive():
        time.sleep(sample_interval_s)
        peak = max(peak, rss_gb(proc.pid))

    proc.join()
    res = q.get() if not q.empty() else {"status": "error", "mode": mode,
                                         "reason": f"dijete izaslo bez rezultata (exitcode={proc.exitcode})"}
    res["peak_rss_gb"] = round(peak, 2)
    res["wall_s"] = round(time.time() - t0, 1)
    return res


def label_sequence(srt_segments, speaker_segments):
    """Govornik po SRT retku (isti best-overlap kao u pipelineu)."""
    labels = []
    for seg in srt_segments:
        best, best_ov = "UNKNOWN", 0.0
        for spk in speaker_segments:
            ov = min(seg["end"], spk["end"]) - max(seg["start"], spk["start"])
            if ov > best_ov:
                best_ov, best = ov, spk["speaker"]
        labels.append(best)
    return labels


def agreement(labels_a, labels_b):
    """Udio redaka s istim govornikom, nakon optimalnog preslikavanja oznaka.

    SPEAKER_00 iz jedne ruke ne mora biti SPEAKER_00 iz druge — bitno je da je
    PARTICIJA ista. Preslikavanje je pohlepno po najvecoj konfuzijskoj celiji;
    za tipican broj govornika (< 30) to je jednako Hungarianu u praksi, a nema
    vanjsku ovisnost (scipy nije u ovom repou).
    """
    from collections import Counter
    conf = Counter(zip(labels_a, labels_b))
    mapping, used_a, used_b = {}, set(), set()
    for (a, b), _ in conf.most_common():
        if a in used_a or b in used_b:
            continue
        mapping[a] = b
        used_a.add(a); used_b.add(b)
    hits = sum(1 for a, b in zip(labels_a, labels_b) if mapping.get(a) == b)
    return hits / len(labels_a) if labels_a else 0.0, mapping


def speech_seconds(segments):
    return round(sum(s["end"] - s["start"] for s in segments), 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wavs", nargs="+")
    ap.add_argument("--out", default="ab_audio_input.json")
    ap.add_argument("--hf-token", default=None)
    ap.add_argument("--order", default="path,waveform",
                    help="redoslijed ruku (default: path,waveform)")
    args = ap.parse_args()

    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "diarize_canary", REPO_ROOT / "colab_diarize" / "diarize_canary.py")
    dc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dc)

    hf_token = args.hf_token or dc.get_hf_token(None)
    modes = [m.strip() for m in args.order.split(",") if m.strip()]

    results = []
    for wav in args.wavs:
        srt = wav + CANARY_SRT_SUFFIX
        if not os.path.isfile(wav) or not os.path.isfile(srt):
            print(f"   preskacem (nema WAV ili .canary.srt): {wav}")
            continue

        srt_segments = dc.parse_srt(srt)
        dur = dc.wav_duration_s(wav) or 0.0
        name = os.path.basename(wav)
        print(f"\n{'=' * 78}\n  {name}\n  {dur / 60:.1f} min zvuka | "
              f"{os.path.getsize(wav) / 2**20:.0f} MB | {len(srt_segments)} SRT redaka\n{'=' * 78}")

        arms = {}
        for mode in modes:
            print(f"\n   ── ruka: {mode} ──")
            res = run_arm(wav, mode, hf_token)
            if res["status"] != "ok":
                print(f"   GRESKA ({mode}): {res.get('reason')}")
                print(res.get("traceback", ""))
                arms[mode] = res
                continue
            res["labels"] = label_sequence(srt_segments, res["segments"])
            res["speech_s"] = speech_seconds(res["segments"])
            res["n_segments"] = len(res["segments"])
            print(f"   {mode}: {res['n_segments']} segmenata, {res['n_speakers']} govornika, "
                  f"{res['diarize_s'] / 60:.1f} min, peak RSS {res['peak_rss_gb']} GB")
            arms[mode] = res

        entry = {"wav": wav, "duration_s": round(dur, 1),
                 "wav_mb": round(os.path.getsize(wav) / 2**20, 1),
                 "srt_lines": len(srt_segments)}
        for mode, res in arms.items():
            entry[mode] = {k: v for k, v in res.items()
                           if k not in ("segments", "labels", "traceback")}

        if all(arms.get(m, {}).get("status") == "ok" for m in modes) and len(modes) == 2:
            a, b = modes
            agr, _ = agreement(arms[a]["labels"], arms[b]["labels"])
            entry["agreement"] = round(agr, 4)
            entry["speaker_delta"] = arms[b]["n_speakers"] - arms[a]["n_speakers"]
            entry["speech_delta_s"] = round(arms[b]["speech_s"] - arms[a]["speech_s"], 1)
            entry["rss_ratio"] = (round(arms[a]["peak_rss_gb"] / arms[b]["peak_rss_gb"], 2)
                                  if arms[b]["peak_rss_gb"] else None)
            print(f"\n   >> poklapanje govornika po SRT retku: {agr * 100:.2f}%"
                  f" | razlika u broju govornika: {entry['speaker_delta']:+d}"
                  f" | govor: {entry['speech_delta_s']:+.1f}s"
                  f" | RSS {arms[a]['peak_rss_gb']} vs {arms[b]['peak_rss_gb']} GB")

        results.append(entry)
        Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")

    print(f"\n   rezultati: {args.out}")

    ok = [r for r in results if "agreement" in r]
    if ok:
        a, b = modes
        print(f"\n{'epizoda':<44} {'min':>6} {'poklapanje':>11} {'spk Δ':>6} "
              f"{'RSS ' + a:>10} {'RSS ' + b:>10} {'min ' + a:>9} {'min ' + b:>9}")
        for r in ok:
            print(f"{os.path.basename(r['wav'])[:44]:<44} {r['duration_s'] / 60:6.1f} "
                  f"{r['agreement'] * 100:10.2f}% {r['speaker_delta']:+6d} "
                  f"{r[a]['peak_rss_gb']:10.2f} {r[b]['peak_rss_gb']:10.2f} "
                  f"{r[a]['diarize_s'] / 60:9.1f} {r[b]['diarize_s'] / 60:9.1f}")


if __name__ == "__main__":
    main()
