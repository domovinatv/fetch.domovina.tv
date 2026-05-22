# Registry vision — najopsežniji katalog hrvatskih podcasta

> **Status**: vision document, postavljeno 2026-05-22.
> **SSOT**: ovaj fajl, ne `podcasts_registry.md` (taj je auto-generirani report).

## Što registry trenutno jest

`data/podcasts_registry.json` je započet kao **interna editorial lista** za DOMOVINA pipeline — koje hrvatske podcaste vrijedi pratiti, transkribirati, obrađivati. Trenutno (137 entries) konvergira oko religijskih, sportskih i političkih tema jer je to bio inicijalni fokus istraživanja.

## Što registry treba postati

**Sveobuhvatan, javno dostupan katalog svih hrvatskih podcasta** — neovisan od DOMOVINA pipeline subset-a. Cilj: kad netko traži "koji hrvatski podcasti postoje na temu X", registry je referentno mjesto, kao **podchaser.com za hrvatsko tržište**.

Vrijednosna teza: HR podcast scena nema centralni katalog. Apple Podcasts charts su djelomični, Spotify ne pokazuje regionalne charts, podcasti.hr ne postoji kao kurirano mjesto. Treća strana koja ovo gradi sustavno + održava kvalitetom + nudi besplatan public read access ima realan brand pull. To je vrijednost za hrvatsku public, ne samo za DOMOVINA internu upotrebu.

## Konceptualna decoupling

Tri sloja, sva tri **nezavisna**:

| Sloj | Što označava | Public/Internal |
|---|---|---|
| **Registry inclusion** | Podcast postoji i mi znamo za njega | Public (katalog) |
| **`tracking.enabled`** | DOMOVINA ima editorial interes pratiti | Internal (editorial) |
| **U `refresh_podcasts.sh`** | Aktivno se povlači u pipeline | Internal (execution) |

Trenutno frontend i issue templates implicitno tretiraju ova tri kao spregnuta ("predloži za pipeline" = "predloži za registry"). To **treba odsegregirati** u sljedećoj iteraciji — registry inclusion je primarno javna funkcija, pipeline je sekundarni interni atribut.

## Inclusion criteria — nova, permisivnija

**U registry ide**:
- Bilo koji hrvatski podcast (HR jezik ili HR tematika) bez obzira na:
  - Aktivnost (živi, dormant, mrtvi — svi su katalogizirajuće vrijedni za referencu)
  - Popularnost (niche s 5 epizoda jednako vrijedan kao top chart podcast)
  - Platformu (YT, Spotify, Apple, Anchor, vlastiti web, samo audio, samo video — sve)
  - Format (long-form intervjui, dnevne news epizode, dokumentarni serijali, comedy, audio knjige)

**U registry NE ide**:
- Single-episode standalone uploads (treba serijalnost, ne nužno tjedna ali "podcast" kao format)
- Pure music streams, ASMR loops, podcast-shaped marketing channels (gdje je sadržaj nije podcast nego komercijalno objavljivanje)
- Non-HR podcasti koji se samo dotiču HR tema u izolaciji (npr. globalni geopolitika podcast s jednom HR epizodom — to nije HR podcast)

**Tier značenje** (treba revidirati):
- Trenutno: editorial worthiness za DOMOVINA tracking
- Predlog: optional popularity tier (T1=top chart, T2=well-known, T3=niche, T4=obscure/dead) — odvojeno od `tracking.enabled`

## Schema gaps koje treba popuniti

Trenutni schema je YT-centric (`youtube.url/handle/type`). Za sveobuhvatan katalog treba:

```json
"platforms": {
  "youtube": { "url": "...", "handle": "...", "type": "channel|playlist" },
  "spotify": { "url": "...", "show_id": "..." },
  "apple": { "url": "...", "podcast_id": "..." },
  "anchor": { "url": "..." },
  "web": { "url": "..." }
},
"platform_primary": "youtube|spotify|apple|anchor|web",
"language": "hr|en|other",
"activity_status": "active|dormant|dead",
"first_episode": "YYYY-MM-DD",
"last_episode": "YYYY-MM-DD"
```

Migracija starih entries: postojeći `youtube.url` ostaje važeći (back-compat); kad se novi platforms field popuni, `platform_primary` defaultira na "youtube" osim ako je drugačije.

Posljedice za "stubs" definiciju: trenutno stub = `!youtube.url`. Treba postati `!platforms.{any}.url` — entries bez ijedne platforme su pravi stubs. Audio-first podcasti (Spotify/Apple-only, no YT) su **NISU stubs** — oni su platform-diverse entries.

## Bulk discovery workflow

Trenutni "deep research" pattern (claude-opus/gemini/perplexity prompts) ne skalira dovoljno za "sve hrvatske podcaste". Sustavni pristup:

**Per kategorija** koja je underrepresented, paralelni research agent koji:
1. Pokreće 10-15 search query-ja kroz firecrawl-search
2. Verificira kandidate kroz scrape kanal/show landing page
3. Vraća strukturirane proposal-e s confidence levelom

