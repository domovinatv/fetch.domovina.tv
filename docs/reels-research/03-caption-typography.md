# Burned-in captions & on-screen type for 9:16 podcast clips (1080×1920, Croatian)

> Izvorni izvještaj istraživačkog subagenta (08.10.2026.), na engleskom, s izvorima.
> Sinteza na hrvatskom: `docs/2026-10-08-reels-layout-best-practices.md`.

## TL;DR

- **BBC is the only authoritative standard with explicit vertical-video rules:** for 9:16, line
  height **3.9–4.5 % of video height** → 75–86 px line on 1920 → ~62–72 px font; lines up to
  **90 % of width** (972 px); captions "a little higher up, though still generally in the lower
  third", because faces sit in the top half.
- **Croatian reading speed = 17 chars/s** (Netflix Croatian Timed Text Style Guide, adult), 42
  chars/line, 2 lines max.
- **Popular "viral" caption fonts can't spell Croatian** (cmap checked): TheBoldFont (free) lacks
  all of č ć ž š đ; Komika Axis lacks č ć ž đ; Lilita One lacks č ć đ. Montserrat, Inter, Poppins,
  Anton, Bebas Neue, Archivo Black, Figtree, Atkinson Hyperlegible pass. Anton's háček reaches
  1.10 em → tight caps line-height collides.
- Word-by-word captions are larger/shorter than broadcast: ~1–3 or 3–5 words per chunk, 70–95 px
  (vendor numbers). Research favors **phrase-level captions with the active word highlighted**
  over one-word flashes (RSVP-style).

## 1. Size, line length, chunking, reading speed

| Source | Line length | Lines | Reading speed | Duration |
|---|---|---|---|---|
| **BBC** | broadcast 37 chars; online 68 % width (16:9), **90 % width (9:16)** | 2 | **160–180 wpm** (~0.33–0.375 s/word) | min ~0.3 s/word |
| **BBC font size** | 16:9: 7–8 % of height; **9:16: 3.9–4.5 %** (ex. 4.2 %) | – | – | – |
| **Netflix EN** | 42 chars | 2 | 20 cps adult / 17 children | 5/6 s – 7 s |
| **Netflix HR** | **42 chars** | 2, prefer 1 | **17 cps adult**, 13 children | same |
| **DCMP** | mixed case, logical breaks | bottom 2 lines | edited-for-research | 40 frames – 6 s |
| **Ofcom** | – | – | 160–180 wpm (pre-recorded) | – |

Line breaks: after punctuation / before conjunctions & prepositions; never split article+noun,
adjective+noun, first+last name, auxiliary+verb; bottom-heavy pyramid; no 1–2 orphan words on top.

**Derived for 1080×1920:** BBC 4.2 % → 81 px line → ~64–72 px font.

Chars per 972 px line (90 % width), real Croatian sentence:

| Font (heavy) | 64 px mixed | 80 px mixed | 80 px CAPS |
|---|---|---|---|
| Montserrat 800 | 29 | 23 | 19 |
| Inter 800 | 32 | 25 | 21 |
| Poppins 800 | 30 | 24 | 21 |
| Figtree 800 | 33 | 27 | 21 |
| Anton | 38 | 31 | 30 |
| Bebas Neue (caps) | 46 | 37 | 37 |

→ at ≥80 px a line ≈ 20–25 chars ≈ **3–4 Croatian words**.

Mobile scaling: 1080 px full-bleed on ~390 pt phone → **1 pt ≈ 2.77 px**. Apple 11 pt ≈ 30 px;
iOS body 17 pt ≈ 47 px; WCAG large text 18 pt ≈ 66 px; bold large 14 pt ≈ 52 px.

Short-form vendor practice (directional): BlitzCut karaoke 70–85 px, 1–3 words; standard 60–75;
never <55 px; max 100. OpusClip: <42 chars, 5–7 words/line, ≤2 lines, 1.5–3 s, may lead audio
0.1–0.3 s. Submagic Hormozi: 4–6 words / 2 lines.

