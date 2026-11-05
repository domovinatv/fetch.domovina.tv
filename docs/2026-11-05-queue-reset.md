# Queue reset (05.11.2026. ~10:50)

## Odluka

Četvrtak, 05.11.2026. oko 10:50 je **točka reseta reda**. Sve što je do tada palo ili
ostalo nedovršeno je **otpisano**:

- Ne nudi se nikakav ponovni pokušaj (requeue, retry, „da ponovim?”) za jobove i
  Magisterium jobove koji su pali **prije** ovog trenutka. Ni u analizi nightlyja, ni
  kao usputni prijedlog.
- Od sada se prati samo jedno: **obradi li nightly (Tier 1) i pipeline.domovina.ai
  (Tier 2) svaki dan SVE nove epizode**. Mjerilo je u
  `docs/2026-11-04-samo-nove-epizode-bez-backfilla.md` §Kako se mjeri.
- Neuspjeh nakon reseta se analizira kao kvar pipelinea (uzrok + popravak naprijed),
  ne kao stavka za ručni retry.

Ovo je nastavak odluke od 04.11. (CLAUDE.md pravilo 4, bez backfilla): stari katalog i
stare rupe čekaju zasebnu odluku kad nekoliko noći zaredom bude 100 %.

## Što NIJE retry i nastavlja raditi

- **Automatski ponovni pokušaj u `automatic/enqueue_all_new.js`**: job pao na downloadu
  (anti-bot) ponovno se šalje, najviše `MAX_ATTEMPTS` (3), samo za epizode iz zadnja 3
  dana `events.jsonl`. To je dio normalne obrade novih epizoda, ne ručni retry.
  Pali jobovi od 02.–04.11. sami ispadaju iz tog prozora.
- **Ograda Claude prozora** (`⏸ ODGOĐENO`) nije neuspjeh, članak dolazi idući nightly
  ili na „▶ Članak ipak sada”.
- **Aktivni redovi u trenutku reseta** rade do kraja (nisu pali, samo čekaju):
  - jobs: ponovna obrada kanala `domovina_tv` (6 epizoda, vidi dolje), 1 u obradi + 3 u redu;
  - Magisterium HR: 1 u radu + 8 u redu (5 noćnih Tier 2 epizoda + #005 i #004 s
    `force`), Magisterium EN: 1 u redu.

## Stanje u trenutku reseta (otpisano)

D1 `pipeline_domovina`, 05.11. ~10:50: `jobs` 206 done / 18 failed, `magisterium_jobs`
HR 233 done / 15 failed, EN 1724 done / 14 failed.

Failed jobovi zadnjih 7 dana (otpisani, ne retryati):

| Video | Kada | Razlog |
|---|---|---|
| 13 jobova u nizu (`uLfnOpij6yA` … `HsUdHhV6IjE`) | 02.11. 05:18–05:35 | prioritetni download nije uspio (anti-bot u tom trenutku) |
| `KB9sPiyFTCs` | 02.11. | YouTube anti-bot |
| `cs5GMSWgbxs` | 03.11. | YouTube anti-bot |
| `VOcypz9_Ofo` | 03.11. | video nema zvuka (ispravno preskočen) |
| `KyMHBGFS5Gc` | 03.–04.11. (3×) | download nije uspio, vjerojatno privatan |
| Magisterium `-VAs93ZWwEE` (HR) | 01.11. | run prošao, `article.magisterium.json` nije na CDN-u |

## Isti dan: ponovna obrada kanala domovina_tv

Vlasnikov kanal (domovina.ai/c/domovina-tv) imao je 7 epizoda obrađenih u ožujku–srpnju
(Canary, gemini-2.5-flash ili Opus bez Magisteriuma). Na izričit zahtjev, kao zasebna
odluka za jedan kanal, ponovno su obrađene trenutnim pipelineom (Soniox + pyannoteAI,
Opus, Magisterium HR+EN):

- jobovi upisani izravno u D1 istim `INSERT`-om kao admin „🔁 Ponovna obrada”
  (`reprocess=1, priority=1, transcription='soniox', llm claude/opus, magisterium opus`),
  jer javni API to ne pokriva: `POST /api/jobs` za objavljen video radi `import` red, a
  `/jobs/:id/reprocess` odbija `import` (403);
- `WRE248YCIeI` (#005), `fO7iltytw0I` (#004), `AoXN-3Mkmew` (#003), `b-nls1ck8EE` (#002),
  `oxq1U0xypu8` (#001), `MGLq9v3AtvE` (cc_01);
- `KvIhy5SESYs` je duplikat `oxq1U0xypu8` (ista snimka, 6226 s) i **sakriven** je:
  datoteke u `_orphan_duplicates/2026-11-05/domovina_tv/`, `archive_videos.js` ga
  prebacio u `archived[]`, kanalski indeks + home/search.json obnovljeni i na CDN-u.
  `data/KvIhy5SESYs/` na CDN-u i RAG ostali su netaknuti (izravni link još radi);
- `QkcpHsj43rE` (28.10.) već je bio na trenutnom pipelineu i nije diran.

EN i Magisterium EN dolaze sami: `domovina_tv +EN` u `full_backfill_channels.txt`, novi
članci su datirani 05.11. (≥ `EN_AUTO_SINCE`), a zakašnjeli Magisterium EN pokriva
`EN_MAG_LATE_SINCE`.
