# Ad-hoc obrada videa s postojećom transkripcijom

Cookbook za ručno provođenje videa kroz pipeline-korake 6-12 kad već postoji Canary transkripcija (`.wav.canary.srt`), bez čekanja na noćni `nightly_pipeline.sh`.

**Use case**: jedan video se hitno mora pojaviti na `https://domovina.ai/v/{VIDEO_ID}` (npr. ručno testiranje, gost u medijima, editorial highlight, debug noćnog pipeline-a koji je preskočio video).

**Što ovaj cookbook NE pokriva**:
- Korake 1-5 (fetch, WAV, whisper prompt, transcribe) — to radi Colab G4 + `transcribe_canary.py`
- `import_to_vertex.js` (korak 11) — za MCP/`mcp.domovina.ai`, traži docker/gcloud setup
- Engleska translacija (vidi `translate_to_english.js` — opcionalni post-step nakon Magisterium koraka)

---

## Pretpostavke i imenovanje

```
basename = {YYYYMMDD}_{sanitized_title}_yt_{VIDEO_ID}
channel  = npr. mladi_za_domovinu
dir      = storage/output/{channel}/
```

**Preduvjeti na disku** prije početka:
- `{basename}.wav`
- `{basename}.wav.canary.srt`
- `{basename}.info.json` (od `yt-dlp`)
- `{basename}.description`, `{basename}.png`, `{basename}.og-share.jpg`, `{basename}.mp4`/`.mkv` (idealno svi, jer ih CDN/Flutter app očekuje)

Ako bilo što fali, prvo pokreni `./run_pipeline.sh --only-fetch` ili Colab notebook `colab_canary/domovina_tv_canary_transcribe.ipynb`.

---

## Korak 1 — Diarizacija (STRIKTAN preduvjet za sve AI korake)

```bash
export HF_TOKEN=hf_xxx  # https://huggingface.co/settings/tokens
                        # nakon "Accept terms" na pyannote/speaker-diarization-community-1

python3 colab_diarize/diarize_canary.py \
  --input-dir storage/output/{channel} \
  --file storage/output/{channel}/{basename}.wav \
  --hf-token $HF_TOKEN
```

**Output**: `{basename}.wav.canary.diarized.srt` (~2-5 min na M4 Pro za 50-min audio; MPS acceleration; clustering je CPU-bound — Colab G4 nije brži, vidi `docs/diarization_research_2026-05.md`)

**Zašto preduvjet**: koraci 7-12 očekuju `[SPEAKER_XX]` oznake u SRT-u. `prepare_rag_combined.js` je speaker-aware; bez diarizacije RAG chunkovi nemaju atribuciju, što kvari MCP retrieval po govorniku.

---

## Korak 2 — Summary JSON

**Opcija A — Gemini deterministic (default)**:
```bash
node summarize_gemini.js --input-dir storage/output --video-id {VIDEO_ID}
```

**Opcija B — Manualno u Claude chatu (Opus 4.7) za editorialnu kvalitetu** (Magisterium MCP cross-check, ručno izabrani naslov, narativno strukturiran abstract):
1. Pročitaj `{basename}.wav.canary.diarized.srt`
2. Generiraj JSON po schemi iz `summarize_gemini.js:143-180`
3. Spremi kao **točno** `{basename}.wav.canary.summary.json`

**⚠️ Kritično — filename**: MORA biti `.wav.canary.summary.json` (NE samo `.canary.summary.json`). `generate_channel_index.js:197` traži taj točan sufiks, inače novi video se neće registrirati s naslovom/abstractom u channel manifestu.

**Schema (must-have polja)**:
```json
{
  "version": "1.0",
  "generated_at": "ISO-8601",
  "model": "...",
  "source": { "filename", "channel", "youtube_id", "title", "upload_date", "duration_seconds" },
  "summary": {
    "title_hr": "...",
    "abstract_hr": "...",
    "key_topics": [],
    "speakers": [{"id":"SPEAKER_00","suggested_name":"...","role":"..."}],
    "key_points": [],
    "mentioned_people": [], "mentioned_places": [], "mentioned_organizations": [],
    "language": "hr", "content_type": "podcast", "sentiment": "..."
  }
}
```

---

## Korak 3 — Outline + Article JSON

**Opcija A — Gemini**:
```bash
node generate_article_gemini.js --input-dir storage/output --video-id {VIDEO_ID}
```

**Opcija B — Manualno u Claude chatu**: pročitaj diarized SRT, slijedi schema iz `generate_article_gemini.js:111-145` (Faza 1 outline → Faza 2 article).

