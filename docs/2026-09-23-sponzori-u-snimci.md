# Sponzori ugrađeni u snimku — `sponsors_in_video.json` (KORAK 9.85)

**Datum:** 23.09.2026.
**Skripta:** `detect_sponsors.js` (+ `detect_sponsors.test.js`)
**Izlaz:** `{base}.sponsors_in_video.json` → CDN `data/{id}/sponsors_in_video.json`

## Zašto

Sponzor kojeg je autor sam doveo nije YouTube-ov oglasivač nego partner koji je
omogućio snimanje. Ne sakrivamo ga i ne preskačemo — Flutter mu daje vidljivo mjesto
i gumb „poslušaj" za točan raspon u snimci.

Ime datoteke je namjerno `sponsors_in_video`: to su sponzori **ugrađeni u snimku**.
Dinamička sponzorstva koja se na domovina.ai kupuju **nakon** snimanja zaseban su
proizvod i zaseban izvor podataka — ne miješati.

Povod: Iva Kraljević ep. 50 (`aue1GuuMsbA`). LLM outline je produciran spot
„e-Duhovne vježbe" (01:39:24–01:40:06) tiho utopio u susjedno poglavlje čija slika
počinje tek na 01:43:05 — klik na poglavlje preskočio je oglas. U promptovima nema
nijednog pravila o sponzorima; model odlučuje sam, svaki put drukčije.

## Kako radi — bez LLM-a

| Izvor | Daje |
|---|---|
| `{base}.description` / `info.json.description` | TKO: ime, uloga, URL, Instagram, reklamni tekst |
| `info.json.chapters` | autorova poglavlja („Grickaj i biraj uz Plazmu", „e-Duhovne vježbe") |
| `{base}.wav.canary.diarized.srt` | GDJE: vremenski rasponi (isti transkript kao `data/{id}/diarized.srt`) |
| opisi ostalih epizoda kanala | aliasi sponzora kojeg autor u OVAJ opis nije upisao |

Cijeli katalog (3305 epizoda) prođe za **~19 s** CPU-a.

### Vrste segmenata (`kind`)

