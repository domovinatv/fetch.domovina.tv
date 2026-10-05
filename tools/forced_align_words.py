#!/usr/bin/env python3
"""PROTOTIP: words.json za Canary epizode forced alignmentom (torchaudio MMS_FA).

Canary epizode nemaju vrijeme po riječi na disku (vidi
../domovina.ai/docs/2026-10-06-titlovi-rijec-po-rijec.md §5). Ovdje se postojeći
tekst cue-a iz kanonskog diarized.srt poravna s postojećim zvukom unutar granica
cue-a — lokalno, bez LLM-a i bez plaćenog API-ja. Mjerenja i prag:
docs/2026-10-06-words-json-titlovi.md.

    python3 tools/forced_align_words.py <diarized.srt> <audio.wav|mp3> <out.words.json>
        [--compare <speechmatics.words.json>] [--min-score 0.X] [--device mps|cpu]

Izlaz je ugovor iz §3 uz `source: "mms_fa"`. Cue čija je pouzdanost ispod
`--min-score` se izostavlja (frontend ga tada prikaže bez isticanja), jer
collapse tekst ("da li, da li, …" ×129) ne odgovara zvuku i isticao bi krive
riječi. `anchored` = udio riječi u prihvaćenim cue-ovima.
"""
import argparse, json, re, subprocess, sys, time, unicodedata

import numpy as np
import torch
import torchaudio
import torchaudio.functional as F

SR = 16000
CHUNK_S, CTX_S = 30, 1          # emisije po 30 s s 1 s konteksta sa svake strane
PAD_MS = 150                    # zvuk oko cue-a (dijarizacijske granice znaju odrezati rub riječi)
MAX_CUE_S = 120                 # patološki cue-ovi (collapse: 00:00:00 --> 01:45:01) se ne poravnavaju
MIN_WORD_MS = 60


def srt_ms(s):
    h, m, r = s.split(":"); sec, f = r.replace(".", ",").split(",")
    return ((int(h) * 60 + int(m)) * 60 + int(sec)) * 1000 + int(f)


def parse_cues(raw):
    """Isto kao generate_words_json.js:parseCues (i referenca)."""
    out = []
    for b in re.split(r"\r?\n\s*\r?\n", raw.strip()):
        l = b.strip().split("\n")
        if len(l) < 3:
            continue
        m = re.search(r"(\S+)\s*-->\s*(\S+)", l[1])
        if not m:
            continue
        t = " ".join(x.strip() for x in l[2:]).strip()
        if not re.match(r"^\[\w+\]", t):
            continue
        t = re.sub(r"^\[\w+\]", "", t).strip()
        out.append((srt_ms(m.group(1)), srt_ms(m.group(2)), t.split()))
    return out


def romanize(word):
    """MMS_FA rječnik je a-z + '. Hrvatski: dijakritike van, đ → dj. Bez slova → None (star)."""
    w = word.lower().replace("đ", "dj").replace("ß", "ss")
    w = unicodedata.normalize("NFKD", w)
    w = "".join(c for c in w if not unicodedata.combining(c))
    w = re.sub(r"[^a-z']", "", w)
    return w or None


def load_audio(path):
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         check=True, capture_output=True).stdout
    return torch.from_numpy(np.frombuffer(pcm, dtype=np.float32).copy())


def emissions(model, wav, device):
    """Log-prob emisije za cijelu snimku, u komadima (model je wav2vec2, pamti cijeli ulaz)."""
    chunk, ctx = CHUNK_S * SR, CTX_S * SR
    parts, ratio = [], None
    with torch.inference_mode():
        for st in range(0, len(wav), chunk):
            a, b = max(0, st - ctx), min(len(wav), st + chunk + ctx)
            em, _ = model(wav[a:b].unsqueeze(0).to(device))
            em = em[0].float().cpu()
            r = (b - a) / em.shape[0]                       # uzoraka po frameu (~320)
            ratio = ratio or r
            lo = round((st - a) / r)
            hi = lo + round((min(st + chunk, len(wav)) - st) / r)
            parts.append(em[lo:hi])
    return torch.cat(parts), ratio