**⚠️ Kritično — filename**:
```
{basename}.wav.canary.diarized_{YYYY-MM-DD}_{model-id}.outline.json
{basename}.wav.canary.diarized_{YYYY-MM-DD}_{model-id}.article.json
```

Bez `.wav.canary.diarized` infiksa, `prepare_rag_combined.js:409,414` neće naći outline/article (traži `startsWith(srtBase + "_")` gdje je `srtBase = srtFile.replace(/\.srt$/, "")`).

**⚠️ Dedup gotcha**: pipeline bira leksikografski najveći `{date}_{model}.article.json`. `claude-opus-4-7` < `gemini-2.5-flash` (`c` < `g`), pa ako kasnije nightly pipeline regenerira Gemini varijantu istog datuma, **prepisat će manualnu Opus obradu**. Workaround: koristi datum dan kasnije (`2026-05-27` umjesto `2026-05-26`), preimenuj model u nešto što počinje slovom > `g` (npr. `z-claude-opus-4-7`), ili arhiviraj prije pipeline rerun-a.

---

## Korak 3.5 — Magisterium MCP enrichment (preporučeno za Pro subscribere)

Generira `article.magisterium.json` s teološkom procjenom svake sekcije (score 0-100, assessment, concerns, enrichment, citations iz Katekizma/enciklika/Drugog vatikanskog sabora). Channel manifest pokupi `has_magisterium: true` + `magisterium_score` koje Flutter app renderira na video stranici.

**⛔ KRITIČNO — koristi MCP, NIKADA API ključeve**:
- `magisterium.com` Pro subscription uključuje **unlimited MCP pristup** (Claude tool `mcp__claude_ai_Magisterium_AI__chat`), rate-limit 15 req/min
- API ključevi (`MAGISTERIUM_API_KEY*` u `.env`) su **odvojen, vrlo skup** plan (per-token billing)
- **NE pokretati** `node enrich_magisterium.js` ili `enrich_magisterium_full.js` — koriste API ključeve i generiraju stvaran trošak
- Memory pravilo: [`magisterium-mcp-only-never-api-keys`](../~/.claude/.../memory/magisterium_mcp_only_never_api_keys.md)

**Workflow** — sekvencijalno, po jedan MCP poziv za svaku sekciju iz `article.json`:

```python
# Pseudo-flow (manualno u Claude chatu):
for iteration in article['iterations']:
    for section in iteration['sections']:
        prompt = f"""Sekcija: {section['subtitle']}
Kontekst: {section['content'][:600]}

Procijeni teološku usklađenost s katoličkim naukom.
Vrati ISKLJUČIVO JSON: {{"score": <0-100>, "assessment": "<1-2 rečenice hr>", "concerns": [], "enrichment": "<2-3 rečenice>"}}"""
        
        # MCP call (sekvencijalno, ~4s pauza između = ispod 15 req/min)
        response = magisterium_mcp_chat(prompt)
        # Spremi response (score, assessment, concerns, enrichment, citations iz response references)
```

**⚠️ Paralelni batch pozivi failau** — empirijski iznad ~2 paralelna `chat` poziva MCP vraća errore (rate limit zaštita). Sekvencijalno je obavezno.

**⚠️ Heredoc trap u shell** — ako spremaš JSON odgovore preko `cat > X.json << 'EOF'` u jednoj komandi za više fajlova, **NE koristi istu EOF oznaku** za vanjski i unutarnji heredoc (bash ne ugnijezdi, sve siše u prvi). Koristi `Write` tool ili pojedinačne komande.

**Schema** koju treba proizvesti (kompatibilno s `enrich_magisterium.js`):

```json
{
  "version": "1.0",
  "generated_at": "ISO-8601",
  "model": "magisterium-1-mcp-via-claude-opus-4-7",
  "source_article": "<basename>.wav.canary.diarized_..._article.json",
  "overall_score": 96,
  "score_interpretation": "Aktivno promiče katolički nauk",
  "score_breakdown": [
    {"iteration": 1, "theme": "...", "score": 94}
  ],
  "total_concerns": 7,
  "iterations": [
    {
      "iteration_number": 1, "start_time": "...", "end_time": "...",
      "theme": "...", "iteration_score": 94,
      "sections": [
        {
          "subtitle": "...", "screenshot_timestamp": "...",
          "screenshot_description": "...", "content": "...",
          "keywords": [], "entities": [],
          "magisterium": {
            "score": 95,
            "assessment": "1-2 rečenice na hrvatskom",
            "concerns": ["..."],
            "enrichment": "2-3 rečenice teološkog konteksta",
            "citations": [
              {"document_title": "Catechism of the Catholic Church", "document_reference": "1374"}
            ]
          }
        }
      ]
    }
  ]
}
```

