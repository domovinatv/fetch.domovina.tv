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
