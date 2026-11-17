"""Soniox riječi (s vremenom) za isječak + glasanje prema ostalim prijepisima istog odsječka."""
import json, re, difflib, sys, os
E = "/Users/ms/git/domovinatv/fetch.domovina.tv/experiments/2026-11-16-ep11-soniox-vs-canary"
A = os.path.dirname(os.path.abspath(__file__))
CS, CE = 1816.0, 2192.0
def k(w): return re.sub(r"[^\wčćžšđ]", "", w.lower())

# Soniox tokeni → riječi
tok = json.load(open(f"{E}/soniox_sirovi_izlaz.json"))["tokens"]
SW = []  # [text, start, end, conf_min, speaker]
brk = True
for t in tok:
    tx = t["text"]
    if not tx.strip():
        brk = True; continue
    new = tx.startswith(" ") or brk or not SW
    brk = False
    if not new and not re.search(r"\w", tx):
        SW[-1][0] += tx; continue
    if new and not re.search(r"\w", tx) and SW:
        SW[-1][0] += tx.strip(); continue
    if new:
        SW.append([tx.strip(), t["start_ms"]/1000, t["end_ms"]/1000, t["confidence"], t["speaker"]])
    else:
        SW[-1][0] += tx; SW[-1][2] = t["end_ms"]/1000; SW[-1][3] = min(SW[-1][3], t["confidence"])
SK = [k(w[0]) for w in SW]
i0 = next(i for i, w in enumerate(SW) if w[1] >= CS); i1 = next(i for i, w in enumerate(SW) if w[1] >= CE - 0.1)
print("Soniox riječi u isječku:", i1 - i0)

def words_md(p):
    g = open(p).read()
    g = re.sub(r"\*\*\[[^\]]*\]\*\*", "", g); g = re.sub(r"\*\*[^*]+:\*\*", " ", g); g = re.sub(r"^#.*$", "", g, flags=re.M)
    g = re.sub(r"\[\d\d:\d\d(:\d\d)?\]", " ", g)
    return [x for x in (k(w) for w in g.split()) if x]
def words_srt(p):
    out = []
    for b in re.split(r"\n\s*\n", open(p).read().strip()):
        l = b.split("\n")
        if len(l) >= 3: out += [x for x in (k(w) for w in re.sub(r"^\[\w+\]", "", " ".join(l[2:])).split()) if x]
    return out
R = {"Hydrogen4": words_md(f"{E}/gemini_hydrogen4_app.md"), "Argon4": words_md(f"{E}/gemini_argon4_app.md"),
     "Speechmatics": words_srt(f"{E}/ep11.mp3.speechmatics.diarized.srt"),
     "Objavljeno": words_srt("/private/tmp/claude-501/-Users-ms-git-domovinatv-fetch-domovina-tv/635cb960-8981-45c9-9589-49248c21311b/scratchpad/clip_caps/src/diarized.srt")}
if os.path.exists(f"{A}/agy_gemini38.txt") and os.path.getsize(f"{A}/agy_gemini38.txt") > 500:
    R["agy38"] = words_md(f"{A}/agy_gemini38.txt")
SEG = SK[i0:i1]
def mapped(ref):
    # lokalno: poravnaj odsječak na prozor u referenci (traži sidro)
    sm = difflib.SequenceMatcher(None, SK, ref, autojunk=False)
    return sm.get_opcodes()
OPS = {}
for n, ref in R.items():
    if n == "agy38":   # agy ima samo isječak: poravnaj odsječak izravno
        OPS[n] = [(t, a + i0, b + i0, c, d) for t, a, b, c, d in difflib.SequenceMatcher(None, SEG, ref, autojunk=False).get_opcodes()]
    else:
        OPS[n] = mapped(ref)
def mp(n, a, b):
    out = []
    for t, x1, x2, y1, y2 in OPS[n]:
        if t == "equal":
            lo, hi = max(x1, a), min(x2, b)
            if lo < hi: out += R[n][y1 + lo - x1:y1 + hi - x1]
        elif (x1 < b and x2 > a) or (x1 == x2 and a <= x1 <= b): out += R[n][y1:y2]
    return out
spans = sorted((max(x1, i0), min(x2, i1)) if x1 != x2 else (x1, x2) for n in OPS for t, x1, x2, y1, y2 in OPS[n]
               if t != "equal" and x1 <= i1 and x2 >= i0 and i0 <= x1 < i1)
reg = []
for a, b in spans:
    if reg and a <= reg[-1][1]: reg[-1][1] = max(reg[-1][1], b)
    else: reg.append([a, b])
rows = []
for a, b in reg:
    s = SK[a:b]; v = {n: mp(n, a, b) for n in R}
    agree = sum(1 for n in R if v[n] == s)
    t = SW[min(a, len(SW) - 1)][1] - CS
    rows.append({"a": a, "b": b, "t": round(t, 2), "soniox": " ".join(SW[x][0] for x in range(a, b)), "s_agree": agree,
                 "conf": round(min([SW[x][3] for x in range(a, b)] or [1]), 2), **{n: " ".join(v[n]) for n in R}})
json.dump({"i0": i0, "i1": i1, "words": SW[i0:i1], "rows": rows}, open(f"{A}/vote.json", "w"), ensure_ascii=False, indent=0)
print("referenci:", list(R), " regija razlike:", len(rows))
for r in rows:
    if r["s_agree"] <= len(R) // 2:
        print(f'{int(r["t"]//60)}:{r["t"]%60:05.2f} S[{r["s_agree"]}/{len(R)} c{r["conf"]}]«{r["soniox"]}» ' + " | ".join(f'{n[:4]}«{r[n]}»' for n in R))
