"""Lica kroz vrijeme za HyperFrames reel → faces.json (kadriranje + zabranjena zona za tekst).

    python3 tools/hyperframes_reel/face_track.py <public/input-video.mp4> <faces.json> [--fps 5]

Isti YuNet kao render_reel.py. Izlaz je u koordinatama #video-wrap (izvor razvučen na
visinu 1920), pa reel_layout.js sam računa gdje je lice na ekranu uz kameru (left,
zoom). Kadar se ne miče unutar snimke kamere: lice se centrira po MEDIJANU snimke,
a na rezu kamere skače — kao kamerman, bez plivanja.
"""
import argparse, json, sys, os

import numpy as np
import cv2

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import render_reel as R

OUT_W, OUT_H = 1080, 1920
MIN_FACE_H = 0.06      # lice niže od 6 % visine kadra = plakat/publika, ne govornik
REL_AREA = 0.12        # drugo lice se računa ako je ≥12 % površine najvećeg (gost + voditelj)
CUT_DIFF = 28          # isti prag reza kamere kao render_reel.py
HOLD_SEC = 1.0         # okrenuta glava: zadrži zadnje viđeno lice toliko dugo


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("video"); ap.add_argument("out")
    ap.add_argument("--fps", type=float, default=5.0, help="gustoća uzoraka za raspored")
    a = ap.parse_args()

    cap = cv2.VideoCapture(a.video)
    SW, SH = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    FPS = cap.get(cv2.CAP_PROP_FPS) or 25
    k = OUT_H / SH                      # izvor → #video-wrap
    det = cv2.FaceDetectorYN.create(R.ensure_model(), "", (640, 360), 0.7)
    sx, sy = SW / 640, SH / 360
    step = max(1, round(FPS / a.fps))

    frames, cuts, prev, n = [], [0.0], None, 0
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        t = n / FPS
        small = cv2.resize(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY), (160, 90)).astype(np.float32)
        if prev is not None and np.abs(small - prev).mean() > CUT_DIFF:
            cuts.append(t)
        prev = small
        if n % step == 0 or cuts[-1] == t:
            _, fs = det.detect(cv2.resize(fr, (640, 360)))
            boxes = []
            if fs is not None:
                fs = [f for f in fs if f[3] * sy >= MIN_FACE_H * SH]
                if fs:
                    big = max(f[2] * f[3] for f in fs)
                    boxes = [[round(f[0] * sx * k), round(f[1] * sy * k),
                              round((f[0] + f[2]) * sx * k), round((f[1] + f[3]) * sy * k)]
                             for f in fs if f[2] * f[3] >= REL_AREA * big]
            frames.append((round(t, 3), boxes))
        n += 1
    dur = n / FPS

    # rupe (okrenuta glava, ruka preko lica) popuni zadnjim viđenim, ali ne preko reza kamere
    last, last_t = [], -1e9
    for i, (t, b) in enumerate(frames):
        shot0 = max(c for c in cuts if c <= t)
        if b:
            last, last_t = b, t
        elif last and t - last_t <= HOLD_SEC and last_t >= shot0:
            frames[i] = (t, last)

    # kadriranje po snimci kamere: medijan glavnog (najvećeg) lica
    shots = []
    for i, t0 in enumerate(cuts):
        t1 = cuts[i + 1] if i + 1 < len(cuts) else dur
        main = [max(b, key=lambda r: (r[2] - r[0]) * (r[3] - r[1])) for t, b in frames if t0 <= t < t1 and b]
        if main:
            cx = float(np.median([(r[0] + r[2]) / 2 for r in main]))
            cy = float(np.median([(r[1] + r[3]) / 2 for r in main]))
        else:
            cx, cy = SW * k / 2, OUT_H * 0.3
        left = min(0.0, max(OUT_W - SW * k, OUT_W / 2 - cx))
        shots.append({"t0": round(t0, 3), "left": round(left), "ox": round(cx), "oy": round(cy)})

    json.dump({"wrap_w": round(SW * k), "wrap_h": OUT_H, "dur": round(dur, 3), "shots": shots,
               "samples": [{"t": t, "faces": b} for t, b in frames]}, open(a.out, "w"))
    nf = sum(1 for _, b in frames if b)
    print(f"{a.out}: {len(frames)} uzoraka ({nf} s licem), {len(shots)} snimki kamere, rezovi {cuts[1:]}")


if __name__ == "__main__":
    main()
