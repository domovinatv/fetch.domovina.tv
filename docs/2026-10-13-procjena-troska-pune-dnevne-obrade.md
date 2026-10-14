# Procjena troška pune dnevne obrade novih epizoda (13.10.2026.)

**Zaključak:** puna obrada svih ~20 novih epizoda dnevno košta **~$25–30/dan
(~$750–900/mj)** uz kvalitetu koju nightly danas daje praćenim kanalima, ili
**~$3–8/dan (~$100–240/mj)** ako se transkripcija vrati na Canary + lokalni
pyannote. Od **1.1.2027.** Gemini 3.8 Flash izlazi iz promo cijene (dupla), pa
puna kvaliteta raste na **~$1 350/mj**. Dvije trećine troška je Speechmatics.

**Istraživanje alternativa (dolje)** pokazuje da se ista pokrivenost može dobiti
za **~$40–220/mj**. Pet stvari to čini mogućim:
- Vertex batch (−50 %),
- popravak EN prijevoda kod nas,
- Canary i pyannote zajedno na Modalu,
- jeftiniji ASR (Soniox ili Scribe),
- jeftiniji LLM (Haiku 5.5 ili gpt-6-luna).

Zadnje tri mogućnosti traže A/B test na hrvatskom prije odluke.

## Priljev

Iz `automatic/watchlist/DAILY.md` (prozor 25.09.–13.10.2026., 18 noći s runom):

| mjera | vrijednost |
|---|---|
| novih epizoda | 351 iz 144 kanala |
| po danu | **19,5** (raspon 8–28; ponedjeljak i petak najjači) |
| audio | 353 h → **~1,0 h/ep**, ~20 h zvuka dnevno |
| od toga praćeni kanali | ~2/dan — jedini koje nightly danas potpuno obrađuje |

Ostalih ~18/dan su kandidati iz registryja koje `automatic/watch_candidates.js`
samo prati (nula medija).

## Trošak po epizodi (1 h audia)

Izmjereno na 104 `.gemini_usage.json` od 20.09.2026. (`est_usd` = izračun iz
tokena po cjeniku, **ne račun**). Speechmatics iz
`docs/speechmatics_evaluation_2026-09.md`, Modal iz
`docs/transcription_colab_vs_modal_cost_2026-07.md`, EN iz
`docs/2026-09-15-en-prijevod-mjerenja.md`.

| korak | današnji nightly | jeftina varijanta |
|---|---|---|
| ASR + diarizacija | Speechmatics **$0,80** (interna brojka; službeni Enhanced $0,75/h) | Modal Canary ~$0,03 + pyannote na Macu $0 |
| KORAK 2.8 Gemini „sluh" (refine) | **$0,34** (prosjek 49 ep) | — |
| sažetak (Gemini 3.8 Flash) | $0,02 | $0,02 |
| članak (Gemini 3.8 Flash) | $0,11 | $0,11 |
| EN prijevod | $0,24 | izostaviti / samo odabrani kanali |
| Magisterium (MCP, Pro pretplata) | $0 | $0 |
| screenshotovi, EPUB, sponzori, words.json, RAG chunking | $0 | $0 |
| R2 pohrana | ~0,12 GB/ep → ~$0,002/ep/mj (kumulativno) | isto |
| **ukupno** | **~$1,50** (bez EN $1,27) | **~$0,40** (bez EN $0,16) |

Opus preko Claude Code pretplate (sažetak + članak) bi po API cijeni bio
**$0,31 + $2,10 = $2,41/ep** (45 epizoda u uzorku). Novac je $0, ali kvota nije:
20 ep/dan ≈ 100 poziva i nekoliko M tokena dnevno — ista klasa potrošnje koja je
30.09.2026. spalila cijeli prozor pretplate (globalni CLAUDE.md).

## Dnevno i mjesečno (20 ep/dan)

