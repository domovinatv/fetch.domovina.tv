# Cross-channel A/B validacija normalizacije glasnoće

**Datum:** 2026-06-01
**Prethodi:** [`loudness_normalization_2026-05.md`](loudness_normalization_2026-05.md) (FAZA 2 — arhitektura + validacija na domovina_tv), [`loudness_analysis_2026-05.md`](loudness_analysis_2026-05.md) (FAZA 1 — mjerenje)
**Skripta:** `normalize_loudness.js` (single-pass dynamic loudnorm, I=-16 : TP=-2 : LRA=11)

Ovaj dokument bilježi **slušnu (A/B) validaciju kataloga izvan domovina_tv kanala** — provjeru da normalizacija dobro radi na raznolikim izvorima (različiti snimatelji, mikrofoni, ulazne glasnoće), uključujući rubne slučajeve (ekstremno tihi i preglasni originali).

---

## Polazni problem (dijagnoza A/B alata)

A/B set se izvorno pripremao kao `.mp4` (ORIGINAL vs POPRAVLJENO) u `/Volumes/DOMOVINA2TB/loudnorm_video_ab_domovina_tv/`. Većina ih se **nije otvarala u QuickTimeu** — ne zbog zvuka, nego zbog **videa**:

- yt-dlp iz mkv izvora daje **VP9 video**; QuickTime ne dekodira VP9 u .mp4 kontejneru → odbija otvoriti fajl prije nego dođe do audija.
- Jedini koji se otvarao bio je izvor s **H.264** videom.
- Audio u svim fajlovima je već bio uredan (AAC stereo, normaliziran) — codec videa je bio jedini blocker.

**Rješenje za A/B preslušavanje:** izolirati zvuk u `.mp3` (svira svugdje, uklj. QuickTime). VP9 problem time potpuno otpada. Svi A/B materijali ispod su mp3 parovi.

> Usputni nalaz: stariji `.loudnorm.mp4` (prije 2026-05-29 17:03 fixa) imali su audio na **96000 Hz** — loudnorm interno resampla na 192k i to je curilo u AAC enkoder jer `-ar` nije bio pinan na mp4 audio izlazu. Aktualni `normalize_loudness.js` pinning ima (`-ar 48000`, linije 202/208). A/B parovi ispod koriste finalne `.loudnorm.mp3` (128k), ne te zastarjele mp4.

---

## Materijali

| Set | Lokacija | Sadržaj |
|---|---|---|
| domovina_tv (6 epizoda) | `…/loudnorm_video_ab_domovina_tv/ab_mp3/` | `NN_naziv_{ORIGINAL,POPRAVLJENO}.mp3` |
| **Cross-channel (12 kanala)** | `…/loudnorm_video_ab_domovina_tv/ab_mp3_kanali/` | `{kanal}_{ORIGINAL,POPRAVLJENO}.mp3` |

**Metoda po epizodi:**
- **ORIGINAL** = audio izvučen iz *istog izvora* koji je loudnorm koristio (čitano iz `audio_source` u `.loudnorm.json`), **bez** normalizacije → mp3 128k. Zadržava izvornu (često tihu/glasnu) glasnoću.
- **POPRAVLJENO** = postojeći produkcijski `.loudnorm.mp3` (128k, single-pass dynamic, I=-16:TP=-2:LRA=11).

Jedina razlika između para je normalizacija → pošten A/B.

---

## Rezultati — 12 kanala, po jedna nasumična epizoda

Sortirano po **|pomak|** (apsolutna promjena glasnoće koju je loudnorm primijenio). Mali pomak = original je već dolazio blizu cilja od -16 LUFS.

| Kanal | Izvor | ORIGINAL (LUFS) | → POPRAVLJ. | Pomak | Ulazni TP | Ulazni LRA | Ocjena |
|---|---|---:|---:|---:|---:|---:|---|
| lood_podcast | mkv | -16.3 | -16.2 | **+0.1** | -1.1 | 5.2 | ★ već na cilju |
| nanovoroeni | mkv | -16.2 | -16.0 | **+0.2** | -0.7 | 6.4 | ★ već na cilju |
| iva_kraljevic | mkv | -16.5 | -15.8 | **+0.7** | — | 4.3 | ★ već odličan |
| ad_deum_podcast | mp4 | -17.7 | -16.6 | +1.1 | — | 9.9 | dobar |
| mislav_kolakusic | mkv | -13.4 | -16.6 | **−3.2** | — | 7.2 | bio preglasan → stišan |
| catholic_futurist | mp4 | -19.4 | -16.0 | +3.4 | -2.5 | 5.7 | osrednji, pojačan |
| radio_mreznica | mkv | -20.0 | -16.0 | +4.0 | -4.1 | 2.7 | osrednji, pojačan |
| budi_frajer | mkv | -21.1 | -16.8 | +4.3 | -2.3 | 7.5 | osrednji, pojačan |
| eho_projekt | mp4 | -21.8 | -16.6 | +5.2 | -0.2 | 4.9 | tih, jaki boost |
| zeljka_markic_i_narod_hr | mkv | -10.7 | -16.5 | **−5.8** | — | 6.8 | jako glasan → stišan |
| cryptoverse_kripto_caffe | mkv | -23.0 | -16.0 | +7.0 | -5.8 | 6.0 | tih, jaki boost |
| mladi_za_domovinu | mkv | -33.3 | -16.8 | **+16.5** | -10.2 | 8.7 | ekstremno tih → ogroman boost |

