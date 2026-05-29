# FAZA 3 — mp4 → R2 backfill: runbook za novi session

**Svrha:** Samostalna uputa da **nova Claude Code sesija** (bez konteksta prethodnog razgovora) može izvršiti jednokratni backfill: normalizirati glasnoću **audija unutar isporučnih `.mp4`** datoteka i gurnuti ih na R2 (`cdn.domovina.ai`) tako da frontend `domovina.ai` dobije ujednačen, kvalitetan zvuk.

**Status na 2026-05-29.** Prethodi: [`loudness_analysis_2026-05.md`](loudness_analysis_2026-05.md) (mjerenje), [`loudness_normalization_2026-05.md`](loudness_normalization_2026-05.md) (audio inženjerski put — PROČITAJ PRIJE IMPLEMENTACIJE).

---

## 1. Što je već gotovo (ne ponavljati)

| Faza | Što | Artefakt |
|---|---|---|
| FAZA 1 | Mjerenje glasnoće svih 2683 epizoda (ebur128) | `analyze_loudness.js`, `loudness_report_xlsx.py`, `docs/loudness_analysis_2026-05.md` |
| FAZA 2 | Normalizacijska skripta + validacija | `normalize_loudness.js`, `docs/loudness_normalization_2026-05.md` |
| FAZA 2b | **mp3** backfill cijelog kataloga (`.loudnorm.mp3` uz original) | pokrenut 2026-05-28, ~11 h, trebao završiti 2026-05-29 |
| A/B | 6 domovina_tv parova original/popravljeno, **korisnik potvrdio "super poboljšanje"** | Drive: `google_drive_ms:domovina_loudnost_ab_2026-05-28` |

**Validirane postavke glasnoće** (NE mijenjati bez razloga): `I=-16 LUFS, TP=-2 dBTP, LRA=11, linear=false` (single-pass **dynamic**).

---

## 2. Ključni uvid koji definira FAZU 3

Frontend `domovina.ai` (Flutter) svira **`data/{videoId}/video.mp4` iz R2**, NE mp3. `upload_to_r2.js` eksplicitno ne uploada mp3. Zato:

> mp3 backfill (FAZA 2b) **ne stiže do frontenda**. Za bolji zvuk na siteu mora se normalizirati **audio unutar `.mp4`-a** i taj mp4 gurnuti na R2.

---

## 3. Plan FAZE 3 (dogovoreno s korisnikom — implementirati)

Injekcijska točka je **remux korak u `upload_to_r2.js`** (`remuxVideo`, oko linije 319), koji već radi `mkv → mp4` (`-c:v copy -c:a aac -movflags +faststart`).

**Promjene:**

1. **`--normalize-audio` flag** → remux ubaci loudnorm na audio:
   ```
   ffmpeg -i {base}.mkv \
     -af "loudnorm=I=-16:TP=-2:LRA=11:linear=false" \
     -c:v copy -c:a aac -movflags +faststart -y {base}.mp4.tmp && mv {base}.mp4.tmp {base}.mp4
   ```
   - Audio dolazi iz `.mkv` (originalni Opus = najbolji izvor), video se **kopira** (`-c:v copy`, nepromijenjen — može biti VP9-u-mp4, to je OK, ne re-enkodiraj video).
   - **Zamjena `.mp4` na mjestu** (mkv ostaje master) → **NEMA 607 GB duplikata**. Piši u temp pa atomski `rename`.
   - **Idempotencija:** marker (npr. `{base}.audionorm` ili polje u sidecaru) da se već normalizirani mp4 ne re-remuxa svaki put. Bez markera postojeći `.mp4` je noviji od `.mkv` pa ga `remuxPhase` mtime-logika preskače — marker tjera prvo normaliziranje.

2. **Force re-upload immutable `video.mp4` ključa.** `upload_to_r2.js` preskače postojeće immutable keyeve (`video.mp4` ima `Cache-Control: public, max-age=31536000, immutable`). Treba force put za taj key (oba: pipeline `{channel}/{base}.mp4` i flutter `data/{videoId}/video.mp4`).

3. **Auto CF purge** nakon uploada (jer je immutable — inače CF servira stari mp4 godinu dana):
   - Token: `.env` → `DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE` (Zone cache-purge scope). Standardni `KEY=value` (bez `export` prefiksa).
   - CF API: `POST https://api.cloudflare.com/client/v4/zones/{zoneId}/purge_cache` s `{"files":[...urls...]}` ili `{"purge_everything":true}`. Treba zone ID za `domovina.ai` (dohvati preko `GET /zones?name=domovina.ai` s istim tokenom ako ima permisije, ili pitaj korisnika).
   - **Verifikacija s GET, ne HEAD** (`curl -sL`) — HEAD može lažno pokazati 200 dok GET vraća stari cache.

Isti `--normalize-audio` flag = **i pipeline integracija**: `upload_to_r2.js` se zove u `run_pipeline.sh` (korak 12), pa svaka nova epizoda automatski dobije normaliziran zvuk (po epizodi trivijalno — jedan loudnorm prolaz, ~2–5 min za 120-min audio).

---

## 4. Tehnička referenca (gdje je što)

**`upload_to_r2.js`:**
- `remuxVideo(mkvPath, mp4Path)` ~L319 — injekcijska točka za loudnorm.
- `remuxPhase(videos, dryRun)` ~L353 — mtime skip logika (L374-382); ovdje dodati force-uz-marker.
- `getFlutterKey(...)` ~L414 — `{base}.mp4 → data/{videoId}/video.mp4` (L436).
- Pipeline key: `{channel}/{base}.mp4`. Oba seta s `--flutter-keys`.
- `CACHE_CONTROL_IMMUTABLE` ~L163, `cacheControlFor()` ~L174 — `video.mp4` je immutable.
- S3 client ~L695 (`@aws-sdk/client-s3`, endpoint `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`), `PutObjectCommand` ~L778.
- CLI: `getArg`/`hasFlag` ~L183, main parsing ~L800, `remuxPhase` poziv ~L904.
- Vlastiti `.env` parser na vrhu (~L100) — čita `KEY=value`.

