# Prototip: Opus 5.5 ispravlja Canary prijepis ep. 11 (16.11.2026.)

Prototip KORAKA 2.9 (`fix_transcript_opus.js`). Mjerenje i ocjena:
[`docs/2026-11-16-ep11-soniox-vs-canary.md`](../../docs/2026-11-16-ep11-soniox-vs-canary.md)
§ „Opus 5.5 ispravlja Canary tekst”, plan i rezultat implementacije:
[`docs/2026-11-16-korak-2-9-opus-ispravak-prijepisa-plan.md`](../../docs/2026-11-16-korak-2-9-opus-ispravak-prijepisa-plan.md).

- `ulaz/` — Canary + pyannote prijepis (`seq [SPEAKER_xx] tekst`, bez vremena) i metapodaci epizode
- `izlaz/dio{1,2,3}.txt` — odgovor subagenta (Opus 5.5, Read/Write alati)
- `sastavi.py` — vraća Canary vremena po seq-u → `kanal/muzevni_budite/<base>.wav.canary.diarized.srt`
- `kanal/` — za `generate_words_json.js --input-dir …/kanal`

Prototip je ispravio 92 i uveo 21 grešku (dio lektura). Pipeline verzija ima pooštren prompt
(`SYSTEM_PROMPT` u `fix_transcript_opus.js`): 64 ispravljeno, 6 novih.

## Izvorna uputa subagentu (16.11., doslovno)

```
Zadatak: lektorski ispraviti automatski hrvatski prijepis podcasta (ASR NVIDIA Canary, govornici iz pyannote dijarizacije). Ti NE čuješ zvuk; ispravljaš samo ono što se pouzdano da zaključiti iz teksta i metapodataka epizode.

SMIJEŠ čitati SAMO ove dvije datoteke (apsolutni putovi) i ništa drugo na disku — ni ostatak repozitorija, ni druge direktorije u experiments/, ni docs/, ni storage/:
- /Users/ms/git/domovinatv/fetch.domovina.tv/experiments/2026-11-16-ep11-opus-ispravak/ulaz/prijepis_canary_pyannote.txt  — 405 redaka, format: `<seq> [SPEAKER_xx] <tekst>`
- /Users/ms/git/domovinatv/fetch.domovina.tv/experiments/2026-11-16-ep11-opus-ispravak/ulaz/epizoda_meta.json — naslov, kanal, opis, oznake, poglavlja s YouTubea
Ne koristi web, ne pokreći druge alate osim Read i Write. Nemoj pretraživati disk.

Pravila ispravka:
1. Ispravljaj: krivo prepoznate riječi kad je točna riječ jasna iz konteksta (fonetski zapisi, krivi padeži/oblici koji nemaju smisla, rastavljene ili spojene riječi), pravopis imena osoba, mjesta, institucija i stranih pojmova (koristi metapodatke i opće znanje), interpunkciju i velika slova, kratice („itd.”).
2. Ne prepričavaj, ne skraćuj, ne uljepšavaj stil, ne izbacuj poštapalice i ponavljanja govornika. Ovo je doslovni prijepis; mijenjaš samo ono što je vjerojatno ASR greška.
3. Ako je ASR očito progutao ili pokvario dio rečenice, a točan tekst se ne može pouzdano zaključiti, ostavi kako jest — NE izmišljaj sadržaj. Ako se može pouzdano zaključiti (npr. ime iz naslova u predstavljanju gosta), smiješ dopuniti.
4. Oznake govornika: zadrži [SPEAKER_xx] (ne upisuj imena). Promijeni oznaku samo ako tekst nedvojbeno pokazuje da je pripisana krivoj osobi (npr. pozdrav voditelja razlomljen na dva cue-a s različitim oznakama).
5. Zadrži SVAKI seq od 1 do 405, svaki točno jednom, istim redom. Smiješ premjestiti riječ ili dvije u susjedni cue kad je rečenica razlomljena na krivom mjestu, ali ne spajaj ni ne briši cue-ove (prazan tekst je dopušten samo ako je cue bio samo šum/jedna slučajna riječ).

Izlaz (format identičan ulazu, `<seq> [SPEAKER_xx] <tekst>`, jedan cue po retku), zbog duljine u TRI datoteke:
- /Users/ms/git/domovinatv/fetch.domovina.tv/experiments/2026-11-16-ep11-opus-ispravak/izlaz/dio1.txt — seq 1–135
- .../izlaz/dio2.txt — seq 136–270
- .../izlaz/dio3.txt — seq 271–405
(isti direktorij `experiments/2026-11-16-ep11-opus-ispravak/izlaz/`). Pročitaj ulaz jednom, ne čitaj ga ponovno više puta nego što treba.

Na kraju vrati kratak izvještaj (do 15 redaka): koliko si cue-ova promijenio, koje su glavne vrste ispravaka, 5–10 primjera „prije → poslije”, i gdje si bio nesiguran pa nisi dirao.
```
