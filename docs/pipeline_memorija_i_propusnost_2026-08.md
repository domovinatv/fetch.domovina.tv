# Memorija i propusnost pipelinea — mjerenja i prijedlozi (2026-08-25)

Nastalo tijekom pilota saborskih sjednica (`sabor_pipeline/`), ali nalazi vrijede za
cijeli pipeline. Sve brojke su mjerene na ovom stroju (Mac Mini M4 Pro, 24 GB unified,
sistemski disk ~20 GB slobodno, swap 6 GB), ne procijenjene.

---

## 1. Što je izmjereno

### 1.1 Canary VRAM ne ovisi o duljini snimke

`torch.cuda.max_memory_allocated()` na Modalu (A100, BF16), raspon duljine **10×**:

| Snimka | Trajanje | WAV | Peak VRAM | Inference |
|---|---|---|---|---|
| part_04 | 1 h 56 m | 223 MB | 16.48 GB | 39 s |
| part_01 | 5 h 44 m | 662 MB | 16.48 GB | 101 s |
| part_02 | 6 h 08 m | 708 MB | 16.48 GB | 89 s |
| part_03 | 6 h 11 m | 714 MB | 16.48 GB | 86 s |
| full_session | **20 h 01 m** | 2199 MB | **16.48 GB** | 371 s |

Identično do druge decimale → NeMo `transcribe()` interno chunka. **Duljina snimke nije
razlog za chunking.** Vrijeme skalira ~linearno.

Ranija tvrdnja „~26 GB peak na dugim fajlovima" nije kontradikcija nego druga metrika:
`nvidia-smi` *reserved* za cijeli proces vs `max_memory_allocated` samo za tenzore.

### 1.2 Modalov klijent puca na velikom argumentu, poslužitelj ne

`Canary().transcribe.remote(wav_bytes)` s 2.3 GB WAV-om:

| | |
|---|---|
| lokalni `open().read()` istog fajla | 2.3 GB RSS, 2.6 s — bezopasno |
| ista datoteka kroz `transcribe.remote()` | **34 GB peak footprint** → macOS ubije proces |
| simptom | tiho, bez tracebacka, `EXITCODE=1` nakon ~65 s |

Serijalizacija bytes-argumenta ima ~15× memorijski overhead. **Nije Modalov dokumentirani
limit** (takav za argumente ne postoji) nego memorija klijenta. Rješenje je
`modal_canary/canary_modal.py::from_volume`. Volume limiti (docs 2026-08): v1 tvrdi limit
500 000 inodeova, v2 max 1 TiB po datoteci; ukupna veličina neograničena, naplaćuje se
zauzeće → brisati WAV nakon obrade.

**Prag**: bytes-argument do ~500 MB je dokazano OK (714 MB dijelovi prošli); iznad ~1 GB
ide preko volumea.

### 1.3 Diarizacija: `sf.read` je bio 3× skuplji nego što treba

```python
data, sr = sf.read(wav)                     # float64!
waveform = torch.from_numpy(data).float()   # + float32 kopija
```

`sf.read` bez `dtype` vraća **float64**, pa `.float()` radi drugu kopiju. Obje žive
istovremeno jer `del` dolazi tek nakon poziva pipelinea:

| Trajanje | s float64 (prije) | s float32 (sada) |
|---|---|---|
| 3 h podcast | ~2.0 GB | ~0.7 GB |
| 20 h sjednica | ~13.8 GB | ~4.6 GB |

Popravljeno u `diarize.py` i `colab_diarize/diarize_canary.py` (commit `2f6a8b6`).

### 1.4 Putanja umjesto waveforma: memorija postaje ravna

`sabor_pipeline/02_diarize.py` daje pyannoteu **putanju**, pa čita prozore lijeno:

| | RSS |
|---|---|
| kroz cijeli prolaz (1 h 56 m) | **ravno 0.7 GB** |
| peak (učitavanje modela + završno klasteriranje) | 2.02 GB |
| sistemski disk kroz run | nepomičan (19.8 → 19.9 GB) |

Brzina: **4.85 min po satu zvuka** (~12× realtime) — 863 segmenata i 28 govornika za
9.4 min na 1 h 56 m.

### 1.5 Zašto je ovo uopće opasno

