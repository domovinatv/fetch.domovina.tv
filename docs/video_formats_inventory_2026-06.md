# Inventar video formata kataloga — zašto nisu svi .mp4 isti

**Datum:** 2026-06-01
**Povod:** Dva fajla oba s `.mp4` ekstenzijom, a interno različit video (jedan VP9, drugi H.264); jedan zvuči bitno lošije od drugog.
**Izvor podataka:** 2695 `.info.json` (yt-dlp `--write-info-json`) + ffprobe nad uzorkom + `git log` nad `fetch.js`.

---

## Kratak odgovor

Ekstenzija (`.mp4`/`.mkv`) **ne govori ništa o codecu unutra**. Kontejner i codec ovise o tome **što je YouTube ponudio za taj konkretni video** + kako naš `fetch.js` bira format. Naš format-string se **nije mijenjao kroz vrijeme** (jedan commit, 2026-02-18) — šarolikost dolazi od YouTubea, ne od drift-a pipelinea.

Postoje **tri sloja** `.mp4`/`.mkv` datoteka, lako ih se zamijeni:

| Sloj | Kako nastaje | Codec | Kada |
|---|---|---|---|
| **A — yt-dlp original (mkv)** | `bestvideo[h≤360]+bestaudio` → merge | VP9/AV1 + **Opus** | na preuzimanje (velj–svib) |
| **B — yt-dlp original (mp4)** | fallback `/best[h≤360]` = format 18 | **H.264 + AAC** | na preuzimanje |
| **C — izvedeni web-mp4** | batch konverzija A→mp4 (video copy, audio→AAC) | VP9/AV1 + **AAC** | **2026-05-06/07** |

Sloj C sjedi *pored* sloja A (ista epizoda ima i `.mkv` i `.mp4`). Zato disk ima ~2255 mkv **i** ~2690 mp4, a epizoda je ~2695.

---

## Konkretni brojevi

### Što je yt-dlp stvarno preuzeo (po `info.json`, N=2695)

**Video codec:**

| Codec | Broj | % |
|---|---:|---:|
| VP9 | 1318 | 48.9% |
| AV1 | 851 | 31.6% |
| H.264 | 526 | 19.5% |

**Format kombinacije (top):**

| format_id | Codec | Kontejner | Broj |
|---|---|---|---:|
| 243+251 | VP9 + Opus | mkv | 1304 |
| 396+251 | AV1 + Opus | mkv | 843 |
| **18** | **H.264 + AAC** | **mp4** | **438** |
| 134+251 | H.264 + Opus | mkv | 85 |
| 243+140 | VP9 + AAC | mkv | 8 |

**Rezolucija:** 360p = 97.7% (2634). Ostatak su sitne varijante (≈350/320/272…) gdje 360p nije bio dostupan; 4 epizode na 1080p su zaostale od **prije** uvođenja 360p capa.

### Finalni kontejner po epizodi (postojanje na disku)

| Stanje | Broj |
|---|---:|
| ima i `.mkv` i `.mp4` (sloj A+C) | 2250 |
| samo `.mp4` (sloj B, format 18) | 440 |
| samo `.mkv` | 5 |

---

## Zašto YouTube nema standardizirani format

YouTube za **svaki** upload generira "ljestve" formata za adaptivni streaming (ABR), a koje codece/rezolucije ima ovisi o dobi videa, popularnosti, izvornoj rezoluciji i tome kad je YouTube koji enkoder uveo:

- **Kombinirani format 18** (640×360, H.264+AAC, jedan fajl) — gotovo univerzalno dostupan "pod".
- **DASH video-only** — VP9 uvijek; **AV1** na novijim/popularnijim videima (zato AV1 čini 31.6%); H.264 na nekim rezolucijama.
- **DASH audio-only** — Opus (251, ~130 kbps "medium") i AAC (140).

yt-dlp iz te ponude bira po našem stringu. Ako traženi separe streamovi postoje → merge u mkv; ako ne → padne na kombinirani format 18 → mp4.

## Što naš `fetch.js` traži (i da se nije mijenjao)

```js
"-f", "bestvideo[height<=360]+bestaudio/best[height<=360]",
"--prefer-free-formats",
// NEMA --merge-output-format, NEMA --recode  (provjereno: git log -S, prazno)
```

- `bestvideo[h≤360]+bestaudio` — uzmi najbolji **video-only ≤360p** + najbolji **audio-only**, pa ih **spoji**. `--prefer-free-formats` gura VP9/AV1/Opus → spoj ide u **mkv** (univerzalni kontejner kad codeci nisu mp4-native). **→ Sloj A.**
- `/best[h≤360]` — **fallback**: jedan kombinirani fajl ≤360p kad gornje ne uspije = **format 18 (H.264+AAC mp4)**. **→ Sloj B.**
- `--merge-output-format` nikad postavljen → kontejner je uvijek bio codec-driven default. `git log -S "merge-output-format"` i `-S "recode"` nad `fetch.js` = **prazno** (nikad).
- 360p cap uveden **2026-02-18** (commit `2c682a9`) i **otad nepromijenjen** (`git log -S "height<=360"` = jedan commit).

