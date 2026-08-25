#!/usr/bin/env python3
"""
02b_merge_speakers.py — FAZA 02b: globalno spajanje govornika preko centroida.

Provodi tocke 3-5 iz `docs/pipeline_memorija_i_propusnost_2026-08.md` §6.8.
Ulaz je `diarization_chunks/` iz `02_diarize.py`; izlaz je konacan
`diarization.json` s globalno konzistentnim oznakama `SPEAKER_001...`.

═══ CENTROIDI SU BESPLATNI — DRUGI PROLAZ NE TREBA ═══

Izvorna specifikacija (`02_global_diarization.md`, korak 2) trazi drugi prolaz s
`pyannote/embedding` da bi se dobili glasovni otisci lokalnih govornika. **Taj
korak otpada.** pyannote 4 vraca `DiarizeOutput.speaker_embeddings` — matricu
`(num_speakers, 256)` **poravnatu s `speaker_diarization.labels()`**
(`speaker_diarization.py:745-780`). To su tezinske sredine embeddinga kojima je
pyannote i sam klasterirao, iz istog WeSpeaker modela, pa se i skale pragova
poklapaju.

Jedna zamka iz izvornog koda: ako je govornika u anotaciji vise nego centroida,
pyannote matricu **nadopuni nulama**. Takvi redovi se ne smiju normalizirati
(0/0 = NaN) ni spajati — dobivaju vlastitu globalnu oznaku.

Druga: centroidi su sredine **nenormaliziranih** vektora → L2-normalizirati
prije usporedbe.

═══ CANNOT-LINK NIJE UKRAS ═══

Dva centroida iz ISTOG komada su po konstrukciji razlicite osobe — pyannote ih
je unutar tog komada vec razdvojio. Bez tog ogranicenja obicni AHC ih zna
spojiti (dva centroida iste osobe iz susjednih komada povuku i trecega), pa
`scipy.linkage` + `fcluster` nisu dovoljni: constraint se ne moze izraziti u
condensed matrici. Zato je ovdje vlastito ogranicено average-linkage spajanje
(~60 redaka) — semantika je identicna `linkage(method='average',
metric='cosine')`, samo se zabranjeni parovi maskiraju.

Za ~450 centroida to je trivijalno: `pdist` je 0.8 MB, cijelo spajanje traje
manje od sekunde.

═══ PRAG SE MJERI, NE PREPISUJE ═══

Objavljene vrijednosti (3.1: cosine 0.7046; community-1: euclidean 0.6 ⇒ cosine
0.18) vrijede za POJEDINACNE 10-sekundne embeddinge. Nasi centroidi su sredine
preko minuta govora i znatno su cisci → prag je bitno nizi, ocekivano 0.3-0.5.
Vrijednost 0.68 iz izvorne specifikacije NIJE upotrebljiva.

Prag daj s `--threshold`, ili ga izmjeri s
`sabor_pipeline/tools/calibrate_threshold.py` (postupak iz §6.7) — tada se
`merge_threshold.json` procita automatski.

Skripta uvijek ispise i **pretragu po pragu** (koliko govornika i koliko
slaganja u preklapanjima daje koja vrijednost), pa se izbor vidi u brojkama.

Primjeri:
  python3 sabor_pipeline/02b_merge_speakers.py --session sabor_11_izvanredna_11_gospic --sweep-only
  python3 sabor_pipeline/02b_merge_speakers.py --session ... --threshold 0.42
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_DIR = REPO_ROOT / "storage" / "output" / "sabor"

MERGE_GAP_S = 0.7      # susjedni segmenti istog govornika blizi od ovoga se spajaju
MIN_SEGMENT_S = 0.3    # kraci od ovoga su sum (kasalj, udarac mikrofona)
GRID_S = 0.1           # rezolucija provjere slaganja u preklapanjima


# ─── Ucitavanje ──────────────────────────────────────────────────────────────

def load_chunks(diar_dir, manifest):
    """[{tag, part, chunk, labels, segments, centroids}] sortirano po globalnom vremenu."""
    offsets = {p["part"]: p["offset_global_sec"] for p in manifest["parts"]}
    items = []
    for jf in sorted(diar_dir.glob("p*_c*.json")):
        d = json.loads(jf.read_text())
        tag = jf.stem
        part = int(tag[1:3])
        npy = diar_dir / f"{tag}.centroids.npy"
        cent = np.load(npy) if npy.is_file() else None
        if cent is None:
            sys.exit(f"❌ {tag}: nema centroida ({npy.name}). "
                     f"Pokreni 02_diarize.py --force za taj komad.")
        if cent.shape[0] != len(d["labels"]):
            sys.exit(f"❌ {tag}: {cent.shape[0]} centroida vs {len(d['labels'])} oznaka "
                     f"— nesuglasje, ne mogu poravnati.")
        items.append({
            "tag": tag, "part": part, "chunk": d["chunk"], "labels": d["labels"],
            "segments": d["segments"], "centroids": cent,
            "offset_global_sec": offsets[part],
            "sr": d["chunk"]["sample_rate"],
        })
    items.sort(key=lambda x: (x["part"], x["chunk"]["idx"]))
    return items


def build_centroid_table(items):
    """(X_normalizirano, meta, degenerate) — jedan redak po lokalnom govorniku.

    `degenerate` su redovi koje je pyannote nadopunio nulama (vise govornika u
    anotaciji nego centroida) — oni ne ulaze u spajanje.
    """
    rows, meta, degen = [], [], []
    for ci, it in enumerate(items):
        for li, lab in enumerate(it["labels"]):
            v = it["centroids"][li].astype(np.float64)
            n = float(np.linalg.norm(v))
            rec = {"chunk_i": ci, "tag": it["tag"], "part": it["part"],
                   "label": lab, "norm": n}
            if n < 1e-6 or not np.isfinite(n):
                degen.append(rec)
            else:
                rows.append(v / n)
                meta.append(rec)
    X = np.vstack(rows) if rows else np.zeros((0, 256))
    return X, meta, degen


# ─── Ograniceno average-linkage spajanje ─────────────────────────────────────

def constrained_average_linkage(X, chunk_of, threshold):
    """Average-linkage AHC nad kosinusnom udaljenoscu, uz cannot-link.

    Semantika je `linkage(method='average', metric='cosine')` + `fcluster(t=threshold,
    criterion='distance')`, uz jednu izmjenu: par klastera koji dijele bilo koji
    komad se NIKAD ne spaja (dva centroida iz istog komada su razlicite osobe).

    Vraca niz oznaka klastera duljine len(X).
    """
    n = X.shape[0]
    if n == 0:
        return np.zeros(0, dtype=int)
    if n == 1:
        return np.zeros(1, dtype=int)

    D = 1.0 - X @ X.T                    # kosinusna udaljenost (X je L2-normaliziran)
    np.clip(D, 0.0, 2.0, out=D)
    np.fill_diagonal(D, 0.0)

    S = D.copy()                         # suma udaljenosti izmedu clanova klastera
    sizes = np.ones(n)
    active = np.ones(n, dtype=bool)
    members = [[i] for i in range(n)]

    # F[i,j] = klasteri i i j dijele barem jedan komad → zabranjeno spajanje.
    ch = np.asarray(chunk_of)
    F = ch[:, None] == ch[None, :]

    while active.sum() > 1:
        sub = np.flatnonzero(active)
        A = S[np.ix_(sub, sub)] / np.outer(sizes[sub], sizes[sub])
        A[F[np.ix_(sub, sub)]] = np.inf
        np.fill_diagonal(A, np.inf)
        k = int(np.argmin(A))
        d = A.flat[k]
        if not np.isfinite(d) or d > threshold:
            break
        a, b = divmod(k, len(sub))
        i, j = int(sub[a]), int(sub[b])

        S[i, :] += S[j, :]
        S[:, i] += S[:, j]
        sizes[i] += sizes[j]
        members[i].extend(members[j])
        F[i, :] |= F[j, :]
        F[:, i] |= F[:, j]
        active[j] = False

    labels = np.empty(n, dtype=int)
    for c, i in enumerate(np.flatnonzero(active)):
        for m in members[i]:
            labels[m] = c
    return labels


# ─── Segmenti: lokalno → globalno, uz razrjesavanje preklapanja ──────────────

def chunk_segments_global(it, name_of):
    """Segmenti jednog komada u globalnim sekundama, obrezani na vlasnistvo.

    Komad k pokriva [cut_k - 45s, cut_{k+1} + 45s], ali POSJEDUJE samo
    [cut_k, cut_{k+1}]. Rez je granica vlasnistva, pa se isti govor iz
    preklapanja nikad ne broji dvaput.
    """
    base = it["chunk"]["read_start"] / it["sr"]        # pomak komada unutar dijela
    off = it["offset_global_sec"]
    o0, o1 = it["chunk"]["own_start_s"], it["chunk"]["own_end_s"]
    out = []
    for s in it["segments"]:
        a = max(base + s["start"], o0)
        b = min(base + s["end"], o1)
        if b - a <= 0.01:
            continue
        out.append({
            "part": it["part"],
            "start_local_sec": round(a, 3),
            "end_local_sec": round(b, 3),
            "start_global_sec": round(a + off, 3),
            "end_global_sec": round(b + off, 3),
            "speaker": name_of[(it["tag"], s["speaker"])],
        })
    return out


def postprocess(segments):
    """Spoji susjedne istog govornika s razmakom < MERGE_GAP_S, odbaci < MIN_SEGMENT_S.

    Redoslijed je bitan: spajanje IDE PRVO, jer rez na granici vlasnistva zna
    ostaviti krnji rep koji bi inace pao pod prag i nestao usred govora.
    """
    segments.sort(key=lambda s: (s["start_global_sec"], s["end_global_sec"]))
    merged = []
    for s in segments:
        if merged:
            p = merged[-1]
            if (p["speaker"] == s["speaker"] and p["part"] == s["part"]
                    and s["start_global_sec"] - p["end_global_sec"] < MERGE_GAP_S):
                if s["end_global_sec"] > p["end_global_sec"]:
                    p["end_global_sec"] = s["end_global_sec"]
                    p["end_local_sec"] = s["end_local_sec"]
                continue
        merged.append(dict(s))
    out = []
    for s in merged:
        d = s["end_global_sec"] - s["start_global_sec"]
        if d < MIN_SEGMENT_S:
            continue
        s["duration_sec"] = round(d, 3)
        out.append(s)
    for i, s in enumerate(out, 1):
        s["segment_id"] = i
    return out


# ─── Validacija: slaganje u preklapanjima ────────────────────────────────────

def overlap_agreement(items, name_of):
    """Postotak vremena u preklapanjima gdje susjedni komadi kazu ISTOG govornika.

    U preklapanju je isti zvuk diariziran dvaput, neovisno. Ako je prag pretijesan,
    ista osoba iz komada k i k+1 dobije razlicite globalne oznake i slaganje pada.
    To je end-to-end mjera kvalitete spajanja, mjerljiva bez ijedne rucne oznake.

    ⚠️ Sama po sebi NIJE dovoljna: prag koji sve spoji u jednog govornika daje
    100 % slaganja. Cita se uvijek ZAJEDNO s brojem globalnih govornika.
    """
    def labeler(it):
        base = it["chunk"]["read_start"] / it["sr"]
        return [(base + s["start"], base + s["end"], name_of[(it["tag"], s["speaker"])])
                for s in it["segments"]]

    total = agree = only_one = 0
    details = []
    by_part = {}
    for it in items:
        by_part.setdefault(it["part"], []).append(it)

    for part, chunks in sorted(by_part.items()):
        chunks.sort(key=lambda x: x["chunk"]["idx"])
        for a, b in zip(chunks, chunks[1:]):
            lo = max(a["chunk"]["start_s"], b["chunk"]["start_s"])
            hi = min(a["chunk"]["end_s"], b["chunk"]["end_s"])
            if hi <= lo:
                continue
            la, lb = labeler(a), labeler(b)
            grid = np.arange(lo, hi, GRID_S)
            ta = _labels_at(la, grid)
            tb = _labels_at(lb, grid)
            both = [(x, y) for x, y in zip(ta, tb) if x and y]
            same = sum(1 for x, y in both if x == y)
            one = sum(1 for x, y in zip(ta, tb) if bool(x) != bool(y))
            total += len(both)
            agree += same
            only_one += one
            details.append({
                "pair": f"{a['tag']}↔{b['tag']}",
                "window_s": round(hi - lo, 1),
                "compared": len(both),
                "agree_pct": round(100.0 * same / len(both), 1) if both else None,
            })
    return {
        "compared_frames": total,
        "agree_frames": agree,
        "agree_pct": round(100.0 * agree / total, 1) if total else None,
        "one_sided_frames": only_one,
        "pairs": details,
    }


def _labels_at(spans, grid):
    out = [None] * len(grid)
    if len(grid) == 0:
        return out
    lo, hi = grid[0], grid[-1]
    for a, b, lab in spans:
        # Preklapanje je ~90 s, a komad ima tisuce segmenata — bez ovog filtra
        # se pretraga po pragu (11 vrijednosti × 2 komada po paru) pretvara u
        # stotine tisuca `searchsorted` poziva ni za sto.
        if b <= lo or a >= hi:
            continue
        i0 = int(np.searchsorted(grid, a, "left"))
        i1 = int(np.searchsorted(grid, b, "right"))
        for i in range(i0, min(i1, len(grid))):
            out[i] = lab
    return out


# ─── Imenovanje ──────────────────────────────────────────────────────────────

def assign_names(meta, degen, cluster_labels):
    """(name_of, n_global) — mapa (tag, lokalna_oznaka) → SPEAKER_NNN.

    Globalne oznake se numeriraju po UKUPNOM trajanju govora silazno, pa je
    SPEAKER_001 najzastupljeniji glas (u saborskoj sjednici tipicno
    predsjedavajuci). To cini izlaz citljivim bez ikakve dodatne obrade.
    Redoslijed se popravlja poslije, kad znamo trajanja; ovdje samo grupiramo.
    """
    groups = {}
    for m, c in zip(meta, cluster_labels):
        groups.setdefault(int(c), []).append(m)
    # degenerirani (nula-centroidi) dobivaju vlastite, nespojive klastere
    nxt = (max(groups) + 1) if groups else 0
    for m in degen:
        groups[nxt] = [m]
        nxt += 1
    return groups


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    ap.add_argument("--threshold", type=float, default=None,
                    help="kosinusna udaljenost za spajanje centroida; bez nje se "
                         "cita merge_threshold.json iz kalibracije")
    ap.add_argument("--sweep-only", action="store_true",
                    help="samo pretraga po pragu, bez pisanja diarization.json")
    ap.add_argument("--sweep", default="0.15,0.20,0.25,0.30,0.35,0.40,0.45,0.50,0.55,0.60,0.70")
    ap.add_argument("--no-sweep", action="store_true")
    args = ap.parse_args()

    session_dir = Path(args.output_dir) / args.session
    manifest = json.loads((session_dir / "session_manifest.json").read_text())
    diar_dir = session_dir / "diarization_chunks"
    if not diar_dir.is_dir():
        sys.exit(f"❌ Nema {diar_dir} — pokreni 02_diarize.py")

    items = load_chunks(diar_dir, manifest)
    if not items:
        sys.exit(f"❌ Nema obradenih komada u {diar_dir}")

    print("\n╔══════════════════════════════════════════════════════╗")
    print("║  🏛️  SABOR — FAZA 02b: GLOBALNO SPAJANJE GOVORNIKA    ║")
    print("╚══════════════════════════════════════════════════════╝\n")
    print(f"   📄 {manifest.get('title') or args.session}")

    print(f"   🧩 {len(items)} komada iz {len({i['part'] for i in items})} dijelova")
    for it in items:
        print(f"      {it['tag']}  {len(it['labels']):3d} lokalnih govornika, "
              f"{len(it['segments']):5d} segmenata")

    X, meta, degen = build_centroid_table(items)
    print(f"\n   🎯 {len(meta)} centroida × {X.shape[1]}D "
          f"(L2-normalizirano){f', {len(degen)} nula-redaka izdvojeno' if degen else ''}")
    if len(items) < 2:
        print("   ⚠️  Samo jedan komad — nema sto spajati.")

    chunk_of = [m["chunk_i"] for m in meta]

    # Kontrolna brojka: koliko su blizu parovi UNUTAR komada (po konstrukciji
    # razlicite osobe). To je donja granica — prag iznad ovoga sigurno lijepi
    # krive identitete.
    if len(meta) > 1:
        D = 1.0 - X @ X.T
        same_chunk = np.asarray(chunk_of)[:, None] == np.asarray(chunk_of)[None, :]
        np.fill_diagonal(same_chunk, False)
        within = D[same_chunk]
        if within.size:
            print(f"   📏 razliciti govornici (isti komad, N={within.size}): "
                  f"min {within.min():.3f} | p1 {np.percentile(within,1):.3f} | "
                  f"p5 {np.percentile(within,5):.3f} | median {np.median(within):.3f}")
            print(f"      ↳ prag iznad ~{np.percentile(within,1):.2f} pocinje lijepiti "
                  f"ljude koje je pyannote unutar komada RAZDVOJIO")

    # ─── Pretraga po pragu ───
    if not args.no_sweep:
        print(f"\n   🔎 Pretraga po pragu (cannot-link ukljucen):")
        print(f"      {'prag':>6} {'globalnih':>10} {'slaganje u preklapanjima':>26}")
        for t in [float(x) for x in args.sweep.split(",")]:
            lab = constrained_average_linkage(X, chunk_of, t)
            groups = assign_names(meta, degen, lab)
            name_of = _name_map(groups)
            ov = overlap_agreement(items, name_of)
            print(f"      {t:6.2f} {len(groups):10d} "
                  f"{(str(ov['agree_pct']) + ' %') if ov['agree_pct'] is not None else '—':>26}")

    thr = args.threshold
    if thr is None:
        calib = session_dir / "merge_threshold.json"
        if calib.is_file():
            thr = json.loads(calib.read_text())["threshold"]
            print(f"\n   📐 prag iz kalibracije ({calib.name}): {thr:.3f}")
    if args.sweep_only:
        print("\n   🧪 SWEEP-ONLY — diarization.json nije pisan.\n")
        return
    if thr is None:
        sys.exit("\n❌ Nema praga. Ili `--threshold X`, ili pokreni "
                 "`sabor_pipeline/tools/calibrate_threshold.py` (§6.7).\n"
                 "   NE prepisivati 0.68 iz specifikacije — ta vrijednost vrijedi za "
                 "pojedinacne embeddinge, ne za centroide.")

    # ─── Konacno spajanje ───
    lab = constrained_average_linkage(X, chunk_of, thr)
    groups = assign_names(meta, degen, lab)
    name_of = _name_map(groups)

    all_segs = []
    for it in items:
        all_segs.extend(chunk_segments_global(it, name_of))
    segs = postprocess(all_segs)

    # Preimenuj po ukupnom trajanju silazno → SPEAKER_001 je najzastupljeniji.
    dur = {}
    for s in segs:
        dur[s["speaker"]] = dur.get(s["speaker"], 0.0) + s["duration_sec"]
    order = sorted(dur, key=lambda k: -dur[k])
    ren = {old: f"SPEAKER_{i:03d}" for i, old in enumerate(order, 1)}
    for s in segs:
        s["speaker"] = ren[s["speaker"]]
    name_of = {k: ren.get(v, v) for k, v in name_of.items()}

    ov = overlap_agreement(items, name_of)
    report = speaker_report(segs, items, name_of)

    out = {
        "session_id": args.session,
        "source": "chunked+centroid-merge",
        "total_duration_sec": manifest["total_duration_sec"],
        "total_speakers_detected": len(dur),
        "globally_consistent": True,
        "merge": {
            "threshold": thr,
            "metric": "cosine",
            "linkage": "average",
            "cannot_link": "centroidi iz istog komada",
            "n_chunks": len(items),
            "n_local_speakers": len(meta) + len(degen),
            "n_degenerate_centroids": len(degen),
            "chunk_target_s": items[0]["chunk"]["own_end_s"] - items[0]["chunk"]["own_start_s"],
        },
        "validation": {"overlap_agreement": ov, "speakers": report},
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "segments": segs,
    }
    out_path = session_dir / "diarization.json"
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")

    print(f"\n   🔗 prag {thr:.3f} → {len(dur)} globalnih govornika "
          f"(iz {len(meta)+len(degen)} lokalnih)")
    print(f"   ✅ slaganje u preklapanjima: {ov['agree_pct']} % "
          f"({ov['agree_frames']}/{ov['compared_frames']} okvira po {GRID_S}s)")
    for p in ov["pairs"]:
        print(f"      {p['pair']}  prozor {p['window_s']:.0f}s  {p['agree_pct']} %")

    print(f"\n   🎙️  Najzastupljeniji glasovi (validacija protokolom — "
          f"predsjedavajuci mora biti JEDAN kroz sve komade):")
    print(f"      {'govornik':<12} {'govori':>9} {'zavoja':>7} {'komada':>7}  raspon")
    for r in report[:10]:
        print(f"      {r['speaker']:<12} {r['total_s']/60:8.1f}m {r['turns']:7d} "
              f"{r['n_chunks']:7d}  {r['first_s']/3600:.2f}–{r['last_s']/3600:.2f} h")

    print(f"\n   📄 {out_path}")
    print(f"   ➡️  Sljedece: faza 03 (ASR + parser protokola)\n")


def _name_map(groups):
    out = {}
    for c, members in groups.items():
        nm = f"G{c:04d}"
        for m in members:
            out[(m["tag"], m["label"])] = nm
    return out


def speaker_report(segs, items, name_of):
    """Po globalnom govorniku: trajanje, broj zavoja, u koliko komada se javlja."""
    chunks_of = {}
    for (tag, _), nm in name_of.items():
        chunks_of.setdefault(nm, set()).add(tag)
    agg = {}
    for s in segs:
        a = agg.setdefault(s["speaker"], {"speaker": s["speaker"], "total_s": 0.0,
                                          "turns": 0, "first_s": s["start_global_sec"],
                                          "last_s": s["end_global_sec"]})
        a["total_s"] += s["duration_sec"]
        a["turns"] += 1
        a["first_s"] = min(a["first_s"], s["start_global_sec"])
        a["last_s"] = max(a["last_s"], s["end_global_sec"])
    for nm, a in agg.items():
        a["n_chunks"] = len(chunks_of.get(nm, ()))
        a["total_s"] = round(a["total_s"], 1)
    return sorted(agg.values(), key=lambda r: -r["total_s"])


if __name__ == "__main__":
    main()
