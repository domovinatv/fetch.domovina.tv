# words.json — vrijeme po riječi za titl (KORAK 9.87)

**Datum:** 2026-10-06
**Ugovor:** `../domovina.ai/docs/2026-10-06-titlovi-rijec-po-rijec.md` §3
**Kod:** `generate_words_json.js` (+ test), `tools/upload_sponsors_in_video.js --suffix .words.json`,
`upload_to_r2.js` (sufiks + `getFlutterKey`), `run_pipeline.sh` KORAK 9.87,
`modal_canary/canary_modal.py` (`.wav.canary.word_ts.json`), prototip `tools/forced_align_words.py`

## Zaključak

Speechmatics epizode imaju `data/<id>/words.json` na CDN-u (52 od 57). Nightly
ga gradi za svaku novu epizodu s kosturom. Canary katalog (3 326 epizoda) je
**namjerno parkiran**: prototip forced alignmenta radi i izmjeren je, ali puni
backfill se zasad ne radi (odluka 06.10.2026.).

## 1. Speechmatics put (u produkciji)

`generate_words_json.js` je Node port `../domovina.ai/scripts/subtitle-words-reference.py`.
Na svih 57 epizoda daje **identične** `s`/`e`/`w` i `anchored` kao referenca.

Dvije zamke porta, obje oko Pythonovog `round()`:
- `round(x, 2)` zaokružuje točnu binarnu vrijednost (`0.925` → `0.93`), a half-even
  samo za prave izjednačenosti (`0.125` → `0.12`). `Math.round(x*100)/100` griješi u
  oba smjera → `pyRound()`.
- `difflib.SequenceMatcher(autojunk=False)` je portan doslovno (`matchingBlocks`),
  uključujući strogi `>` kod izjednačenja.

Backfill 06.10.2026.:

| | epizoda |
|---|---|
| zapisano + na CDN-u (`immutable`, purge ×2 Vary) | 52 |
| ispod praga 0,6 → `.words.skipped.json` | 5 (`catholic_futurist` 2,6 %, `subclub` 3,0 %, 2× `_unlisted` 24–32 %, `podcast_cuspajz/-_z27sNDZxw` 55,5 %) |
| vrijeme za cijeli katalog | ~1,2 s |

Prije uploada je provjereno da je `data/<id>/diarized.srt` na CDN-u bajt-za-bajt
jednak lokalnom za svih 52 — inače cue-ovi ne bi sjeli i titl ne bi ništa isticao.

**Zašto 9.87, a ne odmah iza 2.8:** kanonski SRT može doći i iz KORAKA 6
(pyannote). `words.json` vrijedi samo za točno onaj SRT koji ide na CDN.

**Zašto nije u `REPAIRABLE_BASENAMES`:** ni `diarized.srt` se ne popravlja
driftom, pa bi popravljen `words.json` uz stari SRT dao nikakvo isticanje. Par
ostaje par. Ručna izmjena: `--force` + `tools/upload_sponsors_in_video.js --suffix .words.json`.

## 2. Canary od sad (forward-only)

`canary_modal.py` sprema `timestamp["word"]` u `{wav}.canary.word_ts.json`
(`{"v":1,"source":"canary","words":[[ms,ms,"riječ"],…]}`) na sva tri puta
(`main`, `from_volume`, `batch`). `generate_words_json.js` ga uzima kao drugi
izvor i bira onaj s više usidrenih riječi. `modal run` (nightly KORAK 2.6) koristi
lokalni kod; deployana app (`modal.Cls.from_name`, bridge) treba `modal deploy`.
Colab `transcribe_canary.py` riječi i dalje baca.

Ime NIJE `.canary.words.json`: završavalo bi na `.words.json` i uploader bi ga
poslao kao `data/<id>/words.json`.

## 3. Forced alignment za stari Canary katalog (PARKIRANO)

