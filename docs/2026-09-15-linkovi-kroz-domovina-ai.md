# Linkovi u offline artefaktima idu kroz domovina.ai

**Datum:** 15.09.2026. · **Zahvaćene skripte:** `generate_ebook.js`,
`summarize_gemini.js`, novi `tools/rebuild_summary_md.js`

## Pravilo

**Svaki klikabilan link u datoteci koja napušta naš sustav vodi na domovina.ai.**
YouTube smije ostati isključivo kao **neklikabilan navod izvora** (atribucija
nakladniku).

Razlog nije estetski. EPUB je jedini artefakt pipelinea koji putuje sam: netko ga
pošalje na WhatsApp, on se proslijedi dalje i živi mjesecima izvan svakog našeg
kanala. Ako su timestampovi u njemu `youtube.com/watch?v=…&t=NNNs`, onda smo
uložili transkripciju, dijarizaciju, članak, prijevod i teološku prosudbu — pa
cijeli promet koji iz toga nastane poklonili YouTubeu. Čitatelj koji klikne
završi na sirovoj snimci: bez transkripta, bez prijevoda, bez pretrage, bez
poveznice na ostatak kataloga.

Format deep linka: **`https://domovina.ai/v/:id/t/:sec`** — stvarna ruta Flutter
aplikacije (`../domovina.ai/lib/router/app_router.dart`), ista koju već koriste
og-share slike (`generate_og_sections.py`). Sekunde su cijeli broj (`Math.floor`).
Bazu mijenja `EBOOK_SITE_BASE`.

Provjereno iz točke potrošača, ne iz koda:

```
$ curl -s -A "WhatsApp/2.23" https://domovina.ai/v/rAAplrRelPM/t/92 | grep og:
og:title  ⏱ 1:32 · Duhovna hrana bez koje vjera umire
og:url    https://domovina.ai/v/rAAplrRelPM/t/92
og:image  https://cdn.domovina.ai/images/rAAplrRelPM/og-t-92.jpg
```

Dakle link iz knjige na WhatsAppu otvara karticu s našom slikom i našim naslovom.

## Što je pregledano

| Artefakt | Dijeli li se kao datoteka | Prije | Sada |
|---|---|---|---|
| `{base}.epub` (KORAK 9.8, CDN `data/{id}/book.epub`) | **da** | svi timestampovi → `youtube.com/watch?v=…&t=Ns` | `domovina.ai/v/:id/t/:sec` |
| `{base}.canary.summary.md` | da (samo s diska — **nema** R2 key, vidi dolje) | `**YouTube:** youtu.be/ID` | `**Epizoda:** domovina.ai/v/ID` + neklikabilan `Izvornik:` |
| `{base}.og-share.jpg`, `og-t-{sec}.jpg` | da (preview slika) | već brandirano `DOMOVINA.ai · kanal`, bez YT-a | nepromijenjeno |
| `{base}.canary.diarized.srt` | da | čisti tekst, nema linkova | nepromijenjeno |
| `*.article.json`, `*.summary.json`, `*.rag_combined.jsonl`, `info.json` | ne (strojni ulaz aplikacije/RAG-a) | `youtube_id` / `webpage_url` kao **podatak** | nepromijenjeno — aplikacija odlučuje što s tim |
| `index.json` iz `generate_channel_index.js` | ne | `youtube_url` polje | nepromijenjeno (polje, ne link u tekstu) |
| `yt-dlp` pozivi (`fetch.js`, `screenshot_youtube.js`, …) | ne | URL za preuzimanje | nepromijenjeno |
| `sabor_pipeline` (`utils/time_mapper.js` → `globalToYoutube`) | interno | YouTube deep link u manifestu | **namjerno ostaje** — saborske sjednice nisu u katalogu, `/v/:id` za njih ne postoji |
| `domovina-cutter` klipovi (`clips/` na R2) | da | drugi repo | **nije dirano ovdje** |

Usput otkriveno: `.canary.summary.md` je u `UPLOAD_SUFFIXES`, ali `getFlutterKey()`
za njega **nema mapping**, pa nikad nije završio na R2 (`0` ključeva u
`.r2_keys_cache.json`, dok `book.epub` ima 3280). Datoteka postoji samo na disku.
Ako je ikad poželimo isporučiti, treba joj dodati `data/{id}/summary.md` mapping.

## Što je u knjizi ostalo od YouTubea

Atribucija, ali bez `<a href>`:

