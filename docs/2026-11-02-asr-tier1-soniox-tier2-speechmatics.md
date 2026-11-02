# ASR po tieru: Tier 1 Soniox, Tier 2 Speechmatics (02.11.2026.)

## Odluka

- **Tier 1** = praćeni kanali (`automatic/refresh_podcasts.sh` → `automatic/podcasts/*-lista.txt`,
  nightly). Primarni ASR **Soniox**, Speechmatics je fallback.
- **Tier 2** = sve ostalo što ide kroz pipeline.domovina.ai (obrada svih novih epizoda iz
  `automatic/enqueue_all_new.js`, ručni ⚡ za video koji nije na popisu praćenih).
  Primarni ASR **Speechmatics**, Soniox je fallback.

Soniox krediti su tako rezervirani za nightly. Govornici su u oba tiera pyannoteAI (2.7c).

## Zašto je bila rupa

Jutros (02.11.) je Soniox ostao bez kredita (`organization_balance_exhausted`). 12 epizoda prošlo je
bez ijednog članka, jer su se poklopile dvije odluke:

1. 28.10. `--no-speechmatics` je gasio i KORAK 2.7 i Soniox→Speechmatics fallback u 2.7b, uz
   pretpostavku da je mreža Canary (2.6) + lokalni pyannote (6).
2. 31.10. je lokalna diarizacija ugašena. Canary je i dalje davao tekst, ali bez govornika nije
   bilo `.wav.canary.diarized.srt`, a hibrid 2.7c zna uzeti riječi samo iz Sonioxa ili Speechmaticsa.

## Mehanizam

| Gdje | Što |
|---|---|
| `run_pipeline.sh` | `--no-speechmatics` gasi SAMO KORAK 2.7. Fallback u 2.7b gasi `--no-speechmatics-fallback` / `SPEECHMATICS_FALLBACK=0` |
| `transcribe_soniox.js` | `--primary speechmatics` ili env `ASR_PRIMARY=speechmatics`: prvo Speechmatics, pa Soniox fallback. `.soniox.meta.json` dobije `provider: "speechmatics", tier: 2` |
| `pipeline.domovina.ai/bridge/plan.js` | `isTier2()`: video nije u popisu praćenih → `env.ASR_PRIMARY = 'speechmatics'` |
| `pipeline.domovina.ai/bridge/priority_poller.js` | `tier1Ids()` čita ID-eve iz `automatic/podcasts/*-lista.txt` pri svakom claimu; nečitljiv popis → sve kroz Soniox |

Rubni slučaj: nova epizoda praćenog kanala pokrenuta ručnim ⚡ prije nego je `refresh_podcasts.sh`
upiše u listu ide kao Tier 2.

## Trošak

Procjene iz koda (`SONIOX_USD_PER_HOUR` 0,12, `SPEECHMATICS_USD_PER_HOUR` 0,80 za enhanced; cijene
nisu ponovno provjerene s cjenikom). Tier 2 je ~20 epizoda / ~24 h zvuka dnevno → ~19 $/dan kroz
Speechmatics (~580 $/mj.), naspram ~3 $/dan kroz Soniox. Prijava na Speechmatics Startup Program
(do 50 000 $ kredita) je otvorena; Sonioxu je 02.11. poslan upit za kredite (info@soniox.com).
