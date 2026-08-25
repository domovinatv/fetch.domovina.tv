#!/usr/bin/env python3
"""
02_diarize.py — FAZA 02a: diarizacija saborske sjednice PO KOMADIMA (~2 h).

Provodi tocke 1-3 iz `docs/pipeline_memorija_i_propusnost_2026-08.md` §6.8.
Izlaz ove skripte NIJE konacan: daje po komadu lokalne oznake + centroide.
Globalne oznake radi `02b_merge_speakers.py` (tocke 4-5 istog poglavlja).

    01_ingest.js  →  02_diarize.py  →  02b_merge_speakers.py  →  faza 03
                     (ovaj korak)      (spajanje identiteta)

═══ ZASTO KOMADI, A NE JEDAN PROLAZ ═══

Prva verzija ove skripte pokusavala je JEDAN prolaz nad spojenim 20-satnim
audiom. Prekinut nakon 146 min. Naknadna analiza (§6.1) pokazuje da ne prolazi
ni teoretski, i to na DVA neovisna mjesta:

| faza                                          | za 20 h        |
|---|---|
| embeddinga u klasteriranje (1099/s, mjereno)  | ≈ 79 200       |
| AHC `scipy.linkage`, condensed float64        | ≈ 25.1 GB  ⛔  |
| `reconstruct()` float64, alocira 2 kopije     | 28-41 GB   ⛔  |
| ...i poziva se DVAPUT (regularna + exclusive) | ⛔             |

Stroj ima 24 GB, od cega Docker VM drzi 14 GiB rezervirano. Nije rubno nego za
faktor. Isto priznaju i uzvodni projekti: pyannote #1819 (4 h) zatvoren kao
`wontfix`, NeMo #7912 → OOM na 64 GB. Kanonski postupak (rezi → diariziraj →
spoji klastere) je Huijbregts & van Leeuwen, IEEE TASLP 20(2):404-413, 2012.

**Ne pokusavati ponovno jedan prolaz.** Zato ova skripta vise nema `--target
stitched` nacin rada.

═══ TRI STVARI KOJE TIHO PUCAJU ═══

1. **Waveform, nikad putanja.** `pipeline(str(path))` izgleda kao usteda
   memorije, ali nije: `Inference.__call__` svejedno zove `get_all_samples()`.
   Uz to je dramaticno sporija — `Audio.crop()` stvara NOVI `AudioDecoder` po
   pozivu, a torchcodec < 0.14 (mi imamo 0.10.0) premotava na pocetak datoteke.
   Mjereno na 20 h WAV-u: crop na 0 h = 4.3 ms, na 15 h = 3508 ms → 8-15 h samo
   dekodiranja. Vidi §5.1-5.3.
2. **`dtype="float32"` u `sf.read`.** Bez njega float64 + kopija = 3× memorije.
3. **`set_per_process_memory_fraction(0.55)` PRIJE prve MPS alokacije.** Default
   MPS high watermark je 1.7× `recommended_max_memory()` = 30.2 GiB na stroju s
   22.35 GiB — PyTorch po defaultu NIKAD ne baci OOM prije nego stroj ode u
   swap. Ovaj redak je vazniji od cijelog nadzornika (§5.6).

Primjeri:
  python3 sabor_pipeline/02_diarize.py --session sabor_11_izvanredna_11_gospic --dry-run
  python3 sabor_pipeline/02_diarize.py --session sabor_11_izvanredna_11_gospic
  python3 sabor_pipeline/02_diarize.py --session ... --only-part 4
  python3 sabor_pipeline/02_diarize.py --session ... --only-part 1 --only-chunk 0
"""

import argparse
import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from utils import machine_guard as mg                     # noqa: E402
from utils import diar_runner as dr                       # noqa: E402
from utils.audio_chunker import plan_chunks               # noqa: E402

DEFAULT_OUTPUT_DIR = REPO_ROOT / "storage" / "output" / "sabor"

TARGET_CHUNK_S = 7200.0     # ~2 h (§6.8 t.1)
OVERLAP_S = 90.0            # sredina raspona 60-120 s (§6.8 t.2)
MAX_CHUNK_S = 9000.0        # 2.5 h — iznad toga se dodaje jos jedan komad
MPS_MEMORY_FRACTION = dr.MPS_MEMORY_FRACTION   # ≈9.8 GiB cap (§5.6)
CHECK_INTERVAL_S = 20