**⚠️ Filename**: `{basename}.wav.canary.diarized_{date}_{model}.article.magisterium.json` — paralelno s `article.json` istog modela.

**Score interpretacija**:
- 90-100: Aktivno promiče katolički nauk
- 70-89: Uglavnom usklađeno
- 50-69: Djelomično usklađeno, nejasnoće
- 30-49: Odstupanje od crkvenog nauka
- 0-29: Proturječi katoličkom nauku

## Korak 4 — RAG chunking

```bash
node prepare_rag_combined.js --input-dir storage/output --video-id {VIDEO_ID}
```

**Output**: `{basename}.rag_combined.jsonl` (~50 chunkova: topic + summary, speaker-aware)

---

## Korak 5 — Screenshots

### 5a. Default (ako YouTube radi — rijetko zbog anti-bot blokova)

```bash
node screenshot_youtube.js --input-dir storage/output --video-id {VIDEO_ID}
```

### 5b. Fallback — lokalni `mkv`/`mp4` + ffmpeg

Kad `yt-dlp` vrati `Sign in to confirm you're not a bot`, koristi lokalnu video datoteku (po memory `pipeline_anti_bot_silent_continue.md` pipeline tiho nastavlja s 0 screenshotova — provjeri log).

```bash
cd storage/output/{channel}
BASE="{basename}"
ARTICLE="${BASE}.wav.canary.diarized_{date}_{model}.article.json"
SSDIR="${BASE}_screenshots"
VIDEO="${BASE}.mkv"   # ili .mp4 ako nemaš mkv

mkdir -p "$SSDIR"
python3 << EOF
import json, os, subprocess
d = json.load(open("$ARTICLE"))
ss = []
ok = fail = 0
for it in d['iterations']:
    for s in it['sections']:
        ts = s['screenshot_timestamp']
        sanitized = ts.replace(':', '-')
        out = f"$SSDIR/${BASE}_{sanitized}.png"
        ss.append({
            "timestamp": ts,
            "filename": f"${BASE}_{sanitized}.png",
            "description": s['screenshot_description'],
            "section_subtitle": s['subtitle'],
            "iteration": it['iteration_number']
        })
        r = subprocess.run(
            ["ffmpeg","-ss",ts,"-i","$VIDEO","-frames:v","1","-update","1","-q:v","1","-y",out],
            capture_output=True
        )
        if r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 1000:
            print(f"  OK {ts} — {s['subtitle'][:50]}"); ok += 1
        else:
            print(f"  FAIL {ts}"); fail += 1

json.dump({
    "video_id": "{VIDEO_ID}",
    "video_base": "$BASE",
    "article_file": "$ARTICLE",
    "generated_at": "$(date -u +%FT%TZ)",
    "source": "local_mkv_ffmpeg_extract (yt-dlp anti-bot blocked)",
    "screenshots": ss
}, open(f"$SSDIR/_manifest.json","w"), indent=2, ensure_ascii=False)
print(f"\\n{len(ss)} total, ok={ok}, fail={fail}")
EOF
```

**Napomena o kvaliteti**: lokalni `.mkv`/`.mp4` koje `fetch.js` skida obično su 360p — niži res nego YouTube 1080p stream. Za editorial highlight (kanal `domovina_tv` glavni feed) razmisli o regetu višeg formata; za batch nightly pipeline 360p je prihvatljivo.

---

## Korak 6 — Og-sections (per-section social slike, Tier B)

```bash
python3 generate_og_sections.py --input-dir storage/output --channel {channel}
```

Idempotent — preskače već postojeće. Reuse-a PNG-ove iz koraka 5.

**Output**: `{basename}.og-sections/og-t-{section_id}.jpg` + `og-sections.json` manifest

---

## Korak 6.5 — Engleski prijevod bez halucinacija (opcionalno)

Generira paralelne `.en.json` artefakte (`summary.en.json`, `article.en.json`, `article.magisterium.en.json`) za engleske čitatelje. Koristi Vertex AI Gemini 2.5 Flash sa `temperature=0` i strogim "literal translator" prompt-om.

```bash
set -a; source .env; set +a
node translate_to_english.js --input-dir storage/output --video-id {VIDEO_ID}
```