**Izlazni true peak:** svuda **-2.0 dBTP** osim zeljka_markic (**-4.3 dBTP** — vrhovi pali ispod stropa nakon jakog stišavanja). **Nigdje ne klipa.** Izlazni integrated konzistentno **-15.8 … -16.8 LUFS** (cilj -16, raspon <1 LU) preko svih 12 raznolikih kanala.

### Točne epizode (za reprodukciju)

| Kanal | Basename |
|---|---|
| lood_podcast | `20241205_prekid_trudnoce_moja_najteza_odluka_mirela_cavajda_yt_V7rLD_jZw68` |
| nanovoroeni | `20230815_fra_ilija_bozic_gospa_olovska_yt__stjHU56-vk` |
| iva_kraljevic | `20241115_djecji_psiholog_i_otac_sestero_djece_…_yt_QLse_eF8lrM` |
| ad_deum_podcast | `20251024_to_je_bilo_bas_boze_sacuvaj_fra_augustin_cordas_ad_deum_podcast_yt_vAVuccWigCs` |
| mislav_kolakusic | `20251116_ovi_ljudi_odlucuju_o_ratu_i_miru_…_yt_hdzg95E3mtY` |
| catholic_futurist | `20260106_ai_loneliness_and_the_need_for_real_presence_catholic_futurist_yt_TVt4pRtuvF8` |
| radio_mreznica | `20250408_podcast_mreznica_raguz_…_yt_ctaEnWRNE-c` |
| budi_frajer | `20220426_oslobodenje_od_duha_traume_yt_tx5_9kxVpGI` |
| eho_projekt | `20250613_odgoj_djece_i_brak_…_nikolina_essert_yt_wULVtJq4Mxk` |
| zeljka_markic_i_narod_hr | `20200811_55_minuta_kod_zeljke_markic_13_odilon_singbo_yt_rE9J32OIHUQ` |
| cryptoverse_kripto_caffe | `20260224_intervju_tjedna_nikola_skoric_ceo_electrocoin_yt_l_aG-V-_Dig` |
| mladi_za_domovinu | `20230329_stjepo_bartulica_bez_dlake_na_jeziku_…_yt_dvjXCCM1Vlc` |

---

## Interpretacija (kako čitati za slušni test)

Tri skupine, svaka testira drugu hipotezu:

1. **Kontrolna skupina — pomak ≤1 LU** (`lood_podcast`, `nanovoroeni`, `iva_kraljevic`): originali su već praktički na -16. ORIGINAL i POPRAVLJENO trebaju zvučati **gotovo identično**. Ako se *čuje* razlika gdje je brojčano nema → loudnorm dira nešto osim glasnoće (dinamika/limiter), što bi bio regresijski signal. Ovo su dokaz da normalizacija **ne kvari ono što je već dobro**.

2. **Tipičan katalog — pomak 3–4 LU** (`mislav_kolakusic`, `catholic_futurist`, `radio_mreznica`, `budi_frajer`): najreprezentativniji slučajevi. Razlika čujna ali ne dramatična. Uključuje i smjer stišavanja (mislav) i pojačavanja.

3. **Rubni slučajevi — najveći rizik za artefakte:**
   - **Ekstremni boost** (`mladi_za_domovinu` +16.5, `cryptoverse` +7, `eho_projekt` +5.2): sluša se diže li se pojačavanjem **šum/šištanje/sibilance**. mladi_za_domovinu je najgori mogući slučaj (ulaz -33.3, TP -10.2).
   - **Jako stišavanje** (`zeljka_markic` −5.8): sluša se **pumpa li limiter** ili guši dinamiku.

   Ako ova tri prođu čisto, srednji slučajevi su sigurni po konstrukciji.

---

## Zaključak

- **Normalizacija dobro generalizira cross-channel.** Svih 12 kanala (ulazi od -33.3 do -10.7 LUFS, raspon 22.6 LU) konvergiraju u uski izlazni prozor -15.8…-16.8 LUFS uz siguran true peak. Potvrđuje katalog-razinske brojke iz FAZE 2 (median -16.2, stddev 0.70) na svježem, neviđenom uzorku.
- **Tri kanala (`lood_podcast`, `nanovoroeni`, `iva_kraljevic`) već dolaze s dobrom glasnoćom** (pomak ≤0.7 LU) — služe kao "ne-pokvari-dobro" kontrola.
- **Nije bilo grešaka pri obradi** (12/12 OK), svi izvori (mkv i mp4) uspješno obrađeni.

**Otvoreno pitanje za slušni sud:** drži li ekstremni boost (mladi_za_domovinu, cryptoverse) zvuk prihvatljivim, ili najtiši izvori traže dodatni speech-tuning (denoise/de-ess prije normalizacije). Ako rubni slučajevi prođu, normalizacija je validirana za promociju u korak `run_pipeline.sh` (vizija u [`loudness_normalization_2026-05.md`](loudness_normalization_2026-05.md#vizija-integracija-u-pipeline)).
