# Nightly report 04.11.2026.: vrijeme po koraku za svaku epizodu

Stanje u 22:06 (CET). Izvori: `automatic/logs/nightly_2026-11-04.log`, `priority_2026-11-04.log`, `magisterium_2026-11-04.log`, `magisterium-en_2026-11-04.log`, API `pipeline.domovina.ai/api/jobs` i `cdn.domovina.ai/data/<id>/episode.json`. Trajanje koraka je razmak između dva uzastopna zapisa „📢 KORAK” u logu. Grafovi su u PDF-u: `docs/2026-11-04-nightly-report-vremena-po-koraku.pdf`.

## Sažetak

- **23 nove epizode, 22 s člankom.** 4 iz nightlyja (praćeni kanali, 03:00–03:58) i 18 iz prioritetnog reda (Tier 2). Pao je 1 posao: `KyMHBGFS5Gc` (PSIHOLOGiJA HRT). Download ne prolazi, a isti video pao je i 03.11.
- **Sve je gotovo.** Svih 18 Tier 2 epizoda na CDN-u ima članak, EN članak, Magisterium HR i Magisterium EN. Nightly: sve 4 imaju HR i EN članak; Magisterium samo Ora et Labora (ostali kanali ga nemaju u planu). Zadnji posao završio je u 11:11:24.
- **Prioritetni slot:** prvi posao preuzet u 04:03:24, zadnji gotov u 09:31:38. Obrađeno je 19.0 h zvuka. Obrada po epizodi traje medijan 17 min (8–27 min). Čekanje u redu: medijan 160 min, najdulje 319 min.
- **Kamo ide vrijeme** (zbroj 18 Tier 2 epizoda, 292 min): Članak Opus (8) 108 min (37 %), H.264 video (12.5) 41 min (14 %), ASR (2.7b) 33 min (11 %), Reels Opus (9.9) 33 min (11 %), Modal Canary (2.6) 29 min (10 %).
- **Magisterium HR:** 19 epizoda, medijan 12 min po epizodi, jedna po tick (10 min). Zadnja HR obrada završila je u 11:08:52. **EN prijevod:** 22 epizoda, medijan 2.9 min. To je u redu: Magisterium je pozadinski posao koji smije trajati nekoliko sati (odluka 04.11.).
- **Magisterium EN je kasnio za 16 epizoda.** EN tick je preveo članak prije nego što je HR Magisterium stigao. Zakašnjeli Magisterium EN dodao je `c2af6ac7` (`EN_MAG_LATE_SINCE`, 3 po ticku) između 10:14 i 11:11.
- **⚠️ pyannoteAI je bez kredita od 05:51** (HTTP 402 „Insufficient credits and no active subscription”). 13 od 18 Tier 2 epizoda ima govornike iz Speechmaticsove dijarizacije. Korak je non-fatal, pa se to ne javlja kao greška. Nightly 05.11. udarit će u isto.
- **Cijeli dan radio je samo jedan slot:** 184 zapisa „slot 2+: disk 12–14 GB < 25 GB”.
- **Modal Canary (2.6)** vrti se kao osigurač na svakoj Tier 2 epizodi iako je ASR Speechmatics: 29 min ukupno.
- Rupa od 12 min iza `-kSZAvMDzC8` (08:15 → 08:27): `reconcile` je zapeo na mreži (`fetch failed`, `PATCH … EPIPE`).
- Nightly: `audit_pipeline.js` exit 1 (rupe disk ↔ CDN), kao i 03.11.

## Odluke nakon reporta (04.11.2026. navečer)

1. **pyannoteAI samo uz Soniox, dakle samo Tier 1.** `run_pipeline.sh` preskače KORAK 2.7c kad je `ASR_PRIMARY=speechmatics` (Tier 2), a `diarize_pyannote_ai.js` šalje pyannoteAI-ju samo epizode koje već imaju Soniox riječi (`.soniox.words.json` / `.soniox.json`). Tier 2, i Tier 1 kad Soniox padne na Speechmatics, koriste Speechmaticsovu dijarizaciju; kostur 2.8 `auto` tada sam uzme Speechmatics. `PYANNOTE_AI_REQUIRE_SONIOX=0` vraća staro ponašanje. Krediti pyannoteAI su i dalje na nuli. Dok se ne nadoplate, ni Tier 1 neće imati pyannoteAI govornike (korak je non-fatal).
2. **Ograda drugog slota mjerila je krivi disk.** `automatic/priority_pipeline.sh` je radio `df $REPO_DIR`, a to je interni SSD (9 GB slobodno). Prioritetni videi pišu u `storage/output/_unlisted` → DOMOVINA2TB (655 GB slobodno). Sada se 25 GB (`PRIORITY_MIN_FREE_GB`) mjeri na radnom disku, a na SSD-u samo 5 GB (`PRIORITY_MIN_FREE_SSD_GB`). Toliko treba privremenom `web.mp4` iz KORAKA 12.5 koji se piše na SSD (izbjegava I/O thrashing na USB-u) i briše nakon uploada. Interni SSD na 98 % je zaseban problem (ClickHouse/Docker, vidi RAG handoff).
3. **Magisterium smije biti spor.** HR/EN Magisterium je pozadinski posao koji se odradi kroz nekoliko sati. Kašnjenje za člankom nije nalaz.

