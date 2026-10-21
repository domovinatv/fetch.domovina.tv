"""Riječi s vremenom za raspon epizode (isti par SRT+words.json i lijepljenje na cue kao render_reel.py).

    cd <repo> && python3 tools/hyperframes_reel/words_for_range.py <diarized.srt> <words.json> <start> <end> <transcript.json>

Vremena u izlazu su relativna na početak reela (r_s). Treba venv s opencv (uvozi render_reel).
"""
import sys, json
sys.path.insert(0, "tools")
import render_reel as R
srt, wj, a, b, out = sys.argv[1:6]
words, starts, ends = R.load_words(srt, wj)
r_s = min(starts, key=lambda x: abs(x - float(a))) - 0.12
r_e = min((e for e in ends if e > r_s + 1), key=lambda x: abs(x - float(b))) + 0.45
rw = [{"text": t, "start": round(s - r_s, 3), "end": round(e - r_s, 3)} for t, s, e in words if r_s - 0.05 <= s < r_e - 0.2]
json.dump({"r_s": r_s, "r_e": r_e, "dur": r_e - r_s, "words": rw}, open(out, "w"), ensure_ascii=False, indent=0)
print(r_s, r_e, r_e - r_s, len(rw))
