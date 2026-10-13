#!/usr/bin/env python3
"""
Faza 3a: mjerenje ASR-a i diarizacije nad izlazom faze 1 (nula API poziva).

Referenca = Speechmatics Enhanced. NIJE istina (README §Ograde): servis koji griješi
drukčije od Speechmaticsa izgleda lošije nego što jest. Prava referenca su tek ručno
ispravljeni isječci.

Mjeri po epizodi i alatu:
  wer            — globalno poravnanje cijelog teksta (rapidfuzz, bez prozora), normalizirano:
                   mala slova, bez interpunkcije; dijakritika ostaje. S/D/I odvojeno.
  ispusteno_s    — sekunde u 60-s prozorima gdje referenca ima ≥30 riječi, a alat < 30 % toga
                   (tiho ispušten sadržaj — ono što TRANSCRIPT_GAP lovi, ali relativno prema referenci)
  gap_ratio      — pravilo TRANSCRIPT_GAP iz inspect_pipeline.js nad SRT-om alata
                   (rupe > 10 s između cue-ova + rep; warn > 5 %, error > 15 %)
  pomak_ms       — medijan |početak riječi − početak iste riječi u referenci| (poravnate jednake riječi)
  govornika, der — broj govornika i DER prema Speechmaticsovim okretima (collar 0.25 s, bez overlapa)

Izlaz: results/asr_metrics.json + results/asr_metrics.md
"""
import glob
import json
import os
import re
import statistics
import sys

from rapidfuzz.distance import Levenshtein

EXP = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(EXP, "data/output")
RES = os.path.join(EXP, "results")
TAG = "exp-20261011"
REF = "speechmatics-enhanced"
ASR = ["deepgram-nova3", "assemblyai-universal2", "canary-1b-v2", "parakeet-tdt-0.6b-v3"]
# alat → datoteka s okretima govornika (None = iz riječi alata)
DIAR = {
    "deepgram-nova3": None,
    "assemblyai-universal2": None,
    "pyannote-c1": "pyannote-c1.govornici.json",
    "pyannoteai-precision-3": "pyannoteai-precision-3.govornici.json",
}
GAP_MIN_S, GAP_WARN, GAP_ERROR = 10, 0.05, 0.15
WIN_S, WIN_MIN_REF, WIN_LOST = 60, 30, 0.30

NORM_RE = re.compile(r"[^\w]+", re.UNICODE)


def norm(t):
    return [x for x in NORM_RE.sub(" ", t.lower()).split() if x]


def load_words(stem, alat):
    """→ [(start, end, token, speaker)] normalizirano; jedna riječ alata može dati više tokena."""
    p = f"{stem}.{alat}.rijeci.json"
    if not os.path.exists(p):
        return None
    out = []
    for w in json.load(open(p, encoding="utf-8"))["words"]:
        if len(w) >= 5 and w[4]:          # Speechmaticsova zasebna interpunkcija
            continue
        for tok in norm(w[2]):
            out.append((w[0], w[1], tok, w[3] if len(w) > 3 else None))
    return out


def wer(ref, hyp):
    r, h = [w[2] for w in ref], [w[2] for w in hyp]
    ops = Levenshtein.editops(r, h)
    s = sum(1 for o in ops if o.tag == "replace")
    d = sum(1 for o in ops if o.tag == "delete")
    i = sum(1 for o in ops if o.tag == "insert")
    # pomak vremena: jednaki blokovi poravnanja
    shifts = []
    for op in Levenshtein.opcodes(r, h):
        if op.tag == "equal":
            for k in range(op.src_end - op.src_start):
                shifts.append(abs(ref[op.src_start + k][0] - hyp[op.dest_start + k][0]))
    return {
        "wer": round((s + d + i) / max(len(r), 1), 4), "sub": s, "del": d, "ins": i,
        "ref_words": len(r), "hyp_words": len(h),
        "pomak_ms_median": round(statistics.median(shifts) * 1000) if shifts else None,
        "pomak_ms_p90": round(sorted(shifts)[int(len(shifts) * 0.9)] * 1000) if shifts else None,
    }