**No-halucinacija safeguards**:
- `temperature: 0` (deterministic)
- Eksplicitan prompt zabranjuje paraphrazu, embelishment i izostavljanje
- Per-field translation (ne cijeli JSON odjednom) — manji chunk = bolja vjernost
- Croatian proper names ostaju isti (Brčina, Antunovski hod, Sveti Duh)
- Standardni katolički termini se mapiraju na engleski (euharistija→Eucharist, klanjanje→Eucharistic adoration, krunica→Rosary, ispovijed→confession)
- Markdown formatting, citati i timestampi preservirani

**Filename**: `{basename}.wav.canary.diarized_{date}_{model}.article.en.json` (paralelno s originalom).

## Korak 7 — Channel index regeneracija

```bash
node generate_channel_index.js
```

Skenira `storage/output/*/` i regenerira:
- `storage/meta/channels/data/{channel}.json` (per-channel video list)
- `storage/meta/channels/data/index.json` (svi kanali)
- `storage/meta/channels/data/index_bundle.json` (cached bundle za brži app load)

**Ako ovo preskočiš**, video će postojati na CDN-u (`data/{VIDEO_ID}/*`) ali se NEĆE pojaviti u Flutter app-u jer channel manifest neće znati za njega.

---

## Korak 8 — R2 upload

```bash
set -a; source .env; set +a  # učitaj R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY

# A) Video artefakti — uploadi na images/{VIDEO_ID}/* i data/{VIDEO_ID}/*
node upload_to_r2.js --input-dir storage/output --video-id {VIDEO_ID}

# B) Meta (KRITIČAN — bez ovoga video se NE pojavljuje u app-u!)
node upload_to_r2.js --meta-dir storage/meta
```

**Upload mapping** (vidi `upload_to_r2.js:412-466` za pun popis):
| Local | R2 key |
|---|---|
| `{basename}.wav.canary.summary.json` | `data/{VIDEO_ID}/summary.json` |
| `{basename}.wav.canary.diarized_..._article.json` | `data/{VIDEO_ID}/article.json` |
| `{basename}.wav.canary.diarized_..._outline.json` | `data/{VIDEO_ID}/outline.json` |
| `{basename}.wav.canary.diarized.srt` | `data/{VIDEO_ID}/diarized.srt` |
| `{basename}.wav.canary.diarized_..._article.magisterium.json` | `data/{VIDEO_ID}/article.magisterium.json` |
| `{basename}.wav.canary.diarized_..._summary.en.json` | `data/{VIDEO_ID}/summary.en.json` |
| `{basename}.wav.canary.diarized_..._article.en.json` | `data/{VIDEO_ID}/article.en.json` |
| `{basename}.wav.canary.diarized_..._article.magisterium.en.json` | `data/{VIDEO_ID}/article.magisterium.en.json` |
| `{basename}.info.json` | `data/{VIDEO_ID}/info.json` |
| `{basename}.mp4` | `data/{VIDEO_ID}/video.mp4` |
| `{basename}.png` | `images/{VIDEO_ID}/thumbnail.png` |
| `{basename}.og-share.jpg` | `images/{VIDEO_ID}/og-share.jpg` |
| `{basename}_screenshots/{...HH-MM-SS}.png` | `images/{VIDEO_ID}/screenshots/{HH-MM-SS}.png` |
| `{basename}.og-sections/og-t-{N}.jpg` | `images/{VIDEO_ID}/og-t-{N}.jpg` |
| `storage/meta/channels/data/{channel}.json` | `channels/data/{channel}.json` |

---

## Korak 9 — Verifikacija

```bash
VID={VIDEO_ID}; CHAN={channel}
for p in data/$VID/summary.json data/$VID/article.json data/$VID/outline.json \
         data/$VID/diarized.srt data/$VID/info.json data/$VID/video.mp4 \
         images/$VID/thumbnail.png images/$VID/og-share.jpg \
         channels/data/$CHAN.json; do
  curl -s -o /dev/null -w "%{http_code}  $p\n" "https://cdn.domovina.ai/$p"
done
```

Svi moraju biti **200**. Verificiraj **GET-om, ne HEAD-om** — Cloudflare CDN cache-ira 404 odgovore 4h, pa HEAD može vratiti 200 a GET stari cached 404 (memory `cloudflare_cdn_caches_404s.md`).

**Ako bilo koji 404 nakon uploada**: CF Dashboard → Caching → Purge Everything (CDN-wide) ili Purge by URL (selective).

---

## Korak 10 — Otvori u browseru

```
https://domovina.ai/v/{VIDEO_ID}
```

