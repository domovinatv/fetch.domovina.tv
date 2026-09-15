# EN prijevod i EPUB backfill — izmjereno 15.09.2026.

Sve brojke u ovom dokumentu su **izmjerene u produkciji tog dana**, ne procijenjene.
Gdje je nešto izvedeno računom, piše da je izvedeno. Gdje mjerenje nije pouzdano,
piše zašto.

Vezani dokumenti: `docs/2026-09-15-linkovi-kroz-domovina-ai.md` (zašto je backfill
uopće pokrenut), `docs/ebook_epub_pipeline.md` (EPUB korak i englesko izdanje).

---

## 1. EPUB backfill — linkovi kroz domovina.ai

| faza | brojka |
|---|---|
| regenerirano knjiga | **3 331** (3 292 HR + 39 EN) |
| grešaka | 0 |
| brzina | ~43 knjige/min |
| prvi prolaz prekinut na | 2 914 / 3 292 (memorijski pritisak, Docker VM) |
| nastavak (`--older-than`) | 376 knjiga |
| poslano na R2 | **3 277 PUT**, 4,25 GB, 0 grešaka, ~11,8 knjiga/s |
| CDN purge | **6 554 zapisa** (3 277 URL-ova × 2 `Vary: Origin` varijante) |
| provjera | `curl` s `Origin` headerom, uzorak 6 knjiga → **0** `href` prema YouTubeu |

Dvije nepravilnosti otkrivene usput:

- **15 epizoda postoji i u kanalu i u `_unlisted`** → isti CDN ključ iz dva izvora.
  Bez razrješenja upload ovisi o redoslijedu čitanja direktorija.
- **3 knjige na CDN-u nemaju lokalni izvor** (`6dcab9c9837`, `cd7ac05aabf`,
  `eab99cbaefd`) — sintetički Beamly ID-evi, ostaju sa starim linkovima.

Nightly pokrenut ručno (`launchctl kickstart`) u 16:03, gotov **16:23 (19 min 38 s)**,
svi koraci OK. Njegov obračun Claude Code potrošnje za korake 7+8, 67 videa:

```
ulaz 92.204 · cache upis 19.295.256 · cache čitanje 416.891.157 · izlaz 3.605.834
```

Svježeg ulaza je malo jer se transkript čita iz cachea.

---

## 2. Englesko izdanje knjige

| | |
|---|---|
| EN članaka na disku | 47 |
| izrađenih EN knjiga | **39** |
| bez knjige | 8 — prijevod postoji samo za **stariju** verziju članka od one koja se servira |

Tih 8 je razlog za cijelu analizu koja slijedi.

---

## 3. Prijevod 8 epizoda — što se stvarno dogodilo

`translate_to_english.js`, model `gemini-3.8-flash`, global endpoint, projekt
`bimbo-sync-prod`, sekvencijalno.

| epizoda | poziva | trajanje | s/poziv | ishod |
|---|---:|---:|---:|---|
| `CUJmOc91C64` | 75 | 6,8 min | 5,4 s | ✅ |
| `6ueR_Leq6uE` | 188 | 18,2 min | 5,8 s | ✅ |
| `pDrMN_ysSDA` | 385 | 42,7 min | 6,6 s | ✅ |
| `fO7iltytw0I` | 388 | 70,1 min | 10,8 s | ✅ |
| `biRibr8NByE` | 418 | **153,0 min** | **22,0 s** | ✅ |
| `Is7ZDbWCu0k` | — | 6,5 min | — | ❌ 429, `MAX_RETRIES exceeded` |
| `ZkMcSRvajCw` | — | ~29 min | — | prekinut na zahtjev |
| `h_6vqQEL2uc` | — | — | — | nije započet |

**5 dovršenih epizoda = 1 454 poziva u 4,85 h, prosjek 12,0 s/poziv.**
Ukupno utrošeno vrijeme s prekinutom epizodom: ~5,4 h.

Raspon 5,4 → 22,0 s/poziv uz identičnu arhitekturu i isti model pokazuje da vrijeme
ne određuje veličina članka nego koliko je 429 naleta zapelo usput.

> **Ograda mjerenja:** wrapper skripta propuštala je izlaz kroz `tail -20`, pa je
> detalj po pozivu (svaki 429 i njegovo čekanje) izgubljen. `s/poziv` je zato izveden
> iz ukupnog trajanja, a ne iz zbroja čekanja. Sljedeći put log ide nekraćen.

