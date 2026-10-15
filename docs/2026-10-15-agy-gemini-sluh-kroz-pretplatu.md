# Gemini sluh (KORAK 2.8) kroz `agy` i Google AI Pro pretplatu (15.10.2026.)

**Zaključak.** `agy` (Antigravity CLI 1.3.5) uz Google AI Pro pretplatu SLUŠA zvuk i
radi isto što KORAK 2.8 radi na Vertexu, bez API troška. Postoje dvije prepreke:

- **`agy -p` je pokvaren.** Radi samo interaktivni način, pa ga treba voziti kroz
  tmux (`send-keys` + čekanje izlazne datoteke).
- **Sporiji je oko 3,5× od Vertexa.** Treba oko stvarnog vremena trajanja snimke.

Posljedica za produkciju: **`--gemini-backend agy` u `summarize_gemini.js` i
`generate_article_gemini.js` trenutno NE RADI** (isti `-p` put). Default model u
njima (`"Gemini 3.1 Pro (High)"`) je zastario. Danas postoje `gemini-3.8-flash-{low,medium,high}`
te Opus 5.5 i Sonnet 5.5 kroz istu pretplatu (`agy models`).

## Zašto `agy -p` visi (dva neovisna uzroka)

| simptom | uzrok | lijek |
|---|---|---|
| `print timeout … returning partial output`, `response: ""`, `usage` sve 0 | `You are not logged into Antigravity` u logu (`--log-file`) | korisnik pokrene `agy` u PRAVOM terminalu i prijavi se (`! agy` iz Claude Codea ne radi, nema TTY) |
| isto, i nakon prijave | interaktivni upit „Do you trust the contents of this project?" za NOVI direktorij — u `-p` ga nitko ne vidi | jednom pokrenuti interaktivno u tom direktoriju i potvrditi |
| isto, i nakon prijave i povjerenja | bug u 1.3.5: zahtjev ode (`streamGenerateContent` u logu), odgovor nikad ne stigne na izlaz; i u tmuxu i izvan njega, i za „glavni grad Hrvatske" | nema; koristi interaktivni način |

Crvena haringa: u logu svakih 30 s piše `MCP: GitKraken still connecting`. To NIJE
uzrok, a `agy mcp disable GitKraken` ne mijenja ništa (IDE ga ubacuje sam).

Interaktivni `agy` hvata `Ctrl-b`, pa se iz tmuxa ne može odspojiti. Gledati sesiju
samo za čitanje (`tmux attach -t <sesija> -r`), a izaći zatvaranjem prozora.

## Mjerenje: Hajdučka štorija (OspwepfLObY, 18 min, kostur Canary + pyannote, 140 segmenata)

Isti prompt (`SKELETON_PROMPT` doslovno iz `refine_diarized_gemini.js`), isti prozori
(≤10 min, ≤70 segmenata), isti kostur. Skripta je `experiments/2026-10-10-asr/agy_refine.js`
(`--backend agy|vertex`).

| | trajanje | prozori (s) | prepisano | trošak |
|---|---|---|---|---|
| Vertex Gemini 3.8 Flash | **5,2 min** | 102 / 23 / 180 | 140/140 (3 prazna → kostur) | ~$0,155 (26k tokena razmišljanja) |
| `agy` Gemini 3.8 Flash High | 18 min | 304 / 349 / 419 | 140/140 | $0 (pretplata) |

Kvaliteta: `agy` je ispravio upravo greške koje je slijepi ocjenjivač zamjerio
Canary članku:
- Haji Kadorić → **Hadžikadunić**
- 60-terac → **šesnaesterac**
- Demis → **Denis**

Zadržao je ono što je Canary već imao dobro (Šotiček, Fajad). Ključna imena po
prijepisu: Speechmatics ima 4 kriva imena, a Canary + `agy` nijedno.

Na isječku od 60 s `agy` razlikuje i govornike (G1/G2) gdje su ih Speechmatics i Canary
spojili. Vremena su pomaknuta 2–3 s, pa za titlove ne valja.

## Paralelni run: 4 sesije, 14 epizoda (15.10. 11:43 → 15:27)

