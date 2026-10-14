# Eksperiment: ASR + diarizacija + LLM na danu 11.10.2026.

Test set = svih 14 epizoda s https://podcast.domovina.ai/dani/2026-10-11/
(`testset.tsv`): 2 već obrađene kroz pipeline (Speechmatics + Gemini refine +
Opus članak, služe kao referenca za usporedbu s produkcijom) i 12 novih
(~21 h audia, raspon 29–189 min; tri epizode > 2,5 h testiraju duge datoteke).

Kontekst i cijene: `docs/2026-10-13-procjena-troska-pune-dnevne-obrade.md`.
Ključevi: `.env.experiments` (nikad `.env`). Mediji i sirovi odgovori:
`data/` → `/Volumes/DOMOVINA1TB/experiments/2026-10-11-asr-llm` (gitignored).

## Faze

| # | faza | kandidati | procjena troška (14 ep, ~23 h) |
|---|---|---|---|
| 0 | `fetch_audio.sh` | yt-dlp → 16 kHz WAV + 64k MP3 | $0 |
| 1 | ASR + diarizacija | Speechmatics Enhanced (referenca, `SPEECHMATICS_API_KEY_EXPERIMENT`), Deepgram Nova-3 `hr`, AssemblyAI Universal-2 | ~$17 + kredit DG ~$6 + kredit AAI ~$4 |
| 1b | Modal, JEDAN kontejner po epizodi | Canary 1B v2 + Parakeet TDT 0.6B v3 + pyannote community-1 (GPU, mjeri s/h audia) | ~$3–5 (free tier) |
| 1c | samo diarizacija | pyannoteAI Precision (trial) | trial |
| 2 | LLM (ulaz = isti Speechmatics transkript za sve) | Gemini 3.8 Flash (osnovica), Gemini 4 Argon (Vertex, krediti), Claude Haiku 5.5, Gemma 4 31B + 26B-A4B (OpenRouter, plaćeno), Nemotron 3 Ultra + Inkling (OpenRouter `:free`) | <$5; Gemini iz GCP kredita |

LLM faza koristi iste promptove kao `summarize_gemini.js` i
`generate_article_gemini.js` (sažetak, outline, iteracije) i EN prijevod
jednim JSON pozivom po članku.

## Mjerenja

- **ASR:** WER prema Speechmatics Enhanced (normalizirano: mala slova, bez
  interpunkcije), pokrivenost (`TRANSCRIPT_GAP` logika — ispušteni prozori),
  broj govornika i DER prema referenci, pomak vremena riječi, wall-clock, $.
- **LLM:** slijepa usporedba (modeli anonimizirani A–G) za ocjenu urednika,
  stopa valjanog JSON-a na prvi pokušaj, halucinirana imena govornika, tokeni
  (uklj. razmišljanje), latencija, $/ep.

## Ograde

- Speechmatics nije istina — servis koji griješi drukčije izgleda lošije nego što
  jest. Za pravu referencu treba ručno ispraviti 3–4 isječka od 10 min.
- `:free` modeli na OpenRouteru: ~50 poziva/dan, zagušeni (429), provider smije
  logirati — sadržaj je javni YouTube.
- Haiku 5.5 i Gemini 3.8 Flash razmišljaju po defaultu; mjeriti i bez/niže.

## Trajni izlaz (arhiva, dataset.domovina.tv)

Izlaz eksperimenta NIJE privremen — to je proizveden sadržaj za tih 14 epizoda.

- `data/output/<kanal>/<base>.<…>` — raspored kao kanalski dir u `storage/output`,
  ali **namjerno izvan njega**: pipeline izvedene datoteke čita kao „korak gotov"
  i objavio bi ih na CDN.
- `base` = `{upload_date}_{sanitize(title)}_yt_{id}` (formula iz `fetch.js`);
  za 2 epizode koje pipeline već ima uzet je postojeći base i kanal (`bases.tsv`,
  `prepare_output.js`), pa u datasetu završe u istom folderu kao produkcija.
