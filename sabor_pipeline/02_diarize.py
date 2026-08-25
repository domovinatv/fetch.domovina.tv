#!/usr/bin/env python3
"""
02_diarize.py — globalna diarizacija saborske sjednice s obranom od rušenja stroja

Faza 02 iz sabor_pipeline/02_global_diarization.md.

Cilj: JEDAN prolaz nad spojenim `full_session_16k.wav` → `SPEAKER_XX` je ista osoba
kroz cijelu sjednicu po konstrukciji, bez naknadnog spajanja identiteta među dijelovima.

═══ ZAŠTO OVA SKRIPTA POSTOJI (a ne koristimo diarize.py) ═══

`diarize.py` i `colab_diarize/diarize_canary.py` rade:

    data, sr = sf.read(wav_file)                    # cijeli fajl u RAM (float64!)
    waveform = torch.from_numpy(data).float()       # + float32 kopija
    pipeline({"waveform": waveform, ...})

Za 20 h to je 9.2 GB (float64) + 4.6 GB (float32) = ~14 GB prije nego pyannote alocira
išta svoje, na stroju s 24 GB unified memorije. Kad to prelije, macOS raste swap NA
SISTEMSKOM DISKU — a kad se disk napuni, ruše se i drugi procesi (Docker daemon zna
ostati u stanju iz kojeg se diže samo restartom). Mjereno na ovom stroju.

Obrana je trostruka:

1. **Putanja umjesto waveforma** — pyannoteu se daje `str(path)`, pa on čita prozore
   lijeno s diska umjesto da držimo cijelu snimku u memoriji.
2. **Pyannote u CHILD procesu** — roditelj ne radi ništa teško, pa preživi i kad
   dijete mora umrijeti. Sav rizik je u procesu koji se smije ubiti.
3. **Nadzornik s pragovima** — svakih N sekundi mjeri slobodan prostor na `/` (ondje
   swap raste) i RSS djeteta. Ako padne ispod praga, dijete se ubija SIGKILL-om i
   skripta izlazi s dijagnozom. Bolje izgubiti run nego stroj.

Primjeri:
  python3 sabor_pipeline/02_diarize.py --session sabor_11_izvanredna_11_gospic --dry-run
  python3 sabor_pipeline/02_diarize.py --session sabor_11_izvanredna_11_gospic
  python3 sabor_pipeline/02_diarize.py --session ... --target parts   # sigurniji fallback
"""

import argparse
import json
import multiprocessing as mp
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_DIR = REPO_ROOT / "storage" / "output" / "sabor"

# Pragovi obrane. Sistemski disk je taj na kojem macOS drži swap — kad on ode,
# odlaze i nevezani procesi (Docker), pa je prag namjerno konzervativan.
MIN_FREE_DISK_GB = 12.0      # ispod ovoga na `/` → ubij dijete
CHILD_RSS_CAP_GB = 15.0      # RSS djeteta iznad ovoga → ubij (24 GB stroj)
CHECK_INTERVAL_S = 15


def free_disk_gb(path="/"):
    return shutil.disk_usage(path).free / 2**30


def total_ram_gb():
    out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True)
    return int(out.stdout.strip()) / 2**30


def swap_usage():
    """(total_gb, used_gb) iz sysctl vm.swapusage."""
    out = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True)
    tot = used = 0.0
    parts = out.stdout.replace("=", " ").split()
    for i, p in enumerate(parts):
        if p == "total" and i + 1 < len(parts):
            tot = float(parts[i + 1].rstrip("M")) / 1024
        if p == "used" and i + 1 < len(parts):
            used = float(parts[i + 1].rstrip("M")) / 1024
    return tot, used


# Napredak djeteta vidljiv roditelju kroz shared memory. Namjerno GOLI
# sharedctypes objekti, a ne vlastita klasa: pod `spawn`-om se argumenti procesa
# pickleaju, a klasa definirana u `__main__` skripte s vodecom znamenkom u imenu
# ("02_diarize.py") nije uvijek razrjesiva u djetetu. Gole Array/Value imaju
# vlastitu ForkingPickler redukciju i uvijek prolaze.

def _make_progress(ctx):
    """(step_arr, frac_val) — dijeljeno stanje napretka."""
    import ctypes
    return ctx.Array(ctypes.c_char, 64, lock=False), ctx.Value("d", 0.0, lock=False)


