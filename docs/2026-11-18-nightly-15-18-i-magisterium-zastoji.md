# Nightly 15.–18.11.2026. i Magisterium `ETIMEDOUT` (zastoji stroja)

Provjera zadnja četiri nightlyja i popravak koji je iz nje izašao.

## Nightly 15.–18.11.: sve prošlo, rerun nije potreban

| Noć | Kraj | Nenula korak |
|---|---|---|
| 15.11. | 05:28 | `audit_pipeline.js` exit 1 |
| 16.11. | 03:24 | `audit_pipeline.js` exit 1 |
| 17.11. | 04:49 | `audit_pipeline.js` exit 1 |
| 18.11. | 05:31 | `audit_pipeline.js` exit 1 |

Ono što izgleda kao kvar, a nije:

- **Audit exit 1** — 99,97 % ispravnih; jedina rupa je `E0AILEwW550` (`_unlisted`, 24.07.,
  `asr_failed.json`), stara i otpisana resetom reda 05.11. Drift `book.epub` za `WRE248YCIeI`
  (15.–16.11.) nestao je sam.
- **Mnogo ❌ u KORAKU 10** — kadar iz yt-dlp streama padne, pa se ponovi iz lokalnog `.mkv`
  u 360p (`📁 N kadrova palo iz streama — ponavljam iz …`). Završni `Greske: 0`. Isti obrazac
  10.–13.11., nije regresija (360p je poznato ograničenje, memorija `screenshot_format_selector_360p`).
- **KORAK 9.9 ~1 h 17. i 18.11.** (inače 0–15 min) — jednokratna kaskada: 16.11. 13:00–15:00
  KORAK 2.9 (Opus ispravak prijepisa) pušten je na ~40 svježih epizoda → 17.11. novi
  `segments.jsonl` → `reels.json` zastario (`isStale` = mtime). 20 + 20 Opus poziva, 18.11.
  ostalo 5. Nije petlja.

Brza dijagnostika nightly loga: `perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g; s/.*\r(?!\n)//g'` u
scratchpad, pa `grep '📢 \[.*KORAK'` za vremensku liniju i razmak koraka.

## Magisterium `spawnSync node ETIMEDOUT` — uzrok nije MCP

Tri nove epizode ostale bez Magisterium HR: `mHPLFcqwJxM` (13.11.), isti ponovno 14.11.,
`jNk_c81A55Q` (17.11.). Poller je javio `ETIMEDOUT` (rok 60 min) → `failed`, bez ponavljanja.

Pretpostavka „MCP chat visi” je kriva — klijent već ima rok 240 s po pozivu. Mtime datoteka
u `/tmp/mag_hybrid/<base>.results/` pokazuje kada je koji poziv stvarno završio:

- 17.11.: tick 08:07:37, `holistic.mcp.json` 09:06:43 (poziv 86,7 s) → prvi chat poziv krenuo
  tek ~09:05, **57 min nakon početka**. U istom prozoru oba Tier 2 slota stoje (priority log
  nema redaka 08:21–09:06, uz `fetch failed (EPIPE)` i `reconcile greška: fetch failed`).
- 14.11.: priority log prazan **08:01–17:17**; inventar (čisti `readdir` diska) trajao 24 908 s.
- Mac nije spavao (`pmset -g`: sleep 0, nema Sleep/Wake zapisa).

Dakle **zastoji cijelog stroja** (mreža i/ili disk), Magisterium je samo žrtva. Uzrok zastoja
nije istražen — otvoreno.

Druga zamka: `spawnSync({timeout})` ubija samo `magisterium_mcp_episode.js`; njegov
`magisterium_mcp_client.js` nastavlja kao siroče (13. i 17.11. log nakon `ETIMEDOUT` još
ispisuje `✅ batch_NN`).

## Popravak (18.11.)

- `pipeline.domovina.ai/bridge/magisterium_poller.js`
  - `runDirect` = async `spawn` s `detached: true`; na timeout `kill(-pid)` SIGTERM, +10 s SIGKILL
    — gasi cijelu grupu (provjereno: unuk ugašen).
  - HR (direct runner) bez artefakta na CDN-u → **jednom** `queued` s oznakom `auto-retry` u
    `error`; drugi neuspjeh → `failed` (isti obrazac kao `stuck-requeue`). Ponavljanje je jeftino
    jer klijent preskače gotove `*.mcp.json`.
- `tools/magisterium_mcp_client.js` — OAuth `asMeta`/`tokenRequest` dobili rok 30 s (jedini
  mrežni pozivi bez `signal`).

`jNk_c81A55Q` HR je ručno dovršen 18.11. (`node tools/magisterium_mcp_episode.js --video-id
jNk_c81A55Q`, ~11 min, md5 disk = CDN). EN Magisterium bi trebala pokupiti EN traka.

## Otvoreno

- Što zaustavlja stroj (14.11. 9 h, 17.11. ~45 min)? Kandidati: vanjski SSD (exFAT), mreža/Tailscale.
- Ako zastoj traje dulje od 2 ticka + 60 min, i auto-retry padne — tada ostaje `failed`.
- Auto-retry još nije viđen u live ticku.

## Vezani dokumenti

- `docs/2026-10-24-magisterium-mcp-bez-llm-a.md`
- `docs/2026-11-10-magisterium-svi-tier1.md`
