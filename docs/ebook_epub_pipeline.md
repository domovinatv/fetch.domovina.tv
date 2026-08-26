# EPUB e-knjige iz epizoda (KORAK 9.8)

**Status:** pilot izveden 2026-08-25 na `h_6vqQEL2uc`
(*[re:DEFINICIJA] Dario Kordić*, kanal `muzevni_budite`), korak je uveden u
`run_pipeline.sh` i u R2 upload.

## 1. Zašto je ovo jeftino

Knjiga se ne *piše* — ona se **slaže od onoga što na disku već postoji** nakon
koraka 7–10. Nema nijednog LLM poziva, nema Vertexa, nema Modala, nema mreže.

| Ulaz | Iz kojeg koraka | Što daje knjizi |
|---|---|---|
| `{base}_{date}_{model}.article.json` | 8 | poglavlja (iteracije) i sekcije s tekstom |
| `{base}.wav.canary.summary.json` | 7 | naslov, sažetak, teme, imena govornika, ključne točke |
| `{base}_screenshots/{base}_HH-MM-SS.png` | 10 | ilustracija uz svaku sekciju |
| `{base}.png` / `.og-share.jpg` | 1 / 9.5 | podloga naslovnice |
| `{base}.article.magisterium.json` | 8.5 | dodatak „Teološka prosudba" |
| `{base}.wav.canary.diarized.srt` | 6 | dodatak „Cjeloviti transkript" (opt-in) |
| `{base}.info.json` | 1 | kanal, datum, trajanje, izvorni URL |

Izmjereno na pilotu: **1,5 s wall clock, 1,8 MB izlaza** (17 slika + 7 stranica).
Za usporedbu, ista epizoda kroz korake 7+8 potroši ~$0,039 Gemini kvote.
E-knjiga je, po epizodi, **jeftinija od zaokruživanja** te brojke.

## 2. Kako se pokreće

```bash
node generate_ebook.js --video-id h_6vqQEL2uc          # jedna epizoda
node generate_ebook.js --channel muzevni_budite --limit 5
node generate_ebook.js --force --with-transcript       # prepiši + dodaj prijepis
node generate_ebook.js --dry-run                       # samo popis, bez pisanja
```

| Zastavica | Default | Značenje |
|---|---|---|
| `--input-dir` | `storage/output` | korijen s kanalima |
| `--channel` / `--video-id` | svi | scoping (poller fast-path šalje oboje) |
| `--force` | off | prepiši postojeći `.epub` |
| `--with-transcript` | off | doslovan prijepis kao dodatak (vidi §4) |
| `--no-images` | off | knjiga bez slika (~60 KB umjesto 1,8 MB) |
| `--image-width` / `--image-quality` | 1200 / 80 | JPEG parametri ilustracija |
| `--limit` | 0 (bez limita) | za probne runove |

U pipelineu je **KORAK 9.8**, bezuvjetan kao 9.5/9.6/9.7 (`--no-ebook` ga gasi,
`--with-ebook-transcript` uključuje prijepis).

## 3. Zašto 9.8, a ne 11.5

Korak **mora** ići nakon KORAK 10 (screenshotovi). To je ista zamka zbog koje je
9.6 (og-sections) premješten iza 10: ako se knjiga složi prije nego frame-ovi
postoje, izađe bez ijedne slike — a `.epub` tada **postoji**, pa ga idući nightly
preskoči kao gotovog. Tihi gubitak, ne greška.

Numeracija 9.8 (umjesto 11.5) drži red čitanja u `run_pipeline.sh` poklopljenim s
redom izvršavanja: 10 → 9.6 → 9.8 → 11 → 12.

## 4. Prijepis je namjerno OFF

Poglavlja knjige su **uredničko-novinarska obrada** razgovora — izvedeno djelo,
ista klasa sadržaja koju domovina.ai ionako već javno servira kao članak.

Doslovan prijepis cijele epizode je drugi red veličine: to je potpuna
transkripcija tuđe snimke, spakirana u datoteku napravljenu za distribuciju.
Zato je iza `--with-transcript` / `--with-ebook-transcript` i **ne pali se u
nightlyju**. Ako se ikad pusti u produkciju, neka to bude po kanalu (uz dopuštenje
nakladnika), ne katalog-wide.

Kolofon svake knjige to i piše: prava na izgovoreni sadržaj i kadrove ostaju
izvornom kanalu, izdanje je izvedeno.

## 5. Tehničke odluke

