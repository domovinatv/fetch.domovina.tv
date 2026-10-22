"""Gradi HyperFrames kompoziciju (9:16): titl-klipovi riječ po riječ iz transcript.json + predložak s karticama.

    python3 build_composition.py <workdir> [OFF] [DUR] [template.html] [--debug] [--brand <ime>]

Uz <workdir>/faces.json (face_track.py nad public/input-video.mp4) — raspored kartica i
titla radi reel_layout.js u pregledniku (kopira se u public/). --debug iscrta sigurnu
zonu i zabranjenu zonu lica, za `npx hyperframes snapshot --at`. --brand <ime> = boje,
fontovi i logo kanala iz $DOMOVINA_BRANDING_DIR/<ime>/brand.json (tamne kartice sa
zlatnim rubom); potpis domovina.ai ostaje isti.
"""
import json, os, re, shutil, sys, html

DEBUG = "--debug" in sys.argv
BRAND = sys.argv[sys.argv.index("--brand") + 1] if "--brand" in sys.argv else None
argv = [a for i, a in enumerate(sys.argv) if a not in ("--debug", "--brand") and sys.argv[i - 1] != "--brand"]
REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
W = argv[1]
OFF = float(argv[2]) if len(argv) > 2 else 2.9   # odrezano s početka segmenta (ostatak prethodnog cue-a)
DUR = float(argv[3]) if len(argv) > 3 else 61.92
FPS = 25
d = json.load(open(f"{W}/transcript.json"))
words = [dict(w, start=w["start"] - OFF, end=w["end"] - OFF) for w in d["words"] if w["start"] >= OFF - 0.05]

q = lambda t: round(round(t * FPS) / FPS, 4)

# titl-komadi: ≤3 riječi / ≤20 znakova, lom na interpunkciji ili pauzi > 0.35 s (kao render_reel.py)
chunks, cur = [], []
for w in words:
    if cur and (len(cur) >= 3 or len(" ".join(x["text"] for x in cur + [w])) > 20
                or re.search(r"[.,?!:;]$", cur[-1]["text"]) or w["start"] - cur[-1]["end"] > 0.35):
        chunks.append(cur); cur = []
    cur.append(w)
chunks.append(cur)

cap_html, cap_js = [], []
for i, c in enumerate(chunks):
    s = q(max(0, c[0]["start"]))
    e = q(min(DUR, chunks[i + 1][0]["start"] if i + 1 < len(chunks) and chunks[i + 1][0]["start"] - c[-1]["end"] < 0.6 else c[-1]["end"] + 0.25))
    spans = "".join(f'<span class="w" id="w{i}_{j}">{html.escape(x["text"])}</span> ' for j, x in enumerate(c))
    cap_html.append(f'<div class="cap clip" id="c{i}" data-start="{s}" data-duration="{q(e - s)}" data-track-index="9">{spans}</div>')
    cap_js.append(f'tl.fromTo("#c{i}",{{opacity:0,y:14,scale:0.96}},{{opacity:1,y:0,scale:1,duration:0.14,ease:"power2.out"}},{s});')
    for j, x in enumerate(c):
        cap_js.append(f'tl.set("#w{i}_{j}",{{color:"var(--gold)"}},{q(max(s, x["start"]))});')
        if j:  # prethodna riječ se vraća u bijelo
            cap_js.append(f'tl.set("#w{i}_{j-1}",{{color:"#fff"}},{q(max(s, x["start"]))});')

tpl = open(argv[4] if len(argv) > 4 else f"{W}/template.html").read()
faces = open(f"{W}/faces.json").read()


def brand_css(name):
    """brand.json → @font-face + CSS varijable; fontovi i logo se kopiraju u public/brand/."""
    d = os.environ.get("DOMOVINA_BRANDING_DIR") or os.path.join(REPO, "data", "branding")
    bdir = os.path.join(d, name)
    b = json.load(open(os.path.join(bdir, "brand.json")))
    c = b["colors"]
    col = lambda v: c.get(v, v)          # uloga ("highlight") ili izravan hex
    os.makedirs(f"{W}/public/brand", exist_ok=True)
    faces = []
    for role in ("title", "body", "caption"):
        shutil.copy(os.path.join(bdir, b["typography"][role]), f"{W}/public/brand/{role}.ttf")
        faces.append(f'@font-face {{ font-family: "Brand-{role}"; src: url("brand/{role}.ttf") format("truetype"); font-display: block; }}')
    shutil.copy(os.path.join(bdir, b["logo"]["wide"]), f"{W}/public/brand/logo.png")
    r = b.get("reel", {})
    return "\n".join(faces) + f"""
:root {{ --paper: {col("background")}; --ink: {col("text")}; --ink-soft: rgba(255,255,255,.72); --rule: rgba(255,255,255,.18);
  --wine: {col("primary")}; --gold: {col(r.get("caption_active", "highlight"))}; --edge: {col("primary")}; --bar-ink: {col("background")};
  --f-head: "Brand-title"; --f-body: "Brand-body"; --f-cap: "Brand-caption"; }}
.brand-logo {{ display: block; height: 92px; margin: 0 auto 18px; }}"""

out = (tpl.replace("{{CAPTIONS}}", "\n".join(cap_html)).replace("{{CAPTION_JS}}", "\n".join(cap_js))
       .replace("{{DUR}}", str(DUR)).replace("{{FACES}}", faces).replace("{{DEBUG}}", "true" if DEBUG else "false")
       .replace("{{BRAND_CSS}}", brand_css(BRAND) if BRAND else ""))
shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)), "reel_layout.js"), f"{W}/public/reel_layout.js")
open(f"{W}/public/index.html", "w").write(out)
print(len(words), "riječi,", len(chunks), "komada titla")
