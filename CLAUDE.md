# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
# Run tests (Node.js built-in test runner, no external deps)
node --test generate_article_gemini.test.js

# Syntax check any JS file
node -c <file.js>

# Run the full pipeline
./run_pipeline.sh --hf-token <TOKEN>

# Run only article generation (skips steps 0-6)
./run_pipeline.sh --only-articles

# Run only summarization (skips steps 0-6)
./run_pipeline.sh --only-summaries

# Dry run (preview without API calls)
./run_pipeline.sh --hf-token <TOKEN> --dry-run

# Check pipeline progress across all channels
node count_progress.js

# Detect anomalies and corrupt files
node inspect_pipeline.js --input-dir storage/output
```

## Architecture

10-step pipeline for processing Croatian YouTube podcasts into AI-enhanced searchable content. Orchestrated by `run_pipeline.sh`.

### Pipeline Flow

```
YouTube → fetch.js → convert_to_wav.js → generate_whisper_prompt.js → transcribe.js
  → transcribe_diarized.js / diarize_canary.py → summarize_gemini.js
  → generate_article_gemini.js → prepare_rag_*.js → screenshot_youtube.js
```

Each step is idempotent — checks for existing output before processing. The pipeline can be partially complete (a video can have .wav.srt but no .canary.diarized.srt yet). Scripts are designed for incremental processing, not all-or-nothing.

### Key Scripts by Pipeline Step

| Step | Script | What it does |
|------|--------|-------------|
| 0 | `rclone` (in run_pipeline.sh) | Sync .canary.diarized.srt from Google Drive |
| 1 | `fetch.js` | Download videos via yt-dlp (Brave cookies for anti-bot) |
| 2 | `convert_to_wav.js` | MP3 → 16kHz mono PCM 16-bit WAV |
| 3 | `generate_whisper_prompt.js` | LLM keyword extraction (LM Studio localhost:1234, qwen2.5-7b) |
| 4 | `transcribe.js` | Whisper.cpp transcription (Metal GPU, hardcoded binary path) |
| 5 | `transcribe_diarized.js` | pyannote speaker diarization (MPS/Metal) |
| 6 | `diarize_canary.py` | Cloud pyannote diarization (Colab T4 GPU) |
| 7 | `summarize_gemini.js` | Gemini summarization (Vertex AI) |
| 8 | `generate_article_gemini.js` | Two-phase article generation (Vertex AI) |
| 9 | `prepare_rag_combined.js` | RAG chunking (semantic + speaker-aware) |
| 10 | `screenshot_youtube.js` | Extract frames at article timestamps |
| 11 | `import_to_vertex.js` | Upload RAG JSONL to Vertex AI Agent Builder |

### Two-Phase Article Generation (generate_article_gemini.js)

The most complex script. Phase 1 creates a semantic outline splitting the podcast into 35-45min thematic iterations. Phase 2 writes detailed journalistic sections per iteration. Both output JSON. Raw API responses saved in `*_raw/` dirs for recovery.

- Multi-region Vertex AI rotation (9 regions) to bypass 429 rate limits
- JSON repair pipeline: control chars → malformed objects → truncated responses
- Round-robin batch: newest videos per channel first
- Partial save on error — resumes from last completed iteration

### Storage Architecture

Multi-disk support via symlinks. `storage/output/` is a real directory containing symlinked channel directories:
```
storage/output/domovina_tv → /Volumes/DOMOVINA1TB/.../domovina_tv
```
Configured in `storage.conf` (key=value, bash 3 compatible — macOS has bash 3.x). Created by `setup_storage.sh`.

**Symlink gotchas** (applies to ALL directory-scanning code):
- Node.js `fs.readdirSync` with `{ withFileTypes: true }` returns `isDirectory()=false` for symlinks. Must use `(entry.isDirectory() || entry.isSymbolicLink())`.
- `fs.statSync()` follows symlinks and works correctly (used by `count_progress.js`).
- rclone requires `-L` (`--copy-links`) flag to traverse symlinked channel directories.

## Code Patterns & Gotchas

### No Shared Module — Utilities Are Copy-Pasted

Each script is standalone. Common functions are duplicated across 6-8 files, NOT imported from a shared module:
- `sanitizeDescription()` — lowercases, strips diacritics (č→c, ž→z), replaces non-alnum with underscores
- `extractVideoId()` — extracts 11-char YouTube ID from `_yt_XXXXXXXXXXX` pattern
- `extractDataFromLine()` — parses `DATE|TITLE|URL` pipe-delimited channel list format
- `loadState()` / `saveState()` — three-tier state: `completed[]`, `failed[]`, `private[]`
- `timeToSeconds()` / `timestampToSeconds()` — same logic, inconsistent naming across scripts

**When fixing a bug in any of these, grep for the function name and fix in ALL copies.**

### CLI Argument Parsing (Two Patterns)

**Pattern A** (older scripts: fetch.js, convert_to_wav.js, transcribe.js):
```javascript
const args = process.argv.slice(2);
const idx = args.indexOf("--output-dir");
const outputDir = idx !== -1 ? args[idx + 1] : DEFAULT;
```

**Pattern B** (newer scripts: prepare_rag_*.js, generate_article_gemini.js, inspect_pipeline.js):
```javascript
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
```
Prefer Pattern B for new code.

### Three-Tier State Management (fetch.js)

Videos have three permanent states, tracked in `*-state.json`:
- `completed[]` — successfully processed, skip on rerun
- `failed[]` — error occurred, will retry on next run
- `private[]` — video unavailable/private, **never retry** (permanent exclusion)

State filename derives from list filename: `domovina_tv-lista.txt` → `domovina_tv-state.json`.

### Channel List Format (automatic/podcasts/*.txt)

```
YYYYMMDD|Naziv Epizode|https://youtu.be/VIDEO_ID
NA|Bez datuma|https://www.youtube.com/watch?v=VIDEO_ID
```
Lines starting with `#` are comments. Empty lines skipped. Parsed by `extractDataFromLine()`.