Kad alokacija prelije RAM, macOS raste swap **na sistemskom disku**. Kad se on napuni,
ruše se nevezani procesi — Docker daemon zna ostati u stanju iz kojeg se diže samo
restartom stroja. Stroj kreće već napola u swapu (5 od 6 GB zauzeto pri mirovanju), pa
je rezerva manja nego što se čini.

---

## 2. Prijedlozi

Poredani po omjeru dobitka i rizika.

### P1 — Validirati putanju u `diarize.py` (najveći dobitak)

**Problem**: nightly i dalje učitava cijelu snimku u RAM.
**Zapreka**: komentar u kodu kaže da je waveform svjestan workaround „zaobilazi
AudioDecoder". Zato NIJE promijenjeno naslijepo.
**Dokaz da je možda zastarjelo**: putanja je 2026-08-25 dokazano radila na pyannote
4.0.4 s community-1 modelom (§1.4).
**Izmjena**: `pipeline(str(wav_path), **params)` umjesto waveform dicta, iza flaga, uz
A/B na 3-4 nightly epizode.
**Rizik**: srednji — drugi model (3.1 u `diarize.py`) i drugi kod-put.
**Dobitak**: nightly gubi cijelo učitavanje snimke; memorija postaje neovisna o duljini.

### P2 — Indikator napretka za duge diarizacije

**Problem**: pyannote ne javlja napredak. Na 20-satnoj snimci se 34 minute ne može
razlikovati „radi normalno" od „zaglavilo". Projekcija trajanja je linearna
ekstrapolacija, a završno klasteriranje ne skalira linearno.
**Izmjena**: `from pyannote.audio.pipelines.utils.hook import ProgressHook` i
`pipeline(..., hook=hook)`; nadzornik u `02_diarize.py` da uz RSS ispisuje i poziciju.
**Rizik**: nizak.
**Dobitak**: stvaran ETA umjesto ekstrapolacije; jasna razlika između sporog i zaglavljenog.

### P3 — Nadzornik stroja u nightly putu

**Problem**: nightly diarizira u 03:00 bez nadzora. To je najskuplji trenutak za scenarij
iz §1.5 — otkrije se ujutro, uz restart.
**Izmjena**: prenijeti child-proces + pragove iz `02_diarize.py` u nightly diarizacijski
korak (disk na `/`, RSS djeteta).
**Rizik**: nizak — obrana samo ubija posao, ne mijenja rezultat.
**Dobitak**: najgori ishod postaje „epizoda nije diarizirana" umjesto „stroj traži restart".

### P4 — Auto-ruta na Modal volume iznad praga

**Problem**: automatski put (`run_pipeline.sh`, priority poller) zna samo za
bytes-argument. Na velikoj datoteci bi umro tiho, bez tracebacka (§1.2).
**Izmjena**: iznad ~1 GB automatski `volume put` + `from_volume`, pa brisanje s volumea.
**Rizik**: nizak.
**Dobitak**: dugačke snimke prolaze automatski; nema tihe klase kvarova.

### P5 — Ispitati bazni pritisak na swap ✅ ODGOVORENO (2026-08-25)

**Problem**: 5 od 6 GB swapa zauzeto dok RAM nije pun. Svaki gornji problem je manji kad
stroj ne kreće već napola u swapu.
**Nalaz**: vidi §4 — swap drži Docker Desktopov VM, i to zbog fiksne rezervacije, ne curenja.
**Rizik**: nema.
**Dobitak**: veća rezerva za sve ostalo.

---

## 3. Otvoreno pitanje

**Je li čitanje s putanje sporije od waveforma u memoriji?** Head-to-head mjerenje NIJE
napravljeno. Mehanizam sugerira da je razlika mala: pyannote ionako radi po prozorima, a
čitanje ~320 KB po prozoru je podmilisekundno naspram desetaka ms za forward pass. Uz to
verzija s memorijom plaća unaprijed trošak učitavanja cijele snimke, kojeg putanja nema —
pa je na dugim snimkama putanja vjerojatno **brža** ukupno.

Mjerenje koje to zaključava: isti `part_04_16k.wav` starom metodom (putanja je dala
9.4 min). Ne pokretati paralelno s drugim pyannote poslom.

---

## 4. Tko drži swap (P5, mjereno 2026-08-25)

`top -l 1 -o mem -stats pid,command,mem,cmprs` daje jednoznačan odgovor — jedan proces
nosi praktički cijeli bazni pritisak:

| PID | Proces | MEM | CMPRS |
|---|---|---|---|
| 46691 | `com.apple.Virtualization.VirtualMachine` | **12 GB** | **14 GB** |
| 23508 | Python (pyannote, 20 h sjednica) | 6.3 GB | 2.6 GB |
| 174 | WindowServer | 1.3 GB | 284 MB |
| ostalo (Chrome/Brave helperi, iTerm2, …) | < 800 MB svaki | |

Taj VM je **Docker Desktop** (`lsof` na PID-u pokazuje otvoren
`~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw`). Uzrok nije curenje
nego **fiksna rezervacija** u `~/Library/Group Containers/group.com.docker/settings-store.json`:

```
MemoryMiB   = 14336     ← 14 GiB od 24 GB stroja
Cpus        = 12
SwapMiB     = 1024
DiskSizeMiB = 61035
```

`docker stats` pokazuje da 11 aktivnih kontejnera unutar tog VM-a troši **~3.75 GiB**
(ClickHouse 2.05 GiB, pediludium Supabase stack ~1.65 GiB, ostalo sitno). Dakle
**58 % stroja je rezervirano za VM koji koristi četvrtinu toga.**

**Zašto je to bitno za sve gore**: rezervacija je uzeta prije nego pipeline išta zatraži,
pa "24 GB unified" u praksi znači ~10 GB za sve ostalo. Zbog toga se swap puni prije nego
RAM izgleda pun, a swap raste na sistemskom disku — što je točno mehanizam iz §1.5.

**Stanje diska u istom trenutku** (`/` i `/System/Volumes/Data` dijele isti APFS spremnik,
pa je slobodno mjesto zajedničko):

| | |
|---|---|
| slobodno na spremniku | **12.6 GB** (97 % popunjeno) |
| Docker.raw | 29 GB stvarno (64 GB rijetko alocirano) |
| Docker reclaimable | ~2.9 GB (1.4 GB build cache — 0 aktivnih, 354 MB exited kontejnera, 656 MB volumea) |
| WhatsApp group container | 11 GB |
| `~/Library/Caches` | ~6 GB (Google 1.3 GB, Brave 1.3 GB, WhatsApp 896 MB, Telegram 893 MB) |

**Poluge, po dobitku**:

1. **`MemoryMiB` 14336 → 6144** vraća ~8 GB stroju. Traži restart Docker Desktopa, dakle
   pad `domovina-rag` ClickHouse/postgres i pediludium Supabase stacka.
2. Gašenje pediludium Supabase stacka (drugi projekt, 8 kontejnera) — ~1.65 GiB, bez restarta.
3. `docker builder prune` + brisanje exited kontejnera — ~2.9 GB unutar Docker.raw, ali
   sama datoteka se ne skuplja dok se Docker ne restarta.

**Odluka 2026-08-25**: ništa se ne dira dok traje 20 h diarizacija; nalaz je zapisan, poluge
ostaju za trenutak kad stroj nije zauzet.

**Posljedica za P3**: prag nadzornika (12 GB slobodno na `/`) je *iznad* trenutnog stanja s
rezervom od svega 0.6 GB. To nije razlog za spuštanje praga — prag radi ono zbog čega
postoji. Ako nightly stane uz poruku "PREKID PRIJE STARTA", to je signal da treba povući
polugu 1 ili 3, a ne da treba popustiti prag.

---

## 5. Stanje prijedloga

| | Status | Gdje |
|---|---|---|
| P1 putanja umjesto waveforma | zastavica `--audio-input path\|waveform`, default i dalje `waveform`; A/B alat `tools/ab_diarize_audio_input.py` | `diarize.py`, `colab_diarize/diarize_canary.py` |
| P2 indikator napretka | ✅ | `LogProgressHook` u sve tri diarizacijske skripte |
| P3 nadzornik u nightlyju | ✅ | `MachineGuard` + predpolet; `--guard/--min-free-disk-gb/--rss-cap-gb`, provučeno kroz `run_pipeline.sh` KORAK 6 |
| P4 auto-ruta na Modal volume | ✅ | `modal_canary/canary_modal.py::main`, prag `MODAL_VOLUME_THRESHOLD_MB` (1024 MB) |
| P5 bazni pritisak na swap | ✅ utvrđeno (§4), poluge nisu povučene | — |
