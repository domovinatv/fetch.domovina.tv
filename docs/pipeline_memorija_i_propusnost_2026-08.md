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

---

## 4. Dopuna nakon 20-satnog runa (isti dan, kasnije)

Prva tri poglavlja pisana su nakon mjerenja na snimci od 1 h 56 m. Run na 20 h otkrio je
da **jedan od zaključaka ne skalira** i da su dva mjerna instrumenta bila kriva.

### 4.1 Putanja je na dugim snimkama DRAMATIČNO sporija (ispravak §1.4)

§1.4 tvrdi da putanja daje ravan RSS i preporučuje je. Ravan RSS **stoji**, ali cijena
je drugdje. Run nad 20 h WAV-om nakon **125 minuta još nije bio gotov** (projekcija iz
linearnog skaliranja bila je 97 min). `sample` na radniku:

```
1369 od 1382 uzoraka stacka:
  torchcodec::get_frames_by_pts_in_range_audio
    → SingleStreamDecoder::getFramesPlayedInRange
      → decodeAVFrame / av_read_frame / avcodec_send_packet
```

**99 % vremena je dekodiranje zvuka**, 100 % na jednoj CPU jezgri — ne klasteriranje,
kako se prvo pretpostavilo. Svaki dohvat prozora plaća seek/dekodiranje čija cijena
raste s duljinom datoteke → ukupni trošak je nadlinearan u duljini.

To je točno ono na što upozorava postojeći komentar u `diarize.py`:
„Proslijedi waveform dict umjesto file patha (zaobilazi AudioDecoder)". Taj workaround
NIJE zastario — opisuje ovaj problem.

**Posljedica za P1**: prijedlog da se `diarize.py` prebaci na putanju je **povučen**.
Za nightly (2-3 h epizode) razlika se ne vidi, ali smjer je pogrešan.

**Ispravan pristup za duge snimke**: waveform, ali učitan kao `float32` (§1.3).
20 h u float32 = **4.6 GB**, što na 24 GB stroju stane komotno — a AudioDecoder se
zaobilazi u potpunosti. Tek fix iz §1.3 čini waveform-pristup izvedivim na 20 h.

### 4.2 RSS ne mjeri MPS memoriju

Kroz cijeli run RSS djeteta je bio ravnih 0.6 GB, dok je sustav u isto vrijeme narastao
swap sa 6 na 10 GB. MPS alocira iz unified memorije i te alokacije **ne ulaze u RSS**.

**Posljedica**: prag „RSS ≤ 15 GB" u `sabor_pipeline/02_diarize.py` je mrtvo slovo —
nikad se neće okinuti. Jedini prag koji je išta uhvatio je slobodan prostor na disku.

### 4.3 `df` podcjenjuje stvarnu rezervu

| Mjera | Vrijednost u istom trenutku |
|---|---|
| `df` / `statfs` na `/` (čita nadzornik) | 12.6 GB |
| Finder „Available" | 126 GB (112 GB purgeable) |
| `memory_pressure` | **53 % memorije slobodno** |

Provjereno: nema APFS ni Time Machine snapshotova, nema obrisanih-a-otvorenih datoteka
(~0 GB). Izvor purgeable prostora nije utvrđen.

**Posljedica**: nadzornik je zamalo ubio zdrav posao. Disk je pao na 12.6 GB uz prag od
12 GB, dok sustav uopće nije bio pod pritiskom — i sam se zatim oporavio na 15 GB.
`df` sam nije valjan signal; treba ga kombinirati sa stvarnim pokazateljem pritiska.

### 4.4 Što ovo mijenja u prijedlozima

- **P1 povučen** (vidi §4.1) — smjer je bio pogrešan.
- **P2 dobiva na težini**: bez signala napretka 125 minuta se ne razlikuje od zaglavljivanja.
  Nadzornik treba i **razlikovati faze** — 100 % jedne jezgre je normalno u CPU fazi, a
  sumnjivo u GPU fazi.
- **P3 se mijenja**: ne RSS (§4.2) i ne `df` sam (§4.3), nego kombinacija stvarnog
  pokazatelja pritiska i praga na disku.

### 4.5 Otvoreno pitanje iz §3 — ODGOVORENO