Karaoke: highlight paced by speech (podcasts ~150–190 wpm ≈ BBC band) → chunk must be readable
before the highlight passes: **3–5 words / ≤25 chars, 0.8–2.5 s**; for >17 cps speakers shorten
chunks or lightly edit.

Research: no eye-tracking study of karaoke captions; RSVP hurts comprehension
(https://scholarlypublishingcollective.org/uip/ajp/article/130/2/183/258180/Modern-Speed-Reading-Apps-Do-Not-Foster-Reading);
two-line captions beat word-by-word incremental for comprehension.

## 2. Styling

- **BBC:** white on black box per line, 0.5 em padding; speaker colors white / yellow #FFFF00 /
  cyan / green on black.
- **DCMP:** white, medium weight, sans, drop or rim shadow; translucent box on light backgrounds.
- **OpusClip:** black box 60–80 %, or shadow/outline on simple backgrounds.
- **Short-form:** black outline + soft shadow, no box. Scale stroke with font: **~6–10 % of font
  size** (5–9 px at 80–90 px) + soft shadow (2–4 px offset, 40–60 %, blur). (Rule of thumb.)

WCAG contrast (computed):

| Color | vs black outline/box | vs 50 % grey video | vs white (highlight distinctness) |
|---|---|---|---|
| White | 21.0 | 3.95 | – |
| Yellow #FFE600 | 16.6 | 3.12 | **1.27** |
| Yellow #FFFF00 | 19.6 | 3.68 | **1.07** |
| Lime #00FF00 | 15.3 | 2.88 | 1.37 |
| Cyan #00FFFF | 16.8 | 3.15 | 1.25 |
| Green #22C55E | 9.2 | 1.73 | 2.28 |
| Orange #FF9900 | 9.8 | 1.84 | 2.14 |
| Red #FF3B30 | 5.9 | 1.11 | 3.55 |
| Purple #8B5CF6 | 5.0 | 1.07 | 4.23 |

- Without outline/box even white on mid-grey fails 4.5:1 — the outline makes the contrast.
- Yellow/lime/cyan barely differ in luminance from white → highlight is hue-only → fails WCAG 1.4.1
  for color-blind viewers. **Add a second cue:** 105–115 % scale, pill/box behind the active word,
  or heavier weight.
- Box opacity: 60 % black over white → 5.7:1; 75 % → 10.4:1 → use ≥60 %, 70–80 % safer.

Case: DCMP prefers mixed case; caps only for shouting. Caps cost ~15–20 % chars/line and push
diacritics above cap height. **Sentence case for running captions; caps OK for 1–5 word hooks.**

Animation 2025–2026: the Hormozi package (TheBoldFont/Anton caps, yellow keywords, pop-ins, emojis,
SFX) is described as saturated; successor = word timing kept, flashing colors/SFX/emojis dropped,
clean sans, subtle fades/scale-ins (vendor/blog sources). Professional: one highlight color,
80–150 ms ease-out 100→105–110 % scale or fade, consistent position, ≤1 emphasized keyword per
chunk. Gimmicky: per-word bounce, rainbow cycling, emoji every line, shaking text, comic fonts on
serious content. Emoji: none safer for news/commentary.

## 3. Placement

- **BBC 9:16:** higher than usual but still lower third; never cover mouth or names.
- **DCMP:** never cover names, faces, mouths; move to top if needed.
- Vendors: BlitzCut 55–78 % from top; OpusClip center third, avoid top 20 % / bottom 25 %.
- **Lower-middle (~60–72 %, block center 65–70 %)**: bottom 15–35 % is covered by UI everywhere;
  center is where the face is; lower-middle stays near the mouth for read+lip-read without big eye
  jumps.
- Face-aware: caption top ≥ ~0.3 face-heights below the chin; if the face is low, move captions up.

## 4. Fonts & Croatian coverage (cmap-verified)

| Font | License | č ć ž š đ | Notes |
|---|---|---|---|
| Montserrat 700–900 | OFL | OK | Common safe default; wide |
| Inter 700–800 | OFL | OK | Compact, neutral |
| Poppins 700–800 | OFL | OK | Tall metrics (1.40 em) |
| Figtree 800, League Spartan 800 | OFL | OK | Modern geometric |
| Archivo Black | OFL | OK | Heavy, very wide |
| Anton | OFL | OK | Condensed; háček top 1.10 em → line-height ≥1.15 in caps |
| Bebas Neue | OFL | OK | Caps-only, titles |
| Atkinson Hyperlegible 700 | OFL | OK | Low-vision legibility |
| Luckiest Guy, Bangers, Titan One | OFL | OK | Comic — gimmicky for serious content |
| **Lilita One** | OFL | **missing č ć đ** | "latin-ext" yet incomplete |
| **TheBoldFont (free)** | freeware | **missing all** | 113 glyphs |
| **Komika Axis** | freeware | **missing č ć ž đ** | |

Lesson: "latin-ext" on Google Fonts ≠ Croatian coverage — test `čćžšđČĆŽŠĐ„“…` against the cmap
(fontTools). Accent heights on Č/Ć: Montserrat 0.91 em, Inter 0.95, Poppins 0.99, Anton 1.10 →
caps line-height ≥1.1 (≥1.15 Anton); leave bbox room for stroke/shadow.
Croatian punctuation (Netflix HR): „…” quotes, single "…" glyph, hyphen dialogue dashes.

## 5. Hook / title & name badges

- **Hook:** 90–120 px, 800–900, caps OK, ≤2 lines / ~6–10 words, y ≈ 13–25 % from top (never in
  top ~220–270 px), solid box or heavy outline, first 1–3 s.
- **Name badge:** name 48–60 px bold, role 34–42 px, 3–5 s on first appearance, never stacked on
  captions.
- **Floors:** smallest secondary text ≥ **48 px** (absolute ~30 px); dialogue ≥ 55–66 px. Avoid
  thin weights (DCMP: medium minimum).

## 6. Accessibility

- WCAG 1.4.3: 4.5:1 normal / 3:1 large (≥18 pt or 14 pt bold) — burned-in captions count. Aim
  4.5:1 vs worst frame (outline or ≥60 % box). Don't rely on color alone (1.4.1).
- WCAG 2.3.1 flashing: ≤3 flashes/s above thresholds over >~25 % of a 10° field — avoid large
  color-toggling boxes, esp. saturated red.
- "99 % accuracy" is an industry convention (DCMP, vendors), not WCAG. For Croatian ASR, hand-check
  names, numbers, diacritics ("kuca" vs "kuća").
- **Filler words:** BBC — remove "ums and ers" in factual content unless characterizing; DCMP —
  editing OK if meaning kept; OpusClip/Descript remove by default (Descript can remove from
  captions only). **Consensus: drop pure fillers from captions ("ovaj", "znači", "ono", "hmm",
  "ee") even if kept in audio;** keep meaningful hesitation as "…"; in karaoke let the highlight
  skip the filler's span.

## 7. Safe margins (1080×1920)

| Source | Top | Bottom | Left | Right |
|---|---|---|---|---|
| TikTok organic (Ignite) | 108 | 320 | 60 | 120 |
| Instagram boosted (Ignite) | 220 | 420 | 1010×1280 box | – |
| TikTok ads (Upload-Post) | 240 | 660 | 120 | 120 |
| Reels ads (Meta) | 269 | 672 | 65 | 65 |
| Shorts ads (Google) | 288 | 672 | 48 | 192 |
| Shorts organic (BlitzCut) | ~120 | ~300 | – | ~48 |
| Adaptlypost "universal" | 900×1400 centered (260 top/bottom, 90 sides) | | | |

Practical organic box (this report): x 90–990 (right ≤ ~960), **y 250–1400**; captions centered
y ≈ 1250–1350; hooks y ≈ 280–480; nothing in the bottom ~520 px.
(Stricter ad-spec intersection in `01-platform-safe-zones.md`: y ≤ 1248.)

## Recommended spec (Croatian podcast reels)

| Parameter | Recommendation |
|---|---|
| Font | Montserrat 800 / Inter 800 / Figtree 800 (OFL); Atkinson Hyperlegible 700 for accessibility. **Avoid TheBoldFont, Komika Axis, Lilita One.** Verify cmap |
| Case | Sentence case captions; caps only for 1–5 word hooks |
| Caption size | 72–88 px (floor 64) |
| Line height | 1.1–1.2 (≥1.15 Anton / caps with háčeks) |
| Words per chunk | 3–5, ≤25 chars/line, 1 line preferred, 2 max |
| Chunk duration | 0.8–2.5 s, never >7 s; split above 17 cps |
| Active-word highlight | One color (e.g. #FFE600) **plus** non-color cue (105–110 % scale or pill), 80–150 ms ease-out |
| Outline | Black, ~6–10 % of font size, round joins |
| Shadow | soft 2–4 px, 40–60 %, blur — or 70–80 % box with 0.5 em padding |
| Contrast | ≥4.5:1 vs worst frame; no >3 flashes/s over large areas |
| Vertical position | Block center ~65–70 % (y ≈ 1250–1350); never over mouth; move up if face low |
| Safe area | x 90–990 (right ≤ ~960), y 250–1400 |
| Hook | 90–120 px, 800–900, ≤2 lines, ≤10 words, y ≈ 280–480, box or heavy outline, first 1–3 s |
| Name badge | 48–60 px name, 34–42 px role, 3–5 s, not overlapping captions |
| Smallest text | ≥48 px (floor ~30) |
| Fillers | Remove pure fillers from captions; "…" for meaningful hesitation |
| Emoji / animation | None (or one per punchline outside captions); no per-word bounce/color cycling |
| Punctuation | „…”, single "…", accurate diacritics |

## Sources

Standards: BBC https://www.bbc.co.uk/accessibility/forproducts/guides/subtitles/ ·
Netflix EN https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide ·
Netflix General https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements ·
Netflix HR https://partnerhelp.netflixstudios.com/hc/en-us/articles/115002790368 ·
DCMP https://dcmp.org/learn/597-captioning-key---text · https://dcmp.org/learn/601-captioning-key---presentation-rate ·
WCAG https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html ·
https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html ·
Ofcom summary https://liamodell.com/2023/07/15/ofcom-tv-access-services-code-guidelines-consultation-subtitles-sign-language-audio-description ·
Apple HIG https://developer.apple.com/design/human-interface-guidelines/typography

Tools: https://www.submagic.co/blog/how-to-make-alex-hormozi-captions ·
https://www.opus.pro/blog/youtube-shorts-caption-subtitle-best-practices ·
https://blitzcutai.com/blog/best-caption-size-youtube-shorts-2026 ·
https://help.descript.com/hc/en-us/articles/10164806394509-Remove-filler-words ·
https://feedback.descript.com/feature-requests/p/remove-filler-words-in-captions-but-not-in-the-audio

Safe zones: https://www.ignitesocialmedia.com/content-creation/what-are-the-safe-zones-for-tiktoks-and-instagram-reels/ ·
https://www.upload-post.com/tools/safe-zone-checker/ · https://adaptlypost.com/blog/social-media-safe-zones-2026-complete-guide

Research/trends: https://www.3playmedia.com/blog/verizon-media-and-publicis-media-find-viewers-want-captions/ ·
https://joyspace.ai/hormozi-editing-style-2026-analysis · https://blitzcutai.com/blog/tiktok-caption-trends-2026 ·
https://videobuilders.beehiiv.com/p/hormozi-captions

Own measurements: glyph coverage, advance widths, accent heights via fontTools on Google Fonts /
dafont files; contrast via WCAG formula.
