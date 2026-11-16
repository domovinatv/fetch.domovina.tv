# KORAK 2.9: Opus ispravak Canary prijepisa — plan implementacije (16.11.2026.)

**Odluka korisnika (16.11.):** uvesti u pipeline (nightly + Tier 2 bridge) od nightlyja 17.11.,
i reobraditi epizode s Canary rezerve od 15. i 16.11. da se vidi da sve radi. **Na disku ostaju
OBA prijepisa (izvorni Canary i dorađeni) i OBA idu na CDN.**

Mjerenje koje je dovelo do odluke: [`2026-11-16-ep11-soniox-vs-canary.md`](./2026-11-16-ep11-soniox-vs-canary.md)
§ „Opus 5.5 ispravlja Canary tekst” — 191 → 120 grešaka protiv 4 neovisne reference, 92 ispravljeno,
21 novih (dio lektura), govornici 99,77 → 99,82 %. Prototip: `experiments/2026-11-16-ep11-opus-ispravak/`.

## Datoteke

| Što | Disk | CDN |
|---|---|---|
| izvorni Canary+pyannote (kopija kanonskog prije ispravka) | `{base}.diarized.asr.srt` | `data/{id}/diarized.asr.srt` |
| izvorni words | `{base}.words.asr.json` | `data/{id}/words.asr.json` |
| ispravljeni = KANONSKI (svi koraci 7+ ga koriste) | `{base}.wav.canary.diarized.srt` | `data/{id}/diarized.srt` |
| ispravljeni words | `{base}.words.json` | `data/{id}/words.json` |
| provenance (model, effort, tokeni, promijenjeni cue-ovi, govornici) | `{base}.transcript_fix.json` | `data/{id}/transcript_fix.json` |

Imena su provjerena: `.diarized.asr.srt` NE završava na `.canary.diarized.srt` (regexi u
`prepare_rag_import.js`, `generate_article_gemini.js` ga ne hvataju); `.words.asr.json` NE
prolazi `upload_to_r2.js` filtar `.words.json` (traži točno `${videoBase}.words.json`), pa treba
eksplicitno dodati.

## Nova skripta `fix_transcript_opus.js` (KORAK 2.9)

