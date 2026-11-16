# re:DEFINICIJA ep. 11: Soniox vs Canary + pyannote vs Speechmatics, ista epizoda (16.11.2026.)

**Vezano:** [`2026-11-12-reelovi-za-neobjavljenu-epizodu.md`](./2026-11-12-reelovi-za-neobjavljenu-epizodu.md),
[`2026-11-14-canary-rezerva-modal-pyannote.md`](./2026-11-14-canary-rezerva-modal-pyannote.md),
[`2026-10-25-asr-prioritet-soniox.md`](./2026-10-25-asr-prioritet-soniox.md).

`RdEN7Ny1bV8` (Ante Lučić, 73:39) obrađena je dvaput:

| | Ad-hoc 12.11. | Nightly 15.11. (objavljeno) |
|---|---|---|
| Tekst | Soniox stt-async-v5 | Canary 1B v2 (Modal A100) |
| Govornici | Soniox vlastita dijarizacija | pyannote community-1 (Modal T4) |
| Cijena (1,23 h) | ~$0,15 | ~$0,20 (stvarni Modal račun, $0,13/h + pyannote) |

## Izvor Soniox strane

Originalni izlaz iz ZIP-a poslanog Krunoslavu (`~/Downloads/redefinicija_ep11_obrada.zip`):
`prijepis_s_govornicima.srt` je u `experiments/2026-11-16-ep11-soniox-vs-canary/soniox_ep11.diarized.srt`,
sirovi Soniox JSON (tokeni s confidence) uz njega, gitignored. Isporučeni SRT završava na 72:55,
bez najave sljedeće epizode, pa se uspoređuje do tamo. (Prva verzija ove analize koristila je
rekonstrukciju iz zapisnika sesije 12.11.; brojke s originalom su gotovo iste.)

## Brojke

| | Soniox | Canary + pyannote |
|---|---|---|
| riječi | 10 237 | 10 085 |
| kraj rečenice (.?!) | 542 | 485 |
| zarezi | 1 467 | 1 009 |
| podudarnost riječi (difflib) | 0,931 | |
| govornici | 2 | 3 |
| slaganje govornika po sekundi | 99,8 % (3 870 s) | |

Razlike u riječima (~7 %) su većinom sitne. Bez referentnog prijepisa sudac je jezik, ne zvuk.
Soniox je nesiguran (confidence < 0,5) na samo 47 od 10 314 riječi (0,5 %); „Paciolija” ima
0,62–0,93, „Lučić” 1,0.

## Gdje je Canary lošiji

- **Izgubio ime gosta** u uvodu: Soniox „…podcasta „Redefinicija”. Danas je s nama Ante Lučić,”,
  Canary „…našeg podcast-a Defin, suprug…”. Pozdrav „Hvaljen Isus i Marija” postao je „Hvala /
  vam, Marija” i pola je pripisano gostu.
- Fonetski pravopis: „Pačolija” (Soniox „Paciolija”, Luca Pacioli; ušlo je u objavljeni članak kao „Luka Pačoli”, name_audit ga je
  označio), „produkt dizajner”, „gikovi”, „itede” umjesto „itd.”, „osamdesettih”, „ljeganje”.
- Iskrivljene fraze: „za mirisom je” (zamirisao mi), „kartice nalazi” (karte snalazi),
  „klini ti zaspa” (klinci zaspu), „eksponencijalencijalni” (progutao pola rečenice).
- Rjeđa interpunkcija (≈ 30 % manje zareza), pa su rečenice dulje.

## Gdje je Canary + pyannote bolji

- **Najava sljedeće epizode** (72:56–73:39, drugi glas; u isporučenom SRT-u odrezana, viđeno u
  rekonstrukciji iz zapisnika): pyannote je dao zaseban SPEAKER_02, Soniox ju je pripisao gostu. Ipak, i pyannote je dodao 5 kratkih lažnih SPEAKER_02 riječi oko 49:05.

## Presuda

Za objavu je Canary + pyannote **upotrebljiv** (sadržaj i govornici su gotovo isti, članak Opusa
ispravio je ime iz naslova), ali Soniox je jasno bolji u imenima, stranim riječima i
interpunkciji, a za istu cijenu. Isplati se Soniox za tekst + pyannote na Modalu za govornike
(`docs` 16.11. procjena: ~$0,16/h).

## Treći: Speechmatics (enhanced, 16.11.)

