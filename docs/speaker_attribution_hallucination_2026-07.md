# Halucinacija atribucije govornika u multi-speaker / highlights videima (2026-07)

> **TL;DR** — `generate_article_gemini.js` dobiva SAMO `.canary.diarized.srt` koji nosi
> anonimne `[SPEAKER_XX]` oznake i **nula osobnih imena**. Za podcaste s malom, stabilnom
> ekipom model pouzdano pogodi tko je tko iz konteksta. Za **highlights / koncertne reelove
> s 20+ kratkih govornika** nema dovoljno signala pa model **konfabulira imena** (uvjerljiva
> hrvatska imena + imena iz općeg znanja o temi). Ground-truth mapa imena postoji u
> **`.description` chapter-listi koju objavljuje sam izdavač**, ali je pipeline ne koristi.
> Ovo NIJE bug u jednom polju — to je strukturno ograničenje domene.

## Slučaj koji je otkrio problem: `vq65cKlbMjs`

Video "Koncert Thompsona i vodećih pjevača duhovne glazbe" (kanal `40_dana_za_zivot`) je
**highlights reel** ~20 kratkih backstage svjedočanstava, a ne klasičan podcast. Diarizacija
je dala **25 govornika**. Rezultat u izvornoj Gemini `article.json`:

- **10 od 15 sekcija** nosilo je izmišljeno ili pogrešno ime.
- Isti izmišljeni **"Klaudija Popović"** zalijepljen na **4 različita govornika** (model
  kolabira sve "ženske pro-life glasove" u jedan lik).
- Izmišljen **bend "Opća Opasnost"** (stvarni izvođač: **PHOS**).
- Pogrešne uloge/spol: pjevačice → "Duhovnik"/"Svećenik".
- Korisnikov okidač: sekcija na `t/200` (03:20) pripisana "Tiho Orlić" — ime kojeg **nema
  nigdje** (ni SRT, ni opis, ni summary). Stvarni govornik po chapter-listi: **Petar Buljan**
  (`03:05`, član Thompsonova benda).

Sadržaj (ŠTO je rečeno) bio je uglavnom **vjeran** transkriptu — halucinacija je gotovo
isključivo u **atribuciji (TKO je govorio)**.

## Zašto se događa (uzročni lanac)

1. Jedini ulaz u generaciju je `.canary.diarized.srt` → **samo `[SPEAKER_XX]`, nula imena**
   (provjereno na svih 296 linija ovog videa).
2. Prompt traži novinarsku prozu s **imenskom atribucijom citata**. Bez imena u ulazu model
   je prisiljen ili generalizirati (uloga) ili **pogađati ime** — radi oboje, nedosljedno.
3. Za pogađanje crpi iz **parametarskog znanja** o temi (klaster "Husar": Marija Husar Rimac,
   Ivana Husar Mlinac; poznati bend "Opća Opasnost") i iz **čiste sintetike** (Alen Hržica,
   Tiho Orlić). Klasična konfabulacija potaknuta tematskim primingom.
4. **Ground-truth mapa POSTOJI** u `.description` chapter-listi (`MM:SS Ime`) i egzaktno se
   poravnava sa SRT speaker-turnovima. Provjereno na 5 točaka (na sekundu): `02:44`→Košić,
   `03:05`→Petar Buljan, `04:23`→majka Lidija, `24:40`→Marko Bartulović, `24:58`→Petra Milković.
   Pipeline tu listu **ne prosljeđuje** modelu.
5. Pomoćni signal `summary.json > speakers[].suggested_name` i sam je neovisno pogrešan/pomaknut,
   i članak ga ionako ne konzumira.

`temperature` je **0.2** (`generate_article_gemini.js`) — nije uzrok; i na 0 bi model
determinstički konfabulirao jer u ulazu nema imenskog signala.

## Ručna korekcija (referentni postupak, dok pipeline ne dobije fix)

Za `vq65cKlbMjs` korekcija je napravljena ručno (Opus 4.8), uz očuvanje **iste sheme i istih
15 `screenshot_timestamp`-ova** (da screenshoti/OG-sekcije ostanu poravnati):

1. Parsiraj `.description` chapter-listu (`^\d?\d:\d\d\s+Ime`) → speaker↔ime↔timestamp mapa.
2. Imenuj **samo** kad je pouzdano: exact timestamp match, ili chapter-window koji čisto
   sadrži jednog govornika. Gdje poglavlje označava **pjesmu ili uvod** → **neutralna uloga**
   ("izvođač", "posjetiteljica", "sudionik"), NIKAD izmišljeno ime.
3. Sadržaj drži vjeran SRT-u; makni izmišljene činjenice (npr. krivi naziv benda) i krive
   uloge/spol.