- Argumenti (Pattern B): `--input-dir`, `--channel`, `--video-id`, `--limit` (30), `--fresh-days`
  (3; pravilo #4, samo naprijed; fast-path 0), `--dry-run`, `--force`.
- **Kandidat (proširenje 16.11., korisnik: „maksimalno otporan fallback u svim smjerovima”):**
  svaki kanonski `{base}.wav.canary.diarized.srt` čiji `canonical.origin` (`lib/processing_manifest.js`
  `buildManifest`) NE počinje sa `soniox` — dakle Canary rezerva (`canary+pyannote_modal`,
  `canary_solo`) **i Speechmatics** (`speechmatics…`, Tier 2 primarni i fallback kad Soniox nema
  kredita). Soniox se ne dira (najtočniji, 12 grešaka; Opus bi dodao lekturu). Provjeri stvarne
  vrijednosti `origin` za Speechmatics put u manifestu prije pisanja uvjeta.
  Mjerenje: Speechmatics 282 sadržajne greške (najlošiji), Canary 192 → najveća korist je baš tamo.
  `transcript_fix.json` bilježi `source_origin`.
  Preskoči ako `{base}.transcript_fix.json` postoji (osim `--force`).
- Ulaz UVIJEK izvorni: ako nema `.diarized.asr.srt`, prvo `copyFile` kanonski → `.asr.srt`;
  s `--force` čitaj `.asr.srt`, nikad već ispravljeni.
- Postavke kanala: `gate().checkStep({ key: "transcript_subtitles", filePath })` (`lib/channel_settings.js`).
- Claude prozor: `claudeWindowClosed()` iz `lib/claude_window.js` → `⏸️ [ODGOĐENO]`, kao 7+8.
- Poziv: kopija `callClaudeCli` iz `generate_article_gemini.js:1199` (`claude -p --model opus
  --output-format json --setting-sources "" --strict-mcp-config --max-turns 1 --tools ""
  --system-prompt …`, cwd `os.tmpdir()/domovina_claude_cli`; **NIKAD `--bare`**). Effort env
  `TRANSCRIPT_FIX_EFFORT` (prijedlog `medium`; prototip je bio subagent, tokeni se mjere u prvim runovima).
- **Komadi po ~100 cue-ova** (~18 min): 3 h epizoda bi u jednom odgovoru prešla izlazni limit.
  Svaki poziv: metapodaci (`title`, `channel`, `description` ≤ 3000 zn., `tags`, `chapters` iz
  `.info.json`), 5 cue-ova prije i poslije kao kontekst „ne mijenjaj”, pa komad u formatu
  `seq [SPEAKER_xx] tekst` (bez vremena). Izlaz isti format.
- Validacija komada: isti skup seq-ova; inače 1 ponovni pokušaj, pa izvorni tekst tog komada
  (`partial: true` u meta).
- **Rezerva samog ispravka (nikad ne blokira epizodu):** Opus (`claude -p`) → ako je Claude prozor
  zatvoren ili poziv padne 2× → agy Gemini tekstualno (`lib/agy_tmux.js` `agyJson()`, isti prompt,
  `TRANSCRIPT_FIX_AGY_MODEL`, default `gemini-4-hydrogen-medium`) → ako ni to ne uspije, izvorni ostaje
  kanonski i koraci 7+ idu dalje (non-fatal, bez `transcript_fix.json`, pa idući run pokuša opet
  unutar `--fresh-days`). `transcript_fix.json` `backend` = `claude:opus` / `agy:<model>`.
- Vremena: iz izvornog SRT-a po seq-u (kao `experiments/2026-11-16-ep11-opus-ispravak/sastavi.py`).
- Meta `{base}.transcript_fix.json`: model, effort, at, chunks, cues, changed_cues,
  speaker_changes, usage zbroj (input/cache/output), cost_usd iz envelopea.

### System prompt (pooštren nakon prototipa)

Prototip je uveo lekturu („nervni” → „živčani”, dodano „drago”, „s odgovornošću”). Pravila:
ispravljaj samo vjerojatne ASR greške (fonetski zapisi, krivi oblici bez smisla, rastavljene/spojene
riječi, imena i strani pojmovi iz metapodataka/općeg znanja, interpunkcija, „itd.”); **ne mijenjaj
riječ koja postoji i ima smisla**, ne zamjenjuj sinonime ni dijalekt/žargon standardom, ne dodaji
riječi osim imena iz metapodataka kad je predstavljanje očito progutano, ne briši poštapalice;
oznaku govornika mijenjaj samo na mrvicama od 1–3 riječi koje su očito druge osobe; riječ u
susjedni cue samo kad je rečenica presječena. Puni tekst uputa subagenta: transkript sesije
16.11. (`experiments/2026-11-16-ep11-opus-ispravak/` README ga treba sadržavati).

## Izmjene postojećeg koda

1. `generate_words_json.js` `main()` (red ~296): tijelo nakon `sources` izvući u funkciju i
   pozvati za dvije varijante: kanonski (`.words.json`/`.words.skipped.json`) i, ako postoji
   `{base}.diarized.asr.srt`, izvorni (`.words.asr.json`/`.words.asr.skipped.json`).
2. `upload_to_r2.js`: `UPLOAD_SUFFIXES` + `".diarized.asr.srt"`, `".words.asr.json"`,
   `".transcript_fix.json"`; filtar točnog imena kao za `.diarized.en.srt` (red ~690);
   `getFlutterKey` grane → `data/{id}/diarized.asr.srt`, `words.asr.json`, `transcript_fix.json`.
   Paziti: `".words.json"` grana se ne smije poklopiti s `.words.asr.json` (već ne).
3. `lib/processing_manifest.js` (`buildManifest`, red ~89): uz `canonical.origin` dodati
   `transcript_fix` (model, at) kad postoji `{base}.transcript_fix.json`.
4. `run_pipeline.sh`: novi blok odmah iza KORAKA 2.8 (red ~1288, nakon `fi` „Preskačem KORAK
   2.8”), s `"${PRIORITY_SCOPE_ARGS[@]}"` (memorija: novi korak MORA dobiti scope, inače
   prioritetni run skenira cijeli katalog), `--fresh-days 0` na fast-pathu, `--dry-run`
   prosljeđivanje, non-fatal. Flag `--no-transcript-fix` + env `TRANSCRIPT_FIX=0` gasi.
   Default ON (nightly i bridge, jer bridge zove `run_pipeline.sh`).
5. `build_episode_bundle.js` (12.7) lista `data/{id}/`, pa nove datoteke uđu same — provjeriti.
6. Report (`tools/nightly_step_report/build.py`): stupac/red za 2.9 (tokeni) — opcionalno.
7. Testovi `node --test` za validaciju komada i sastavljanje (bez poziva Claudea).

## Reobrada 15. i 16.11. (nakon što 1–4 rade)

- Kandidati: Tier 1 iz nightlyja 15.11. (8 ep., `LC_ALL=C grep -a "Canary rezerva" automatic/logs/nightly_2026-11-15.log`)
  i Tier 2 `done` s `asr_provider='canary'` od 15.11. (D1, ~31 ep., `_unlisted`).
- `node fix_transcript_opus.js --video-id <ID> [--channel <kanal>]` po epizodi, pa
  `node generate_words_json.js --video-id <ID> --force`, pa `node force_upload.js --video-id <ID>
  --channel <kanal> --targets …` za `diarized.srt` + `words.json` (immutable `data/` ključevi →
  purge) i običan upload za nove `.asr`/`transcript_fix` datoteke; bundle 12.7 se regenerira.
- Članak/sažetak/RAG se NE regeneriraju (Opus članak je ~430 k tokena/ep; zasebna odluka).
  `segments.jsonl` se sam osvježi po mtimeu.
- **Kvota:** ~40 epizoda × ~60–80 k tokena ≈ 2,5–3,2 M Claude tokena. Prije pokretanja reći
  korisniku i provjeriti 5h/tjedni prozor (`docs/claude_subscription_usage_endpoint` memorija).
  Tier 2 dnevno ≈ 20 × 70 k ≈ 1,4 M tokena dodatno; po potrebi `TRANSCRIPT_FIX_TIER2=0`.

## Otpornost ASR lanca (stanje 16.11., korisnikovo pitanje)

| Kvar | Što se događa |
|---|---|
| Soniox bez kredita (sad) | 2.7b pada na Speechmatics (novi ključ radi) → 2.9 Opus ispravak |
| + Speechmatics bez kredita | `asr_failed.json` → 2.8 Canary rezerva (Modal) → 2.9 Opus ispravak |
| + Modal bez kredita | nema prijepisa: Tier 2 job `failed` („ASR: nema prijepisa”), Tier 1 čeka; Telegram `asr-no-credit` |
| Claude prozor zatvoren / Claude pada | 2.9 → agy Gemini; inače izvorni ostaje kanonski |

Zadnja rupa (svi ASR-ovi bez kredita) nema rezervu u kodu. Kandidat: agy Gemini (Hydrogen/Argon) koji
SLUŠA mp3 (16.11.: Hydrogen 4 27 grešaka, Argon 0 ispusta) za tekst + vremena poravnana na… ništa —
bez ijednog ASR-a nema vremena riječi (Argon SRT kasni do 12 min, `srt_timing.py`). Zasebna odluka.
