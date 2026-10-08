# 9:16 Reels safe zones by platform — 1080×1920 (as of 2026-10-08)

> Izvorni izvještaj istraživačkog subagenta (08.10.2026.), na engleskom, s izvorima.
> Sinteza na hrvatskom: `docs/2026-10-08-reels-layout-best-practices.md`.

## TL;DR

- Only three platforms publish safe-zone numbers you can read off their own pages: **Meta**
  (Instagram/Facebook Reels ads), **Google/YouTube** (official PNG overlay, measured to the pixel),
  **TikTok** (downloadable zips; pixel values via third parties). **Snap** publishes top/bottom for
  ads. **LinkedIn, X, WhatsApp publish nothing** — estimates only.
- Every published figure is an **ad** spec. No platform publishes an organic safe zone; ad zones
  are a conservative upper bound.
- **Universal:** strict rectangle **x 120–780, y 288–1248 (660×960)**; centered caption box
  **x 200–880, y 288–1248**; cover text inside **y 480–1200**.

## 1. Instagram Reels

| Item | Value (px @1080×1920) | Source |
|---|---|---|
| Top unsafe | **269 (14 %)** | Meta Ads Guide: "leave at least 14% top, 35% bottom, 6% each side" — https://www.facebook.com/business/ads-guide/update/video/instagram-reels |
| Bottom unsafe | **672 (35 %)** | same |
| Sides | **65 (6 %)** each | same |
| Bottom with disclaimer (ads) | 768 (40 %), attributed to Meta help | via https://www.inro.social/tools/instagram-reels-safe-zone-checker (Aug 2026); Meta article not readable |
| Right action rail | no Meta figure; AdKit estimate **227 px wide from y≈1152** | https://adkit.so/tools/safe-zones/meta (v2026-09-10) |
| Text-safe (official) | **x 65–1015, y 269–1248**; stay left of x≈853 for y 1152–1248 | derived |
| Organic | no Meta figure; 15 third-party sources range 108–269 top, 250–672 bottom, 35–140 right | inro.social |

Why 6 % sides (inference): ~19.5:9 phones are taller than 9:16; Reels fills height and crops
~68 px per side on a ~1080×2200 viewport ≈ 6 %.

