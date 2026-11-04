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