## Tier 2: trajanje faza po epizodi (min:s)

| # | video | kanal | audio | poslano | preuzeto | čekanje | Preuzimanje | WAV | Modal Canary | ASR | pyannoteAI | Kostur | Sažetak Opus | Članak Opus | RAG + sličice | Screenshotovi | OG/EPUB/sponz./words | Reels Opus | R2 upload | H.264 video | CDN ostalo | start | zatv. | gotovo | obrada | govornici |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `valMgmN1tXA` | Explora / HRT | 53:28 | 04:02:02 | 04:03:24 | 1:22 | 17 s | 2 s | 1:48 | 1:08 | 47 s | · | 27 s | 8:18 | 1 s | 1:41 | 6 s | 1:33 | 4 s | 1:50 | 16 s | 4 s | 1:25 | 04:23:14 | 18:18 | pyannoteAI |
| 2 | `GpPzKW6eUQM` | Eduza | 86:31 | 04:02:02 | 04:23:15 | 21:13 | 46 s | 3 s | 1:40 | 1:49 | 1:17 | 1 s | 33 s | 8:51 | 1 s | 1:46 | 5 s | 1:59 | 5 s | 3:03 | 17 s | 2 s | 32 s | 04:46:06 | 22:16 | pyannoteAI |
| 3 | `KyMHBGFS5Gc` |  | – | 04:02:02 | 04:46:06 | 44:04 | · | · | · | · | · | · | · | · | 1 s | · | · | · | · | · | 1 s | 2 s | – | ❌ | – | – |
| 4 | `sNbOUa-hQSc` | Netokracija | 63:22 | 04:02:03 | 04:52:13 | 50:10 | 1:07 | 2 s | 1:32 | 1:05 | 1:02 | 1 s | 31 s | 5:59 | 1 s | 49 s | 2 s | 2:04 | 4 s | 2:16 | 13 s | 2 s | 1:26 | 05:10:30 | 16:48 | pyannoteAI |
| 5 | `OMmfDf5gEX0` | Ideje | 70:21 | 04:02:03 | 05:10:32 | 68:29 | 32 s | 3 s | 1:53 | 1:08 | 47 s | · | 36 s | 6:12 | · | 1:24 | 4 s | 2:25 | 5 s | 2:29 | 16 s | 2 s | 18 s | 05:28:47 | 17:54 | pyannoteAI |
| 6 | `F7xiNXvwm1s` | Ideje | 54:35 | 04:02:03 | 05:28:48 | 86:45 | 24 s | 2 s | 1:44 | 2:10 | 47 s | 1 s | 36 s | 4:25 | · | 1:01 | 3 s | 2:29 | 4 s | 1:55 | 11 s | 1 s | 50 s | 05:45:32 | 15:52 | pyannoteAI |
| 7 | `fUFlhmqBVMs` | Tribina | 144:42 | 04:02:03 | 05:45:34 | 103:31 | 1:45 | 4 s | 1:50 | 1:49 | 3 s | · | 46 s | 12:13 | 1 s | 41 s | 3 s | 2:02 | 5 s | 5:05 | 22 s | 1 s | 34 s | 06:12:58 | 26:49 | Speechmatics (pyannoteAI 402) |
| 8 | `QtqZiG3FMtM` | Telegram.hr | 24:51 | 04:02:04 | 06:12:58 | 130:54 | 15 s | 1 s | 1:15 | 47 s | · | 1 s | 22 s | 2:13 | · | 9 s | 1 s | 1:37 | 3 s | 52 s | 9 s | 2 s | 1:21 | 06:22:06 | 7:45 | Speechmatics (pyannoteAI 402) |
| 9 | `AsbxJB5vshI` | Podcast Inkubator | 88:59 | 04:02:04 | 06:22:07 | 140:03 | 45 s | 3 s | 1:56 | 1:27 | 1 s | 1 s | 44 s | 8:05 | · | 16 s | 3 s | 1:52 | 6 s | 3:09 | 19 s | 1 s | 1:01 | 06:41:56 | 18:47 | Speechmatics (pyannoteAI 402) |
| 10 | `85LE9OLR7_s` | Ofenziva - Sportski podc | 79:38 | 04:02:04 | 06:41:56 | 159:52 | 30 s | 3 s | 1:34 | 1:50 | 1 s | 1 s | 34 s | 7:17 | 1 s | 11 s | 2 s | 1:44 | 5 s | 2:41 | 14 s | 2 s | 1:25 | 07:00:12 | 16:48 | Speechmatics (pyannoteAI 402) |
| 11 | `5euYYTuybzY` | PODCAST BOG I HRVATI | 62:34 | 04:02:05 | 07:00:12 | 178:07 | 34 s | 3 s | 1:28 | 4:12 | 2 s | · | 31 s | 4:42 | · | 1:25 | 5 s | 1:42 | 6 s | 2:09 | 15 s | 3 s | 1:02 | 07:18:31 | 17:14 | Speechmatics (pyannoteAI 402) |
| 12 | `pqPh1taQ2Gg` | radiobenkovac | 55:02 | 04:02:05 | 07:18:32 | 196:27 | 25 s | 3 s | 1:35 | 2:36 | 1 s | · | 34 s | 4:19 | 1 s | 2:04 | 4 s | 1:25 | 5 s | 1:53 | 16 s | 2 s | 1:23 | 07:35:18 | 15:21 | Speechmatics (pyannoteAI 402) |
| 13 | `sTvZUW2v6K8` | Vox Medicus | 33:12 | 04:02:05 | 07:35:20 | 213:15 | 19 s | 1 s | 1:47 | 48 s | 1 s | · | 27 s | 5:46 | 1 s | 22 s | 3 s | 1:42 | 5 s | 1:12 | 12 s | 2 s | 53 s | 07:49:01 | 12:46 | Speechmatics (pyannoteAI 402) |
| 14 | `-kSZAvMDzC8` | Digitalna Kultura | 110:23 | 04:02:05 | 07:49:02 | 226:57 | 48 s | 3 s | 1:59 | 3:56 | 1 s | 1 s | 36 s | 11:57 | · | 20 s | 4 s | 1:53 | 6 s | 4:08 | 23 s | 2 s | 11:58 | 08:27:18 | 26:15 | Speechmatics (pyannoteAI 402) |
| 15 | `VbFzr-R79r4` | PSIHOLOGiJA / HRT | 67:28 | 04:02:05 | 08:27:18 | 265:13 | 34 s | 3 s | 1:42 | 2:18 | 1 s | · | 27 s | 5:58 | 1 s | 1:30 | 5 s | 1:40 | 4 s | 2:24 | 16 s | 2 s | 1:14 | 08:45:38 | 17:03 | Speechmatics (pyannoteAI 402) |
| 16 | `jYCIKsaA6Ys` | HRT vijesti | 30:05 | 04:02:06 | 08:45:38 | 283:32 | 19 s | 1 s | 1:21 | 1:24 | 1 s | · | 29 s | 2:32 | · | 9 s | 2 s | 1:47 | 3 s | 1:10 | 11 s | 2 s | 1:10 | 08:56:20 | 9:29 | Speechmatics (pyannoteAI 402) |
| 17 | `4T8iHbidRqc` | Radio MIR Međugorje | 30:48 | 04:02:06 | 08:56:20 | 294:14 | 19 s | 1 s | 1:45 | 1:44 | 1 s | · | 27 s | 2:18 | 1 s | 9 s | 1 s | 1:35 | 3 s | 1:04 | 9 s | 2 s | 1:02 | 09:07:02 | 9:37 | Speechmatics (pyannoteAI 402) |
| 18 | `NbLmTuhikJ4` | HRT vijesti | 52:01 | 04:02:06 | 09:07:02 | 304:56 | 30 s | 2 s | 1:17 | 2:06 | 1 s | 1 s | 35 s | 4:12 | 1 s | 16 s | 2 s | 1:57 | 5 s | 2:03 | 17 s | 3 s | 20 s | 09:20:50 | 13:25 | Speechmatics (pyannoteAI 402) |
| 19 | `0sxT3NF8yFg` | VTV Televizija | 30:45 | 04:02:06 | 09:20:49 | 318:43 | 19 s | 1 s | 1:23 | 48 s | 1 s | · | 49 s | 2:38 | · | 59 s | 5 s | 1:18 | 4 s | 1:14 | 13 s | 3 s | 54 s | 09:31:38 | 9:52 | Speechmatics (pyannoteAI 402) |

