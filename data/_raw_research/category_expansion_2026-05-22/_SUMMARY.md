# Bulk discovery — Faza 1 (2026-05-22)

> **Cilj**: prvi batch eksperiment "registry kao sveobuhvatan katalog hrvatskih podcasta" vision-a (vidi `docs/registry_vision.md`). Target 5 underrepresented kategorija u trenutnom 137-entry registry-ju.
>
> **Status**: research artifacti — NIJE još integrirano u `data/podcasts_registry.json`. Treba ručna selekcija per kandidat (svaki ima `confidence` level i `evidence` field).

## Ukupno

**128 novih kandidata** preko 5 paralelnih research agenta s firecrawl-search / WebSearch:

| Kategorija | Total | High | Medium | Low | Active | Dormant/Dead |
|---|--:|--:|--:|--:|--:|--:|
| science | 17 | 15 | 2 | 0 | 17 | 0 |
| tech | 30 | 14 | 12 | 4 | 23 | 7 |
| arts_film | 27 | 13 | 14 | 0 | 27 | 0 |
| history | 23 | 13 | 7 | 3 | 17 | 6 (5 unknown + 1 ended) |
| regional | 31 | 27 | 4 | 0 | 30 | 1 (completed) |
| **TOTAL** | **128** | **82** | **39** | **7** | **114** | **14** |

## Platform diversity (validira schema migration potrebu)

Iz svih 128 kandidata:
- **YouTube**: 86 (67%)
- **Apple**: 15 (12%)
- **Web**: 13 (10%) — vlastiti hosting / Podbean / SoundCloud
- **Spotify**: 10 (8%)
- **Podbean**: 3 (2%)
- **SoundCloud**: 1 (<1%)

Trenutni schema je YT-centric (`youtube.url/handle/type`). **~33% novih kandidata je primary-non-YouTube** — apple-only, spotify-only ili web-hosted. To definitivno potvrđuje Fazu 2 vision-a (multi-platform schema migracija).

## Top findovi per kategorija

### Science (15 high)
- **MUZZA** — `@udrugamuzza`, dva podcasta na zajedničkom kanalu, UniZG partnership
- **DigiLab NSK** — institucionalna NSK platforma, 6 sub-podcasta
- **Akademski podcast (Sveučilište u Zagrebu)** — službeni univerzitetski
- **Ruđerov interaktivni labos** — IRB službeni
- **Andromeda** — 27-god HRT astronomska emisija, ~500 epizoda, Apple Podcasts
- **BIOcast** (BIUS biologija), **Doturska Ćakula** (MEFST), **Znanost bez filtera** (Institut Pilar 2025), **Povcast** (FFZG povijest), **SocCast** (FHS sociologija)

### Tech (14 high)
- **Well Founded** (CISEx + Croatian Startup Association, ~29 ep, long-form)
- **Nominis** (Neuralab + eCommerce Hrvatska, ~80 ep) — najveći eCommerce podcast u regiji
- **Spanoptic** (Span, enterprise IT/cybersec)
- **Highway to Scale** (Bornfight, EN weekly, scale-up founders, ~60 ep)
- **Razgovori o slobodnom softveru** (podcast.linux.hr, FOSS) — Pavlinušić, Miletić, Košturjak
- King ICT Press Play, ICT Insider (Lider+A1), Games Croatia (HAVC), Alice in Blockchains, Kompare.hr AI Podcast (prvi 100% AI HR), Voices of The Future, Global Fokus (N1)

### Arts/film (13 high)
- **Beli Zagreb Grad** — cross-cutting kultura/glazba/kazalište/film/književnost, NSK-backed
- **Casting — HNK Split** (28+ ep) — institucionalna teatar produkcija
- **Književni HKZ za slijepe** (40+ ep) — Karakaš, Rudan, Talajić, Novak
- **Između redaka / Hoću knjigu** (120+ ep) — najveći književni po volumenu
- **Osvrtnik (Srđan Cvitan)** (100+ ep) — najpoznatiji HR YT filmski kritičar
- Aleks' Comedy Set, LAJNAP, Fakin El, Artivist, Dizajn Priča, Kulturpunkt, DigiLab NSK ekosistem

