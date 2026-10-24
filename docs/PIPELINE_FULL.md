# DOMOVINA.ai — Potpuni pipeline (svi koraci 0→13) + mjereni case study

> **Što je ovo:** master-dokument koji vizualizira **cijeli** put od `.canary.srt` (Colab transkripcija) do
> publicirane, teološki-verificirane, dvojezične epizode na `cdn.domovina.ai`. Nadopunjuje [`PIPELINE.md`](./PIPELINE.md)
> stvarima **naučenima u produkcijskom runu 2026-06-08** (12 epizoda odjednom): naplatni projekt fix,
> hibridni Magisterium MCP flow s realnim brojkama, te `global`-endpoint quota gotcha kod EN prijevoda.

---

## 1. Pregled cijelog pipelinea (0 → 13)

> **Usklađeno s kodom 24.10.2026.** Izvor istine je linija u `automatic/nightly_pipeline.sh`
> (`run_step "run_pipeline.sh (faza A + faza B)"`) i `../pipeline.domovina.ai/bridge/plan.js`
> za prioritetni fast-path; oba šalju isti cloud tok. Detalji i put za povratak:
> [`2026-10-24-pipeline-trenutno-stanje.md`](./2026-10-24-pipeline-trenutno-stanje.md).
> Ovaj dijagram je do 24.10. prikazivao stanje iz lipnja (Colab Canary → lokalni pyannote →
> Gemini na Vertexu); §2 i §3 su i dalje zapis runa od 08.06. i ne opisuju današnji tok.

```mermaid
flowchart TB
    subgraph INGEST["📥 Ulaz (Mac)"]
        K1["KORAK 1 — fetch.js (yt-dlp) / ingest_rss.mjs<br/>→ mp3 + mkv + info.json"]
        K2["KORAK 2 — convert_to_wav.js → 16 kHz WAV"]
    end

    subgraph ASR["☁️ Transkripcija (cloud)"]
        K26["KORAK 2.6 — Modal Canary 1B v2<br/>→ .wav.canary.srt + .wav.canary.word_ts.json"]
        K27b["KORAK 2.7b — transcribe_soniox.js<br/>Soniox stt-async-v5, fallback Speechmatics<br/>→ .soniox.* / .speechmatics.json"]
        K27c["KORAK 2.7c — diarize_pyannote_ai.js<br/>pyannoteAI precision-3 + hibrid riječ→govornik<br/>→ .{izvor}_pyannote.words.json"]
        K28["KORAK 2.8 — refine_diarized_gemini.js<br/>Gemini 3.8 Flash sluh, kostur auto<br/>promocija u kanonski SRT"]
    end

    subgraph LOCAL["💻 Mac — fallback"]
        K6["KORAK 6 — diarize_canary.py (pyannote, MPS)<br/>samo kad 2.8 nije promovirao"]
    end

    CANON[".wav.canary.diarized.srt<br/>STRIKTAN PREDUVJET 7-12"]

    subgraph LLM["✍️ Uredništvo — Claude Opus (pretplata)"]
        K7["KORAK 7 — summarize_gemini.js --gemini-backend claude<br/>→ summary.json"]
        K8["KORAK 8 — generate_article_gemini.js<br/>faza1 outline.json + faza2 article.json"]
    end

    subgraph MEDIA["🖼️ Izvedeno (lokalno, nula LLM poziva)"]
        K9["KORAK 9 — prepare_rag_combined.js<br/>→ rag_combined.jsonl + segments.jsonl"]
        K10["KORAK 10 — screenshot_youtube.js"]
        K96["KORAK 9.6 — og-sections"]
        K98["KORAK 9.8 — generate_ebook.js → epub"]
        K985["KORAK 9.85 — detect_sponsors.js"]
        K987["KORAK 9.87 — generate_words_json.js<br/>izvor: Speechmatics ili Canary word_ts"]
    end

    subgraph ASYNC["⏱️ Odvojeni launchd poller (svakih 10 min)"]
        K85["Magisterium HR — magisterium_mcp_episode.js<br/>MCP izravno, OAuth Pro, bez LLM-a<br/>→ article.magisterium.json + objava"]
        K65["EN — translate_to_english.js<br/>Vertex, jedan poziv po bloku → *.en.json"]
    end

    subgraph DIST["🚀 Distribucija"]
        K12["KORAK 12 — upload_to_r2.js → cdn.domovina.ai"]
        K127["KORAK 12.7 — build_episode_bundle.js → episode.json"]
        K13["KORAK 13 — generate_channel_index.js"]
    end

    PJ[".processing.json — provenance, samo disk"]

    K1 --> K2 --> K26
    K1 --> K27b --> K27c --> K28
    K28 -->|promovira| CANON
    K26 --> K6 -->|ako kanonski ne postoji| CANON
    CANON --> K7 --> K8
    K8 --> K9
    K8 --> K10 --> K96 --> K98
    K8 --> K985
    CANON --> K987
    K26 -.word_ts.-> K987
    K27b -.-> PJ
    K27c -.-> PJ
    K9 --> K12
    K98 --> K12
    K985 --> K12
    K987 --> K12
    K8 --> K12
    K12 --> K127
    K12 --> K13
    K8 -.cron enqueue.-> K85
    K85 -.na zahtjev.-> K65
    K85 --> K127
    K65 --> K127

    style CANON fill:#f8d7da
    style K28 fill:#d4edda
    style K85 fill:#f8d7da
    style K6 fill:#d1ecf1
    style K12 fill:#cce5ff
```

