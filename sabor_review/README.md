# `sabor_review` — ljudski pregled imenovanja govornika

Lokalna aplikacija bez ijedne vanjske ovisnosti (isti obrazac kao
`dashboard/server.js`).

```bash
node sabor_review/server.js                       # → http://localhost:8788
node sabor_review/server.js --port 8790 --output-dir storage/output/sabor
SABOR_REVIEWER="Ime Prezime" node sabor_review/server.js
```

Zamisao: AI obradi što više, čovjek pregleda **samo ono gdje je pouzdanost
niska**. Odluka → faza 03 → razlika, sve u ~0.4 s.

## ⛔ Jedno pravilo

Aplikacija **nikad** ne piše u `aligned_transcript.json`. Piše isključivo u
`human_overrides.json`; transkript proizvodi samo faza 03. Zbog toga se
transkript smije baciti i proizvesti iznova, a ljudski rad preživi.

## Red čekanja

| razina | značenje |
|---|---|
| `nerazriješeno` | glasovi najava se ne slažu |
| `srednja` | identitet stoji na **jednoj jedinoj** najavi |
| `neimenovano` | protokol je za tu oznaku nijem (~33 % vremena) |
| `visoka` | dvije ili više složnih najava |

Unutar razine: po govornom vremenu silazno.

## Nova sjednica

Aplikacija čita disk pri svakom zahtjevu — nova sjednica se pojavi **bez
ponovnog pokretanja poslužitelja**, dovoljno je osvježiti stranicu.

1. `sabor_pipeline/data/sessions/<session_id>.json` (video ID-ovi po dijelovima)
2. `sabor_pipeline/run_sabor_session.sh --session <session_id>`
3. osvježi `localhost:8788` i odaberi sjednicu iz padajućeg izbornika

Sjednice koje još nisu prošle fazu 03 **vide se u izborniku** (onemogućene, uz
fazu koja nedostaje) — da se ne čini kako ih aplikacija ne vidi.

**Registar se čita po sjednici**, iz `roster.path` koji faza 03 zapisuje u
`aligned_transcript.json`. Sjednica iz drugog saziva time automatski dobiva svoj
popis zastupnika; da je registar bio globalan, imena bi se razrješavala u krive
ljude bez ijedne poruke.

## Što gdje živi

| datoteka | tko piše |
|---|---|
| `human_overrides.json` | aplikacija (i ruka) |
| `aligned_transcript.json` | **samo** faza 03 |
| `aligned_transcript.protokol.json` | faza 03 `--no-human` — referenca za mjerenje |
| `human_review/audit_overrides.json` | `tools/audit_overrides.js` |
| `human_review/rerun_*.log` | pozadinsko pokretanje faze 03/04 |

Puni opis, mjerenja i zamke: `docs/sabor_human_in_the_loop_2026-08.md`.
