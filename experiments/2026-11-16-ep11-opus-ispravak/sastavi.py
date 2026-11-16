#!/usr/bin/env python3
"""izlaz/dio{1,2,3}.txt (Opus ispravak) + vremena iz Canary .diarized.srt
→ kanal/muzevni_budite/<base>.wav.canary.diarized.srt (za generate_words_json.js)."""
import os, re, sys, shutil

X = os.path.dirname(os.path.abspath(__file__))
B = "20261114_re_definicija_ante_lucic_nisam_ponosan_vec_sam_zahvalan_sto_sam_hrvat_ep_11_yt_RdEN7Ny1bV8"
SRC = "/Users/ms/git/domovinatv/fetch.domovina.tv/storage/output/muzevni_budite/" + B
OUT = f"{X}/kanal/muzevni_budite"
os.makedirs(OUT, exist_ok=True)
if not os.path.exists(f"{OUT}/{B}.wav.canary.word_ts.json"):
    shutil.copy(SRC + ".wav.canary.word_ts.json", OUT)

src = open(SRC + ".wav.canary.diarized.srt").read().strip().split("\n\n")
times = {int(b.split("\n")[0]): b.split("\n")[1] for b in src}
fix = {}
for n in (1, 2, 3):
    for l in open(f"{X}/izlaz/dio{n}.txt"):
        m = re.match(r"^(\d+) (\[SPEAKER_\d+\])\s?(.*)$", l.rstrip("\n"))
        if m:
            fix[int(m.group(1))] = (m.group(2), m.group(3).strip())
miss = sorted(set(times) - set(fix))
extra = sorted(set(fix) - set(times))
print("cue-ova", len(fix), "nedostaje", miss[:20], "višak", extra[:20])
if miss or extra:
    sys.exit(1)
out = [f"{i}\n{times[i]}\n{fix[i][0]} {fix[i][1]}".rstrip() for i in sorted(times)]
p = f"{OUT}/{B}.wav.canary.diarized.srt"
open(p, "w").write("\n\n".join(out) + "\n")
print("→", p)
