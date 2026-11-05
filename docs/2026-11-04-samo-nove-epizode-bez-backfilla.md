# Samo nove epizode, bez backfilla (odluka 04.11.2026.)

## Odluka

Cilj pipelinea je da **svaku novu epizodu** obradi bez greške, svaki dan: Tier 1
(praćeni kanali, nightly u 03:00) i Tier 2 (sve ostale nove hrvatske epizode kroz
pipeline.domovina.ai).

- Popravak ide **samo naprijed**. Kod koji popunjava rupe dobiva granicu „od dana
  popravka” i ne dira stariji katalog.
- Stare rupe se **ne popunjavaju automatski**, ni kao usputni dio popravka.
- Backfill dolazi tek kad nightly i Tier 2 **nekoliko noći zaredom dokazano obrade
  100 % novih epizoda**. To je tada zasebna odluka, s procjenom troška i trajanja.

Zašto: backfill troši kvotu i vrijeme na stari katalog, a skriva pitanje koje je
važnije, je li pipeline za nove epizode stvarno stabilan. Rupa koja se popuni ručno
vratit će se sutra ako uzrok nije riješen.

## Kako se mjeri „100 % novih epizoda”

- `audit_pipeline.js` u nightlyju: 0 rupa (exit 0). Tihi zvuk (`.silent.json`) nije
  rupa.
- Nightly sažetak bez koraka s nenula izlazom.
- pipeline.domovina.ai: svi jobovi dana `done`, Magisterium HR/EN `done`, a na CDN-u
  postoje `article.json`, `article.en.json`, `article.magisterium.json` i
  `article.magisterium.en.json` (gdje je Magisterium uključen).
- RAG sync (domovina-rag, 05:00) unio je sve nove epizode.

## Primjer: zakašnjeli Magisterium EN (04.11.2026.)

Tier 2 epizoda u `_unlisted` dobije EN prijevod čim je HR članak na CDN-u. HR
Magisterium traka je serijska (~15 min po epizodi), pa stigne kasnije i nitko ga ne
prevede: 74 od 80 Tier 2 epizoda od 29.10. ostalo je bez
`article.magisterium.en.json`, a admin je pokazivao „EN done”.

Popravak u `automatic/enqueue_en_new.js` (`refreshMagisteriumEn`): epizoda s EN
člankom i HR Magisteriumom, a bez EN Magisteriuma, dobije prijevod samo onoga što
fali (`translate_to_english.js`), upload i `episode.json`. Granica je
`EN_MAG_LATE_SINCE` (default `2026-11-04`) po mtime-u HR Magisteriuma, pa se stare
rupe ne diraju. Najviše `EN_MAG_MAX` (3) po ticku, najviše 3 neuspjeha po epizodi
(`automatic/logs/.magisterium_en_late_state.json`).

Ostalih ~60 starih epizoda bez EN Magisteriuma čeka odluku o backfillu.

## Stanje 04.11.2026. i otvorene stavke

Nightly 04.11. (03:00–04:15) je za 4 nove epizode prošao bez greške. Popravci istog dana:

- `audit_pipeline.js` i KORAK 2.8 poštuju `.silent.json` (tihi video nije rupa).
- KORAK 12.66 (`tools/force_upload_epubs.js`) zadržava knjigu samo kad je >10 % manja od
  CDN-a. Stroga usporedba je blokirala knjige koje se razlikuju za 1–2 B (vremenska oznaka u
  `content.opf`), pa i `KLPD-Meu4e8` s dodanim Magisterium poglavljem. Audit: 100 %.
- KORAK 10: kadrovi koji padnu iz streama (YouTube 403) ponavljaju se iz lokalnog `.mkv`
  (360p) — prvi stvarni test 04.11.: 81/81 vraćeno, neuspjelih 1 (prije 57).
- pipeline.domovina.ai admin: stvarni ASR po jobu (`jobs.asr_provider`, D1 0017); Tier 2 je
  Speechmatics, Tier 1 Soniox. „🕊 EN ✓" više ne laže kad Magisterium EN ne postoji
  („🕊 EN ◐"), a `/admin/episodes` pokazuje Magisterium EN kao rupu samo kad postoje HR
  Magisterium i EN članak (77 pravih rupa umjesto ~1400).

Otvoreno:

- **RAG sync ne radi od 03.11.** Lokalni ClickHouse ne učitava `rag.rag_chunks` (175
  oštećenih dijelova) ni tablicu MV-a (177); SSD je na 98 %. Handoff:
  `../domovina-rag/docs/2026-11-04-clickhouse-broken-parts-handoff.md`.
- Provjeriti noćas da `refreshMagisteriumEn` dopuni sve nove Tier 2 epizode (u adminu nijedan
  današnji job ne smije ostati „🕊 EN ◐").
- EN Magisterium petlja za `KLPD-Meu4e8` (EN traka ga svake 2 min stavi u red) još postoji.
- Jedan kadar Sub Cluba (`0qt-wHxiFMY`, 26:50) pada svake noći — nema lokalnog videa.
- Modal Canary (KORAK 2.6) i dalje transkribira epizode koje Soniox već pokriva (namjerna
  mreža, ~$0,01/ep).

## Vezani dokumenti

- `docs/2026-11-05-dan-objave-vs-nightly-queue.md`: tri rupe zbog kojih nove epizode nisu ulazile u obradu (playliste složene od najstarijih, livestreamovi, kasni Beamly katalog), popravljene samo naprijed.
