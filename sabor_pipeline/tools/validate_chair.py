#!/usr/bin/env python3
"""
validate_chair.py — validacija spajanja govornika protokolom predsjedavajuceg.

Provodi tocku 5 iz `docs/pipeline_memorija_i_propusnost_2026-08.md` §6.8, uz
JEDAN ispravak same specifikacije.

═══ ⚠️ ISPRAVAK KRITERIJA IZ §6.8 ═══

§6.8 kaze: „Predsjedavajuci mora ispasti JEDAN govornik kroz svih 20 h — ako
ispadne dva, prag je pretijesan."

**Ta pretpostavka je kriva za Sabor.** Sjednicom naizmjence predsjedaju
predsjednik i potpredsjednici; na pilot-sjednici ih je bilo **troje**. „Tri
predsjedavajuca" zato NIJE dokaz pretijesnog praga.

Ispravan kriterij je stroziji i mjerljiv:

1. **Rotacija, ne rascjep.** Predsjedavajuci moraju **poplocati** vremensku os —
   blok jednoga zavrsava ondje gdje blok drugoga pocinje. Ako se dva
   predsjedavajuca **isprepliecu unutar istog bloka**, to JEST rascjep jedne
   osobe na dvije oznake i prag je pretijesan.
2. **Kontinuitet preko dijelova.** Svaki predsjedavajuci mora biti ISTA oznaka u
   svim dijelovima u kojima je predsjedao — ukljucujuci dijelove snimljene
   drugi dan, u drugom videu. To je zapravo cijela svrha faze 02b.

Predsjedavajuci se prepoznaje bez ijedne rucne oznake: po **gustoci protokolarnih
fraza** („rijec ima", „zahvaljujem, postovani zastupnice", „prelazimo na"...) po
1000 izgovorenih rijeci. Kod predsjedavajuceg je red velicine visa nego kod
zastupnika.

Primjer:
  python3 sabor_pipeline/tools/validate_chair.py --session sabor_11_izvanredna_11_gospic
"""

import argparse
import bisect
import itertools
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_OUTPUT_DIR = REPO_ROOT / "storage" / "output" / "sabor"

# Protokolarne fraze predsjedavajuceg. Namjerno siroko — mjeri se GUSTOCA, pa
# poneki pogodak kod zastupnika ne kvari sliku.
CHAIR_RE = re.compile(
    r"riječ ima|riječ je dobio|zahvaljujem.{0,30}zastupni|poštovani zastupnic|"
    r"otvaram .{0,20}sjednic|zaključujem raspravu|prelazimo na|izvolite|"
    r"molim glasujmo|u ime kluba", re.I)

MIN_DENSITY = 10.0     # fraza na 1000 rijeci — iznad ovoga je predsjedavajuci
BLOCK_GAP_S = 1200.0   # razmak veci od 20 min razdvaja blokove predsjedanja


def parse_srt(path):
    out = []
    text = Path(path).read_text(encoding="utf-8", errors="replace").strip()
    for blk in re.split(r"\n\n+", text):
        lines = blk.strip().split("\n")
        if len(lines) < 3:
            continue
        m = re.match(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)",
                     lines[1])
        if not m:
            continue
        g = [int(x) for x in m.groups()]
        out.append((g[0]*3600 + g[1]*60 + g[2] + g[3]/1000,
                    g[4]*3600 + g[5]*60 + g[6] + g[7]/1000,
                    " ".join(lines[2:])))
    return out


def attribute_text(manifest, diar, session_dir):
    """(fraze_po_govorniku, rijeci_po_govorniku) — ASR tekst pripisan govorniku."""
    bypart = {}
    for s in diar["segments"]:
        bypart.setdefault(s["part"], []).append(s)
    phrases, words = {}, {}
    seen_srt = 0
    for p in manifest["parts"]:
        srt = session_dir / "audio" / (Path(p["wav_file"]).name + ".canary.srt")
        if not srt.is_file():
            continue
        seen_srt += 1
        segs = sorted(bypart.get(p["part"], []), key=lambda x: x["start_local_sec"])
        if not segs:
            continue
        starts = [x["start_local_sec"] for x in segs]
        for a, b, txt in parse_srt(srt):
            i = max(0, bisect.bisect_right(starts, a) - 1)
            best, best_ov = None, 0.0
            for j in range(max(0, i - 2), min(len(segs), i + 3)):
                ov = min(b, segs[j]["end_local_sec"]) - max(a, segs[j]["start_local_sec"])
                if ov > best_ov:
                    best_ov, best = ov, segs[j]
            if best is None:
                continue
            sp = best["speaker"]
            words[sp] = words.get(sp, 0) + len(txt.split())
            if CHAIR_RE.search(txt):
                phrases[sp] = phrases.get(sp, 0) + 1
    return phrases, words, seen_srt