| scenarij | /dan | /mj |
|---|---|---|
| A. Canary + lokalni pyannote + Gemini, bez EN | ~$3 | **~$100** |
| A + EN prijevod | ~$8 | ~$240 |
| B. današnja kvaliteta (Speechmatics + refine + Gemini), bez EN | ~$25 | **~$760** |
| B + EN | ~$30 | **~$900** |
| B + EN nakon 31.12.2026. (Gemini ×2) | ~$44 | **~$1 350** |
| članak na Opusu po API cijeni | ~$74 | ~$2 200 |

## Što nije novac, a ograničava

- **Mac kao usko grlo u scenariju A.** 20 h zvuka dnevno kroz pyannote na Mac
  Mini M4 Pro nije izmjereno kao održivo; diarizacija se gasi ispod 12 GB diska
  (`nightly_diarize_guard`), a predugačak WAV zna srušiti cijeli nightly.
- **Magisterium** je $0, ali ~14 min/ep sekvencijalno — 20 ep/dan ne stane u noć
  (relevantno samo za katolički sadržaj).
- **Vertex kvota** za EN prijevod je DSQ po zahtjevima, ne po tokenima.

## Preporučena sredina (~$300–400/mj)

Canary (Modal) za sve, Speechmatics + refine samo kad Canary detektor
(`TRANSCRIPT_GAP`, collapse) javi problem, Gemini za članke, EN samo po kanalu.

## Alternative na tržištu (istraživanje 13.10.2026.)

Tri paralelna istraživanja (ASR + diarizacija, LLM, GPU/CPU hosting). Cijene su
čitane s vendorskih stranica 13.10.2026.; **[NV]** = nije potvrđeno na službenoj
stranici. **Ni za jedan servis ne postoji neovisan hrvatski WER ili hrvatski LLM
benchmark** — sve „hr kvalitete" ispod su tvrdnje samih ponuđača, pa je vlastiti
A/B test preduvjet svake odluke.

### Sažetak: kamo trošak može pasti

Za 600 epizoda / 600 h mjesečno:

| sloj | danas (scenarij B + EN) | najbolja alternativa | /mj |
|---|---|---|---|
| ASR + diarizacija | Speechmatics ~$450–480 | Soniox ~$60, ili Canary + pyannote u istom Modal kontejneru ~$10–25 | **$10–60** |
| refine | Gemini 3.8 Flash standard ~$204 | isto u **Vertex batchu** ~$104 / Claude Haiku 5.5 batch ~$18 | **$18–104** |
| sažetak + članak | ~$78 | 3.8 Flash batch ~$32 / Haiku batch ~$6 | **$6–32** |
| EN prijevod | ~$144 | **popravak našeg koda** (sva polja u jedan poziv) + batch ~$25 / Haiku ~$4 | **$4–25** |
| **ukupno** | **~$900** (od 2027. ~$1 350) | | **~$40–220** |

Dvije stvari se mogu napraviti odmah, bez rizika za kvalitetu i bez novog
dobavljača: **Vertex batch** za korake 7, 8, refine i EN (−50 %, noćni prozor
dopušta SLA od 24 h) i **EN prijevod u jednom JSON pozivu po članku**. Danas se
570-tokenski system prompt šalje uz svako polje, pa je ~90 % EN ulaza ponovljena
uputa. Zajedno to spušta LLM dio s ~$426 na ~$161 mjesečno. Od 1.1.2027. batch
cijena jednaka je današnjoj promo cijeni, pa poskupljenje ne pogađa nightly.

### 1. Transkripcija i diarizacija

