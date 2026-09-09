# 2026-09-09 — PAUZA svih launchd jobova (GCP free trial krediti istekli)

**Status: PAUZIRANO.** Ne odpauziravati dok novi GCP projekt nije spreman i
`gemini.conf` prebačen na njega.

## Što se dogodilo

Google Cloud billing account **016BE2-D24293-12968B** ("My Billing Account")
prešao je s free-trial kredita na **naplatu 31.08.2026.** Konzola javlja:

> You are now incurring charges in your billing account My Billing Account,
> as of August 31, 2026.

Stanje 09.09.2026. (`Current month`, 1.–9.9.): **cost $6.20, savings $0.00**,
`Forecasted total cost $3.66`, **↑ 375 % vs. August**. Krediti su bili ono što je
do sada apsorbiralo Vertex promet; od 31.08. svaki poziv ide na karticu.

Podsjetnik: krediti/billing se **ne mogu očitati odavde** — `gcloud` nema tu
naredbu, a račun nema billing role (memory `gcp_billing_credits_not_readable`).
Jedini izvor istine je konzola.

## Odluka

1. Pauzirati sve launchd jobove koji mogu potrošiti Vertex AI.
2. Sutra (10.09.2026.) napraviti **novi GCP projekt** i pipeline preusmjeriti
   na njega (`gemini.conf` → `VERTEX_PROJECT` / `PROJECT_ID`).
3. Tek onda odpauzirati.

## Što je pauzirano

Pauza je izvedena kao `bootout` + `disable` (disable **preživi reboot i login** —
bez njega bi se plist ponovno učitao iz `~/Library/LaunchAgents`):

```bash
for L in tv.domovina.fetch.nightly tv.domovina.fetch.priority \
         tv.domovina.fetch.magisterium tv.domovina.rag.sync; do
  launchctl bootout  gui/501/$L
  launchctl disable  gui/501/$L
done
```

| Label | Raspored | Troši Vertex? |
|---|---|---|
| `tv.domovina.fetch.nightly` | 01:00 dnevno | Da — koraci 7+8 idu `--gemini-backend claude` (pretplata), ali `translate_to_english.js` i eventualni vertex fallback udaraju Vertex |
| `tv.domovina.fetch.priority` | svakih 90 s | **Da** — `priority_poller.js` prima `backend` iz queue joba; `vertex` je default kad job ne kaže drukčije (`bridge/priority_poller.js:104`) |
| `tv.domovina.fetch.magisterium` | svakih 600 s | Ne (Magisterium MCP = Claude pretplata) — pauziran jer je dio istog lanca |
| `tv.domovina.rag.sync` | 05:00 dnevno | **Da** — `sync-vector-map.sh` / `sync-person-map.sh` → `scripts/vectormap_common.py` zove `aiplatform.googleapis.com …:generateContent` za LLM imenovanje klastera |

### Provjera stanja

```bash
launchctl print-disabled gui/501 | grep domovina
launchctl list | grep domovina
```

## Što NIJE pauzirano (provjereno — ne troše GCP)

| Label | Zašto ostaje |
|---|---|
| `ai.domovina.nightly-build` | Flutter build; `gcloud` se koristi samo u `play-upload.sh` / `play-promote.sh` (Play Console upload, ne Vertex) |
| `ai.domovina.voting-drift` | Supabase drift check |
| `com.domovina.ecosystem-brain.daily` | `daily-refresh.sh` **ne zove** `bin/llm` — samo `rollup-*.py` + git push |
| `ai.domovina.build-volume`, `ai.domovina.funnel-ui`, `ai.domovina.companion-server`, `ai.domovina.apple-secret-rotate` | lokalni servisi / hdiutil / secret rotacija |

## Kako odpauzirati (nakon migracije na novi projekt)

**Prvo** provjeri da `gemini.conf` i `VERTEX_PROJECT` (u `domovina-rag`) pokazuju
na NOVI projekt, pa tek onda:

```bash
for L in tv.domovina.fetch.nightly tv.domovina.fetch.priority \
         tv.domovina.fetch.magisterium tv.domovina.rag.sync; do
  launchctl enable    gui/501/$L
  launchctl bootstrap gui/501 ~/Library/LaunchAgents/$L.plist
done
```

`enable` je obavezan — `bootstrap` na disableanom labelu tiho ne pokrene job.

## Zamke uočene usput

- **`gcloud config` je bio na krivom projektu** (`workute-dev`, umjesto
  `project-a275a620`). Skripte koje se oslanjaju na `gcloud config get-value
  project` umjesto na `gemini.conf` bi u tom stanju gađale krivi projekt —
  provjeriti pri migraciji (memory `gcp_project_domovina_sync_ms`,
  `gcloud_active_account_flip_403`).
- **`fetch.priority` je najopasniji job u pauzi-po-potrebi scenariju**: vrti se
  svakih 90 s i backend mu diktira queue job, pa "pauzirali smo nightly" nije
  dovoljno.
- **`rag.sync` sam po sebi štedi**: `sync-vector-map.sh` preskače UMAP (i LLM
  imenovanje) kad se broj chunkova nije promijenio. S pauziranim fetch
  pipelineom ionako ne bi imao što regenerirati — ali pauziran je da ne ovisimo
  o toj pretpostavci.

## Otvorene stavke (nije provjereno u ovoj sesiji)

1. **Točan izvor $6.20 NIJE identificiran po SKU-u.** Nightly od 2026-07-29 vrti
   korake 7+8 na `--gemini-backend claude` (pretplata), pa najveći očekivani
   trošak *ne bi* trebao ići na Vertex. Preostali kandidati, poredani po
   vjerojatnosti:
   - `tv.domovina.fetch.priority` s jobovima koji u queueu imaju `backend=vertex`
   - `translate_to_english.js` (`gemini-3-flash-preview` @ global)
   - `sync-vector-map.sh` / `sync-person-map.sh` LLM imenovanje klastera
   - **Vertex AI Search / Discovery Engine datastore storage** — ovo bi trošilo
     *neovisno o launchd-u*, pa pauza ne bi pomogla. Provjeriti u konzoli
     (Billing → Cost table → group by SKU) prije nego se zaključi da je pauza
     riješila problem.
2. **Verificirati sutradan (10.09.) da je dnevni trošak pao na ~$0.** Ako nije,
   riječ je o storage/always-on SKU-u, ne o cronovima — vidi t. 1.
3. **`gcloud config` je na `workute-dev`.** Provjeriti prije migracije da nijedna
   skripta ne razrješava projekt preko `gcloud config get-value project`.
4. Migracija na novi projekt: popisati sve točke koje drže project id —
   `gemini.conf`, `VERTEX_PROJECT` (domovina-rag), `ecosystem-brain/bin/llm`
   (hardkodiran default `project-a275a620-ef0c-45ae-99e`).

## Vezani dokumenti

- `docs/claude_code_backend_2026-07.md` — `--gemini-backend claude` (put bez GCP troška)
- `docs/2026-08-28-konvergencija-pipelinea.md` — što se ne konvergira dok je pipeline u pauzi