Cover/grid: since 20 Jan 2025 the profile grid is ~3:4 → centered 1080×1440 crop, **y 240–1680**
survives (creator-measured; https://www.businesstoday.in/technology/news/story/instagram-head-announces-big-changes-3-minute-reels-and-new-look-for-profile-grid-461527-2025-01-21).
Main feed crops 4:5 (**y 285–1635**). Older guides: 1:1 (y 420–1500) worst case.

Specs (ads): 9:16, rec. 1440×2560, MP4/MOV H.264, fixed fps, AAC ≥128 kbps, ≤4 GB, 0 s–15 min.
Organic: 3 min in-app since Jan 2025 (https://buffer.com/resources/instagram-reels-length).

## 2. Facebook Reels

Meta's Reels ad page covers both apps, keep key elements in the safe zone, offers PPT/PSD/Keynote
safe-zone templates: https://www.facebook.com/business/ads/facebook-instagram-reels-ads. Use the
**same 14 / 35 / 6 %**. (A looser 13 % / 23.4 % third-party measurement exists — use Instagram
values.) Facebook *Stories*: bottom 20 % (384 px), sides 0.

## 3. TikTok

Help pages link zips (LTR/RTL/anchor): https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads.

| Item | Strict reading (official guide, scaled) | Source |
|---|---|---|
| Top | **240** | AdKit scaled TikTok's labelled 720×1280 guide ×1.5 (160/440/80 + 120 rail): https://adkit.so/tools/safe-zones/tiktok |
| Bottom | **660** (y ≤ 1260) | same |
| Sides | **120** each | same |
| Right action rail | **300 total (120 + ~180) from y≥840** | same |
| Text-safe | x 120–960 above y 840; **x 120–780 for y 840–1260** | derived |
| Anchor / 4-line caption | bottom up to **1014**, right 240 from y≥360 | AdKit |

Disagreement: AdNabu (Jun 2026) gives 160/440/80 without a canvas
(https://blog.adnabu.com/tiktok/tiktok-ad-specs/); some tools apply them to 1080×1920 directly
(e.g. https://www.poster.ly/tools/tiktok-safe-zone-checker). AdKit's reading matches the guide's
visible geometry and is conservative. TikTok: "safe zone size is determined by the ad caption
length and any Interactive Add-on usage" (https://ads.tiktok.com/help/article/tiktok-reservation-topview).

Cover/grid: ~3:4 (y 240–1680) vs 1:1 (y 420–1500) — design for 1:1 worst case.
Specs (ads): ≥540×960, ≤500 MB, ≥516 kbps (auction) / ≥2500 (reservation). Organic 10 min in-app.

## 4. YouTube Shorts

Google's **official 1080×1920 PNG overlay** ("Vertical Video Ads — Safe Zone Overlay"), linked from
https://support.google.com/google-ads/answer/13547298, file:
https://services.google.com/fh/files/misc/youtubesafezoneoverlay_vertical_final.png —
**measured transparent rectangle: x 48–888, y 288–1248 (840×960).**

| Top | Bottom | Left | Right (rail, full height) |
|---|---|---|---|
| **288 (15 %)** | **672 (35 %)** | **48** | **192** |

Other circulating figures (AdKit previews 241/381/60/201; Postplanify 120/300/96; Poster.ly
380/380/60/120) — **the Google PNG is the only primary source.** Shorts up to **3 min**
(https://support.google.com/youtube/answer/15424877).

## 5. Snapchat Spotlight

Ads: **150 top / 330 bottom** (Snap "Snap Ad Practices", via https://adkit.so/tools/safe-zones/snapchat).
Spotlight organic: no safe zone; MP4, **5–60 s**, ≥576×1024, full-frame, no foreign watermarks
(https://creators.snap.com/start-creating). Treat like TikTok (right rail + bottom caption).

## 6. LinkedIn

Official (https://www.linkedin.com/help/lms/answer/85306): 9:16 rec. 720×1280 (max 1080×1920),
4:5 recommended vertical; MP4 H.264, <30 fps, AAC, 75 KB–500 MB, 3 s–30 min. **No safe zone.**
Third-party: ~108–250 top, ~250–320 bottom. Feed may crop toward 4:5 → keep text in y 285–1635.

## 7. X (Twitter)

No official safe zone; single aggregator: ~400 px bottom, ~140 px right
(https://socialk.it/en/sizes/x-video-size). Specs: H.264 High, AAC-LC, ≤60 fps, recommended
720×1280 portrait (https://docs.x.com/x-api/media/quickstart/best-practices).

## 8. WhatsApp

No official safe zone. Status (estimate): top ~200 px (progress, avatar, name), bottom ~250–300
(caption + Reply), no rail. In-chat full-screen player: top bar + bottom scrubber ~150–250 each.
Media sent at **480p default or 720p "HD"** (https://www.androidauthority.com/whatsapp-hd-video-3358221/);
document = original. Captions must stay legible at 480p (cap height ≥48 px on the 1080 canvas).

## 9. Comparison (1080×1920)

| Platform | Top | Bottom | Left | Right | Status |
|---|---|---|---|---|---|
| Instagram / FB Reels ads | 269 | 672 | 65 | 65 (+ rail ~227 from y 1152) | Meta official %; rail AdKit |
| TikTok In-Feed ads | 240 | 660 | 120 | 120 (+ rail to 300 from y 840) | Official guide via AdKit |
| YouTube Shorts ads | 288 | 672 | 48 | 192 | **Official PNG, measured** |
| Snapchat ads | 150 | 330 | (60) | (60) | Snap official top/bottom |
| LinkedIn | ~108–250 | ~250–320 | ~60 | ~120 | Third-party |
| X | — | ~400 | — | ~140 | Third-party |
| WhatsApp Status | ~200 | ~300 | — | — | Estimate |

## 10. Universal safe zone (one export for all)

Strict intersection: top 288 (YouTube), bottom edge y 1248 (YouTube/Instagram), left 120 (TikTok),
right x 888 (YouTube) and x 780 below y 840 (TikTok rail) → L-shape **y 288–840: x 120–888;
y 840–1248: x 120–780**; simplified **x 120–780, y 288–1248 (660×960)**.

| Zone | Rectangle | Purpose |
|---|---|---|
| Title / hook | x 120–880, y 288–520 | Above TikTok rail |
| Face / subject | centered, y ~420–1150 | Survives cover crops, clear of UI |
| Captions | **x 200–880 (centered, 680 wide), y ~1000–1240** | Centered on x 540; short captions rarely reach the rail |
| Never text | y < 288, y > 1248, x > 888 | |

Cover: worst case 1:1 (y 420–1500) → cover text in **x 120–880, y 480–1200**.

Single export: 1080×1920, H.264 High, yuv420p, constant 30 fps (LinkedIn <30... use 30), AAC-LC
≥128 kbps, `+faststart`, ~8–12 Mbps; **≤60 s** to fit Spotlight / TopView / WhatsApp Status.

## 11. Caveats

All numbers trace to ad specs or third-party measurement — **no organic safe zones published.**
AdKit v2026-09-10, inro.social Aug 2026, Meta/Google read 2026-10-08. Not readable: Meta help
article (JS), Snap business help, business.x.com (402), help.x.com (403), TikTok zip internals.
UIs change several times a year — always preview on a real phone.