### Zašto je `Is7ZDbWCu0k` pala

Stari backoff je bio linearan: 3-6-9-12 s kroz 5 pokušaja = ~45 s ukupnog čekanja,
kraće od tipičnog 429 naleta. Zamijenjen eksponencijalnim (3→6→12→24→48→60 s, jitter,
8 pokušaja). `biRibr8NByE` je nakon te promjene preživjela nalete — cijena je 153
minute, ali epizoda nije izgubljena.

---

## 4. Gdje odlazi vrijeme — anatomija poziva

Tri epizode, **1 191 poziv ukupno**:

| polje | poziva | udio | znakova | prosjek |
|---|---:|---:|---:|---:|
| content | 103 | 9 % | 145 201 | 1 410 z |
| subtitle | 103 | 9 % | 7 778 | 76 z |
| screenshot_description | 103 | 9 % | 9 080 | 88 z |
| theme | 6 | 1 % | 840 | 140 z |
| **keywords** | **485** | **41 %** | 8 182 | **17 z** |
| **entities** | **391** | **33 %** | 4 144 | **11 z** |

**74 % poziva prevodi pojedinačne riječi, a te riječi čine 8,5 % teksta.**
Pri 5,5 s/poziv to je ~80 od 109 minuta.

### Latencija gotovo ne ovisi o duljini

Probe, isti model i endpoint, 3 mjerenja (min / prosjek / max):

```
1 riječ (17 z)              1,88 / 2,79 / 3,76 s
dugi odlomak (1400 z)       7,98 / 10,23 / 11,64 s
10 riječi u JEDNOM pozivu   2,74 / 6,04 / 8,15 s     (2 od 3 poziva dobila 429)
```

Deset riječi odjednom košta koliko i jedna. Trošak je round-trip i obrada prompta.

### System prompt se ponavlja uz svaki poziv

**2 275 znakova ≈ 570 tokena** pravila ide uz svako polje. Za prijevod riječi
„Photomath" pošalje se 570 tokena uputa i 3 tokena sadržaja.

---

## 5. Kvota na `bimbo-sync-prod` — što Vertex zapravo dopušta

Očitano iz `gcloud alpha services quota list --service=aiplatform.googleapis.com`,
base model `gemini-3.8-flash-qcd`:

| kvota | vrijednost |
|---|---|
| ulazni tokeni / min (global) | **50 000 000** |
| ulazni tokeni / dan (global) | **5 000 000 000** |
| **zahtjeva / min** | **nema bucketa → `effectiveLimit: None`** |

Eksplicitan RPM imaju samo neki modeli (`gemini-3.5-flash-cyber` i `*-early-exp`: 250,
`gemini-1.5-flash`: 5, TTS varijante: 10). Za 3.8-flash ga **nema**, što znači
**Dynamic Shared Quota** — bez rezervacije po projektu, kapacitet dijeljen i
best-effort. 429 zato dolazi u naletima i ne otključava se plaćanjem.

Naša potrošnja u odnosu na strop: ~6,6 k tokena/min = **0,013 %** od 50 M/min.
Jedna epizoda ≈ 240 k tokena = 0,005 % dnevne kvote.

Burst probe (15 uzastopnih poziva, dok paralelno radi prijevod):
**15/15 OK u 22,4 s ≈ 40 uspješnih zahtjeva/min.** Kvota, dakle, nije stalno
neprijateljska — periodično je.

**Zaključak: ograničenje su zahtjevi, ne tokeni.**

---

## 6. Trošak

| | |
|---|---|
| po epizodi | **~$0,24** |
| 8 epizoda | ~$1,93 |
| cjenik (promo do 31.12.2026.) | $0,75 / M ulaz, $3,75 / M izlaz |

Katalog, izvedeno iz uzorka od 250 članaka (prosjek **19 482 znaka** i **19 sekcija**
po epizodi):

```
3 292 epizode = 64,1 M znakova = 16,0 M ulaznih tokena
stvarni sadržaj:                       $12 ulaz + $66 izlaz = $78
ponovljeni system prompt (polje-po-polje): 750 M tokena     = $563
```

**87 % troška nije prijevod nego ponavljanje uputa.**

