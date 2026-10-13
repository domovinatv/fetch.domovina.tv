# Faza 3a — ASR i diarizacija (referenca: Speechmatics Enhanced)

Generirano s `evaluate_asr.py`. Referenca NIJE istina — vidi README §Ograde.

## Ukupno

| alat | ep | WER (ponderirano) | ispušteno (min) | pomak riječi medijan ms | TRANSCRIPT_GAP |
|---|---|---|---|---|---|
| deepgram-nova3 | 14 | 27.6 % | 0 | 120 | IjoWv3AmbvA:warn |
| assemblyai-universal2 | 14 | 29.4 % | 0 | 60 | ok |
| canary-1b-v2 | 14 | 29.6 % | 1 | 120 | ok |
| parakeet-tdt-0.6b-v3 | 14 | 33.7 % | 11 | 100 | IBKliva4oYk:warn, IjoWv3AmbvA:warn |

## WER po epizodi (%)

| id | min | deepgram-nova3 | assemblyai-universal2 | canary-1b-v2 | parakeet-tdt-0.6b-v3 |
|---|---|---|---|---|---|
| -P5TCG_aN2c | 57 | 15.3 | 17.5 | 15.2 | 16.8 |
| ja995FNQP3A | 72 | 12.4 | 13.7 | 11.8 | 15.8 |
| 2FeLIaMDprw | 104 | 22.6 | 23.9 | 22.6 | 25.8 |
| 4s5SI-n7270 | 189 | 34.6 | 37.7 | 40.6 | 43.6 (isp. 1 min) |
| dK_cN6D3dDQ | 35 | 15.0 | 11.4 | 9.1 | 12.2 |
| IBKliva4oYk | 64 | 32.9 | 34.1 | 33.4 | 47.9 (isp. 1 min) |
| IjoWv3AmbvA | 163 | 21.1 | 22.6 | 23.5 | 28.4 (isp. 6 min) |
| O72WoKYazQ0 | 123 | 31.7 | 34.2 | 33.6 (isp. 1 min) | 36.1 (isp. 2 min) |
| PFeTdbx-09c | 48 | 21.6 | 23.7 | 20.5 | 26.2 |
| PlPyI-TPlgw | 29 | 16.4 | 15.5 | 12.9 | 15.3 |
| soQ8jSlBT1Y | 71 | 25.8 | 27.2 | 25.7 | 27.6 |
| v6QdSjd8NAE | 165 | 43.3 | 45.7 | 51.8 | 51.7 |
| wXPHSvY9Cek | 63 | 21.4 | 22.5 | 19.3 | 24.7 |
| Y89lSaTRAqQ | 69 | 26.2 | 28.4 | 25.1 | 37.6 (isp. 1 min) |

## Govornici (broj / DER prema SM)

| id | speechmatics-enhanced | deepgram-nova3 | assemblyai-universal2 | pyannote-c1 | pyannoteai-precision-3 | c1 vs pyannoteAI DER |
|---|---|---|---|---|---|---|
| -P5TCG_aN2c | 2 | 2 / 5 % | 2 / 4 % | 2 / 9 % | 2 / 7 % | 3 % |
| ja995FNQP3A | 2 | 2 / 3 % | 2 / 2 % | 2 / 4 % | 2 / 10 % | 3 % |
| 2FeLIaMDprw | 2 | 2 / 5 % | 2 / 4 % | 2 / 11 % | 2 / 12 % | 3 % |
| 4s5SI-n7270 | 4 | 4 / 12 % | 3 / 13 % | 4 / 16 % | 4 / 13 % | 5 % |
| dK_cN6D3dDQ | 2 | 3 / 8 % | 2 / 2 % | 2 / 4 % | 2 / 4 % | 2 % |
| IBKliva4oYk | 5 | 3 / 13 % | 3 / 14 % | 3 / 12 % | 3 / 13 % | 4 % |
| IjoWv3AmbvA | 48 | 18 / 11 % | 5 / 13 % | 30 / 14 % | 36 / 16 % | 5 % |
| O72WoKYazQ0 | 5 | 4 / 10 % | 4 / 9 % | 5 / 11 % | 6 / 15 % | 10 % |
| PFeTdbx-09c | 7 | 6 / 7 % | 5 / 7 % | 6 / 7 % | 6 / 10 % | 3 % |
| PlPyI-TPlgw | 2 | 2 / 4 % | 2 / 3 % | 2 / 5 % | 2 / 6 % | 2 % |
| soQ8jSlBT1Y | 2 | 2 / 9 % | 2 / 7 % | 2 / 10 % | 2 / 11 % | 7 % |
| v6QdSjd8NAE | 20 | 5 / 51 % | 5 / 56 % | 4 / 52 % | 4 / 50 % | 17 % |
| wXPHSvY9Cek | 2 | 2 / 5 % | 2 / 4 % | 2 / 7 % | 2 / 8 % | 2 % |
| Y89lSaTRAqQ | 4 | 4 / 4 % | 4 / 4 % | 4 / 8 % | 4 / 10 % | 2 % |
