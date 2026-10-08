#!/usr/bin/env python3
"""Slika rasporeda reela (1080×1920): zone koje UI mreža pokriva + preporučeni raspored.

Brojke su iz docs/2026-10-08-reels-layout-best-practices.md (sinteza) i
docs/reels-research/01-platform-safe-zones.md (službeni overlayi Mete, Googlea, TikToka).

    python3 tools/reels_layout_guide.py docs/reels-research/reels-layout-guide.png
    python3 tools/reels_layout_guide.py out.png --frame kadar.png   # zone preko stvarnog kadra

Bez `--frame` crta generičku siluetu (bez sadržaja ijednog kanala). S `--frame` crta
samo zone i ravnalo preko gotovog 1080×1920 kadra (npr. frame iz render_reel.py), da se
vidi što od postojećeg rasporeda pada pod UI. Ovisnosti: pillow.
"""
import argparse, os, sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
# Univerzalna sigurna zona = presjek službenih overlaya (YouTube PNG, Meta %, TikTok vodič)
TOP, BOTTOM = 288, 1248          # iznad / ispod toga UI (gornja traka; opis, ime, CTA, scrubber)
LEFT, RIGHT = 120, 888           # TikTok lijevo 120; YouTube desna traka akcija od x 888
RAIL_Y, RAIL_X = 840, 780        # TikTok traka akcija: od y 840 nadolje već od x 780
COVER_1x1 = (420, 1500)          # najgori rez naslovnice (1:1 centar)
COVER_3x4 = (240, 1680)          # Instagram grid 3:4

FONT_DIRS = [os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "branding", "fonts"),
             "/System/Library/Fonts/Supplemental"]


def font(names, size):
    for d in FONT_DIRS:
        for n in names:
            p = os.path.join(d, n)
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
    return ImageFont.load_default()


F_BLACK = lambda s: font(["Montserrat-Black.ttf", "Arial Black.ttf"], s)
F_BOLD = lambda s: font(["Montserrat-Bold.ttf", "Arial Bold.ttf"], s)
NOTE = (0, 220, 255, 255)        # anotacije (nisu dio reela)
RED = (255, 40, 40)


def hatch(im, box, alpha=70, step=26, color=RED):
    """Crveno šrafirano: UI mreže pokriva ovaj dio."""
    x0, y0, x1, y1 = box
    ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    d.rectangle(box, fill=color + (alpha,))
    for k in range(-(y1 - y0), x1 - x0, step):
        d.line([(x0 + k, y0), (x0 + k + (y1 - y0), y1)], fill=color + (alpha + 50,), width=3)
    ov = ov.crop((0, 0, W, H))
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rectangle(box, fill=255)
    im.paste(Image.alpha_composite(im, ov), (0, 0), mask)


def dashed(d, y, color, label, f, x0=0, x1=W, dash=18):
    for x in range(x0, x1, dash * 2):
        d.line([(x, y), (min(x + dash, x1), y)], fill=color, width=3)
    d.text((x1 - 8 - d.textlength(label, font=f), y + 6), label, font=f, fill=color)


def note(d, xy, text, f, anchor="la"):
    d.text(xy, text, font=f, fill=NOTE, anchor=anchor, stroke_width=3, stroke_fill=(0, 0, 0, 255))


def silhouette(im):
    """Generički govornik: puni kadar, oči na y≈700 (gornja trećina)."""
    d = ImageDraw.Draw(im)
    for y in range(H):                                   # tamna studijska pozadina
        c = int(38 + 22 * (y / H))
        d.line([(0, y), (W, y)], fill=(c, c + 4, c + 12, 255))
    d.ellipse((160, 1020, 920, 2300), fill=(70, 78, 92, 255))      # ramena/torzo
    d.rectangle((470, 880, 610, 1060), fill=(150, 125, 110, 255))  # vrat
    d.ellipse((380, 500, 700, 900), fill=(178, 148, 128, 255))     # glava
    d.ellipse((370, 470, 710, 640), fill=(55, 45, 40, 255))        # kosa
    d.ellipse((380, 500, 700, 900), outline=(0, 0, 0, 0))
    for ex in (480, 600):                                          # oči na y≈700
        d.ellipse((ex - 16, 690, ex + 16, 712), fill=(40, 40, 40, 255))