`run_agy_queue.sh` je pokrenut na 4 tmux sesije (`agy1`–`agy4`) za ~13 h zvuka. Run je
završio za **3 h 44 min**, dakle pretplata podnosi 4 paralelne sesije, bez ijednog
odbijanja zbog kvote. Brzina po sesiji ostaje ~1× stvarnog vremena (Špica 74 min → 68 min,
ATMA 97 min → 58 min).

**10 od 14 epizoda je čisto (svi segmenti prepisani).** Kod 4 epizode je 8 prozora (od
~120) isteklo nakon 15 min bez valjanog izlaza. Ti segmenti zadržavaju Canary tekst:

| epizoda | prepisano | prozori bez izlaza |
|---|---|---|
| Mjesto zločina (lCmUjIkTECw) | 796/1077 | 4 (150 min ukupno) |
| Actualitica (pD7lyjjlot8) | 757/827 | 1 |
| 2Pogled (M8OUH8QIG3Q) | 270/335 | 1 |
| Samo Hajduk (q28ivn-YEp4) | 560/570 | 1 |

**Ponovljeno 15.10. navečer: sve 4 epizode su sada potpune.** Dva različita uzroka:

- **Mjesto zločina (4 prozora): prekratak timeout.** agy je sva 4 izlaza ipak zapisao,
  valjana, 1–8 min nakon što je skripta odustala. `--reuse` ih je pokupio bez ijednog
  novog poziva (1077/1077).
- **Ostala 3 prozora: prolazni zastoj.** Izlaza nije bilo nikakvog, iako je jedan isječak
  trajao samo 0,9 min. Na ponovnom pokušaju (3 paralelne sesije, timeout 25 min) prošla
  su za 4,6–7,7 min.

`agy_refine.js` sada ima dvije stvari:
- `--reuse` uzima valjan postojeći `{stem}.izlaz.json` i agy pita samo za rupe.
- Nakon isteka šalje Escape, da zaglavljeni potez ne zadrži `/clear` i idući upit u redu.

## Skaliranje na ~20 epizoda dnevno (mjereno 15.10.)

20 epizoda × ~56 min ≈ 19 h zvuka. Uz ~1× stvarnog vremena po sesiji to traje ~5 h na
4 sesije, ~2,5 h na 8 i ~1 h na 20. Za noćni prozor je dovoljno 6–8 sesija. Dvije
prepreke prije skaliranja:

- **Curenje procesa.** Svaka agy sesija svakih ~30 s pokrene nov GitKraken `gk mcp`
  proces i ne ugasi ga. Nakon 8 h s 4 sesije bilo ih je 255 (2,2 GB). Uz to agy
  sam naraste s 38 na ~500 MB. Treba ugasiti GitLens ekstenziju u Antigravityju i
  pokretati svježu sesiju po epizodi.
- **Kvota.** 4 paralelne sesije i ~120 zahtjeva u 4 h prošle su bez odbijanja. Iznad
  toga nije mjereno.

Isti posao na Vertexu: ~$0,0086 po minuti zvuka, dakle ~$10 dnevno za 20 epizoda.

## Otvoreno (stanje 15.10. 15:30)

1. ~~Ponoviti 8 palih prozora~~ — gotovo (`--reuse`).
2. ~~Opus članak + slijepa ocjena~~ — gotovo: sluh **8,67**, prvi u 15/15, nula teških
   grešaka (Canary 7,00, Speechmatics 6,27, Deepgram 6,00). Tablica i ograde u
   `experiments/2026-10-10-asr/README.md` §4. krug.
3. Popraviti ili označiti `--gemini-backend agy` u produkcijskim skriptama.

Vezani dokumenti: `experiments/2026-10-10-asr/README.md` (slijepa ocjena ASR-ova), `docs/2026-10-15-varijante-eksperimenta-linkovi.md` (linkovi na domovina.ai),
`docs/2026-09-19-speechmatics-kostur-gemini-sluh.md` (KORAK 2.8 na Vertexu),
`docs/claude_code_backend_2026-07.md`.