4. Metadata: dodaj `speaker_attribution_corrected*` polja; original spremi kao
   `.article.json.gemini-hallucinated.bak` (rename, ne delete — vidi memory
   `wildcard_delete_caution`).
5. Regeneriraj downstream iz ispravljenog članka:
   - `magisterium_mcp_assemble.js` ponovno čita `articlePath` → ispravljene sekcije + isti
     teološki skorovi/citati.
   - `translate_to_english.js` (rename stari `.en.json` → `.bak` da se re-translate okine).
6. **Force re-upload** immutable `data/{vid}/*.json` ključeva (vidi `force_upload.js` niže) +
   CDN purge + **GET-verifikacija** (ne HEAD — CDN cache-ira 404/stari sadržaj).

Zaostaje (istog uzroka, popraviti po potrebi): `summary.json`/`summary.en`, OG-section slike,
`rag_combined.jsonl`.

## Poluge za trajni fix pipelinea — IMPLEMENTIRANO (`generate_article_gemini.js`, 2026-07-04)

Sve tri poluge su ugrađene u `generate_article_gemini.js` i **uvjetno aktivirane** da ne
pokvare dobru podcast-atribuciju. Aktivacija (`strictAttribution`) uključi se kad postoji
upotrebljiva izdavačeva mapa (**≥3 chapter-unosa**) **ILI** kad diarizacija vrati puno
govornika (**> `STRICT_SPEAKER_THRESHOLD` = 8**). Za obični podcast bez mape s malo govornika
ponašanje je **bajt-identično** kao prije (prazan chapter-block + nepromijenjeni system prompt).

1. **Injektirana `.description`/`.info.json` chapter-lista kao ground-truth**
   (`loadPublisherChapters` → `buildChapterMapBlock`). Preferira strukturirani
   `.info.json` `chapters` (`{start_time, title}`), fallback na `.description` tekst
   (`MM:SS`/`HH:MM:SS Naslov`). Blok "SLUŽBENA MAPA GOVORNIKA" dodaje se u prompt Faze 1 i
   Faze 2; model poravnava vrijeme nastupa govornika s oznakama iz mape.
2. **Tvrdi constraint u promptu** (`STRICT_NAMING_CLAUSE`): "NIKAD ne izmišljaj ime; koristi
   ga samo ako je doslovno u transkriptu ILI u mapi; inače neutralna uloga; ne pretpostavljaj
   uloge/spol; stavke-pjesme nisu imena." Dodaje se na `SYSTEM_PROMPT_1/2` samo u strict-modeu.
3. **Post-hoc name-audit** (`auditNames`): izvuče PERSON/ORG kandidate (bolded `**X**`,
   `subtitle`, `screenshot_description`, `entities`; heuristika ≥2 uzastopne Velike riječi ili
   titula mons./fra/dr./sv.), provjeri protiv allowliste `{chapter tokeni} ∪ {SRT tokeni} ∪
   {summary.mentioned_people}` s **deklinacijski-tolerantnim** prefiks-matchom (Marko→Marka→
   Markom). Nepotvrđena imena → `console.warn` + sidecar **`*.article.name_audit.json`**.
   Audit je **dijagnostički** (ne mutira članak) — prevencija dolazi iz poluga 1+2; audit je
   safety-net za ljudski pregled. Empirijski (video `vq65cKlbMjs`): na haluciniranom članku
   flag-a točno 6 izmišljenih identiteta (Alen Hržica, Klaudija Popović, Tiho Orlić, Marija
   Husar Rimac, Ivana Husar Mlinac, Opća Opasnost), na ispravljenom 0.