| servis | hr | diarizacija | vremena riječi | $/h | zamke |
|---|---|---|---|---|---|
| **Speechmatics** Enhanced / Standard | eksplicitno | da | da | **0,75 / 0,45**; uz pristanak na treniranje −33 % (0,50 / 0,30) | upload <1 GB |
| **Soniox** async | hr, sr, bs, sl | uključena | da (potvrditi) | **0,10** | **max 300 min po datoteci**; o treniranju na našim podacima stranica šuti |
| **ElevenLabs Scribe v2** | „≤5 % WER" (vendorove hr brojke si proturječe: 3,1 / 20,8 / ≤5 %) | do 32 govornika | da | **0,22** | do 10 h po datoteci; zero-retention samo enterprise |
| **Deepgram Nova-3** `hr` | mono jezik, nije u `multi` | besplatna | da | **0,26** | $200 kredita = ~700 h, dovoljno za benchmark |
| AssemblyAI Universal-2 | „Good 10–25 %" | +0,02 | da | 0,17 | Universal-3.5 nema hr |
| Azure batch | hr-HR | za hr nepotvrđena | da | 0,18 | MAI-Transcribe-2 nema hr; 2 h limit |
| AWS Transcribe | hr-HR | da | da | 0,36 | — |
| Google Chirp 3 | hr-HR | **ne za hr** | do 20 min | 0,96 | ispada |
| Gemini 3.5 Transcribe | hr-HR | do 8 govornika | da, ali uz pad točnosti | ~0,30 | **max 30 min** s diarizacijom |
| OpenAI gpt-4o-transcribe-diarize | nije eksplicitno | da | ne (samo whisper-1) | 0,36 | 25 MB limit |
| Mistral Voxtral, Qwen3-ASR, Granite | **nemaju hr** | | | | ispadaju |
| pyannoteAI hosted (samo diarizacija) | jezično neovisno | community-1 €0,035/h, Precision-3 ~€0,10/h | — | + plan €19–99/mj | — |

**Open-weight modeli:**
- **ASR:** Canary-1B-v2 (CC-BY-4.0, hr) i Parakeet-TDT-0.6B-v3 (CC-BY-4.0, hr 12,46 % WER na FLEURS-u, do 3 h u komadu). Whisper large-v3 ima hr ~14,5 % na FLEURS-u.
- **Diarizacija:** DiariZen ima bolji DER, ali weights su **CC-BY-NC**, pa je neupotrebljiv. FluidAudio (CoreML) tvrdi 122× realtime na Macu.

**Ne rješava tiho ispuštanje dijelova:** svaki ASR, i plaćeni, treba proći kroz
naš postojeći TRANSCRIPT_GAP detektor. Upravo zbog toga je Speechmatics i
uveden; prije bilo kakve zamjene treba izmjeriti koliko se to događa na
zamjenskom servisu.

### 2. Hosting za vlastite modele: Mac se može maknuti

**Najvažniji nalaz istraživanja.** Pravilo iz CLAUDE.md-a „pyannote je
CPU-bound, G4 ≈ M4 Pro" potječe iz ere pyannote 3.x s agglomerativnim
klasteriranjem. community-1 koristi VBx, a službeni README navodi **~31 s po
satu zvuka na H100**. Neovisni izvor (speakrs wiki) mjeri ~32× realtime na
RTX 4090. Ako to vrijedi i za naše datoteke, Canary i pyannote mogu ići u isti
topli Modal `::batch` kontejner jednom po noći. To je ~15–20 GPU-sati mjesečno,
**~$10–25 nakon besplatnog tiera** od $30. Mac tada prestaje biti usko grlo, a
novi dobavljač ne treba.

| postav za 600 h/mj | /mj |
|---|---|
| **Modal: Canary + pyannote u istom kontejneru, jednom po noći** | **~$10–25** (EU regija ×1,15–1,75) |
| RunPod serverless L40S, oba koraka | ~$26–44 |
| GCP G4 spot / Cloud Run (`bimbo-sync-prod`, moguće pokriveno kreditima; provjeriti GPU kvotu) | ~$25–70 |
| Modal ASR + Hetzner AX102 CPU za diarizaciju | ~$300 |
| Hetzner GEX63 (RTX PRO 6000) stalno upaljen | ~$1 150, isplati se samo s vlastitim LLM-om |