## Magisterium HR, EN prijevod i Magisterium EN

| # | video | kanal | članak gotov | EN tick | EN | Mag HR tick | Mag HR | poziva | čekanje HR | Mag EN | sve gotovo |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `pIx_7N-6HJ4` | Mreže riječi | 03:58:13 (nightly) | 04:02:08–04:04:18 | 2:10 | nije u planu | – | – | – | – | 04:04:18 |
| 2 | `uw5vYIdAHeM` | Ora et Labora | 03:58:13 (nightly) | 04:17:19–04:20:42 | 3:23 | 04:02:18–04:14:05 | 11:47 | 13 | 4:05 | s EN tickom | 04:20:42 |
| 3 | `3GGuSVt4Q4Y` | Radio Mrežnica | 03:58:13 (nightly) | 04:09:57–04:13:16 | 3:19 | nije u planu | – | – | – | – | 04:13:16 |
| 4 | `uMVmX4GDYag` | Radio Mrežnica | 03:58:13 (nightly) | 04:06:18–04:07:56 | 1:38 | nije u planu | – | – | – | – | 04:07:56 |
| 5 | `valMgmN1tXA` | Explora / HRT | 04:23:14 | 04:24:44–04:27:40 | 2:56 | 04:34:07–04:46:17 | 12:10 | 16 | 10:53 | 10:20:17 (kasni, 1:10) | 10:25:01 |
| 6 | `GpPzKW6eUQM` | Eduza | 04:46:06 | 05:15:05–05:19:57 | 4:52 | 04:56:18–05:11:03 | 14:45 | 17 | 10:12 | s EN tickom | 05:19:57 |
| 7 | `sNbOUa-hQSc` | Netokracija | 05:10:30 | 05:10:19–05:13:04 | 2:45 | 05:21:04–05:29:20 | 8:16 | 13 | 10:34 | 10:14:31 (kasni, 1:01) | 10:18:16 |
| 8 | `OMmfDf5gEX0` | Ideje | 05:28:47 | 05:28:03–05:30:52 | 2:49 | 05:39:21–05:48:19 | 8:58 | 14 | 10:34 | 10:14:31 (kasni, 1:01) | 10:18:16 |
| 9 | `F7xiNXvwm1s` | Ideje | 05:45:32 | 05:45:04–05:47:22 | 2:18 | 06:08:20–06:15:05 | 6:45 | 10 | 22:48 | 10:14:31 (kasni, 52 s) | 10:18:16 |
| 10 | `fUFlhmqBVMs` | Tribina | 06:12:58 | 06:09:40–06:14:38 | 4:58 | 06:25:05–06:41:01 | 15:56 | 26 | 12:07 | 10:20:17 (kasni, 2:02) | 10:25:01 |
| 11 | `QtqZiG3FMtM` | Telegram.hr | 06:22:06 | 06:22:44–06:24:56 | 2:12 | 06:51:01–06:55:49 | 4:48 | 8 | 28:55 | 10:27:02 (kasni, 37 s) | 10:30:33 |
| 12 | `AsbxJB5vshI` | Podcast Inkubator | 06:41:56 | 06:41:09–06:44:47 | 3:38 | 07:05:50–07:20:43 | 14:53 | 21 | 23:54 | 10:38:15 (kasni, 1:10) | 10:45:15 |
| 13 | `85LE9OLR7_s` | Ofenziva - Sportski podc | 07:00:12 | 06:58:58–07:02:08 | 3:10 | 07:30:43–07:39:58 | 9:15 | 16 | 30:31 | 10:32:34 (kasni, 1:04) | 10:36:15 |
| 14 | `5euYYTuybzY` | PODCAST BOG I HRVATI | 07:18:31 | 07:18:22–07:21:12 | 2:50 | 07:49:59–08:03:20 | 13:21 | 15 | 31:28 | 10:20:17 (kasni, 1:10) | 10:25:01 |
| 15 | `pqPh1taQ2Gg` | radiobenkovac | 07:35:18 | 07:35:24–07:38:38 | 3:14 | 08:13:20–08:33:51 | 20:31 | 16 | 38:02 | 10:38:15 (kasni, 1:04) | 10:45:15 |
| 16 | `sTvZUW2v6K8` | Vox Medicus | 07:49:01 | 07:48:46–07:50:58 | 2:12 | 08:43:51–08:54:00 | 10:09 | 11 | 54:50 | 10:32:34 (kasni, 1:31) | 10:36:15 |
| 17 | `-kSZAvMDzC8` | Digitalna Kultura | 08:27:18 | 08:27:48–08:32:26 | 4:38 | 09:04:00–09:22:18 | 18:18 | 28 | 36:42 | 10:27:02 (kasni, 2:00) | 10:30:33 |
| 18 | `VbFzr-R79r4` | PSIHOLOGiJA / HRT | 08:45:38 | 08:44:36–08:48:15 | 3:39 | 09:47:15–10:02:28 | 15:13 | 14 | 61:37 | 10:38:15 (kasni, 1:13) | 10:45:15 |
| 19 | `jYCIKsaA6Ys` | HRT vijesti | 08:56:20 | 08:56:22–08:58:31 | 2:09 | 09:32:19–09:37:15 | 4:56 | 9 | 35:59 | 10:32:34 (kasni, 46 s) | 10:36:15 |
| 20 | `4T8iHbidRqc` | Radio MIR Međugorje | 09:07:02 | 09:08:39–09:10:46 | 2:07 | 10:12:28–10:18:07 | 5:39 | 8 | 65:26 | 10:27:02 (kasni, 34 s) | 10:30:33 |
| 21 | `NbLmTuhikJ4` | HRT vijesti | 09:20:50 | 09:20:56–09:23:35 | 2:39 | 10:51:08–11:08:52 | 17:44 | 18 | 90:18 | 11:09:43 (kasni, 1:31) | 11:11:24 |
| 22 | `0sxT3NF8yFg` | VTV Televizija | 09:31:38 | 10:38:15–10:45:15 | 7:00 | 10:28:08–10:41:07 | 12:59 | 10 | 56:30 | s EN tickom | 10:45:15 |

