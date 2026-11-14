# A/B agy modela za Tier 2 članak: flash-low vs Gemini 4 Hydrogen (14.–15.11.2026.)

> **Stanje: U TIJEKU.** Prvi krug (flash-low, hydrogen-low, hydrogen-medium) pokrenut 14.11. u 19:16,
> hydrogen-high se nadovezuje (`run_high.sh`). Tablica ispod je djelomična (19:32). Preporuka još
> nije dana i **default se ne mijenja bez potvrde korisnika**.

## Zašto

Tier 2 (pipeline.domovina.ai) od 10.11. piše članak, sažetak i reels kroz agy na
`gemini-3.8-flash-low` (`AGY_ARTICLE_MODEL`, `AGY_MODEL`), a EN kroz `TRANSLATE_AGY_MODEL`.
`agy models` od 14.11. nudi `gemini-4-hydrogen-{low,medium,high,xhigh}`. Prije zamjene treba
izmjeriti trajanje, kvotu i vjernost transkriptu. Argon je 07.11. imao zaseban malen tjedni limit
(3 članka = 9,6 %), vidi `docs/2026-11-07-tier2-agy-i-5h-ograda.md`.

## Postav

- Iste 3 epizode kao A/B 07.11. (Opus referenca postoji): `HYNJ0Ddwjyw` Škabrnja 28 min
  (radio_benkovac), `L9JEBGkSokM` privatna klinika 52 min (psz_podcast), `nToZnW8RHP4` Prgavi
  105 min (prgavi_podcast).
- Ulaz: `.wav.canary.diarized.srt` + `.canary.summary.json` + `.info.json`, kopirani u
  `experiments/2026-11-15-agy-hydrogen-ab/out/<model>/` (nikad `storage/output`; slug je za sve
  agy modele `agy`, pa bi pisanje na mjesto pregazilo objavljeni članak).
- `GEMINI_BACKEND=agy AGY_ARTICLE_MODEL=<model> PRIORITY_SLOT=9 node generate_article_gemini.js --file <srt>`;
  slot 9 = vlastita tmux sesija, ne sudara se s bridgeom. `FIDELITY_CLAUSE` je aktivan za sve.
- `run.sh` čita agy `/usage` prije svakog članka i staje ako Gemini 5h ≥ 60 % (Tier 2 queue troši
  isti prozor). `metrics.py` = iste mjere kao 07.11. (popis pojačanja malo širi, isti za sve).

## Kvota: Hydrogen NEMA zaseban limit

`agy /usage` ni nakon Hydrogen poziva ne pokazuje novi bucket (grupe: Gemini Models 5h + tjedni,
Claude/GPT, Gemini 4 Argon). Hydrogen troši **isti Gemini 5h i tjedni prozor** kao flash.
Razlike „prije” između članaka su gornja granica, jer Tier 2 queue paralelno piše članke kroz agy.
Cijeli prvi krug (8 članaka, 19:16–19:31): Gemini 5h 18,5 % → 28,1 %, tjedni ~10 → ~11 %.

## Rezultati (djelomično, 14.11. 19:32)

| Epizoda | Model | znakova | sekcija | citata | pojačanja | bold | prijepis | rupa min | trajanje |
|---|---|---|---|---|---|---|---|---|---|
| Škabrnja 28 min | opus | 17 337 | 18 | 13 | 9 | 107 | 0 | 3,6 | ~6 min |
| | flash-low | 8 961 | 10 | 9 | 5 | 0 | 0 | 5,1 | 78 s |
| | hydrogen-low | 10 130 | 7 | 0 | 5 | 63 | 0 | 5,8 | 51 s |
| | hydrogen-medium | 12 003 | 11 | 6 | 2 | 33 | 0 | 3,5 | 73 s |
| Privatna klinika 52 min | opus | 23 424 | 18 | 13 | 8 | 55 | 0 | 4,6 | |
| | flash-low | 16 951 | 21 | 15 | 8 | 0 | 0 | 5,4 | 147 s |
| | hydrogen-low | 15 995 | 15 | 8 | 4 | 0 | 0 | 8,1 | 91 s |
| | hydrogen-medium | 19 435 | 16 | 0 | 6 | 3 | 0 | 6,9 | 127 s |
| Prgavi 105 min | opus | 53 097 | 65 | 0 | 7 | 174 | 0 | 3,7 | |
| | flash-low | 17 736 | 24 | 11 | 10 | 0 | 0 | 9,5 | 185 s |
| | hydrogen-low | 18 046 | 14 | 1 | 4 | 0 | 0 | 13,7 | 119 s |
| | hydrogen-medium | | | | | | | | radi |
| | hydrogen-high (×3) | | | | | | | | čeka |

Prvi dojam (samo brojke, tekst još nije čitan): Hydrogen je brži od flash-lowa i ima manje
pojačanja, ali ni jedan agy model ne prilazi Opusu po opsegu kod duge epizode (Prgavi ~18 000 vs
53 000 znakova), a hydrogen-low ostavlja najveće rupe između kadrova.

## Što još treba

1. Dopuniti tablicu (`python3 experiments/2026-11-15-agy-hydrogen-ab/metrics.py`) za
   hydrogen-medium Prgavi i hydrogen-high ×3.
2. Vjernost: pročitati isti odsječak (Škabrnja 10:00–15:00, Prgavi 40.–47. min) u svakom modelu i
   provjeriti u SRT-u, kao 07.11.
3. Arhiva: `node experiments/2026-11-15-agy-hydrogen-ab/archive.js --upload`.
4. Preporuka korisniku; tek nakon potvrde mijenjati default u `generate_article_gemini.js` /
   bridge `TIER2_LLM_BACKEND` okolini.

## Trajna pohrana (za buduće usporedbe)

`archive.js` kopira svaki članak, plan (outline), sirove odgovore, log i `meta.json` (model,
trajanje, Gemini 5h prije/poslije) u:

- disk: `experiments/2026-11-15-agy-hydrogen-ab/data/output/<kanal>/<base>.exp-20261114.agy-<model>.{clanak,plan,meta}.json`
  (`data` → `/Volumes/DOMOVINA1TB/experiments/2026-11-15-agy-hydrogen-ab`), uz Opus referencu
  `…claude-opus-referenca.clanak.json`. Taj raspored čita `dataset.domovina.tv/sync_dataset.sh`
  (korak 1c); sync NE čita CDN.
- CDN (s `--upload`): `https://cdn.domovina.ai/experiments/2026-11-15-agy-hydrogen-ab/<kanal>/…`,
  `Cache-Control: max-age=3600`.

Imena su namjerno hrvatska (`clanak`, `plan`): sufiks `.article.json` bi pipeline shvatio kao gotov korak.

## Vezani dokumenti

- `docs/2026-11-07-tier2-agy-i-5h-ograda.md` — A/B 07.11. (Opus, flash-low/high, argon-low), FIDELITY_CLAUSE
- `docs/2026-11-14-canary-rezerva-modal-pyannote.md` — „Otvoreno” s ovim zadatkom
