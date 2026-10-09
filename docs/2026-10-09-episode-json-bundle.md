# `data/{id}/episode.json` — bundle epizode (9.10.2026.)

Pipeline strana iz frontend plana
`../domovina.ai/docs/2026-10-08-brzina-ucitavanja-naslovnice.md` §8. Ugovor (v1) je
doc komentar u `../domovina.ai/lib/models/episode_bundle.dart`, shema u
`data_contract.md` §15.

Ekran epizode slao je ~29 zahtjeva po otvaranju (17 datoteka + retry svakog 404 s
cache-busterom + HEAD probe medija), a tipično ih postoji 7. S bundleom: 3.

## Kako radi `build_episode_bundle.js`

1. LIST `data/` (cijeli katalog, ~28 stranica) ili `data/{id}/` po epizodi.
2. Otisak epizode = sortirana imena datoteka + ETag-ovi pet inline datoteka.
   Isti otisak kao u `.episode_bundle_state.json` i `episode.json` postoji → preskok,
   nula GET-ova. ETag-ovi videa, e-knjige i sponzora namjerno nisu u otisku.
3. Inače GET pet JSON-ova **s R2** (ne s diska — CDN zna biti bogatiji), složi bundle.
4. Bez lokalnog stanja (drugi stroj, obrisan fajl): GET postojećeg bundlea i usporedba
   bez `generated_at` → nema prepisa ako je isti.
5. PUT s `public, max-age=60, must-revalidate`; nov bundle se purgea u obje
   `Vary: Origin` varijante (edge je mogao zapamtiti 404 dok ga je klijent tražio).

## Tko ga zove

| mjesto | opseg |
|---|---|
| `run_pipeline.sh` KORAK 12.7 (nakon 12.5 video i 12.6 audio) | `--all`; uz `MODAL_ONLY_ID` / ponovnu obradu samo ta epizoda |
| `upload_to_r2.js` (kraj, `--input-dir` mod) | epizode s novim/popravljenim `data/` ključem; >200 → `--all` |
| `force_upload.js` | ta epizoda (KORAK 12.1, reconcile, Magisterium poller) |

`run_pipeline.sh` postavlja `EPISODE_BUNDLE_SKIP=1` za KORAK 12, inače bi bundle
izašao bez `video_h264.mp4` i odmah bio prepisan u 12.7. Što god uploadaju drugi
alati, noćni 12.7 nad cijelim katalogom to sustigne.

## Mjerenja (backfill 9.10.2026.)

- 3 378 novih bundleova u 579 s, 394 MB ukupno (prosjek 119 KB sirovo), purge
  6 756 / 6 756 zapisa. Ponovni `--all`: 0 zapisa, 14 s (samo LIST).
- Brotli preko CDN-a: npr. 13,5 KB i 47,5 KB.
- Trošak backfilla: ~3 400 Class A + ~14 000 Class B operacija — 0,3 % / 0,14 %
  besplatne mjesečne kvote R2. Nightly: ~28 LIST-ova + samo promijenjene epizode.

## Otvoreno

- **`info.json` dominira veličinom** (yt-dlp popis formata): kod `-8NKsgpKWMQ`
  513 KB od 539 KB bundlea. Ugovor v1 traži puni sadržaj; kandidat za v2 je
  skraćeni `info.json` s poljima koja klijent stvarno čita.
