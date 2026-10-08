#!/usr/bin/env python3
"""Reel / isječak: 16:9 epizoda → 9:16 video s titlom riječ po riječ.

Jedan poziv = jedan reel. Bez LLM-a i bez plaćenog API-ja — sve lokalno:
  1. dio epizode u 1080p (yt-dlp --download-sections, samo traženi raspon),
  2. riječi s vremenom iz kanonskog SRT-a + words.json (KORAK 9.87, par 1:1),
  3. granice reela se pomaknu na najbliže granice cue-a (ne reže usred rečenice),
  4. kadar prati lice (OpenCV YuNet), mirno: deadzone + EMA, skok samo na rezu kamere,
  5. govornik u panelu, oko njega isti kadar zamućen i zatamnjen,
  6. titl ≤3 riječi, aktivna riječ žuta; naslov + bedž + potpis,
  7. h264 + AAC, faststart.

Raspored („v2“): sav tekst je u sigurnoj zoni y≈260–1600 od 1920 — iznad su
kontrole playera (WhatsApp iOS, TikTok, Reels), ispod emoji/reply/opis. Titl
stoji preko ruku i mikrofona, nikad preko lica. Zoom ×1.09 (prva verzija je
rezala cijeli ekran na ×1.78 — preuzak kadar, mekša slika, tekst pod kontrolama).

    python3 tools/render_reel.py <diarized.srt> <words.json> <start> <end> <out.mp4>
        --title "Naslov reela" --badge "Mladen Barać · Domovinski pokret"
        --footer "Cijeli razgovor na domovina.ai · Mladi za domovinu #113"
        (--youtube-id ID | --segment dio.mp4 --segment-start SEK)

`start`/`end` su sekunde ili HH:MM:SS u epizodi. Bez `--segment` skripta sama
skine traženi raspon s YouTubea (1080p H.264). Ovisnosti:
`pip install opencv-python-headless numpy pillow`, ffmpeg, yt-dlp. Model za lica
(YuNet, MIT, 230 KB) se skine sam u ~/.cache/domovina-reels/.
Fontovi su macOS (Arial / Arial Black) — na drugom sustavu zadaj `--font-dir`.
"""
import argparse, json, os, re, subprocess, sys, tempfile, urllib.request

import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont

YUNET_URL = ("https://github.com/opencv/opencv_zoo/raw/main/models/"
             "face_detection_yunet/face_detection_yunet_2023mar.onnx")
W, H = 1080, 1920
PANEL_Y, PANEL_H = 500, 1180          # govornik u panelu 1080×1180
FEATHER = 60                          # meki rub panela (px)
CAP_Y0, CAP_Y1 = 1300, 1520           # titl: preko ruku/mikrofona, ne preko lica
YELLOW, WHITE = (255, 212, 0, 255), (255, 255, 255, 255)


def to_sec(v):
    if re.fullmatch(r"[\d.]+", v):
        return float(v)
    p = [float(x) for x in v.replace(",", ".").split(":")]
    return sum(x * 60 ** i for i, x in enumerate(reversed(p)))


def ensure_model():
    path = os.path.expanduser("~/.cache/domovina-reels/yunet_2023mar.onnx")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        print(f"skidam YuNet → {path}")
        urllib.request.urlretrieve(YUNET_URL, path)
    return path


def fetch_segment(yt_id, a, b, out):
    """Samo traženi raspon u 1080p H.264; rez na točnom vremenu (keyframe na rezu)."""
    subprocess.run(["yt-dlp", "-q", "--no-warnings",
                    "-f", "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[height<=1080]",
                    "--download-sections", f"*{a:.2f}-{b:.2f}", "--force-keyframes-at-cuts",
                    "--merge-output-format", "mp4", "-o", out,
                    f"https://www.youtube.com/watch?v={yt_id}"], check=True)


