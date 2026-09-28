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

## Lokacije, cjenik, krediti, Priority (drugi prolaz 28.09.)

**Gdje `gemini-3.8-flash` postoji.** Mini poziv na svih 29 Vertex regija i 3 lokacije:
**samo `global`, `eu` i `us`.** Sve pojedinačne regije (SAD, Kanada, Brazil,
cijela Europa, Azija, Australija, Bliski istok) vraćaju 404. Rotacija „po
svijetu” ima dakle najviše **3 bazena**. (`gemini-3.5-flash` postoji na 10
lokacija, uključujući `asia-*` i `australia-southeast1`, ali to je drugi model.)

**Cjenik** (cloud.google.com/vertex-ai/generative-ai/pricing, 28.09.):

| gemini-3.8-flash, po 1M tokena | ulaz | izlaz |
|---|---|---|
| `global`, promo do 31.12.2026. | $0,75 | $3,75 |
| **ne-global (`eu`, `us`), promo** | **$0,825** (+10 %) | **$4,125** (+10 %) |
| od 01.01.2027. `global` / ne-global | $1,50 / $1,65 | $7,50 / $8,25 |
| Priority PayGo, `global` | $1,35 (1,8×) | — |
| Flex/Batch, `global` | $0,375 (0,5×) | — |

Ne-global doplatak vrijedi od 01.07.2026.; prije toga ne-global se naplaćivao po global cijeni.

**Free trial krediti ne ovise o regiji.** Uvjeti isključuju samo Gemini API u AI
Studiju i partnerske MaaS modele. `global` smo 27.06. uzeli zbog **dostupnosti**
modela, a ne zbog kredita. Dok je billing račun u trial načinu, **ne može se
tražiti povećanje kvote**.

**Priority PayGo** (zaglavlja `X-Vertex-AI-LLM-Request-Type: shared` i
`X-Vertex-AI-LLM-Shared-Request-Type: priority`; `global`, `eu`, `us`):
- trial račun ga prihvaća: jedan poziv je vratio `trafficType: ON_DEMAND_PRIORITY`;
- u naletu od 150 poziva **svi su spušteni na `ON_DEMAND`** (priority ima vlastito
  ograničenje propusnosti);
- zato nije uključen, uz cijenu od 1,8× po tokenu.

**Odluka (Matija, 28.09.):** lokacija obrade podcasta je nebitna, cilj je što
manje 429. Zato je od 28.09. `VERTEX_REGIONS=global,eu,us`:
- `summarize`, `article` i `translate` rotiraju po pozivu (round-robin);
- `translate` sad čita `gemini.conf`, a dosad je čitao samo env (default `global`);
- `refine` na 429 prelazi na sljedeći bazen nakon 1 s, a čeka tek kad su u nizu
  odbile sve regije.

Trošak raste oko 6,7 % (dvije trećine poziva uz +10 %). `.gemini_usage.json`
računa po `global` cijenama, pa ga podcjenjuje za toliko.

Provjereno: sažetak s tri regije (put preko `gclouda`) i refine na 2 prozora
prolaze, a svih 172 testa prolazi. **Rotacija u refineu nije aktivirana**
stvarnim 429 u testu.

## Zaključak

1. **`eu` nema bolji rate limit od `global`.** Bazen je podjednak ili manji, a
   nakon naleta se oporavlja sporije od minute. Latencija je ista.
2. **`eu` je zaseban bazen.** Dok je vraćao 150 × 429, `global` je radio. Skripte
   već rotiraju regije po pozivu i nakon 429 (`getNextRegion()`), pa
   `VERTEX_REGIONS=global,eu` daje nightlyju otprilike dva bazena. Cijena toga je
   da dio podataka ide izvan EU, što je za javne podcaste prihvatljivo.
3. **Za Zapis** (rezidencija podataka) koristi se `VERTEX_REGIONS=eu` i Speechmatics `eu1`.

## Otvoreno

- Izmjeriti broj 429 u nightlyju prije i poslije uključivanja `global,eu,us`
  (grep `429` u logu nightlyja).
- **Put `VERTEX_SA_KEY_FILE` nije testiran na stvarnom ključu** (u ovoj sesiji nije
  napravljen SA ključ). Testirani su `VERTEX_ACCESS_TOKEN` (end-to-end, članak na
  `eu`) i `gcloud` (164 postojeća testa i dosadašnji put).
- Refine (KORAK 2.8) na `eu` nije vrtio stvarnu epizodu.

## Vezani dokumenti

- `../zapis.domovina.ai/docs/2026-09-28-plan.md` — Zapis plan (F0 = ovaj dokument)
- `docs/2026-09-26-audio-datoteka-u-clanak.md` — demo snimka korištena za mjerenje
- `docs/2026-09-19-speechmatics-kostur-gemini-sluh.md` — KORAK 2.7/2.8