`node transcribe_speechmatics.js --file experiments/2026-11-16-ep11-soniox-vs-canary/ep11.mp3`
(isti MP3 kao Canary, novi ključ): 173 s, **$0,99**, 4 govornika u cijeloj datoteci (2 do 72:55).
Usporedba sva tri: `compare3.py`, do 72:55 (kraj isporučenog Soniox SRT-a).

Nema referentnog prijepisa, pa je mjera **glasanje 2:1**: Soniox je os poravnanja, regije u kojima
se bilo koja dva razlikuju; ako se dva slažu, treći je „sam protiv dva”, tj. vjerojatno u krivu.
Riječi su normalizirane (mala slova, bez interpunkcije).

| | Soniox | Canary + pyannote | Speechmatics |
|---|---|---|---|
| riječi | 10 214 | 10 075 | 10 226 |
| kraj rečenice / zarez | 542 / 1 467 | 485 / 1 009 | 749 / 744 |
| sam protiv dva: regija (riječi) | **99 (124)** | 275 (356) | 488 (621) |
| od toga sadržajno (bez poštapalica, funkcijskih riječi, brojki) | **39** | 192 | 282 |
| cijena ove epizode (1,24 h) | ~$0,15 | ~$0,20 | $0,99 |

Sva tri različita: 234 regije. Međusobna razlika riječi: Soniox–Canary 8,9 %, Soniox–Speechmatics
11,5 %, Canary–Speechmatics 14,6 %. **Govornici:** sva tri para 99,6–99,8 % po sekundi, tj. jednaki.

Kakve su to greške:
- **Soniox** (39): uglavnom zapis, ne sluh: „i tako dalje” vs „itd.”, „dobro došli”, „12godišnje”,
  spojeno „ovoono”, „mindblowing”. Stvarnih je desetak („tore” vs „tor”, „šokiram”).
  Na nekima su vjerojatno druga dva u krivu („skuha mi” kavu, „nitko ga”).
- **Canary** (192): fonetski pravopis i krivi oblici: „aleričan”, „svetonazor”, „višestroko”,
  „klijenti” (klinci), „zahvalna”, „izvan institucionalnog”, plus izgubljeno ime gosta u uvodu.
- **Speechmatics** (282): krnja imena i riječi („uljević” za Kotruljević, „trgovčević”,
  „empatiju birati”, „plodonosni”, „fala”) i puno umetnutih poštapalica („a”, „ovaj”, „to”).
  Poštapalice su možda stvarno izgovorene (doslovniji prijepis), zato nisu u sadržajnom broju.
  Rečenice su kraće (749 točaka, 744 zareza).

**Presuda:** Soniox > Canary > Speechmatics po tekstu, govornici jednaki. Speechmatics je
najskuplji (~6× Soniox) i na ovoj epizodi najlošiji po tekstu; nema razloga da bude primarni
za Tier 2. Ograničenje: jedna epizoda, dva govornika, čist studijski zvuk.

## Četvrti: Gemini app, Hydrogen 4 (doslovni prijepis, 16.11.)

Korisnik je epizodu dao Gemini appu (model Hydrogen 4) i tražio doslovni prijepis
(`gemini_hydrogen4_app.md`, Markdown s imenima govornika, **bez vremena**). Skripte:
`gemini_gaps.py` (ispusti), `compare4.py` (glasanje 3:1), `gemini_speakers.py`.

- **Potpunost:** 10 213 riječi naprema 10 214 kod Sonioxa do odjave. Samo 4 bloka ≥ 6 riječi
  ispuštena, ukupno **27 riječi** (samoispravci i započete rečenice: „jako čudno kad sam, bilo mi
  je”, „dobro, to je ono što vidim, provociram”), 0 dodanih. Najava sljedeće epizode je tu,
  kao zaseban „Dodatni isječak”.
- **Razlika prema Sonioxu 4,5 %** (Canary 8,9 %, Speechmatics 11,5 %): najbliži Sonioxu.
- **Glasanje 3:1** (sam protiv tri slažna; sadržajne razlike): Soniox **12**, Gemini **27**,
  Canary 165, Speechmatics 247. Gemini razlike su uglavnom pravopis spajanja
  („takoreći”, „napamet”, „bogomdanu”, „dvatri”) i sitni oblici („trpjeti”, „ko”), ne krivo čuto.
  Kajkavsko „Bumo se nekak snašli, nikdar ni bilo…” zapisao je doslovno.