„Je li čitanje s putanje sporije od waveforma u memoriji?" **Jest, i to znatno na dugim
snimkama.** Ranija procjena u §3 (da je putanja vjerojatno brža) bila je pogrešna;
mehanizam koji je promašila je torchcodec seek po prozoru (§4.1).

---

## 5. Online research (2026-08-25) — potvrde, ispravci i JEDAN NOVI ZID

Tri paralelna istraživanja. Nalazi su provjereni i uzvodno (GitHub, službena dokumentacija)
i mjerenjem na NAŠOJ datoteci.

### 5.1 Uzrok sporosti putanje — potvrđen uzvodno

**torchcodec PR #1449**: „Previously, the seeking logic would **always seek back to the
beginning of the file**". Popravljeno u **torchcodec 0.14.0**. Mi imamo **0.10.0**
(nadogradnja traži `torch >= 2.11`).

`Audio.crop()` (`pyannote/audio/core/io.py:394`) stvara **NOVI `AudioDecoder` pri svakom
pozivu**, a `speaker_diarization.py:406` ga zove po svakom chunku. Uz `segmentation_step
= 0.1` × 10 s prozor → korak 1 s → za 20 h to je **~72 000 poziva**.

Mjereno na `full_session_16k.wav` (dohvat 10 s prozora):

| offset | trajanje |
|---|---|
| 0 h | 4.3 ms |
| 5 h | 177 ms |
| 15 h | **3508 ms** |

Integrirano: **8–15 h samo za dekodiranje**. Naših 146 min bez završetka se uklapa.

### 5.2 Waveform je SLUŽBENA preporuka, ne workaround

- Model card `speaker-diarization-community-1`: „**Pre-loading audio files in memory may
  result in faster processing**".
- pyannote issue **#1955**, odgovor člana tima (`collaborator`): preporuka
  `pipeline({"waveform": ...})`. Prijavitelj izmjerio **1053.9 s → 49.8 s (21×)**.
- pyannote 4.0.0 CHANGELOG: uklonjeni `sox`/`soundfile` backendi — „only `ffmpeg` or
  **in-memory audio** is supported". In-memory JEST podržani backend.

Stari komentar u `diarize.py` bio je točan cijelo vrijeme.

### 5.3 ⚠️ Putanja NIKAD nije ni štedjela memoriju (ispravak §1.4 i §4.1)

`Inference.__call__` (`core/inference.py:403`) zove `model.audio(file)` →
`decoder.get_all_samples()` (`io.py:319`) i **učitava cijeli waveform za segmentaciju
svejedno**. Naš „ravan 0.7 GB RSS" na snimci od 1 h 56 m bio je upravo tih ~445 MB
waveforma te datoteke — ne dokaz štednje.

**Putanja = ista memorija PLUS kvadratno dekodiranje. Nema kompromisa koji bismo birali.**

Mjereno na našoj datoteci: `get_all_samples()` 11.8 s → tensor 4.61 GB float32, peak RSS
5.51 GB, crop iz RAM-a 0.46 ms → 72 000 cropova ≈ 33 s. **Ukupno ~45 s umjesto 8–15 h.**

### 5.4 🧱 NOVI ZID: klasteriranje je O(n²) i 20 h ne prolazi ni s waveformom

`pipelines/clustering.py:374` zove `scipy.cluster.hierarchy.linkage(embeddings,
method="centroid")` — **bez capa i bez subsamplinga**. Izmjereno skaliranje:

| n embeddinga | linkage | peak RSS |
|---|---|---|
| 5 000 | 0.81 s | 0.30 GB |
| 10 000 | 3.44 s | 1.14 GB |
| 20 000 | 16.51 s | 3.61 GB |

Za 20 h: ~70 000–110 000 embeddinga → kondenzirana matrica **20–47 GB**, peak RSS
**45–100 GB**. Na 24 GB stroju fatalno.

Provjera na našim podacima: `part_01` (5.74 h) ≈ 31k embeddinga ≈ ~9 GB — prošlo.
20 h je 3.5× dulje, a memorija raste s kvadratom → ~12× više.

**Zaključak: jedan prolaz nad 20 h nije izvediv na ovom stroju, bez obzira na I/O.**

### 5.5 Ispravna arhitektura za saborske sjednice

