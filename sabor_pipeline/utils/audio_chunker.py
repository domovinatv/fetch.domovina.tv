#!/usr/bin/env python3
"""
audio_chunker.py — plan rezanja duge snimke na komade za diarizaciju.

Provodi tocku 1 i 2 iz `docs/pipeline_memorija_i_propusnost_2026-08.md` §6.8:
komadi od ~2 h, preklapanje 60-120 s, rezovi u tisini.

═══ ZASTO 2 h, A NE 6 h ═══

Klasteriranje u pyannoteu je O(n²) po broju embeddinga, a embeddinga ima
**1099 po sekundi zvuka** (mjereno, §6.1 — broj je bit-identican izmedu
pokretanja, za razliku od RSS-a):

| komad | n embeddinga | `pdist` (condensed float64) | `reconstruct` × 2 poziva |
|---|---|---|---|
| 6 h   | ≈ 24 000 | 2.3 GB  | 8.6 GB tranzijentno |
| 2 h   | ≈  7 900 | 250 MB  | ≈ 1.4 GB |

Na stroju gdje Docker VM vec drzi 14 GiB, 6 h je tijesno a 2 h udobno.

═══ ZASTO SE KOMADI NE PISU NA DISK ═══

Nema `chunk_XX.wav` datoteka. Komad se cita izravno iz izvornog WAV-a
(`sf.read(start=, stop=, dtype="float32")`) i predaje pyannoteu kao waveform.
Razlozi:

1. **Waveform je i inace obavezan.** Putanja NIJE stedjela memoriju — pyannote
   svejedno zove `get_all_samples()` — a torchcodec < 0.14 premotava na pocetak
   datoteke pri svakom cropu (~72 000 puta na 20 h). Vidi §5.1-5.3.
2. 2 h u float32 = **472 MB**, sto je manje od cijelog dijela ionako.
3. Nula dodatnih bajtova na disk, a disk je na ovom stroju usko grlo.

═══ ZASTO REZ U TISINI ═══

Rez usred govorne izmjene raspolovi jednu izmjenu na dva krnja komada, pa oba
dobiju vlastiti (losiji) centroid. Preklapanje to vecinom sanira, ali rez u
tisini je besplatan pa se radi svejedno.

Detekcija je energetska (RMS po 20 ms okviru), ne neuronski VAD: trazi se samo
mjesto gdje nitko ne govori, a ne granica govora. Prag je **adaptivan** — sumni
pod saborskih mikrofona nije isti kroz cijelu snimku, pa apsolutni dBFS prag ne
bi radio jednako u sva tri dijela.
"""

import numpy as np
import soundfile as sf

# Rezovi se traze u prozoru +-SEARCH_S oko nominalne granice.
SEARCH_S = 180.0
FRAME_S = 0.020        # 20 ms okvir za RMS
MIN_SILENCE_S = 0.40   # kraci "predah" nije pouzdana granica
IDEAL_SILENCE_S = 3.0  # dulje od ovoga ne donosi dodatnu korist u ocjeni


def wav_info(wav_path):
    info = sf.info(str(wav_path))
    return info.frames, info.samplerate, info.frames / float(info.samplerate)


def _rms_db(data, sr):
    """(db_po_okviru, frame_len) — RMS u dBFS po okviru od FRAME_S."""
    frame = max(1, int(FRAME_S * sr))
    n = len(data) // frame
    if n == 0:
        return np.zeros(0, dtype=np.float32), frame
    f = data[:n * frame].reshape(n, frame).astype(np.float32, copy=False)
    rms = np.sqrt(np.mean(f * f, axis=1) + 1e-12)
    return 20.0 * np.log10(rms + 1e-12), frame


def _silence_runs(db, thr_db):
    """[(i_start, i_stop_exclusive)] za nizove okvira ispod praga."""
    quiet = db < thr_db
    if not quiet.any():
        return []
    d = np.diff(quiet.astype(np.int8))
    starts = list(np.flatnonzero(d == 1) + 1)
    stops = list(np.flatnonzero(d == -1) + 1)
    if quiet[0]:
        starts.insert(0, 0)
    if quiet[-1]:
        stops.append(len(quiet))
    return list(zip(starts, stops))