`tools/forced_align_words.py`: torchaudio `MMS_FA` (with_star), emisije jednom za
cijelu epizodu u komadima od 30 s na MPS-u, pa `forced_align` po cue-u sa `*`
tokenom na oba ruba. Hrvatski: dijakritike van, `đ → dj`, riječ bez slova → `*`.

Izmjereno na 3 epizode koje imaju i Speechmatics vremena (usporedba početaka riječi):

| epizoda | zvuk | emisije | RTF | ±100 ms | ±250 ms | p50 / p90 |
|---|---|---|---|---|---|---|
| `4cpxioHdQDs` | 20 min | 21 s | 0,018 | 53 % | 96 % | 99 / 147 ms |
| `FaSWndsMVew` | 108 min | 107 s | 0,017 | 78 % | 95 % | 54 / 145 ms |
| `aue1GuuMsbA` | 161 min | 159 s | 0,017 | 77 % | 94 % | 59 / 158 ms |

- Na `4cpxioHdQDs` je odstupanje **sustavno**: FA kasni ~+95 ms (p10/p50/p90
  +56/+93/+134), bez drifta kroz snimku — tipično CTC kašnjenje. Korekcija
  konstantom nije napravljena.
- Model se učita jednom (13 s prvi put, 1,2 GB checkpoint u `~/.cache/torch`).
- Procjena za katalog: 3 162 h zvuka (WAV postoji za svih 3 326) × RTF 0,017 ≈
  **54 h** na Mac Miniju. To vrijedi samo uz jedan proces za sve epizode; s
  procesom po epizodi model load dodaje sate.

Neizmjereno prije eventualnog backfilla:
1. **Collapse epizode.** Prag `--min-score` po cue-u nije kalibriran. Kandidati za
   kalibraciju: `421g3OqK0fc` (`podcast_cuspajz`, „da li" ×129) i `skBC7BYU3CQ`
   (`bozja_pobjeda`). Prvi pokušaj je pao na putanji, ne na prototipu. Na čistim
   epizodama 2,5–3,7 % riječi je u cue-ovima ispod 0,3, što je gornja granica
   onoga što bi takav prag odrezao kod zdravih epizoda.
2. Korekcija pomaka od ~95 ms (izmjeriti na više epizoda).
3. Batch način (jedan proces, model jednom).

## 4. Usput: keys-cache je svaku noć gubio veličine (popravljeno)

`.r2_keys_cache.json` je v2 (`{v:2, sizes:{key:size}}`) da `upload_to_r2.js` vidi
drift disk≠R2 po veličini. `upload_audio_only.js` (KORAK 12.6) čitao je samo stari
v1 niz. v2 mu je zato izgledao kao „nema cache”, pa je svake noći radio puni LIST i
prepisao cache u v1, bez veličina. Drift-provjera u KORAKU 12 time je bila mrtva.
`screenshot_youtube.js` je čitao također samo v1. Oba sada čitaju oba formata, a
audio-only piše v2.

Veličine su vraćene bez ijednog uploada:
`node upload_to_r2.js --input-dir storage/output --dry-run --verify-r2`
(LIST 184 459 ključeva za ~80 s; cache se sprema i u dry-runu).

Taj dry-run je našao 12 novih ključeva i **8 s driftom**. Nightly ih popravlja
prepisivanjem diska preko R2, a **u 3 slučaja je R2 veći od diska**, pa bi se
CDN degradirao (vidi MEMORY „Provjeri SMJER drifta”):

```
data/6ueR_Leq6uE/article.en.json          R2 58.7 KB  → disk 43.8 KB
data/oxq1U0xypu8/article.magisterium.json R2 770.6 KB → disk 642.4 KB
data/MGLq9v3AtvE/article.magisterium.json R2 1.6 MB   → disk 861.9 KB
```

Ostalih 5 (4× `article.en.json` gdje je disk veći, 1× `sponsors_in_video.json`
170 → 169 B) su ispravan smjer.
