# Diarization Quality Benchmark — 2026-05-11

Generirano: 2026-05-11T14:06:55.216Z

Usporedba dvije dijarizacijske pipeline-e nad 5 epizoda iz `mladi_za_domovinu` kanala:

- **CANARY**: Canary 1B v2 transcription + pyannote community-1 diarization (Mac lokalno)
- **SORTFORMER**: Canary 1B v2 transcription + NVIDIA Streaming Sortformer 4spk v2.1 (Colab G4)

Transkript je u oba slučaja isti (oba koriste Canary). Razlika su samo `[SPEAKER_XX]` oznake.

## TL;DR — Ključni nalaz

- **LLM ocjene praktički identične**: Canary 94.40/100, Sortformer 94.40/100.
- **Razlog**: per-segment disagreement između sustava je samo **1.7%** — pod optimalnim mapiranjem govornika, sustavi se slažu u ~98% segmenata. Stoga su side-by-side prikazi koje LLM ocjenjuje u velikoj većini prozora **bukvalno identični**, što vodi do iste ocjene (često i istog obrazloženja verbatim).
- **Praktična implikacija**: oba sustava produciraju usporedivo kvalitetnu dijarizaciju za 2-osobni interview format. Razlike su u **objektivnim mikro-metrikama** (vidi sekciju 4):
  - Sortformer ima više **flicker** (6.0 vs 3.8) i **rapid-switch** (3.6 vs 1.6) artefakata — sugerira blago više over-segmentation.
  - Sortformer producira ~5 više turn-ova po epizodi.
  - Speaker-time balance približno isti (0.306 vs 0.316) — niska vrijednost znači da je u korpusu jedan govornik dominantan (host/gost asymmetry tipična za intervjue ovog kanala).
- **Preporuka**: zadržati stabilni Canary+pyannote workflow (Mac lokalno) kao default — jednako kvalitetna dijarizacija uz nižu cijenu (vidi CLAUDE.md "Diarization Cost/Performance Note"). Sortformer je validan eksperimentalni alternativni put kad Mac nije dostupan.

## 1. Rezultati po epizodi (LLM ocjene)

| Epizoda | Canary score | Sortformer score | Δ (sort - canary) |
|---|---:|---:|---:|
| `bL4l4df_UTI` | 100.0 | 100.0 | 0.0 |
| `KuWqx0TJaVM` | 100.0 | 100.0 | 0.0 |
| `Df--kDZSIYU` | 100.0 | 100.0 | 0.0 |
| `iP5X9Q93sSY` | 72.0 | 72.0 | 0.0 |
| `LJtqwpxbB84` | 100.0 | 100.0 | 0.0 |

## 2. Ukupne ocjene

- **Canary**: 94.40 / 100
- **Sortformer**: 94.40 / 100
- **Pobjednik**: TIE (margina: 0.00 bodova)

## 3. Primjeri obrazloženja

### Najbolji prozor (combined=100.0)
Epizoda `bL4l4df_UTI`, t=00:09:57–00:11:27

- **Canary** (100/100): Oznake govornika su dosljedne, promjene govornika savršeno se podudaraju s prirodnim prekidima u razgovoru, a podjela je prirodna bez 'flickanja'.
- **Sortformer** (100/100): Oznake govornika su dosljedne, promjene govornika savršeno se podudaraju s prirodnim prekidima u razgovoru, a podjela je prirodna bez 'flickanja'.

### Najgori prozor (combined=25.0)
Epizoda `iP5X9Q93sSY`, t=00:21:38–00:23:08

- **Canary** (25/100): Konzistentnost govornika je narušena jer je dugi segment na kraju pogrešno pripisan drugom govorniku. Granice turn-a su djelomično točne, ali ključna dugačka izjava je pogrešno atribuirana, što narušava plauzibilnost razgovora.
- **Sortformer** (25/100): Konzistentnost govornika je narušena jer je dugi segment na kraju pogrešno pripisan drugom govorniku. Granice turn-a su djelomično točne, ali ključna dugačka izjava je pogrešno atribuirana, što narušava plauzibilnost razgovora.

## 4. Cross-reference s objektivnim metrikama (compare_stats.js)

| Epizoda | Sustav | Balance | Flicker | Rapid | Turns | Disagreement |
|---|---|---:|---:|---:|---:|---:|
| `bL4l4df_UTI` | canary | 0.288 | 7 | 3 | 97 | 2.8% |
| `bL4l4df_UTI` | sortformer | 0.283 | 11 | 8 | 98 |  |
| `KuWqx0TJaVM` | canary | 0.130 | 0 | 0 | 46 | 0.5% |
| `KuWqx0TJaVM` | sortformer | 0.154 | 1 | 0 | 49 |  |
| `Df--kDZSIYU` | canary | 0.183 | 3 | 1 | 42 | 0.0% |
| `Df--kDZSIYU` | sortformer | 0.183 | 3 | 1 | 42 |  |
| `iP5X9Q93sSY` | canary | 0.319 | 2 | 0 | 69 | 2.0% |
| `iP5X9Q93sSY` | sortformer | 0.348 | 4 | 0 | 76 |  |
| `LJtqwpxbB84` | canary | 0.612 | 7 | 4 | 96 | 3.4% |
| `LJtqwpxbB84` | sortformer | 0.613 | 11 | 9 | 110 |  |

**Agregat:**
- Canary: balance=0.306, flicker=3.8, rapid=1.6, turns=70.0
- Sortformer: balance=0.316, flicker=6.0, rapid=3.6, turns=75.0
- Disagreement (canary vs sortformer): 1.7%

**Interpretacija**: viši `balance` = ravnomjernija raspodjela vremena između govornika (bliže 1.0 = savršeno 50/50). Niži `flicker` i `rapid` = manje sumnjivih kratkih turn-ova i rapid-switching artefakta. Niži `disagreement` znači da se sustavi slažu na razini segmenta.

---

**Metodologija**: 5 epizoda × 3 random 90s prozora = 15 LLM evaluacija. Sudac: Gemini 2.5 Flash (Vertex AI OAuth, global region). Window-ovi sampliraju se sa seeded RNG (mulberry32, seed=20260511) za reproducibilnost. Sustavi se anonimiziraju samo po imenu (`CANARY`/`SORTFORMER`); model ne zna koji je koji algoritam.