- **Govornici:** imena umjesto SPEAKER_xx, slaganje sa Sonioxom po riječi **99,7 %**
  (66 izmjena govornika naprema 75).
- **Mana:** nema vremena (ni po rečenici ni po riječi), pa sam ne daje SRT, words.json,
  screenshotove ni reelse. Moguće rješenje: Gemini tekst poravnati na vremena riječi iz Canaryja
  (`.wav.canary.word_ts.json`; tekstovi se poklapaju ~91 %). Nije isprobano.

**Dulje epizode (3 h) nisu mjerene.** Iskustvo s Gemini sluhom (2.8, `docs/2026-09-19-…`,
`docs/2026-10-27-gemini-sluh-pomak-id.md`): pažnja pada pred kraj dugog prozora (prazni
segmenti, pomak), zato su prozori bili ≤ 10 min. 3 h doslovnog teksta ≈ 30 000 riječi ≈ 40–50 k
izlaznih tokena u jednom odgovoru, blizu granice izlaza. Rizik je tiho sažimanje ili preskok
sredine, a bez vremena se to ne vidi. Test: ista provjera (`gemini_gaps.py`) na epizodi od
2–3 h za koju imamo Canary/Soniox.

## Peti: Gemini app, Argon 4 (16.11.)

Isti upit u Gemini appu s modelom Argon 4 (`gemini_argon4_app.md`). Skripte primaju
`GEMINI_FILE=<datoteka>` (default Hydrogen).

| | Hydrogen 4 | Argon 4 |
|---|---|---|
| riječi do odjave (Soniox 10 214) | 10 213 | 10 537 |
| ispušteni blokovi ≥ 6 riječi | 4 (27 riječi) | **0** |
| razlika prema Sonioxu | 4,5 % | 7,1 % |
| sam protiv tri (sadržajno) | 27 | 46 |
| govornici prema Sonioxu, po riječi | 99,70 % | **99,93 %** |
| najava sljedeće epizode | pripisana gostu | **zaseban govornik („Gost (Svećenik)”)** |

- Argon je **doslovniji**: zadržava poštapalice („ovaj”, „je l'”), zato ima više riječi i veću
  razliku prema Sonioxu (koji ih čisti). Uz Argon u glasanju Speechmatics pada s 247 na 219
  sadržajnih „sam protiv svih”, tj. dio Speechmaticsovih „umetnutih” poštapalica stvarno je izgovoren.
- Njegovih 46 „sadržajnih” razlika uglavnom su „je l'” (rastavljeno pa ga filtar poštapalica ne
  hvata) i artefakti poravnanja („razmjenjuju informacije”, „etiketa” postoje i u Canaryju i
  Speechmaticsu). Stvarno sporno: ubacivanje voditelja „Četiri, pet firmi...” oko 02:14, kojeg
  nema ni u jednom drugom prijepisu. Ili je tiho dobacivanje ili izmišljeno; treba preslušati.
- Argon je jedini od pet koji je najavu sljedeće epizode označio kao drugu osobu (pyannote ju je
  odvojio kao SPEAKER_02, ali bez imena).

### Argon 4 kao SRT (16.11.)

Korisnik je tražio i SRT od Argona (`gemini_argon4_app.srt.md`, 489 cue-ova). Tekst je cijeli
(10 629 riječi, govornici imenom), ali **vremena su izmišljena**: zadnji cue počinje u 60:32, a
epizoda traje 73:39. `srt_timing.py` poravna svaku riječ na Soniox riječ (sirovi tokeni, ms) i
mjeri pomak početka cue-a:

| stvarno | 0–10 min | 10–20 | 20–30 | 30–40 | 40–50 | 50–60 | 60–70 | 70–73 |
|---|---|---|---|---|---|---|---|---|
| pomak (medijan) | −0,8 s | −17 s | −91 s | −209 s | −329 s | −442 s | −640 s | −741 s |

Samo 8 % cue-ova je unutar 2 s; pomak raste linearno (~10 s po minuti), kao da model „broji”
vrijeme iz duljine teksta, a ne iz zvuka. Canary i Speechmatics: medijan 0,1 s, 100 % unutar 2 s.
Zaključak: Gemini app je dobar za TEKST, a vremena moraju doći od ASR-a (poravnanje na
word_ts), nikad iz modela.