def blocks_of(segs, gap_s=BLOCK_GAP_S):
    segs = sorted(segs, key=lambda s: s["start_global_sec"])
    out, cur = [], [segs[0]]
    for a, b in zip(segs, segs[1:]):
        if b["start_global_sec"] - a["end_global_sec"] > gap_s:
            out.append(cur)
            cur = []
        cur.append(b)
    out.append(cur)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    ap.add_argument("--min-density", type=float, default=MIN_DENSITY)
    ap.add_argument("--min-words", type=int, default=300)
    args = ap.parse_args()

    session_dir = Path(args.output_dir) / args.session
    manifest = json.loads((session_dir / "session_manifest.json").read_text())
    diar_path = session_dir / "diarization.json"
    if not diar_path.is_file():
        sys.exit(f"❌ Nema {diar_path} — pokreni 02b_merge_speakers.py")
    diar = json.loads(diar_path.read_text())

    print("\n╔══════════════════════════════════════════════════════╗")
    print("║  🏛️  VALIDACIJA PROTOKOLOM — PREDSJEDAVAJUĆI          ║")
    print("╚══════════════════════════════════════════════════════╝\n")
    print(f"   📄 {manifest.get('title') or args.session}")
    print(f"   🔗 prag {diar['merge']['threshold']} → "
          f"{diar['total_speakers_detected']} globalnih govornika "
          f"iz {diar['merge']['n_local_speakers']} lokalnih")

    phrases, words, n_srt = attribute_text(manifest, diar, session_dir)
    if not n_srt:
        sys.exit("❌ Nema .canary.srt datoteka — validacija protokolom traži ASR.")

    dens = {sp: 1000.0 * c / words[sp]
            for sp, c in phrases.items()
            if words.get(sp, 0) >= args.min_words}
    chairs = sorted([sp for sp, d in dens.items() if d >= args.min_density],
                    key=lambda sp: -dens[sp])

    print(f"\n   🔎 Gustoća protokolarnih fraza (na 1000 riječi, "
          f"≥{args.min_words} riječi):")
    for sp in sorted(dens, key=lambda s: -dens[s])[:8]:
        mark = "  ← PREDSJEDAVAJUĆI" if sp in chairs else ""
        print(f"      {sp:<14} {dens[sp]:6.1f}  "
              f"({phrases[sp]} fraza / {words[sp]} riječi){mark}")

    if not chairs:
        sys.exit("\n❌ Nijedan govornik nema gustoću predsjedavajućeg — "
                 "provjeri poklapanje ASR-a i diarizacije.")

    print(f"\n   👔 Pronađeno predsjedavajućih: {len(chairs)} "
          f"(rotacija je NORMALNA — predsjednik + potpredsjednici)")

    segs_of = {sp: [s for s in diar["segments"] if s["speaker"] == sp] for sp in chairs}
    all_blocks = []
    for sp in chairs:
        bl = blocks_of(segs_of[sp])
        parts = sorted({s["part"] for s in segs_of[sp]})
        tot = sum(s["duration_sec"] for s in segs_of[sp])
        print(f"\n      {sp}: {tot/60:.0f} min, {len(segs_of[sp])} zavoja, "
              f"dijelovi {parts}, {len(bl)} blokova")
        for b in bl:
            print(f"         {b[0]['start_global_sec']/3600:6.2f}–"
                  f"{b[-1]['end_global_sec']/3600:6.2f} h  "
                  f"({sum(x['duration_sec'] for x in b)/60:5.1f} min, dio {b[0]['part']})")
            all_blocks.append((b[0]["start_global_sec"], b[-1]["end_global_sec"], sp))

    # ─── Kriterij 1: rotacija, ne rascjep ───
    all_blocks.sort()
    overlaps = []
    for (a0, a1, sa), (b0, b1, sb) in itertools.combinations(all_blocks, 2):
        ov = min(a1, b1) - max(a0, b0)
        if ov > 0:
            overlaps.append((sa, sb, ov))
    print(f"\n   ── Kriterij 1: blokovi se ne smiju preklapati (rotacija, ne rascjep)")
    if overlaps:
        print(f"      ⚠️  {len(overlaps)} preklapanja blokova:")
        for sa, sb, ov in overlaps[:5]:
            print(f"         {sa} ↔ {sb}: {ov/60:.1f} min")
        print(f"      → Dva 'predsjedavajuća' u istom bloku znače da je JEDNA osoba "
              f"rascijepljena.\n        Prag {diar['merge']['threshold']} je pretijesan — podigni ga.")
    else:
        print(f"      ✅ nijedan blok se ne preklapa — čista rotacija")
        handovers = [(all_blocks[i][1], all_blocks[i+1][0],
                      all_blocks[i][2], all_blocks[i+1][2])
                     for i in range(len(all_blocks)-1)
                     if all_blocks[i][2] != all_blocks[i+1][2]]
        print(f"      ✅ {len(handovers)} primopredaja:")
        for end, start, sa, sb in handovers:
            print(f"         {end/3600:6.2f} h {sa} → {start/3600:6.2f} h {sb}  "
                  f"(prekid {(start-end)/60:.1f} min)")

    # ─── Kriterij 2: kontinuitet preko dijelova ───
    print(f"\n   ── Kriterij 2: isti predsjedavajući preko granica dijelova/videa")
    multi = [sp for sp in chairs if len({s["part"] for s in segs_of[sp]}) > 1]
    if multi:
        for sp in multi:
            ps = sorted({s["part"] for s in segs_of[sp]})
            print(f"      ✅ {sp} je JEDNA oznaka u dijelovima {ps} "
                  f"(različiti videi{', različiti dani' if 4 in ps and 1 in ps else ''})")
    else:
        print(f"      ⚠️  nijedan predsjedavajući ne prelazi granicu dijela — "
              f"spajanje preko videa nije dokazano")

    ok = not overlaps and bool(multi)
    print(f"\n   {'✅ VALIDACIJA PROŠLA' if ok else '❌ VALIDACIJA PALA'}\n")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
