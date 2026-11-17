"""16:9 isječak s titlom riječ po riječ + logo kanala (HyperFrames projekt).

    cd <projekt> && python3 <repo>/tools/hyperframes_reel/clip_captions_169.py

Projekt treba: src/diarized.srt + src/words.json (s CDN-a, data/<ID>/), assets/clip.mp4
(isječak s cdn.domovina.ai/clips/), assets/logo_wide.png, assets/fonts/SourceSans3-*.ttf,
assets/gsap.min.js. Piše index.html + compositions/captions.html.
Riječi: kanonski diarized.srt + words.json (isti par kao render_reel.load_words).
CLIP_S/CLIP_E i SHIFT (prozor ugrađene grafike dolje lijevo) su za re:DEFINICIJA 11, RdEN7Ny1bV8.
Postupak: docs/2026-11-17-rucni-isjecak-epizode-na-cdn.md."""
import re, json, html, sys
CLIP_S, CLIP_E = 1816.0, 2192.0           # 30:16–36:32
DUR = CLIP_E - CLIP_S
SHIFT = (262.5, 292.5)                    # ugrađena kartica „Podupri naš rad" dolje lijevo
MAXW, MAXC, GAP = 5, 32, 0.30

cues = []
for b in re.split(r"\r?\n\s*\r?\n", open("src/diarized.srt", encoding="utf-8").read().strip()):
    l = b.strip().split("\n")
    if len(l) < 3: continue
    t = " ".join(x.strip() for x in l[2:]).strip()
    if not re.match(r"^\[\w+\]", t): continue
    cues.append(re.sub(r"^\[\w+\]", "", t).split())
wj = json.load(open("src/words.json"))["cues"]
assert len(cues) == len(wj)
words = []
for toks, c in zip(cues, wj):
    for i, tok in enumerate(toks):
        s, e = c["w"][2*i]/1000, c["w"][2*i+1]/1000
        if CLIP_S <= s < CLIP_E - 0.1:
            words.append([tok, round(s-CLIP_S, 3), round(min(e, CLIP_E)-CLIP_S, 3)])

groups, cur = [], []
for w in words:
    if cur and (len(cur) >= MAXW or len(" ".join(x[0] for x in cur+[w])) > MAXC
                or re.search(r"[.?!:;,]$", cur[-1][0]) or w[1]-cur[-1][2] > GAP):
        groups.append(cur); cur = []
    cur.append(w)
if cur: groups.append(cur)

out, js = [], []
for k, g in enumerate(groups):
    st = max(0.1, g[0][1]-0.05)
    nxt = groups[k+1][0][1]-0.05 if k+1 < len(groups) else DUR
    en = min(nxt, g[-1][2]+0.6, DUR)
    if en - st < 0.25: en = min(st+0.25, DUR)
    shift = " shift" if SHIFT[0] <= st < SHIFT[1] else ""
    spans = []
    for j, w in enumerate(g):
        wid = f"w{k}-{j}"
        spans.append(f'<span id="{wid}" class="wd">{html.escape(w[0])}</span>')
        nx = g[j+1][1] if j+1 < len(g) else en
        js.append(f'k("{wid}",{w[1]:.3f},{max(nx, w[1]+0.08):.3f});')
    out.append(f'    <div id="g{k}" class="grp clip{shift}" data-start="{st:.3f}" data-duration="{en-st:.3f}" data-track-index="0">'
               f'<div class="pill" id="p{k}">{" ".join(spans)}</div></div>')
    js.append(f'p("p{k}",{st:.3f});')