def _progress_write(step_arr, frac_val, step_name, frac):
    step_arr.value = step_name.encode("utf-8")[:63]
    frac_val.value = frac


def _progress_read(step_arr, frac_val):
    return step_arr.value.decode("utf-8", "replace"), frac_val.value


class LogProgressHook:
    """pyannote hook koji pise OBICNE log retke (bez ANSI-ja).

    Zasto ne knjiznicni `ProgressHook`: on crta `rich` progress bar, a ovaj se
    ispis cita iz nadzornickog loga (i iz launchd nightly loga) — ANSI escape
    sekvence ondje su smece.

    `completed`/`total` za korak "segmentation" su redni brojevi PROZORA nad
    snimkom, pa je iz njih citljiva stvarna pozicija u snimci. Za ostale korake
    (embeddings) to su batchevi — postotak da, pozicija ne.
    """

    def __init__(self, prefix="", duration_s=None, min_interval_s=60, sink=None):
        self.prefix = prefix
        self.duration_s = duration_s
        self.min_interval_s = min_interval_s
        self.sink = sink
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
            if self.sink:
                self.sink(step_name, 0.0)
            print(f"{self.prefix}   ▶ korak: {step_name} "
                  f"(+{self._hms(now - self.t0)} od starta)", flush=True)

        if not total or completed is None:
            return

        frac = min(1.0, max(0.0, completed / total))
        if self.sink:
            self.sink(step_name, frac)

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
        info = sf.info(str(wav_path))
        return info.frames / float(info.samplerate)
    except Exception:
        return None


def hms(sec):
    sec = max(0, int(sec))
    return f"{sec // 3600}:{(sec % 3600) // 60:02d}:{sec % 60:02d}"


def rss_gb(pid):
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=5)
        return int(out.stdout.strip()) / 2**20   # ps daje KB
    except Exception:
        return 0.0


# ─── Child: sve što troši memoriju živi ovdje ────────────────────────────────

def _diarize_child(wav_path, hf_token, device, min_spk, max_spk, out_queue,
                   step_arr=None, frac_val=None, progress_interval=60):
    """Pokreće pyannote nad PUTANJOM (ne waveformom) i vraća segmente kroz queue."""
    try:
        import torch
        from pyannote.audio import Pipeline

        if device == "auto":
            device = "mps" if torch.backends.mps.is_available() else "cpu"

        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-community-1", token=hf_token
        )
        pipeline.to(torch.device(device))

        kwargs = {}
        if min_spk:
            kwargs["min_speakers"] = min_spk
        if max_spk:
            kwargs["max_speakers"] = max_spk

        print(f"   🖥️  device={device}  params={kwargs or 'auto'}", flush=True)
        print(f"   ▶️  pyannote čita s diska: {wav_path}", flush=True)
        t0 = time.time()

        # Indikator napretka (P2): bez njega se na 20-satnoj snimci desecima minuta
        # ne moze razlikovati "radi" od "zaglavilo", a projekcija trajanja je bila
        # linearna ekstrapolacija — a zavrsno klasteriranje NE skalira linearno.
        sink = None
        if step_arr is not None:
            def sink(name, frac):
                _progress_write(step_arr, frac_val, name, frac)
        hook = LogProgressHook(duration_s=wav_duration_s(wav_path),
                               min_interval_s=progress_interval,
                               sink=sink)

        # KLJUČNO: putanja, ne {"waveform": ...} — pyannote tada čita prozore lijeno.
        with hook:
            result = pipeline(str(wav_path), hook=hook, **kwargs)

        diar = getattr(result, "exclusive_speaker_diarization", None) \
            or getattr(result, "speaker_diarization", None) or result

        segments = [
            {"start": round(float(t.start), 3), "end": round(float(t.end), 3), "speaker": spk}
            for t, _, spk in diar.itertracks(yield_label=True)
        ]
        out_queue.put({"status": "ok", "segments": segments, "elapsed": time.time() - t0})
    except Exception as e:
        import traceback
        out_queue.put({"status": "error", "reason": f"{type(e).__name__}: {e}",
                       "traceback": traceback.format_exc()[-2000:]})