1. Waveform (float32) **bezuvjetno**, za sve snimke — čist dobitak i na 2 h epizodama.
2. Diarizacija **po dijelu** (`part_01..04`) — to nije workaround nego ispravna
   arhitektura; `part_01` je već uspješno prošao.
3. Identitet govornika preko granica dijelova: pyannote 4.x s `legacy=False` vraća
   `DiarizeOutput.speaker_embeddings` — **centroide poravnate s `diarization.labels()`**
   (`speaker_diarization.py:768–778`). Spajati **kosinusnom sličnošću centroida**, ne
   ponovnom diarizacijom cjeline. Jeftino, determinističko, izbjegava oba zida.

### 5.6 Pravi uzrok nestabilnosti stroja — konfiguracija, ne mjerenje

Iz `torch/include/ATen/mps/MPSAllocator.h`: `default_high_watermark_ratio = 1.7`.
Na ovom stroju `recommended_max_memory()` = 17.76 GiB → **hard limit 30.2 GiB uz 22.35 GiB
fizičkog RAM-a**. PyTorch po defaultu **nikad neće baciti OOM prije nego stroj ode u swap**.

Popravak je jedan redak, i **važniji je od cijelog nadzornika**:
```python
torch.mps.set_per_process_memory_fraction(0.55)   # ≈9.8 GiB cap
```
Testirano: daje čist `RuntimeError` umjesto swapanja.

⚠️ `PYTORCH_MPS_HIGH_WATERMARK_RATIO` **sam po sebi puca** („invalid low watermark ratio
1.4") — LOW mora biti ≤ HIGH, pa se moraju postaviti oba. Nije dokumentirano.
**Nikad `=0.0`** — internet to preporučuje kao „fix za OOM", a to je upravo ono što obara stroj.

### 5.7 ⚠️ Ispravak §4.2 i §4.3 — jedan nalaz potvrđen, jedan obrnut

**§4.2 POTVRĐEN**: RSS ne vidi MPS. Mjereno: alokacija 2 GiB na MPS → RSS narastao **3 MB**
(700× podcjenjivanje), dok `phys_footprint` vidi svih 2116 MB. Ispravna metrika je
`proc_pid_rusage(pid, RUSAGE_INFO_V4).ri_phys_footprint` — jedan syscall, radi cross-process
bez sudo, pokriva i CPU-side clustering i MPS/IOAccelerator u jednom broju.

**§4.3 OBRNUT — `df` je bio ISPRAVAN.** Finderovih 126 GB je
`NSURLVolumeAvailableCapacityForOpportunisticUsageKey` — kapacitet za **nebitne** resurse
koje sustav smije odmah baciti, ne za swap. Mjereno u istom trenutku:

| Ključ | Vrijednost |
|---|---|
| `ForOpportunisticUsage` (Finder) | 114.4 GB |
| `ForImportantUsage` (relevantan) | **17.6 GB** |
| `NSURLVolumeAvailableCapacityKey` (`df`) | 15.1 GB |
| `shutil.disk_usage()` | 12.2 GB |

`shutil.disk_usage()` je **konzervativniji i od Appleovog** „important" broja. Purgeable
prostor je fatamorgana. Swap dijeli isti APFS container (`/System/Volumes/VM`), pa je
praćenje `/` ispravan proxy. **Nadzornikov disk-prag treba zadržati.**

### 5.8 Ispravan poredak provjera u nadzorniku

Od najranijeg signala prema najkasnijem:

```
1. swap_used / swap_total          > 0.75  → ABORT   (rani; hvata uzrok)
2. shutil.disk_usage('/').free     < prag  → ABORT   (df je OK; Finder ignorirati)
3. phys_footprint(child)           > 14 GB → ABORT   (zamjena za RSS)
4. kern.memorystatus_vm_pressure_level >= 2 → ABORT  (kasni; zadnja crta)
```

`kern.memorystatus_vm_pressure_level`: 1=NORMAL, 2=WARN, 4=CRITICAL.
`vm.memory_pressure` **ne koristiti** — na ovom stroju vraća konstantnu 0.
`memory_pressure` 53 % nas nije lagao: sustav nije bio pod pritiskom **jer je macOS
pritisak već preselio u swap na disku**. Zato je swap rani, a memorystatus kasni signal.
