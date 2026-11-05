# Obrada svih novih epizoda — dnevni izvještaj

Generira `automatic/all_episodes_report.js` (nightly, prije slanja nove serije).
Kontekst i pilot: `docs/2026-11-01-obrada-svih-epizoda-pilot.md`. Porast tjedne kvote uključuje
sve što je u prozoru serije radilo na pretplati, pa je „po ep." gornja granica.

| datum | ep. | gotovo | pali | Mag HR | audio h | obrada (prvo slanje → zadnja ep.) | medijan min/ep | Mag kraj | tjedni % | +tjedni | /ep | max 5h % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-04 ⏳ | 18 | 18 | 0 | 0 | 19 | 04. 11. 04:02 → 04. 11. 09:31 (5.5 h) | 18.3 | 04. 11. 09:31 | 45 → 61 | 16 | 0.89 | 58 |
| 2026-11-03 | 27 | 25 | 2 | 0 | 26.4 | 03. 11. 03:59 → 03. 11. 16:08 (12.2 h) | 13.8 | 03. 11. 16:08 | 33 → 43 | 10 | 0.4 | 53 |
| 2026-11-02 | 21 | 21 | 0 | 0 | 28.3 | 02. 11. 03:32 → 02. 11. 15:39 (12.1 h) | 280 | 02. 11. 15:39 | 17 → 27 | 10 | 0.48 | 77 |
| 2026-11-01 | 19 | 19 | 0 | 19 | 21.5 | 01. 11. 07:56 → 01. 11. 13:57 (6 h) | 13.6 | 01. 11. 15:34 | 8 → 15 | 7 | 0.37 | 34 |

**Prosjek zaključenih dana (3):** 0.42 boda tjednog/ep, 22.3 ep/dan → **~65 % tjedne kvote tjedno** samo za ovu obradu.

### Padovi 2026-11-03

- `KyMHBGFS5Gc` — prioritetni download nije uspio (private/anti-bot?) — nema info.json u _unlisted
- `VOcypz9_Ofo` — video nema zvuka (max -91 dB) — ASR preskočen, ne ponavlja se
