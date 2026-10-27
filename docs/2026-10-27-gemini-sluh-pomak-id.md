# Gemini sluh: pomak id-a (27.10.2026.)

Na `domovina.ai/v/ja70p_gJWZA` (mladi_za_domovinu, podcast 118) titl se od ~50.
minute razilazio sa zvukom. Video, MP3 i WAV su bili jednako dugi (5151,6 s), dakle
nije bio pomak zvuka. Problem je bio u **tekstu** kanonskog prijepisa.

## Što se dogodilo

KORAK 2.8 (`refine_diarized_gemini.js`) šalje Geminiju prozor zvuka od ~10 min i
popis segmenata kostura (id, od, do, natuknica). Za svaki id model vrati tekst.

U prozoru 49:47–59:18 model je pisao točne riječi, ali pod **id sljedećeg segmenta**.
Zaostatak je rastao: 1 segment na 49:47, 16 segmenata na ~56 min. Zatim su ~3 minute
govora nestale, a na 59:18 (novi prozor) tekst je opet bio na mjestu. Vremena cue-ova
su ostala točna, a tekst nije, pa su titl, `words.json` i RAG nosili tekst koji se
govori i do 1:45 ranije.

| | na 52:08 |
|---|---|
| prijepis | „s kojom lakoćom osuđujemo ljude…" (stvarno izgovoreno na ~51:17) |
| zvuk / Soniox | „Ja sam pitao Zorane: ‘Recite mi zašto ja kao hrvatski konzervativac ne mogu biti antifašist?'" |

## Kako je ušlo u kod

KORAK 2.8 je uveden 19.09.2026. (`f8918b2c`) kao port eksperimenta. Ograde su
pisane prema greškama koje su se tada vidjele
(`docs/2026-09-19-speechmatics-kostur-gemini-sluh.md` §3.2):

- **prazni segmenti** pred kraj prozora → quality gate 65 % pokrivenosti riječi
- **collapse** (sav monolog u jedan segment) → pravilo u promptu
- **blokade / krnji JSON** → raspolavljanje prozora
- **podijeljen id** → spajanje

Pomak id-a nije bio među njima. Sve četiri ograde pitaju „ima li teksta?", nijedna
„je li to tekst OVOG segmenta?". Pomaknut prozor ima ~100 % pokrivenosti, pa je
prošao kao `544 prihvaćeno · 0 na kosturu`. Pravilo 5 u promptu („ne mijenjaš im
`id`") je molba modelu, a ne provjera.

Sigurnosni pod (tekst kostura) hvatao je samo `null`/prazno, nikad pogrešan sadržaj.

Izloženost je narasla 24.10. (`37180b84`): nightly je tada prešao na Soniox +
pyannoteAI + Gemini sluh, pa KORAK 2.8 prolazi **svaka** nova epizoda, a ne samo
backfill. Downstream je signal postojao: `words.json` ima udio usidrenih riječi po
cue-u (cue-ovi 306–367 su imali ~0). Prag je, međutim, na razini cijele epizode
(0,6), a epizoda je imala 0,863, pa lokalna rupa nije bila vidljiva.

## Popravak

`lib/refine_drift.js` → `detectDrift(refined[], skeleton[])`, nula API poziva:

- segment je **pomaknut** kad mu riječi znatno bolje pokriva kostur susjeda (k ≠ 0,
  ≥ 0,6 i barem 0,3 bolje) nego vlastiti kostur. Sama niska sličnost s vlastitim
  kosturom NIJE dokaz: to je upravo collapse koji refine popravlja („ono ono ono…"
  → pravi govor), pa takav segment prolazi.
- **niz** = barem 2 pomaknuta segmenta. Traje dok se 2 uzastopna ocijenjena segmenta
  ne poklope sa svojim kosturom. Sve unutar niza (i segmenti bez para) je sumnjivo.
- segmenti kraći od 6 riječi se ne ocjenjuju.

U `refine_diarized_gemini.js`, nakon svakog prozora:

1. ako ima niza, prozor se ponovi jednom u dvije polovice (kraći prozor manje klizi)
2. ono što i dalje klizi pada na tekst kostura (točna vremena riječi)
3. isti test još jednom nad cijelom epizodom, za niz preko granice prozora

Novi brojači u `.gemini.meta.json` → `stats.drift_windows` i `stats.drift_fallback`.
Testovi: `lib/refine_drift.test.js` (rastući zaostatak, collapse, izolirani rub,
segment bez para).

## Backfill (27.10.2026.)

`tools/fix_refine_drift.js` (default suho):

```bash
node tools/fix_refine_drift.js                                  # popis
node tools/fix_refine_drift.js --video-id <ID> -v               # detalji
node tools/fix_refine_drift.js --commit --downstream --upload   # do CDN-a
```

Alat ne zove nijedan API: u sumnjivim segmentima vrati tekst kostura. Kanonski SRT
dira samo kad je on doista taj Gemini prijepis; stari ide u `.bak_drift_YYYYMMDD`.
`--downstream` ponovno slaže `words.json` (`--force`), `segments.jsonl` i tri RAG
jsonl-a: stari izlaz se preimenuje, a epizoda se makne iz done-cachea.
**Ne koristiti `--rebuild-state` za jednu epizodu:** `prepare_rag_combined.js` tada
na kraju prepiše cijeli `rag-combined-done.json` samo tom epizodom. To se dogodilo
27.10. i cache je ponovno složen iz datoteka. `--upload` šalje
`force_upload.js --targets diarized,words` (+ bundle, CF purge).

Rezultat: od 130 epizoda koje su prošle Gemini sluh **13 je imalo pomak**, ukupno
355 segmenata. 12 je popravljeno do CDN-a. `cQ8TNmlWoMI` ima kanonski prijepis iz
drugog izvora, pa je popravljen samo njegov `.gemini.diarized.srt`. Veliki nizovi:
`ja70p_gJWZA`, `XwgjW2crt6U`, `UTgOBOwITmc`, `bq6GYHQWrzo`, `cU88JYVdEkQ`,
`EF4owB1WMio`, `CZT8mdWTIOA`. Mali (1–2 segmenta, uglavnom riječi preko granice
kratkog segmenta) su također vraćeni na kostur, jer je kostur na tom mjestu točan.

Epizode bez Gemini sluha (~3300 Canary prijepisa) ovaj bug ne pogađa.

Članak i sažetak se ne diraju: pisani su iz istog teksta, samo razmještenog.
Iznimka su ~3 min koje je Gemini u `ja70p_gJWZA` izgubio; članak ih možda ne spominje.

### RAG re-ingest: OTVORENO

`domovina-rag` ETL preskače epizode koje su već indeksirane
(`pg.is_episode_indexed`). Novi `rag_combined.jsonl` zato ne stiže u ClickHouse/Meili
sam. Ponovni unos ide s `--reingest` po kanalu (ReplacingMergeTree pobjeđuje).
Nije pokrenut, jer traži embedder i zbog memorijskog budžeta Maca
(vidi memory `mac_panic_rag_sync_memory_budget`).