- Imena: `<base>.exp-20261011.<alat>.<artefakt>.<ext>`, npr.
  `….exp-20261011.deepgram-nova3.dijariziran.srt`,
  `….exp-20261011.haiku-5-5.clanak.json` (`sazetak`, `clanak`, `clanak.en`, `prijepis`). Sufiks nikad ne završava na
  produkcijski oblik (`_{date}_{model}.article.json`, `.wav.canary.diarized.srt`, `.summary.json`, `.article.json`),
  pa ništa ne pregazi niti se ne zamijeni s produkcijom.
- Sirovi API odgovori: `<base>.exp-20261011_raw/<alat>.json`.
- `dataset.domovina.tv/sync_dataset.sh` korak 1c rsynca
  `experiments/*/data/output/` (tekstualni whitelist: json, jsonl, srt, md, txt,
  vtt, description) u `data/<kanal>/<base>/`. ⚠️ Dataset repo je **PUBLIC** na
  GitHubu — `--commit --push` objavljuje i ove datoteke.
- Audio (`data/audio/`, WAV + MP3 + webm) ostaje trajno na DOMOVINA1TB; sync ga
  ne dira (samo tekst).

## Stanje 14.10.2026. — faza 1 GOTOVA (14/14 za svaki alat)

Skripte: `asr_cloud.js` (1a), `modal_asr_diar.py` (1b), `diar_pyannoteai.js` (1c),
`evaluate_asr.py` (3a → `results/asr_metrics.md` + `.json`). Logovi i stanje računa
prije/poslije: `data/logs/`.

| alat | trošak (stvarni / procjena) | brzina |
|---|---|---|
| Speechmatics Enhanced | 12 poslova, 18,71 h (usage API); ~$14,6 po $0,80/h. 2 ref. epizode preuzete iz produkcije | 3 h ep ≈ 10 min |
| Deepgram Nova-3 `hr` | procjena ~$5,30; balans $200 → $199,15 nakon runa, usage API isti dan prazan — **provjeriti ponovno** | 3 h ep ≈ 45 s |
| AssemblyAI Universal-2 | procjena ~$3,90 (`speech_models: ["universal-2"]`, stari `speech_model` ukinut) | 3 h ep ≈ 5 min |
| Modal A100-40GB (Canary + Parakeet + pyannote, 1 kontejner/ep) | **$3,10** za cijeli dan (billing report, app `domovina-exp-asr-20261011`), uklj. ~7 srušenih kontejnera | wall 2,5–6,7 min/ep |
| pyannoteAI precision-3 | trial | 30–160 s/ep |

**Ključni nalaz 1b:** pyannote community-1 na A100 = **39–49 s po satu zvuka**
(cilj 30–60) → diarizacija stane u isti Modal kontejner kao transkripcija, Mac izlazi
iz kritičnog puta. Canary 19–35 s/h (bf16), Parakeet 24–37 s/h (fp32), učitavanje
modela ~60–80 s po kontejneru.

**Ključni nalazi 3a** (referenca Speechmatics, nije istina):
- Najčešće „greške" su izbačene poštapalice/veznici (`i`, `je`, `dakle`, `pa`) —
  Speechmatics je doslovniji. Na urednim razgovorima svi su 9–17 % WER.
- Canary ≈ Deepgram ≈ AssemblyAI na razgovorima; Canary lošiji na sportskim/uživo
  emisijama (4s5SI 40,6 vs 34,6; v6Qd 51,8 vs 43,3). Parakeet najlošiji i jedini
  ispušta (IjoWv3 6 min).
- **pyannote-c1 (Modal) vs pyannoteAI precision-3: međusobni DER 2–5 % na 11/14
  epizoda** → plaćeni hosted diarizator ne donosi ništa bitno.