def align_cue(em, ratio, s, e, toks, dictionary, star):
    """Poravna jedan cue. Vraća ([(a_ms, b_ms, score)] po riječi, cue_score) ili None."""
    if e - s > MAX_CUE_S * 1000:
        return None
    f0 = max(0, int((s - PAD_MS) * SR / 1000 / ratio))
    f1 = min(em.shape[0], int((e + PAD_MS) * SR / 1000 / ratio) + 1)
    roman = [romanize(t) for t in toks]
    # Star na rubovima upija zvuk koji tekst ne pokriva (rub susjednog cue-a, šum).
    groups = [[star]] + [[dictionary[c] for c in r] if r else [star] for r in roman] + [[star]]
    targets = [t for g in groups for t in g]
    if f1 - f0 <= len(targets):
        return None
    try:
        ali, scores = F.forced_align(em[f0:f1].unsqueeze(0), torch.tensor([targets], dtype=torch.int32), blank=0)
    except Exception:
        return None
    spans = F.merge_tokens(ali[0], scores[0].exp())
    if len(spans) != len(targets):
        return None
    words, k = [], 0
    for gi, g in enumerate(groups):
        sp = spans[k:k + len(g)]; k += len(g)
        if gi == 0 or gi == len(groups) - 1:
            continue
        a = (f0 + sp[0].start) * ratio * 1000 / SR
        b = (f0 + sp[-1].end) * ratio * 1000 / SR
        sc = sum(x.score * (x.end - x.start) for x in sp) / max(1, sum(x.end - x.start for x in sp))
        words.append([int(a), int(b), sc, roman[gi - 1] is not None])
    real = [w[2] for w in words if w[3]]
    cue_score = float(np.mean(real)) if real else 0.0
    # Granice cue-a su ugovor (frontend): stegni unutra, monotono, minimalno trajanje.
    out = []
    for a, b, sc, _ in words:
        a = min(max(a, s), e); b = min(max(b, a + MIN_WORD_MS), e)
        if out and a < out[-1][0]:
            a = out[-1][0]
        out.append((a, max(a, b), sc))
    return out, cue_score


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("srt"); ap.add_argument("audio"); ap.add_argument("out")
    ap.add_argument("--compare"); ap.add_argument("--min-score", type=float, default=0.0)
    ap.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    ap.add_argument("--stats-out")
    a = ap.parse_args()

    t0 = time.time()
    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=True).to(a.device).eval()
    dictionary = bundle.get_dict(star="*")
    star = dictionary["*"]
    t_load = time.time() - t0

    t0 = time.time(); wav = load_audio(a.audio); t_audio = time.time() - t0
    dur = len(wav) / SR
    t0 = time.time(); em, ratio = emissions(model, wav, a.device); t_em = time.time() - t0

    cues = parse_cues(open(a.srt, encoding="utf-8").read())
    t0 = time.time()
    res, cue_stats, words_tot, words_ok = [], [], 0, 0
    for s, e, toks in cues:
        if not toks:
            continue
        words_tot += len(toks)
        r = align_cue(em, ratio, s, e, toks, dictionary, star)
        if r is None:
            cue_stats.append({"s": s, "e": e, "n": len(toks), "score": None})
            continue
        ws, cs = r
        cue_stats.append({"s": s, "e": e, "n": len(toks), "score": round(cs, 3)})
        if cs < a.min_score:
            continue
        words_ok += len(toks)
        res.append({"s": s, "e": e, "w": [round(v) for w in ws for v in w[:2]], "a": round(cs, 2)})
    t_al = time.time() - t0

    doc = {"v": 1, "source": "mms_fa", "anchored": round(words_ok / max(1, words_tot), 3), "cues": res}
    json.dump(doc, open(a.out, "w"), separators=(",", ":"))

    sc = [c["score"] for c in cue_stats if c["score"] is not None]
    wsc = np.repeat(sc, [c["n"] for c in cue_stats if c["score"] is not None]) if sc else np.array([0.0])
    stats = {
        "audio_s": round(dur), "model_load_s": round(t_load, 1), "decode_s": round(t_audio, 1),
        "emission_s": round(t_em, 1), "align_s": round(t_al, 1),
        "rtf": round((t_audio + t_em + t_al) / dur, 4),
        "cues": len(cue_stats), "cues_failed": sum(c["score"] is None for c in cue_stats),
        "words": words_tot, "anchored": doc["anchored"],
        "cue_score_p10_p50_p90": [round(float(x), 3) for x in np.percentile(sc, [10, 50, 90])] if sc else None,
        "word_weighted_score_mean": round(float(wsc.mean()), 3),
        "words_in_cues_below": {str(t): round(float((wsc < t).mean()), 3) for t in (0.2, 0.3, 0.4, 0.5)},
    }
    if a.compare:
        ref = {c["s"]: c["w"] for c in json.load(open(a.compare))["cues"]}
        diffs = []
        for c in res:
            w = ref.get(c["s"])
            if w and len(w) == len(c["w"]):
                diffs += [abs(x - y) for x, y in zip(c["w"][0::2], w[0::2])]
        d = np.array(diffs) if diffs else np.array([0])
        stats["vs_speechmatics_start_ms"] = {"n": len(diffs), "p50": int(np.median(d)), "p90": int(np.percentile(d, 90)),
                                             "within_100ms": round(float((d <= 100).mean()), 3),
                                             "within_250ms": round(float((d <= 250).mean()), 3)}
    stats["cue_scores"] = cue_stats if a.stats_out else None
    if a.stats_out:
        json.dump(stats, open(a.stats_out, "w"))
    stats.pop("cue_scores")
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    main()
