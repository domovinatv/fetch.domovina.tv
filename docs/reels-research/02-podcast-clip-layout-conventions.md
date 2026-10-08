# Vertical podcast clip layout — what tools & designers converged on (2025–2026)

> Izvorni izvještaj istraživačkog subagenta (08.10.2026.), na engleskom, s izvorima.
> Sinteza na hrvatskom: `docs/2026-10-08-reels-layout-best-practices.md`.

**Bottom line:** for 2-person podcasts the professional default in 2025–2026 is a **full-bleed,
face-tracked close-up of the active speaker**, switching to a **stacked split only for genuine
back-and-forth**, with all text/branding inside the cross-platform safe zone. The letterboxed
16:9-with-headline style is still common on aggregator/fan-clip channels but reads as the
lower-effort option; use it only briefly for wide/group moments. Caveat: **no independent A/B
study on layout** exists — the only authoritative numbers are platform (ad-spec) safe zones;
most other advice comes from tool vendors.

## 1. Layout archetypes

| Archetype | What it is | When pros use it | Verdict |
|---|---|---|---|
| **Full-bleed reframed speaker** ("Fill") | 9:16 crop following active speaker's face | One person storytelling/explaining — the base layout | **Strong consensus default.** Big face = strongest scroll-stopper |
| **Stacked split** (host top / guest bottom) | Two ~1080×960 panels | Rapid exchanges, jokes/comebacks, disagreements | **Situational, not whole-clip.** In a monologue the silent half is wasted |
| **Letterbox / "Fit"** | 16:9 (or 4:3) band, blurred/colored/black fill, headline in top fill | Group reactions, set matters, B-roll, screen content | **Weaker.** Small faces, "looks recycled"; Cut.Pro: keep to 2–3 s. Common on clip/fan channels |
| **Active-speaker switching** | Fill with cuts timed to turn changes | Standard way to run Fill on 2+ people | Cut at start of new speaker's sentence; ignore "mm-hm"/laughs; never switch twice within ~1 s — use split instead |
| **Reaction cutaway** | 1–2 s listener face | Only when reaction carries the moment | Fine as spice |
| **B-roll / auto-zoom** | Transcript-keyed stock/GIF/zoom punch-ins | Pattern interrupts | Vendor claims a change every 3–7 s keeps attention (unsourced); heavy stock B-roll is an "AI-clip" tell |

Most-cited mistake: one layout for the whole clip. Decide per moment by "who needs to be seen".
If a clip would open on a small-face split, open full-screen and split later. 3-band splits rarely
work on phones.

**Width math:** a 9:16 crop from 16:9 at full height keeps ~⅓ of the width (608 of 1920 px). Both
people in one frame = tiny faces; one person cropped from a 1080p wide shot = ~400–600 px source
upscaled ~2× = soft. Pros shoot 4K or a dedicated close-up camera.

**Retention numbers:** average Shorts retention ~73% (Socialinsider, Nov 2025); ~80% still
watching at 3 s (cited benchmarks); vendor claim (unsourced): viral podcast clips keep 60–80%
through 5 s, 40–60% to the end, <50% at 5 s caps reach. None compare layouts.

## 2. Vertical zoning on 1080×1920

**Platform UI no-go zones (official, ad specs):**

| | Top | Bottom | Left | Right |
|---|---|---|---|---|
| TikTok | 240 px (12.5%) | 660 px (34%) | 120 px | 120 px (action rail ~300 px wide from y≈840 down) |
| Instagram Reels (Meta: 14% top, 35% bottom, 6% sides) | 269 px | 672 px | 65 px | 65 px |
| YouTube Shorts | 288 px (15%) | 672 px (35%) | 48 px | 192 px |
| **Union (worst case per side)** | **288 px** | **672 px** | **120 px** | **192 px** |

→ Universal visible box **x 120–888, y 288–1248**; below y≈840 keep things left of x≈780 (TikTok
rail). Longer post captions creep up further.

