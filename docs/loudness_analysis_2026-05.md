# Analiza glasnoće kataloga — svibanj 2026.

**Datum mjerenja:** 2026-05-28
**Obuhvat:** 2683 epizode kroz 42 kanala (sve epizode s `.wav` izvorom u `storage/output`)
**Alat:** `analyze_loudness.js` (ffmpeg `ebur128`), izvještaj u `loudness_report.json` / `.xlsx`
**Cilj normalizacije:** **-16 LUFS** (integrated)

---

## TL;DR

- Katalog je **sustavno pretih**. Median prave glasnoće je **~-19 LUFS**, tj. ~3 LU ispod cilja od -16; **75 % epizoda je više od ±3 LU udaljeno od cilja**.
- Raspon je golem: **35 LU** između najtiše (-42.7) i najglasnije (-7.6) epizode.
- "Pretiho" ≠ "pokvareno". Two-pass `loudnorm` svaku epizodu dovodi na -16 ±0.5 bez obzira na trenutnu razinu. **Jedini stvarni rizik** su epizode koje traže ekstremni pozitivni gain (+15 do +26 dB) — tu pojačanje podiže i šum/hiss.
- Najgori kanali po prosjeku: **domovina_tv, catholic_futurist, marijanski_zavjet, cryptoverse**. Najbolji (blizu cilja + ujednačeni): **lood_podcast, nanovoroeni, ad_deum_podcast**.

---

## Metodologija i važna ograda (+3 LU offset)

Mjerenje radi ffmpeg `ebur128=peak=none` nad **16 kHz mono `.wav`** intermediate datotekama (one koje pipeline ionako generira za transkripciju). To je ~1270× brže od realtimea i 14× brže od punog `loudnorm` prolaza.

**Posljedica:** K-weighting filter je odsječen na 8 kHz Nyquistu, a stereo je sumiran u mono → izmjereni integrated LUFS je **~3 LU niži** nego što bi bio na punom full-band stereo izvoru.

Zato kroz cijelu analizu vrijedi:

| | Valjano? |
|---|---|
| **Raspon / usporedba između epizoda i kanala** | ✅ DA — offset je sustavan, jednak za sve |
| **Apsolutna vrijednost vs -16** | ⚠️ Ne izravno — treba dodati ~+3 LU za "pravu" glasnoću |

Stupac **"true (+3)"** u tablicama je `mjereno + 3` i predstavlja procjenu prave full-band glasnoće. Apsolutni target se ionako **re-mjeri u trenutku primjene** (two-pass `loudnorm` mjeri pravi izvor), pa pre-analiza ne mora biti apsolutno točna — služi da vidimo problem i odlučimo strategiju.

True peak (dBTP) se ovdje **ne mjeri** (`peak=none`) — radi brzine; mjeri se tek u fazi normalizacije.

---

## Ukupna distribucija (2683 epizode)

```
min    -42.7
p10    -29.2
median -21.7   (true ~-18.7)
mean   -22.5   (true ~-19.5)
p90    -16.6
max     -7.6
raspon  35.1 LU
stddev   5.2 LU
```

Udaljenost od cilja (-16 LUFS, mjereno):

| Unutar ±1 LU | Unutar ±2 LU | Više od ±3 LU |
|---|---|---|
| 250 (9 %) | 460 (17 %) | **2005 (75 %)** |

> Napomena: zbog +3 offseta "true" udaljenost je manja nego što ove brojke sugeriraju, ali smjer je jasan — katalog je pretih i raštrkan.

---

## Rang kanala — median vs mean (i zašto je razlika bitna)

Rangiranje po **medianu** je otporno na outliere: ako kanal ima nekoliko katastrofalno tihih epizoda, ali većinu "uredno tihih", median ostaje umjeren. **Mean** (prosjek) hvata teški rep. Kad se ta dva jako razilaze, znači da kanal ima nekoliko ekstrema koji se kriju iza mediana — **domovina_tv je udžbenički primjer** (vidi case study).

Cijeli katalog, sortirano po medianu (tiši → glasniji):