Usput za Mac: **speakrs**, Rust port community-1 s CoreML-om, tvrdi 529× na
M4 Pro uz isti DER. Ako se to potvrdi, Mac prestaje biti usko grlo i bez oblaka.

Vlastiti LLM se ne isplati. ~$40/mj na GPU-u plus cold startovi i održavanje,
a Haiku ili gpt-6-luna u batchu koštaju ~$22–28.

### 3. LLM (sažetak, članak, refine, EN)

Batch cijene u USD po M tokena (ulaz / izlaz):

| model | batch | napomena |
|---|---|---|
| Gemini 3.8 Flash | 0,375 / 1,875 (od 2027. ×2) | današnji; EU multi-region |
| Gemini 3.5 Flash-Lite | 0,15 / 1,25 | |
| **Claude Haiku 5.5** | 0,05 / 0,25 | ×5 iznad 100k prompta, pa 3–4 h epizode treba rezati; EU preko Vertexa +10 % |
| **Claude Sonnet 5.5** | 1 / 5 | kandidat umjesto Opusa za prioritetne epizode: ~$0,18/ep naspram ~$2,41 |
| OpenAI gpt-6-luna | 0,05 / 0,25 | |
| **Mistral Small 4 / Large 4** | −50 % na 0,15 / 0,60 i 1,36 / 4,18 | jedini **EU vendor** |
| DeepSeek V4.1 Flash | 0,15 / 0,60 izvan špice | špica je 01–04 UTC, kad nightly radi; Kina |

Mjesečno za 600 ep (a + refine + EN): danas ~$426. Uz Gemini batch ~$161, uz
Flash-Lite ~$88, uz Haiku 5.5 ~$28, uz gpt-6-luna ~$22, uz Mistral Small ~$29,
uz Sonnet 5.5 ~$410–557. **Kod jeftinih modela cijena više nije faktor;
odlučuje kvaliteta hrvatskog.** Javnih dokaza o tome gotovo nema:
- OpenGPT-X leaderboard izrijekom nema hrvatski.
- Na slovenskoj areni regionalni GaMS-12B je izjednačen s gpt-5.
- Llama 3.1 je osjetno slabija na slavenskim jezicima.

**Otpadaju:**
- **DeepL, Google, Azure i Amazon prevoditelji:** $390–975/mj, 15–40× skuplje od LLM-a, i ne čuvaju JSON strukturu.
- **Kineski vendori:** jurisdikcija.
- **Llama, Grok, Cohere:** omjer cijene i kvalitete.

### Preporučeni redoslijed

1. **Odmah:** Vertex batch za korake 7, 8, refine i EN, plus EN u jednom pozivu po članku. Trošak LLM-a s ~$426 na ~$161 mjesečno; poskupljenje Gemini 3.8 Flasha 2027. više ne pogađa nightly.
2. **Benchmark, oko sat vremena rada:** pyannote community-1 na Modal L40S i A100 nad 5 naših epizoda (0,5 / 2 / 4 h). Ako je ~30–60 s po satu zvuka, Canary i pyannote idu u isti Modal kontejner i Mac izlazi iz kritičnog puta.
3. **ASR zlatni set:** 10–15 epizoda kroz Soniox, Scribe v2, Deepgram `hr` i Speechmatics Standard, mjereno prema Speechmatics Enhanced. Uspoređuju se WER, TRANSCRIPT_GAP pokrivenost, DER i pomak vremena riječi.
4. **LLM A/B na hrvatskom:** Haiku 5.5 i gpt-6-luna za refine i EN; Sonnet 5.5 umjesto Opusa za članke. Slijepa ocjena 20 članaka, stopa valjanog JSON-a i halucinirana imena govornika.
5. **Ugovorni uvjeti:** koristi li Soniox ili Deepgram naše snimke za treniranje modela i postoji li opt-out, te uvjeti za Speechmaticsov −33 %.

### Otvoreno i neprovjereno

