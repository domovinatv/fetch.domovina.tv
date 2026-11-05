# Dnevni report: vrijeme po koraku za svaku epizodu

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
