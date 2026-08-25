#!/usr/bin/env python3
"""
test_merge_speakers.py — provjera ogranicenog AHC-a iz `02b_merge_speakers.py`.

Vlastita implementacija spajanja postoji samo zato sto `scipy.linkage` ne zna za
cannot-link. Sve ostalo mora biti IDENTICNO `linkage(method='average',
metric='cosine')` + `fcluster(criterion='distance')` — inace smo umjesto
ogranicenja uveli i tihu promjenu ponasanja.

Pokretanje:  python3 sabor_pipeline/tools/test_merge_speakers.py
"""

import importlib.util
import sys
from pathlib import Path

import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import pdist

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
spec = importlib.util.spec_from_file_location(
    "merge_speakers", REPO_ROOT / "sabor_pipeline" / "02b_merge_speakers.py")
ms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ms)

FAIL = 0


def check(name, cond, extra=""):
    global FAIL
    print(f"   {'✅' if cond else '❌'} {name}{(' — ' + extra) if extra else ''}")
    if not cond:
        FAIL += 1


def canonical(labels):
    """Oznake klastera u kanonski oblik (redoslijed prvog pojavljivanja)."""
    seen, out = {}, []
    for x in labels:
        if x not in seen:
            seen[x] = len(seen)
        out.append(seen[x])
    return out


def scipy_reference(X, t):
    Z = linkage(pdist(X, metric="cosine"), method="average")
    return canonical(fcluster(Z, t=t, criterion="distance"))


def main():
    rng = np.random.default_rng(20260825)

    print("\n1) bez ogranicenja == scipy average/cosine")
    for trial in range(20):
        n, d = int(rng.integers(4, 40)), 16
        X = rng.normal(size=(n, d))
        X /= np.linalg.norm(X, axis=1, keepdims=True)
        t = float(rng.uniform(0.1, 1.2))
        # svaki centroid iz svog komada → nijedan par nije zabranjen
        mine = canonical(ms.constrained_average_linkage(X, list(range(n)), t))
        theirs = scipy_reference(X, t)
        if mine != theirs:
            check(f"pokusaj {trial} (n={n}, t={t:.2f})", False,
                  f"{len(set(mine))} vs {len(set(theirs))} klastera")
            return
    check("20 nasumicnih pokusaja daje identicnu particiju kao scipy", True)

    print("\n2) cannot-link se postuje")
    # tri gotovo identicna vektora, svi iz ISTOG komada → prag ih ne smije spojiti
    base = rng.normal(size=16)
    base /= np.linalg.norm(base)
    X = np.vstack([base + 0.001 * rng.normal(size=16) for _ in range(3)])
    X /= np.linalg.norm(X, axis=1, keepdims=True)
    lab = ms.constrained_average_linkage(X, [7, 7, 7], 0.9)
    check("tri centroida iz istog komada ostaju razdvojena", len(set(lab)) == 3,
          f"dobiveno {len(set(lab))}")

    lab2 = ms.constrained_average_linkage(X, [7, 8, 9], 0.9)
    check("isti vektori iz razlicitih komada se spoje", len(set(lab2)) == 1,
          f"dobiveno {len(set(lab2))}")

    print("\n3) cannot-link je TRANZITIVAN preko klastera")
    # A0,B0 su ista osoba (spoje se); A1 je iz istog komada kao A0 pa se ne smije
    # prilijepiti na taj klaster, ma koliko bio blizu B0.
    v = rng.normal(size=16); v /= np.linalg.norm(v)
    w = v + 0.002 * rng.normal(size=16); w /= np.linalg.norm(w)
    u = v + 0.003 * rng.normal(size=16); u /= np.linalg.norm(u)
    X = np.vstack([v, w, u])                 # A0, B0, A1
    lab = ms.constrained_average_linkage(X, ["A", "B", "A"], 0.9)
    check("A0 i A1 nisu zavrsili u istom klasteru", lab[0] != lab[2],
          f"oznake {list(lab)}")
    check("A0 i B0 jesu spojeni", lab[0] == lab[1], f"oznake {list(lab)}")

    print("\n4) rubni slucajevi")
    check("prazan ulaz", len(ms.constrained_average_linkage(np.zeros((0, 4)), [], 0.5)) == 0)
    check("jedan centroid", len(set(ms.constrained_average_linkage(
        np.ones((1, 4)) / 2, [0], 0.5))) == 1)
    Xz = rng.normal(size=(6, 8)); Xz /= np.linalg.norm(Xz, axis=1, keepdims=True)
    check("prag 0 ne spaja nista",
          len(set(ms.constrained_average_linkage(Xz, list(range(6)), 0.0))) == 6)

    print("\n5) postprocess: spoji < 0.7s, odbaci < 0.3s")
    segs = [
        {"part": 1, "speaker": "G1", "start_global_sec": 0.0, "end_global_sec": 5.0,
         "start_local_sec": 0.0, "end_local_sec": 5.0},
        {"part": 1, "speaker": "G1", "start_global_sec": 5.4, "end_global_sec": 9.0,
         "start_local_sec": 5.4, "end_local_sec": 9.0},   # razmak 0.4 → spoji
        {"part": 1, "speaker": "G2", "start_global_sec": 9.1, "end_global_sec": 9.3,
         "start_local_sec": 9.1, "end_local_sec": 9.3},   # 0.2 s → odbaci
        {"part": 1, "speaker": "G2", "start_global_sec": 20.0, "end_global_sec": 25.0,
         "start_local_sec": 20.0, "end_local_sec": 25.0},
    ]
    out = ms.postprocess([dict(s) for s in segs])
    check("spajanje + odbacivanje", len(out) == 2, f"dobiveno {len(out)}")
    check("spojeni segment ima puni raspon",
          out[0]["start_global_sec"] == 0.0 and out[0]["end_global_sec"] == 9.0,
          f"{out[0]['start_global_sec']}–{out[0]['end_global_sec']}")
    check("segment_id je 1-based i uzastopan",
          [s["segment_id"] for s in out] == [1, 2])
    check("razmak preko granice dijela se NE spaja",
          len(ms.postprocess([
              {"part": 1, "speaker": "G1", "start_global_sec": 0.0, "end_global_sec": 5.0,
               "start_local_sec": 0.0, "end_local_sec": 5.0},
              {"part": 2, "speaker": "G1", "start_global_sec": 5.1, "end_global_sec": 9.0,
               "start_local_sec": 0.1, "end_local_sec": 4.0}])) == 2)

    print(f"\n{'✅ SVE PROLAZI' if not FAIL else f'❌ {FAIL} PROVJERA PALO'}\n")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