- v6QdSjd8NAE (Ril Tok #202): svi ~43–52 % WER i ~50 % DER, Speechmatics jedini vidi 20
  govornika (ostali 4–5) → sumnja na referencu, ručno pregledati.

**Zamke 1b** (popravljeno u skripti):
- Parakeet u bf16 + CUDA graph dekoder: DRUGI `transcribe()` u istom procesu →
  `illegal memory access` (Xid 31), Modal je srušeni input ponavljao u petlji.
  Sada fp32, `use_cuda_graph_decoder=False`, `retries=0`.
- Parakeet fp32 123 min u komadu = OOM na 40 GB → komad 80 min.

Sljedeće: faza 2 (LLM). Odluke 14.10.: OpenRouter uplata PRESKOČENA (Gemma, Nemotron,
Inkling otpadaju); Sonnet 5.5 ide preko Claude Code PRETPLATE (`claude -p --model sonnet
--tools ''`, neutralan cwd, nikad `--bare` — vidi `docs/claude_code_backend_2026-07.md`).
Kandidati: Gemini 3.8 Flash (osnovica) + Gemini 4 Argon (Vertex, krediti), Haiku 5.5
(exp ključ), Sonnet 5.5 (pretplata). GCP krediti prije: $216,92 (`data/logs/gcp_krediti_prije_faza2.json`).
Slijepu ocjenu članaka i analizu rade Opus subagenti.

## Faza 2 (LLM) — `llm_phase2.js`

Ulaz za sve modele: `<base>.exp-20261011.speechmatics-enhanced.dijariziran.srt`.
Promptovi se **izvlače doslovno** iz produkcije pri svakom pokretanju (`SYSTEM_PROMPT` iz
`summarize_gemini.js`, `SYSTEM_PROMPT_1/2` + `STRICT_NAMING_CLAUSE` iz
`generate_article_gemini.js`, `TRANSLATOR_PROMPT` iz `translate_to_english.js`), pa
promjena produkcijskog prompta automatski ulazi u eksperiment. Ako se prompt prepiše
tako da ima `${…}` interpolaciju, skripta puca umjesto da tiho koristi krivi tekst.

| slug | put | postavke |
|---|---|---|
| `gemini-3-8-flash` | Vertex global, `bimbo-sync-prod` | kao produkcija: temp 0,2, `responseMimeType: application/json`, thinking default |
| `gemini-4-argon` | Vertex global | isto |
| `haiku-5-5` | Anthropic API (`ANTHROPIC_API_KEY_HAIKU_EXPERIMENT`), raw fetch + SSE | effort default (medium), adaptive thinking; cijena ×5 iznad 100k prompta |
| `sonnet-5-5` | `claude -p --model sonnet --effort high --tools ''`, neutralan cwd, pretplata | `ANTHROPIC_API_KEY` se briše iz env-a djeteta; skripta odbija start ako je postavljen |

Koraci po epizodi: sažetak → outline → N iteracija (+1 schema-fix poziv kad fali polje,
kao produkcija) → EN cijelog članka u **jednom** pozivu. Službeni kontekst za članak
(govornici) gradi se iz sažetka **istog** modela. Mjerenja po pozivu u
`data/logs/faza2_pozivi.jsonl`: tokeni (Gemini daje `thoughtsTokenCount` zasebno;
Anthropic razmišljanje uračunava u `output_tokens`), ms, $, `jsonStrict` (čisti
`JSON.parse`) i `jsonLenient` (nakon skidanja ```` ``` ```` ograde). `--summary` zbraja.

**Proba 14.10. (PlPyI-TPlgw, 29 min):** sva 4 modela prošla bez greške, EN oblik sačuvan.
Claude modeli (Haiku, Sonnet) outline/iteraciju omotaju u ```` ```json ```` ogradu
(→ „blago"), Gemini nikad (forsiran MIME). $/ep: Flash 0,085, Argon 0,20, Haiku 0,020,
Sonnet 0,64 (ekvivalent). Argon ne prijavljuje tokene razmišljanja (0). Članak: Flash 6
sekcija / 7,9k znakova, Argon 6 / 13,3k, Haiku 16 / 15,8k, Sonnet 15 / 17,5k.
Tokenizer: isti ulaz je Geminiju 9,3k, Claudeu 14,2k tokena (~1,5×).

## Stanje 14.10.2026. 02:55 — faza 2 + 3b GOTOVE (14/14, sva 4 modela)

312 poziva, **nula grešaka poziva**, svi članci kompletni, EN oblik sačuvan 14/14 za svaki model.
Slijepa ocjena: `judge_prep.js` (paketi A–E, ključ `data/slijepo/kljuc.json`) → 14 Opus
subagenata po `judge_prompt.md` (svaki ~140–260k tokena, 2–5 min) → `judge_report.js` →
**`results/llm_metrics.md`** (+ `.json`, sve greške s citatom i vremenom u `data/slijepo/<id>/ocjena.json`).

| model | ukupno (1–10) | utemelj. | imena | pokriv. | jezik | 1. mjesta | teške greške | $/ep | s/poziv |
|---|---|---|---|---|---|---|---|---|---|
| produkcija-opus (n=2, drugi transkript) | 8,5 | 8,0 | 8,0 | 10 | 9,0 | 1 | 0 | ~2,4 | — |
| **gemini-4-argon** | **7,5** | 7,5 | 7,6 | 8,9 | 8,4 | **8** | 8 | 0,71 | 37 |
| **sonnet-5-5** (pretplata) | 7,3 | **8,0** | 6,9 | **9,7** | 7,2 | 5 | **0** | 2,14 ekv. | 107 |
| gemini-3-8-flash (današnja produkcija) | 6,2 | 6,6 | 6,8 | 6,6 | 7,8 | 0 | 6 | 0,31 | 47 |
| haiku-5-5 | 3,6 | 4,3 | 4,6 | 6,7 | 5,8 | 0 | 24 | 0,12 | 46 |

Nalazi:
- **Argon > Flash za +0,40 $/ep** — bolji na 12/14 epizoda, ali kad griješi, griješi teško
  (izmišljena imena igrača/klubova na sportskim emisijama, 5 halucinacija).
- **Sonnet nema nijednu tešku grešku** i najbolje pokriva snimku, ali je predug, imena ostavlja
  anonimnima ili prepisuje ASR šum („Madunić i Kadoić kao dva igrača"), slabiji hrvatski.
- **Flash (produkcija) je prekratak** — pokrivenost 6,6; izostavlja kraj razgovora.
- **Haiku 5.5 je neupotrebljiv za članke na hrvatskom**: krivo pripisane izjave, izmišljeni
  opisi slika, meta-rečenice u tekstu. Za sažetak/EN eventualno, za članak ne.
- **Strani znakovi usred hrvatskih riječi (ćirilica, kineski, japanski) javljaju se kod SVIH
  modela osim produkcijskog Opusa** (Flash „nagラスak", Argon, Sonnet, Haiku). Potreban
  deterministički post-filter u pipelineu bez obzira na model.
- JSON: Gemini 100 % strogo (forsiran MIME); Claude modeli ~40–60 % omotaju u ```` ```json ````
  — produkcijski parser to već skida, dakle 100 % upotrebljivo.
- Claude tokenizer: isti ulaz ~1,35× više tokena. Haiku iznad 100k prompta ×5 cijena
  (duge epizode) → $0,12/ep umjesto procijenjenih $0,03.
- Trošak cijelog runa: Flash $4,35 + Argon $10,00 (GCP krediti), Haiku $1,64 (API),
  Sonnet $29,98 ekvivalenta (pretplata, ~4,5 M ulaz + 1,3 M izlaz; EN najdulje epizode 89k
  tokena izlaza / 8 min).

Zamka u ovoj sesiji: `A && B && X=… && node … & node $X …` — `&` pozadini CIJELI `&&` lanac,
pa varijable ne postoje u sljedećim naredbama; 2 od 3 Sonnet procesa su tiho pala (log na `/`).
Varijable postavljati u zasebnim linijama prije `&`.

Otvoreno: GCP krediti poslije (billing kasni — očitati 15.10., prije $216,92, očekivano ~$203);
odluka Argon vs Flash za nightly (+$0,40/ep ≈ +$240/mj na 600 ep); Sonnet za prioritetne
umjesto Opusa; post-filter stranih znakova; Deepgram balans; Ril Tok referenca.