**ZIP se piše ručno** (`lib/zip_writer.js`, ~120 redaka, `zlib` + CRC-32).
Repo konvencija je „nema npm ovisnosti u pipeline skriptama", a EPUB traži jednu
stvar koju gotovi zipperi znaju zabrljati: prvi zapis mora biti `mimetype`,
**metoda 0 (Stored)**, bez extra-fielda. Provjera:

```bash
unzip -lv knjiga.epub | head -4      # prvi red: mimetype, Stored, 0%
head -c 60 knjiga.epub | xxd         # "mimetypeapplication/epub+zip" na offsetu 30
```

**Naslovnicu radi ImageMagick, ne ffmpeg.** Lokalni ffmpeg je preveden bez
libfreetype → `drawtext` filtera **nema** (`ffmpeg -filters | grep drawtext` = 0
pogodaka). ImageMagick `caption:` radi wrapping sam.

> **Zamka koja je pukla u prvoj verziji:** `caption:` nasljeđuje `-background`,
> koji je po defaultu bijel. Bijeli naslov na bijeloj podlozi = prazan pravokutnik
> preko pola naslovnice. Rješenje je `( -background none -fill white … caption:… )`
> u zasebnoj zagradi, pa `-composite`.

**Model slug sadrži točke.** `gemini-3.5-flash` — regex za `article.json` mora
biti `(.+?)`, ne `([^.]+)`. Prva verzija je s `[^.]+` tiho našla **nula** epizoda.

**Dedup članka je isti kao downstream:** leksikografski najveći
`_{date}_{model}.article.json` (`opus` > `gemini-*` > `agy`), pa knjiga uvijek
prati onaj članak koji se i servira.

**YouTube deep linkovi** u knjizi (`&t=NNNs`) traže **cijele** sekunde — SRT
timestampovi su decimalni, pa ide `Math.floor`. `t=41.679s` YouTube ignorira.

**Idempotencija:** postojeći `.epub` = gotov posao, preskače se bez `--force`.
Ne vodi se zaseban state file — izvedena datoteka *jest* signal.

## 6. Isporuka

`upload_to_r2.js` (KORAK 12) šalje ga na
`data/{videoId}/book.epub`, Content-Type `application/epub+zip`.

Kao i `article.json`, ključ ide s **immutable** Cache-Controlom (godina dana).
Regeneracija knjige nakon uploada traži `--force` + CF purge, inače edge servira
staru. Za pilot je to u redu jer se knjiga i mijenja samo kad se mijenja članak.

## 7. Struktura knjige

```
Naslovnica (1600×2400, thumbnail + naslov + kanal + datum)
O ovoj epizodi   — sažetak, sudionici, teme, linkovi na YouTube i domovina.ai
Ključne točke    — key_points iz summary.json
Poglavlje 1..N   — jedno po iteraciji članka
  └ sekcija: podnaslov → screenshot s deep linkom → tekst → ključne riječi
Teološka prosudba — Magisterium (ocjena, sjemenke istine, ograde, izvori)  [ako postoji]
Cjeloviti transkript — po govornicima, s deep linkovima                    [opt-in]
Kolofon          — izvor, prava, kojim je alatima obrađeno
```

Navigacija: `nav.xhtml` (EPUB 3) **i** `toc.ncx` (stariji čitači, Kindle konverzija).

## 8. Što nije napravljeno

- **`epubcheck` nije pokrenut** — nije instaliran lokalno. Provjereno je ručno:
  `mimetype` je prvi i Stored, svih 11 XML/XHTML datoteka je well-formed
  (`xml.dom.minidom`), OPF manifest pokriva svaki `href`. Za javnu distribuciju
  (Google Play Books, Apple Books) pokreni pravi `epubcheck` prije prve isporuke.
- **Nema `.mobi`/`.pdf`** varijante. PDF bi tražio rendering engine; ako zatreba,
  `pandoc` je već instaliran i može uzeti isti EPUB kao ulaz.
- **Nema kataloga knjiga** — knjiga se ne pojavljuje nigdje u
  `channels/data/index*.json`. Frontend je zasad ne zna prikazati; potreban je
  `has_ebook` flag po uzoru na `has_article`.
- **Backfill nije pokrenut.** Katalog ima ~2 500 epizoda s člankom → ~4,5 GB
  EPUB-ova i ~1 h CPU-a. Prije toga provjeri headroom diska i CDN plan
  (vidi memory: `confirm_delivery_target_before_long_backfill`).