---

## 7. Koliko bi manje poziva značilo — mjereno na `biRibr8NByE`

Cijeli članak: 35 sekcija, 69 288 znakova ≈ **17 322 tokena** (model daje 64 k
izlaznih, dakle stane i odjednom).

| granularnost | poziva | pri 10 s/poziv |
|---|---:|---:|
| polje-po-polje (sada) | 418 | ~70 min |
| **po sekciji** | **35** | **~6 min** |
| po iteraciji | 2 | ~20 s |
| cijeli članak odjednom | 1 | ~10 s |

Po sekciji: prosjek **494 tokena** po pozivu, najveća sekcija **826** — daleko od
ikakvog limita, uz zadržanu zrnatost oporavka.

Ne bih išao na maksimum: kod „cijeli članak odjednom" jedan MAX_TOKENS ili malformed
JSON košta cijelu epizodu (zato `generate_article_gemini.js` i ima JSON-repair
pipeline), a poravnanje `keywords_en.length === keywords.length` postaje neprovjerljivo.

---

## 8. Rječnik/cache — izmjereno na 250 članaka

```
keywords: 20 938 pojava → 10 330 jedinstvenih   (51 % bi bio cache hit)
entities: 12 688 pojava →  3 971 jedinstvenih   (69 % cache hit)
```

A na već prevedenim člancima: **64 % entiteta vrati identičan tekst** (2 139 identičnih
naprama 1 223 promijenjenih). Model plaćamo da prepiše „Photomath" u „Photomath".
Stvarne promjene izgledaju ovako:

```
Nadbiskupija Toronto      → Archdiocese of Toronto
Pontifikalni istočni institut → Pontifical Oriental Institute
sv. Filip Nerej           → Saint Philip Neri
Kanada                    → Canada
```

Trajni glosar znači da se pojam u katalogu prevodi **jednom**, ne 3 292 puta — i da
terminologija postane konzistentna, što per-call prijevod ne jamči.

---

## 9. Alternative

| opcija | učinak | trošak/rizik |
|---|---|---|
| **A. batch po sekciji** | 418 → 35 poziva/ep; 40–153 min → ~6 min | jedna funkcija; traži provjeru poravnanja |
| **H. ne prevoditi vlastita imena** | −33 % poziva odmah | heuristika, mora imati fallback |
| **B. glosar/cache** | −51 % keywords, −69 % entities; konzistentna terminologija | mali modul, trajna datoteka |
| **C. Vertex Batch Prediction** | izvan online DSQ pritiska, ~50 % jeftinije | asinkrono (sati); jedini put za katalog |
| **D. Claude Code pretplata** | marginalno $0, nula Vertex kvote | ~240 k tok/ep → katalog ~790 M = izvan pretplate; samo ad-hoc |
| **E. lokalni LLM (M4 Pro)** | $0, bez kvote | okupira stroj koji dijarizira; kvaliteta HR→EN nedokazana |
| **F. DeepL / Cloud Translation** | visok RPM, glosar, nema parafraze | po znaku skuplje na razini kataloga; **cjenik provjeriti** |
| **G. Provisioned Throughput** | ukida DSQ i 429 | mjesečna obveza; tek ako prijevod postane kontinuiran |

Redoslijed koji ima smisla: **A + H sada**, **B** kao sljedeći korak, **C** kad se ide
na katalog, **D** za prioritetne epizode.

---

## 10. Otvoreno na kraju dana

- tri prijevoda nedovršena: `Is7ZDbWCu0k` (pao na 429), `ZkMcSRvajCw` (prekinut na
  ~29 min), `h_6vqQEL2uc` (nije započet). Prekid nije ostavio krnje datoteke —
  skripta zapisuje `.en.json` tek kad je epizoda cijela prevedena.
- četiri gotova prijevoda još nemaju EN knjigu (`pDrMN_ysSDA`, `CUJmOc91C64`,
  `biRibr8NByE`, `fO7iltytw0I`) — nightly u 01:00 sagradit će ih u KORAKU 9.8 i
  objaviti u KORAKU 12.
- batchanje (A + H) nije izvedeno — čeka odluku.
- `.canary.summary.md` i dalje nema R2 mapping u `getFlutterKey()`.
- tri CDN knjige sa sintetičkim ID-evima ostaju sa starim linkovima.
