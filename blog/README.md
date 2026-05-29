# Blog

Tehnički zapisi o izgradnji domovina.ai podcast platforme.

## Objave

- **[Kako smo automatski izjednačili glasnoću 2683 podcast epizode](2026-05-29-standardizacija-glasnoce-podcast-kataloga.md)** (2026-05-29)
  Audio inženjering: EBU R128 mjerenje, tri zamke `loudnorm`-a (two-pass clipping, linearni gain bez limitera, codec true-peak inflacija) i automatska normalizacija cijelog kataloga na -16 LUFS. Rezultat: stddev glasnoće 5.21 → 0.70 LU.

---

Detaljnija inženjerska dokumentacija je u [`/docs`](../docs/) (`loudness_analysis_2026-05.md`, `loudness_normalization_2026-05.md`).
