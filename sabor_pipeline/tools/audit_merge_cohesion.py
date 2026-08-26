#!/usr/bin/env python3
"""
audit_merge_cohesion.py — koliko je globalnih oznaka PRESPOJENO.

Slijepa provjera modelom (§9.2) nasla je jednu oznaku pod kojom govore dvije
osobe — ali samo slucajno, jer je ta oznaka pala u dva prozora pa je model za
nju dao dva imena. Ovaj alat trazi isto sustavno, bez modela.

Postupak: faza 02b spaja lokalne centroide prosjecnim povezivanjem (average
linkage). Ono spaja i klastere ciji su NAJUDALJENIJI clanovi daleko iznad
praga, dokle god je prosjek ispod njega — tzv. lancano spajanje:

    A ─0.20─ B ─0.20─ C          prosjek A-C moze ostati ispod praga
    └────── 0.45 ──────┘         iako su A i C ocito razlicite osobe

Zato se za svaku globalnu oznaku mjeri PROMJER: najveca kosinusna udaljenost
izmedu bilo koja dva njezina lokalna centroida. Promjer znatno iznad praga
znaci da oznaka drzi glasove koji si medusobno nisu slicni.

⚠️ Promjer iznad praga NIJE dokaz greske. Ista osoba zvuci razlicito kad vice
i kad cita; §8.6 memorijskog dokumenta mjeri SAME populaciju do 0.077, ali to
je nad jednim komadom. Alat proizvodi RANG-LISTU za pregled, ne presudu.

    python3 sabor_pipeline/tools/audit_merge_cohesion.py --session <id>
"""

