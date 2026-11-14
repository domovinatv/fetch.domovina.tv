# A/B agy modela za Tier 2 članak: flash-low vs Gemini 4 Hydrogen (14.–15.11.2026.)

> **Stanje: mjerenje GOTOVO 14.11. u 19:47** (12 agy članaka, svi rc=0). Preporuka je dolje.
> **Default se ne mijenja bez potvrde korisnika.**

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

## Rezultati

| Epizoda | Model | znakova | sekcija | citata | pojačanja | bold | rupa min | trajanje |
|---|---|---|---|---|---|---|---|---|
| Škabrnja 28 min | opus (07.11.) | 17 337 | 18 | 13 | 9 | 107 | 3,6 | ~6 min |
| | flash-low | 8 961 | 10 | 9 | 5 | 0 | 5,1 | 78 s |
| | hydrogen-low | 10 130 | 7 | 0 | 5 | 63 | 5,8 | 51 s |
| | hydrogen-medium | 12 003 | 11 | 6 | 2 | 33 | 3,5 | 73 s |
| | hydrogen-high | 14 728 | 10 | 5 | 4 | 84 | 4,4 | 98 s |
| Privatna klinika 52 min | opus | 23 424 | 18 | 13 | 8 | 55 | 4,6 | |
| | flash-low | 16 951 | 21 | 15 | 8 | 0 | 5,4 | 147 s |
| | hydrogen-low | 15 995 | 15 | 8 | 4 | 0 | 8,1 | 91 s |
| | hydrogen-medium | 19 435 | 16 | 0 | 6 | 3 | 6,9 | 127 s |
| | hydrogen-high | 22 989 | 17 | 21 | 3 | 20 | 5,6 | 244 s |
| Prgavi 105 min | opus | 53 097 | 65 | 0 | 7 | 174 | 3,7 | |
| | flash-low | 17 736 | 24 | 11 | 10 | 0 | 9,5 | 185 s |
| | hydrogen-low | 18 046 | 14 | 1 | 4 | 0 | 13,7 | 119 s |
| | hydrogen-medium | 29 269 | 24 | 19 | 3 | 5 | 9,2 | 219 s |
| | hydrogen-high | 33 398 | 20 | 2 | 0 | 63 | 12,7 | 329 s |

Spominjanja prijepisa/ASR-a: 0 u svim člancima.

### Vjernost: izjava o Vukovaru (Škabrnja 13:44)

U snimci: „smo u dogovoru da djeca iz osnovnih škola dolaze u naš memorijalni centar … kao što
imate u Vukovaru, osmi razredi … terensku nastavu da je plan da dolazi, tako i u Škabrnju”.

- **flash-low:** „planira se uvođenje terenske nastave za učenike osmih razreda osnovnih škola
  **iz cijele Hrvatske**” — dodano, isto uljepšavanje koje je 07.11. radio flash-high.
- **hydrogen-low / medium / high:** sva tri točno: „u dogovoru … da učenici osnovnih škola dolaze …
  po uzoru na posjete osmih razreda Vukovaru”, plan ostaje plan („nada se skoroj realizaciji”).
  hydrogen-high ocjenu o „cijeloj godini” ispravno pripisuje voditelju Brkiću.

### Kvota

Hydrogen troši Gemini 5h/tjedni prozor (nema zaseban bucket). Za vrijeme cijelog A/B-a (19:16–19:47,
12 članaka + Tier 2 queue paralelno): Gemini 5h 18,5 → 39,8 %, tjedni ~10 → 16,2 %. hydrogen-high
krug (3 članka) 30,6 → ~39,8 % 5h, s queueom. Po članku se ne može čisto izdvojiti dok queue radi.

## Preporuka

- **Članak (AGY_ARTICLE_MODEL): `gemini-4-hydrogen-medium`.** Točniji od flash-lowa (bez dodanih
  kvalifikatora, najmanje pojačanja), 1,3–1,7× opsega flash-lowa, a trajanje slično (73–219 s vs
  78–185 s). Kod duge epizode i dalje je ~55 % Opusa.
- **hydrogen-high** daje najviše teksta (do 98 % Opusa na 52 min), ali 1,5–2× dulje od mediuma i
  vjerojatno više kvote; uz ~50 Tier 2 epizoda dnevno to je rizik za tjedni Gemini prozor.
- **hydrogen-low** nije bolji od flash-lowa po opsegu, a ima najveće rupe između kadrova.
- Sažetak, reels i EN ostaju na flash-low dok se ne izmjere zasebno.
- Nakon zamjene pratiti 1–2 dana `agy_gemini_weekly` u `quota_samples.jsonl`.

## Trajna pohrana (za buduće usporedbe)

`archive.js` kopira svaki članak, plan (outline), sirove odgovore, log i `meta.json` (model,
trajanje, Gemini 5h prije/poslije) u:

- disk: `experiments/2026-11-15-agy-hydrogen-ab/data/output/<kanal>/<base>.exp-20261114.agy-<model>.{clanak,plan,meta}.json`
  (`data` → `/Volumes/DOMOVINA1TB/experiments/2026-11-15-agy-hydrogen-ab`), uz Opus referencu
  `…claude-opus-referenca.clanak.json`. Taj raspored čita `dataset.domovina.tv/sync_dataset.sh`
  (korak 1c); sync NE čita CDN.
- CDN (uploadano 14.11. 19:48, 87 datoteka): `https://cdn.domovina.ai/experiments/2026-11-15-agy-hydrogen-ab/<kanal>/…`,
  `Cache-Control: max-age=3600`.

Imena su namjerno hrvatska (`clanak`, `plan`): sufiks `.article.json` bi pipeline shvatio kao gotov korak.

## Vezani dokumenti

- `docs/2026-11-07-tier2-agy-i-5h-ograda.md` — A/B 07.11. (Opus, flash-low/high, argon-low), FIDELITY_CLAUSE
- `docs/2026-11-14-canary-rezerva-modal-pyannote.md` — „Otvoreno” s ovim zadatkom