# Pragovi nadzornika. Namjerno NIZI disk-prag od nightly guarda (12 GB):
# ondje ga stiti od NEOGRANICENOG jednoprolaznog runa, a ovdje je vrsak omeden
# konstrukcijom (2 h komad + MPS cap), pa 12 GB ne bi ni dopustio start na stroju
# koji trenutno ima 13 GB. Vrhovi se mjere i ispisuju po komadu — ako se pokaze
# da su niski, prag se moze podici natrag s podatkom u ruci.
MIN_FREE_DISK_GB = 7.0
FOOTPRINT_CAP_GB = 14.0
SWAP_GROWTH_GB = 3.0
# Jedan uzorak razine WARN je lazni pozitiv na ovom stroju (Docker VM drzi
# 14 GiB, pa macOS cesto nagovjesti WARN dok reklamira memoriju). Mjereno:
# prekid na 1 uzorku uz footprint 5.0 GB i swap koji PADA. Vidi machine_guard.
WARN_STREAK_ABORT = 6


# ─── Driver ──────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    ap.add_argument("--only-part", type=int, default=None)
    ap.add_argument("--only-chunk", type=int, default=None,
                    help="samo taj komad unutar dijela (uz --only-part)")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--min-speakers", type=int, default=None)
    ap.add_argument("--max-speakers", type=int, default=None)
    ap.add_argument("--target-chunk-s", type=float, default=TARGET_CHUNK_S)
    ap.add_argument("--overlap-s", type=float, default=OVERLAP_S)
    ap.add_argument("--max-chunk-s", type=float, default=MAX_CHUNK_S)
    ap.add_argument("--no-silence-cuts", action="store_true",
                    help="rezi na nominali, bez trazenja tisine (za usporedbu)")
    ap.add_argument("--mps-fraction", type=float, default=MPS_MEMORY_FRACTION)
    ap.add_argument("--min-free-disk-gb", type=float, default=MIN_FREE_DISK_GB)
    ap.add_argument("--footprint-cap-gb", type=float, default=FOOTPRINT_CAP_GB)
    ap.add_argument("--swap-growth-gb", type=float, default=SWAP_GROWTH_GB)
    ap.add_argument("--warn-streak-abort", type=int, default=WARN_STREAK_ABORT,
                    help="koliko uzastopnih uzoraka razine WARN prekida posao "
                         "(CRITICAL prekida odmah)")
    ap.add_argument("--no-guard", action="store_true")
    ap.add_argument("--check-interval", type=int, default=CHECK_INTERVAL_S)
    ap.add_argument("--progress-interval", type=int, default=60)
    ap.add_argument("--force", action="store_true", help="preracunaj i postojece komade")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    session_dir = Path(args.output_dir) / args.session
    manifest_path = session_dir / "session_manifest.json"
    if not manifest_path.is_file():
        sys.exit(f"❌ Nema manifesta: {manifest_path} (pokreni fazu 01)")
    manifest = json.loads(manifest_path.read_text())

    print("\n╔══════════════════════════════════════════════════════╗")
    print("║  🏛️  SABOR — FAZA 02a: DIARIZACIJA PO KOMADIMA (~2h)  ║")
    print("╚══════════════════════════════════════════════════════╝\n")
    print(f"   📄 {manifest.get('title') or args.session}")
    print(f"   ⏱️  {manifest['total_duration_hms']} "
          f"({manifest['total_duration_sec']/3600:.2f} h)")

    parts = manifest["parts"]
    if args.only_part is not None:
        parts = [p for p in parts if p["part"] == args.only_part]
        if not parts:
            sys.exit(f"❌ Nema dijela {args.only_part} u manifestu")

    diar_dir = session_dir / "diarization_chunks"
    diar_dir.mkdir(parents=True, exist_ok=True)

    # ─── Plan ───
    print(f"\n   ✂️  Plan rezanja: cilj {args.target_chunk_s/3600:.2f} h/komad, "
          f"preklapanje {args.overlap_s:.0f} s, rezovi "
          f"{'na nominali' if args.no_silence_cuts else 'u tisini (RMS VAD)'}")
    plan = []
    for p in parts:
        wav = session_dir / p["wav_file"]
        if not wav.is_file():
            sys.exit(f"❌ Nema audija: {wav}")
        chunks, diags = plan_chunks(wav, target_s=args.target_chunk_s,
                                    overlap_s=args.overlap_s,
                                    max_chunk_s=args.max_chunk_s,
                                    silence_cuts=not args.no_silence_cuts)
        print(f"\n   🎧 dio {p['part']}: {wav.name} "
              f"({p['duration_sec']/3600:.2f} h, offset {p['offset_global_sec']:.0f}s) "
              f"→ {len(chunks)} komada")
        for c in chunks:
            tag = f"p{p['part']:02d}_c{c['idx']:02d}"
            oj = diar_dir / f"{tag}.json"
            done = oj.is_file() and not args.force
            mb = (c["read_stop"] - c["read_start"]) * 4 / 2**20
            print(f"      {tag}  {c['start_s']/3600:6.3f}–{c['end_s']/3600:6.3f} h  "
                  f"({c['duration_s']/3600:.2f} h, {mb:.0f} MB){'  ✓ vec obradeno' if done else ''}")
            if args.only_chunk is not None and c["idx"] != args.only_chunk:
                continue
            plan.append({"part": p, "wav": wav, "chunk": c, "tag": tag,
                         "json": oj, "npy": diar_dir / f"{tag}.centroids.npy",
                         "done": done})
        for d in diags:
            if d.get("found"):
                print(f"      ↳ rez u tisini od {d['silence_dur_s']:.1f}s "
                      f"@ {d['cut_s']/3600:.3f} h (pomak {d['shift_s']:+.0f}s, "
                      f"prag {d['threshold_db']:.0f} dBFS)")
            else:
                print(f"      ↳ ⚠️  rez ostao na nominali: {d.get('reason')}")

    todo = [x for x in plan if not x["done"]]
    print(f"\n   📊 ukupno {len(plan)} komada, za obradu {len(todo)}")

    # ─── Predpolet ───
    guard = mg.MachineGuard(min_free_disk_gb=args.min_free_disk_gb,
                            footprint_cap_gb=args.footprint_cap_gb,
                            swap_growth_gb=args.swap_growth_gb,
                            warn_streak_abort=args.warn_streak_abort,
                            enabled=not args.no_guard)
    tot_sw, used_sw = mg.swap_usage()
    print(f"\n   💾 RAM {mg.total_ram_gb():.0f} GB | slobodno na / "
          f"{mg.free_disk_gb():.1f} GB | swap {used_sw:.1f}/{tot_sw:.1f} GB "
          f"(bazni, Docker VM drzi 14 GiB) | pressure {mg.vm_pressure_level()}")
    ok, msg = guard.preflight()
    if not ok:
        sys.exit(f"\n❌ PREKID PRIJE STARTA: {msg}")
    print(f"   ✅ predpolet: {msg}")

    if args.dry_run:
        print("\n🧪 DRY RUN — nista nije pokrenuto.\n")
        return

    if not todo:
        print("\n   ✅ Svi komadi vec obradeni. Sljedeci korak: 02b_merge_speakers.py\n")
        return

    hf_token = dr.hf_token()

    t_all = time.time()
    for i, item in enumerate(todo, 1):
        c = item["chunk"]
        print(f"\n▶️  [{i}/{len(todo)}] {item['tag']} — {item['wav'].name} "
              f"{c['start_s']/3600:.3f}–{c['end_s']/3600:.3f} h")
        res = dr.run_guarded_chunk(item["wav"], c, hf_token, args.device,
                                   args.min_speakers, args.max_speakers,
                                   item["json"], item["npy"], guard,
                                   args.check_interval, args.progress_interval,
                                   args.mps_fraction)
        if res["status"] != "ok":
            print(f"\n❌ {res['status'].upper()}: {res.get('reason')}")
            if res.get("traceback"):
                print(res["traceback"])
            print(f"   vrhovi: footprint {res.get('peak_footprint_gb')} GB | "
                  f"min disk {res.get('min_free_disk_gb')} GB | "
                  f"swap-rast {res.get('max_swap_growth_gb')} GB")
            print(f"\n   💡 Obradeni komadi su sacuvani — ponovno pokretanje "
                  f"nastavlja od {item['tag']}.")
            sys.exit(3 if res["status"] == "aborted" else 1)
        print(f"   ✅ {res['n_segments']} segmenata, {res['n_speakers']} lokalnih govornika "
              f"za {res['elapsed']/60:.1f} min "
              f"({c['duration_s']/res['elapsed']:.1f}× realtime) | "
              f"centroidi: {'da' if res['centroids'] else '⚠️ NEMA'} | "
              f"peak footprint {res['peak_footprint_gb']} GB")

    print(f"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"   ✅ FAZA 02a gotova — {len(todo)} komada za "
          f"{(time.time()-t_all)/60:.1f} min")
    print(f"   📁 {diar_dir.relative_to(REPO_ROOT) if diar_dir.is_relative_to(REPO_ROOT) else diar_dir}")
    print(f"   ⚠️  Oznake govornika su LOKALNE po komadu — jos NISU globalne.")
    print(f"   ➡️  Sljedece: python3 sabor_pipeline/02b_merge_speakers.py "
          f"--session {args.session}")
    print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")


if __name__ == "__main__":
    main()
