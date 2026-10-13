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
