#!/usr/bin/env python3
"""
calibrate_threshold.py — IZMJERI prag za spajanje centroida (§6.7).

Prag se NE prepisuje iz specifikacije. Objavljene vrijednosti
(`speaker-diarization-3.1`: cosine 0.7046; `community-1`: euclidean 0.6 ⇒ cosine
0.18; DiariZen: 0.6) vrijede za **pojedinacne 10-sekundne embeddinge**. Nasi
centroidi su tezinske sredine preko MINUTA govora i znatno su cisci, pa je
ispravan prag drugdje — ocekivano 0.3-0.5. Vrijednost **0.68 iz
`02_global_diarization.md` nije upotrebljiva**.

Dodatna zamka: AHC prag u VBx pipelineima namjerno POD-klasterira, da bi VBx
poslije imao slobodu spajanja. Mi nemamo VBx, pa nam treba vrijednost koja
razdvaja izravno.

═══ POSTUPAK (§6.7) — same/different parovi bez ijedne rucne oznake ═══

    1. referenca:  cijeli part_04 diariziran u jednom komadu  →  tko je tko
    2. polovice:   isti dio prepolovljen na A i B, svaka diarizirana ZASEBNO
    3. mapiranje:  svaki A-govornik i B-govornik se preslika na referentnog
                   (po najvecem vremenskom preklapanju)
    4. parovi:     ref(A_i) == ref(B_j)  →  SAME     (ista osoba, RAZLICIT zvuk)
                   ref(A_i) != ref(B_j)  →  DIFFERENT
    5. prag:       sredina praznine izmedu dviju populacija (i EER kao kontrola)

Kljucno je da su A i B **disjunktni** — nema preklapanja. Da ga ima, „isti
govornik" bi dijelom bio doslovno isti zvuk, pa bi SAME udaljenosti ispale
lazno male i prag bi bio pretijesan. Zato ovdje, za razliku od proizvodnog
prolaza, preklapanja NEMA.

Referenca se ne diarizira ponovno — uzima se `p04_c00` koji je proizvodni
prolaz ionako napravio. Kalibracija zato kosta dvije diarizacije od ~1 h.

Primjer:
  python3 sabor_pipeline/tools/calibrate_threshold.py --session sabor_11_izvanredna_11_gospic
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "sabor_pipeline"))

from utils import machine_guard as mg              # noqa: E402
from utils import diar_runner as dr                # noqa: E402
from utils.audio_chunker import wav_info           # noqa: E402

DEFAULT_OUTPUT_DIR = REPO_ROOT / "storage" / "output" / "sabor"
MIN_SPEECH_S = 20.0   # govornik s manje govora daje sumovit centroid


def overlap_map(half_segments, ref_segments, base_offset):
    """{lokalna_oznaka_polovice: (ref_oznaka, preklapanje_s, ukupno_s)}.

    Svaki govornik polovice se preslika na referentnog s kojim dijeli najvise
    vremena. `base_offset` prevodi sekunde polovice u sekunde cijelog dijela.
    """
    acc = {}
    for s in half_segments:
        a, b = s["start"] + base_offset, s["end"] + base_offset
        tot = acc.setdefault(s["speaker"], {"total": 0.0, "by_ref": {}})
        tot["total"] += b - a
        for r in ref_segments:
            lo, hi = max(a, r["start"]), min(b, r["end"])
            if hi > lo:
                tot["by_ref"][r["speaker"]] = tot["by_ref"].get(r["speaker"], 0.0) + (hi - lo)
    out = {}
    for lab, v in acc.items():
        if not v["by_ref"]:
            continue
        ref = max(v["by_ref"], key=v["by_ref"].get)
        out[lab] = (ref, v["by_ref"][ref], v["total"])
    return out


def eer_threshold(same, diff):
    """Prag na kojem se izjednace promasaji obiju populacija (EER)."""
    cand = np.unique(np.concatenate([same, diff]))
    best, best_gap = None, 1e9
    for t in cand:
        fnr = float(np.mean(same > t))     # ista osoba, a ne bi se spojila
        fpr = float(np.mean(diff <= t))    # razlicite osobe, a spojile bi se
        if abs(fnr - fpr) < best_gap:
            best_gap, best = abs(fnr - fpr), (float(t), fnr, fpr)
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    ap.add_argument("--part", type=int, default=4,
                    help="dio na kojem se kalibrira (4 je najjeftiniji, 1h56m)")
    ap.add_argument("--reference-tag", default=None,
                    help="komad koji sluzi kao referenca (default p{part}_c00)")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--min-speech-s", type=float, default=MIN_SPEECH_S)
    ap.add_argument("--min-free-disk-gb", type=float, default=7.0)
    ap.add_argument("--footprint-cap-gb", type=float, default=14.0)
    ap.add_argument("--swap-growth-gb", type=float, default=3.0)
    ap.add_argument("--check-interval", type=int, default=20)
    ap.add_argument("--progress-interval", type=int, default=60)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    session_dir = Path(args.output_dir) / args.session
    manifest = json.loads((session_dir / "session_manifest.json").read_text())
    diar_dir = session_dir / "diarization_chunks"
    calib_dir = session_dir / "calibration"
    calib_dir.mkdir(parents=True, exist_ok=True)

    part = next((p for p in manifest["parts"] if p["part"] == args.part), None)
    if part is None:
        sys.exit(f"❌ Nema dijela {args.part}")
    wav = session_dir / part["wav_file"]
    total_frames, sr, dur = wav_info(wav)

    ref_tag = args.reference_tag or f"p{args.part:02d}_c00"
    ref_json = diar_dir / f"{ref_tag}.json"
    if not ref_json.is_file():
        sys.exit(f"❌ Nema reference {ref_json}.\n"
                 f"   Pokreni prvo: python3 sabor_pipeline/02_diarize.py "
                 f"--session {args.session} --only-part {args.part}")
    ref = json.loads(ref_json.read_text())
    ref_base = ref["chunk"]["read_start"] / sr
    ref_segments = [{"start": s["start"] + ref_base, "end": s["end"] + ref_base,
                     "speaker": s["speaker"]} for s in ref["segments"]]

    print("\n╔══════════════════════════════════════════════════════╗")
    print("║  📐 KALIBRACIJA PRAGA ZA SPAJANJE CENTROIDA (§6.7)   ║")
    print("╚══════════════════════════════════════════════════════╝\n")
    print(f"   📄 {manifest.get('title') or args.session}")
    print(f"   🎧 dio {args.part}: {wav.name} ({dur/3600:.2f} h)")
    print(f"   📌 referenca: {ref_tag} — {ref['n_speakers_local']} govornika, "
          f"{len(ref['segments'])} segmenata")

    mid = total_frames // 2
    halves = [
        {"name": "A", "read_start": 0, "read_stop": mid},
        {"name": "B", "read_start": mid, "read_stop": total_frames},
    ]
    for h in halves:
        h["duration_s"] = (h["read_stop"] - h["read_start"]) / sr
        h["sample_rate"] = sr
        h["idx"] = 0
        print(f"   ✂️  polovica {h['name']}: {h['read_start']/sr/3600:.3f}–"
              f"{h['read_stop']/sr/3600:.3f} h ({h['duration_s']/3600:.2f} h) "
              f"— disjunktne, BEZ preklapanja (inace bi SAME parovi bili lazno mali)")

    guard = mg.MachineGuard(min_free_disk_gb=args.min_free_disk_gb,
                            footprint_cap_gb=args.footprint_cap_gb,
                            swap_growth_gb=args.swap_growth_gb)
    ok, msg = guard.preflight()
    if not ok:
        sys.exit(f"\n❌ PREKID PRIJE STARTA: {msg}")
    print(f"   ✅ predpolet: {msg}")

    if args.dry_run:
        print("\n🧪 DRY RUN — nista nije pokrenuto.\n")
        return

    token = dr.hf_token()
    for h in halves:
        oj = calib_dir / f"half_{h['name']}.json"
        on = calib_dir / f"half_{h['name']}.centroids.npy"
        if oj.is_file() and not args.force:
            print(f"\n   ✓ polovica {h['name']} vec obradena")
            continue
        print(f"\n▶️  Diariziram polovicu {h['name']}")
        res = dr.run_guarded_chunk(wav, h, token, args.device, None, None, oj, on,
                                   guard, args.check_interval, args.progress_interval)
        if res["status"] != "ok":
            print(f"\n❌ {res['status'].upper()}: {res.get('reason')}")
            if res.get("traceback"):
                print(res["traceback"])
            sys.exit(3 if res["status"] == "aborted" else 1)
        print(f"   ✅ {res['n_speakers']} govornika, {res['n_segments']} segmenata "
              f"za {res['elapsed']/60:.1f} min")

    # ─── Mapiranje na referencu ───
    data = {}
    for h in halves:
        d = json.loads((calib_dir / f"half_{h['name']}.json").read_text())
        cent = np.load(calib_dir / f"half_{h['name']}.centroids.npy").astype(np.float64)
        base = h["read_start"] / sr
        m = overlap_map(d["segments"], ref_segments, base)
        data[h["name"]] = {"labels": d["labels"], "centroids": cent, "map": m}
        print(f"\n   🔗 polovica {h['name']}: {len(m)}/{len(d['labels'])} govornika "
              f"preslikano na referencu")

    # ─── Parovi ───
    same, diff, rows = [], [], []
    for la, ia in [(l, i) for i, l in enumerate(data["A"]["labels"])]:
        ma = data["A"]["map"].get(la)
        if not ma or ma[2] < args.min_speech_s:
            continue
        va = data["A"]["centroids"][ia]
        na = np.linalg.norm(va)
        if na < 1e-6:
            continue
        va = va / na
        for lb, ib in [(l, i) for i, l in enumerate(data["B"]["labels"])]:
            mb = data["B"]["map"].get(lb)
            if not mb or mb[2] < args.min_speech_s:
                continue
            vb = data["B"]["centroids"][ib]
            nb = np.linalg.norm(vb)
            if nb < 1e-6:
                continue
            d = float(1.0 - np.dot(va, vb / nb))
            is_same = ma[0] == mb[0]
            (same if is_same else diff).append(d)
            rows.append({"A": la, "B": lb, "ref_A": ma[0], "ref_B": mb[0],
                         "same": is_same, "cosine_distance": round(d, 4),
                         "speech_A_s": round(ma[2], 1), "speech_B_s": round(mb[2], 1)})

    same, diff = np.asarray(same), np.asarray(diff)
    print(f"\n   📊 parova: SAME {len(same)} | DIFFERENT {len(diff)} "
          f"(govornici s < {args.min_speech_s:.0f}s govora izbaceni)")
    if len(same) < 3:
        sys.exit("\n❌ Premalo SAME parova — nijedan govornik se ne javlja u obje "
                 "polovice s dovoljno govora. Probaj drugi dio (--part) ili nizi "
                 "--min-speech-s.")

    def stat(x, nm):
        print(f"      {nm:<10} n={len(x):4d}  min {x.min():.3f}  p5 {np.percentile(x,5):.3f}  "
              f"median {np.median(x):.3f}  p95 {np.percentile(x,95):.3f}  max {x.max():.3f}")
    stat(same, "SAME")
    stat(diff, "DIFFERENT")

    gap_lo, gap_hi = float(same.max()), float(diff.min())
    separated = gap_hi > gap_lo
    eer = eer_threshold(same, diff)
    if separated:
        thr = (gap_lo + gap_hi) / 2.0
        rule = "sredina praznine (populacije se ne preklapaju)"
    else:
        thr = eer[0]
        rule = "EER (populacije se preklapaju — praznine nema)"

    print(f"\n   🎯 SAME.max = {gap_lo:.3f} | DIFFERENT.min = {gap_hi:.3f} → "
          f"{'PRAZNINA ' + format(gap_hi-gap_lo, '.3f') if separated else 'PREKLAPANJE'}")
    print(f"   🎯 EER prag {eer[0]:.3f} (FNR {eer[1]*100:.1f}% / FPR {eer[2]*100:.1f}%)")
    print(f"\n   ✅ PRAG = {thr:.3f}  — {rule}")
    if not 0.2 <= thr <= 0.6:
        print(f"   ⚠️  Izvan ocekivanog raspona 0.3-0.5 (§6.6) — provjeri parove "
              f"u pairs.json prije koristenja.")

    out = {
        "session_id": args.session,
        "threshold": round(thr, 4),
        "rule": rule,
        "metric": "cosine",
        "procedure": "§6.7 — referenca + dvije disjunktne polovice",
        "part": args.part,
        "reference_tag": ref_tag,
        "min_speech_s": args.min_speech_s,
        "same": {"n": len(same), "min": round(float(same.min()), 4),
                 "median": round(float(np.median(same)), 4),
                 "max": round(gap_lo, 4)},
        "different": {"n": len(diff), "min": round(gap_hi, 4),
                      "median": round(float(np.median(diff)), 4),
                      "max": round(float(diff.max()), 4)},
        "separated": bool(separated),
        "gap": round(gap_hi - gap_lo, 4),
        "eer": {"threshold": round(eer[0], 4), "fnr": round(eer[1], 4),
                "fpr": round(eer[2], 4)},
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    (session_dir / "merge_threshold.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2) + "\n")
    (calib_dir / "pairs.json").write_text(
        json.dumps(sorted(rows, key=lambda r: r["cosine_distance"]),
                   ensure_ascii=False, indent=2) + "\n")

    print(f"\n   📄 {session_dir / 'merge_threshold.json'}")
    print(f"   📄 {calib_dir / 'pairs.json'}  (svi parovi, sortirani po udaljenosti)")
    print(f"   ➡️  02b_merge_speakers.py sad cita prag sam.\n")


if __name__ == "__main__":
    main()
