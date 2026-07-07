# modal_canary — on-demand Canary transkripcija (Modal serverless A100-40)

Ad-hoc transkripcija **jedne** epizode bez stalno upaljenog GPU-a. Scale-to-zero: plaćaš samo
sekunde izvršavanja, $0 dok miruje. Za **bulk** koristi `colab_canary/` (Colab G4 batch) — jeftiniji
po fajlu na skali.

## Kad Modal vs Colab (trošak + break-even)

Vidi **`docs/transcription_colab_vs_modal_cost_2026-07.md`** (SSOT) — mermaid dijagrami oba procesa
+ break-even analiza. Sažetak: **< ~20 nakupljenih epizoda → Modal ad-hoc** (zanemariv trošak, često
$0 pod free tierom, instant single-pass); **≥ ~20 backlog → Colab G4 batch** (~$0.003/ep na skali).

## Setup (jednom)

```bash
pip install modal && modal setup
modal run modal_canary/canary_modal.py::download_model   # napuni Volume s R2 (6.36 GB, jednokratno)
```

## Ad-hoc transkripcija

```bash
modal run modal_canary/canary_modal.py --wav /put/do/file.wav   # → file.wav.canary.srt/.csv pokraj WAV-a
```

## Single-pass u pipelineu

`run_pipeline.sh --with-modal-transcribe` (KORAK 2.6) transkribira lokalne `_unlisted` WAV-ove na
Modalu → `.canary.srt` lokalno → KORAK 6 diarizira odmah (bez Colab/rclone round-tripa). Scope je
**samo `_unlisted`** (ad-hoc pipeline.domovina.ai jobovi); bulk ostaje Colab. Cap `MODAL_MAX_FILES`
(default 20). Koordinacija s Colabom preko transcription claim/lock — vidi glavni doc.

- GPU: A100-40GB (3h WAV ~28 GB peak). Za 5h+ prebaci na `A100-80GB` u `canary_modal.py`.
- Model: R2 cache (`models.domovina.ai`) → perzistentni Modal Volume `domovina-canary-model`.