**Recommended zoning — full-bleed speaker frame (synthesis):**

| Element | Placement on 1080×1920 | Basis / confidence |
|---|---|---|
| **Hook / title** | y ≈ 300–560 (16–29%), centered, ≤2 lines, boxed or heavy stroke | Strong (below 288 top UI). **Duration on screen unsettled** — first 3–5 s vs whole clip both common |
| **Eye line** | y ≈ 640–800 (33–42%); with hook above, push to ≈720–820 | Moderate (rule of thirds; faces inside 288–1248) |
| **Captions** | y ≈ 1000–1240 (52–65%), just below chin, never below 1248; 1–2 lines centered | **Strong** — Cut.Pro "just below the chin", Opus "center third, avoid top 20%/bottom 25%" |
| **Guest name badge** | Above captions / chin level, y ≈ 880–1000, left-aligned from x≥120; first ~2–4 s, then out | Moderate. Broadcast lower third (bottom 10–15%) **sits in UI no-go on all platforms** |
| **Channel logo** | Top-left/right corner, ~80–130 px wide (8–12% width), y 290–400, or beside/under hook | Moderate |
| **"Made with partner" credit** | ~22–28 px, 50–70% opacity, under logo or just above y 1248 left, or end card only | Weak — no published standard; smallest element on screen |
| **CTA** | Spoken, or caption-zone text in last 2–3 s; never bottom 35% | Moderate |

**Split adjustments:** captions on the seam (y 960). Trap: a centrally framed bottom face puts
eyes at y≈1440 (UI zone) — frame bottom speaker high (eyes ≈1080–1150) or asymmetric split
(top 0–900, bottom 900–1500, empty/branded band below). Different caption color per speaker.
**Letterbox:** band 1080×608 at y≈560–1168; hook in top fill (300–540); captions right under band.

## 3. Tool defaults

- **Opus Clip:** 7 layouts — Fill, Fit (4:3 + padding), Split (only if both visible in source),
  Three, Four, Screenshare, Gameplay; brand template sets allowed layouts, AI applies per segment.
  Caption guide: center third, 5–7 words/line, ≤2 lines, bold sans, white on 60–80% black box,
  white/yellow per speaker.
- **Riverside** Magic Clips/Editor: smart-speaker layouts (sidebar, overlay, ⅔+⅓ splits).
- **Vizard:** Auto Speaker Focus. **Kapwing:** Speaker Focus + blurred-canvas Fit; Smart Cut.
- **Submagic:** caption-first, Y-position slider, Magic B-rolls, auto-zooms.
- **Captions (captions.ai):** mobile-first shorts, eye-contact correction.
- **VEED** (Sieve), **Descript** (no vertical split template), **Headliner** (audiogram — dated
  for video podcasts), **CapCut** (recognizable split/letterbox templates — works against
  originality).
- **Convergence:** Fill default, Split/Fit as AI-chosen per-segment options, word-synced bold
  captions center/lower-middle.
- **Big shows:** no published breakdown found. General impression (unverified): premium shows
  (DOAC, Modern Wisdom, Call Her Daddy, Huberman) = full-bleed close-ups from dedicated cameras +
  bold word captions + short top hook; aggregator clip channels (Rogan, Lex) = letterbox +
  persistent headline + captions.

## 4. Branding

- Same corner, same size, every clip — the one strongly agreed point. Animate at most once.
- Watermark opacity 50–70% common suggestion; solid fine if small.
- Never carry another platform's watermark (Instagram demotes TikTok-watermarked Reels since 2021).
- Partner credit: no convention; smaller/lower-contrast than channel logo, or end card only.
- Progress bars: vendor claims only; native scrubbers at bottom cover custom bars.
- End cards: weak evidence; short-form prefers a seamless loop; keep any card ~1–1.5 s.

## 5. Hook, length, text