**Cijeli prostor pretrage** koji treba pokriti:
- HR znanost, edu, popularizacija
- HR tech, IT, gaming, AI/ML
- HR film, knjizevnost, glazba, kazaliste, vizualna umj
- HR povijest (akademska, popularna, Domovinski rat, vojna)
- HR regional (Slavonija, Dalmacija, Istra, Lika, Hercegovina) + lokalni mediji
- HR dijaspora (AU, CA, US, AR, DE, BR) — često non-HR-jezicni o HR temama
- HR turizam, outdoor, putovanja
- HR mental health, parenting, self-help, lifestyle
- HR business, ekonomija, financije, startupi
- HR sport (mnoga niche — boks, košarka, šah, motoring)
- HR politika sve struje (lijevo/desno/centar)
- HR religija (sve denominacije, ne samo katolicki)
- HR humor, satira, true-crime
- HR audio-drama, fictional storytelling

Trenutni 137 entries pokriva možda 20-30% realne HR podcast scene. Reasonable target: 400-600 entries.

## Frontend implications

**Što treba dotjerati** u `dashboard/public/index.html` da reflektira katalog vision:

1. **Headline i copy** — trenutno "Podcast Registry" + DOMOVINA branding signaliziraju "internal tool". Treba: "Najopsežniji katalog hrvatskih podcasta" kao naslov, DOMOVINA kao curator/maintainer u footeru ali ne primary brand pozicija.

2. **CTA banner refraziraj** — "Predloži novi podcast" ostaje, ali bez "DOMOVINA pipeline" referenca u tekstu. Cilj: ljudi predlažu jer žele da je njihov omiljeni podcast u katalogu, ne zato što žele DOMOVINA tracking.

3. **Filter chips dodati**:
   - Platforma (YT / Spotify / Apple / multi)
   - Aktivnost (active / dormant / dead)
   - Jezik (HR / EN-o-HR)
4. **`tracked` i `in_pipeline` flags** ostaju, ali su sekundarni — možda preseliti u tooltip/expandable detail umjesto primary tag.

5. **Public-friendly view** — vjerojatno default sorting po popularnosti/activity, ne po quality_score (interna metrika).

## Brand strategija — pending odluka

Dvije varijante:

**A. DOMOVINA umbrella** (`podcast-registry.domovina.ai`): zadržati trenutno, ali smanjiti vizualnu prominenciju DOMOVINA branda. DOMOVINA = "curator". Prednost: ne treba novi domain/brand. Nedostatak: DOMOVINA ima političko-religijske konotacije koje suzuju publiku (lijevoorijentirani slušatelj nećce ozbiljno uzeti katalog koji izgleda kao desni projekt).

**B. Neutralan brand** (`podcasti.hr`, `katalog.hr`, ili sl.): odvojen public-facing brand. Tehnički ostaje pod DOMOVINA stack-om, ali public-facing je "Katalog hrvatskih podcasta — održava DOMOVINA". Prednost: širi reach, manji brand bias. Nedostatak: dodatni domain/SEO troskovi, brand fragmentacija unutar DOMOVINA ekosistema.

Trenutno: nije odlučeno. Vjerojatno prvi mjerni eksperimenta u **varijanti A** s pažljivim copy-toning prije puste odluke da se radi B.

## Maintenance posljedice

Više entries = više maintenance:

- **Dead/dormant detection** — automatski cron koji periodicno provjerava platform URL-ove (HEAD check za YT channel, Spotify API ako podijeli, Apple feed parser) + flag-ira entries gdje "last_episode" stari preko 12 mjeseci kao `dormant`, 24+ mj kao `dead`.
- **Crowdsourced correction loop** — GitHub issue intake (već imamo) postaje primarni signal za updates. Treba treći issue template tip: "Update existing entry" (promjena URL, voditelja, statusa).
- **Annual data quality pass** — manual review barem jednom godišnje da uhvatimo drift (kanali preimenovani, voditelji se promijenili, podcasti spojeni).

## Realan timeline

| Faza | Cilj | Trajanje |
|---|---|---|
| Faza 1 (sad) | 5 paralelnih bulk discovery batch-eva za underrepresented kategorije; registry 137 → ~250-300 | 1 sesija (ova) |
| Faza 2 | Schema migracija na multi-platform; populate Spotify/Apple URLs za postojeće YT entries gdje postoje | 1-2 sesije |
| Faza 3 | Frontend rebranding i copy update; UX filter chips za platforme/aktivnost | 1 sesija |
| Faza 4 | Dead-detection cron + crowdsource correction loop + annual maintenance plan | 1-2 sesije |
| Faza 5 | Brand strategija odluka (A vs B); ako B, novi domain, redirect, SEO | TBD |

## Non-goals (eksplicitno NIJE u scope-u)

- Ranking/preporuka algoritam — registry je strukturirani podatak, ne content discovery engine
- Embedded player — ne hostamo audio, samo linkamo na platforme
- Komentari/recenzije — nije Reddit, nije podchaser
- Plaćeni tier / monetizacija — javna besplatna usluga
- Non-Croatian podcasti — to je drugi katalog, ne ovaj
