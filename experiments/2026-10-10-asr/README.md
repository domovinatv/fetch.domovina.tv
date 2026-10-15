# Eksperiment: koji ASR + diarizacija je najbolji ulaz za Opus članak (dan 10.10.2026.)

Nastavak `experiments/2026-10-11-asr-llm/`. Tamo su svi LLM-ovi dobili ISTI Speechmatics
transkript, pa faza 2 nije rekla ništa o tome koji ASR daje bolji članak — samo koji LLM.
Ovdje je obrnuto: **isti LLM (Opus 5.5, produkcijski promptovi) nad tri različita
transkripta s diarizacijom** za svih 15 epizoda s https://podcast.domovina.ai/dani/2026-10-10/.

Test set: `testset.tsv` (15 ep, 797 min ≈ 13,3 h, 18–97 min), `bases.tsv` (kanal + base).
Mediji i izlaz: `data/` → `/Volumes/DOMOVINA1TB/experiments/2026-10-10-asr` (gitignored).
Oznaka izlaza `exp-20261010`; raspored i pravila imena kao u README-u 11.10. §Trajni izlaz.

> Dan 10.10. je 14.10. imao 15 epizoda, a prije toga manje: umbrella unosi u registryju
> (HRT, HKM, Laudato, Radio Marija, Radio MIR, ~50 emisija) dodaju epizode i u prošle dane
> (npr. „Živjeti Evanđelje (HKM)”, „Veterani mira (HRT)”; na 11.10. „HRT Pozitivno” kao 15.).

## Skripte (kopije iz 2026-10-11-asr-llm, prilagođene)

| skripta | što | razlika od originala |
|---|---|---|
| `run_all.sh` | zvuk → `bases.tsv` → Deepgram → Canary+pyannote (Modal) | novo |
| `fetch_audio.sh`, `prepare_output.js` | yt-dlp → 64k MP3 + 16 kHz WAV; info.json + base | — |
| `asr_cloud.js --provider deepgram\|speechmatics` | cloud ASR + diarizacija | TAG |
| `modal_asr_diar.py` | Canary 1B v2 + pyannote community-1 u JEDNOM A100 kontejneru | bez Parakeeta; epizoda bez MP3 se preskače umjesto da sruši cijeli run |
| `llm_opus.js --model opus-5-5 --input <asr>` | sažetak → outline → iteracije | `--input` bira transkript; izlaz `<base>.exp-20261010.<asr>.opus-5-5.{sazetak,clanak}.json`; EN samo uz `--with-en` |
| `run_llm.sh [ID,…]` | po epizodi 3 Opusa paralelno (jedan po ASR-u), pa sljedeća; najkraća prva | novo |

Opus ide kroz `claude -p --model opus --effort high --tools ''`, neutralan cwd, nikad `--bare`
(`docs/claude_code_backend_2026-07.md`); skripta odbija start ako je `ANTHROPIC_API_KEY` postavljen.

## Rezultati 14.10.2026. — ASR (svih 15/15 za svaki)

| alat | trošak (13,3 h) | brzina | diarizacija |
|---|---|---|---|
| Speechmatics Enhanced | **~$9,29** | 3 h ep ≈ 10 min; 74 min ep = 210 s | ugrađena |
| Deepgram Nova-3 `hr` | **~$3,46** (kredit) | **4–22 s po epizodi** | ugrađena (`diarize=true`), pyannote NE treba |
| Canary 1B v2 + pyannote-c1 (Modal A100-40GB, 3 kontejnera) | ~$2 (Modal billing NEOČITAN) | 14 ep za 8,6 min; Canary 14–35 s/h, pyannote 36–43 s/h | pyannote u istom kontejneru |

Broj govornika Deepgram / pyannote uglavnom se slaže; odstupanja: 2Pogled 3/5, Muževni budite
5/6, Veliki Judi 6/7, Veterani mira 15/19 (stvarno puno sugovornika).

## Rezultati 14.10. — Opus 5.5, 45 članaka (15 × 3), svi kompletni

| ulaz | pozivi | ulaz tok | izlaz tok | ekv. $ (pretplata) |
|---|---|---|---|---|
| Speechmatics | 61 | 1,94 M | 532k | 25,5 |
| Deepgram | 61 | 1,86 M | 545k | 24,6 |
| Canary + pyannote | 61 | 2,04 M | 514k | 26,0 |

Trošak LLM-a ne ovisi o ASR-u (±5 %); ASR odluku nose kvaliteta i cijena transkripcije.
~5,8 M ulaz + 1,6 M izlaz potrošilo je jedan cijeli 5-satni prozor pretplate: zadnje dvije
(najdulje) epizode pale su na limitu (`claude exit 1`, `total_cost_usd: 0`, 12 poziva) i
nastavljene nakon reseta — skripta nastavlja od zadnje gotove iteracije.

### Ručni pregled 2 epizode (NIJE slijepa ocjena)

