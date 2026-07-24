# X (Twitter) video ingestion — SSOT (2026-07-24)

Kako X post s videom prolazi kroz **isti ad-hoc prioritetni pipeline** kao ad-hoc
YouTube video. Ovaj dokument je izvor istine za dizajn i operativu; kod je autoritativan
za detalje, memory `x_twitter_video_ingestion.md` za brzi podsjetnik.

Povezano: `docs/PIPELINE_FULL.md` (koraci 0→13), `unlisted_adhoc_ingestion_mechanism`
(memory), `pipeline_domovina_ai_queue_service` (memory), `priority_fast_path_o1_scoping`.

---

## 1. Motivacija i odluke

Do 2026-07-24 puna obrada radila je samo za YouTube. Cilj: korisnik zalijepi X post URL
u **`pipeline.domovina.ai/admin`** (ili `/dashboard`) i pusti na prioritetnu obradu →
Modal transkripcija → diarizacija → summary → article → Magisterium → EN → RAG →
screenshots → R2 → CDN `/v/{id}`, ~10–15 min.

Potvrđene odluke (s korisnikom):
- **Odredište:** `_unlisted` ad-hoc (neindeksiran, per-video na CDN) — nula promjena
  downstreama, reuse priority fast-patha. NE zaseban X pseudo-kanal.
- **Ulaz:** isti kao ad-hoc YT (`fetch.js --unlisted-url` preko queue bridgea).
- **Opseg:** puna obrada (isti pipeline kao YT).

## 2. Ključna arhitektura — sintetički 11-znakovni ID

X status ID je ~19 numeričkih znamenki → pada na `{11}` kvantifikatoru u ~20 skripti
(`extractVideoId` / `_yt_([A-Za-z0-9_-]{11})`). Umjesto diranja svih njih, **backend
minta deterministički 11-char ID** (Beamly presedan):

```
synthId = base64url(sha256(canonicalStatusUrl)).slice(0, 11)   // ∈ [A-Za-z0-9_-]{11}
```

- Kanonizira `x.com`/`twitter.com` URL i skida query string → **isti ID za oba oblika**.
- ~66 bita entropije → praktički bez kolizije (sigurnije od Beamly `slice(-11)`).
- Backend (`pipeline.domovina.ai/backend/src/util.ts`: `synthIdFromUrl` +
  `extractSourceRef`) je **JEDINI izvor istine**; sprema `youtube_id=synthId`,
  `youtube_url=<X URL>`, `source_platform='x'`, `source_url=<X URL>`.
- Fajlovi na disku poštuju `_yt_<synthId>` konvenciju → cijeli downstream je
  source-agnostic bez izmjena.

## 3. Cross-repo tok

```
pipeline.domovina.ai (CF Worker + D1)                    fetch.domovina.tv (producer)
  /admin, /dashboard, /api/v1  --enqueue-->  D1 jobs
                                               │
  bridge/priority_poller.js (Mac Mini, launchd) claim(priority)
     └─ run_pipeline.sh --unlisted-url <Xurl> --unlisted-id <synthId>
        --unlisted-source x --modal-only <synthId> --with-modal-transcribe
        --with-local-canary-diarize --with-r2-upload
                                               │
                                    fetch.js (X download) → convert_to_wav → Modal
                                    → diarize → summary → article → RAG → screenshot
                                    → h264 → R2 → CDN
  bridge/reconcile.js  <--article live on CDN-- flip fetching/transcribing → done
     └─ PATCH done + detail_url (+ backfill title/channel/duration iz info.json)
```

`run_pipeline.sh` **NIJE mijenjan** — nepoznati `--unlisted-id`/`--unlisted-source`
flagovi prolaze kroz else-granu (`COMMON_ARGS`) do `fetch.js`, isto kao `--unlisted-url`.

## 4. Tri enqueue putanje (GOTCHA)

Backend ima **TRI** mjesta koja validiraju URL — sva moraju zvati `extractSourceRef`
(ne `extractYouTubeId`):

| Ruta | Datoteka | Klijent |
|---|---|---|
| `POST /admin/jobs` | `admin/app.ts` | admin forma |
| `POST /api/jobs` | `jobs/api.ts` | bridge (INGEST_KEY) |
| `POST /api/v1/jobs` | `jobs/v1.ts` | **`/dashboard` frontend** (kreditni public API) |

Prvi deploy je propustio `v1.ts` → dashboard je javljao "Neispravan YouTube URL/ID".
Ako dodaješ novi izvor, provjeri sva tri.

## 5. yt-dlp twitter ekstraktor — činjenice