## Nightly: skupni koraci (sve 4 epizode zajedno)

| KORAK | opis | početak | trajanje |
|---|---|---|---|
| 0 | Skidanje novih diarisation fajlova s Google Drive-a | 03:00:11 | 6 s |
| 1 | Osvježavanje i preuzimanje podcasta | 03:00:17 | 2:56 |
| 2 | Konverzija MP3 → WAV | 03:03:13 | 8 s |
| 2.5 | Upload WAV datoteka na Google Drive | 03:03:21 | 1:18 |
| 2.6 | Modal on-demand Canary transkripcija [--with-modal-transcr | 03:04:39 | 5:29 |
| 2.7b | Soniox cloud ASR [--with-soniox] (fallback Speechmatics) | 03:10:08 | 4:56 |
| 2.7c | pyannoteAI govornici + hibrid [--with-pyannote-ai] | 03:15:04 | 3:09 |
| 2.8 | promocija kostura (auto) BEZ Gemini sluha [--no-gemini-ear | 03:18:13 | 4 s |
| 7 | Gemini Sumarizacija transkripata | 03:18:17 | 2:00 |
| 8 | Gemini Generiranje članaka | 03:20:17 | 15:55 |
| 9 | RAG priprema (chunkanje i import) | 03:36:12 | 5 s |
| 9.4 | Beamly video download (matchane subclub/launched) | 03:36:17 | 0 s |
| 9.5 | Generiranje OG-share varijante (1200×630 progressive JPEG  | 03:36:17 | 0 s |
| 9.7 | WebP thumbnail varijante (320/640/1280 q80) | 03:36:17 | 1 s |
| 10 | YouTube screenshotovi (yt-dlp + ffmpeg) | 03:36:18 | 5:56 |
| 9.6 | Generiranje OG-sections composite-a (per-section Tier B) | 03:42:14 | 1:00 |
| 9.8 | EPUB e-knjige (article.json + screenshotovi → .epub) | 03:43:14 | 10 s |
| 9.85 | sponzori u snimci (opis + poglavlja + transkript → sponsor | 03:43:24 | 24 s |
| 9.87 | vrijeme po riječi za titl (diarized.srt + Soniox/Speechmat | 03:43:48 | 0 s |
| 9.9 | kandidati za reels/shorts (segments.jsonl + words.json → r | 03:43:48 | 6:57 |
| 12 | Cloudflare R2 upload (cdn.domovina.ai) | 03:50:45 | 1:45 |
| 12.5 | H.264 cross-platform video (video_h264.mp4) | 03:52:30 | 4:20 |
| 12.6 | Audio-only .mp3 upload (data/{id}/audio.mp3) | 03:56:50 | 0 s |
| 12.65 | WebP screenshotovi (960 px q80, PNG ostaje) | 03:56:50 | 30 s |
| 12.66 | nadograđene e-knjige (book.epub) na CDN | 03:57:20 | 0 s |
| 12.7 | episode.json bundle (data/{id}/episode.json) | 03:57:20 | 21 s |
| 13 | Channel index regen + meta upload | 03:57:41 | 32 s |
| | **ukupno run_pipeline.sh** | 03:00:11 | **58:02** |

| video | kanal | audio | Soniox | sažetak | članak | reels | EN | Mag HR |
|---|---|---|---|---|---|---|---|---|
| `pIx_7N-6HJ4` | Mreže riječi | 32:07 | 45 s | 19 s | 2:45 | 1:34 | 2:10 | – |
| `uw5vYIdAHeM` | Ora et Labora | 57:44 | 1:16 | 32 s | 3:40 | 1:16 | 3:23 | 11:47 |
| `3GGuSVt4Q4Y` | Radio Mrežnica | 81:14 | 1:59 | 37 s | 6:10 | 2:29 | 3:19 | – |
| `uMVmX4GDYag` | Radio Mrežnica | 28:00 | 46 s | 28 s | 2:59 | – | 1:38 | – |

## Prilog: svaki korak svake Tier 2 epizode

**1. `valMgmN1tXA` · Explora | HRT** · audio 53:28 · done · Explora 03.11.2026. Otkriven planet

| 1 | 2.6 | 2.7b | 2.7c | 7 | 8 | 10 | 9.6 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 04:03:31 | 04:03:50 | 04:05:38 | 04:06:46 | 04:07:33 | 04:08:00 | 04:16:19 | 04:18:00 | 04:18:06 | 04:19:39 | 04:19:43 | 04:21:33 | 04:21:45 |
| 17 s | 1:48 | 1:08 | 47 s | 27 s | 8:18 | 1:41 | 3 s | 1:33 | 4 s | 1:50 | 12 s | 3 s |

**2. `GpPzKW6eUQM` · Eduza** · audio 86:31 · done · Postali ste coach, i što sada? Coaching kao biznis | Višnja Željeznjak

| 1 | 2 | 2.6 | 2.7b | 2.7c | 7 | 8 | 10 | 9.6 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 04:23:18 | 04:24:04 | 04:24:07 | 04:25:47 | 04:27:36 | 04:28:54 | 04:29:27 | 04:38:19 | 04:40:05 | 04:40:10 | 04:42:09 | 04:42:14 | 04:45:17 | 04:45:30 |
| 46 s | 3 s | 1:40 | 1:49 | 1:17 | 33 s | 8:51 | 1:46 | 3 s | 1:59 | 5 s | 3:03 | 13 s | 3 s |

**3. `KyMHBGFS5Gc` · ** · audio – · failed · S3E09 PSIHOLOGiJA #90 Burnout ( Krunoslav Nujić i dr.med Goran Ivkić)


❌ prioritetni download nije uspio (private/anti-bot?) — nema info.json u _unlisted

**4. `sNbOUa-hQSc` · Netokracija** · audio 63:22 · done · Puca li AI balon u 2027.? | S7.EP5

| 1 | 2.6 | 2.7b | 2.7c | 7 | 8 | 10 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 04:52:16 | 04:53:25 | 04:54:57 | 04:56:02 | 04:57:05 | 04:57:36 | 05:03:36 | 05:04:27 | 05:06:31 | 05:06:35 | 05:08:51 | 05:09:00 |
| 1:07 | 1:32 | 1:05 | 1:02 | 31 s | 5:59 | 49 s | 2:04 | 4 s | 2:16 | 9 s | 4 s |

**5. `OMmfDf5gEX0` · Ideje** · audio 70:21 · done · Šikić i Čačić: Može li AI zamijeniti matematičare?

| 1 | 2 | 2.6 | 2.7b | 2.7c | 7 | 8 | 10 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 05:10:35 | 05:11:07 | 05:11:10 | 05:13:03 | 05:14:11 | 05:14:58 | 05:15:34 | 05:21:46 | 05:23:14 | 05:25:39 | 05:25:44 | 05:28:14 | 05:28:25 |
| 32 s | 3 s | 1:53 | 1:08 | 47 s | 36 s | 6:12 | 1:24 | 2:25 | 5 s | 2:29 | 11 s | 3 s |

**6. `F7xiNXvwm1s` · Ideje** · audio 54:35 · done · Lulin veliki preokret i Bolsonarov špijunski bijeg Trumpu

| 1 | 2.6 | 2.7b | 2.7c | 7 | 8 | 10 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 05:28:50 | 05:29:16 | 05:31:00 | 05:33:10 | 05:33:58 | 05:34:34 | 05:38:59 | 05:40:03 | 05:42:32 | 05:42:36 | 05:44:31 | 05:44:38 |
| 24 s | 1:44 | 2:10 | 47 s | 36 s | 4:25 | 1:01 | 2:29 | 4 s | 1:55 | 7 s | 4 s |

**7. `fUFlhmqBVMs` · Tribina** · audio 144:42 · done · Kimi Antonelli | F1Puls podcast #71

| 1 | 2 | 2.6 | 2.7b | 2.7c | 7 | 8 | 10 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 05:45:35 | 05:47:20 | 05:47:24 | 05:49:14 | 05:51:03 | 05:51:06 | 05:51:52 | 06:04:06 | 06:04:50 | 06:06:52 | 06:06:57 | 06:12:02 | 06:12:19 |
| 1:45 | 4 s | 1:50 | 1:49 | 3 s | 46 s | 12:13 | 41 s | 2:02 | 5 s | 5:05 | 16 s | 5 s |

**8. `QtqZiG3FMtM` · Telegram.hr** · audio 24:51 · done · Kreće obračun: Vučićeva skandalozna izjava otkriva strah

| 1 | 2.6 | 2.7b | 7 | 8 | 10 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|
| 06:13:00 | 06:13:16 | 06:14:31 | 06:15:19 | 06:15:41 | 06:17:54 | 06:18:04 | 06:19:41 | 06:19:44 | 06:20:36 | 06:20:41 |
| 15 s | 1:15 | 47 s | 22 s | 2:13 | 9 s | 1:37 | 3 s | 52 s | 5 s | 3 s |

**9. `AsbxJB5vshI` · Podcast Inkubator** · audio 88:59 · done · Podcast Inkubator #1509 - Ratko i Domagoj Delač (Best Food Croatia)

| 1 | 2 | 2.6 | 2.7b | 7 | 8 | 10 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 06:22:08 | 06:22:53 | 06:22:56 | 06:24:52 | 06:26:21 | 06:27:05 | 06:35:10 | 06:35:29 | 06:37:21 | 06:37:27 | 06:40:36 | 06:40:51 |
| 45 s | 3 s | 1:56 | 1:27 | 44 s | 8:05 | 16 s | 1:52 | 6 s | 3:09 | 14 s | 3 s |

**10. `85LE9OLR7_s` · Ofenziva - Sportski podcast** · audio 79:38 · done · Ofenziva rasprave: Jeste li se mogli obogatiti uz Losa?

| 1 | 2 | 2.6 | 2.7b | 7 | 8 | 10 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 06:41:59 | 06:42:29 | 06:42:32 | 06:44:06 | 06:45:58 | 06:46:32 | 06:53:50 | 06:54:03 | 06:55:47 | 06:55:52 | 06:58:33 | 06:58:43 |
| 30 s | 3 s | 1:34 | 1:50 | 34 s | 7:17 | 11 s | 1:44 | 5 s | 2:41 | 10 s | 3 s |

**11. `5euYYTuybzY` · PODCAST BOG I HRVATI** · audio 62:34 · done · Gostuje dr.  sc.  Krešimir Bušić

| 1 | 2 | 2.6 | 2.7b | 7 | 8 | 10 | 9.6 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 07:00:15 | 07:00:49 | 07:00:52 | 07:02:20 | 07:06:34 | 07:07:05 | 07:11:47 | 07:13:12 | 07:13:17 | 07:14:59 | 07:15:05 | 07:17:14 | 07:17:25 |
| 34 s | 3 s | 1:28 | 4:12 | 31 s | 4:42 | 1:25 | 3 s | 1:42 | 6 s | 2:09 | 11 s | 3 s |

**12. `pqPh1taQ2Gg` · radiobenkovac** · audio 55:02 · done · Što znači biti učitelj - prof. Marijan Pranjić

| 1 | 2 | 2.6 | 2.7b | 7 | 8 | 10 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 07:18:34 | 07:18:59 | 07:19:02 | 07:20:37 | 07:23:14 | 07:23:48 | 07:28:08 | 07:30:16 | 07:31:41 | 07:31:46 | 07:33:39 | 07:33:50 |
| 25 s | 3 s | 1:35 | 2:36 | 34 s | 4:19 | 2:04 | 1:25 | 5 s | 1:53 | 11 s | 4 s |

**13. `sTvZUW2v6K8` · Vox Medicus** · audio 33:12 · done · PEDIJATRIJSKA RADIOLOGIJA, dr.med. Natko Beck, spec. radiologije

| 1 | 2.6 | 2.7b | 7 | 8 | 10 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|
| 07:35:22 | 07:35:42 | 07:37:29 | 07:38:18 | 07:38:45 | 07:44:32 | 07:44:57 | 07:46:39 | 07:46:44 | 07:47:56 | 07:48:04 |
| 19 s | 1:47 | 48 s | 27 s | 5:46 | 22 s | 1:42 | 5 s | 1:12 | 8 s | 3 s |

**14. `-kSZAvMDzC8` · Digitalna Kultura** · audio 110:23 · done · MacBook Pro dobiva touchscreen: što će nam sada iPad?

| 1 | 2 | 2.6 | 2.7b | 7 | 8 | 10 | 9.6 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 07:49:05 | 07:49:53 | 07:49:56 | 07:51:55 | 07:55:53 | 07:56:29 | 08:08:26 | 08:08:46 | 08:08:50 | 08:10:43 | 08:10:49 | 08:14:58 | 08:15:16 |
| 48 s | 3 s | 1:59 | 3:56 | 36 s | 11:57 | 20 s | 3 s | 1:53 | 6 s | 4:08 | 18 s | 4 s |

**15. `VbFzr-R79r4` · PSIHOLOGiJA | HRT** · audio 67:28 · done · S3E09 PSIHOLOGiJA #90 Burnout (Krunoslav Nujić i dr. med. Goran Ivkić)

| 1 | 2 | 2.6 | 2.7b | 7 | 8 | 10 | 9.6 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 08:27:21 | 08:27:55 | 08:27:58 | 08:29:40 | 08:31:59 | 08:32:26 | 08:38:25 | 08:39:55 | 08:40:00 | 08:41:40 | 08:41:44 | 08:44:08 | 08:44:20 |
| 34 s | 3 s | 1:42 | 2:18 | 27 s | 5:58 | 1:30 | 3 s | 1:40 | 4 s | 2:24 | 11 s | 3 s |

**16. `jYCIKsaA6Ys` · HRT vijesti** · audio 30:05 · done · Otvoreno: Međuizbori kao prekretnica američke politike

| 1 | 2.6 | 2.7b | 7 | 8 | 10 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|
| 08:45:41 | 08:46:01 | 08:47:22 | 08:48:47 | 08:49:16 | 08:51:48 | 08:51:59 | 08:53:46 | 08:53:49 | 08:55:00 | 08:55:06 |
| 19 s | 1:21 | 1:24 | 29 s | 2:32 | 9 s | 1:47 | 3 s | 1:10 | 6 s | 3 s |

**17. `4T8iHbidRqc` · Radio MIR Međugorje** · audio 30:48 · done · Miris zavičaja 1. 11. 2026. - dr. sc. Marija Bošnjak  - monografija Povjestice

| 1 | 2.6 | 2.7b | 7 | 8 | 10 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|
| 08:56:23 | 08:56:43 | 08:58:28 | 09:00:13 | 09:00:40 | 09:02:59 | 09:03:09 | 09:04:44 | 09:04:47 | 09:05:52 | 09:05:57 |
| 19 s | 1:45 | 1:44 | 27 s | 2:18 | 9 s | 1:35 | 3 s | 1:04 | 4 s | 3 s |

**18. `NbLmTuhikJ4` · HRT vijesti** · audio 52:01 · done · Romano Bolković - 1 na 1: Christian Leuprecht

| 1 | 2.6 | 2.7b | 7 | 8 | 10 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|
| 09:07:05 | 09:07:37 | 09:08:54 | 09:11:02 | 09:11:37 | 09:15:50 | 09:16:08 | 09:18:05 | 09:18:10 | 09:20:13 | 09:20:25 |
| 30 s | 1:17 | 2:06 | 35 s | 4:12 | 16 s | 1:57 | 5 s | 2:03 | 12 s | 5 s |

**19. `0sxT3NF8yFg` · VTV Televizija** · audio 30:45 · done · Pravi smjer 3. studenoga 2026.

| 1 | 2.6 | 2.7b | 7 | 8 | 10 | 9.6 | 9.9 | 12 | 12.5 | 12.65 | 12.68 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 09:20:52 | 09:21:12 | 09:22:35 | 09:23:24 | 09:24:13 | 09:26:51 | 09:27:50 | 09:27:55 | 09:29:13 | 09:29:17 | 09:30:32 | 09:30:40 |
| 19 s | 1:23 | 48 s | 49 s | 2:38 | 59 s | 3 s | 1:18 | 4 s | 1:14 | 8 s | 4 s |

Prikazani su koraci od 3 s naviše; kraći su zbrojeni u fazama u tablici gore.