Flutter app će:
1. Učitati `channels/data/{channel}.json` da nađe video u listi
2. Dohvatiti `data/{VIDEO_ID}/summary.json` za naslov, abstract, topics, speakers
3. Dohvatiti `data/{VIDEO_ID}/article.json` za renderiranje sekcija
4. Lazy-loadati `images/{VIDEO_ID}/screenshots/{HH-MM-SS}.png` po sekciji
5. (Opcijski, kod social-share) `images/{VIDEO_ID}/og-t-{N}.jpg`

---

## Quickstart skripta (sve odjednom)

Za eksperte koji znaju da svi koraci rade:

```bash
#!/usr/bin/env bash
set -euo pipefail
VID=$1                          # npr. 6ueR_Leq6uE
CHAN=$2                         # npr. mladi_za_domovinu
DATE=$(date -u +%F)
MODEL=${MODEL:-gemini-2.5-flash} # ili z-claude-opus-4-7 za manualnu obradu

BASE=$(ls storage/output/$CHAN/*_yt_${VID}.wav 2>/dev/null | head -1 | xargs basename | sed 's/\.wav$//')
test -n "$BASE" || { echo "WAV ne postoji za $VID"; exit 1; }

# 1. Diarizacija
python3 colab_diarize/diarize_canary.py \
  --input-dir storage/output/$CHAN \
  --file storage/output/$CHAN/$BASE.wav \
  --hf-token $HF_TOKEN

# 2-3. Summary + Article (Gemini)
node summarize_gemini.js --input-dir storage/output --video-id $VID
node generate_article_gemini.js --input-dir storage/output --video-id $VID

# 3.5. Magisterium MCP enrichment — RUČNO U CLAUDE CHATU, NIKAD enrich_magisterium*.js
# (skripta postoji ali koristi skupe API ključeve; MCP je free pod Pro subscriptionom)

# 4. RAG
node prepare_rag_combined.js --input-dir storage/output --video-id $VID

# 5. Screenshots (prvo proba yt-dlp, ako anti-bot pad → koristi 5b fallback ručno)
node screenshot_youtube.js --input-dir storage/output --video-id $VID || \
  echo "⚠️ Anti-bot blok — pokreni Korak 5b iz cookbook-a ručno"

# 6. og-sections
python3 generate_og_sections.py --input-dir storage/output --channel $CHAN

# 6.5. Engleski prijevod (opcionalno)
node translate_to_english.js --input-dir storage/output --video-id $VID

# 7. Channel index
node generate_channel_index.js

# 8. Upload
set -a; source .env; set +a
node upload_to_r2.js --input-dir storage/output --video-id $VID
node upload_to_r2.js --meta-dir storage/meta

# 9. Verify
for p in data/$VID/summary.json data/$VID/article.json data/$VID/diarized.srt \
         images/$VID/thumbnail.png channels/data/$CHAN.json; do
  curl -s -o /dev/null -w "%{http_code}  $p\n" "https://cdn.domovina.ai/$p"
done

echo "✅ https://domovina.ai/v/$VID"
```

---

## Tri značajne gotchae (memory-tracked)

1. **`yt-dlp` anti-bot za screenshots** (`pipeline_anti_bot_silent_continue.md`) → fallback na lokalni mkv ffmpeg (Korak 5b). Pipeline ne aborta — exit 0 i "PIPELINE ZAVRŠEN" znače samo da je skripta završila, ne da je rad obavljen. Uvijek grep log za `ABORT`/`Sign in to confirm`.

2. **CDN cache-ira 404** 4h (`cloudflare_cdn_caches_404s.md`) → CF dashboard Purge Everything nakon prvog uploada, verificiraj GET-om (ne HEAD-om).

3. **Manualni Opus output može biti prepisan Gemini varijantom** zbog leksikografskog dedup-a (`article_json_dedup_latest_per_video.md`) → koristi datum dan kasnije ili `z-` prefix u model ID-u.

---

## Reference

- **Pipeline orchestrator**: `run_pipeline.sh`
- **Nightly automation**: `automatic/nightly_pipeline.sh` + launchd `tv.domovina.fetch.nightly`
- **Diarization research**: `docs/diarization_research_2026-05.md`
- **Data contract** za consumer stack (Flutter, MCP): `docs/data_contract.md`
- **Pripadajući pipeline koraci**:
  - `colab_diarize/diarize_canary.py` (korak 6)
  - `summarize_gemini.js` (korak 7)
  - `generate_article_gemini.js` (korak 8)
  - `prepare_rag_combined.js` (korak 9)
  - `screenshot_youtube.js` (korak 10)
  - `generate_og_sections.py` (korak 9.6, Tier B)
  - `generate_channel_index.js` (korak 11.5, meta)
  - `upload_to_r2.js` (korak 12)