def probe(src):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height,r_frame_rate", "-of", "json", src],
                       capture_output=True, text=True, check=True)
    s = json.loads(r.stdout)["streams"][0]
    n, d = s["r_frame_rate"].split("/")
    return s["width"], s["height"], float(n) / float(d)


def load_words(srt_p, words_p):
    """Tokeni iz kanonskog SRT-a, vremena iz words.json — isti cue-ovi, isti redoslijed."""
    cues = []
    for block in re.split(r"\r?\n\s*\r?\n", open(srt_p, encoding="utf-8").read().strip()):
        l = block.strip().split("\n")
        if len(l) < 3:
            continue
        t = " ".join(x.strip() for x in l[2:]).strip()
        if not re.match(r"^\[\w+\]", t):
            continue
        cues.append(re.sub(r"^\[\w+\]", "", t).split())
    wj = json.load(open(words_p))["cues"]
    if len(wj) != len(cues):
        sys.exit(f"SRT ({len(cues)} cue-ova) i words.json ({len(wj)}) nisu par")
    words = []
    for toks, c in zip(cues, wj):
        w = c["w"]
        for i, tok in enumerate(toks):
            words.append((tok, w[2 * i] / 1000, w[2 * i + 1] / 1000))
    return words, [c["s"] / 1000 for c in wj], [c["e"] / 1000 for c in wj]


def make_chunks(rw, r_s):
    """Titl-komadi: ≤3 riječi / ≤20 znakova, lom na interpunkciji ili pauzi >0.35 s."""
    chunks, cur = [], []
    for w in rw:
        if cur and (len(cur) >= 3 or len(" ".join(x[0] for x in cur + [w])) > 20
                    or re.search(r"[.,?!:;]$", cur[-1][0]) or w[1] - cur[-1][2] > 0.35):
            chunks.append(cur)
            cur = []
        cur.append(w)
    if cur:
        chunks.append(cur)
    spans = []
    for k, ch in enumerate(chunks):
        b = chunks[k + 1][0][1] if k + 1 < len(chunks) else ch[-1][2] + 0.4
        spans.append((ch[0][1] - r_s, min(b, ch[-1][2] + 0.6) - r_s, ch))
    return spans


def wrap(draw, text, font, maxw):
    lines, line = [], ""
    for word in text.split():
        t = (line + " " + word).strip()
        if draw.textlength(t, font=font) <= maxw:
            line = t
        else:
            lines.append(line)
            line = word
    return lines + [line]


def static_overlay(title, badge, footer, f_bold):
    """Naslov + bedž odmah iznad panela (odozdo prema gore), potpis na dnu panela."""
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    ft, fb = ImageFont.truetype(f_bold, 62), ImageFont.truetype(f_bold, 34)
    tl = wrap(d, title, ft, 960)
    by1 = PANEL_Y - 18
    by0 = by1 - 56
    y = by0 - 14 - 74 * len(tl)
    for line in tl:
        d.text(((W - d.textlength(line, font=ft)) / 2, y), line, font=ft, fill=WHITE,
               stroke_width=3, stroke_fill=(0, 0, 0, 255))
        y += 74
    if badge:
        bw = d.textlength(badge, font=fb)
        d.rounded_rectangle(((W - bw) / 2 - 22, by0, (W + bw) / 2 + 22, by1), 28, fill=(255, 212, 0, 240))
        d.text(((W - bw) / 2, by0 + 8), badge, font=fb, fill=(20, 20, 20, 255))
    if footer:
        d.text(((W - d.textlength(footer, font=fb)) / 2, PANEL_Y + PANEL_H - 125), footer, font=fb,
               fill=WHITE, stroke_width=3, stroke_fill=(0, 0, 0, 220))
    a = np.asarray(im).astype(np.float32)
    rows = np.where(a[:, :, 3].max(axis=1) > 0)[0]
    y0, y1 = rows.min(), rows.max() + 1
    return y0, a[y0:y1, :, :3], a[y0:y1, :, 3:] / 255


