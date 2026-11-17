"""Govornik po riječi: Soniox dijarizacija (S1 = Ante Lučić, S2 = Krunoslav Puškar; potvrđeno Hydrogenom
i Canary+pyannote), plus dobacivanja kojih Soniox nema (po Hydrogenu)."""
import json, bisect, os
A = os.path.dirname(os.path.abspath(__file__))
E = "/Users/ms/git/domovinatv/fetch.domovina.tv/experiments/2026-11-16-ep11-soniox-vs-canary"
CS = 1816.0
NAME = {"1": "A", "2": "K"}
tok = [t for t in json.load(open(f"{E}/soniox_sirovi_izlaz.json"))["tokens"] if t["text"].strip()]
st = [t["start_ms"] / 1000 - CS for t in tok]
W = json.load(open(f"{A}/transcript_3asr.json"))
for w in W:
    i = max(0, bisect.bisect_right(st, w["start"] + 0.02) - 1)
    w["spk"] = NAME[tok[i]["speaker"]]
# dobacivanja koja je čuo samo Hydrogen
for n, w in enumerate(W):
    if w["text"] == "Etiketu.": w["spk"] = "K"
    if w["text"] == "Točno.": w["spk"] = "A"
json.dump(W, open(f"{A}/transcript_3asr_spk.json", "w"), ensure_ascii=False, indent=0)
runs = []
for w in W:
    if runs and runs[-1][0] == w["spk"]: runs[-1][2] = w["end"]; runs[-1][3].append(w["text"])
    else: runs.append([w["spk"], w["start"], w["end"], [w["text"]]])
for s, a, b, t in runs: print(f"{s} {int(a//60)}:{a%60:05.2f}  {' '.join(t)[:80]}")
