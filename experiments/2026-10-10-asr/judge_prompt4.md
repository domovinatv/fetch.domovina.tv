Ti si strogi urednik hrvatskog portala. Slijepo ocjenjuješ četiri članka koje je ISTI AI model
napisao iz četiri RAZLIČITA prijepisa istog podcasta. Ne znaš koji je članak
nastao iz kojeg prijepisa i NE SMIJEŠ to pokušati saznati.

EPIZODA: {ID}
Direktorij: /Users/ms/git/domovinatv/fetch.domovina.tv/experiments/2026-10-10-asr/data/slijepo4/{ID}/
- `A.md`, `B.md`, `C.md`, `D.md` — kandidati (svaki = sažetak + članak; `[slika HH:MM:SS: …]` je predložena slika)
- `transkript_W.srt`, `transkript_X.srt`, `transkript_Y.srt`, `transkript_Z.srt` — četiri prijepisa s oznakama govornika.
  NIJEDAN nije istina: svaki griješi drukčije (imena, brojke, tko govori). Slova W/X/Y/Z NISU
  povezana sa slovima A/B/C/D. Kad se prijepisi razilaze, istina je ono u čemu se slaže većina
  ili ono što potvrđuje `epizoda.txt`.
- `epizoda.txt` — naslov i opis s YouTubea; mjerodavan za zapis imena.

ZABRANJENO čitati išta izvan tog direktorija (posebno `../kljuc.json`, `data/output/`, `data/logs/`).
Nemoj ništa mijenjati osim pisanja `ocjena.json` u tom direktoriju.

POSTUPAK
1. Pročitaj `epizoda.txt` i SVE kandidate u cijelosti.
2. Provjeri ih prema prijepisima, ciljano (Grep/Read). Za SVAKOG kandidata provjeri barem 10
   konkretnih tvrdnji (brojke, imena, tko je što rekao, redoslijed) i sva imena govornika.
   Kad je tvrdnja sporna, pogledaj isto mjesto u sva četiri prijepisa. Provjeri pokriva li
   članak cijelu snimku (zadnji dio razgovora često nedostaje).
3. Ocijeni svakog kandidata 1–10 po kriterijima:
   - `utemeljenost`: nema izmišljenih činjenica, nema pogrešnih pripisivanja izjava
   - `imena`: govornici i spomenute osobe točno imenovani; izmišljeno ili iskrivljeno ime = teška greška
   - `pokrivenost`: obuhvaća sve glavne teme i dio snimke od početka do kraja
   - `jezik`: gramatika, pravopis, prirodan novinarski hrvatski; strani znakovi/riječi u tekstu = greška
   - `struktura`: podnaslovi, odlomci, čitljivost, smislena vremena slika (unutar snimke, uz temu)
   - `ukupno`: tvoja urednička ocjena (bi li to objavio i koliko bi uređivao) — nije prosjek
4. Za svaku konkretnu grešku zapiši stavku u `greske`. Ako greška očito potječe iz pogrešno
   čutog prijepisa (krivo ime, krivi broj), to napiši u `opis` — to je upravo ono što mjerimo.

IZLAZ: zapiši datoteku `ocjena.json` (valjan JSON, UTF-8) točno ovog oblika:
{
  "id": "{ID}",
  "kandidati": {
    "A": {"utemeljenost": 0, "imena": 0, "pokrivenost": 0, "jezik": 0, "struktura": 0, "ukupno": 0,
          "duljina_dojam": "prekratko|primjereno|predugo", "sazetak_ocjene": "2-3 rečenice"},
    "B": {}, "C": {}, "D": {}
  },
  "greske": [
    {"kandidat": "A", "vrsta": "halucinacija|krivo_ime|krivo_pripisano|propust|jezik|vrijeme|struktura",
     "tezina": "teska|srednja|laka", "citat": "doslovno iz kandidata", "transkript": "HH:MM:SS + što stvarno piše (i u kojem prijepisu)", "opis": "…"}
  ],
  "prijepisi": {"W": "…", "X": "1-2 rečenice o kvaliteti", "Y": "…", "Z": "…"},
  "rang": ["najbolji", "…", "najlošiji"],
  "napomena": "što je zajedničko svima / problem s prijepisima ako ga ima"
}

Na kraju odgovori JEDNOM kratkom porukom: rang i po jedna rečenica po kandidatu (bez sadržaja datoteke).