**Zaključak o uzroku:** heterogenost je posljedica **(a) ponude YouTubea po videu** + **(b) `--prefer-free-formats` pristranosti**, a **ne** mijenjanja pipelinea. Jedini efekt ere: 360p cap od 2026-02-18 (4 zaostala 1080p videa su pre-cap).

---

## Sloj C — izvedeni web-mp4 (2026-05-06/07)

Uzorak ffprobe + mtime nad epizodama koje imaju oba:

```
catholic_futurist  mkv[2026-02-18 vp9+opus]  mp4[2026-05-06 vp9+aac]
catholic_futurist  mkv[2026-04-21 av1+opus]  mp4[2026-05-06 av1+aac]
podcast_bitno_net  mkv[2026-03-05 vp9+opus]  mp4[2026-05-07 vp9+aac]
```

`.mp4` ima **isti video codec** kao `.mkv` (dakle video stream-copied) ali **AAC umjesto Opusa**, i svi su iz **jednog batcha 6–7. svibnja 2026.** → to je naknadna konverzija mkv→mp4 (vjerojatno za web/CDN isporuku ili pripremu), **ne** yt-dlp download. ⚠️ Napomena: VP9-u-mp4 i dalje **ne svira u Safariju/QuickTimeu** (vidi [`loudness_crosschannel_ab_2026-06.md`](loudness_crosschannel_ab_2026-06.md)), pa svrhu ovog sloja treba potvrditi.

---

## Posljedica za kvalitetu zvuka (važno)

Izvorni audio bitno se razlikuje po sloju:

| Origin | Audio izvor | Tipičan bitrate | Kvaliteta |
|---|---|---|---|
| **Sloj A (mkv)** | Opus 251 | ~130 kbps | **dobra** |
| **Sloj B (mp4 fmt 18)** | AAC u kombiniranom streamu | **~48 kbps** | **slaba** |

To objašnjava razliku koju se **čuje**:
- **goran_jeras** (sloj A, Opus izvor) → loudnorm rezultat zvuči odlično.
- **dorian_jakov blockchain** (sloj B, format 18, **48 kbps AAC izvor**) → intrinzično slabiji audio bez obzira na normalizaciju.

> Dodatno je `*_POPRAVLJENO.mp4` iz **starog** A/B seta (prije 2026-05-29 17:03 `-ar` fixa) imao audio na 96 kHz @ ~47 kbps — under-bitrate artefakt. Zato baš taj **mp4** zvuči loše, dok `ab_mp3/..._POPRAVLJENO.mp3` (128k, fiksiran) zvuči dobro. Potvrđeno slušno: mp4 loš, mp3 dobar.

**Optimizacija (kandidat):** za ~440 epizoda sloja B mogli bismo re-fetchati **samo audio** kao Opus 251 (audio-only stream je dostupan neovisno o video rezoluciji) i renormalizirati — dobio bi se ~130 kbps izvor umjesto 48 kbps. Video se ne dira.

---

## Pojmovnik fajlova po epizodi (da se ne zamijene slojevi)

```
{base}.mkv                  ← Sloj A: yt-dlp original (VP9/AV1 + Opus)   ⭐ najbolji audio izvor
{base}.mp4                  ← Sloj C: izvedeni web-mp4 (VP9/AV1 + AAC)   (ili Sloj B ako je fmt18 H.264)
{base}.f243.webm / .f251.webm ← yt-dlp fragmenti (prije merge-a)
{base}.mp3                  ← ekstrahirani audio (--audio-format mp3)
{base}.loudnorm.mp3 / .mp4  ← normalizirani izlaz (FAZA 2)
```

---

## ⚠️ Kritičan nalaz: cross-platform cilj NIJE postignut (live na CDN-u)

`upload_to_r2.js:10-13` (FAZA 3 remux) namjera:
> *"Pipeline proizvodi .mkv ali Flutter app treba .mp4 (H.264+AAC) za cross-platform kompatibilnost → `ffmpeg -i {base}.mkv -c:v copy -c:a aac -movflags +faststart {base}.mp4`"*

**Bug:** komentar tvrdi "H.264+AAC", ali `-c:v copy` **kopira** video codec iz .mkv = **VP9/AV1**. Remux je popravio kontejner (mkv→mp4) i audio (Opus→AAC), ali **video je ostao VP9/AV1**. VP9/AV1-u-mp4 **ne svira na Safariju/iOS/macOS Safari/tvOS/dosta Smart TV-a** (codec, ne kontejner, određuje kompatibilnost).

**Potvrđeno LIVE (ffprobe nad CDN-om):**

