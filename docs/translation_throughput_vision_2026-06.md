# EN prijevod — throughput vizija i rješenje uskog grla (2026-06-09)

**Status:** istraženo + empirijski potvrđeno. SSOT za odluke o EN-prijevodnom sloju.

## Problem (zatečeno stanje)

`translate_to_english.js` koristi Vertex AI `gemini-2.5-flash` (OAuth, regional rotacija
9 regija). Pri bulk-backfillu (npr. cijeli kanal `catholic_futurist`, ~1000 polja) udara u
**HTTP 429 "Resource exhausted"** kroz **sve** regije istovremeno → efektivno ~1 uspješan
zahtjev/minuti → ~16h+ za jedan kanal, većinom padova.

### Root-cause (potvrđeno `gcloud`-om + web researchom)

- `gemini-2.5-flash` je pod **Dynamic Shared Quota (DSQ)**: `gcloud alpha services quota list`
  pokazuje `effectiveLimit=None` u svim regijama → **nema fiksne RPM granice koja se može
  podići**; dobivaš koliko ima u globalnom dijeljenom bazenu u tom trenutku.
- **Rotacija regija je no-op** za 2.5-flash: svih 9 regija vuče iz istog DSQ bazena (zato
  padaju zajedno). Trik `VERTEX_REGIONS` pomaže samo starijim modelima s fiksnom per-region kvotom.
- Quota-increase request **ne postoji** za DSQ. Billing aktivnog projekta
  `project-a275a620-ef0c-45ae-99e` JE zdrav (dunning je bio samo stari `domovina-sync-ms`).

## Rješenje #1 (PRIMARNO, potvrđeno): prebaci model na preview/250-RPM

`gcloud alpha services quota list --service=aiplatform.googleapis.com` otkriva modele s
**fiksnih 250 RPM** (umjesto DSQ):

```
gemini-flash-early-exp / exp2 / exp3        → 250 RPM   (global)
gemini-flash-lite-early-exp / exp2 / exp3   → 250 RPM   (global)
gemini-pro-early-exp / exp2 / exp3          → 250 RPM   (global)
gemini-2.5-flash                            → DSQ (None) ← naš problem
gemini-1.5-*                                → 1 RPM
```

Callable publisher-aliasi (na **`global`** endpointu — preview modeli NISU u regionalnim):
- **`gemini-flash-latest`** — najbrži (~3.2s/poziv)
- **`gemini-3-flash-preview`** — Gemini 3 Flash (~5.3s/poziv), repo ga već koristio za članke
- (`gemini-3-pro-preview`, `gemini-flash-*-early-exp*` po imenu vraćaju 404 — koristi aliase gore)

### Empirijski burst-test (12 brzih uzastopnih poziva, 2026-06-09)

| Model | Endpoint | OK / 429 | Napomena |
|---|---|---|---|
| **gemini-flash-latest** | global | **12 / 0** | ✅ bez zastoja, 3.2s/poziv |
| **gemini-3-flash-preview** | global | **12 / 0** | ✅ bez zastoja, 5.3s/poziv |
| gemini-2.5-flash | regional | 2 / **10** | ❌ DSQ zid |

**Posljedica:** EN-backfill cijelog kanala padne s ~16h (mahom padova) na **~50 min bez
ijednog 429**, sekvencijalno — a uz 250 RPM može i umjereno paralelno. Kvaliteta prijevoda
usporediva s 2.5-flash (vidi quality A/B niže).

### ⚠️ ISPRAVAK o cijeni (potvrđeno research-om 2026-06-09)
Preview modeli **NISU besplatni** — to je bila pogrešna pretpostavka. 250 RPM je **rate-limit,
NE free tier** (kvota ≠ besplatno). Vertex pricing:
- `gemini-3-flash-preview`: **$0.50 / 1M in, $3.00 / 1M out** — *skuplji* od 2.5-flasha ($0.30 / $2.50)!
- `gemini-flash-latest`: alias na trenutni "latest Flash" → naplata po razriješenom modelu (rate se može promijeniti pod nogama → cost-control gotcha).

**ALI:** free-trial krediti ($300/90 dana) **pokrivaju** first-party Gemini na Vertexu (preview
JEDNAKO kao GA) — isti pokriveni put kao i dosadašnji 2.5-flash. Dakle "besplatno" useru dok
traje trial kredit, samo **brže troši kredit** (skuplji model). Kad kredit istekne/presuši →
pravi trošak. Provjera stanja kredita: **Billing konzola → Credits/Reports** (gcloud
`billing accounts describe` je PERMISSION DENIED za ovaj identitet — nema `billing.accounts.get`).
Isključenja koja NAS ne diraju: AI Studio API-key put (ne koristimo) i MaaS partner modeli
(Anthropic/Llama — nije first-party Gemini).