**Striktni preduvjeti (chain dependencies):**
1. `.canary.diarized.srt` mora postojati prije AI sloja (7/8) — inače RAG degradira bez govornika.
   Ime je povijesno: danas ga najčešće piše 2.8 (Soniox/pyannoteAI kostur + Gemini sluh), a ne Canary.
2. `article.json` + `outline.json` moraju postojati prije Magisterium MCP (8.5) i RAG (9).
3. KORAK 9.8 (e-knjiga) mora ići nakon KORAKA 10, inače knjiga izađe bez slika i više se ne regenerira.
4. EN prijevod treba summary + article + magisterium (prevodi sva tri additivno).
5. `episode.json` (12.7) je zadnji upload u `data/{id}/` — zastario bundle sakriva novu datoteku.

---

## 2. Tri stvari naučene u runu 2026-06-08 (NOVO)

### 2.1 Naplatni projekt: aktualan je **`bimbo-sync-prod`** (od 14.09.2026.)

```mermaid
flowchart LR
    A["standalone poziv skripte<br/>(bez env override)"] --> B{"VERTEX_PROJECT?"}
    B -->|"domovina-sync-ms<br/>(MRTAV, dunning)"| C["403 'Lightning dunning<br/>decision is deny'"]
    B -->|"project-a275a620<br/>(MRTAV, krediti potroseni 31.08.)"| E["200 OK ali se NAPLACUJE<br/>s kartice"]
    B -->|"bimbo-sync-prod<br/>(billing 01FAEA, free trial)"| D["200 OK"]
    style C fill:#f8d7da
    style E fill:#fff3cd
    style D fill:#d4edda
```

**Aktualan projekt: `bimbo-sync-prod`** (projectNumber `984390019987`, billing
`01FAEA-72A278-819B25`, novi free-trial krediti). Prebačeno 14.09.2026.;
`aiplatform.googleapis.com` enableana istog dana, `gemini-3.5-flash` i
`gemini-3-flash-preview` na global endpointu vraćaju 200.

Dva ranija projekta **se više ne koriste** — ne vraćaj ih iz starih dokumenata:

| Projekt | Billing | Zašto je mrtav | Razdoblje |
|---|---|---|---|
| `domovina-sync-ms` | `0140D3-08E99F-E8C697` | Dunning — `403 PERMISSION_DENIED "Lightning dunning decision is deny for project: projects/1091687353506"` | do 08.06.2026. |
| `project-a275a620-ef0c-45ae-99e` | `016BE2-D24293-12968B` | Free-trial krediti potrošeni **31.08.2026.** → svaki poziv ide na karticu. Zbog toga je 09.09. pauziran cijeli launchd (`2026-09-09-launchd-pauza-gcp-billing.md`) | 08.06.–14.09.2026. |