| videoId | `cdn.domovina.ai/data/{id}/video.mp4` | Apple/Safari |
|---|---|---|
| `b-nls1ck8EE` (Sloj A) | VP9 + AAC | ❌ ne svira |
| `AoXN-3Mkmew` (Sloj B/fmt18) | H.264 + AAC | ✅ svira |

→ ~**84% kataloga** (VP9 48.9% + AV1 31.6%) servira video koji ne svira na Apple uređajima.

### Uvedeni tradeoffovi (potvrda)

1. **Lažni cross-platform** — VP9/AV1-u-mp4 ne svira na Apple ekosustavu (glavni promašaj).
2. **Dvostruki lossy audio** — Opus 251 (~130k, već lossy) → AAC = druga generacija gubitka, bez potrebe (mkv Opus je bio dobar).
3. **Udvostručen storage** — svaka epizoda drži i .mkv (~280M) i .mp4 (~300M); ~2255× ≈ +0.6 TB.
4. **96 kHz AAC bug** — loudnorm interni 192k curio u AAC (fiksano `f414ed7`, ali live fajlovi mogu nositi).
5. **Immutable cache** — video.mp4 je max-age=1god immutable; prepisivanje istog keya = browseri drže stari (pokvareni) fajl do godinu dana.

---

## Idealni flow (prijedlog) — max audio + STVARNI cross-platform

**Načelo:** kompatibilnost određuje **video codec**, ne kontejner. Univerzalni baseline = **H.264 (AVC, yuv420p, ≤High profile) + AAC-LC + `+faststart`** u MP4. Mora se **re-enkodirati** VP9/AV1 → H.264 (ne `-c:v copy`).

### Po epizodi — jedan ffmpeg prolaz (transcode + normalize zajedno = jedan decode)

**Sloj A (mkv, VP9/AV1 + Opus) — re-enkodiraj video, normaliziraj audio:**
```bash
ffmpeg -i {base}.mkv -map 0:v:0 -map 0:a:0 \
  -c:v h264_videotoolbox -profile:v high -pix_fmt yuv420p \
     -b:v 1200k -maxrate 1600k -bufsize 2400k \
  -af "loudnorm=I=-16:TP=-2:LRA=11:linear=false" \
  -c:a aac -b:a 160k -ar 48000 \
  -movflags +faststart  {base}.web.mp4
```

**Sloj B (fmt18 mp4, već H.264) — NE diraj video, samo audio + faststart:**
```bash
ffmpeg -i {base}.mp4 -map 0:v:0 -map 0:a:0 -c:v copy \
  -af "loudnorm=I=-16:TP=-2:LRA=11:linear=false" -c:a aac -b:a 160k -ar 48000 \
  -movflags +faststart  {base}.web.mp4
# (opcionalno: re-fetch `yt-dlp -f 251` Opus audio-only da se digne 48k→130k izvor)
```

### Odluke (tradeoffovi flowa)

| Odluka | Preporuka | Zašto / tradeoff |
|---|---|---|
| **Video enkoder** | `h264_videotoolbox` (M4 Pro HW) | ~realtime na 360p → 2695 fajlova izvedivo (dani, ne tjedni). libx264 `-crf 21 -preset slow` = bolja kvaliteta/bit ali tjedni CPU-a. Na 360p talking-head razlika mala. |
| **Audio bitrate** | AAC 160k @ 48kHz | jedan lossy hop iz Opusa; 160k transparentno za govor. |
| **R2 ključ** | **verzioniran** (`video_h264.mp4`) + manifest pointer | immutable cache: prepis istog keya = stari VP9 ostaje u browseru do 1god. Verzioniran ključ + mutable manifest = nema stale cache. Alt: prepiši + Cloudflare purge (`DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE`), jednostavnije ali ne čisti već-cachirane klijente. |
| **Upload** | fast-path uploader (HEAD-skip, paralelni PUT) | NE `upload_to_r2.js` MD5-stream nad 73k fajlova (anti-pattern). |
| **Storage** | obriši Sloj C (pokvareni VP9-mp4); zadrži .mkv kao master dok web.mp4 nije validiran | ffmpeg na USB-u: `--concurrency 1-2` (I/O thrashing). |
| **Validacija** | PILOT 3 epizode → ffprobe `h264` + stvarni iOS/Safari test PRIJE catalog-wide | "potvrdi delivery target prije dugog backfilla". |

### Veći strateški alternativ (spomenuti, ne nužno usvojiti)

Pošto su to YouTube podcasti, alternativa self-hostanju videa: **embed YouTube player** (svira native svugdje, nula transkodiranja/storagea) + serviraj samo naš **normaliziran audio** (m4a/mp3, već univerzalan). Self-hosting H.264 ima smisla samo ako je offline/neovisnost o YouTubeu cilj. App trenutno self-hosta (`data/{id}/video.mp4`), pa je transcode in-flow popravak.
