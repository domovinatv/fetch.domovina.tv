# Audit rupa u objavljenom sadržaju — 2026-07-25

Recompute stvarnog stanja CDN-a + izvršen og-sections backfill. Ovaj dokument je SSOT za
preostale rupe; **brojke su point-in-time** — prije nastavka uvijek recompute (vidi
[Metoda](#metoda-recomputea)), ne kreći po ovim brojevima naslijepo.

Povod: memorijske bilješke o backfill stanju bile su zastarjele (u međuvremenu je bilo
nightly runova), pa je cijelo stanje ponovno izvedeno iz CDN-a.

---

## Rezultat: Blok 1 (og-sections) ZAVRŠEN

| | |
|---|---|
| Videa | 56/56, 0 grešaka |
| Generirano | 3377 `og-t-*.jpg` + 56 `manifest.json` |
| Uploadano | 3433 nova ključa, 312.9 MB, 0 neuspjelih |
| Verifikacija | svih 56 → `og-sections.json` 200 + sample JPG 200; re-LIST → kategorija = 0 |
| R2 ključevi | 148.858 → 152.291 |
| LLM trošak | **$0** (sve regenerirano iz postojećih CDN artefakata) |
| Trajanje | ~75 min generacije + ~4 min upload |

Alat: `backfill_og_sections_from_cdn.py --ids-file <lista>` →
`node upload_to_r2.js --input-dir storage/output --channel _ogbackfill`.
Temp kanal `storage/output/_ogbackfill` (320 MB) obrisan nakon verifikacije.

### Što se naučilo u ovom runu

1. **Ne treba `force_upload.js` ni CF purge.** Ti ključevi prije nisu postojali, pa ih obični
   `upload_to_r2.js` uredno objavi. Pravilo o write-once immutable `data/*/*.json` vrijedi
   samo kad ključ VEĆ postoji.
2. **Ne treba reindex / KORAK 13.** `channels/data/*.json` pipeline flagovi ne prate
   og-sections; worker čita `images/{id}/og-sections.json` direktno.
3. **Nema stale-404 problema** — `og-sections.json` se servira `cf-cache-status: DYNAMIC`
   (nije cacheable), za razliku od immutable slika. Dva manifesta koja sam GET-ao dok su
   bili 404 nisu ostala zaglavljena u cacheu.
4. **Prosjek je ~60 sekcija/video, ne ~25** — planiraj vrijeme po broju sekcija, ne videa.
   Početna procjena od 1400 composita bila je 2,4× premala.

---

## Metoda recomputea

Ključno: **diff prema CDN-u, ne prema lokalnom disku.**

1. Svjež `ListObjectsV2` cijelog bucketa (paginirano, `MaxKeys: 1000`) → popis svih ključeva.
   NE koristiti `.r2_keys_cache.json` za audit — zaostaje za nightly runovima.
2. `channels/data/index_bundle.json` s CDN-a → mapiranje `video_id → kanal` + naslovi/flagovi.
   Napomena: bundle pokriva samo indeksirane kanale; `_unlisted`/ad-hoc videi u njemu nisu.
3. Za "referencirano ali nedostaje" provjere (screenshoti): reference iz **lokalnih**
   `.article.json` (dedup: leksikografski najveći `_{date}_{model}.article.json` po video ID),
   prisutnost iz **R2 LIST-a**. Lokalno = izvor referenci, R2 = izvor istine o prisutnosti.
4. **Uvijek isključi Beamly audio-only** (`data/{id}/audio.mp3` bez `video_h264.mp4`, odn.
   `info.json._yt_matched === false`) — inače dobiješ 154 lažna pozitivna na og-sections i
   screenshotima. Oni ISPRAVNO nemaju te artefakte.

Baseline 2026-07-25: 3172 videa s `data/{id}/`, 3056 s `article.json`, 167 audio-only.

---

## Preostale rupe

### Blok 2 — screenshot 404 + nepotpuni og-sections (11 videa) — NIJE RAĐEN

Sistemski uzrok, ne slučajni kvar: objavi se **noviji** članak s drugim timestampovima
(leksikografski dedup, npr. `claude-code:opus` pobijedi `gemini-*`), a screenshoti ostanu od
stare verzije → svaki referencirani frame 404. Posljedično i og-t fali jer se gradi iz
screenshota.

**Potpuno slomljen (21/21 frame 404):**
- `AMv-2r5YFac` (founder_talks) — CDN ima Opus članak s 21 timestampom, screenshoti od starije
  gemini verzije. Potvrđeno: `images/AMv-2r5YFac/screenshots/00-00-35.png` → 404.

**Off-by-one (po 1 frame), svi subclub:**
- `eKVHg2z3E_8` → `00-19-25.png`
- `UCiGz2aBUhU` → `00-21-25.png`
- `0qt-wHxiFMY` → `00-26-50.png`

**Nepotpun og-sections (manifest postoji, og-t < broja sekcija) — isti uzrok:**

| video | kanal | sekcija | og-t |
|---|---|---|---|
| `AMv-2r5YFac` | founder_talks | 20 | 19 |
| `Pza2pK1Yzos` | nanovoroeni | 32 | 31 |
| `Ab4ufyxWbSA` | nanovoroeni | 49 | 48 |
| `5YR5HdKTjOw` | radio_mreznica | 36 | 35 |
| `eKVHg2z3E_8` | subclub | 10 | 9 |
| `UCiGz2aBUhU` | subclub | 15 | 14 |
| `0qt-wHxiFMY` | subclub | 11 | 10 |

**Fix traži re-fetch** (`screenshot_youtube.js` prema YouTubeu) → nosi anti-bot rizik, zato
ga NE pokretati prije velikih sigurnih backfilla, nego poslije.
`backfill_og_sections_from_cdn.py` ih ne rješava jer nema izvorni frame.

> **Ispravak starije dijagnoze:** `xCE4o-v_jT8` je bio vođen kao screenshot-404 slučaj. Nije —
> ima 69 screenshotova za 68 sekcija, svi GET 200. Falile su mu samo og-sections; riješen je
> Blokom 1.

### Blok 3 — Magisterium (68 ready epizoda)

| kanal | ima/ukupno | fali | ready (ima članak) | blokirano na NO_ARTICLE |
|---|---|---|---|---|
| catholic_futurist | 15/18 | 3 | 2 | `biRibr8NByE` |
| iva_kraljevic | 7/62 | 55 | **54** | `0PHqPy1Khrs` |
| bozanstvena_komedija | 27/35 | 8 | 8 | — |
| muzevni_budite | 65/71 | 6 | 3 | `iG2G9tLSyzs ZkMcSRvajCw tIUwvVfbPbI` |
| mladi_za_domovinu | 132/134 | 2 | 1 | `M_Qiu7MX7Fc` |

**Ready ID-evi:**

- catholic_futurist (2): `oY_cqjnAI5g 0sZaWRgnVWc`
- bozanstvena_komedija (8): `AHAoSdr3IRU qT7BWA2XwC4 b-abdSpsgmE 6pTOfuRkzJQ cTYzLV8O9iU DupCwGp_VrI XzbXb69cz58 3ZLpCri7rKc`
- muzevni_budite (3): `JDsdghnELbM rLGFxgV3SMs h8kT3I7kQ1I`
- mladi_za_domovinu (1): `_bYNrUFjW84`
- iva_kraljevic (54): `P9sLks-f2mQ RyDxJJyjyqw bBaDy9g5Omk F0Eh3ZitE94 dh8oaj6Q3qI lNDdCMgikDo yKXrBz22flw wva55ZIbtoM 4gWRQm9IOkQ b5VKyruzcas CTFYmyP7wkU X9dQ3vbMlug LLevFHUFrn4 oDZJZMhqwIU Lu1GHJtZj48 YIhT6STHep8 CSwhrJdMH2w 9dCkqPlSrA4 t-5ETYHpX8g 891g27nMYH8 PYBVJiNRoAQ l15AKREFxgQ nG8j0XkHR-Q NamKWyUNrbU 2qcQDrMI9yE lekteHsEwlQ Gz39NAhdHy4 9rKo8Z_ECDI 5y9fNtjRVhg zhDKOQ_m7N0 DqoiBH2YvZk -oDbLMBZq1s Z_PFjmDQo2I yFm7R2kNjes TVGkjJXLjrg nPBMUiKnAjo x5gRFwP3ITo l4lOHhm-aO4 dSvIq7Y1W4Y oz7uO0MrWVE QLse_eF8lrM w0x6MWUFitc xfv5U-_GTq0 JqC4-KT8sdc zzmZGMS-g2M BXzLLYF3DUg CxRP2sGbdtU hjF1I8-wS_c g9btCi3iybs hZB-O1v5_jM Svd2Hli0Yj4 45GL_iLyQXM 7rnPonn_ia4 H10klJy_5L8`

Preporučeni redoslijed: **prvo repovi** (14 ep, ~3.2 h) jer zatvaraju 4 od 5 kanala na 100 %,
**pa iva_kraljevic** (54 ep, ~12.5 h) u zasebnoj sesiji. Pravila: SAMO MCP (nikad API key),
subagent-po-epizodi, sekvencijalno, HR-only osim eksplicitnog `+EN`.

### Blok 4 — NO_ARTICLE (103 prave rupe)

Od 116 videa bez `article.json`, 13 su Beamly audio-only (12 launched + 1 subclub) — nemaju
transkript, to je zaseban problem.

**Ključni nalaz: svih 103 zaglavljeni su na TRANSKRIPCIJI, ne na članku.** Imaju `.wav`,
nemaju `.canary.srt`. Nijedan nije BLOCKED. Dakle ovo je **Colab batch posao**, ne Gemini —
gate je `.canary.diarized.srt` kao strogi preduvjet za korake 7-12.

| kanal | n | | kanal | n |
|---|---|---|---|---|
| **mladifest_hrvatska** | **64** | | zeljka_markic_i_narod_hr | 3 |
| slijedi_svoj_poziv_1 | 8 | | podcast_cuspajz | 3 |
| slijedi_svoj_poziv_2 | 6 | | muzevni_budite | 3 |
| na_kavi_sa_svetim_ignacijem | 5 | | lood_podcast | 2 |
| _unlisted/adhoc | 3 | | 6× kanal po 1 | 6 |

`mladifest_hrvatska` je faktički mrtav kanal — 64 videa, nula članaka; sam nosi 62 % ove rupe.
**Otvorena odluka: oživjeti kanal ili preskočiti?**

Procjena punog puta: ~$0.30 Colab transkripcija + ~8.5 h lokalne diarizacije (103 × ~5 min)
+ ~$4 Gemini (103 × ~$0.039) + screenshoti + og-sections + upload. Otključava i 6 zaostalih
Magisterium epizoda iz Bloka 3.

---

## Predloženi redoslijed (preostalo)

| # | Posao | Opseg | Trošak | Status |
|---|---|---|---|---|
| 1 | og-sections backfill | 56 videa | $0, ~75 min | ✅ **ZAVRŠENO** |
| 2 | screenshot 404 + nepotpuni og | 11 videa | ~$0, ~15 min, anti-bot rizik | ⏸️ preskočeno na zahtjev |
| 3a | Magisterium repovi | 14 ep | MCP, ~3.2 h | ⏳ |
| 3b | Magisterium iva_kraljevic | 54 ep | MCP, ~12.5 h | ⏳ |
| 4 | NO_ARTICLE | 103 videa | ~$4.30 + ~8.5 h | ⏳ (traži odluku o mladifest) |

## Okolina u trenutku audita

- Nijedan pipeline nije vrtio (`ps` čist) — nema locka, uvijek provjeriti prije pokretanja.
- DOMOVINA1TB: 93 GB slobodno (91 % puno) · DOMOVINA2TB: 533 GB slobodno · boot: 31 GB.
- Oba external volumea montirana (nužno — `storage/output/*` su symlinkovi na njih).
