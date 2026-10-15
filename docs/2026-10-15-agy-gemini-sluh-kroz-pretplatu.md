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

Uzrok nije provjeren. Mogući su `agy` koji piše prozu umjesto JSON-a, prekratak timeout
za prozor od 10 min ili zaglavljen potez. `agy_refine.js` zasad ne zna ponoviti samo
pale prozore, pa to treba dodati prije ocjenjivanja (ili te 4 epizode ocijeniti uz napomenu).

## Otvoreno (stanje 15.10. 15:30)

1. Ponoviti 8 palih prozora (dodati `--only-windows` ili nastavak iz postojećih
   `*.izlaz.json` u radnom diru).
2. Opus članak iz sluh-prijepisa + slijepa ocjena kao četvrti kandidat. Pitanje je
   diže li sluh članak iznad Deepgrama i Canaryja (6,93).
3. Popraviti ili označiti `--gemini-backend agy` u produkcijskim skriptama.

Vezani dokumenti: `experiments/2026-10-10-asr/README.md` (slijepa ocjena ASR-ova),
`docs/2026-09-19-speechmatics-kostur-gemini-sluh.md` (KORAK 2.8 na Vertexu),
`docs/claude_code_backend_2026-07.md`.
