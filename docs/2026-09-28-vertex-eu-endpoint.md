# Vertex `eu` endpoint + vjerodajnice bez gclouda (F0 za Zapis, 28.09.2026.)

F0 iz plana `../zapis.domovina.ai/docs/2026-09-28-plan.md`: pipeline mora znati
raditi (a) u EU i (b) s tuđim GCP vjerodajnicama, bez `gcloud` CLI-ja. Default
nightlyja se **ne mijenja**.

## Što je promijenjeno

| Datoteka | Promjena |
|---|---|
| `lib/vertex_auth.js` (novo) | `vertexEndpointUrl()` zna `global`, multi-regije `eu`/`us` (`aiplatform.{eu,us}.rep.googleapis.com`) i pojedinačne regije. `vertexAccessToken()`: `VERTEX_ACCESS_TOKEN` → `VERTEX_SA_KEY_FILE` (JWT-bearer u Nodeu) → `gcloud` kao dosad. |
| `summarize_gemini.js`, `generate_article_gemini.js`, `translate_to_english.js`, `refine_diarized_gemini.js` | koriste lib umjesto četiri kopije URL/token koda. `refine` je imao hardkodiran `global`, a sad čita prvu regiju iz `VERTEX_REGIONS`. |
| `summarize_gemini.js` → `summary.md` | nova aditivna polja `source.platform / source_url / yt_matched / local_file`. Lokalna snimka (`_local_file` u info.json) nema linkova; X dobiva x.com izvor, beamly bez YT para više nema lažan YouTube link. Stari JSON-i daju identičan Markdown. |
| `gemini.conf` | samo komentar: opcije `global` / `eu` / `global,eu`. Vrijednost je i dalje `global`. |

Speechmatics u EU ne traži kod: `SPEECHMATICS_API_BASE=https://eu1.asr.api.speechmatics.com/v2`
(naš ključ tamo daje 200, a `eu2` daje 401).

## Mjerenja

**Dostupnost modela** (mini `generateContent`, `bimbo-sync-prod`):

| Model | `global` | `eu` | europe-west1/4/9, north1 | europe-west3 |
|---|---|---|---|---|
| gemini-3.8-flash | 200 | **200** | 404 | 404 |
| gemini-3.5-flash | 200 | 200 | 404 | 200 |
| gemini-2.5-flash | 200 | 404 | 200 | 200 |

`global` je uzet 27.06. (`511de4aa`) jer je 3.x Flash tada bio samo na `global`.

**Stvarni posao:** snimka od 80 min (demo 26.09.), isti transkript.

| | `global` (26.09.) | `eu` (28.09., `VERTEX_ACCESS_TOKEN`) |
|---|---|---|
| sažetak | 18,6 s | 12,4 s |
| članak (3 poziva, ~115k+15k tok) | 5 min 34 s | **2 min 3 s** |
| 429 | 0 | 0 |

Za svaku stranu imamo jedan uzorak u različite dane, pa ne treba tvrditi da je
`eu` brži.

**Burst** (150 istovremenih kratkih poziva, `thinkingBudget: 0`):

| Scenarij | `eu` | `global` |
|---|---|---|
| 40 istovremenih, 4 kruga | 40/40 × 200, p50 ~1,5 s | 40/40 × 200, p50 ~1,5 s |
| 150, krug odmah nakon ~300 poziva | **12/150 × 200** (138 × 429) | 139/150 × 200 |
| 150, 60 s pauze prije | 150 × 429 (još se nije oporavio), pa 150 × 200 | 150 × 200 |
| p50 / p95 kad prolazi | 1,6–1,9 s / 2,4–2,6 s | 1,6–1,7 s / 2,3–2,7 s |

## Zaključak

1. **`eu` nema bolji rate limit od `global`.** Bazen je podjednak ili manji, a
   nakon naleta se oporavlja sporije od minute. Latencija je ista.
2. **`eu` je zaseban bazen.** Dok je vraćao 150 × 429, `global` je radio. Skripte
   već rotiraju regije po pozivu i nakon 429 (`getNextRegion()`), pa
   `VERTEX_REGIONS=global,eu` daje nightlyju otprilike dva bazena. Cijena toga je
   da dio podataka ide izvan EU, što je za javne podcaste prihvatljivo.
3. **Za Zapis** (rezidencija podataka) koristi se `VERTEX_REGIONS=eu` i Speechmatics `eu1`.

## Otvoreno

- **Cjenik `eu` nije provjeren.** `GEMINI_PRICE_*` i `.gemini_usage.json` računaju
  po `global` cijenama.
- **`global,eu` za nightly nije uključen.** To je odluka za Matiju; preduvjet je
  cjenik iznad.
- **Put `VERTEX_SA_KEY_FILE` nije testiran na stvarnom ključu** (u ovoj sesiji nije
  napravljen SA ključ). Testirani su `VERTEX_ACCESS_TOKEN` (end-to-end, članak na
  `eu`) i `gcloud` (164 postojeća testa i dosadašnji put).
- Refine (KORAK 2.8) na `eu` nije vrtio stvarnu epizodu.

## Vezani dokumenti

- `../zapis.domovina.ai/docs/2026-09-28-plan.md` — Zapis plan (F0 = ovaj dokument)
- `docs/2026-09-26-audio-datoteka-u-clanak.md` — demo snimka korištena za mjerenje
- `docs/2026-09-19-speechmatics-kostur-gemini-sluh.md` — KORAK 2.7/2.8
