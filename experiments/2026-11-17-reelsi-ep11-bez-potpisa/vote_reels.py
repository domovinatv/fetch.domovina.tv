#!/usr/bin/env python3
"""Titl reelova 1, 2, 4, 6 (ep. 11): Soniox cue-ovi (ono što reel prikazuje) + vremena riječi
iz sirovog Sonioxa, glasanje prema Canaryju (sirovi i Opus ispravak), Speechmaticsu i
Geminiju 4 (Hydrogen i Argon, app, cijela epizoda).

Izlaz: words.json (vremena po tokenu cue-a) i glasanje.txt (regije gdje se Soniox ne slaže)."""
import json, re, difflib, os
A = os.path.dirname(os.path.abspath(__file__))
E = os.path.join(A, "..", "2026-11-16-ep11-soniox-vs-canary")
REELS = {1: (27, 32), 2: (57, 62), 4: (172, 180), 6: (278, 283)}
k = lambda w: re.sub(r"[^\wčćžšđ]", "", w.lower())


def hms(s):
    h, m, x = s.replace(",", ".").split(":")
    return int(h) * 3600 + int(m) * 60 + float(x)


def srt(p):
    out = []
    for blk in re.split(r"\n\s*\n", open(p).read().strip()):
        l = blk.split("\n")
        if len(l) < 3: continue
        a, b = l[1].split(" --> ")
        t = " ".join(l[2:]); m = re.match(r"\[(\w+)\]\s*", t)
        out.append({"seq": int(l[0]), "start": hms(a), "end": hms(b), "speaker": m.group(1) if m else "", "text": t[m.end():] if m else t})
    return out


# Soniox sirovi tokeni → riječi s vremenom (razmak je zaseban token)
SW, brk = [], True
for t in json.load(open(f"{E}/soniox_sirovi_izlaz.json"))["tokens"]:
    tx = t["text"]
    if not tx.strip(): brk = True; continue
    new = tx.startswith(" ") or brk or not SW; brk = False
    if not new and not re.search(r"\w", tx): SW[-1][0] += tx; continue
    if new and not re.search(r"\w", tx) and SW: SW[-1][0] += tx.strip(); continue
    if new: SW.append([tx.strip(), t["start_ms"] / 1000, t["end_ms"] / 1000, t["confidence"]])
    else: SW[-1][0] += tx; SW[-1][2] = t["end_ms"] / 1000; SW[-1][3] = min(SW[-1][3], t["confidence"])

CUES = srt(f"{E}/soniox_ep11.diarized.srt")
# tokeni cue-ova (kao render_reels: text.split) → indeks u SW
TOK = []  # (seq, tok, key)
for c in CUES:
    for w in c["text"].split():
        TOK.append((c["seq"], w, k(w)))
TK = [x[2] for x in TOK]
SK = [k(w[0]) for w in SW]
tim = [None] * len(TOK)
for t, i1, i2, j1, j2 in difflib.SequenceMatcher(None, TK, SK, autojunk=False).get_opcodes():
    if t == "equal" or (t == "replace" and i2 - i1 == j2 - j1):
        for n in range(i2 - i1): tim[i1 + n] = (SW[j1 + n][1], SW[j1 + n][2], SW[j1 + n][3])
miss = [i for i, x in enumerate(tim) if x is None]
# rupe (npr. „100%” vs „100 %”): razdijeli između susjeda
for i in miss:
    a = next((tim[j][1] for j in range(i - 1, -1, -1) if tim[j]), 0)
    b = next((tim[j][0] for j in range(i + 1, len(tim)) if tim[j]), a + 0.3)
    tim[i] = (a, max(a + 0.05, b), 0.0)
print("tokena", len(TOK), "bez izravnog vremena", len(miss))


def words_md(p):
    g = open(p).read()
    g = re.split(r"^.*(?:### Dodatni isječak|\*\*\[Najava iduće).*$", g, flags=re.M)[0]
    g = re.sub(r"\*\*\[[^\]]*\]\*\*", "", g); g = re.sub(r"\*\*[^*]+:\*\*", " ", g); g = re.sub(r"^#.*$", "", g, flags=re.M)
    g = re.sub(r"\[\d\d:\d\d(:\d\d)?\]", " ", g)
    return [x for x in (w for w in g.split()) if k(x)]


def words_srt(p):
    return [w for c in srt(p) for w in c["text"].split() if k(w)]


R = {"Hydrogen4": words_md(f"{E}/gemini_hydrogen4_app.md"),
     "Argon4": words_md(f"{E}/gemini_argon4_app.md"),
     "Speechm": words_srt(f"{E}/ep11.mp3.speechmatics.srt"),
     "Canary": words_srt(f"{A}/canary.asr.srt"),
     "CanOpus": words_srt(f"{A}/canary_opus.srt")}
OPS = {n: difflib.SequenceMatcher(None, TK, [k(w) for w in ref], autojunk=False).get_opcodes() for n, ref in R.items()}


def mp(n, a, b):
    out = []
    for t, i1, i2, j1, j2 in OPS[n]:
        if t == "equal":
            lo, hi = max(i1, a), min(i2, b)
            if lo < hi: out += R[n][j1 + lo - i1:j1 + hi - i1]
        elif (i1 < b and i2 > a) or (i1 == i2 and a <= i1 <= b):
            out += R[n][j1:j2]
    return out


lines = []
for rk, (s0, s1) in REELS.items():
    idx = [i for i, x in enumerate(TOK) if s0 <= x[0] <= s1]
    a0, a1 = idx[0], idx[-1] + 1
    lines.append(f"\n===== Reel {rk} (cue {s0}–{s1}), {a1 - a0} riječi")
    lines.append("SONIOX: " + " ".join(f"{TOK[i][1]}{'⁽' + str(round(tim[i][2], 2)) + '⁾' if tim[i][2] < 0.6 else ''}" for i in range(a0, a1)))
    spans = sorted((max(i1, a0), min(i2, a1) if i2 > i1 else i1) for n in OPS for t, i1, i2, j1, j2 in OPS[n]
                   if t != "equal" and ((i1 < a1 and i2 > a0) or (i1 == i2 and a0 <= i1 < a1)))
    reg = []
    for a, b in spans:
        if reg and a <= reg[-1][1]: reg[-1][1] = max(reg[-1][1], b)
        else: reg.append([a, b])
    for a, b in reg:
        lo, hi = max(a0, a - 2), min(a1, b + 2)   # 2 riječi konteksta
        so = " ".join(t[1] for t in TOK[lo:hi])
        alts = {n: " ".join(mp(n, lo, hi)) for n in R}
        agree = sum(1 for v in alts.values() if [k(x) for x in v.split()] == [k(t[1]) for t in TOK[lo:hi]])
        if agree >= 4: continue   # Soniox potvrđen
        t0 = tim[lo][0]
        lines.append(f"\n[{int(t0 // 60):02d}:{t0 % 60:05.2f}] tok {lo}  S: {so}   (slaže se {agree}/5)")
        for n, v in alts.items(): lines.append(f"     {n:9s} {v}")
open(f"{A}/glasanje.txt", "w").write("\n".join(lines) + "\n")
json.dump({"tokens": [[TOK[i][0], TOK[i][1], round(tim[i][0], 3), round(tim[i][1], 3), round(tim[i][2], 3)] for i in range(len(TOK))]},
          open(f"{A}/soniox_tokens.json", "w"), ensure_ascii=False)
print("\n".join(lines))