- pyannote CPU RTF.
- GCP spot i Cloud Run CPU/RAM cijene.
- Hetzner GEX131.
- RunPod cold startovi.
- Azure diarizacija za hr.
- Je li diarizacija uključena u ElevenLabsovih $0,22/h.
- Batch SKU za 3.8 Flash u EU multi-regionu.
- Tokenizacija hrvatskog po modelu: Claude od 4.7 broji ~30 % više tokena; to mijenja sve LLM izračune.
- Dostupnost Haiku/Sonnet 5.5 na Vertex EU.

## Ključevi za eksperimente

Svi ključevi za benchmark su u **`.env.experiments`** (repo root, gitignored,
chmod 600), odvojeno od produkcijskog `.env` koji pipeline učitava:
`DEEPGRAM_API_KEY`, `SPEECHMATICS_API_KEY_EXPERIMENT` (zaseban od produkcijskog
`SPEECHMATICS_API_KEY`), `PYANNOTEAI_API_KEY`, `ANTHROPIC_API_KEY_HAIKU_EXPERIMENT`, `ASSEMBLYAI_API_KEY`, `MODAL_TOKEN_ID_EXPERIMENT` + `MODAL_TOKEN_SECRET_EXPERIMENT` (isti Modal workspace kao produkcija, zaseban token; `~/.modal.toml` se ne dira).
Eksperimentalne skripte ga učitavaju eksplicitno; ne spajati u `.env`.
Anthropic ključ se namjerno ne zove `ANTHROPIC_API_KEY` — `claude -p` bi s tim
imenom u okruženju prešao s pretplate na per-token naplatu.
`OPENROUTER_API_KEY` (Gemma i drugi open-weight modeli; ključ ima limit $100).

## GCP krediti i LLM kandidati za A/B (13.10.2026.)

**Krediti na `bimbo-sync-prod`: $219.93 od $300, istječu 14.12.2026.** (očitano u
konzoli; gcloud ih ne zna očitati). Od 14.09. potrošeno ~$80 u 29 dana, dakle ~$2,8
dnevno. Tim tempom do isteka ode ~$170, pa **~$50 propadne** — kredite je
isplativo potrošiti na eksperimente prije 14.12. Puna obrada 20 ep/dan na
Geminiju (~$14/dan standard, ~$5,4/dan batch) potrošila bi ih za ~15 odnosno ~40 dana.

Probni poziv (ista rečenica s instrumentalom, sva tri modela gramatički ispravna):

| model | put | latencija | napomena |
|---|---|---|---|
| `gemini-3.8-flash` | Vertex global, krediti | 9,2 s | 859 tokena razmišljanja za 67 tokena odgovora — brzina ovisi o `thinkingConfig`, za A/B mjeriti i nisku razinu |
| `gemini-4-argon` | Vertex global, krediti | 1,8 s | radi na `bimbo-sync-prod`; cijena **$2 / $10** po M (uvodna), kasnije $4 / $20 [NV, sekundarni izvori]; ~2,7× skuplji od 3.8 Flasha → ~$0,28/ep za članak |
| `google/gemma-4-31b-it` | OpenRouter (DeepInfra) | 2,6 s | $0,09 / $0,34 po M; `:free` varijanta odmah 429, ne računati na nju |
| `google/gemma-4-26b-a4b-it` | OpenRouter | — | $0,076 / $0,255, MoE (4B aktivnih) |
| `claude-haiku-5-5` | Anthropic API | — | ključ u `.env.experiments` |

Gemma 4 je open-weight, pa dobar rezultat znači i opciju self-hosta kasnije (na
Modalu uz Canary). Zamka: aktivni `gcloud` account se opet prebacio na
`play-publisher@domovina-production` (403 na Vertexu) — testne skripte moraju
koristiti `--account=$VERTEX_ACCOUNT` kao i pipeline.

## Mjerenje 14.10.2026. — faza 1 benchmarka (14 ep, ~23 h)

