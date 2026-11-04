# Dnevni report: vrijeme po koraku za svaku epizodu

Skripte kojima je složen `docs/2026-11-04-nightly-report-vremena-po-koraku.{md,pdf}`.
Nula LLM poziva, samo logovi + API. Radni dir `W` je bilo koji prazan direktorij.

```bash
W=/tmp/rep; mkdir -p $W; export LC_ALL=C; D=2026-11-04
for x in priority nightly magisterium magisterium-en; do
  sed -E 's/\x1b\[[0-9;]*[mK]//g' automatic/logs/${x}_$D.log > $W/$x.log; done
grep -v -E "Nema prioritetnih|Nema jobova|proxy .* ne odgovara|SLOT 1 (START|DONE)|yt-dlp: /opt|slot 1 . worker PID" \
  $W/priority.log > $W/prio_f.log
node tools/nightly_step_report/dump.mjs $W        # jobs.json iz pipeline.domovina.ai (cwd = repo, čita .env)
python3 tools/nightly_step_report/parse.py $W      # runs.json: KORAK timestampovi po prioritetnom jobu
python3 tools/nightly_step_report/parse_mag.py $W  # mag.json: Magisterium HR/EN tickovi (filtar datuma je u kodu)
python3 tools/nightly_step_report/build.py $W      # report.html + report.md
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer \
  --user-data-dir=$W/chrome --print-to-pdf=$W/report.pdf file://$W/report.html
```

Zamke:
- `build.py` ima **ručno upisane** podatke za nightly epizode (`NIGHT`: Soniox/sažetak/članak/reels
  sekunde iz `nightly_*.log`), `NIGHT_END`, datume i tekst sažetka za 04.11. Za drugi dan
  prepiši te dijelove; sve ostalo se računa iz logova.
- Posao se veže na job **id** (`→ ⚡ VID (job-id)`), ne na youtube_id: isti video zna imati
  više jobova (KyMHBGFS5Gc je pao 03.11. i 04.11.).
- `/api/magisterium?limit=…` vraća max 200 redaka, pa Magisterium vremena dolaze iz logova.
- Regex za korak mora hvatati sufiks slova (`KORAK 2.7b`, `2.7c`).