yt-dlp (v2026.06) **već ima** `twitter`/X ekstraktor; download radi bez ikakve izmjene.
Probe (`x.com/IgorJerkovic/status/2077784921582506270`): `mp4 / avc1 (H.264) 1080p`,
uploader, upload_date, thumbnail, duration. **H.264 = izravno TV-kompatibilno.**
Napomena: yt-dlp interni `id` je **media-id** i razlikuje se od **status-id** u URL-u →
kanonski referentni ID za mint MORA biti status URL, ne yt-dlp `id`.

## 6. info.json oblik: X vs YouTube (VAŽNO za Flutter consumer)

`fetch.js:augmentUnlistedInfoJson` upiše `_source:'x'` + `id=synthId`. Ali yt-dlp
twitter info.json ima **drugačiji oblik** od YouTubea — nedostaju polja koja YouTube
uvijek ima:

| Polje | YouTube | X (twitter) |
|---|---|---|
| `channel` | ✓ | **✗ NEMA** (koristi `uploader`) |
| `channel_url` | ✓ | **✗ NEMA** |
| `view_count` | ✓ | **✗ NEMA** |
| `categories` | ✓ | **✗ NEMA** |
| `uploader` / `uploader_id` | ✓ | ✓ ("Hobba 🟢" / "hobba_io") |
| `thumbnail` | i.ytimg.com | **pbs.twimg.com** |
| `webpage_url` | youtube.com | **x.com/…/status/…** |
| `extractor` | "youtube" | **"twitter"** |
| `_source` | (nema) | **"x"** |

**Consumer (domovina.ai Flutter) mora:** null-safe parsati `channel`→`uploader`
fallback, `channel_url`/`view_count`/`categories` opcionalno; NE graditi
`i.ytimg.com`/`youtu.be` iz sintetičkog `youtube_id`; granati po `_source`/`extractor`;
izvorni link = `webpage_url`. (article.json/summary.json su ISTOG oblika kao YT — ne diraju se.)

## 7. DB metadata (migration 0007)

Sintetički `youtube_id` se NE može reverzno u izvorni URL → eksplicitna metadata:
- `source_platform` TEXT ('youtube' | 'x')
- `source_url` TEXT — kanonski originalni URL (X post / YouTube watch)

Backfill postojećih redaka: `source_url = youtube_url`; X (source LIKE 'x%' ili X URL) →
`source_platform='x'`. UI (admin + dashboard) linka na `source_url` s 𝕏 badgeom i 𝕏
thumbnail placeholderom umjesto slomljenog `youtu.be/<synthId>` + ytimg.

## 8. Izmijenjene datoteke

**pipeline.domovina.ai** (commit `c46b5be`):
`backend/src/util.ts` (extractSourceRef/synthIdFromUrl), `admin/app.ts`, `jobs/api.ts`,
`jobs/v1.ts`, `admin/views.ts`, `dashboard/views.ts`, `db.ts`, `types.ts`,
`backend/migrations/0007_source_platform.sql`, `bridge/priority_poller.js`,
`bridge/reconcile.js` (title backfill).

**fetch.domovina.tv** (commit `b9371df`):
`fetch.js` (initUnlisted `--unlisted-id`/`--unlisted-source`, downloadVideo `targetUrl`,
augmentUnlistedInfoJson), `screenshot_youtube.js` (`_source`!='youtube' → lokalni ffmpeg put).

## 9. Verifikacija (E2E, live)

`x.com/hobba_io/status/2077782099445137475` → synthId `CUJmOc91C64` prošao autonomno
do `domovina.ai/v/CUJmOc91C64` (D1 state=done). CDN live: `data/{id}/{article,summary,
info}.json`, `data/{id}/video_h264.mp4` (avc1), `images/{id}/thumbnail.png`. Screenshotovi
uhvaćeni preko **lokalnog ffmpeg puta** (dokaz da screenshot fix radi jer synthId nije
pravi YT video).

## 10. Operativne napomene / caveats

- **X cookies:** javni postovi rade bez auth. Osjetljivi/age-gated mogu tražiti X login
  cookies (`fetch.js` ima `--cookies-from-browser` granu; Brave X cookies ≠ YouTube).
- **Naslov:** X nema pravi title; yt-dlp fabricira iz teksta tweeta. `sanitizeDescription`
  očisti emoji/`|`. Admin može override kroz naslov u formi.
- **Bridge title backfill:** kad job ide fetching→done direktno (preskoči poller
  transcribing PATCH), naslov je ostajao null; `reconcile.js` sad backfilla iz info.json.
- **og-share.jpg** za _unlisted nije potvrđen na CDN-u pod `data/{id}/og-share.jpg` — minor.
