# Jedno video skidanje po epizodi (23.11.2026.)

Prekidač `VIDEO_SINGLE_1080P=1` (env ili `.env`). Odnosi se samo na prioritetni fast-path
(Tier 2 jobovi, `--modal-only ID`). Bez prekidača se ništa ne mijenja.

## Zašto

Bez prekidača epizoda dvaput pristupa YouTube videu:

| Korak | Što | YouTube |
|---|---|---|
| KORAK 1 `fetch.js` | MP3 + 360p `.mkv` (izvor za `video_h264.mp4`, KORAK 12.5) | skidanje |
| KORAK 10 `screenshot_youtube.js` | `--get-url` 1080p streama, pa ~16 ffmpeg seekova (±5 s za Apple Vision) | stream |

Lokalnog 1080p nema: Apple Vision izbor kadra (28.10.) čita kandidate iz streama.
Anti-bot 23.11. u 06:05 postavio je upravo KORAK 10 (`--get-url`).

## Kako radi s prekidačem

| Korak | Što | YouTube |
|---|---|---|
| KORAK 1 `fetch.js --audio-only` | samo MP3 (+ info, description, thumbnail) | skidanje (samo zvuk) |
| KORAK 9.95 `tools/fetch_video_1080p.js` | 1080p (avc1 + najbolji audio) na **vanjski SSD** (`VIDEO_1080P_DIR`, default `/Volumes/DOMOVINA1TB/fetch_domovina_tv_work/video1080`), pa lokalno `{base}.mkv` 360p (libx264 veryfast crf 26, izvorni audio) | skidanje (video) |
| KORAK 10 | kadrovi iz lokalnog 1080p (`SCREENSHOT_LOCAL_VIDEO_DIR`) | **ništa** |
| iza KORAKA 10 | `--cleanup` obriše 1080p; 360p `.mkv` ostaje kao i danas | — |

Noćna serija (`MODAL_NIGHTLY_BATCH=1`) uz ovaj prekidač skida samo zvuk, a video skida
job u KORAKU 9.95.

## Sigurnost

- Non-fatal: ako 1080p ne uspije, KORAK 10 ide preko streama kao prije. `.mkv` se tada
  pokuša skinuti starim 360p formatom; na anti-bot se odmah odustaje i upiše se
  `youtube_antibot.json` (poller pauzira).
- Alat odbija radni direktorij izvan `/Volumes/` i ne skida kad je na disku manje od
  `VIDEO_1080P_MIN_FREE_GB` (default 30 GB).
- `run_pipeline.sh` je izmijenjen kopijom i atomskim `mv`, dok su se vrtjeli jobovi.

## Mjerenje

23.11. u 08:06, Tonecast #16 (`Tv6ag4mCVVI`, 69:43), sve na DOMOVINA1TB, bez proxyja:

| Što | Rezultat |
|---|---|
| 1080p skidanje (h264 1920×1080 + audio) | 766 MB za 144 s (5,3 MB/s), bez anti-bota |
| 360p `.mkv` izveden lokalno (veryfast crf 26) | 143 MB za 51 s (YouTube 360p: 156 MB) |
| prozor ±5 s, fps 2, 21 kadar iz lokalnog 1080p | 0,84–0,90 s po timestampu |
| ukupno video dio po epizodi | ~195 s i jedan YouTube video pristup umjesto dva |

Prostor: 1080p zauzima ~11 MB po minuti i briše se nakon KORAKA 10, pa disk drži
samo epizode koje su trenutno u obradi.