Testovi: `node --test generate_article_gemini.test.js` (suite "atribucija govornika —
chapter-mapa i strict-mode").

## Novi/izmijenjeni alati iz ove sesije

- **`force_upload.js`** (novo) — direktan S3 PutObject preko IMMUTABLE `data/{vid}/*.json`
  ključeva koje `upload_to_r2.js` LIST-once preskače, + Cloudflare purge. Uporaba:
  `node force_upload.js --video-id VID --channel CH [--targets article,magisterium,article-en,magisterium-en]`.
  Rješava memory-anti-pattern `upload_r2_data_dir_immutable_force_pattern`.
- **`translate_to_english.js`** — dodan `parseFirstJsonObject()`: `gemini-3.5-flash` zna
  (deterministički, temp=0) vratiti valjani `{"en":…}` pa nadovezati dodatni sadržaj →
  `JSON.parse` je rušio cijeli fajl ("Unexpected non-whitespace character after JSON").
  Sada se izvlači prvi balansirani JSON objekt (poštuje stringove/escape). Bez ovog fixa
  EN prijevod članka/magisteriuma nije prolazio.
- **`magisterium_doc_urls.json`** — +2 keš unosa (Psalam 139 "O where can I go", Pro-Life
  Constitutional Amendment).

## Slučaj 2 (2026-07-29): `cb4CsFDCDho` — "Ivan Voras" umjesto Saše Tenodija (2-speaker podcast!)

Dokaz da problem NIJE ograničen na highlights videe s 20+ govornika: klasičan 1-na-1
podcast (Moć komunikacije E066), diarizacija savršena (2 govornika), strict-atribucija
AKTIVNA s injektiranom chapter mapom — i Gemini 3.5 Flash je svejedno voditelja kroz
cijeli članak imenovao **"Ivan Voras"** umjesto **Saša Tenodi**.

### Uzročni lanac (svaka karika nužna)

1. **ASR trigger**: Canary je `00:00:31` krivo čuo *"…moj **i Vorasov** podcast, Surove
   strasti…"* kao *"…moj **VORASO** podcast, SURVE strasti…"* — iz krivog transkripta
   se čita kao da govornik kaže "moj Voraso podcast".
2. **Parametarsko znanje**: model zna da je "Surove strasti" podcast Ivana Vorasa →
   zaključio da je govornik Voras i **dopisao ime "Ivan" kojeg nema nigdje u ulazima**
   (direktno kršenje strict klauzule).
3. **Informacijska rupa**: summary korak (koji vidi opis epizode) je točno napisao
   "voditelj Saša Tenodi" — ali article korak opis/summary **uopće nije dobivao**.
4. **Audit rupa**: pravilo "bar polovica tokena potvrđena" — "voras" stem-matcha krivo
   čuti "VORASO" iz transkripta → 1/2 tokena = prolaz. Flagan samo "Good Will Hunting".

### Empirijski test modela (slijepi, identični ulazi kao produkcija)

Strict klauzula + chapter mapa + početak transkripta (s zamkom), bez ikakvog spomena
problema: **Claude Opus (2 runa) i Claude Haiku (1 run) svi točno** — gošća Lucija
Adžić iz mape, voditelj = neutralno "voditelj" uz eksplicitno obrazloženje da ime nije
potvrđeno. Zaključak: Flash je i prekršio uputu i upao u zamku; Claude modeli (čak i
fast tier) nisu. → Odluka: **Claude Opus default za korake 7+8** (nightly
`--gemini-backend claude` + `CLAUDE_MODEL=opus`; pipeline.domovina.ai v0.15.0 default
`claude:opus` za nove jobove). Haiku je prošao test ATRIBUCIJE, ali kvaliteta pisanja
dugog članka nije testirana — ne koristiti bez A/B usporedbe.

### Poluga 4 — SLUŽBENI KONTEKST EPIZODE (implementirano 2026-07-29, f712a1f)

`buildOfficialContextBlock()`: naslov+kanal iz `.info.json` + mapa govornika **po
diarizacijskim oznakama** iz summary sidecar-a (`summary.speakers[]: {id,
suggested_name, role}` — summary vidi opis epizode pa je pouzdan izvor). Blok ide u
OBA prompta (outline + iteracije), eksplicitno POBJEĐUJE ASR transkript i aktivira
strict mod. Usput popravljen bug: `loadSummaryMentioned` je čitao polja s vrha
sidecar-a, a stvarna struktura ih gnijezdi pod `summary` — signal je bio tiho prazan.

### Audit: SVI tokeni (ne "bar polovica")

`auditNames()` sada traži da SVAKI značajni token imena bude u allowlisti. Trošak:
pokoji benigni lažni pozitiv (npr. "Good Will Hunting" — film stvarno spomenut u
razgovoru); audit samo upozorava, ne blokira.

### Doslovni zapis imena (2026-07-29, druga iteracija)

Opus je "Lucia Adžić" (točan zapis iz naslova/opisa!) normalizirao u "Lucija" —
uslužno "pohrvaćivanje" koje je krivo jer se osoba stvarno zove Lucia. Fix u OBA
prompta (summary 3b + strict klauzula): ime iz metapodataka izdavača prepisuje se
DOSLOVNO u nominativu, bez pravopisne korekcije; padeži se tvore od izvornog zapisa.
U official bloku: kod razlike zapisa naslov > mapa.

### Runbook: ručna regeneracija epizode (tri sloja cachea)

Brisanje artefakata NIJE dovoljno — treba očistiti:
1. done-cache liste `storage/output/*-done.json` (articles, summarize, rag-{chunks,combined,import})
2. `.r2_keys_cache.json` u rootu repoa (upload preskače postojeće ključeve; `data/{id}/*.json` je immutable 1y)
3. Cloudflare edge purge (API token `DOMOVINA_AI_CLOUDFLARE_API_TOKEN_PURGE_CACHE` u `.env`; skripta sama purga samo .mp4)
Plus: browseri koji su stranicu već otvorili drže stari `article.json` (immutable) do
hard refresha. Magisterium artefakt regeneriranog članka obrisati s R2 i re-triggerati
iz admina.