cap = f'''<template>
  <style>
    #root {{ position: absolute; inset: 0; pointer-events: none; }}
    #root .grp {{ position: absolute; left: 192px; right: 192px; bottom: 96px; text-align: center; overflow: visible; }}
    #root .grp.shift {{ left: 900px; right: 120px; }}
    #root .pill {{ display: inline-block; padding: 10px 26px 14px; border-radius: 14px;
      background: rgba(13,18,22,.82); box-shadow: 0 8px 28px rgba(0,0,0,.35);
      font: 900 60px/1.15 "Source Sans 3", sans-serif; color: #fff; white-space: nowrap; letter-spacing: .005em; }}
    #root .wd {{ display: inline-block; }}
  </style>
  <div id="root" data-composition-id="captions" data-width="1920" data-height="1080" data-start="0" data-duration="{DUR:.0f}">
{chr(10).join(out)}
  </div>
  <script>
    const tl = gsap.timeline({{ paused: true }});
    const GOLD = "#C6A15B";
    function p(id, t) {{ tl.fromTo("#" + id, {{ opacity: 0, y: 8 }}, {{ opacity: 1, y: 0, duration: 0.12, ease: "power2.out" }}, t); }}
    function k(id, a, b) {{ tl.set("#" + id, {{ color: GOLD }}, a); tl.set("#" + id, {{ color: "#fff" }}, b); }}
    {chr(10).join("    "+x for x in js)}
    window.__timelines["captions"] = tl;
  </script>
</template>
'''
open("compositions/captions.html", "w").write(cap)

idx = f'''<!doctype html>
<html lang="hr">
<head>
<meta charset="utf-8" />
<title>re:DEFINICIJA 11 — Ante Lučić, isječak s titlom</title>
<style>
  @font-face {{ font-family: "Source Sans 3"; src: url("assets/fonts/SourceSans3-Black.ttf") format("truetype"); font-weight: 900; font-display: block; }}
  @font-face {{ font-family: "Source Sans 3"; src: url("assets/fonts/SourceSans3-Bold.ttf") format("truetype"); font-weight: 700; font-display: block; }}
  html, body {{ margin: 0; background: #000; overflow: hidden; }}
  #main {{ position: relative; width: 1920px; height: 1080px; overflow: hidden; background: #0D1216; }}
  #footage {{ position: absolute; inset: 0; width: 1920px; height: 1080px; object-fit: cover; z-index: 1; }}
  #captions {{ position: absolute; inset: 0; z-index: 5; }}
  #bug {{ position: absolute; right: 96px; top: 54px; z-index: 6; }}
  #bug-in {{ padding: 10px 16px; border-radius: 14px; background: rgba(13,18,22,.82); }}
  #bug-in img {{ display: block; height: 84px; width: auto; }}
</style>
</head>
<body>
<div id="main" data-composition-id="main" data-start="0" data-duration="{DUR:.0f}" data-width="1920" data-height="1080" data-fps="25">
  <video id="footage" class="clip" src="assets/clip.mp4" playsinline data-has-audio="true"
    data-start="0" data-duration="{DUR:.0f}" data-track-index="0"></video>
  <div id="bug" class="clip" data-start="0" data-duration="{DUR:.0f}" data-track-index="1">
    <div id="bug-in"><img src="assets/logo_wide.png" alt="Muževni budite" /></div>
  </div>
  <div id="captions" data-composition-id="captions" data-composition-src="compositions/captions.html"
    data-track-kind="captions" data-start="0" data-duration="{DUR:.0f}" data-track-index="2" data-width="1920" data-height="1080"></div>
  <script src="assets/gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({{ paused: true }});
    tl.fromTo("#bug-in", {{ opacity: 0 }}, {{ opacity: 1, duration: 0.8, ease: "power1.out" }}, 0.2);
    window.__timelines["main"] = tl;
  </script>
</div>
</body>
</html>
'''
open("index.html", "w").write(idx)
json.dump([{"id": f"w{i}", "text": w[0], "start": w[1], "end": w[2]} for i, w in enumerate(words)], open("src/transcript.json", "w"), ensure_ascii=False)
print("riječi", len(words), "grupa", len(groups), "max znakova", max(len(" ".join(x[0] for x in g)) for g in groups))
print("prve:", [" ".join(x[0] for x in g) for g in groups[:4]], "zadnje:", [" ".join(x[0] for x in g) for g in groups[-3:]])
