# Katalog ingest nakon uploada (KORAK 13.5) i `channel` u `episode.json`

06.11.2026., katalog sesija S7 (lanac u `../domovina.ai/katalog/docs/handoffs/`).
Odluke 700–709 u `../domovina.ai/katalog/docs/decisions.md`.

## Što radi

Katalog (Cloudflare Worker + D1, `https://domovina.ai/api/katalog/v1`) je projekcija
CDN-a: kanali i epizode s člankom, paginirano, za aplikaciju. Do S7 ga je punio samo
`drift-check --sync` u 08:45, pa je nova epizoda čekala jutro. Od 06.11. pipeline
odmah nakon uploada zove:

```bash
cd ../domovina.ai/katalog
INGEST_TOKEN=… node scripts/ingest-episode.ts <ID>        # prioritetni / reprocess run
INGEST_TOKEN=… node scripts/ingest-episode.ts --all       # nightly i ostali runovi
   … --channels-out <fetch>/.katalog_channels.json        # mapa epizoda → kanal
```

Redoslijed u `run_pipeline.sh` (izmijenjen 06.11.):

1. KORAK 12 … 12.68: upload u `data/{id}/` (+ `upload_to_r2.js` sam napravi bundle bez kanala)
2. KORAK 13: listinzi kanala (`channels/data/*.json`), ne u fast-pathu
3. **KORAK 13.5: katalog ingest** + mapa kanala
4. **KORAK 12.7: `episode.json`** (premješten ovamo; i dalje zadnji upload u `data/`)

## Zašto retke gradi katalog, ne ovaj repo

`tier`, `flags`, `variantOf` i kanal `_unlisted` epizode računa
`katalog/src/ingest/plan.ts` + `resolve.ts`. Druga implementacija u JS-u ovog repoa bila
bi drugi filtar na dva mjesta (pouka iz voting tripwirea: 164 umjesto 218). Zato
fetch repo samo poziva katalogov skript i čita njegovu mapu.

## Zašto puni plan i za jednu epizodu

Redak kanala nosi `processed_count` i `latest_published_date`, a upsert ih prepisuje.
Brojka Tier 2 kanala ovisi o svim Tier 2 epizodama, a kanal svake zna tek resolver nad
njezinim `info.json`. Plan od jedne epizode bi kanalu upisao 1. Puni plan je ~560 GET-ova
na CDN i traje **3,3 s** (`npm run ingest-episode -- --all --dry-run`), `--all` s
upisom **6,5 s** (8 POST-ova, 0 promjena kad je poravnato).

CDN se čita u `fresh` načinu: listinzi kanala i 404 retry s jedinstvenim cache-busterom.
Bez toga bi edge mogao vratiti listing od prije KORAKA 13 ili 404 koji je aplikacija
zapamtila pod istim 5-minutnim bucketom dok je epizoda nastajala.

## Neuspjeh

Exit 0 = upisano; 1 = neki ID nije u planu (nema `article.json` u `.r2_keys_cache.json`
ili listingu), ostali upisani; 2 = nema tokena, mreža, 4xx/5xx. Pipeline u svim
slučajevima nastavlja s porukom u logu. `drift-check --sync` u 08:45 popravi propušteno
(launchd `ai.domovina.katalog-drift` u domovina.ai). Watchdog: 5 min po pozivu.

Drift-check uspoređuje samo ID-eve, pa promjenu zastavica bez novog ID-a (Magisterium
ili EN stignu satima nakon članka, izvan `run_pipeline.sh`) donosi tek idući `--all`,
tj. idući nightly.

## `channel` u `episode.json`

`{"slug","name","tier"}` iz `.katalog_channels.json` (gitignored). Pravila:

- kanal se u ovom repou ne računa, samo čita iz mape;
- polje dobivaju samo epizode s `first_seen` (prvi put viđene nakon sijanja mape
  **06.11.2026. 11:42**, 3670 epizoda tada dobilo `null`). Pravilo #4: bez backfilla.
  Backfill starog kataloga = postaviti `first_seen` starim epizodama u mapi, pa
  `build_episode_bundle.js --all` (≈ 3670 PUT-ova + purge). Posebna odluka;
- `channel` je u otisku samo kad postoji, pa se stari bundleovi ne diraju (suhi prolaz
  `--all`: 3671 nepromijenjeno, 0 za provjeru);
- verzija ostaje 1. Nepoznat ključ ignoriraju svi čitači: `podcast_core`
  `EpisodeBundle.tryParse`, `vijesti` zod `z.object`, katalog `parseEpisodeManifest`,
  `domovina-push` `isReady`.

Simulacija (mapa s `first_seen` za jednu epizodu, `KATALOG_CHANNEL_MAP=… node
build_episode_bundle.js --video-id TmrpIoKXN2c --dry-run`): `UPDATE 17 datoteka, inline 4,
kanal launched`.

## Provjera nakon nightlyja

```bash
# nova epizoda iz noći je u katalogu (bez ručnog uvoza)
curl -s https://domovina.ai/api/katalog/v1/episodes/<ID>/card | jq .
# episode.json ima channel
curl -s "https://cdn.domovina.ai/data/<ID>/episode.json?cb=$(date +%s)" | jq .channel
# drift-check poravnato
cd ../domovina.ai/katalog && npm run drift-check
# mapa: koliko je novih od sijanja
jq '[.episodes[] | select(.first_seen != null)] | length' .katalog_channels.json
```