### History (13 high)
- **Kontrapovijest (Hrvoje Klasić)** — 65+ ep, FFZG prof, YT + Apple/Spotify
- **Povcast (FFZG)** + **Povijesne kontroverze (HR3, Mihaljević/Ravančić)** — akademski
- **HIP Zagreb YT** + **Matica hrvatska YT** + **TV kalendar (HRT, 13850+ ep)**
- **Treća povijest (Tvrtko Jakovina)** — završen ali arhiviran, 94 ep
- **Domoljubni radio "Vrijednosti Domovinskog rata"** — UHBDR 121. brigade
- **Podcast Sekstant** (Davor Marijan), **Remembering Yugoslavia** (Peter Korchnak, 200+ ep, dijaspora)

### Regional (27 high)
- **Studia Croatica** (Argentina, 65+ god institucija, aktivan YT)
- **Mladi za Domovinu** (FeedSpot top 35, weekly long-form, 40+ ep)
- **VTV** (prva regionalna TV u HR, 60% vlastite produkcije, ~30 emisija)
- **Paul Bradbury Croatia Expert** (active weekly, expat/returnee fokus, TCN povezan)
- **Glas Hrvatske HRT** (službeni diaspora channel, multilingual)
- Regionalni mediji: Slobodna Dalmacija, Glas Slavonije, STV, Glas Istre, Novi list, Kanal Ri, VTV
- Dijaspora pokriva: Argentina, USA, Canada, Australia (SBS+Macquarie), Germany, NZ

## Methodology insights

**Što je radilo**:
- Ime-specifične pretrage (`"BIOcast" BIUS`, `"Akademski podcast"`) — direktna verifikacija
- Hub aggregators: **Netokracija "Veliki vodič hrvatskih podcasta"** + **Manjgura vodič** + **FeedSpot 35 Best Croatia** = master-listi za seed kandidate
- Institucionalni pattern: tvrtka/sveučilište/udruga + "podcast" — Span, Bornfight, FFZG, MUZZA itd.
- **DigiLab NSK ekosistem** otkrio 6 institucionalnih odjednom

**Što nije radilo**:
- Generičke pretrage tipa "hrvatski znanstveni podcast" → samo recikliraju već poznate
- Spekulativni nazivi bez bazne reference
- Pretrage po fakultetima koji nisu STEM povezani

**Filtrirano kao non-HR**: Filmoholik (srpski), Filmologija (slovenski), Filmogram (srpski), Filmocracy (US), POP Kultura (srpski), Tin Vodopivec (slovenski). Drugastrana.rs i NT Podkast također skipnuti.

**Firecrawl credits**: 3 od 5 agenata pogodila out-of-credits, prebacila se na WebSearch+WebFetch. Output je strukturalno identičan — workflow je platform-resilient.

## Integration TODO (sljedeća sesija)

1. **Review per kandidat** — manualno proći kroz 128 entries i odabrati koje ići u registry. Default: svi high-confidence (82) bi trebali biti added; medium/low traže pažljiviji pogled.
2. **Apply integration script** — za svaki accepted kandidat, generirati registry entry s pravom strukturom:
   - Trenutno YT-centric schema → privremeno hack-irati Spotify/Apple-only u `youtube.url` polje s `type: "external"` (mostrnik), ili
   - Inicirati schema migraciju (Faza 2 vision-a) prije nego se dodaju
3. **`data_quality` default**: research-derived entries idu kao `partial` (nije verified bez voditelj-match), `sources: ["bulk_discovery_2026-05-22"]`
4. **Schema migration FAZA 2 trigger**: out of 128, ~42 entries imaju non-YouTube primary platform. Integracija ovih sa YT-only schema-om je friction signal — bolje migrirat schema prije masovne integracije
5. **Frontend update** — kad se schema migrira, dodati `platform_primary` filter chip; postoji `_existing_in_categories.json` za referencu što je već u registry-ju

## Files

```
data/_raw_research/category_expansion_2026-05-22/
├── _SUMMARY.md                       ← ovaj fajl
├── _existing_in_categories.json      ← što je već u registry-ju (dedup context)
├── science.json                      ← 17 kandidata
├── tech.json                         ← 30 kandidata
├── arts_film.json                    ← 27 kandidata
├── history.json                      ← 23 kandidata
└── regional.json                     ← 31 kandidata
```
