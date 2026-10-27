# Plan: agy (tmux) fallback kad Vertex baca 429 ili ne odgovara

**27.10.2026.** · status: **PLAN, nije izvedeno**

## Zašto

EN prijevod epizode `nBPDxzrAW0Q` (Ora et Labora 120, 38 sekcija) trajao je **46 min**
umjesto uobičajenih 6–12. `translate_to_english.js` je cijelo vrijeme dobivao 429 na
eu/us i pozive **bez odgovora 180 s** na sve tri regije (global, eu, us):

| Dio | Trajanje | Normalno |
|---|---|---|
| summary | 410 s | ~30–60 s |
| article | 1732 s | ~3–5 min |
| magisterium | 613 s | ~2–4 min |

Posao nije pao (8 pokušaja, rok 220 min), ali je samo čekao. Gemini 3.8 Flash je na
Vertexu pod dijeljenom kvotom (DSQ), pa takvi nalet dolaze bez upozorenja.

## Što postoji danas

| Skripta | 429 → agy? |
|---|---|
| `screenshot_youtube.js` (best frame, od 26.10.) | **Da** — nakon 2 uzastopna 429 isti upit ide kroz agy u tmux sesiji `agyss` |
| `translate_to_english.js` (EN) | Ne — samo rotacija regija + backoff + 8 pokušaja |
| `refine_diarized_gemini.js` (Gemini sluh, 2.8) | Ne |
| `summarize_gemini.js`, `generate_article_gemini.js` | agy samo kao ručni `--gemini-backend agy`, i to preko `agy -p` koji od 1.3.5 ne vraća odgovor — taj put je mrtav |

## Plan

1. **`lib/agy_tmux.js`** — izvući iz `screenshot_youtube.js` (§ „agy FALLBACK"):
   `agyAvailable`, `agyEnsureSession` (trust upit, čekanje na „for shortcuts"),
   `agySend`, serijski red (`agyQueue`), upit → odgovor kroz **datoteke** (prompt u
   `<stem>.in.txt`, agy zapiše `<stem>.json`). Predugi prompt ne smije ići kroz
   `send-keys` — agy ga mora pročitati iz datoteke. Sesija po potrošaču
   (`agyss`, `agytr`, …) da se screenshot i prijevod ne guraju u istoj.
   `screenshot_youtube.js` prebaciti na modul (bez promjene ponašanja).
2. **`translate_to_english.js` `vertexJson()`** — nakon **2 uzastopna 429 ili isteka
   180 s** (oboje, ne samo 429 — 27.10. su timeouti koštali više) isti upit kroz agy.
   Odgovor prolazi isti `parseFirstJsonObject` + provjeru oblika bloka; ako ne prođe,
   natrag na Vertex petlju. Gasi se s `TRANSLATE_AGY_FALLBACK=0`. Prijevod kroz agy u
   metapodacima nosi `translated_by: "agy:gemini-3.8-flash-high"` (provenance).
3. **`refine_diarized_gemini.js`** — isto, ali tek nakon što 2. radi u produkciji;
   sluh šalje audio, pa agy mora dobiti putanju do isječka (provjeriti da agy čita audio
   iz datoteke kao u `~/.claude/scripts/agy_glasovna.sh`).

Test: jedna epizoda s prisilnim fallbackom (`TRANSLATE_AGY_FIRST=1`), usporedba s
Vertex prijevodom iste epizode po bloku.

## Ograničenja

- Jedna agy sesija = pozivi jedan po jedan, ~30–40 s po pozivu. Prijevod epizode je
  ~30–50 poziva → agy je **premošćivanje naleta**, ne glavni put.
- agy je na Google AI Pro pretplati ($0), ali ima vlastitu kvotu — pratiti kad
  backfill katalog krene.
- Radni dir mora biti „trusted" u agy-ju (`~/git` je trusted roditelj).

## Usput nađeno istog dana (pipeline.domovina.ai `bridge/magisterium_poller.js`)

- **Lažni `failed` nakon uspješne objave.** EN posao `fbf56654` je objavio sve tri
  datoteke, a poller je javio „nema artefakta nakon runa". Provjera u koraku 3 zove
  `artifactExists()` bez cache-bustera (kad `force=0`), na isti URL koji je korak 1
  prije runa dobio kao 404; CDN purge iz uploada još nije bio propagiran.
  Popravak: provjera nakon runa uvijek s `?x=<ts>` (ili 2–3 pokušaja s 15 s razmaka).
  Stanje je ručno vraćeno u `done`.
- **EN e-knjiga nije nastala** jer je proces krenuo (14:42) prije commita `7a859bb`
  (14:54) koji dodaje `generate_ebook.js` u EN objavu. Ručno izgrađena i objavljena.
- Poller HR trake spava 10 min između poslova i kad red nije prazan
  (vidi analizu čekanja u `docs/2026-10-27-ora-et-labora-obrada-epizode.md`).
