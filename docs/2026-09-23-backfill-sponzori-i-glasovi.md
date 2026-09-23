# Backfill kataloga: sponzori u snimci + glasovni otisci

**Datum:** 23.09.2026.
**Opseg:** 3305 epizoda s `.wav.canary.diarized.srt` — **sve imaju i `.wav`** na disku.

Oba zahvata su čist CPU, nula API poziva.

## 1. `sponsors_in_video.json` (KORAK 9.85)

| | |
|---|---|
| Trajanje zapisa | ~19 s za cijeli katalog |
| Izlaz | 3305 × ~0.5–5 KB |
| Na CDN | samo za već objavljene epizode (`data/{id}/info.json` u keys-cacheu: 3290) |

```bash
node detect_sponsors.js --dry-run | tail -2          # pregled (475 epizoda sa sponzorima)
node detect_sponsors.js                             # zapis za svih 3305
node tools/upload_sponsors_in_video.js --dry-run    # koliko ide na R2
node tools/upload_sponsors_in_video.js              # upload + purge (2 Vary varijante)
```

⚠️ **KORAK 9.85 je u nightlyju default ON.** Ako se backfill ne pokrene ručno, prvi
nightly nakon commita sam zapiše svih 3305 datoteka, a KORAK 12 (`upload_to_r2.js`)
ih pošalje kao nove ključeve i purgea svaki (obrana od zapamćenog 404). To je
ispravno, ali sporije i bučnije u logu. Ručni prolaz s `tools/upload_sponsors_in_video.js`
upiše veličine u keys-cache, pa nightly iza njega nema što slati.

Ponovni prolaz nakon promjene detektora: isti redoslijed. Detektor piše samo kad se
sadržaj promijeni; uploader šalje samo ključeve čija se veličina razlikuje od R2.

## 2. Glasovni otisci (KORAK 6.5, `pyannote_wespeaker34`)

Stanje prije: 148 / 3305 epizoda ima `.embeddings.pyannote_wespeaker34.json`
(110 ima `titanet`).

**IZVEDENO 23.09.2026.** — 3160 epizoda za **26 min 45 s** (0.5 s/ep, MPS), 0 grešaka;
sada **3305 / 3305**. Provjera iz spremljenih datoteka: spot `aue1GuuMsbA` SPEAKER_02 ↔
Vlašić (`5XhBFrXb8II` SPEAKER_00) **0.838**; kontrole 0.107 / 0.138 / 0.108.

**IZVEDENO 23.09.2026.** i §1: 3304 `sponsors_in_video.json` zapisano, 3289 poslano na
R2 (0 grešaka, 6578 purge zapisa, 2 min 11 s); ponovni prolaz „za slanje: 0".

### Uzorak umjesto svega govora — `--max-speech-sec`

Izvorni KORAK 6.5 embedda **svaki segment** i učitava **cijeli WAV** (~300 MB s USB
diska). Izmjereno na Iva ep. 50 (2 h 41 min):

| Način | Vrijeme | Sličnost s punim otiskom |
|---|---|---|
| sav govor (5335 s + 3584 s + 39 s) | **154 s** (CPU samo 56 s — ostalo je disk) | — |
| `--max-speech-sec 90` (101 s + 80 s + 39 s) | **1.6 s** | **0.987 / 0.986 / 1.000** |

Katalog: ~3157 × 1.6 s ≈ **1.5 h** (umjesto ~70 h). Uzorak je ravnomjerno raspoređen
kroz epizodu (ne „prvih 90 s"), duži segmenti imaju prednost. U JSON-u je zapisano
`"sampling": "even:90s"` i `sampled_speech_sec` po govorniku.

```bash
PY=/Library/Frameworks/Python.framework/Versions/3.13/bin/python3
$PY colab_speaker_embeddings/extract_speaker_embeddings.py \
    --input-dir storage/output --model pyannote_wespeaker34 --dry-run
$PY colab_speaker_embeddings/extract_speaker_embeddings.py \
    --input-dir storage/output --model pyannote_wespeaker34 \
    --max-speech-sec 90 --max-runtime-hours 3
```

Idempotentno (preskače postojeće `.embeddings.pyannote_wespeaker34.json`), pa se smije
prekinuti i nastaviti. Ne pokretati u prozoru nightlyja (03:00): dijeli disk s
koracima 2–6.

### Što otisak (još) NE radi

Datoteke ostaju na disku. Downstream (`../domovina-rag`) ih danas **ne čita**:
ClickHouse tablica `speaker_voice_signatures` postoji, ali je prazna („Faza 3"), a
registar glasova je dogovoren za pgvector (MEMORY speaker_embeddings_pgvector_not_clickhouse).
Za mapu osoba vidi §3.

## 3. Mapa osoba (`stats.domovina.ai/people`) — što glas mijenja

**Kolizija postoji.** Identitet osobe je slug iz imena (`domovina-rag`
`services/etl/etl/speakers.py:86-100`, PG `speakers.slug UNIQUE`): dvije različite
osobe s istim imenom i prezimenom postaju jedna. Jedina disambiguacija je ručni
alias-merge (`infra/postgres/seeds/speaker_aliases.csv`, trenutno prazan) — on
spaja, nikad ne razdvaja.

Glas pomaže **samo za govornike**, ne za spomenute osobe:

| Slučaj | Glas pomaže? |
|---|---|
| Isto ime, dvije osobe koje GOVORE | **da** — otisci pod istim slugom se razdvoje u dva klastera (sličnost ~0.1–0.3 između, ~0.8+ unutar) |
| Jedna osoba, dvije varijante imena (Mič/Mić) | **da** — potvrda za merge (danas kandidati idu po tekstnom centroidu, koji je dokazano nepouzdan: ljudi iz istih epizoda imaju sličan centroid) |
| Isto ime, dvije SPOMENUTE osobe (`mentioned_people`) | **ne** — spomen nema glas |
| Pogrešno imenovan govornik (LLM atribucija) | **da** — otisak koji ne odgovara ostalim pojavljivanjima sluga je signal greške |

Preduvjet: veza `SPEAKER_XX` → ime po epizodi (daje je producer u
`metadata.speakers` RAG chunkova) + otisak po `SPEAKER_XX` (ovaj backfill). Algoritam
i prag žive u `domovina-rag`, ne ovdje. Prag za slične glasove (ista dob, naglasak,
mikrofon) **nije kalibriran** — razdvajanje sluga i imenovanje nikad bez čovjeka.
