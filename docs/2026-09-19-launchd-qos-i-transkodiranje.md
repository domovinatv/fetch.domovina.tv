# launchd QoS: zašto je nightly četiri mjeseca radio 12,7× sporije

**Datum:** 2026-09-19
**Kod:** `automatic/launchd/*.plist`, `backfill_video_h264.js`, `generate_webp_thumbs.js`
**Vezani dokumenti:** [KORAK 2.8](2026-09-19-speechmatics-kostur-gemini-sluh.md),
[Claude prozor kvote](2026-08-26-claude-window-ograda.md),
[konvergencija pipelinea](2026-08-28-konvergencija-pipelinea.md)

---

## Zaključak u jednoj rečenici

`ProcessType=Background` u launchd plistu nije zaštita od gašenja nego **QoS
klasa koja job i svu njegovu djecu vezuje na efficiency jezgre** — i stajala nas
je faktora 12,7 na svakom CPU koraku, od 2026-05-26.

---

## 1. Kako je otkriveno

Korak 12.5 (H.264 transkodiranje) vrtio se 28 minuta na epizodi od 161 minute i
nije bio pri kraju. Sumnja je isprva pala na enkoder.

Mjerenje iste produkcijske naredbe **izvan** launchd-a, na istom stroju, u istom
trenutku, na 120-sekundnom isječku iste snimke:

```
120 s videa za 4,1 s  =  29,0× realtime
ekstrapolacija na 161 min: 6 min
```

Šest minuta naspram 28-i-još. Razlika od ~15×, a disk je mjeren na 746 MB/s i
nije bio usko grlo.

Procesi su pritom bili na **52–66 % CPU-a** — dakle po jednoj jezgri, dok je
benchmark koristio sve. To je uputilo na raspoređivanje, ne na kod.

## 2. Dokaz

```bash
# normalni QoS
ffmpeg … -c:v libx264 -preset medium -crf 30 …

# background QoS (isto što launchd radi plistom)
taskpolicy -b ffmpeg … -c:v libx264 -preset medium -crf 30 …
```

| režim | brzina |
|---|---|
| normalni QoS | **27,9× realtime** |
| `taskpolicy -b` | **2,2× realtime** |

**12,7× razlike.** Poklapa se s opaženih ~1,9× u stvarnom runu.

> 📌 **Dijagnostički recept:** ako CPU korak pod launchd-om ispada neobjašnjivo
> spor, usporedi naredbu sa i bez `taskpolicy -b` prije nego diraš kod.

## 3. Koliko je koštalo

Iz nightly logova, najveće trajanje po noći:

| log | KORAK 6 (pyannote) | KORAK 12.5 (H.264) |
|---|---|---|
| 2026-09-15 | 39 m 21 s | **98 m 09 s** |
| 2026-09-16 | 2 m 51 s | 8 m 24 s |
| 2026-09-17 | 4 m 15 s | 10 m 27 s |
| 2026-09-18 | 20 m 40 s | 55 m 46 s |

Uz faktor 12,7 to su ~8 min odnosno ~3 min. Pogađalo je **sve** CPU korake
(diarizacija, transkodiranje, slike), u sva tri joba (`nightly`, `priority`,
`magisterium`), od prvog commita plista.

**Vjerojatna sekundarna posljedica:** dugi rep nightlyja. `docs/2026-08-26-claude-window-ograda.md`
bilježi runove od 4 h 31 m i 6 h 37 m, zbog kojih je izgrađen cijeli
`claude-window` arbitar sa 17 testova. Koraci 7+8 čekaju mrežu i njih QoS ne
usporava, pa nije sav rep odavde — ali CPU koraci su bili ozbiljan doprinos.

**Tercijarna posljedica:** pyannote koji radi 12× dulje 12× dulje drži memoriju i
swap. Disk ograda od 12 GB (koja je 19.09. srušila nightly) postoji baš zbog tog
pritiska.

## 4. Popravak

`Background` → `Standard` u sva tri plista, kopirano u `~/Library/LaunchAgents/`,
`launchctl bootout` + `bootstrap`.

Jobovi idu noću kad nitko ne radi na stroju, pa nema razloga štedjeti jezgre.

---

## 5. Odbačena alternativa: `h264_videotoolbox`

Prva hipoteza bila je da hardversko enkodiranje rješava sporost. **Izmjereno i
odbačeno**, na 120 s isječka:

| varijanta | vrijeme | veličina |
|---|---|---|
| `libx264 -preset medium -crf 30` | **4,3 s** | **3,8 MB** |
| `h264_videotoolbox -q:v 55` | 4,2 s | 8,4 MB |
| hw dekodiranje + `h264_videotoolbox` | 4,2 s | 8,4 MB |

**Ista brzina, 2,2× veće datoteke.** Na 3300 epizoda to je stotine gigabajta
viška na R2 bez ijedne sekunde dobitka.

Razlog: izvorni video je **AV1 640×360**. Na toj rezoluciji softverski enkoder
je već 29× brži od realnog vremena — nema što ubrzati. Hardversko enkodiranje
pobjeđuje na 1080p/4K, gdje libx264 pada ispod realnog vremena.

> ⚠️ Uz to: `h264_videotoolbox` **ne podržava `-crf` ni `-preset`**. Naivna
> zamjena bi tiho promijenila kvalitetu jer bi ti flagovi bili ignorirani.

**Nije trajno isključeno** — ako katalog ikad dobije 1080p izvore, vrijedi
ponoviti mjerenje.

---

## 6. Usput: KORAK 9.7 nikad nije radio

Otkriveno u istom prolazu, jer je preglednik vratio 404 na
`images/aue1GuuMsbA/thumb-1280.webp` za epizodu koja je inače bila kompletna.

`generate_webp_thumbs.js` je listao kanale s:

```javascript
.filter((e) => e.isDirectory())
```

Svi kanali u `storage/output/` su symlinkovi na vanjske diskove, a za symlink
`withFileTypes` vraća `isDirectory() === false`. Lista kanala je bila **prazna**,
pa je korak svaku noć javljao „Nema ničega za obraditi" — u manje od sekunde,
što je izgledalo kao uredan no-op.

Točno zamka koju `CLAUDE.md` opisuje pod „Symlink gotchas", i ista klasa greške
koja je 26 noći držala Modal na nuli kandidata
(`docs/2026-08-28-konvergencija-pipelinea.md`).

Nakon popravka: **130 epizoda, 387 varijanti, 5,9 s.** Varijante su 6,8× manje od
originalnih PNG-ova.

> 📌 **Pouka šira od ovog kvara:** „0 kandidata" i „nema ničega za obraditi" su
> stanja koja iz loga izgledaju identično uspjehu. Svaki korak koji može tiho
> vratiti nulu trebao bi ispisati i **koliko je direktorija/datoteka uopće
> vidio**, da se prazan skup razlikuje od praznog pogleda.

---

## 7. Otvoreno

1. **Nije izmjeren nightly nakon popravka.** Očekivanje je da 12.5 padne s ~70 na
   ~6 min, ali to treba potvrditi sljedećom noći i usporediti s brojkama iz §3.
2. **`thumb-*.webp` varijante nisu na CDN-u** — generirane su lokalno 19.09., ide
   ih uploadati sljedeći nightly (KORAK 12).
3. **Koliko epizoda uopće ima lokalni `.png`** — popravljeni korak je našao 130 od
   ~3300. Ostale nemaju izvor; postoji `--from-cdn` put koji nije pokrenut.