**`.env` kredencijali** (vidi memory `env_r2_and_cf_purge_creds`):
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME=cdn-domovina-ai`, `R2_PUBLIC_URL=https://cdn.domovina.ai`
- `DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE`

**`normalize_loudness.js`** — referentna implementacija loudnorm logike (single-pass dynamic, asplit fanout, bitrate match). FAZA 3 može posuditi loudnorm filter odatle.

---

## 5. Protokol izvršenja (OBAVEZNO ovim redom)

0. **⚠️ DISABLE NOĆNI CRONJOB PRVO.** Postoji launchd agent `tv.domovina.fetch.nightly` koji se pokreće **svaki dan u 03:00** i radi fetch + catch-up + `upload_to_r2.js`. Ako se pokrene usred FAZE 3 backfilla → utrka oko istih `.mp4`/R2 resursa + disk/CPU kontencija (potencijalni rusvaj). Prije backfilla:
   ```
   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/tv.domovina.fetch.nightly.plist
   ```
   Nakon što backfill ZAVRŠI, vrati ga:
   ```
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/tv.domovina.fetch.nightly.plist
   ```
   (Preskakanje jedne noći je bezopasno — nightly je idempotentan, catch-up sutra.)
1. **Provjeri da je mp3 backfill završio** (`pgrep -f normalize_loudness.js`); ako još traje, pričekaj (CPU/disk kontencija).
2. **Implementiraj** `--normalize-audio` + force-upload + auto-purge u `upload_to_r2.js`. `node -c` syntax check.
3. **Validacija na JEDNOM kanalu (domovina_tv, 6 epizoda) end-to-end:**
   - normaliziraj + upload tih 6 (`--channel domovina_tv --normalize-audio --flutter-keys` + force)
   - purge tih 6 URL-ova
   - **verificiraj GET-om** da CDN servira normaliziran mp4 (preuzmi, `ffmpeg ebur128` → integrated ~-16, true peak ≤ -1)
   - prijavi korisniku, čekaj OK
4. **Tek nakon OK → puni backfill (2683) u backgroundu** (`run_in_background`). Očekuj **satima** (mp3 backfill je trajao ~11 h) **+ ~607 GB upload na R2**. Pustiti preko noći.
5. Završno: purge (po path-evima ili Purge Everything), GET-verifikacija uzorka, izvještaj.

---

## 6. Ograničenja / zamke (NE pogazi)

- **Disk je DISK-NEUTRALAN, ne treba 607 GB.** Zamjena `.mp4` na mjestu (temp `.mp4.tmp` → atomski `rename`) troši samo TRANZIJENTNI prostor ≈ `concurrency × veličina_jednog_mp4` (~1–2 GB pri C=6), pa radi i na skučenom disku. **607 GB je R2 UPLOAD (mreža), NE lokalna pohrana** — ne treba premještati kanale ni koristiti DOMOVINA2TB free space za sam backfill. (Ako bi se htjeli ČUVATI originalni mp4-evi kao duplikat — tek tad treba 607 GB; ali mkv je master pa ne treba.) `DOMOVINA1TB` je kronično tijesan (mp3 .loudnorm dodali 69 GB tamo) — ako treba trajni headroom, premjesti CIJELI kanal (ne pojedine fajlove) DOMOVINA1TB→DOMOVINA2TB preko `move_to_disk.sh`; to je housekeeping, NIJE preduvjet za FAZU 3.
- **Noćni cronjob:** disable `tv.domovina.fetch.nightly` (03:00) prije backfilla, vrati nakon — vidi korak 0 i memory [[nightly-pipeline-launchd]].
- **CDN immutable:** `video.mp4` = `max-age=1god, immutable` → overwrite NIŠTA ne mijenja na siteu dok ne purge-aš. Vidi memory `cloudflare-cdn-caches-404s`. Verificiraj **GET**, ne HEAD.
- **Glasnoća:** koristi single-pass **dynamic** (`linear=false`). NE two-pass `measured_*` (ignorira TP limiter → klipa). NE `linear=true` (nema limiter → klipa). Cilj TP **-2** (ne -1) jer lossy enkoder digne true peak ~+1.6 dB. Detalji: `docs/loudness_normalization_2026-05.md`.
- **Video:** `-c:v copy` — ne re-enkodiraj video (može biti VP9-u-mp4, radi na frontendu).
- **Original se ne uništava nepovratno:** `.mkv` je master; `.mp4` je derivat pa je zamjena na mjestu prihvatljiva.
- **Idempotencija:** marker da re-run ne re-procesira sve.
- GCP/Gemini se ovdje NE diraju; samo ffmpeg + R2 + CF.

---

## 7. Kako pokrenuti novi session na temelju ovog dokumenta

> "Pročitaj `docs/loudness_faza3_mp4_r2_runbook.md` i `docs/loudness_normalization_2026-05.md`. Implementiraj FAZU 3 (mp4 → R2) prema runbooku: `--normalize-audio` + force-upload + auto CF purge u `upload_to_r2.js`, validiraj na domovina_tv pa pusti puni backfill u backgroundu."

Relevantne memorije: `loudness-normalization-initiative`, `env-r2-and-cf-purge-creds`, `cloudflare-cdn-caches-404s`, `audio-fix-scripts-output-new-files`, `site-filters-videos-by-has-article`.