import argparse
import bisect
import json
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def cosine_matrix(x):
    n = x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-12)
    return 1.0 - n @ n.T


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--output-dir", default=str(REPO_ROOT / "storage" / "output" / "sabor"))
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--cross", action="append", default=[], metavar="A,B",
                    help="izmjeri udaljenost IZMEDU dvije globalne oznake "
                         "(ponovljivo); za provjeru ljudske tvrdnje da su "
                         "dvije oznake ista osoba")
    ap.add_argument("--cross-json", default=None,
                    help="zapisi rezultate --cross u JSON umjesto samo na stdout")
    a = ap.parse_args()

    d = Path(a.output_dir) / a.session
    diar = json.loads((d / "diarization.json").read_text(encoding="utf-8"))
    threshold = float(diar["merge"]["threshold"])

    # Indeks globalnih segmenata po dijelu, za brzo trazenje po vremenu.
    by_part = {}
    for s in diar["segments"]:
        by_part.setdefault(s["part"], []).append(s)
    for v in by_part.values():
        v.sort(key=lambda s: s["start_local_sec"])
    starts = {p: [s["start_local_sec"] for s in v] for p, v in by_part.items()}

    def global_label(part, t0, t1):
        """Globalna oznaka s najvecim preklapanjem u [t0, t1] danog dijela."""
        segs = by_part.get(part, [])
        if not segs:
            return None
        i = max(0, bisect.bisect_right(starts[part], t0) - 1)
        best, best_ov = None, 0.0
        for j in range(max(0, i - 3), min(len(segs), i + 4)):
            ov = min(t1, segs[j]["end_local_sec"]) - max(t0, segs[j]["start_local_sec"])
            if ov > best_ov:
                best_ov, best = ov, segs[j]["speaker"]
        return best

    # local (chunk, label) → global, i pripadni centroid
    members = {}   # global → list[(tag, vector)]
    for jf in sorted((d / "diarization_chunks").glob("*.json")):
        ch = json.loads(jf.read_text(encoding="utf-8"))
        vecs = np.load(jf.parent / (jf.stem + ".centroids.npy"))
        # Dio NIJE u `chunk` dictu nego u imenu datoteke: `p01_c00` → dio 1.
        part = int(jf.stem.split("_")[0][1:])
        for idx, lab in enumerate(ch["labels"]):
            segs = [s for s in ch["segments"] if s.get("speaker") == lab]
            if not segs:
                continue
            # Vlasnistvo: uzmi najduzi segment te lokalne oznake kao uzorak.
            segs.sort(key=lambda s: s["end"] - s["start"], reverse=True)
            # Vremena segmenata su relativna na KOMAD (krecu od 0), a
            # `diarization.json` ih drzi relativno na DIO — otuda `start_s`.
            off = float(ch["chunk"]["start_s"])
            t0 = segs[0]["start"] + off
            t1 = segs[0]["end"] + off
            g = global_label(part, t0, t1)
            if g is None:
                continue
            members.setdefault(g, []).append((f"{jf.stem}:{lab}", vecs[idx]))

    rows = []
    for g, lst in members.items():
        if len(lst) < 2:
            continue
        m = cosine_matrix(np.stack([v for _, v in lst]))
        iu = np.triu_indices(len(lst), 1)
        rows.append({
            "speaker": g,
            "n_local": len(lst),
            "promjer": float(m[iu].max()),
            "medijan": float(np.median(m[iu])),
            "tagovi": [t for t, _ in lst],
        })

    # ── --cross: udaljenost IZMEDU dvije oznake ────────────────────────────
    #
    # Promjer odgovara na „drzi li JEDNA oznaka dva glasa". Ljudski sloj
    # postavlja obrnuto pitanje: kad covjek tvrdi da su DVIJE oznake ista
    # osoba, jesu li im centroidi doista blizu? Bez toga bi ta tvrdnja bila
    # jedina u pipelineu koja se nikad ne mjeri.
    cross_out = []
    for spec in a.cross:
        parts = [x.strip() for x in spec.split(",") if x.strip()]
        if len(parts) != 2:
            print(f"⚠ --cross ocekuje 'A,B', dobiveno: {spec!r}")
            continue
        g1, g2 = parts
        m1, m2 = members.get(g1, []), members.get(g2, [])
        if not m1 or not m2:
            missing = [g for g, m in ((g1, m1), (g2, m2)) if not m]
            print(f"⚠ nema centroida za: {', '.join(missing)}")
            cross_out.append({"a": g1, "b": g2, "greska": "nema centroida"})
            continue
        x1 = np.stack([v for _, v in m1])
        x2 = np.stack([v for _, v in m2])
        n1 = x1 / (np.linalg.norm(x1, axis=1, keepdims=True) + 1e-12)
        n2 = x2 / (np.linalg.norm(x2, axis=1, keepdims=True) + 1e-12)
        d = 1.0 - n1 @ n2.T
        # `min` je najblagonakloniji prema tvrdnji: ako je i on iznad praga,
        # nijedan par centroida dviju oznaka nije dovoljno blizu.
        row = {
            "a": g1, "b": g2,
            "n_a": len(m1), "n_b": len(m2),
            "min": float(d.min()), "medijan": float(np.median(d)), "max": float(d.max()),
            "prag": threshold,
            "ista_osoba_vjerojatna": bool(d.min() <= threshold),
        }
        cross_out.append(row)
        verdikt = "BLIZU (tvrdnja se drzi)" if row["ista_osoba_vjerojatna"] else "DALEKO (tvrdnja pada)"
        print(f"{g1} ↔ {g2}   min {row['min']:.3f}  medijan {row['medijan']:.3f}  "
              f"max {row['max']:.3f}  prag {threshold:.3f}  →  {verdikt}")
    if cross_out and a.cross_json:
        Path(a.cross_json).write_text(
            json.dumps({"threshold": threshold, "parovi": cross_out}, ensure_ascii=False, indent=1) + "\n",
            encoding="utf-8")
        print(f"Zapisano: {a.cross_json}")
    if a.cross:
        # --cross je zasebno pitanje; rang-lista promjera se ne ispisuje niti
        # se `merge_cohesion.json` prepisuje usput.
        return

    rows.sort(key=lambda r: r["promjer"], reverse=True)
    sumnjivih = [r for r in rows if r["promjer"] > threshold * 2]

    print(f"Prag spajanja: {threshold:.4f}")
    print(f"Globalnih oznaka s >1 lokalnim centroidom: {len(rows)} / {diar['total_speakers_detected']}")
    print(f"Oznaka s promjerom > 2× prag: {len(sumnjivih)}\n")
    print(f"{'oznaka':<14}{'lok.':>5}{'promjer':>9}{'medijan':>9}  sastav")
    for r in rows[:a.top]:
        flag = "  ⚠" if r["promjer"] > threshold * 2 else ""
        print(f"{r['speaker']:<14}{r['n_local']:>5}{r['promjer']:>9.3f}{r['medijan']:>9.3f}  "
              f"{', '.join(r['tagovi'][:4])}{flag}")

    out = d / "merge_cohesion.json"
    out.write_text(json.dumps({
        "threshold": threshold,
        "n_multi": len(rows),
        "n_suspicious": len(sumnjivih),
        "rows": rows,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\nZapisano: {out}")
    print("⚠ Promjer iznad praga nije dokaz greske — ista osoba zvuci razlicito")
    print("  kad vice i kad cita. Ovo je rang-lista za pregled, ne presuda.")


if __name__ == "__main__":
    main()