- naslovnica: `Izvornik: {kanal} · youtube.com/watch?v=ID`
- kolofon: isti redak ispod linka na domovina.ai
- `content.opf`: `<dc:source>` je sada epizoda na domovina.ai, YouTube je
  `<dc:relation>`

Beamly audio-only epizode (`_yt_matched === false`) imaju sintetički `_yt_` ID —
za njih se navod izostavlja jer taj YouTube URL ne postoji.

## Ograda pri regeneraciji: `--allow-shrink`

Backfill nad postojećim knjigama znači `--force` preko datoteke koja je već dobra.
Ako su u međuvremenu screenshotovi nestali s diska (bulk restore, `move_to_disk.sh`),
nova knjiga izađe **bez slika** i tiho pregazi bogatu — prvo na disku, a nakon
uploada i na CDN-u, gdje je ključ immutable.

Zato `generate_ebook.js` odbija prepisati knjigu koja bi bila manja od 60 %
postojeće i uputi na `restore_derived_from_r2.js`. Namjerno smanjenje traži
`--allow-shrink`.

## Runbook: backfill kataloga

```bash
# 1) koliko ih uopće ima
ls storage/output/*/*.epub | wc -l          # 3292 na disku, 3280 na R2

# 2) regeneracija (bez LLM-a, ~1.5 s/ep → ~80 min za katalog)
node generate_ebook.js --force --limit 20   # prvo uzorak, pa bez --limit
#    greške "nova knjiga je bitno manja" = fali screenshotova → restore, ne --allow-shrink

# 3) provjeri uzorak prije isporuke
unzip -p storage/output/<kanal>/<base>.epub OEBPS/pog-1.xhtml | grep -o 'href="[^"]*"' | sort -u

# 4) isporuka — data/ ključevi su IMMUTABLE, obični upload ih preskače
node tools/force_upload_epubs.js --dry-run  # koliko ih ide (samo VEĆ objavljene)
node tools/force_upload_epubs.js            # PUT + CF purge u dvije Vary varijante

# 5) .md sažeci (samo disk, bez CDN-a)
node tools/rebuild_summary_md.js --dry-run
node tools/rebuild_summary_md.js
```

Korak 4 je jedini skup i jedini nepovratan (purge 3280 URL-ova) — i jedini koji
mijenja ono što ljudi vide.

## Izvedeno 15.09.2026.

| Faza | Rezultat |
|---|---|
| Regeneracija | 3 331 knjiga (3 292 HR + 39 EN), 0 grešaka, ~43 knjige/min |
| Isporuka | 3 277 PUT-ova, 4,25 GB, 0 grešaka |
| Purge | 6 554 zapisa (3 277 URL-ova × 2 Vary varijante) |
| Provjera | `curl` s `Origin: https://domovina.ai` na uzorku → 0 `href` prema YouTubeu |

Prvi pokus katalog-wide regeneracije ubijen je na **2914/3292** zbog memorijskog
pritiska (Docker VM drži 14 GiB od 24, skripta troši par stotina MB). Zato
`--older-than <ISO>`: preskače knjige regenerirane poslije zadanog trenutka, pa
nastavak ne ponavlja odrađeno. Postojeći `.epub` je i inače signal idempotencije
— ovo mu samo dodaje vrijeme, umjesto uvođenja state filea.

Dvije stvari koje je backfill otkrio:

- **15 epizoda postoji i u kanalu i u `_unlisted`** (ad-hoc obrada koju je kanal
  kasnije posvojio, `auto_reuse_adhoc.js`). Oba imena vode na isti CDN ključ, pa
  bez razrješenja upload ovisi o redoslijedu čitanja direktorija. Servira se
  kanalska epizoda (`_unlisted` nije indeksiran), pa kanalska kopija pobjeđuje.
- **3 knjige na CDN-u nemaju lokalni izvor** (`6dcab9c9837`, `cd7ac05aabf`,
  `eab99cbaefd`) — sintetički Beamly ID-evi; ostaju sa starim linkovima.

## Vezani dokumenti

- `docs/2026-09-15-en-prijevod-mjerenja.md` — sve izmjerene brojke istog dana:
  trajanja i broj poziva po epizodi, anatomija per-field prijevoda, stvarna Vertex
  kvota (`effectiveLimit: None` = DSQ), trošak po epizodi i za katalog, mjerenja
  cache hit-a i analiza alternativa.
