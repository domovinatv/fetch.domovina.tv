# Dnevni report: vrijeme po koraku za svaku epizodu

## Automatski (od 05.11.2026.)

launchd `tv.domovina.fetch.nightly-report` (svakih 15 min) pokreće `auto.py`. Kad je dan **stvarno
gotov**, složi PDF i pošalje ga u Telegram grupu `ms-social-poster` (bot `@ms_social_poster_bot`),
jednom dnevno:

- nightly je ispisao SAŽETAK;
- svi Tier 2 poslovi koje je nightly poslao (`created_at` od 03:00 do kraja nightlyja + 30 min) su `done`/`failed`;
- svaka epizoda dana na CDN-u (`episode.json`) ima članak i EN članak, uz Magisterium HR i Magisterium EN,
  a nijedan Magisterium/EN posao tih epizoda ne čeka u redu.

Šalje se **album 4 uspravne slike** (gantogram okomito, Tier 2 po epizodi, kamo ide vrijeme, stanje po epizodi; za mobitel i Telegram Desktop, koji PDF ne prikazuje) s potpisom = sažetak, pa **puni A4 PDF** za desktop (`POST /telegram/photos` + `/telegram/document`).

Odmah nakon slanja pokreće **drugi deploy javnog kataloga** (`../podcast.domovina.ai/scripts/refresh.sh`, build + `wrangler deploy`, non-fatal; `CATALOG_REFRESH=0` gasi). Nightly 5c deploya na početku noći, prije nego što su Tier 2 epizode obrađene; ovaj rebuild im daje oznaku D i poveznicu na `domovina.ai/v/<id>` isti dan (izvor: `data/<id>/article.json` u `.r2_keys_cache.json`).

U **21:00** (`REPORT_DEADLINE`) šalje i ako nije sve gotovo, s popisom što fali. Token bota je samo u
Workeru `li.domovina.ai` (repo `~/git/stepanic/linkedin-poster`), pa PDF ide kroz njegov
`POST /telegram/document` (bearer = `API_TOKEN` iz `linkedin-poster/.dev.vars`). Sažetak u
automatskom reportu su samo činjenice (`auto_summary()` u `build.py`); tumačenje uzroka ostaje ručno.

```bash
tools/nightly_step_report/auto.py --date 2026-11-05 --force --dry-run   # složi, ne šalji
tools/nightly_step_report/auto.py --date 2026-11-05 --force             # pošalji odmah
tools/nightly_step_report/auto.py --date 2026-11-05 --force --manual    # s ručnim days/<datum>.json
automatic/launchd/install.sh nightly-report                              # (re)instalacija
```

Radni dir i PDF: `automatic/logs/nightly_report/<datum>/` (`sent.json` = poslano; obriši ga za
ponovno slanje). Log: `automatic/logs/launchd.nightly-report.out.log`.

## Ručno

Skripte kojima je složen `docs/2026-11-04-nightly-report-vremena-po-koraku.{md,pdf}`.
Nula LLM poziva, samo logovi + API. Radni dir `W` je bilo koji prazan direktorij.

```bash
W=/tmp/rep; mkdir -p $W; export LC_ALL=C; D=2026-11-04
for x in priority nightly magisterium magisterium-en; do
  sed -E 's/\x1b\[[0-9;]*[mK]//g' automatic/logs/${x}_$D.log > $W/$x.log; done
grep -v -E "Nema prioritetnih|Nema jobova|proxy .* ne odgovara|SLOT [12] (START|DONE)|yt-dlp: /opt|slot [12] . worker PID" \
  $W/priority.log > $W/prio_f.log
node tools/nightly_step_report/dump.mjs $W        # jobs.json iz pipeline.domovina.ai (cwd = repo, čita .env)
python3 tools/nightly_step_report/parse.py $W      # runs.json: KORAK timestampovi po prioritetnom jobu
python3 tools/nightly_step_report/parse_mag.py $W $D  # mag.json: Magisterium HR/EN tickovi tog dana
python3 tools/nightly_step_report/build.py $W tools/nightly_step_report/days/$D.json  # report.html + report.md
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer \
  --virtual-time-budget=15000 --user-data-dir=$W/chrome --print-to-pdf=$W/report.pdf file://$W/report.html
```

Zamke:
- Sve što se ne da izračunati iz logova je u `days/<datum>.json`: nightly epizode (`night`:
  Soniox/sažetak/članak/reels sekunde iz `nightly_*.log`), `night_end` (prvi „Kraj:” u nightly logu),
  raspon osi, oznaka enqueuea, `ignore_vids` i nalazi (`summary`, markdown s `{placeholderima}` koje
  `build.py` računa: slotovi, preklapanje, red Magisteriuma…). Za novi dan kopiraj prošli JSON i
  prepiši te dijelove. (04.11. je složen prije ovog rasporeda; njegov JSON ne postoji.)
- Od 05.11. rade **dva slota**: linije workera imaju prefiks `[s1]`/`[s2]` i ispreplete se, pa
  `parse.py` prati posao po slotu. Bez toga se koraci dvaju poslova pomiješaju.
- Gantogram (Mermaid) je u .md i u PDF-u (mermaid s jsdelivra, zato `--virtual-time-budget`).
  EN traka nije u njemu (40+ redaka ga stisne). Provjera: `tools/check_mermaid.sh`.
- Posao se veže na job **id** (`→ ⚡ VID (job-id)`), ne na youtube_id: isti video zna imati
  više jobova (KyMHBGFS5Gc je pao 03.11. i 04.11.).
- `/api/magisterium?limit=…` vraća max 200 redaka, pa Magisterium vremena dolaze iz logova.
- Regex za korak mora hvatati sufiks slova (`KORAK 2.7b`, `2.7c`).
