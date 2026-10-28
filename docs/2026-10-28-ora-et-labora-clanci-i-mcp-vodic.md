# Ora et Labora: članci za oel.hr i MCP vodič (28.10.2026.)

Demonstracija za udrugu OraEtLabora (Marko Marić). Iz dvije obrađene epizode napisana su
dva novinska članka u stilu portala oel.hr, obogaćena Magisterium MCP-om, i vodič kako se
vanjski sustavi spajaju na Claude Code kroz MCP. Oba PDF-a poslana su u WhatsApp grupu
„OraEtLabora & DOMOVINA.ai”.

Izvori, slike, PDF-ovi i build skripta: [`2026-10-28-ora-et-labora-clanci/`](2026-10-28-ora-et-labora-clanci/).

| Epizoda | ID | Datum | Trajanje | Naslov |
|---|---|---|---|---|
| 120 | `nBPDxzrAW0Q` | 26.10. | 107 min | Kako raste kraljevstvo Božje |
| 121 | `n38M_g__TxQ` | 27.10. | 67 min | Kako graditi Hram Božji |

## Što bi sljedeći prolaz morao ponovno otkriti

### 1. Epizode NISU u Domovina MCP-u (RAG zaostatak)

Korpus Domovina MCP-a 28.10. završava na **08.10.2026.** Nijedna Ora et Labora epizoda nije
pretraživa kroz `search_podcasts`, iako su na disku potpuno obrađene
(`storage/output/ora_et_labora/`: summary, `*_opus.article.json`, `.rag_combined.jsonl`,
`.segments.jsonl`, screenshotovi).

- `sync-cron-20261027.log`: Docker build ETL-a pao na `DeadlineExceeded`, a cloud ClickHouse
  vratio `rag_user AUTHENTICATION_FAILED` (rc=4). Popravak `domovina-rag 3067f86` stigao je
  nakon tog runa.
- `sync-cron-20261028.log`: Docker uopće nije radio, pa prvi sync nakon popravka nije prošao.
- Korisnik je odgodio popravak. Sljedeći sync mora ponijeti ~20 dana zaostatka.

Zato su članci rađeni izravno s diska, ne kroz MCP.

### 2. Kako je rađen članak

- Stil oel.hr pročitan u Braveu (claude-in-chrome): nadnaslov, naslov, potpis, lead, međunaslovi,
  dugi citati, oznake. Portal piše pobožno, u trećem licu, s puno izravnih citata svećenika.
- Citati iz `*_opus.article.json` (`sections[].content`, `screenshot_timestamp`) i
  `.segments.jsonl`. Svaki citat linka na `https://domovina.ai/v/:id/t/:sec`, nikad YouTube
  (vidi `docs/2026-09-15-linkovi-kroz-domovina-ai.md`).
- Naslovne slike: screenshot epizode 120 na 01:38:00, epizode 121 na 00:42:55.
- Okviri „Što uči Crkva” iz pet Magisterium MCP `chat` poziva, sekvencijalno. Prvi poziv s dugim
  promptom je istekao (timeout); kraći prompt je prošao. **Duge promptove u `chat` skraćuj.**

### 3. Otvorene sadržajne ograde (prije objave na oel.hr)

- Hrvatski prijevodi citata iz KKC-a i *Lumen gentium* su moji. Treba ih zamijeniti službenim
  hrvatskim prijevodima (KS).
- Tvrdnje govornika o Vučiću i Srbiji prenesene su kao njegovo mišljenje i nisu provjerene.

### 4. PDF lanac i zamke

`build.sh <ulaz.md> <izlaz.pdf>`: mermaid-cli (SVG, Brave kao Puppeteer) → pandoc
`--embed-resources` → Brave headless `--print-to-pdf`.

- mermaid-cli upisuje alt tekst `diagram`, a pandoc ga pretvara u natpis ispod svake slike.
  Skripta ga briše `sed`om.
- Uski `flowchart TB` s podgrafovima ispadne kao tanka okomita traka na A4. Za prispodobe je
  bolji `flowchart LR` s `direction LR` u podgrafovima.
- `pdftoppm` imenuje stranice `p-1.png`, ne `p-01.png`, kad ih je manje od 10. Glob `p-0[1-4]`
  zato ne nađe ništa.
- Brave headless ispisuje `CVDisplayLinkCreateWithCGDisplay failed`. Greška je bezopasna.

### 5. MCP vodič

`mcp_vodic.md` objašnjava tri načina spajanja na primjerima iz ove instalacije:

1. claude.ai konektor s OAuth prijavom: Magisterium `https://mcp.magisterium.com`, Domovina
   `https://mcp.domovina.ai`.
2. Udaljeni HTTP server: `claude mcp add --transport http …`.
3. Lokalni stdio server, na primjeru WhatsApp mosta.

Vodič ima i primjer `.mcp.json` za tim te stvaran upit nad Domovina MCP-om
(„post i molitva mogu zaustaviti rat”).

## Vezani dokumenti

- `docs/2026-10-27-ora-et-labora-obrada-epizode.md`: ponuda udruzi (trošak, vrijeme, backfill ~1100 epizoda)
- `docs/MAGISTERIUM_MCP_RUN.md`
- `../domovina-rag/.ingest-logs/sync-cron-2026102{7,8}.log`