def run_guarded(wav_path, hf_token, device, min_spk, max_spk,
                min_free_disk_gb, rss_cap_gb, interval_s, progress_interval=60,
                duration_s=None):
    """Pokreće diarizaciju u child procesu i nadzire disk/RAM. Vraća dict rezultata."""
    ctx = mp.get_context("spawn")
    q = ctx.Queue()
    step_arr, frac_val = _make_progress(ctx)
    proc = ctx.Process(target=_diarize_child,
                       args=(wav_path, hf_token, device, min_spk, max_spk, q,
                             step_arr, frac_val, progress_interval))
    proc.start()
    print(f"   🛡️  Nadzornik aktivan (PID {proc.pid}) — prag: disk ≥ {min_free_disk_gb:.0f} GB, "
          f"RSS ≤ {rss_cap_gb:.0f} GB, provjera svakih {interval_s}s", flush=True)

    t0 = time.time()
    peak_rss = 0.0
    min_disk = free_disk_gb()
    killed = None

    while proc.is_alive():
        time.sleep(interval_s)
        disk = free_disk_gb()
        rss = rss_gb(proc.pid)
        peak_rss = max(peak_rss, rss)
        min_disk = min(min_disk, disk)
        sw_tot, sw_used = swap_usage()
        mins = (time.time() - t0) / 60
        step, frac = _progress_read(step_arr, frac_val)
        # Pozicija u snimci je stvarna SAMO za korak "segmentation" (prozori idu
        # redom kroz snimku); za ostale korake postotak je napredak batcheva.
        if step == "segmentation" and duration_s:
            where = f" | {step} {frac*100:4.1f}% ≈ {hms(frac*duration_s)}/{hms(duration_s)}"
        elif step:
            where = f" | {step} {frac*100:4.1f}%"
        else:
            where = " | ucitavam model"
        print(f"   ⏱️  {mins:6.1f} min | RSS {rss:5.1f} GB (peak {peak_rss:5.1f}) | "
              f"disk / {disk:5.1f} GB | swap {sw_used:.1f}/{sw_tot:.1f} GB{where}", flush=True)

        if disk < min_free_disk_gb:
            killed = f"slobodan prostor na / pao na {disk:.1f} GB (prag {min_free_disk_gb:.0f} GB)"
        elif rss > rss_cap_gb:
            killed = f"RSS djeteta {rss:.1f} GB premašio prag {rss_cap_gb:.0f} GB"

        if killed:
            print(f"\n   🛑 PREKID: {killed}", flush=True)
            print("      Ubijam dijete da stroj ne ode u swap-thrash.", flush=True)
            os.kill(proc.pid, signal.SIGKILL)
            proc.join(timeout=30)
            return {"status": "aborted", "reason": killed,
                    "peak_rss_gb": round(peak_rss, 2), "min_free_disk_gb": round(min_disk, 2)}

    proc.join()
    res = q.get() if not q.empty() else {"status": "error", "reason": f"dijete izašlo bez rezultata (exitcode={proc.exitcode})"}
    res["peak_rss_gb"] = round(peak_rss, 2)
    res["min_free_disk_gb"] = round(min_disk, 2)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    ap.add_argument("--target", choices=["stitched", "parts"], default="stitched",
                    help="stitched = jedan prolaz nad spojenim audiom (globalni ID-evi); "
                         "parts = po dijelu (sigurnije, ali traži naknadno spajanje identiteta)")
    ap.add_argument("--only-part", type=int, default=None,
                    help="samo taj dio (uz --target parts) — za probne runove")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--min-speakers", type=int, default=None)
    ap.add_argument("--max-speakers", type=int, default=None)
    ap.add_argument("--min-free-disk-gb", type=float, default=MIN_FREE_DISK_GB)
    ap.add_argument("--rss-cap-gb", type=float, default=CHILD_RSS_CAP_GB)
    ap.add_argument("--check-interval", type=int, default=CHECK_INTERVAL_S)
    ap.add_argument("--progress-interval", type=int, default=60,
                    help="razmak ispisa pyannote napretka iz djeteta (sekunde)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    session_dir = Path(args.output_dir) / args.session
    manifest_path = session_dir / "session_manifest.json"
    if not manifest_path.is_file():
        sys.exit(f"❌ Nema manifesta: {manifest_path} (pokreni fazu 01)")
    manifest = json.loads(manifest_path.read_text())

    print("\n╔══════════════════════════════════════════════════╗")
    print("║   🏛️  SABOR — FAZA 02: GLOBALNA DIARIZACIJA      ║")
    print("╚══════════════════════════════════════════════════╝\n")
    print(f"   📄 {manifest.get('title') or args.session}")
    print(f"   ⏱️  {manifest['total_duration_hms']} ({manifest['total_duration_sec']/3600:.2f} h)")

    # ─── Predpolet: je li stroj uopće u stanju ovo izdržati ───
    disk = free_disk_gb()
    ram = total_ram_gb()
    sw_tot, sw_used = swap_usage()
    print(f"\n   💾 RAM {ram:.0f} GB | slobodno na / {disk:.1f} GB | swap {sw_used:.1f}/{sw_tot:.1f} GB")
    if disk < args.min_free_disk_gb:
        sys.exit(f"\n❌ PREKID PRIJE STARTA: samo {disk:.1f} GB slobodno na / "
                 f"(prag {args.min_free_disk_gb:.0f} GB).\n"
                 f"   macOS ovdje drži swap — pyannote bi ga napunio i srušio druge procese.\n"
                 f"   Oslobodi prostor pa pokreni ponovno.")

    if args.target == "stitched":
        wav = session_dir / manifest["audio"]["full_session_wav"]
        targets = [(wav, 0.0)]
    else:
        parts = manifest["parts"]
        if args.only_part is not None:
            parts = [p for p in parts if p["part"] == args.only_part]
            if not parts:
                sys.exit(f"❌ Nema dijela {args.only_part} u manifestu")
        targets = [(session_dir / p["wav_file"], p["offset_global_sec"]) for p in parts]

    for wav, off in targets:
        if not wav.is_file():
            sys.exit(f"❌ Nema audija: {wav}")
        print(f"   🎧 {wav.name}  ({wav.stat().st_size/2**30:.2f} GB, offset {off:.0f}s)")

    if args.dry_run:
        print("\n🧪 DRY RUN — ništa nije pokrenuto.\n")
        return

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        cached = Path.home() / ".cache" / "huggingface" / "token"
        if cached.is_file():
            hf_token = cached.read_text().strip()
    if not hf_token:
        sys.exit("❌ Nema HF tokena (HF_TOKEN env ili ~/.cache/huggingface/token)")

    all_segments = []
    for wav, offset in targets:
        print(f"\n▶️  Diariziram {wav.name}")
        res = run_guarded(wav, hf_token, args.device, args.min_speakers, args.max_speakers,
                          args.min_free_disk_gb, args.rss_cap_gb, args.check_interval,
                          progress_interval=args.progress_interval,
                          duration_s=wav_duration_s(wav))

        if res["status"] != "ok":
            print(f"\n❌ {res['status'].upper()}: {res.get('reason')}")
            if res.get("traceback"):
                print(res["traceback"])
            print(f"   peak RSS {res.get('peak_rss_gb')} GB | min slobodan disk {res.get('min_free_disk_gb')} GB")
            if args.target == "stitched":
                print("\n   💡 Spojeni audio je pao — probaj --target parts "
                      "(4 × ~6 h, znatno manji otisak) pa spoji identitete naknadno.")
            sys.exit(1)

        segs = res["segments"]
        if offset:
            for s in segs:
                s["start"] = round(s["start"] + offset, 3)
                s["end"] = round(s["end"] + offset, 3)
                s["speaker"] = f"P{int(offset)}_{s['speaker']}"   # oznake NISU globalne u parts modu
        all_segments.extend(segs)
        spk = len({s["speaker"] for s in segs})
        print(f"   ✅ {len(segs)} segmenata, {spk} govornika za {res['elapsed']/60:.1f} min "
              f"| peak RSS {res['peak_rss_gb']} GB")

    all_segments.sort(key=lambda s: s["start"])
    speakers = sorted({s["speaker"] for s in all_segments})
    out = {
        "session_id": args.session,
        "source": args.target,
        "total_duration_sec": manifest["total_duration_sec"],
        "total_speakers_detected": len(speakers),
        "globally_consistent": args.target == "stitched",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "segments": all_segments,
    }
    out_path = session_dir / ("diarization.json" if args.only_part is None
                              else f"diarization.part{args.only_part}.json")
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")

    print(f"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"   ✅ FAZA 02 gotova — {len(all_segments)} segmenata, {len(speakers)} govornika")
    print(f"   🔗 Globalno konzistentni ID-evi: {'DA' if out['globally_consistent'] else 'NE (parts mod)'}")
    print(f"   📄 {out_path.relative_to(REPO_ROOT)}")
    print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")


if __name__ == "__main__":
    main()