Puni rezultati i zamke: `experiments/2026-10-11-asr-llm/README.md` §Stanje 14.10.,
tablice `experiments/2026-10-11-asr-llm/results/asr_metrics.md`.

- **Pretpostavka iz §Alternative potvrđena:** pyannote community-1 na Modal A100-40GB =
  **39–49 s po satu zvuka**. Canary + Parakeet + pyannote u jednom kontejneru, 14 epizoda,
  cijeli dan eksperimenta **$3,10** (uklj. ~7 srušenih kontejnera) → red veličine
  **~$0,15–0,25 po epizodi**, Mac izlazi iz kritičnog puta.
- **pyannoteAI precision-3 vs vlastiti pyannote-c1:** međusobni DER 2–5 % na 11/14 →
  hosted diarizacija se ne isplati (otpada redak „pyannoteAI hosted" iz kandidata).
- **ASR, WER prema Speechmatics Enhanced** (doslovniji je — poštapalice dižu WER svima):
  na razgovorima Canary ≈ Deepgram ≈ AssemblyAI (9–17 %); na sportskim/uživo emisijama
  Canary 5–8 bodova lošiji od Deepgrama. Parakeet najlošiji i jedini ispušta (do 6 min).
  Nijedan servis ne ispušta sadržaj kao Canary EN→HR (§TRANSCRIPT_GAP).
- Deepgram je najbrži (3 h → 45 s), AssemblyAI najjeftiniji plaćeni (~$0,19/h).
- Otvoreno: Speechmatics kao referenca je slab na emisijama s puno glasova (Ril Tok #202:
  20 govornika naspram 4–5 kod svih ostalih) → ručno ispravljeni isječci i dalje trebaju.
- GCP krediti prije faze 2 (LLM): **$216,92 / $300** (14.10. 01:27).

## Mjerenje 14.10.2026. — faza 2 (LLM) + slijepa ocjena (14 ep)

Puni rezultati: `experiments/2026-10-11-asr-llm/results/llm_metrics.md`, nalazi i zamke u
`experiments/2026-10-11-asr-llm/README.md` §Stanje 14.10. 02:55. Isti ulaz (Speechmatics SRT),
isti produkcijski promptovi, 14 Opus ocjenjivača slijepo (A–E).

| model | ukupna ocjena | teške greške | $/ep (sažetak + članak + EN) |
|---|---|---|---|
| Gemini 4 Argon | **7,5** | 8 | 0,71 |
| Sonnet 5.5 (pretplata) | 7,3 | **0** | 2,14 ekv. |
| Gemini 3.8 Flash (produkcija) | 6,2 | 6 | 0,31 |
| Haiku 5.5 | 3,6 | 24 | 0,12 |
| produkcijski Opus (n=2) | 8,5 | 0 | ~2,4 |

Posljedice za procjenu troška:
- **Haiku 5.5 otpada za članke** — red „Haiku ~$6/mj za sažetak + članak" u §Alternative nije
  ostvariv bez gubitka kvalitete.
- **Argon umjesto Flasha** za nightly: +$0,40/ep, ≈ +$240/mj na 600 ep (standard, bez batcha).
  Bolji na 12/14, ali halucinira imena na sportskim emisijama.
- **Sonnet 5.5 kao zamjena za Opus** za prioritetne: blizu ocjene, nula teških grešaka, ~10 %
  jeftiniji ekvivalent od Opusa; prespor za nightly (107 s/poziv, EN duge epizode 8 min).
- EN cijelog članka u **jednom** pozivu radi na svim modelima (oblik sačuvan 14/14) — potvrđena
  pretpostavka iz preporuke 1.
- Strani znakovi (ćirilica, kineski, japanski) usred riječi kod svih modela → post-filter.
- GCP krediti: faza 2 potrošila ~$14,35 (Flash $4,35 + Argon $10,00) po izračunu iz tokena;
  konzola to još ne pokazuje (billing kasni) — očitati 15.10. (prije $216,92).