- **Cementirano na 6 mjesta** (svako mora pokazivati na isti projekt; popis u `CLAUDE.md` pravilo 0):
  `gemini.conf VERTEX_PROJECT`, hardkodirani fallbacks u `summarize_gemini.js` i
  `generate_article_gemini.js`, te `export VERTEX_PROJECT` u `run_pipeline.sh`.
  Fallbacks postoje jer standalone pozivi (bez `run_pipeline.sh`) inače padnu na default.
- **Izvan ovog repoa** projekt drže još: `../domovina-rag/.env` (job `tv.domovina.rag.sync`)
  i `../ecosystem-brain/.state/llm.env` + `bin/llm`. Migracija koja preskoči njih ostavlja
  pola sustava da gađa mrtav projekt.

### 2.2 EN prijevod: izbaci `global` endpoint iz rotacije

> **Zastarjelo od 24.10.2026. (commit `cf926987`).** Ovo je zapis iz lipnja, kad se prevodilo
> polje po polje (~300–1000 poziva po epizodi) na projektu s 1 RPM. Danas `translate_to_english.js`
> šalje jedan Vertex poziv po bloku (`gemini-3.8-flash`, regije iz `VERTEX_REGIONS`), sekcije
> paralelno, pa epizoda od 25 sekcija traje ~7 min. Ako odgovor nema isti oblik ili ga Gemini
> blokira, samo taj blok pada natrag na stari prijevod polje po polje. Mjerenja:
> [`2026-09-15-en-prijevod-mjerenja.md`](./2026-09-15-en-prijevod-mjerenja.md).

```mermaid
flowchart LR
    E[epizoda] --> B1["sažetak: 1 poziv"]
    E --> B2["zaglavlje Magisteriuma: 1 poziv"]
    E --> B3["po iteraciji: tema, 1 poziv"]
    E --> B4["po sekciji: sekcija + njena<br/>Magisterium prosudba, 1 poziv<br/>TRANSLATE_CONCURRENCY=4"]
    B4 --> Q{"isti ključevi i duljine nizova?"}
    Q -->|da| OK["_en polja"]
    Q -->|ne / PROHIBITED_CONTENT| FB["taj blok polje po polje<br/>s bypass ljestvicom"]
    FB --> OK
    B1 --> OK
    B2 --> OK
    B3 --> OK
```

`translate_to_english.js` rotira 9 regija uključujući `global`. Na svježem projektu **`global` endpoint je
rate-limited (429)**, dok **regionalni endpointi rade (200)**. Posljedice:
- **NE paraleliziraj prijevod** (4-way → 429 storm, ~svi prijevodi padnu na MAX_RETRIES).
- Sekvencijalno + `global` u rotaciji = puzanje (svaki 9. poziv stalls).
- **Fix:** `export VERTEX_REGIONS="us-central1,us-east1,us-east4,us-west1,us-west4,us-south1,europe-west1,europe-west4"`
  (bez `global`) → 429 rate padne s ~stotina na ~jedinice; prijevod teče.

```mermaid
flowchart TB
    P["12 epizoda × ~300 polja prijevoda"] --> Q{"strategija"}
    Q -->|"4-way paralelno"| R["429 storm<br/>MAX_RETRIES fail ❌"]
    Q -->|"sekvencijalno + global"| S["global 429 svaki 9. poziv<br/>~15-20 min/ep 🐢"]
    Q -->|"sekvencijalno, REGIONAL-ONLY"| T["429 rijetko<br/>teče, ali sporo (1 RPM)"]
    style R fill:#f8d7da
    style S fill:#fff3cd
    style T fill:#fff3cd
```