def blend(base, y0, rgb, a):
    reg = base[y0:y0 + rgb.shape[0]].astype(np.float32)
    base[y0:y0 + rgb.shape[0]] = (reg * (1 - a) + rgb * a).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("srt"); ap.add_argument("words"); ap.add_argument("start"); ap.add_argument("end")
    ap.add_argument("out")
    ap.add_argument("--title", required=True)
    ap.add_argument("--badge", default="")
    ap.add_argument("--footer", default="")
    ap.add_argument("--youtube-id")
    ap.add_argument("--segment", help="već skinuti dio epizode (umjesto --youtube-id)")
    ap.add_argument("--segment-start", type=float, default=0.0, help="sekunda epizode na t=0 segmenta")
    ap.add_argument("--font-dir", default="/System/Library/Fonts/Supplemental")
    args = ap.parse_args()

    f_cap = os.path.join(args.font_dir, "Arial Black.ttf")
    f_bold = os.path.join(args.font_dir, "Arial Bold.ttf")
    words, starts, ends = load_words(args.srt, args.words)

    # reel granice = granice cue-ova najbližih traženim vremenima
    r_s = min(starts, key=lambda x: abs(x - to_sec(args.start))) - 0.12
    r_e = min(ends, key=lambda x: abs(x - to_sec(args.end))) + 0.45
    dur = r_e - r_s
    spans = make_chunks([w for w in words if r_s - 0.05 <= w[1] < r_e - 0.2], r_s)

    tmp = None
    if args.segment:
        src, seg_start = args.segment, args.segment_start
    elif args.youtube_id:
        tmp = tempfile.mkdtemp(prefix="reel_")
        src, seg_start = os.path.join(tmp, "seg.mp4"), max(0.0, r_s - 2)
        fetch_segment(args.youtube_id, seg_start, r_e + 2, src)
    else:
        sys.exit("treba --youtube-id ili --segment")

    SW, SH, FPS = probe(src)
    crop_w = round(SH * W / PANEL_H)
    S_Y0, s_rgb, s_a = static_overlay(args.title, args.badge, args.footer, f_bold)
    panel_mask = np.ones((PANEL_H, 1), np.float32)
    for i in range(FEATHER):
        panel_mask[i] = panel_mask[PANEL_H - 1 - i] = (i / FEATHER) ** 1.5
    panel_mask = panel_mask[:, :, None]

    cap_cache = {}

    def caption(k, active):
        if (k, active) in cap_cache:
            return cap_cache[(k, active)]
        toks = [w[0] for w in spans[k][2]]
        size = 84
        while True:
            f = ImageFont.truetype(f_cap, size)
            im = Image.new("RGBA", (W, CAP_Y1 - CAP_Y0), (0, 0, 0, 0))
            dd = ImageDraw.Draw(im)
            sp = dd.textlength(" ", font=f)
            total = sum(dd.textlength(t, font=f) for t in toks) + sp * (len(toks) - 1)
            if total <= 980 or size <= 56:
                break
            size -= 4
        x, yy = (W - total) / 2, (CAP_Y1 - CAP_Y0 - size) / 2
        for i, t in enumerate(toks):
            dd.text((x, yy), t, font=f, fill=YELLOW if i == active else WHITE,
                    stroke_width=9, stroke_fill=(0, 0, 0, 255))
            x += dd.textlength(t, font=f) + sp
        a = np.asarray(im).astype(np.float32)
        cap_cache[(k, active)] = (a[:, :, :3], a[:, :, 3:] / 255)
        return cap_cache[(k, active)]

    det = cv2.FaceDetectorYN.create(ensure_model(), "", (640, 360), 0.7)
    sx = SW / 640

    def face_cx(frame):
        _, faces = det.detect(cv2.cvtColor(cv2.resize(frame, (640, 360)), cv2.COLOR_RGB2BGR))
        if faces is None or len(faces) == 0:
            return None
        f = max(faces, key=lambda r: r[2] * r[3])
        return (f[0] + f[2] / 2) * sx

    ss = r_s - seg_start
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", f"{ss:.3f}", "-i", src, "-t", f"{dur:.3f}",
                            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    vcodec = ["-c:v", "h264_videotoolbox", "-b:v", "6M", "-profile:v", "high"] if sys.platform == "darwin" \
        else ["-c:v", "libx264", "-crf", "20", "-preset", "medium"]
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y",
                            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", f"{FPS}", "-i", "-",
                            "-ss", f"{ss:.3f}", "-t", f"{dur:.3f}", "-i", src,
                            "-map", "0:v", "-map", "1:a", *vcodec, "-pix_fmt", "yuv420p",
                            "-af", f"afade=t=in:d=0.12,afade=t=out:st={dur - 0.45:.3f}:d=0.45",
                            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", args.out],
                           stdin=subprocess.PIPE)

    cx, prev_small, n, k = None, None, 0, 0
    fsize = SW * SH * 3
    bx0, bw = int(SW / 2 - SH * 9 / 32), int(SH * 9 / 16)
    while True:
        buf = dec.stdout.read(fsize)
        if len(buf) < fsize:
            break
        fr = np.frombuffer(buf, np.uint8).reshape(SH, SW, 3)
        t = n / FPS
        # rez kamere = nagla promjena malog sivog kadra → kadar skače, ne klizi
        small = cv2.resize(cv2.cvtColor(fr, cv2.COLOR_RGB2GRAY), (160, 90)).astype(np.float32)
        cut = prev_small is not None and np.abs(small - prev_small).mean() > 28
        prev_small = small
        if cx is None or cut or n % 2 == 0:
            tgt = face_cx(fr)
            if tgt is not None:
                if cx is None or cut:
                    cx = tgt
                elif abs(tgt - cx) > 30:      # deadzone: sitni pomaci glave ne miču kadar
                    cx += 0.07 * (tgt - cx)   # EMA: mirno klizanje
        c = cx if cx is not None else SW / 2
        x0 = int(min(max(c - crop_w / 2, 0), SW - crop_w))
        # pozadina: cijeli kadar, cover na 9:16, jako zamućen i zatamnjen (jeftino, na malom)
        bg = cv2.resize(fr[:, bx0:bx0 + bw], (135, 240), interpolation=cv2.INTER_AREA)
        bg = cv2.GaussianBlur(bg, (0, 0), 6) * 0.45
        out_f = cv2.resize(bg, (W, H), interpolation=cv2.INTER_LINEAR).astype(np.float32)
        panel = cv2.resize(fr[:, x0:x0 + crop_w], (W, PANEL_H), interpolation=cv2.INTER_LANCZOS4)
        reg = out_f[PANEL_Y:PANEL_Y + PANEL_H]
        out_f[PANEL_Y:PANEL_Y + PANEL_H] = reg * (1 - panel_mask) + panel.astype(np.float32) * panel_mask
        out_f = np.ascontiguousarray(out_f.astype(np.uint8))
        blend(out_f, S_Y0, s_rgb, s_a)
        while k + 1 < len(spans) and t >= spans[k + 1][0]:
            k += 1
        if spans and spans[k][0] <= t < spans[k][1]:
            ch = spans[k][2]
            act = max(i for i, w in enumerate(ch) if w[1] - r_s <= t or i == 0)
            blend(out_f, CAP_Y0, *caption(k, act))
        enc.stdin.write(out_f.tobytes())
        n += 1
    enc.stdin.close()
    enc.wait()
    print(f"{args.out}: {n} frameova, {dur:.1f}s, {len(spans)} titl-komada, ep {r_s:.2f}-{r_e:.2f}")


if __name__ == "__main__":
    main()
