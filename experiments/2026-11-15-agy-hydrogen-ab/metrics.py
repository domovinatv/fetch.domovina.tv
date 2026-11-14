#!/usr/bin/env python3
"""Mjere članka za A/B (iste kao 07.11., docs/2026-11-07-tier2-agy-i-5h-ograda.md):
znakova, sekcija, citata („…”), pojačanja (riječi koje pojačavaju izjavu), podebljanja,
spominjanja prijepisa, najveća rupa između kadrova (min)."""
import glob, json, os, re, sys

E = os.path.dirname(os.path.abspath(__file__))
IDS = {"HYNJ0Ddwjyw": "Škabrnja 28 min", "L9JEBGkSokM": "Privatna klinika 52 min", "nToZnW8RHP4": "Prgavi 105 min"}
INTENS = re.compile(r"\b(cijel[aeoiu]\w* Hrvatsk\w*|najveć\w*|ključn\w*|strateš\w*|iznimn\w*|dogovoreno je|izuzetn\w*|presudn\w*|povijesn\w*|revolucionarn\w*)", re.I)
TRANSCRIPT = re.compile(r"\b(transkript\w*|prijepis\w*|ASR)\b", re.I)


def secs(t):
    h, m, s = (t.replace(",", ".").split(":") + ["0", "0"])[:3]
    return int(h) * 3600 + int(m) * 60 + float(s)


def measure(path):
    d = json.load(open(path))
    secs_list, text = [], []
    n = 0
    for it in d.get("iterations", []):
        for s in it.get("sections", []):
            n += 1
            text.append(s.get("content", ""))
            if s.get("screenshot_timestamp"):
                secs_list.append(secs(s["screenshot_timestamp"]))
    t = "\n".join(text)
    secs_list.sort()
    gap = max((b - a for a, b in zip(secs_list, secs_list[1:])), default=0) / 60
    return {
        "znakova": len(t), "sekcija": n,
        "citata": len(re.findall(r"„[^”]{3,}”", t)),
        "pojačanja": len(INTENS.findall(t)),
        "bold": len(re.findall(r"\*\*[^*]+\*\*", t)),
        "prijepis": len(TRANSCRIPT.findall(t)),
        "rupa_min": round(gap, 1),
        "model": d.get("metadata", {}).get("model"),
        "complete": d.get("metadata", {}).get("complete"),
    }


rows = []
for vid, name in IDS.items():
    cands = [("opus", glob.glob(f"{E}/input/*_yt_{vid}*opus.article.json"))]
    for m in sorted(os.listdir(f"{E}/out")):
        cands.append((m, glob.glob(f"{E}/out/{m}/*_yt_{vid}*.article.json")))
    for m, files in cands:
        if not files:
            continue
        r = measure(sorted(files)[-1])
        rows.append((name, m, r))

print("| Epizoda | Model | znakova | sekcija | citata | pojačanja | bold | prijepis | rupa min |")
print("|---|---|---|---|---|---|---|---|---|")
for name, m, r in rows:
    print(f"| {name} | {m} | {r['znakova']:,} | {r['sekcija']} | {r['citata']} | {r['pojačanja']} | {r['bold']} | {r['prijepis']} | {r['rupa_min']} |".replace(",", " "))
if "--json" in sys.argv:
    json.dump([{"ep": n, "model": m, **r} for n, m, r in rows], sys.stdout, ensure_ascii=False, indent=1)
