# 2026-09-14 — Migracija Vertexa na `bimbo-sync-prod` + odpauza launchd-a

**Status: AKTIVNO.** Ovo je projekt koji se koristi. Prethodna dva su mrtva.

## Kratko

`project-a275a620-ef0c-45ae-99e` potrošio je free-trial kredite 31.08.2026., pa je
09.09. cijeli launchd pauziran (`docs/2026-09-09-launchd-pauza-gcp-billing.md`).
14.09. je napravljen novi projekt **`bimbo-sync-prod`** s novim free-trial kreditima,
pipeline je prebačen na njega i odpauziran.

## Kronologija GCP projekata

| # | Projekt | Billing | Razdoblje | Zašto je napušten |
|---|---|---|---|---|
| 1 | `domovina-sync-ms` | `0140D3-08E99F-E8C697` | do 08.06.2026. | Dunning → `403 "Lightning dunning decision is deny"` |
| 2 | `project-a275a620-ef0c-45ae-99e` | `016BE2-D24293-12968B` | 08.06.–14.09.2026. | Free-trial krediti potrošeni 31.08.2026.; dalje naplata s kartice |
| 3 | **`bimbo-sync-prod`** | `01FAEA-72A278-819B25` | **od 14.09.2026.** | — aktualan |

`bimbo-sync-prod`: projectNumber `984390019987`, kreiran 14.09.2026.,
`roles/owner` za `stepanic.matija@gmail.com` i `bimbo.sync@gmail.com`.
Konzola: <https://console.cloud.google.com/iam-admin/iam?project=bimbo-sync-prod>

## Što je bilo potrebno na novom projektu

`aiplatform.googleapis.com` **nije bila enableana** — svjež projekt ima samo BigQuery/
storage/logging default set. Bez nje svaki Vertex poziv vraća 403 `SERVICE_DISABLED`,
što izgleda identično kao problem s pravima.

```bash
gcloud services enable aiplatform.googleapis.com \
  --project=bimbo-sync-prod --account=stepanic.matija@gmail.com
```

Nije trebalo dodavati IAM role — račun je `owner`, što pokriva `aiplatform.user`.

### Verifikacija (radi ovo, ne vjeruj konfiguraciji)

```bash
TOK=$(gcloud auth print-access-token --account=stepanic.matija@gmail.com)
curl -s -o /dev/null -w "HTTP=%{http_code}\n" \
  -X POST "https://aiplatform.googleapis.com/v1/projects/bimbo-sync-prod/locations/global/publishers/google/models/gemini-3.5-flash:generateContent" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"test"}]}],"generationConfig":{"maxOutputTokens":10}}'
```

Izmjereno 14.09.2026.: `gemini-3.5-flash` → **200**, `gemini-3-flash-preview` → **200**
(oba na `global` endpointu — 3.5-flash je i dalje global-only).

## Gdje je projekt pinan — SVIH 6 mjesta

Migracija koja preskoči i jedno od njih ostavlja dio sustava da gađa mrtav projekt,
a greška se vidi tek u nightlyju.

| Repo | Datoteka | Tko to čita |
|---|---|---|
| `fetch.domovina.tv` | `gemini.conf` → `VERTEX_PROJECT` | summarize/article/translate skripte |
| `fetch.domovina.tv` | `run_pipeline.sh` → `export VERTEX_PROJECT` | ima prednost nad `gemini.conf` |
| `fetch.domovina.tv` | `summarize_gemini.js` (hardkodirani fallback) | standalone pozivi bez run_pipeline |
| `fetch.domovina.tv` | `generate_article_gemini.js` (hardkodirani fallback) | isto |
| `domovina-rag` | `.env` → `VERTEX_PROJECT` | `tv.domovina.rag.sync` (`vectormap_common.py`) |
| `ecosystem-brain` | `.state/llm.env` → `VERTEX_PROJECT` | `bin/llm` (gitignoran — **ne vidi se u diffu**) |

⚠️ `ecosystem-brain/.state/llm.env` je gitignoran i **preglasi** default u `bin/llm`
(`os.environ.setdefault`). Popravak samo `bin/llm`-a ne mijenja ništa u praksi.

## Odpauza launchd-a

```bash
for L in tv.domovina.fetch.nightly tv.domovina.fetch.priority \
         tv.domovina.fetch.magisterium tv.domovina.rag.sync; do
  launchctl enable    gui/501/$L
  launchctl bootstrap gui/501 ~/Library/LaunchAgents/$L.plist
done
```

`enable` PRIJE `bootstrap`-a — `bootstrap` na disableanom labelu tiho ne pokrene job.

## Otvorene stavke naslijeđene iz pauze

1. **Trošak na starom projektu ($6.20 u 9 dana) nikad nije razložen po SKU-u.** Ako
   je dio toga bio Vertex AI Search / Discovery Engine **storage**, taj trošak ide
   neovisno o launchd-u i **i dalje teče na starom projektu** — pauza ga nije
   zaustavila, a ni ova migracija neće. Provjeriti u konzoli (Billing → Cost table →
   group by SKU) na `project-a275a620` i po potrebi obrisati datastore.
2. `import_to_vertex.js` (korak 11, Discovery Engine) radi nad datastoreom koji je
   ostao na starom projektu. Ne pokreće se u nightlyju (`--with-vertex-import` je
   opt-in), pa ne blokira — ali migracija RAG datastorea nije napravljena.
3. `gcloud config` globalni projekt bio je `workute-dev` i takav je ostavljen:
   sve relevantne skripte razrješavaju projekt iz `gemini.conf`/env, ne iz
   `gcloud config get-value project`. Ne oslanjaj se na globalni config.

## Vezani dokumenti

- `docs/2026-09-15-disk-ograda-i-cdn-404.md` — što je blokiralo prvi run nakon odpauze
  (ograda diska, Docker fiksna rezervacija, keširani CDN 404)
- `docs/2026-09-09-launchd-pauza-gcp-billing.md` — pauza, popis što troši Vertex
- `docs/PIPELINE_FULL.md` §2.1 — naplatni projekt u kontekstu cijelog pipelinea
- `docs/claude_code_backend_2026-07.md` — `--gemini-backend claude` (put bez GCP troška)
