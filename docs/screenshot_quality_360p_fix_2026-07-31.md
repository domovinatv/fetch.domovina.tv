# Screenshotovi su bili 360p — uzrok, ispravak i zašto retroaktivno nije napravljeno

**Datum:** 2026-07-31
**Status:** ispravak primijenjen (forward-only); retroaktivna regeneracija **svjesno odbijena**

## Simptom

Screenshotovi izgledaju mutno, posebno na og-share slikama pri dijeljenju linkova.

## Uzrok

`screenshot_youtube.js` je dohvaćao stream URL ovim lancem formata:

```
-f 96/95/94/93/18/bestvideo[ext=mp4]/bestvideo/best
```

Formati **96/95/94/93 su HLS i postoje samo za live streamove**. Za obični VOD ih nema, pa
lanac pada na **`18` = 640×360 progressive**, koji na YouTubeu praktički uvijek postoji.
Do `bestvideo` se **nikad** nije došlo.

Provjera na stvarnoj epizodi (`nLQSrHhLECQ`) — 1080p je bio dostupan cijelo vrijeme:

```
ID  EXT  RESOLUTION  │ VCODEC        │ MORE INFO
18  mp4  640x360     │ avc1.42001E   │ 360p            ← ovo se biralo
136 mp4  1280x720    │ avc1.4d401f   │ 720p, mp4_dash
137 mp4  1920x1080   │ avc1.640028   │ 1080p, mp4_dash ← ovo je bilo dostupno
```

Uzorak postojećih PNG-ova to potvrđuje: **640×360 dominira**. Iznimke su videi koji su
zbog anti-bota išli kroz lokalni `.mkv` fallback (taj bira po najvećoj visini, pa je
ironično davao **bolju** sliku od "primarnog" puta) i pokoji live stream gdje format 96
stvarno postoji.

**Pojačavajući faktor:** og-share slike su **1200×630**, dakle 640×360 izvor se *upscale-a*.
Zato je degradacija najvidljivija baš ondje gdje najviše smeta — pri dijeljenju linkova.

## Ispravak

```
-f bestvideo[height<=1080][vcodec^=avc1]/bestvideo[height<=1080]/96/95/94/93/bestvideo/18/best
```

- `bestvideo` ide **prvi**, `18` ostaje kao zadnji fallback
- `vcodec^=avc1` jer ffmpeg avc1 dekodira hardverski; AV1/VP9 bi radili softverski i bili
  bitno sporiji na 20 frameova po epizodi
- cap `height<=1080` — 4K ne donosi ništa za 1200×630 og-share, a troši bandwidth i disk

Izmjereno nakon ispravka: **1920×1080 frame u 3.2 s**, PNG ~1.6 MB.

## Zašto retroaktivna regeneracija NIJE napravljena

| Faktor | Brojka |
|---|---|
| Postojeće | 62,308 PNG-ova, **61.1 GB**, 3,037 videa (~20 frameova/video) |
| Na 1080p | ~120-155 GB → **+60-95 GB** |
| Slobodan disk | DOMOVINA1TB **84 GB** (91% pun), DOMOVINA2TB 231 GB |
| Vrijeme | ~19 h uz concurrency 3, uz 3,037 yt-dlp poziva (anti-bot rizik) |

Tri prepreke, svaka dovoljna sama za sebe:

1. **Ne stane na disk.** Većina kanala je na DOMOVINA1TB koji ima 84 GB slobodno.
2. **CDN immutability.** Slike se serviraju s `Cache-Control: public, max-age=31536000, immutable`,
   a `upload_to_r2.js` **preskače postojeće immutable ključeve** po dizajnu. Regeneracija na
   istom ključu ne bi bila ni uploadana, a i da jest, CDN bi servirao staru verziju do godinu
   dana. Trebalo bi `force_upload.js` + CF cache purge.
3. **Odnos cijene i koristi.** Stari sadržaj se rijetko dijeli; degradacija najviše smeta na
   novom, a novo je od sada 1080p.

**Odluka (2026-07-31): forward-only.** Ako se ikad krene retroaktivno, redoslijed je:
oslobodi disk (kandidati: 2,702 legacy lokalna `.mp4`, VP9/AV1 layer C, koje `count_progress.js`
već označava kao DEPRECATED) → regeneriraj → `force_upload.js` → CF purge. Razmotriti i
JPEG q90 umjesto PNG-a: na 1080p to je ~350 KB umjesto ~1.6 MB, što bi **smanjilo** ukupni
otisak s 61 GB na ~20 GB uz trostruko veću rezoluciju — ali mijenja ekstenziju u ključevima,
pa traži i promjenu na frontendu.

## Vezano

- `docs/video_crossplatform_strategy_2026-06.md` — ista "forward-fix, ne retroaktivno" logika
  primijenjena na video format
- `screenshot_youtube.js` — lokalni ffmpeg fallback (anti-bot) i njegov odabir po visini