### Izbor modela: `gemini-3-flash-preview` (NE flash-latest)
Quality A/B (subagent, 1 reprezentativan odlomak): `gemini-3-flash-preview` je **jednako dobar
ili literalniji** od 2.5-flasha (0 izostavljanja, čuva markdown/vlastita imena) → **siguran
drop-in**. `gemini-flash-latest` je brži (3.2 vs 5.3s) ALI je na uzorku **izostavio sadržaj
2×** ("artificial intelligence (AI alignment)" → "AI alignment"; "another human being" →
"another human") → za striktni no-omission mandat **radije 3-flash-preview**. flash-latest tek
nakon šireg eval-a (50-100 odlomaka).

### Implementacija (minimalna)

`translate_to_english.js` već čita `process.env.GEMINI_MODEL` i podržava `global` u
`VERTEX_REGIONS`. Dakle bez izmjene koda:

```bash
GEMINI_MODEL=gemini-flash-latest VERTEX_REGIONS=global \
  node translate_to_english.js --input-dir storage/output --channel <kanal>
```

(Preporučeni model: **`gemini-3-flash-preview`** zbog quality-sigurnosti; `gemini-flash-latest`
samo ako je brzina kritična i nakon šireg quality eval-a.)

Za trajno: postaviti default na preview model u `gemini.conf` ili env, uz fallback na
2.5-flash ako preview bude povučen. **VAŽNO:** preview ID-evi nisu vječni — kad Google
promovira/povuče preview, prebaci alias; i prati potrošnju kredita (skuplji model).

> ⚠️ Mijenja stari nalaz iz memorije `translate_en_regional_only_no_parallel` ("global je
> 429-throttled, ne paraleliziraj"). To je vrijedilo za **2.5-flash**. Za preview modele
> global radi bez zastoja i smije se umjereno paralelizirati.

## Rješenje #2 (REZERVA): Vertex AI Batch Prediction

Ako preview modeli nestanu/poskupe, ili za jako velike bulk poslove:
- **Zaseban quota sustav** — nema online RPM zida; ~50% jeftinije; SLA 24h (mali jobovi
  minute–sati).
- Mehanika: JSONL u GCS (`{"key":..., "request":{generateContent body}}`, jedan po retku) →
  `client.batches.create(model, src=gs://..., dest=gs://...)` → poll → output JSONL → re-join
  po `key`. Podržava `responseMimeType: application/json` + `systemInstruction`.
- Redoslijed izlaza nije zajamčen → koristi `key = {base}_{field}` i re-join.
- Pretvara ~1000 poziva u jednu async submisiju. Trenutno NIJE implementirano u repou.

## Rješenje #3 (REZERVA, offline): lokalni LLM

LM Studio pattern već postoji u repou (`generate_whisper_prompt.js`, `localhost:1234`,
OpenAI-compatible). Lokalno bi ubilo i rate-limit **i** `PROHIBITED_CONTENT` filter.
- Hrvatski je lower-resource → 7B (trenutni qwen) NIJE dovoljan za publish-kvalitetu;
  treba **Gemma-2/3-27B** (~10–20 tok/s na M4 Pro, ~4.5h za kanal) ili **Qwen2.5-14B** (brže).
- Najbolji hibrid: Opus-MT `tc-big-sh-en` (HR→EN BLEU 58.8, 0.2B, ~trenutno) kao prvi
  doslovni prolaz → lokalni 27B post-edit pod `TRANSLATOR_PROMPT` (katolički glosar, JSON,
  vlastita imena). Pure-MT modeli (NLLB/Opus-MT) sami ne poštuju glosar/JSON contract.
- Realan trade-off: kvalitetni gap na rijetkim katoličkim terminima. Dobro za fallback,
  lošije od preview Gemini modela koji su besplatni i jednako kvalitetni.

## Magisterium — OSTAJE MCP (ne tiče se ovoga)

Magisterium teološki scoring **ne smije** u Vertex (batch ni preview) — poanta je koristiti
proizvod **Magisterium AI** (RAG nad ~27k katoličkih izvora + citati), ne generički Gemini.
Sekvencijalni MCP grind (`chat` je sequential-only) ostaje; ~5–9 poziva/video. To je odvojeno
usko grlo, manje (~2h/kanal), bez boljeg rješenja jer je vanjski servis.

## Preporučeni redoslijed odluka

1. **Odmah:** EN backfill preko `gemini-flash-latest` @ global (Rješenje #1). Riješi 90% boli.
2. Ako preview model nestane → Batch Prediction (#2).
3. Ako treba offline/zero-cloud → lokalni hibrid (#3).
4. Magisterium grind neovisno, MCP.

## Mjerenja (popunjava se kroz eksperimente 2026-06-09)

- Burst 12×: flash-latest 12/0, 3-flash-preview 12/0, 2.5-flash 2/10 (gore).
- Full-video EN (LzIq4MXO4sg, flash-latest@global): _vidi `/tmp/exp_en_flashlatest.log`_ — TBD.
