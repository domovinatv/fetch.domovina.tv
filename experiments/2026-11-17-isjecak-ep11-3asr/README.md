# re:DEFINICIJA 11, isječak 30:16–36:32: titl iz tri ASR-a (17.11.2026.)

Titl za 16:9 isječak (`clips/RdEN7Ny1bV8/…_titl…mp4`) složen iz tri neovisna prijepisa istog zvuka:

| | izvor | uloga |
|---|---|---|
| Soniox stt-async-v5 | `../2026-11-16-ep11-soniox-vs-canary/soniox_sirovi_izlaz.json` (cijela epizoda, 12.11.) | osnova teksta + vremena riječi |
| Gemini 4 Hydrogen (high) | `gemini4_hydrogen_isjecak.txt`, agy, samo isječak (376 s), doslovno s govornicima („Voditelj” = Krunoslav Puškar, „Ante” = gost Ante Lučić) | glas 2 |
| Canary 1B v2 (nightly 15.11.) | `cdn.domovina.ai/data/RdEN7Ny1bV8/diarized.asr.srt` (prije Opus ispravka 2.9) | glas 3 |

- `vote3.py`: Soniox riječi iz tokena (razmak je ZASEBAN token `' '`, inače se „da će” spoji u „daće”),
  poravnanje (difflib) prema druga dva, ispis regija gdje se Soniox ne slaže s oba → `glasanje3.txt`.
- `fix3.py`: ručne ispravke (pravilo: Hydrogen + Canary složni protiv Sonioxa, ili Hydrogen jasno čuje
  ono što Soniox nema; poštapalice van, standardni pravopis) → `transcript_3asr.json`
  (vremena: Soniox; zamjena iste duljine nosi vremena, inače se raspon dijeli).
- Putanje u skriptama pokazuju na scratchpad sesije; prepravi prije ponovnog pokretanja.

Što je Soniox promašio na 6 min (874 → 880 riječi): voditeljeva dobacivanja („Etiketu.”, „Točno.” ×2,
„To je ko vrh sante leda…” je voditelj), „niškoristi” (conf 0,29 → „Niško je isti”), „sve je proces i”,
„da u onom… Psihički, prije svega” (conf 0,21), „krše taj”, „dva-tri fejlana projekta”, „simo-tamo”.
Canary je imao više grešaka u riječima („pogodak na uspjehu”, „pulo”, „manjceta”, „krpu”, „majset”).

Hydrogen kroz agy NIJE mogao iz Claude sesije (TCC, `~/.gemini` je na DOMOVINA2TB); radi kad se agy
pokrene u tmux sesiji na serveru koji ima pristup disku (npr. `tmux -L agy-agyllm-s2-… new-session`).
Postupak isječka: `docs/2026-11-17-rucni-isjecak-epizode-na-cdn.md`.

## v4: oznaka govornika (17.11.)

Oznaka iznad titla („KRUNOSLAV PUŠKAR” narančasto #F15F22, „ANTE LUČIĆ” zlatno #C6A15B) prati tko
GOVORI (zvuk), ne tko je u kadru: kamera često pokazuje sugovornika (npr. 1:50 „Etiketu.” govori
Krunoslav dok je Ante u kadru), pa Apple/Claude Vision ovdje nije izvor. `add_speakers.py`: Soniox
dijarizacija (S1 = Ante, S2 = Krunoslav), 13 izmjena, sve se slažu s Hydrogenom; Canary + pyannote je
propustio Krunoslavovo dobacivanje na 3:12. Dobacivanja koja Soniox nema („Etiketu.”, 2× „Točno.”)
dodijeljena po Hydrogenu → `transcript_3asr_spk.json`. Grupa titla se lomi na izmjeni govornika.

Ugrađene grafike pri dnu (sken crvene, 2 fps): traka Krunoslav 3,5–7 s, traka Ante 197,5–202,5 s
(cijela širina, y 810–1024 → titl se podiže na bottom 300 px), kartica „Podupri naš rad” 263–292 s
(titl udesno). v1–v3 su prve dvije trake prekrivale.

CDN: `clips/RdEN7Ny1bV8/RdEN7Ny1bV8_30m16s-36m32s_1080p_titl_v3.mp4` (3 ASR) i `…_titl_v4.mp4`
(+ govornici + zaobilaženje traka), oba poslana u WhatsApp „Matija Only”.
