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

## Što gdje živi

| datoteka | tko piše |
|---|---|
| `human_overrides.json` | aplikacija (i ruka) |
| `aligned_transcript.json` | **samo** faza 03 |
| `aligned_transcript.protokol.json` | faza 03 `--no-human` — referenca za mjerenje |
| `human_review/audit_overrides.json` | `tools/audit_overrides.js` |
| `human_review/rerun_*.log` | pozadinsko pokretanje faze 03/04 |

Puni opis, mjerenja i zamke: `docs/sabor_human_in_the_loop_2026-08.md`.