def find_silence_cut(wav_path, sr, total_frames, nominal_sample,
                     search_s=SEARCH_S, verbose=False):
    """Pomakni rez na najblizu uvjerljivu tisinu oko `nominal_sample`.

    Vraca (sample_index, dijagnostika_dict). Ako tisine nema, vraca nominalu —
    preklapanje komada je tu kao mreza.
    """
    search = int(search_s * sr)
    start = max(0, nominal_sample - search)
    stop = min(total_frames, nominal_sample + search)
    if stop - start < sr:
        return nominal_sample, {"found": False, "reason": "prozor prekratak"}

    data, _ = sf.read(str(wav_path), start=start, stop=stop,
                      dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)

    db, frame = _rms_db(data, sr)
    if db.size == 0:
        return nominal_sample, {"found": False, "reason": "nema okvira"}

    # Adaptivni prag: 8 dB iznad tihe 20. percentile prozora, ali nikad glasnije
    # od -30 dBFS (inace bi u vrlo tihom prozoru "tisina" progutala i govor).
    thr = min(float(np.percentile(db, 20)) + 8.0, -30.0)
    runs = _silence_runs(db, thr)

    best, best_score, best_dur = None, -1e9, 0.0
    nominal_local_s = (nominal_sample - start) / sr
    for i0, i1 in runs:
        dur = (i1 - i0) * frame / sr
        if dur < MIN_SILENCE_S:
            continue
        mid_s = ((i0 + i1) / 2.0) * frame / sr
        # Dulja tisina je bolja (do IDEAL_SILENCE_S), a blizina nominali vrijedi
        # 1 bod po 120 s odmaka — tako se 3 s tisine isplati traziti i 2 min dalje,
        # ali se ne odlazi na rub prozora zbog nijanse.
        score = min(dur, IDEAL_SILENCE_S) - abs(mid_s - nominal_local_s) / 120.0
        if score > best_score:
            best, best_score, best_dur = mid_s, score, dur

    if best is None:
        return nominal_sample, {"found": False, "reason": f"nema tisine < {thr:.1f} dBFS",
                                "threshold_db": round(thr, 1)}

    cut = start + int(best * sr)
    return cut, {
        "found": True,
        "threshold_db": round(thr, 1),
        "silence_dur_s": round(best_dur, 2),
        "shift_s": round((cut - nominal_sample) / sr, 2),
    }


def plan_chunks(wav_path, target_s=7200.0, overlap_s=90.0, max_chunk_s=9000.0,
                search_s=SEARCH_S, silence_cuts=True, verbose=False):
    """Plan komada za jednu datoteku.

    Vraca listu dictova:
        idx            redni broj komada unutar datoteke (0-based)
        read_start/stop        uzorci koji se CITAJU (ukljucuju preklapanje)
        own_start_s/own_end_s  sekunde koje komad POSJEDUJE (bez preklapanja)
        start_s/end_s          sekunde koje komad pokriva (s preklapanjem)

    `own_*` granice su rezovi c_1..c_{n-1}; svaki komad se siri za overlap/2
    preko svakog reza. Time je preklapanje susjeda tocno `overlap_s`, a
    razrjesavanje dvostrukih segmenata poslije je trivijalno: rez je granica
    vlasnistva.
    """
    total_frames, sr, dur = wav_info(wav_path)

    n = max(1, int(round(dur / target_s)))
    while dur / n > max_chunk_s:
        n += 1

    # Nominalni rezovi, pa pomak u tisinu.
    cuts = [0]
    diags = []
    for i in range(1, n):
        nominal = int(round(i * dur / n * sr))
        if silence_cuts:
            cut, d = find_silence_cut(wav_path, sr, total_frames, nominal,
                                      search_s=search_s, verbose=verbose)
        else:
            cut, d = nominal, {"found": False, "reason": "iskljuceno"}
        # Rezovi moraju ostati rastuci i razmaknuti barem za preklapanje.
        cut = max(cut, cuts[-1] + int(overlap_s * sr))
        cuts.append(cut)
        d["cut_s"] = round(cut / sr, 2)
        diags.append(d)
    cuts.append(total_frames)

    half = int(overlap_s / 2 * sr)
    chunks = []
    for i in range(n):
        read_start = max(0, cuts[i] - half)
        read_stop = min(total_frames, cuts[i + 1] + half)
        chunks.append({
            "idx": i,
            "read_start": read_start,
            "read_stop": read_stop,
            "start_s": round(read_start / sr, 3),
            "end_s": round(read_stop / sr, 3),
            "own_start_s": round(cuts[i] / sr, 3),
            "own_end_s": round(cuts[i + 1] / sr, 3),
            "duration_s": round((read_stop - read_start) / sr, 3),
            "sample_rate": sr,
        })
    return chunks, diags


def read_slice(wav_path, read_start, read_stop):
    """(waveform_float32_1D, sample_rate). float32 je OBAVEZAN — bez njega
    `sf.read` vraca float64 pa `.float()` radi drugu kopiju i trosi 3× (§1.3)."""
    data, sr = sf.read(str(wav_path), start=int(read_start), stop=int(read_stop),
                       dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data, sr


if __name__ == "__main__":
    import sys
    from pathlib import Path
    wav = Path(sys.argv[1])
    target = float(sys.argv[2]) if len(sys.argv) > 2 else 7200.0
    chunks, diags = plan_chunks(wav, target_s=target, verbose=True)
    _, sr, dur = wav_info(wav)
    print(f"{wav.name}: {dur/3600:.2f} h → {len(chunks)} komada")
    for c in chunks:
        print(f"  #{c['idx']}  cita {c['start_s']/3600:6.3f}–{c['end_s']/3600:6.3f} h "
              f"({c['duration_s']/3600:.2f} h, {(c['read_stop']-c['read_start'])*4/2**20:.0f} MB float32) "
              f"| posjeduje {c['own_start_s']/3600:6.3f}–{c['own_end_s']/3600:6.3f} h")
    for d in diags:
        print(f"  rez: {d}")
