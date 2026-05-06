# Diarization research — May 2026

Validates the existing pipeline decision: **Canary 1B v2 transcription on Colab G4 GPU, pyannote
community-1 diarization on Mac Mini M4 Pro**. Triggered by the empirical observation that a $20k
Colab G4 instance and a $1.5k Mac Mini take roughly the same wall-clock time for diarization.

> Companion to the "⚠️ Diarization Cost/Performance Note" section in `CLAUDE.md`.
> All sources at the bottom; everything dated late 2025 / early 2026 unless noted.

---

## 1. TL;DR

- **A truly fully-GPU diarization model exists** (NVIDIA Sortformer / Streaming Sortformer, EEND-TA,
  DiariZen). Sortformer can do ~5000× real-time on GPU with <2 GiB VRAM. **But:** the strongest
  candidate (Sortformer) is **CC-BY-NC-4.0** — non-commercial only — which conflicts with this
  pipeline's commercial-leaning context (cdn.domovina.ai, R2 hosting, public site). DiariZen is
  MIT-licensed and end-to-end neural but its pipeline still includes a VBx clustering stage.
- **pyannote is CPU-bound by design.** Confirmed by maintainers: the segmentation+embedding stages
  use the GPU, but agglomerative/HDBSCAN clustering and audio I/O run on CPU. Reported real-time
  factor on a V100 is ~2.5%; the GPU sits idle for most of that time. This is an architectural
  property of any "neural segmentation + classical clustering" pipeline, not a bug.
- **Switching models would change the perf/cost story only modestly** for this workflow. Sortformer
  on a Colab G4 would be faster than pyannote, but (a) license blocks it, (b) the M4 Pro at
  ~real-time wall-clock is already cheaper than re-renting Colab compute for diarization. **The
  Mac-for-diarization decision holds.**
- **Automation** (Drive watcher → auto-run diarize) is feasible with a `launchd` agent + `fswatch`
  watching the rclone-synced folder, and is the right pattern *if* the workflow runs more than
  twice a week. For weekly batches it is **mild over-engineering**; a `cron` poll every 30 min that
  runs the existing `--with-local-canary-diarize` flag is simpler and fails safer.
- **One concrete easy win regardless of model choice**: if you ever need to batch faster than
  realtime on the Mac, **FluidAudio** (Apache-2.0, CoreML-on-ANE port of pyannote) reports 60×
  realtime on M1, leveraging the Neural Engine that pyannote-audio's PyTorch/MPS path can't touch.
  Same model family — drop-in for the diarization stage if pyannote ever becomes a bottleneck.

---

## 2. Survey of GPU-resident diarization models (late 2025 / early 2026)