def platform_ui(d, f):
    """Skica UI-ja mreže (sivo): gornja traka, desna traka akcija, opis i korisnik dolje."""
    g = (235, 235, 235, 200)
    d.text((W // 2, 150), "Reels  ·  Za tebe", font=f, fill=g, anchor="mm")
    for i, y in enumerate((1180, 1330, 1480, 1630)):               # srce, komentar, dijeli, zvuk
        d.ellipse((960, y, 1040, y + 80), outline=g, width=5)
    d.ellipse((60, 1640, 130, 1710), outline=g, width=5)
    d.text((150, 1652), "@kanal  · Prati", font=f, fill=g)
    d.text((60, 1730), "Opis objave koji se širi prema gore…", font=f, fill=g)
    d.rectangle((0, 1880, W, 1886), fill=g)                        # scrubber


def recommended(im, f_note):
    d = ImageDraw.Draw(im)
    # 1. logo kanala — gornji lijevi kut sigurne zone
    d.rounded_rectangle((LEFT, 304, LEFT + 220, 384), 14, fill=(255, 255, 255, 235))
    d.text((LEFT + 110, 344), "LOGO KANALA", font=F_BLACK(26), fill=(20, 30, 60), anchor="mm")
    # 2. potpis tehnologije — isti red, desno, manji
    d.rounded_rectangle((560, 312, RIGHT, 376), 32, fill=(8, 12, 22, 220))
    d.rounded_rectangle((574, 322, 618, 366), 8, fill=(255, 255, 255, 255))
    d.text((596, 344), "D", font=F_BLACK(28), fill=(0, 47, 108), anchor="mm")
    d.text((630, 344), "Napravljeno s domovina.ai", font=F_BOLD(22), fill=(255, 255, 255), anchor="lm")
    # 3. hook / naslov — ≤ 2 retka, kutija
    ft = F_BLACK(60)
    d.rounded_rectangle((LEFT, 404, RIGHT, 566), 22, fill=(0, 0, 0, 170))
    d.text((W // 2 - 48, 446), "Najjača rečenica", font=ft, fill=(255, 255, 255), anchor="mm")
    d.text((W // 2 - 48, 522), "kao hook, 2 retka", font=ft, fill=(255, 255, 255), anchor="mm")
    # 4. ime gosta — iznad titla, prve 3–5 s
    d.rounded_rectangle((LEFT, 896, LEFT + 470, 966), 35, fill=(255, 212, 0, 245))
    d.text((LEFT + 30, 931), "Ime Prezime · uloga", font=F_BOLD(34), fill=(20, 20, 20), anchor="lm")
    # 5. titl — riječ po riječ, 3–5 riječi, aktivna riječ istaknuta
    fc = F_BLACK(80)
    words, act = ["riječ", "po", "riječ"], 0
    sp = d.textlength(" ", font=fc)
    tw = sum(d.textlength(w, font=fc) for w in words) + sp * (len(words) - 1)
    x, y = (W - tw) / 2, 1130          # centrirano na x 540, unutar x 200–880
    for i, w in enumerate(words):
        d.text((x, y), w, font=fc, fill=(255, 212, 0) if i == act else (255, 255, 255),
               anchor="lm", stroke_width=8, stroke_fill=(0, 0, 0))
        x += d.textlength(w, font=fc) + sp


def zones(im, f_note, f_small, overlay_only=False):
    hatch(im, (0, 0, W, TOP))
    hatch(im, (0, BOTTOM, W, H))
    hatch(im, (RIGHT, TOP, W, BOTTOM))
    hatch(im, (RAIL_X, RAIL_Y, RIGHT, BOTTOM), alpha=40, color=(255, 140, 0))
    hatch(im, (0, TOP, LEFT, BOTTOM), alpha=25, color=(255, 140, 0))
    d = ImageDraw.Draw(im)
    d.rectangle((LEFT, TOP, RIGHT, BOTTOM), outline=(60, 255, 120, 255), width=5)
    dashed(d, COVER_1x1[0], (255, 255, 255, 230), "", f_small, x0=LEFT, x1=RIGHT)
    dashed(d, COVER_1x1[1], (255, 255, 255, 230), "", f_small, x0=LEFT, x1=RIGHT)
    for y, t in ((COVER_1x1[0], "1:1 rez"), (COVER_1x1[1], "1:1 rez")):
        note(d, (RIGHT + 96, y), t, f_small, "mm")
    # ravnalo lijevo
    for y in (0, TOP, RAIL_Y, BOTTOM, H - 1):
        d.line([(0, y), (40, y)], fill=NOTE, width=4)
        note(d, (46, y + (4 if y < H - 40 else -34)), str(y if y < H - 1 else H), f_small)
    note(d, (W // 2, 232), "GORE: UI mreže (traka, oznake) · 0–288", f_note, "mm")
    note(d, (W // 2, BOTTOM + 40), "DOLJE: opis, @kanal, CTA, scrubber · 1248–1920", f_note, "mm")
    note(d, (W // 2, BOTTOM + 84), "nikakav tekst ni logo — pokriveno na svim mrežama", f_small, "mm")
    d.text((RIGHT + 96, 640), "traka akcija", font=f_small, fill=NOTE, anchor="mm",
           stroke_width=3, stroke_fill=(0, 0, 0))
    d.text((RIGHT + 96, 672), "x > 888", font=f_small, fill=NOTE, anchor="mm",
           stroke_width=3, stroke_fill=(0, 0, 0))
    note(d, (W // 2, TOP - 22), "SIGURNA ZONA x 120–888 · y 288–1248", f_small, "mm")
    if not overlay_only:
        note(d, (RIGHT - 8, 386), "potpis tehnologije", f_small, "ra")
        note(d, (LEFT + 228, 344), "← logo", f_small, "lm")
        note(d, (W // 2, 590), "hook: y 400–566, ≤ 2 retka, prve 3 s ili cijelo vrijeme", f_small, "mm")
        note(d, (840, 760), "oči ≈ y 700", f_small, "ra")
        note(d, (LEFT + 480, 931), "← prve 3–5 s", f_small, "lm")
        note(d, (W // 2, 1222), "titl: y 1040–1230, x 200–880, 3–5 riječi, 72–88 px", f_small, "mm")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out")
    ap.add_argument("--frame", help="gotov 1080×1920 kadar: crtaj samo zone preko njega")
    a = ap.parse_args()
    f_note, f_small = F_BOLD(30), F_BOLD(24)
    if a.frame:
        im = Image.open(a.frame).convert("RGBA").resize((W, H))
        zones(im, f_note, f_small, overlay_only=True)
    else:
        im = Image.new("RGBA", (W, H))
        silhouette(im)
        platform_ui(ImageDraw.Draw(im), F_BOLD(30))
        recommended(im, f_note)
        zones(im, f_note, f_small)
    im.convert("RGB").save(a.out, quality=92)
    print(a.out)


if __name__ == "__main__":
    main()
