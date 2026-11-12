# Obrada svih novih epizoda — dnevni izvještaj

Generira `automatic/all_episodes_report.js` (nightly, prije slanja nove serije).
Kontekst i pilot: `docs/2026-11-01-obrada-svih-epizoda-pilot.md`. Porast tjedne kvote uključuje
sve što je u prozoru serije radilo na pretplati, pa je „po ep." gornja granica.

| datum | ep. | gotovo | pali | Mag HR | audio h | obrada (prvo slanje → zadnja ep.) | medijan min/ep | Mag kraj | tjedni % | +tjedni | /ep | max 5h % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-11 | 20 | 20 | 0 | 20 | 16.7 | 11. 11. 04:46 → 11. 11. 08:59 (4.2 h) | 10 | 11. 11. 13:21 | 26 → 33 | 7 | 0.35 | 49 |
| 2026-11-10 | 32 | 32 | 0 | 32 | 32.9 | 10. 11. 03:43 → 10. 11. 14:32 (10.8 h) | 18.4 | 10. 11. 16:49 | 19 → 23 | 4 | 0.13 | 19 |
| 2026-11-09 | 25 | 25 | 0 | 25 | 30.1 | 09. 11. 03:35 → 09. 11. 10:52 (7.3 h) | 20 | 09. 11. 12:55 | 14 → 16 | 2 | 0.08 | 12 |
| 2026-11-08 | 12 | 12 | 0 | 12 | 11.9 | 08. 11. 04:13 → 08. 11. 09:55 (5.7 h) | 10.7 | 08. 11. 10:12 | 13 → 13 | 0 | 0 | 14 |
| 2026-11-07 | 34 | 33 | 1 | 33 | 34.2 | 07. 11. 04:10 → 07. 11. 10:32 (6.4 h) | 12.2 | 07. 11. 19:34 | 2 → 11 | 9 | 0.27 | 91 |
| 2026-11-06 | 30 | 30 | 0 | 30 | 27.2 | 07. 11. 04:10 → 08. 11. 01:31 (21.4 h) | 13 | 08. 11. 05:14 | 2 → 13 | 11 | 0.37 | 91 |
| 2026-11-05 | 32 | 32 | 0 | 32 | 36.3 | 05. 11. 03:52 → 05. 11. 19:08 (15.3 h) | 16.9 | 05. 11. 21:07 | 61 → 86 | 25 | 0.78 | 91 |
| 2026-11-04 | 18 | 18 | 0 | 0 | 19 | 04. 11. 04:02 → 04. 11. 09:31 (5.5 h) | 18.3 | 04. 11. 09:31 | 45 → 51 | 6 | 0.33 | 56 |
| 2026-11-03 | 27 | 25 | 2 | 0 | 26.4 | 03. 11. 03:59 → 03. 11. 16:08 (12.2 h) | 13.8 | 03. 11. 16:08 | 33 → 43 | 10 | 0.4 | 53 |
| 2026-11-02 | 21 | 21 | 0 | 0 | 28.3 | 02. 11. 03:32 → 02. 11. 15:39 (12.1 h) | 280 | 02. 11. 15:39 | 17 → 27 | 10 | 0.48 | 77 |
| 2026-11-01 | 19 | 19 | 0 | 19 | 21.5 | 01. 11. 07:56 → 01. 11. 13:57 (6 h) | 13.6 | 01. 11. 15:34 | 8 → 15 | 7 | 0.37 | 34 |

**Prosjek zaključenih dana (11):** 0.34 boda tjednog/ep, 24.5 ep/dan → **~59 % tjedne kvote tjedno** samo za ovu obradu.

### Padovi 2026-11-07

- `LGJRjT7p960` — prioritetni download nije uspio (private/anti-bot?) — nema info.json u _unlisted

### Padovi 2026-11-03

- `KyMHBGFS5Gc` — prioritetni download nije uspio (private/anti-bot?) — nema info.json u _unlisted
- `VOcypz9_Ofo` — video nema zvuka (max -91 dB) — ASR preskočen, ne ponavlja se
