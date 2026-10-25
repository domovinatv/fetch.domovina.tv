# re:DEFINICIJA (muzevni_budite): stanje obrade po epizodi (24.10.2026.)

Snimka stanja za 10 epizoda: lokalne datoteke (`generated_at` u JSON-ima, a vrijeme izmjene
samo kad tog polja nema) i CDN (`data/{id}/episode.json`, inline članak i Magisterium).
Pokazuje kako je katalog nastajao slojevito, svaka epizoda alatima svog vremena.

| Ep | ID | Prijepis | Govornici | Sažetak | Servirani članak | Magisterium | EN | words.json |
|---|---|---|---|---|---|---|---|---|
| 1 | LnjTZ39Tsdc | Canary 10.03. (prije Whisper) | pyannote lokalno | Gemini 2.5 Flash | Gemini 2.5 Flash 21.03. | 93 | — | — |
| 2 | -bOmDXC7rlA | Canary 10.03. (prije Whisper) | pyannote lokalno | Gemini 2.5 Flash | Gemini 2.5 Flash 21.03. | 91 | — | — |
| 3 | 1--IUSQILFA | Canary 18.03. | pyannote lokalno | Gemini 2.5 Flash | Gemini 2.5 Flash 21.03. | 93 | — | — |
| 4 | kCa7edJS-Lo | Canary 06.05. | pyannote lokalno | Gemini 2.5 Flash | Gemini 2.5 Flash 12.05. | 98 | — | — |
| 5 | Yoln5fe9RdY | Canary 25.05. | pyannote lokalno | Gemini 2.5 Flash | Gemini 2.5 Flash 26.05. | 92 (Opus 4.7 MCP) | ✅ | — |
| 6 | ouoZvcpBt9Y | Canary 22.06. | pyannote lokalno | Gemini 2.5 Flash | Gemini 2.5 Flash 24.06. | 93 | — | — |
| 7 | ZkMcSRvajCw | Canary 25.07. | pyannote lokalno | Gemini 3.5 Flash | **Opus** 31.07. | 90 ⚠️ nad starim 3.5 člankom | ⚠️ sa starog | — |
| 8 | h_6vqQEL2uc | Canary 17.08. | pyannote lokalno | Gemini 3.5 Flash | **Gemini 3.7 Flash** 25.08. | 86 ⚠️ nad starim 3.5 člankom | ⚠️ sa starog | — |
| 9 | f2HIRJPHHK4 | Canary 15.09. (+ Speechmatics naknadno) | pyannote lokalno | Opus | Opus 15.09. | 78 (23.10.) | — | SM 77 % |
| 10 | DOfcONrRyDY | **Speechmatics + Gemini 3.8 sluh** (promoviran) | Speechmatics | Opus | Opus 18.10. | ❌ nema | — | SM 83 % |

## Otvorene stavke

1. Ep. 7 i 8: CDN servira noviji članak, a Magisterium i EN su iz starog 3.5 članka. Treba ih
   ponovno pustiti nad serviranim člankom (MCP, HR-only).
2. Ep. 10: nema Magisteriuma.
3. Ep. 1–8: nema `words.json`, pa se za njih ne može napraviti reel s titlom. Backfill je
   479 min: kroz Speechmatics ~$6,2, kroz Soniox ~$1 (`docs/2026-10-24-soniox-pyannote-roadmap.md`).
4. Vrijeme izmjene datoteka nije pouzdano: kod ep. 7 prijepis ima kasnije vrijeme od sažetka.

Recompute: danas `node tools/build_processing_manifest.js --channel muzevni_budite --print`
(`{base}.processing.json`, data_contract §16). Prva verzija skripte je bila jednokratna (čita `*.meta.json`, `summary.json`, `article.json`
metadata, `gemini_usage.json` i uspoređuje `.diarized.srt` sa `.speechmatics*.diarized.srt`
da odredi izvor). CDN: `inline["article.json"].metadata.model` i
`inline["article.magisterium.json"].source_article`.


## Soniox + pyannoteAI za svih 10 (24.10. navečer)

Gotovo za svih 10, ništa nije promovirano ni poslano na CDN. Izlaz je
`{audio}.soniox.*`, `{audio}.pyannote_ai.json` i `{audio}.soniox_pyannote.{diarized.srt,words.json}`.

| ep | zvuk | Soniox | pyannoteAI | govornika Soniox / pyannote |
|---|---|---|---|---|
| 1 | 64:41 | $0,129 | $0,139 | 2 / 2 |
| 2 | 55:17 | $0,111 | $0,118 | 2 / 3 |
| 3 | 43:02 | $0,086 | $0,092 | 2 / 2 |
| 4 | 48:35 | $0,097 | $0,104 | 2 / 3 |
| 5 | 62:53 | $0,126 | $0,135 | 2 / 3 |
| 6 | 63:40 | $0,127 | $0,137 | 3 / 3 |
| 7 | 68:41 | $0,137 | $0,147 | 2 / 3 |
| 8 | 71:41 | $0,143 | $0,153 | 2 / 3 |
| 9 | 51:21 | $0,103 | $0,109 | 3 / 3 |
| 10 | 61:59 | $0,124 | $0,132 | 3 / 3 |