- First 1–3 s decide the swipe; benchmark ≥80% at 3 s. Open on a big face, mid-thought.
- Limits: Shorts 3 min (since Oct 2024), Reels 3 min (Jan 2025). Practical podcast-clip sweet
  spot ~20–60 s; longer only if retention holds.
- Hook text ~3–8 words, ≤2 lines. Captions ≤2 lines, 32–42 chars/line, lead audio 0.1–0.3 s,
  fix proper nouns by hand.
- Emojis: no consensus; reads cheap for serious/news/faith content — keep out of captions.

## 6. Amateur tells

1. Text/captions/badges in bottom 35% or under the right rail. 2. One layout for the whole clip.
3. Tiny faces. 4. Jittery auto-reframe. 5. Soft upscaled crops. 6. Caption walls / one-word
flashes / bad contrast / wrong names. 7. Broadcast lower third at the bottom. 8. Oversized or
animated logos, inconsistent branding. 9. Foreign watermarks, stock CapCut templates, B-roll
overload. 10. Slow opens. 11. Split without bottom-panel adjustment.

## Sources

- Safe zones (TikTok/Meta/Google ad specs): https://www.upload-post.com/tools/safe-zone-checker/ ·
  https://www.facebook.com/business/ads-guide/update/video/instagram-reels ·
  https://support.google.com/google-ads/answer/9128498 ·
  https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads
- https://adaptlypost.com/en/blog/social-media-safe-zones-2026-complete-guide
- 2-person layouts: https://cut.pro/en/blog/enquadramento-podcast-duas-pessoas-2026
- Opus: https://help.opus.pro/docs/article/layout-and-reframing ·
  https://www.opus.pro/blog/youtube-shorts-caption-subtitle-best-practices
- https://www.clipspeed.ai/help/split-screen.html
- Riverside: https://support.riverside.com/hc/en-us/articles/12124048765981-AI-Magic-Clips ·
  https://riverside.com/university-videos/understanding-the-ai-speaker-view-in-the-magic-editor
- https://vizard.ai/tools/auto-speaker-focus
- Submagic: https://care.submagic.co/en/article/1j14ohm/ · https://submagic.co/features/auto-zooms ·
  https://submagic.co/features/b-roll
- https://www.captions.ai/solutions/podcasters
- Kapwing: https://www.kapwing.com/video-editor/vertical-video ·
  https://www.kapwing.com/help/how-to-use-smart-cut/
- https://feedback.descript.com/feature-requests/p/9-16-ratio-for-podcasting
- https://support.castos.com/article/226-creating-audiograms-with-headliner
- Retention: https://tubeanalytics.net/blog/youtube-shorts-retention-guide ·
  https://www.gofaceless.ai/en/blog/best-retention-strategies-youtube-shorts ·
  https://www.conbersa.ai/learn/podcast-clip-virality-anatomy · https://www.socialync.io/glossary/retention-rate
- Lengths: https://www.socialmediatoday.com/news/instagram-officially-expands-reels-length-3-minutes/737766/ ·
  https://engadget.com/entertainment/youtube/youtube-shorts-can-now-run-up-to-three-minutes-160002081.html
- Watermark/logo: https://wwwhatsnew.com/2021/02/10/instagram-ya-no-recomendara-los-reels-con-marca-de-agua-de-tiktok/ ·
  https://findclout.com/blog/how-logo-watermark-placement-works-on-meme-pages ·
  https://zight.com/blog/best-practices-for-video-watermark-design/ ·
  https://www.gla.ac.uk/myglasgow/staff/brandtoolkit/resources/photographyandvideo/video/brand/watermark
- Lower thirds: https://klap.app/blog/what-is-a-lower-third ·
  https://hse.ie/eng/about/who/communications/digital/video/branding-style-guidelines/lower-thirds
- https://meryl.net/common-caption-mistakes/
- DOAC (AI summary, unverified): https://gist.ly/youtube-summarizer/steven-bartletts-5-step-podcast-growth-playbook
