# Magisterium MCP bez LLM-a u petlji (24.10.2026.)

**Ukratko.** HR Magisterium za jednu epizodu više ne treba Claude agenta. Skripta
`tools/magisterium_mcp_episode.js` zove Magisterium MCP server izravno (OAuth token na
Pro pretplati, NE API ključ), sastavi `article.magisterium.json`, objavi ga i provjeri md5
na CDN-u. Mjereno na `Qt6T9XX4VNA` (mreze_rijeci, 13 sekcija): **10 min 35 s end-to-end,
0 Claude tokena**. Stari tok je za usporedive epizode trajao 21 min – 2,4 h i trošio
200–260k tokena konteksta po epizodi. Poller (`pipeline.domovina.ai/bridge/magisterium_poller.js`)
od danas po defaultu (`MAG_RUNNER=direct`) zove ovu skriptu.

```bash
node tools/magisterium_mcp_client.js login            # JEDNOM: OAuth u browseru
node tools/magisterium_mcp_episode.js --video-id <VID> # prep → chat → assemble → publish → md5
node tools/magisterium_mcp_episode.js --video-id <VID> --force      # ponovna obrada
node tools/magisterium_mcp_episode.js --video-id <VID> --no-publish # samo na disk
```

## Mjerenja

### Novi način, korak po korak (`Qt6T9XX4VNA`, 14 chat poziva, batch-size 1, max-words 80)

| Korak | Što radi | Vrijeme | Claude tokeni |
|---|---|---|---|
| 1 prep | `magisterium_mcp_prep.js` → 13 + 1 prompt u `job.json` | 0,03 s | 0 |
| 2 chat | 14 × MCP `chat`, sekvencijalno | **405 s** (run A) / **574 s** (run B) | 0 |
| 2b jezik | strani fragment → isti prompt ponovno (run B: 1 poziv, ćirilično „не”) | 34 s | 0 |
| 3 assemble | `*.mcp.json` → `article.magisterium.json`, 13/13, svi citati s `source_url` | 0,03 s | 0 |
| 4 publish | `with_pipeline_lock.sh` + `publish_hr_episode.sh` (+ `force_upload` kod `--force`) | 26–30 s | 0 |
| 5 verify | CDN GET s `Origin`, md5 disk == CDN | 0,2 s | 0 |
| **Ukupno** | | **~7,5 min (A) / 10 min 35 s (B)** | **0** |

Latencija servera po pozivu: run A 22–35 s (prosjek 26 s), run B 29–77 s (prosjek 41 s).
Isti promptovi, isti dan, razmak od 15 min, dakle varijanca je na strani Magisteriuma.

### Cijela sekcija umjesto 80 riječi (25.10.2026.)

Prep je do 25.10. slao samo prvih 80 riječi sekcije (`--max-words 80`), pa je rez znao pasti
usred misli. Na re:DEFINICIJA ep. 6 (`ouoZvcpBt9Y`, „Spomenik u Sisku i kozaračka djeca”)
stao je iza „nitko ih nije ubijao”, bez nastavka koji rečenicu objašnjava: ocjena 40, s cijelom
sekcijom (432 riječi) 62. Default je sada **`--max-words 600`**: ispod granice sekcija ide
cijela, iznad nje rez pada na zadnji kraj rečenice (ako bi to odbacilo više od trećine,
tvrdi rez s `...`). Tipične sekcije imaju 150–450 riječi, pa se rez praktički ne događa.

Mjereno na `Qt6T9XX4VNA` (13 sekcija od 160 do 379 riječi, sve poslane cijele, holistički
poziv preuzet iz prethodnog runa jer je prompt isti), izravno u scratch dir, bez objave:

| | 80 riječi (24.10., run A / B) | cijela sekcija (25.10.) |
|---|---|---|
| prompt po sekciji | ~1 000 znakova | 2 250–3 580 znakova |
| latencija po pozivu | 22–35 s / 29–77 s (prosjek 26 / 41 s) | 30–48 s (prosjek 38,8 s) |
| 13 sekcija, zid | — | 505,6 s |
| timeouti / retry / rate-limit čekanja | 0 / 0 / 0 | 0 / 0 / 0 |
| strani fragmenti (2b) | 1 (run B) | 0 |
| root `overall_score` | 83 | 84 |

Latencija je unutar varijance koju Magisterium ima i na istom promptu, pa duži ulaz ne
košta mjerljivo vrijeme. Ocjene po sekciji pomiču se u oba smjera (−12 do +8; prosjek 83,0
→ 83,8), dakle nema sustavnog pomaka: dobitak je u tome što model ocjenjuje ono što je rečeno,
a ne krnji odlomak. Timeouti iz batch-of-4 ere (zbog kojih je default bio 60) ne vrijede za
batch-size 1. Test: `magisterium_mcp_prep.test.js`.

### Stari način (Claude agent u petlji, mjerenja od 24.10. na re:DEFINICIJA)

| Epizoda | chat poziva | Trajanje | s/poziv | Kontekst |
|---|---|---|---|---|
| ep 7 (odgovori izvučeni skriptom iz transkripta) | 28 | 21 min | ~45 | 200–260k |
| ep 5 (odgovori prepisivani ručno) | 36 | 2,4 h | ~240 | 200–260k |
| ep 6 (ručno) | 38 | 2,4 h | ~230 | 200–260k |

Svaki `chat` je u starom toku jedan puni model-turn nad kontekstom koji raste, pa je
orkestrator bio usko grlo, a ne Magisterium. Ukupni input tokeni za epizodu s 28 poziva su
reda veličine 28 × ~150k ≈ **4M (procjena; uglavnom cache read)**. Stvarni broj nije
izmjeren, jer transkripti subagenata s 24.10. nisu sačuvani.

### Trajanje po satu snimke (prva dva produkcijska runa, 24.10. navečer)

Holistički poziv je u oba slučaja bio gotov od ranije, pa ga je skripta preskočila.

| | `dYqKlE_pEXI` (budi_frajer) | `c2vZO7dHBTE` (nanovoroeni) |
|---|---|---|
| snimka | 32,4 min | 77,5 min |
| sekcija (sekcija/h snimke) | 16 (30/h) | 31 (24/h) |
| 2 chat | 455,9 s (~28,5 s/poziv) | 890,7 s (~28,7 s/poziv) |
| 2b jezik | 0 s | 103,6 s (`batch_17` + holistic, 1 krug) |
| 4 publish + 5 md5 | 23,6 s | 25,5 s |
| rate-limit čekanja | 4 | 10 |
| ukupno | 8,0 min | 17,0 min |
| **po satu snimke** | **14,8 min** | **13,2 min** (11,8 bez jezičnog retryja) |
| `overall_score` | 78 | 83 |

Vrijeme raste s brojem sekcija, a ne izravno s trajanjem snimke. Za planiranje:
**trajanje ≈ 1 min + 0,5 min × sekcija** (batch 1; od 29.10. batch 2 ≈ 0,3 min × sekcija, vidi `2026-10-29-magisterium-brzina-batch-eksperiment.md`). Bez outlinea računaj **~15 min po satu snimke
+ 1 min po epizodi**: 10 h backloga ≈ 2,5 h, sekvencijalno. Osnova su samo dvije epizode.

### Usporedba po pozivu

| | Stari | Novi |
|---|---|---|
| vrijeme po `chat` pozivu | 45 s – 4 min | 22–77 s (čisti server) |
| Claude kvota | ~200–260k kontekst/ep | 0 |
| kopiranje odgovora | agent (ručno ili skripta iz transkripta) | skripta piše `*.mcp.json` |
| SLOJ 3 (citat → URL) | `search` pozivi + `magisterium_doc_urls.json` | otpada: reference nose `source_url` |
| naslovi s ugniježđenim zagradama | lome parser, ručni url-map | nema parsiranja teksta |
| strani fragmenti | agent ih prevodi | detektor + ponovno pitanje istog prompta |