| epizoda | Speechmatics | Deepgram | Canary + pyannote |
|---|---|---|---|
| Hajdučka štorija (OspwepfLObY, 18 min) | 17 sekcija; promašio „Bamba” → Opus piše „kritizirani igrač” | 17; „Bamba” ✓ | 15; „Bamba” ✓ |
| Veterani mira (0Oo1LHNiJR4, 25 min) | 15; „Brian” umjesto „Čubrijan” | **18**, najviše detalja, imena točna | **10**; „Tomo **Medvedev**”, „Željko **Vujčić**” ✗ |

Hipoteza nakon 2 epizode: Deepgram ≥ Speechmatics > Canary (Canary kvari imena osoba i daje
najkraći članak). Potvrditi slijepom ocjenom.

## Slijepa ocjena 15.10.2026. — 45 članaka, 15 Opus ocjenjivača

`judge_prep.js` → `data/slijepo/<id>/` (članci A/B/C i prijepisi X/Y/Z miješani NEOVISNO, pa
ocjenjivač ne može spariti članak s prijepisom; sva tri prijepisa su referenca jer nijedan nije
istina) → Opus subagent po `judge_prompt.md` → `ocjena.json`. Ključ: `data/slijepo/kljuc.json`.

| ulaz | ukupno | utemelj. | imena | pokriv. | jezik | rang 1./2./3. | teške / srednje / lake |
|---|---|---|---|---|---|---|---|
| Canary + pyannote | **6,93** | **7,40** | 6,80 | 8,67 | **8,33** | 6/6/3 | 11 / 29 / 70 |
| Deepgram Nova-3 | **6,93** | 6,87 | **7,07** | 8,67 | 8,13 | 6/3/6 | **9** / 41 / 59 |
| Speechmatics Enhanced | 6,60 | 7,07 | 6,40 | 8,73 | 7,93 | 3/6/6 | 13 / 37 / 58 |

Po epizodi (ukupno CA / SM / DG): Hajdučka štorija 6/4/7, Veterani mira 5/8/7, Muževni budite 8/8/7,
Veliki judi 8/7/6, Živjeti Evanđelje 7/8/9, Actualitica 6/6/7, 2Pogled 6/7/8, ATMA 7/7/5,
Bijela kronika 7/6/6, Libertas 7/7/8, Mjesto zločina 8/7/7, Čušpajz 8/6/6, Projekt SNOVI 9/6/8,
Samo Hajduk 5/4/7, Špica s Mačanom 7/8/6.

Nalazi:
- **Nema jasnog pobjednika**: razlika između ASR-ova (≤0,33) manja je od raspona među epizodama.
  Hipoteza iz ručnog pregleda (Deepgram ≥ Speechmatics > Canary) se NE potvrđuje.
- **Speechmatics, najskuplji (~$0,70/h), je zadnji** po ukupnoj ocjeni, imenima i teškim greškama.
- **Canary + pyannote (~$0,15/h na Modalu) je izjednačen s Deepgramom**; najbolji jezik i utemeljenost,
  ali slab na **sportu** (Hajdučka štorija 6, Samo Hajduk 5 — imena igrača) gdje Deepgram vodi (7, 7).
- Greške gotovo uvijek potječu iz prijepisa (imena, spojeni govornici, ispuštene niječnice);
  Opus ih vjerno prenosi. Meta-napomene „(kako piše u transkriptu)” procure u tekst kod svih ulaza.

Trošak ocjene: 15 ocjenjivača, 140–240k tokena i 2–4,5 min svaki (raste sporije od duljine:
18 min → 150k, 92 min → 238k). Kvota pretplate (`api/oauth/usage`, cijeli postoci, uklj. glavnu
sesiju): 5-satni prozor 16 → 36 %, tjedni 75 → 78 %.

## Gemini sluh nad Canary kostur (15.10.)

`agy_refine.js --backend agy|vertex` provodi KORAK 2.8 (doslovni `SKELETON_PROMPT`)
nad kosturom Canary + pyannote. `agy` ide kroz Google AI Pro pretplatu u tmuxu
(`run_agy_queue.sh <sesija> <trusted-dir> <ID…>`). Mjerenja, zamke `agy -p` i stanje
paralelnog runa: `docs/2026-10-15-agy-gemini-sluh-kroz-pretplatu.md`.

## Otvoreno

1. ~~Slijepa ocjena 45 članaka~~ — gotovo 15.10., vidi gore.
2. Modal trošak dana (app `domovina-exp-asr-20261010`) očitati s billinga.
3. Soniox ($0,10/h) i ElevenLabs Scribe v2 ($0,22/h) — kandidati bez ključa; ne testirani.
4. Lokalni preglednik usporedbe (3 članka jedan uz drugi) — predložen, nije napravljen.
   Članci NISU na domovina.ai i nightly ih neće pokupiti (izvan `storage/output`, ne-produkcijska imena).