**Korijenski uzrok (potvrđeno Cloud Quotas API-jem):** projekt `project-a275a620` ima Gemini RPM kvotu
**`1` zahtjev/min** (default za nov projekt; MedLM ima 60, Gemini 1). Zato je article-generacija (~3 poziva/ep)
prošla glatko, a prijevod (~300 poziva/ep) puzao. Regional-only fix samo izbjegne najgori `global` 429-zid —
ali stvarni strop je 1 RPM, pa je i regional-only run trajao **~7 h za 10/12** (2/12 ostala bez po 1 fajla).
Autonomni quota-increase (`gcloud alpha quotas preferences create/update`) Google je **auto-deny** na svaku
testiranu vrijednost — 300, 60, **i čak `1 → 2` (+1)** → svuda `grantedValue: 0` ("cannot grant ... at this
moment"). Dakle nije value-issue nego **hard-gate**: nov projekt ne smije self-grantati NIKAKAV Gemini increase
dok ne sazri (usage/billing povijest) ili kroz Google support case (plaćeni plan). **Prava poluga je quota
bump**; do tad EN je inherentno spor (1 RPM). Preference su ostavljene na fileu pa mogu proći kad gate padne.

**Ali 1 RPM je DOVOLJAN za ne-hitan backfill (ključni uvid).** Kvota je `...PerRegion...` = 1/min **po regiji**,
a `translate_to_english.js` rotira 8 regija → **~8 efektivnih req/min**. To je ~11.500 poziva/dan — daleko više
od ~80 polja koliko treba za par zaostalih fajlova. Pravilo:
- **Sinhroni/batch-hitan** EN (svih 12 odjednom, sad) → boli (1 RPM strop, ~7 h).
- **Strpljivi backfill** (par fajlova, raspoređeno, "dan ima 24 h") → trivijalno: pokreni petlju koja retrya
  dok fajl ne nastane, pa se sama finalizira (upload + reindex). Zaostali fajlovi prođu čim regije nisu
  zasićene drugim poslom. Zato 2 fajla koja su pala tijekom 8 h batch-a (sve regije zauzete) prolaze čim se
  pokreću izolirano. Backfill-skripta: `/tmp/patient_backfill_en.sh` (retry-do-uspjeha + auto-finalize).

### 2.3 Magisterium MCP hibrid — stvarni flow i brojke

> **Od 24.10.2026. HR Magisterium ne treba Claudea.** `tools/magisterium_mcp_episode.js` odradi
> prep → chat → assemble → objavu → CDN provjeru sam, preko izravnog MCP klijenta
> (`tools/magisterium_mcp_client.js`, OAuth token na Pro pretplati, ne API ključ). Poller ga zove
> po defaultu (`MAG_RUNNER=direct`). Ispod je zapis Claude-in-the-loop runa od 08.06., koji je i
> danas fallback (`MAG_RUNNER=claude`). Detalji:
> [`2026-10-24-magisterium-mcp-bez-llm-a.md`](./2026-10-24-magisterium-mcp-bez-llm-a.md).

```mermaid
flowchart LR
    P["1 prep<br/>magisterium_mcp_prep.js"] --> C["2 chat<br/>magisterium_mcp_client.js<br/>sekvencijalno, ~2,5 poziva/min"]
    C --> L{"2b fragmenti na<br/>drugom jeziku?"}
    L -->|da| C
    L -->|ne| A["3 assemble<br/>magisterium_mcp_assemble.js"]
    A --> PUB["4 publish<br/>with_pipeline_lock + publish_hr_episode.sh"]
    PUB --> V["5 verify<br/>CDN GET, md5 diska = md5 CDN-a"]
```

```mermaid
sequenceDiagram
    participant U as Claude (chat)
    participant P as prep.js
    participant M as Magisterium MCP
    participant A as assemble.js
    U->>P: prep --article ART --batch-size N --max-words W
    P-->>U: holistic.txt + batch_NN.txt + job.json
    U->>+M: chat(holistic)  [1×]
    M-->>-U: {overall_score, seeds_of_logos, concerns} + References
    loop svaki batch (N sekcija), SEKVENCIJALNO
        U->>+M: chat(batch_NN)
        M-->>-U: {results:[{score,assessment,concerns,enrichment}]} + References
        Note over U: timeout → ponovi KRAĆI sadržaj<br/>refuse → preformuliraj "moralno-teološki"
    end
    U->>A: assemble --job --results-dir --out STORAGE/article.magisterium.json
    A-->>U: root overall_score = avg(sekcija), holistic u overall.holistic_score
```

**Empirijski (12 epizoda, ~100 `chat` poziva):**
- ~~**batch-size skaliranje:** male epizode (6 sekcija) → batch-4; velike svjetovne (50 sekcija) → batch-6 + `--max-words 40` (manje poziva bez timeout rizika; lever je KRATAK sadržaj po sekciji, NE manji batch).~~ **Zastarjelo 24.10.2026.:** default je batch-size 1 + `--max-words 600` (cijela sekcija); rezanje na 40–80 riječi spuštalo je ocjene jer je model vidio pola misli (`docs/2026-10-24-magisterium-mcp-bez-llm-a.md`).
- **3 failure-mode-a koje treba ručno gurnuti:**
  1. **timeout** (~5% poziva) → retry s kraćim sadržajem.
  2. **refuse** (sekularni/stranački sadržaj) → "ne mogu izvan katolicizma" → preformuliraj kroz socijalni nauk ("moralno-teološka procjena, ne stranačka").
  3. **prazan/`<thought>` odgovor** → spasi samo čisti JSON blok, omotaj u ```​json fence (assemble traži fence).
- **cache citata raste:** `magisterium_doc_urls.json` — dodao Ecclesia de Eucharistia, Sacramentum Caritatis, Gaudium et Spes (recurring u katoličkim epizodama). `search` JE parallel-safe; `chat` NIJE.

---

## 3. Case study: 12 epizoda kroz pipeline (2026-06-08)

**Ulaz:** 12 svježe transkribiranih epizoda (Colab Canary) povučenih s Drive-a, raspon 6–50 sekcija,
miješani sadržaj (katolički, obiteljski, wellness, geopolitika, lokalna politika, BiH polemika).

### 3.1 Magisterium scoreovi (scoring radi po tipu sadržaja)

| Epizoda | Kanal | Sekcija | root | holistic | Tip |
|---|---|---:|---:|---:|---|
| Tijelovo propovijed (DDV) | budi_frajer | 24 | **95** | 92 | katolički |
| Should you be kind to your AI | catholic_futurist | 6 | **92** | 94 | katolički/AI |
| Vjetroelektrana Gradina | hercegovina_info | 50 | **51** | 68 | svjetovni (Laudato si') |
| Tijelo inteligentnije od uma | lood_podcast | 8 | **81** | 65 | wellness/antropologija |
| Fra Ante Vučković (Mk 13) | mreze_rijeci | 13 | **96** | 98 | katolički (egzegeza) |
| Domagoj Delač | podcast_cuspajz | 9 | **73** | 82 | lifestyle |
| Fatmir Alispahić | podcast_cuspajz | 22 | **52** | 58 | političko/polemično |
| Brak i biznis | poduzetnistvo | 21 | **93** | 98 | katolički/obitelj |
| Ogorec (geopolitika) | radio_mreznica | 16 | **59** | 62 | svjetovni (just-war) |
| Vandelić (anti-korupcija) | radio_mreznica | 24 | **59** | 78 | političko |
| Rastući s djecom | rastuci_s_djecom | 24 | **91** | 98 | katolički/obitelj |
| Glasnović (lustracija) | zeljka_markic | 16 | **84** | 68 | političko/povijest |

Scoring točan: 90+ za teološki sadržaj, 50–60 za svjetovni/polemični, s konkretnim concerns (etničke
generalizacije, normalizacija nasilja, cinizam "svi su isti") i citatima socijalnog nauka (Laudato si',
Fratelli Tutti, Pacem in Terris, Compendium, Dignitas Infinita, KKC 2307-2317).

### 3.2 Mjerena vremena (sve nakon transkripcije)

| Korak | Trajanje | Napomena |
|---|---|---|
| KORAK 0 rclone pull | **27 s** | 12 novih `.canary.srt` |
| KORAK 6 diarizacija ×12 | **~24 min** | lokalno M4 Pro, ~1–3 min/ep (kraći ep 62 s) |
| KORAK 7+8 summary+article ×12 | **~15 min** | Gemini, pipelined (trailing diarizaciju), ~16 s/ep summary |
| **KORAK 8.5 Magisterium MCP ×12** | **~80 min** | ⏱️ DOMINANTNO — ~100 sekvencijalnih `chat` poziva, interaktivno |
| KORAK 9 RAG ×12 | **5 s** | lokalno |
| KORAK 10 screenshots | **~0** | već postojali (fetch ih je generirao) |
| KORAK 9.6 og-sections ×9 kanala | **27 s** | ImageMagick |
| KORAK 11 channel index | **~30 s** | 2707 videa, 42 kanala |
| KORAK 12 R2 upload ×12 + meta | **~10 min** | ~70 MB, HEAD-skip idempotent |
| GET-verifikacija | **~5 s** | svih 12: article+magisterium = **200** |
| **UKUPNO do "live na CDN" (HR + Magisterium)** | **~3 h 04 min** | od kojih ~80 min je Magisterium MCP |
| KORAK 6.5 EN prijevod (regional-only, sekvencijalno) | **~7 h 09 min** | ⚠️ 1 RPM Gemini quota: 10/12 sinhrono (21:09→04:18); preostala 2/12 (po 1 fajl) dovršena **strpljivim backfillom** (vidi §2.2) — pojedinačno, regije slobodne |
| **UKUPNO do punog dvojezičnog publisha (12/12)** | **~10 h 15 min** | EN dominira zbog 1-RPM stropa; uz quota bump bilo bi ~+15 min umjesto ~7 h |

**Zaključak mjerenja:** do "HR + Magisterium live na CDN" kritični put je **interaktivni Magisterium MCP sloj**
(~80 min, sekvencijalan po dizajnu); sve ostalo (diarize/summary/article/RAG/media/R2) je ~1 h zajedno i većinom
paralelizabilno. Za **pun dvojezični** publish dominira **EN prijevod (~7 h)**, ali ne zbog algoritma nego
zbog **1-RPM Gemini quote na novom projektu** — to je jedini pravi infra-bottleneck cijelog sustava. Uz quota
bump (kad projekt sazri ili kroz support) EN bi pao na ~15 min, čime bi total do punog dvojezičnog publisha
bio **~3,5 h** umjesto ~10 h.

---

## 4. Reference

| Dokument | Sadržaj |
|---|---|
| [`PIPELINE.md`](./PIPELINE.md) | Originalni narativ + autonomous-mode pravila |
| [`MAGISTERIUM_MCP_RUN.md`](./MAGISTERIUM_MCP_RUN.md) | Turnkey hibridni Magisterium runbook (korak 8.5) |
| [`magisterium_mcp_hybrid_2026-05.md`](./magisterium_mcp_hybrid_2026-05.md) | Detaljni dizajn hibrida |
| [`diarization_research_2026-05.md`](./diarization_research_2026-05.md) | Zašto pyannote ide lokalno |
| [`2026-08-05-homily-extraction-nova-eva.md`](./2026-08-05-homily-extraction-nova-eva.md) | Rez propovijedi iz prijenosa sv. mise: zašto 83.7 % mise ne smije u RAG, `extract_homily.js`, gate u koracima 7-9 |
| `gemini.conf` | `VERTEX_PROJECT=bimbo-sync-prod` (prebačeno 14.09.2026.; prije toga `project-a275a620-...`) |
| `magisterium_doc_urls.json` | Cache citat→UUID (raste sa svakim runom) |

**Stvoreno:** 2026-06-08 kao capstone produkcijskog runa od 12 epizoda (od Colab transkripcije do CDN-a),
prvi batch-run s hibridnim Magisterium MCP-om na realnoj skali i s naplatnim-projekt + EN-quota fixevima.