| kind | Što je | `playable` |
|---|---|---|
| `spot` | produciran oglas: zaseban glas koji u epizodi govori < 120 s u jednom bloku ≤ 180 s, uz barem još jedan signal | da, **samo ako je sponzor imenovan** |
| `host_read` | voditelj čita poruku („Ovu epizodu podržava HiPP…") — sidro + nastavak istog govornika do 120 s | da, ako je sponzor imenovan |
| `rubric` | sponzorirana rubrika: najava s imenom + odjava („…to je bila plazma pauza"), ILI autorovo poglavlje nazvano po sponzoru | da |
| `mention` | jedna rečenica zahvale („Hvala HiPP-u koji nas podržava") | ne — samo link |
| `chapter` | generičko autorovo poglavlje („Reklama") bez potvrde | ne |

Rubovi: `floor(start) − 1 s`, `ceil(end) + 1 s`. Na Ivinom spotu to daje **5963–6008**,
identično ručno izmjerenom rasponu.

### Uloge (`role`)

`sponsor`, `partner` (i „generalni pokrovitelj"), `wardrobe` („Voditeljicu odijeva"),
`studio` („Opremanje studija pomogli"). `wardrobe`/`studio` se navode, ali se **ne
traže u transkriptu** — ne čitaju se u snimci, a imena su im preblizu običnim
riječima.

## Mjerenja (suho pokretanje 23.09.2026.)

| Kanal | Epizoda | Sa sponzorima | Segmenata (▶ playable) |
|---|---|---|---|
| rastuci_s_djecom | 31 | 27 | 49 (24) |
| iva_kraljevic | 64 | 33 | 52 (30) |
| bozanstvena_komedija | 35 | 19 | 4 (0) — patroni su samo u opisu, ne čitaju se |
| **cijeli katalog** | **3305** | **475** | **207 (65)** |

## Zamke — naučene na tri kanala

1. **Kratak zaseban glas NIJE oglas sam po sebi.** Prva verzija našla je 71 „spot" u
   katalogu; 70 je bilo bez imena sponzora — isječci, najave, pitanja iz publike
   (HNB konferencije same 18). Spot bez imena ostaje samo uz ≥ 3 signala i nikad nije
   `playable`.
2. **Samofinanciranje nije sponzor.** Patreon, PayPal, Buy Me a Coffee i domena koja
   sadrži ime kanala (`ivakraljevic.com`) se odbacuju.
3. **Naslov bloka nije ime.** „HVALA NAŠIM PATRONIMA I SPONZORIMA:", „SPONZORI EPIZODE",
   „Sponzori ❤️" su naslovi; imena su u redovima ispod.
4. **Višerječno ime ide samo kao cjelina.** „Bilje sestre Ljubice" → alias „sestre"
   pogađao je običan govor. Distinktivne riječi daje domena (`eurovip-brazil-kava` →
   „brazil").
5. **Fuzzy mora tražiti sličnu duljinu.** „hvala vam" ≈ početak od
   „hvalanasimpatronimaisponzorima" → 203 lažna spomena na jednom kanalu.
6. **Aliasi s drugih epizoda kanala samo uz sponzorsku frazu i bez fuzzyja.** Inače
   „Gojan" (studio) pogađa „Goran" u naslovu poglavlja. Iznimka: riječ kojoj fali
   zadnje slovo aliasa („hip" za „hipp") — sigurno je i bez fuzzyja.
7. **ASR i padeži.** „HIP-u", „Plasma", „Plazmi", „Angelumu"/„Angelomu" za „Angellum",
   „sponsoru" sa s. Imena iz transkripta ostaju u padežu kako su izgovorena
   („Hvaromi") — normalizacija padeža nije napravljena.
8. **Popis poglavlja u opisu** („00:56:00 - 01:00:29 | Produkcija, sponzori…") nije
   sponzor.
9. **Prazan dokument se piše uvijek.** CDN kešira 404 godinu dana (`Vary: Origin`);
   prazan `sponsors: []` znači „nema sponzora", ne „nije obrađeno".

## Glas sponzora — tko čita spot

Hipoteza (korisnik): spot e-Duhovnih vježbi čita sam fra Josip Vlašić, koji stoji iza
aplikacije. Provjereno glasovnim otiskom, model `pyannote/wespeaker-voxceleb-resnet34-LM`,
~45 s govora po uzorku, kosinusna sličnost:

| Usporedba | Sličnost |
|---|---|
| Spot ↔ Vlašić (Ad Deum `5XhBFrXb8II`, SPEAKER_00), 3 uzorka | **0.844 / 0.807 / 0.824** |
| Vlašić ↔ Vlašić (referenca) | 0.960 / 0.940 / 0.962 |
| Spot ↔ voditelj Ad Deuma | 0.095 |
| Spot ↔ Iva Kraljević | 0.154 |
| Spot ↔ Marin Periš | 0.065 |

Isti raspon kao ranije dokazana identifikacija propovjednika (0.82–0.85). Spot je
produciran (drugi mikrofon), uzorak Vlašića je studijski razgovor — razmak je i dalje ~5×.

### Trošak — embedding NIJE diarizacija

Puna diarizacija = segmentacija + embedding + klasteriranje; skupo je **klasteriranje**
(CPU-bound). Kad transkript već kaže tko govori kada, ostaje samo embedding:

| | Izmjereno (Mac Mini M4 Pro, CPU) |
|---|---|
| učitavanje modela | 5.1 s jednom po procesu |
| embedding isječka od 42 s | **0.2 s** |
| model | 6.6 M parametara |

Registar otisaka za katalog (~3 govornika × 3300 ep) ≈ pola sata CPU-a jednokratno.

### Granice pouzdanosti

1. Otisak je čist koliko i oznaka govornika u transkriptu — pomiješana dijarizacija daje
   mješavinu.
2. Ispod 10–15 s govora raspršenje raste; ciljati 30–60 s.
3. Kontrole su bile lagane (žena, jasno različiti muški glasovi). Prag za **slične**
   glasove (ista dob, naglasak, mikrofon) nije kalibriran.
4. Pretraga „tko je ovo?" preko tisuća glasova traži viši prag i razmak prvog od drugog
   kandidata — provjera jednog kandidata je lakši problem.

**Pravilo:** glas je potvrda, ne izvor imena. Ime dolazi iz opisa/transkripta, glas
potvrđuje ili predlaže, čovjek odobrava prije nego ime ode na stranicu.

## Otvoreno

- Backfill cijelog kataloga + upload (vidi `docs/2026-09-23-backfill-sponzori-i-glasovi.md`).
- Polje „narator" u `sponsors_in_video.json` — tek nad spremljenim registrom glasova.
- Normalizacija padeža izgovorenih imena („Hvaromi" → „Hvaroma").
- Uputa outline promptu da sponzorski segment ne utapa u susjedno poglavlje.