def dropped(ref, hyp, dur):
    n = int(dur // WIN_S) + 1
    rc, hc = [0] * n, [0] * n
    for w in ref:
        rc[min(int(w[0] // WIN_S), n - 1)] += 1
    for w in hyp:
        hc[min(int(w[0] // WIN_S), n - 1)] += 1
    lost = [k for k in range(n) if rc[k] >= WIN_MIN_REF and hc[k] < WIN_LOST * rc[k]]
    return {"ispusteno_s": len(lost) * WIN_S, "ispusteni_prozori_min": lost[:20]}


def srt_cues(path):
    cues = []
    for b in re.split(r"\n\n+", open(path, encoding="utf-8").read().strip()):
        m = re.search(r"(\d+):(\d+):(\d+)[,.](\d+) --> (\d+):(\d+):(\d+)[,.](\d+)", b)
        if m:
            g = [int(x) for x in m.groups()]
            cues.append((g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000, g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000))
    return cues


def gap_ratio(path, dur):
    """inspect_pipeline.js:analyzeTranscriptCoverage — ista pravila."""
    cues = sorted(srt_cues(path))
    if not cues or not dur:
        return None
    lost = cues[0][0] if cues[0][0] > GAP_MIN_S else 0
    for a, b in zip(cues, cues[1:]):
        if b[0] - a[1] > GAP_MIN_S:
            lost += b[0] - a[1]
    tail = dur - cues[-1][1]
    lost += tail if tail > GAP_MIN_S else 0
    r = lost / dur
    return {"gap_ratio": round(r, 4), "gap_flag": "error" if r > GAP_ERROR else "warn" if r > GAP_WARN else "ok"}


def turns_from_words(words, max_gap=1.0):
    turns = []
    for s, e, _, spk in words:
        if spk is None:
            continue
        if turns and turns[-1][2] == spk and s - turns[-1][1] <= max_gap:
            turns[-1][1] = max(turns[-1][1], e)
        else:
            turns.append([s, e, spk])
    return turns


def annotation(turns):
    from pyannote.core import Annotation, Segment
    a = Annotation()
    for i, (s, e, spk) in enumerate(turns):
        if e > s:
            a[Segment(s, e), i] = str(spk)
    return a


def der(ref_turns, hyp_turns):
    from pyannote.metrics.diarization import DiarizationErrorRate
    m = DiarizationErrorRate(collar=0.25, skip_overlap=True)
    return round(m(annotation(ref_turns), annotation(hyp_turns)), 4)


def main():
    rows = [l.split("\t") for l in open(os.path.join(EXP, "bases.tsv"), encoding="utf-8").read().strip().split("\n")[1:]]
    result = {}
    for vid, kanal, base in rows:
        stem = os.path.join(OUT, kanal, f"{base}.{TAG}")
        ref = load_words(stem, REF)
        if not ref:
            print(f"⚠️  {vid}: nema reference", file=sys.stderr)
            continue
        dur = json.load(open(f"{stem}.{REF}.meta.json"))["audio_seconds"]
        ep = {"audio_s": dur, "asr": {}, "diar": {}}
        ep["asr"][REF] = gap_ratio(f"{stem}.{REF}.dijariziran.srt", dur)
        for alat in ASR:
            hyp = load_words(stem, alat)
            if not hyp:
                continue
            srt = f"{stem}.{alat}.dijariziran.srt"
            if not os.path.exists(srt):
                srt = f"{stem}.{alat}.prijepis.srt"
            ep["asr"][alat] = {**wer(ref, hyp), **dropped(ref, hyp, dur), **(gap_ratio(srt, dur) or {})}
        ref_turns = turns_from_words(ref)
        ep["diar"][REF] = {"govornika": len({t[2] for t in ref_turns})}
        for alat, f in DIAR.items():
            if f is None:
                w = load_words(stem, alat)
                turns = turns_from_words(w) if w else None
            else:
                p = f"{stem}.{f}"
                turns = [[t["start"], t["end"], t["speaker"]] for t in json.load(open(p))["exclusive"]] if os.path.exists(p) else None
            if turns:
                ep["diar"][alat] = {"govornika": len({t[2] for t in turns}), "der_prema_sm": der(ref_turns, turns)}
        # pyannoteAI vs pyannote-c1: slažu li se dva diarizatora međusobno (neovisno o SM-u)
        pa, pc = f"{stem}.pyannoteai-precision-3.govornici.json", f"{stem}.pyannote-c1.govornici.json"
        if os.path.exists(pa) and os.path.exists(pc):
            ta = [[t["start"], t["end"], t["speaker"]] for t in json.load(open(pa))["exclusive"]]
            tc = [[t["start"], t["end"], t["speaker"]] for t in json.load(open(pc))["exclusive"]]
            ep["diar"]["pyannote-c1"]["der_prema_pyannoteai"] = der(ta, tc)
        result[vid] = ep
        print(f"✓ {vid}", file=sys.stderr)

    os.makedirs(RES, exist_ok=True)
    json.dump(result, open(os.path.join(RES, "asr_metrics.json"), "w"), ensure_ascii=False, indent=1)

    # ─── Markdown ───
    L = ["# Faza 3a — ASR i diarizacija (referenca: Speechmatics Enhanced)", "",
         "Generirano s `evaluate_asr.py`. Referenca NIJE istina — vidi README §Ograde.", ""]
    tot = {}
    for vid, ep in result.items():
        for alat, m in ep["asr"].items():
            if m and "wer" in m:
                t = tot.setdefault(alat, {"err": 0, "ref": 0, "isp": 0, "pomak": [], "n": 0, "flags": []})
                t["err"] += m["sub"] + m["del"] + m["ins"]
                t["ref"] += m["ref_words"]
                t["isp"] += m["ispusteno_s"]
                t["n"] += 1
                if m["pomak_ms_median"] is not None:
                    t["pomak"].append(m["pomak_ms_median"])
                if m.get("gap_flag") != "ok":
                    t["flags"].append(f"{vid}:{m.get('gap_flag')}")
    L += ["## Ukupno", "", "| alat | ep | WER (ponderirano) | ispušteno (min) | pomak riječi medijan ms | TRANSCRIPT_GAP |",
          "|---|---|---|---|---|---|"]
    for alat, t in tot.items():
        L.append(f"| {alat} | {t['n']} | {t['err'] / t['ref'] * 100:.1f} % | {t['isp'] / 60:.0f} | "
                 f"{statistics.median(t['pomak']):.0f} | {', '.join(t['flags']) or 'ok'} |")
    L += ["", "## WER po epizodi (%)", "", "| id | min | " + " | ".join(ASR) + " |", "|---|---|" + "---|" * len(ASR)]
    for vid, ep in result.items():
        cells = [f"{ep['asr'][a]['wer'] * 100:.1f}" + (f" (isp. {ep['asr'][a]['ispusteno_s'] // 60} min)" if ep['asr'][a]['ispusteno_s'] else "")
                 if a in ep["asr"] else "—" for a in ASR]
        L.append(f"| {vid} | {ep['audio_s'] / 60:.0f} | " + " | ".join(cells) + " |")
    dn = [REF] + list(DIAR)
    L += ["", "## Govornici (broj / DER prema SM)", "", "| id | " + " | ".join(dn) + " | c1 vs pyannoteAI DER |",
          "|---|" + "---|" * (len(dn) + 1)]
    for vid, ep in result.items():
        cells = []
        for a in dn:
            m = ep["diar"].get(a)
            cells.append("—" if not m else f"{m['govornika']}" + (f" / {m['der_prema_sm'] * 100:.0f} %" if "der_prema_sm" in m else ""))
        x = ep["diar"].get("pyannote-c1", {}).get("der_prema_pyannoteai")
        L.append(f"| {vid} | " + " | ".join(cells) + f" | {'—' if x is None else f'{x * 100:.0f} %'} |")
    open(os.path.join(RES, "asr_metrics.md"), "w").write("\n".join(L) + "\n")
    print("\n".join(L[:12]))


if __name__ == "__main__":
    main()