| Model / Toolkit | License | Languages | GPU end-to-end? | SRT-style speaker turns? | Evidence |
|---|---|---|---|---|---|
| **NVIDIA Sortformer (`diar_sortformer_4spk-v1`)** | **CC-BY-NC-4.0** | EN-trained, tested OK on Mandarin & CALLHOME multilingual | **Yes** — Transformer-encoder end-to-end, no clustering step | Yes, frame-level `spk_0..3` with timestamps | HF model card; NeMo docs |
| **NVIDIA Streaming Sortformer (`diar_streaming_sortformer_4spk-v2/v2.1`)** | **CC-BY-NC-SA-4.0** | Same as above | **Yes** — streaming, real-time | Yes | NVIDIA dev blog Aug 2025 |
| **DiariZen (BUT FIT)** | **MIT** | Multilingual (WavLM backbone); Croatian not explicitly evaluated | **Partial** — WavLM+Conformer EEND on chunks (GPU), then **VBx clustering** (CPU) | Yes, full pipeline | DiariZen GitHub; Lanzendörfer 2025 benchmark |
| **EEND-TA (Broughton et al. 2025)** | Research (paper; no clean release artifact) | EN benchmarks | **Yes** — 5870× real-time on GPU; 460× on CPU; ≤1.6 GiB VRAM | Yes (frame-level posteriors) | Interspeech 2025 paper |
| **pyannote community-1** *(current)* | **CC-BY-4.0** (free, includes commercial) | Trained on multilingual data, works fine on Croatian empirically | **No** — segmentation/embedding on GPU, clustering on CPU | Yes, native | pyannote HF model card |
| **3D-Speaker (modelscope)** | Apache-2.0 | Mandarin + English first-class | **No** — VAD + embedding (GPU) + clustering (CPU), same shape as pyannote | Yes | 3D-Speaker GitHub |
| **sherpa-onnx diarization** | Apache-2.0 | language-agnostic (uses pyannote-derived ONNX models) | **No** on macOS — no ANE/CoreML support, runs **CPU-only** for diarization | Yes | k2-fsa docs; inference.plus blog |
| **WhisperX diarization** | BSD (WhisperX) + pyannote license | Same as pyannote | **No** — wraps pyannote; same CPU clustering bottleneck (issue #274 explicitly: "diarization too slow… executed on the CPU rather than the GPU") | Yes | WhisperX issue tracker |
| **FluidAudio (Swift)** | **Apache-2.0** | Same as pyannote upstream | **Yes-ish on Apple** — CoreML on ANE, including clustering pass; reports 0.017 RTF on M1 (60× RT) | Yes; CLI mode `swift run fluidaudiocli` | FluidAudio GitHub |
| **AssemblyAI / Deepgram / pyannoteAI premium** | Commercial API | Multilingual | N/A (server-side) | Yes | (out of scope per user constraints) |

**Bottom line of the survey:** the only models that are *both* truly GPU-resident end-to-end *and*
commercially licensed *and* off-the-shelf for batch SRT output are **DiariZen** (partial — VBx still
on CPU) and **FluidAudio** (Apple-only). The GPU-end-to-end SOTA (Sortformer / EEND-TA) is either
non-commercial or research-only.

---

## 3. Why pyannote is CPU-heavy (architectural reason)

Pyannote (and every model in the "EEND-VC" / "neural-then-cluster" family — including DiariZen,
3D-Speaker, sherpa-onnx, WhisperX) is a **two-stage pipeline**:

1. **Local stage (GPU-friendly):** sliding-window segmentation network + speaker embedding network
   produce a stream of (segment, embedding) pairs. This is dense matrix multiplies on fixed-size
   tensors → ideal for GPU.
2. **Global stage (CPU-bound):** the embeddings from stage 1 are clustered (agglomerative
   hierarchical clustering, HDBSCAN, VBx) to assign global speaker IDs. This is **sklearn-style
   pairwise distance + linkage** on a full N×N affinity matrix where N grows with audio length. It
   is sequential, branchy, dominated by Python/NumPy/sklearn overhead, and has **no GPU
   implementation in the upstream toolkits**.

Consequence: even on a Tesla V100, pyannote's reported RTF is ~2.5% (i.e. processing a 1-hour file
takes ~90s) and the GPU is idle for the majority of that — the CPU clustering stage dominates the
tail. Multiple maintainer-acknowledged issues confirm this:

- pyannote-audio **#1403** ("Very low GPU usage (5%) and slow diarization"): user reports
  GPU at 5% utilization while one CPU core pegged at 100%.
- pyannote-audio **#1753** ("High CPU usage during embeddings step"): 100% utilization across 32
  cores, GPU idle.
- pyannote-audio **#1626**: 3.1 is *slower than 3.0 on CPU* — clustering changes only.
- WhisperX **#274** ("Diarization too slow"): identifies CPU-bound diarization as the core problem.

**End-to-end neural diarization (EEND family) does run fully on GPU**, because there's no
clustering stage — speaker identity falls out of the network's frame-level posteriors directly. This
is exactly Sortformer's and EEND-TA's design. EEND-TA reports **5870× realtime on GPU vs 460× on
CPU** for the DIHARD III set — a ~12× GPU/CPU gap that pyannote can't realize because its CPU
stage is non-trivial.

The catch with pure EEND: classical EEND models have a **fixed maximum speaker count** (Sortformer
v1/v2 = 4 speakers) and **memory grows with audio length** because the whole transformer attends
over the recording. Hybrid approaches like DiariZen (WavLM+Conformer chunked + VBx) re-introduce
clustering precisely to handle long, many-speaker recordings — and re-introduce the CPU bottleneck.

So the architectural answer is: **diarization is CPU-bound iff the pipeline does post-hoc clustering;
it is GPU-bound iff it is fully end-to-end neural with bounded speaker count.** Real podcasts
(2-6 speakers, 1-3 hour recordings) are exactly the awkward middle where pure EEND is borderline
and clustering is still attractive.

---

## 4. Automation options — Drive → Mac handoff

The current manual step: run `./run_pipeline.sh --with-local-canary-diarize` on the Mac after
Colab finishes. Three patterns to automate it:

### (a) `launchd` + `fswatch` watching the rclone-synced folder *(recommended if you automate)*

Plain macOS, no daemons. `fswatch` (Homebrew) wraps `FSEvents` and is reliable; `launchd`'s native
`WatchPaths` is *officially discouraged* by Apple because file events can be missed and there's no
guarantee the file is in a consistent state when the agent fires (per Apple's own docs).

Sketch:

```bash
# /Users/ms/Library/LaunchAgents/tv.domovina.diarize.plist
# ProgramArguments: fswatch -0 --event Created --event Updated <SYNC_DIR> | xargs -0 -n1 \
#   /Users/ms/git/domovinatv/fetch.domovina.tv/run_pipeline.sh --with-local-canary-diarize \
#   --only-diarize
# RunAtLoad: true   KeepAlive: true
```

Caveats:
- rclone writes files atomically to a tmp name and renames — `fswatch` fires on the rename, which
  is exactly what you want. Still, debounce (sleep 30s) before invoking the pipeline to let
  multi-file batches settle.
- Concurrency: gate with `flock` on a lockfile so two events can't run two diarizations at once.

### (b) Google Drive Push Notifications via Pub/Sub

Possible (Drive API supports `files.watch` → webhook), but requires a public HTTPS endpoint or a
Pub/Sub bridge. **Massively over-engineered** for a weekly batch. Skip.

### (c) GitHub Actions self-hosted runner

Triggered by Colab pushing a commit (e.g. an updated state file). Works, but needlessly couples
diarization to git history and wastes commits. Skip.

### (d) Plain `cron` poll *(actually probably the right answer)*

```cron
*/30 * * * * cd /Users/ms/git/domovinatv/fetch.domovina.tv && \
  ./run_pipeline.sh --with-local-canary-diarize --only-diarize >> /tmp/diarize.log 2>&1
```

Pros: dead simple, the existing pipeline is already idempotent (skips files with existing
`.canary.diarized.srt`), no new dependencies.
Cons: up to 30 min latency vs near-instant fswatch. For a weekly batch this is irrelevant.

**Recommendation:** start with a cron job (15 min effort, zero new code). Promote to `launchd`+
`fswatch` only if (i) batches become daily, or (ii) you find yourself manually triggering reruns
because you couldn't wait the 30 min poll interval.

---

## 5. Final verdict — does the current Mac-for-diarization tradeoff hold?

**Yes, robustly, for at least the next 6-12 months.** Reasons:

1. **License walls block the obvious GPU upgrade.** The only model that would clearly beat pyannote
   in the GPU-bound regime — Sortformer — is CC-BY-NC. Using it on a public CDN-fronted site
   (`cdn.domovina.ai`) is at minimum legally murky. Until NVIDIA ships a permissively-licensed
   Sortformer, this door is closed.
2. **DiariZen is the realistic open-source upgrade target**, but it still uses VBx clustering on
   CPU. It would improve DER (~13.3% vs pyannote community-1 at ~14-15% on the same benchmarks)
   but not fundamentally shift GPU/CPU balance. Worth piloting if accuracy is the bottleneck —
   not if cost/wall-clock is.
3. **Pyannote's CPU-bound nature is fundamental, not a bug**, and confirmed by maintainers across
   multiple versions. Throwing GPU at it (Colab G4, A100, H100) buys you almost nothing on the
   clustering tail. The M4 Pro's strong single-thread performance + 12-core CPU is, perversely,
   one of the better bang/buck CPUs for this exact workload.
4. **If the Mac ever becomes the bottleneck**, the clean upgrade path inside the same pyannote
   family is **FluidAudio** (Apache-2.0, CoreML-on-ANE, ~60× realtime on M1). That moves work to
   the Neural Engine that pyannote-audio's PyTorch/MPS path doesn't currently target. Same model
   weights, much faster on Apple silicon.
5. **Colab G4 for transcription remains the right call** — Canary 1B v2 is a pure dense
   transformer, no clustering, GPU-bound throughout, and benefits ~10× from the GPU.

**No reason to revisit the split.** Do plug a `cron */30` line in for the handoff, document
DiariZen and FluidAudio as future upgrade paths, and re-evaluate when (a) NVIDIA relicenses
Sortformer, or (b) DiariZen ships a GPU-resident clusterer, or (c) batch volume grows >5×.

---

## 6. Sources

All accessed May 2026.

**Pyannote / community-1**
- [pyannote/speaker-diarization-community-1 (HF model card)](https://huggingface.co/pyannote/speaker-diarization-community-1) — license CC-BY-4.0, benchmarks
- [pyannoteAI blog: Community-1: Unleashing open-source diarization](https://www.pyannote.ai/blog/community-1)
- [pyannote-audio issue #1403 — Very low GPU usage (5%) and slow diarization](https://github.com/pyannote/pyannote-audio/issues/1403)
- [pyannote-audio issue #1753 — High CPU usage during embeddings step](https://github.com/pyannote/pyannote-audio/issues/1753)
- [pyannote-audio issue #1626 — 3.1 slower than 3.0 on CPU](https://github.com/pyannote/pyannote-audio/issues/1626)
- [Towards AI: Towards Approximate Fast Diarization (CPU-only alternative)](https://towardsai.net/p/machine-learning/towards-approximate-fast-diarization-a-cpu-only-alternative-to-pyannote-3-1)

**NVIDIA Sortformer / NeMo**
- [nvidia/diar_sortformer_4spk-v1 (HF, CC-BY-NC-4.0)](https://huggingface.co/nvidia/diar_sortformer_4spk-v1)
- [nvidia/diar_streaming_sortformer_4spk-v2 (HF, CC-BY-NC-SA-4.0)](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2)
- [nvidia/diar_streaming_sortformer_4spk-v2.1 (HF)](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1)
- [NVIDIA dev blog: Identify Speakers with Streaming Sortformer (Aug 2025)](https://developer.nvidia.com/blog/identify-speakers-in-meetings-calls-and-voice-apps-in-real-time-with-nvidia-streaming-sortformer/)
- [Sortformer paper (arXiv 2409.06656)](https://arxiv.org/html/2409.06656v1)
- [NeMo speaker diarization models docs](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/asr/speaker_diarization/models.html)

**EEND family**
- [Pushing the Limits of End-to-End Diarization (Broughton et al., Interspeech 2025)](https://arxiv.org/html/2509.14737) — EEND-TA 5870× RT on GPU, 1.6 GiB VRAM
- [LS-EEND: Long-Form Streaming EEND with Online Attractor Extraction](https://arxiv.org/html/2410.06670v1)
- [EEND-vector-clustering (NTT, GitHub)](https://github.com/nttcslab-sp/EEND-vector-clustering)
- [Integrating EEND and clustering-based diarization (arXiv 2010.13366)](https://ar5iv.labs.arxiv.org/html/2010.13366)

**DiariZen**
- [BUTSpeechFIT/DiariZen (GitHub, MIT)](https://github.com/BUTSpeechFIT/DiariZen)
- [Benchmarking Diarization Models (Lanzendörfer 2025, arXiv 2509.26177)](https://arxiv.org/html/2509.26177v1) — DiariZen 13.3% DER vs pyannoteAI 11.2% DER

**3D-Speaker / sherpa-onnx / WhisperX / FluidAudio**
- [modelscope/3D-Speaker (GitHub, Apache-2.0)](https://github.com/modelscope/3D-Speaker)
- [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and [Speaker Diarization docs](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html)
- [inference.plus: Near-Real-Time Speaker Diarization on CoreML](https://inference.plus/p/low-latency-speaker-diarization-on) — sherpa-onnx CPU-only on macOS, FluidAudio uses ANE
- [m-bain/whisperX issue #274 — Diarization too slow (CPU-bound)](https://github.com/m-bain/whisperX/issues/274)
- [FluidInference/FluidAudio (GitHub, Apache-2.0)](https://github.com/FluidInference/FluidAudio)
- [FluidInference/speaker-diarization-coreml (HF)](https://huggingface.co/FluidInference/speaker-diarization-coreml)

**Automation patterns**
- [Apple: Mac Automation Scripting Guide — Watching Folders](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/WatchFolders.html)
- [launchd.info — A launchd Tutorial](https://www.launchd.info/) — `WatchPaths` discouraged, race-prone
- [How to Trigger Any Action When a File Changes on macOS (mayeu.me)](https://mayeu.me/post/how-to-trigger-any-action-when-a-file-or-folder-changes-on-macos-on-the-cheap/)
- [rclone bisync docs](https://rclone.org/bisync/)
- [DEV.to: Using rclone and launchd to sync data to Google Drive on macOS](https://dev.to/dunkbing/using-rclone-and-launchd-to-sync-data-to-google-drive-on-macos-150j)