`automatic/refresh_podcasts.sh` discovers new videos via:
```bash
yt-dlp --flat-playlist --match-filter "duration > 901" --break-on-existing
```
Uses `--download-archive` to avoid re-fetching. Min duration 15:01 filters out shorts/clips.

### Rate Limiting (Differs Per Script)

| Script | Strategy |
|--------|----------|
| `fetch.js` | Consecutive error threshold (3 errors → 60s cooldown), 3s between downloads |
| `summarize_gemini.js` | Exponential backoff + 9-region rotation, 2s between requests |
| `generate_article_gemini.js` | Same as summarize + JSON truncation recovery |
| `screenshot_youtube.js` | 2s fixed delay between videos |

Gemini token refresh: cached 50 minutes (token lasts 60min), auto-refresh via `gcloud auth print-access-token`.

### SRT Parsing Conventions

- Split by double newline (`/\n\n+/`): index line, timestamp line, text lines
- Timestamps: `HH:MM:SS,mmm` (comma) or `HH:MM:SS.mmm` (period) — both exist, scripts normalize
- Speaker annotations: `[SPEAKER_00] Text of speech` — regex: `/^\[(\w+)\]\s*/`
- Speaker names are replaced (SPEAKER_00 → real names) by article/RAG scripts using context from summaries

### Blocked Content Handling

Gemini `PROHIBITED_CONTENT` responses create permanent marker files:
- `.canary.summary.blocked.json` — summary was blocked
- `.canary.diarized.blocked.json` — article was blocked

These are **never retried**. `count_progress.js` tracks them separately. `discoverPendingFiles()` skips files with `.blocked.json` markers.

### RAG Chunking Constants

```javascript
const DEFAULT_CHUNK_TARGET_CHARS = 2000;  // ~500 tokens for Croatian (1 token ≈ 4 chars)
const MIN_CHUNK_CHARS = 400;              // Merge with previous if smaller
const MAX_CHUNK_CHARS = 5000;             // Safety limit
```

Three RAG strategies: `prepare_rag.js` (speaker-aware fixed-size), `prepare_rag_import.js` (outline chapter boundaries), `prepare_rag_combined.js` (hybrid — recommended).

### File Naming Convention

All files for one video share a basename:
```
{YYYYMMDD}_{sanitized_title}_yt_{youtube_id}.wav.canary.diarized.srt
{basename}_{date}_{model}.outline.json
{basename}_{date}_{model}.article.json
{basename}_{date}_{model}_raw/faza1_outline.raw.txt
{basename}_{date}_{model}_raw/faza2_iteracija_N.raw.txt
{basename}.canary.summary.json
{basename}.rag_combined.jsonl
```

Suffix matching order matters (in `count_progress.js`): longer/more specific suffixes must be checked FIRST, e.g. `.canary.diarized.srt` before `.srt`.

### Hardcoded Paths (Machine-Specific)

These paths exist in script source and require local setup:
- Whisper binary: `/Users/ms/git/ggml-org/whisper.cpp/build/bin/whisper-cli`
- Whisper model: `/Users/ms/git/ggml-org/whisper.cpp/models/ggml-large-v3-turbo.bin`
- LM Studio: `http://localhost:1234/v1/chat/completions` (qwen2.5-7b-instruct)
- Brave cookies: `--cookies-from-browser brave` (macOS specific)

### Shell Script Compatibility

`setup_storage.sh` and `refresh_podcasts.sh` use bash 3-compatible syntax (no associative arrays, no `mapfile`) because macOS ships with bash 3.x. Uses newline-separated strings and parameter expansion (`${var%%|*}`, `${var#*|}`) instead.

## Key Conventions

- **Language**: All code comments, log messages, system prompts, and generated content are in Croatian
- **API**: Vertex AI with OAuth (`gcloud auth print-access-token`), not API keys. Project configured in `gemini.conf`
- **Model**: `gemini-2.5-flash` with `maxOutputTokens: 65536` and `responseMimeType: "application/json"`
- **No external test deps**: Tests use `node:test` and `node:assert/strict` (Node.js built-in)
- **Scripts are standalone**: No build step, no bundler, no shared module imports between pipeline scripts