## Kako je napravljeno

1. **Endpoint.** `https://mcp.magisterium.com` (streamable HTTP, JSON-RPC). Protected
   resource metadata pokazuje na `https://www.magisterium.com/` kao authorization server:
   OAuth 2.1, PKCE S256, dynamic client registration (`/auth/oauth/register`), scope
   `openid email mcp:access`. Token claude.ai konektora drži Anthropic i ne može se
   izvući, pa klijent ima **vlastitu registraciju** (`domovina.ai pipeline (fetch.domovina.tv)`).
   Consent ekran nudi „Use plan from: Matija Stepanić · Pro”.
2. **Token.** `~/.config/magisterium-mcp/token.json` (0600, izvan repoa): client_id,
   client_secret, access_token (24 h), refresh_token. Refresh je automatski i provjeren je
   prisilnim istekom. Pod launchd-om nema TCC problema, jer je datoteka u `$HOME`.
3. **Server alati** su isti kao kod konektora: `search, fetch, chat(prompt), get_*`.
   `chat` vraća JSON `{answer, references[]}`, gdje svaka referenca ima `document_title`,
   `document_author`, `document_reference` i **`source_url`**.
4. **Assemble** čita `<name>.mcp.json` kad postoji (`[^N]` = `references[N-1]`, url sa
   servera), a inače stari `<name>.raw.txt`. Stari tok i dalje radi bez izmjena.

## Zamke

- **`chat` rate limit je ~2,5 poziva/min po korisniku, a ne 15/min.** S 4 paralelna poziva
  svaki treći ili četvrti dobije `{"error":"rate_limit_exceeded"}` (dolazi kao `isError`
  tool result, ne kao HTTP 429). S 2 paralelna prva tri pokušaja padnu. Efektivna
  propusnost bila je 2,1–2,7/min **u svakoj konfiguraciji**, pa je default
  `--concurrency 1`. Rate limit se ne broji u retry budžet: klijent čeka 20 s, do 30 puta.
- **Latencija varira 2×** između runova (26 naspram 41 s/poziv). Za procjenu trajanja
  računaj ~30–45 s po pozivu, dakle ~0,5–0,75 min po sekciji plus ~1 min fiksno.
- **Scoreovi variraju između runova** za ±12 po sekciji (sekcija 7: 78 naspram 66), dok je
  root prosjek stabilan (82 / 82 / 83) i holistički također (91 / 91 / 89). To je
  svojstvo Magisteriuma; ručno se ne „ispravlja”.
- **Strani fragmenti** (ćirilica, litavski i finski dijakritici) hvataju se regexom
  `[Ѐ-ӿ]|[ąęėįųūõäöå]`. Takav odgovor se preimenuje u `.langN.bak` i isti prompt
  se pita ponovno (`--lang-retries 2`). Score se ne dira. Lažni pozitiv (npr. njemačko
  ime s „ö”) košta samo jedan dodatni poziv.
- **Promptovi idu doslovno** iz `job.json`. Nema ručnog skraćivanja, a time ni izmišljanja
  sadržaja.

## Što je ostalo isto

- `magisterium_mcp_prep.js` i `magisterium_mcp_assemble.js`, s tim da assemble dodatno čita `.mcp.json`.
- Objava preko `publish_hr_episode.sh` pod `with_pipeline_lock.sh`, a kod ponovne obrade
  `force_upload.js --targets magisterium`.
- EN ide kroz `translate_to_english.js` (poller), a ne kroz MCP.
- Stari runbook (`claude -p "@docs/MAGISTERIUM_MCP_RUN.md <VID>"`) ostaje kao fallback
  (`MAG_RUNNER=claude`), npr. ako je token opozvan, a nema nikoga da ponovi `login`.
