#!/usr/bin/env python3
"""Privatni korijen za render_reels.js: segments.jsonl + words.json + info.json + reels.json
(izbor i kartice od 12.11.), s titlom ispravljenim glasanjem (vote_reels.py → glasanje.txt).

Reel 4 (cue 172–180) preuzima tekst i vremena iz titla 16:9 isječka (transcript_3asr.json),
ostali reelovi: Soniox + ispravke iz FIX. Upotreba: python3 build_root.py <root>"""
import json, re, sys, os, difflib, subprocess
A = os.path.dirname(os.path.abspath(__file__))
E = os.path.join(A, "..", "2026-11-16-ep11-soniox-vs-canary")
ROOT = sys.argv[1]
CH = "muzevni_budite"
BASE = "20261022_redefinicija_11_epizoda_yt_RdEN7Ny1bV8"
VID = "RdEN7Ny1bV8"
# kartica quote potpisuje govornika reela: u segments idu imena, ne SPEAKER_xx
NAMES = {"SPEAKER_00": "Ante Lučić", "SPEAKER_01": "Krunoslav Puškar"}
k = lambda w: re.sub(r"[^\wčćžšđ]", "", w.lower())

# (seq, Soniox, ispravak) — glasanje Soniox / Gemini 4 Hydrogen / Gemini 4 Argon / Speechmatics / Canary
FIX = [
    (31, "nekakvom uređenom narativu", "nekakvom uvriježenom narativu"),   # H, A, SM, Canary+Opus (5/5 protiv Sonioxa)
    (61, "baš kao što smo ishendali", "baš kao što smo ishendlali"),       # H, A; Canary „ih hendlali”
    (278, "roditelja, ali klinci", "roditelja, jer klinci"),               # H, A „jer”, Canary „jel”
    (282, "jedno od onih 5-0 djece", "jedno od onih 5,0 djece"),           # izgovoreno „pet nula” (prosjek ocjena)
    (283, "zapravo 5-0? 5-0 ne znači", "zapravo 5,0? 5,0 ne znači"),
]

cues = []
for blk in re.split(r"\n\s*\n", open(f"{E}/soniox_ep11.diarized.srt").read().strip()):
    l = blk.split("\n")
    a, b = l[1].split(" --> ")
    hms = lambda s: (lambda h, m, x: int(h) * 3600 + int(m) * 60 + float(x))(*s.replace(",", ".").split(":"))
    t = " ".join(l[2:]); m = re.match(r"\[(\w+)\]\s*", t)
    cues.append({"seq": int(l[0]), "start": hms(a), "end": hms(b), "speaker": m.group(1) if m else "", "text": t[m.end():] if m else t})
toks = json.load(open(f"{A}/soniox_tokens.json"))["tokens"]   # [seq, tok, start, end, conf]
W = {}   # seq → [[tok, start, end]]
for s, t, a, b, _ in toks:
    W.setdefault(s, []).append([t, a, b])
by = {c["seq"]: c for c in cues}
for c in cues: assert [w[0] for w in W[c["seq"]]] == c["text"].split(), c["seq"]


def retime(src, dst_text):
    """src [[tok,s,e]] → nove riječi; ista duljina nosi vremena, inače se raspon dijeli."""
    dst = dst_text.split(); out = []
    for t, i1, i2, j1, j2 in difflib.SequenceMatcher(None, [k(x[0]) for x in src], [k(x) for x in dst], autojunk=False).get_opcodes():
        if t == "equal" or (t == "replace" and i2 - i1 == j2 - j1):
            for n in range(j2 - j1): out.append([dst[j1 + n], src[i1 + n][1], src[i1 + n][2]])
            continue
        s = src[i1][1] if i1 < i2 else (src[i1 - 1][2] if i1 else src[0][1])
        e = src[i2 - 1][2] if i1 < i2 else (src[i1][1] if i1 < len(src) else s + 0.3)
        d = max(0.05, (e - s) / max(1, j2 - j1))
        for n in range(j2 - j1): out.append([dst[j1 + n], s + n * d, s + (n + 1) * d])
    return out


changed = 0
RANGES = [(27, 32), (57, 62), (278, 283)]
for _, a, b in FIX:   # seq u FIX je samo orijentir; traži se jedinstven pogodak unutar reelova
    hit = [c for c in cues if any(x <= c["seq"] <= y for x, y in RANGES) and a in c["text"]]
    assert len(hit) == 1 and hit[0]["text"].count(a) == 1, a
    c = hit[0]; seq = c["seq"]
    c["text"] = c["text"].replace(a, b); W[seq] = retime(W[seq], c["text"]); changed += 1

# Reel 4: riječi titla 16:9 isječka (apsolutno vrijeme = CS + t), raspoređene po cue-ovima 172–180
CS = 1816.0
T3 = json.load(open(os.path.join(A, "..", "2026-11-17-isjecak-ep11-3asr", "transcript_3asr.json")))
lo, hi = by[172]["start"] - 0.1, by[180]["end"] + 0.3   # „Točno.” voditelja prije reza ne ulazi
sel = [[w["text"], w["start"] + CS, w["end"] + CS] for w in T3 if lo <= w["start"] + CS and w["end"] + CS <= hi]
for s in range(172, 181): W[s] = []
for w in sel:
    mid = (w[1] + w[2]) / 2
    seq = min(range(172, 181), key=lambda s: 0 if by[s]["start"] <= mid <= by[s]["end"] else min(abs(mid - by[s]["start"]), abs(mid - by[s]["end"])))
    W[seq].append(w)
for s in range(172, 181):
    by[s]["text"] = " ".join(w[0] for w in W[s])
print("reel 4 iz 3-ASR titla:", len(sel), "riječi; prva:", sel[0][0], "zadnja:", sel[-1][0])

d = os.path.join(ROOT, CH); os.makedirs(d, exist_ok=True)
with open(f"{d}/{BASE}.segments.jsonl", "w") as f:
    for c in cues:
        f.write(json.dumps({"seq": c["seq"], "start_sec": round(c["start"], 3), "end_sec": round(c["end"], 3), "speaker": NAMES.get(c["speaker"], c["speaker"]),
                            "text": c["text"], "video_id": VID, "upload_date": "2026-11-14"}, ensure_ascii=False) + "\n")
json.dump({"version": 1, "video_id": VID, "source": "soniox + glasanje 5 ASR-a (experiments/2026-11-17-reelsi-ep11-bez-potpisa)",
           "cues": [{"w": [round(x * 1000) for w in W[c["seq"]] for x in (w[1], max(w[2], w[1] + 0.05))]} for c in cues]},
          open(f"{d}/{BASE}.words.json", "w"), ensure_ascii=False)
json.dump({"id": VID, "title": "[re:DEFINICIJA] Ante Lučić (ep. 11)", "channel": "Muževni budite", "upload_date": "20261114"},
          open(f"{d}/{BASE}.info.json", "w"), ensure_ascii=False)
print("ispravljenih cue-ova:", changed)