Soniox obrađuje ~39× brže od realnog vremena. Treći pyannote govornik na ep. 2, 4, 5, 7 i 8 nije
preslušan: vjerojatno je to uvodni isječak ili kratka upadica, a obrazac odgovara onome da
Soniox spaja govornike.

Ep. 9 već ima Gemini prepis nad tim kosturom (`.soniox_pyannote.gemini.diarized.srt`,
7528 → 7593 riječi, 8 min, $0,17), također nepromoviran.

**Sljedeći prolaz (dogovoren 24.10.):** svih 10 epizoda kao referentna obrada. Redom:

1. Gemini prepis i promocija.
2. Novi sažetak i članak s poglavljima.
3. words.json iz Sonioxa, pa CDN i bundle.
4. Magisterium MCP, HR **i** EN, za svih 10.

Plan i stanje pipelinea: `docs/2026-10-24-pipeline-trenutno-stanje.md`.

## Referentna obrada — napredak (24.10.2026., dan)

| korak | stanje |
|---|---|
| 1. Gemini sluh nad Soniox+pyannote kosturom + `--force-promote` | ✅ 10/10 · ~$0,17–0,21/ep, ~8–27 min/ep · stari kanonski SRT kao `.bak` |
| 2. `--reprocess-article` (Claude Opus, pretplata) → sažetak, članak, screenshotovi, epub, CDN | ✅ 10/10 · **~7 min/ep** (12:24–13:40), ne 20 kako je procijenjeno |
| 3. `generate_words_json.js --with-soniox --force` + `force_upload --targets diarized,words,sponsors` | ✅ 10/10 · CDN GET md5 = disk za diarized.srt, words.json, article.json |
| 4. Magisterium MCP HR (jedan subagent po epizodi, `--batch-size 1 --max-words 80`) | ✅ 10/10 |
| 4. EN (`translate_to_english.js`, batch po bloku od `cf926987`) + objava | ✅ 10/10 · 5–25 min/ep |
| 5. E-knjige s Magisteriumom (HR + EN), `force_upload_epubs` + `upload_to_r2` za nove `book.en.epub` | ✅ 10/10 |

**Završno stanje (24.10.2026., 21:40), provjereno GET-om na `data/{id}/episode.json`**: svih 10 ima
članak `claude-code:opus`, Magisterium nad člankom od 24.10., `article.en.json`,
`article.magisterium.en.json`, `book.en.epub` i `words.json`; md5 svake EN datoteke i knjige = disk.

| Ep | ID | sekcija | Magisterium (prosjek sekcija / holistički) | raspon sekcija | HR trajanje | chat poziva |
|---|---|---|---|---|---|---|
| 1 | LnjTZ39Tsdc | 25 | 82 / 83 (ponovljeno s 80 riječi; s 45 bilo 86) | 62–95 | 28 min | 30 |
| 2 | -bOmDXC7rlA | 25 | 76 / 78 (ponovljeno s 80 riječi; s 45 bilo 75) | 54–88 | 22 min | 26 |
| 3 | 1--IUSQILFA | 24 | 80 / 82 | 72–89 | — | — |
| 4 | kCa7edJS-Lo | 27 | 85 / 88 | 65–95 | — | — |
| 5 | Yoln5fe9RdY | 35 | 76 / 78 | 45–88 | 2,4 h | 36 |
| 6 | ouoZvcpBt9Y | 36 | 80 / 81 | 56–95 (sekcija Sisak 40 → 62, vidi dolje) | 2,4 h | 38 + 1 |
| 7 | ZkMcSRvajCw | 27 | 72 / 72 | 56–88 | 21 min | 28 |
| 8 | h_6vqQEL2uc | 33 | 79 / 63 | 55–94 | 27 min | 35 |
| 9 | f2HIRJPHHK4 | 22 | 80 / 87 | 62–94 | 15 min | 24 |
| 10 | DOfcONrRyDY | 25 | 84 / 90 | 67–96 | 22 min | 26 |

Usko grlo HR Magisteriuma je orkestrator (Claude agent), ne Magisterium server: isti tip
prompta 45 s/poziv (ep. 7–10, odgovori spremani skriptom iz transkripta) prema ~4 min/poziv
(ep. 5–6, odgovori prepisivani ručno, kontekst raste do 260k). Optimizacija (izravni MCP
klijent bez LLM-a u petlji) je zaseban zadatak.

Riješeno 24.10. navečer:

- **Ep. 6, sekcija „Spomenik u Sisku i kozaračka djeca": 40 → 62.** Uzrok je bio prep, ne
  epizoda: `--max-words 80` odrezao je sadržaj točno iza rečenice „nitko ih nije ubijao", bez
  nastavka („došli su gladni, bolesni, umirući… umrli od gladi i bolesti"). Sekcija je
  ponovno poslana s cijelim tekstom (432 riječi, `--max-words 400`), ostalih 35 sekcija
  identično. Primjedbe koje ostaju: kategorička povijesna tvrdnja bez izvora, ton, dijalog
  uvjetovan spomenikom. Pouka: rez na N riječi može ispasti baš iza sporne rečenice —
  prep bi trebao slati cijelu sekciju i rezati tek iznad razumne granice, na kraju rečenice.
- **Ep. 1–2 ponovljene s `--batch-size 1 --max-words 80`** (stari rezultati `.bak45`), uz
  novi EN Magisterium i e-knjige. CDN md5 = disk za sve.

Otvoreno:

- `force_upload.js --targets epub` nema EN varijantu; prvi `book.en.epub` objavljuje
  `upload_to_r2.js --video-id`, a `tools/force_upload_epubs.js` šalje samo već objavljene.

Zamke naučene usput:

- **`CLAUDE_WINDOW_GUARD=1` u ručnom runu odgodi korake 7+8**, a `--reprocess-article` je
  stari članak već sklonio u `.reprocess_bak/` → epizoda ostane bez članka na disku (CDN
  netaknut jer 12.1 nema što uploadati). Za ručni reprocess pusti bez ograde.
- **`--reprocess-article` NE prepisuje `diarized.srt` ni `words.json`** na CDN-u (samo
  article, summary, outline, epub). Uz novi prijepis treba zaseban `force_upload`.
- **`publish_hr_episode.sh` sam nije dovoljan** kad stari `magisterium.json` već postoji na
  R2: dodaj `force_upload --targets magisterium` i provjeri md5, ne samo status 200.
- **Magisterium `chat` pada na timeout** kod dugih promptova; prep s `--batch-size 2
  --max-words 45`. Ručno skraćivanje promptova na ep. 1 izmislilo je sadržaj u 4 batcha
  (subagent je to sam uhvatio i ponovio) — promptove slati doslovno.
- Prvi nightly na Soniox putu (24.10.): 5 epizoda, 0 grešaka. Tri epizode od 20.–22.10.
  već su imale Speechmatics kanonski SRT pa ih je 2.7b/2.7c/2.8 ponovno obradio (unutar
  prozora od 3 dana) bez promocije — jednokratni trošak prijelaza ~$1,5.

## Ponovna obrada ep. 1–4 iz Soniox teksta (25.10.2026., 17:19–19:11)

`--reprocess-article` 24.10. je za ep. 1–4 čitao `.sortformer.diarized.srt` (bug
`isPromotedRefine`, popravljen u 775ea03f), pa su sažetak, članak, RAG, Magisterium i EN
bili iz starog Canary teksta. Ponovljeno nakon popravka, epizoda po epizoda:

1. `env -u CLAUDE_WINDOW_GUARD ./run_pipeline.sh --reprocess-article <ID> --gemini-backend claude`
   — ~8,5 min/ep, 0 grešaka; u logu `Transkript: Soniox + pyannoteAI + Gemini sluh`, nijedna
   linija `Dijarizacija: sortformer`.
2. `node tools/magisterium_mcp_episode.js --video-id <ID> --force` — ~14 min/ep, bez Claude kvote.
3. `translate_to_english.js` + `force_upload --targets article-en,magisterium-en,summary-en`,
   `generate_ebook.js --force` + `tools/force_upload_epubs.js`. `--force` za EN nije trebao:
   reprocess je stari `summary.en.json` sklonio u `.reprocess_bak/`.

| Ep | ID | Magisterium (prosjek sekcija) | Sortformer riječi u RAG prijepisu, prije → poslije |
|---|---|---|---|
| 1 | LnjTZ39Tsdc | 85 | — → 0/28 |
| 2 | -bOmDXC7rlA | 79 | 22/22 → 0/22 |
| 3 | 1--IUSQILFA | 83 | 19/19 → 0/19 (1 lažni pogodak, „pomoć" je i u Soniox SRT-u) |
| 4 | kCa7edJS-Lo | 85 | 22/22 → 0/22 |

Provjereno GET-om: md5 disk = CDN za article, magisterium, article.en, magisterium.en,
summary.en, book.epub i book.en.epub; `episode.json` inline nosi samo sadržaj od 25.10.
Kvota: 5-satni prozor 0 → 12 %, tjedni 27 → 28 %.

Zamka mjerenja: `rag_combined.jsonl` ima `topic_transcript` (doslovni prijepis) **i**
`article_summary` (proza članka). Provjera „riječi samo iz Sortformera” mora gledati samo
`topic_transcript`, inače obične riječi iz članka („kada”, „vjerovati”) izgledaju kao curenje
(ep. 1: 15/28 na cijeloj datoteci, 0/28 na prijepisu). U članku i sažetku taj signal ionako
šumi; tamo su dokaz samo pogrešno napisana imena (ranije „julian”, „jose”, „potplaničkog”).