| Kanal | n | median | true (+3) | mean | sd | raspon |
|---|---|---|---|---|---|---|
| cryptoverse_kripto_caffe | 51 | -27.7 | -24.7 | -26.9 | 3.6 | 15.4 |
| horizonti_liderstva | 7 | -27.4 | -24.4 | -26.6 | 4.3 | 12.8 |
| catholic_futurist | 14 | -27.0 | -24.0 | -27.9 | 3.0 | 12.6 |
| marijanski_zavjet | 12 | -26.5 | -23.5 | -27.6 | 4.7 | 16.9 |
| mladi_za_domovinu | 129 | -26.1 | -23.1 | -26.2 | 6.6 | 30.4 |
| **domovina_tv** | 6 | -26.0 | -23.0 | **-32.5** | 6.7 | 16.5 |
| budi_frajer | 257 | -25.5 | -22.5 | -26.0 | 6.3 | 31.0 |
| hnb | 77 | -25.4 | -22.4 | -24.4 | 5.3 | 24.4 |
| kko_hr | 43 | -25.3 | -22.3 | -24.2 | 4.3 | 13.4 |
| neuspjeh_prvaka | 55 | -25.2 | -22.2 | -25.4 | 2.8 | 11.0 |
| podcast_bitno_net | 59 | -25.2 | -22.2 | -25.9 | 4.4 | 23.0 |
| franjina_ekonomija | 45 | -25.1 | -22.1 | -23.3 | 3.3 | 10.7 |
| glas_poduzetnika | 38 | -24.4 | -21.4 | -24.0 | 4.7 | 19.9 |
| hercegovina_info | 37 | -24.1 | -21.1 | -23.9 | 2.5 | 12.4 |
| eho_projekt | 101 | -23.9 | -20.9 | -24.5 | 6.2 | 25.6 |
| rastuci_s_djecom | 26 | -23.3 | -20.3 | -23.7 | 2.5 | 9.2 |
| mislav_kolakusic | 76 | -22.8 | -19.8 | -23.2 | 3.1 | 22.4 |
| iva_kraljevic | 58 | -22.6 | -19.6 | -22.7 | 3.1 | 17.9 |
| muzevni_budite | 63 | -22.4 | -19.4 | -23.0 | 3.2 | 13.8 |
| duhovnost_hagio | 33 | -22.3 | -19.3 | -23.8 | 7.0 | 22.3 |
| radio_mreznica | 198 | -22.2 | -19.2 | -22.6 | 3.5 | 17.0 |
| popcast_pavicic | 27 | -22.1 | -19.1 | -22.2 | 2.9 | 10.6 |
| 40_dana_za_zivot | 74 | -21.9 | -18.9 | -22.3 | 2.5 | 11.0 |
| bozanstvena_komedija | 34 | -21.8 | -18.8 | -21.3 | 3.5 | 12.9 |
| marin_miletic | 12 | -21.7 | -18.7 | -23.2 | 8.1 | 29.8 |
| podcast_cuspajz | 133 | -21.3 | -18.3 | -21.1 | 4.1 | 27.8 |
| bozja_pobjeda | 53 | -20.6 | -17.6 | -20.5 | 3.4 | 11.7 |
| founder_talks | 5 | -20.5 | -17.5 | -21.5 | 4.6 | 12.2 |
| hcpi_podcast | 3 | -19.9 | -16.9 | -20.3 | 2.1 | 5.0 |
| nanovoroeni | 314 | -19.9 | -16.9 | -21.6 | 3.9 | 28.2 |
| poduzetnistvo_s_povjerenjem | 14 | -19.9 | -16.9 | -21.5 | 5.3 | 22.0 |
| merz_institut | 7 | -19.8 | -16.8 | -20.5 | 2.9 | 7.4 |
| lood_podcast | 212 | -19.7 | -16.7 | -21.1 | 3.7 | 23.2 |
| ad_deum_podcast | 19 | -19.3 | -16.3 | -19.6 | 3.2 | 11.2 |
| ikra_institut | 27 | -19.2 | -16.2 | -19.2 | 6.5 | 22.6 |
| podcast_by_niko | 5 | -19.1 | -16.1 | -19.5 | 1.4 | 3.8 |
| glas_koncila | 4 | -17.6 | -14.6 | -17.8 | 0.2 | 0.5 |
| mreze_rijeci | 156 | -16.8 | -13.8 | -19.2 | 3.8 | 17.6 |
| sapere_aude | 1 | -15.6 | -12.6 | -15.6 | 0.0 | 0.0 |
| hitna_pomoc_za_nemirne | 44 | -15.5 | -12.5 | -16.9 | 4.6 | 21.7 |
| zeljka_markic_i_narod_hr | 152 | -15.4 | -12.4 | -15.5 | 2.4 | 15.2 |
| podcast_za_bolju_hrvatsku | 2 | -14.0 | -11.0 | -15.1 | 1.1 | 2.2 |

### Najbolji (blizu cilja + ujednačeni)

Od kanala s reprezentativnim brojem epizoda: **lood_podcast** (true median -16.7, n=212), **nanovoroeni** (-16.9, n=314), **ad_deum_podcast** (-16.3). Tehnički najujednačeniji je **glas_koncila** (sd 0.2, raspon 0.5 LU — praktički studijski) ali na samo 4 epizode.

### Drugi kraj — PREglasni kanali

**zeljka_markic_i_narod_hr** (true ~-12.4, n=152) i **mreze_rijeci** (~-13.8, n=156) su mjereno blizu/iznad -16, što uz offset znači **prava glasnoća ~-12/-14 → malo PREglasni**. Njih normalizacija stišava (negativni gain) — bezopasno.

### Najgori

Dvije klase:

1. **Sustavno pretihi, ali konzistentni** — `cryptoverse_kripto_caffe`, `catholic_futurist`, `horizonti_liderstva`. Cijeli kanal ~8 LU ispod cilja, mali sd. Lako popravljivo: gotovo jednolik veliki +gain, mali rizik.
2. **Pretihi *i* raštrkani** — `mladi_za_domovinu` (raspon 30.4), `budi_frajer` (31.0), `eho_projekt` (25.6). I tihi i nepredvidivi između epizoda. Najproblematičniji jer najtiše epizode traže +12 dB i više.

---

## Case study: domovina_tv — kako median sakriva problem

domovina_tv ima samo 6 epizoda:

| Epizoda | LUFS | true | gain do -16 |
|---|---|---|---|
| 002 Zadruge i budućnost bankarstva (Goran Jeras) | **-42.5** | -39.5 | **+26.5 dB** |
| 003 Blockchain, Liberland (Dorian Jakov) | -38.3 | -35.3 | +22.3 dB |
| 004 MOST, reforma izbornog sustava (Ivan Orlović) | -36.1 | -33.1 | +20.1 dB |
| 001 Katolička udruga (Belavić) | -26.0 | -23.0 | +10 dB |
| cc_01 Ticketing app (Senko Rašić) | -26.0 | -23.0 | +10 dB |
| 001 Katolička udruga (Tomislav B.) | -26.0 | -23.0 | +10 dB |

- **Median = -26.0** (4. od 6 vrijednosti) → po medianu kanal izgleda "tek osrednje tih", rang #6.
- **Mean = -32.5** → **najtiši prosjek u CIJELOM katalogu (#1 od 40)**.

Tri numerirane gostujuće snimke (002/003/004) su katastrofalno tihe — vjerojatno isti loš audio setup — ali leže *ispod* mediana pa ga ne pomiču. To je pouka: **za kanale s teškim repom mean je iskreniji od mediana.** Epizoda Goran Jeras (-42.5) je 2. najtiša u cijelom katalogu od 2683.

---

## Ekstremi kataloga

**Najtiših 5** (kandidati za denoise prije pojačanja — +25 dB gain podiže i šum):

| LUFS | gain | Kanal | Epizoda |
|---|---|---|---|
| -42.7 | +26.7 | mladi_za_domovinu | u ovim stvarima nema kompromisa u politici |
| -42.5 | +26.5 | domovina_tv | 002 zadruge i budućnost bankarstva (Goran Jeras) |
| -42.3 | +26.3 | budi_frajer | upoznajmo sv. Antuna |
| -42.3 | +26.3 | mladi_za_domovinu | hrvati izvan domovine su drugo plućno krilo |
| -41.4 | +25.4 | budi_frajer | ddv kateheze — oslobođenje iz ropstva pornografije |

**Najglasnijih 5** (negativni gain, bezopasno):

| LUFS | gain | Kanal | Epizoda |
|---|---|---|---|
| -7.6 | -8.4 | ikra_institut | Constantine the Great |
| -8.4 | -7.6 | ikra_institut | The Consubstantiality of Wisdom |
| -8.4 | -7.6 | ikra_institut | Creed and its modern-day alternatives |
| -8.5 | -7.5 | ikra_institut | There was when he was not |
| -8.6 | -7.4 | podcast_cuspajz | Andreja Barberić — medijska pismenost |

---

## Što ovo znači za normalizaciju

1. **Cilj -16 LUFS** je razuman srednji put (Apple Podcasts target; YouTube/Spotify renormaliziraju na -14 kod reprodukcije pa -16 izvor neće biti previše tih).
2. **Two-pass `loudnorm`** je prava metoda: 1. prolaz mjeri pravi full-band izvor, 2. prolaz primijeni izmjerene vrijednosti da pogodi cilj ±0.5 LU + ograniči true peak (npr. -1.5 dBTP).
3. **"Crveno" u izvještaju ≠ oštećeno.** 75 % epizoda > ±3 LU samo znači "treba znatan gain", što je upravo posao normalizacije. Sve završi na -16.
4. **Realni rizik** je samo kod ekstremno tihih epizoda (+15 do +26 dB): veliko pojačanje podiže noise floor. Te epizode (vidi "najtiših 5" + cijeli domovina_tv) treba **poslušati nakon normalizacije**, a možda i denoise prije gaina.

### Workflow normalizacije (FAZA 2)

Skripta normalizacije radi **nove datoteke** uz original (nikad ne prepisuje izvor), da se original i popravljena verzija mogu **A/B preslušati** prije usvajanja. Mjerenje iz ove analize (FAZA 1) ne baca se — `input_*` vrijednosti služe kao polazište, ali pravi target se re-mjeri na full-band izvoru u trenutku primjene.

---

## Reprodukcija

```bash
# FAZA 1 — mjerenje (idempotentno, nastavlja iz loudness_data.json)
node analyze_loudness.js --concurrency 8

# Izvještaj kao obojani .xlsx (3 sheeta + rang kanala)
python3 loudness_report_xlsx.py
```

Artefakti `loudness_data.json` / `loudness_report.json` / `loudness_report.xlsx` su gitignorani (regenerabilni); ovaj dokument je trajni zapis nalaza.
