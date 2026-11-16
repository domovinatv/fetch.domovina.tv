# re:DEFINICIJA ep. 11: Soniox vs Canary + pyannote, ista epizoda (16.11.2026.)

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
