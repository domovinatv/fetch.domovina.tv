#!/usr/bin/env python3
"""Watcher pilota: svakih 5 min čita stanje jobova i bilježi SVAKI prijelaz s vremenom.

Izlazi (i time javlja Claude sesiji) samo kad: neki job padne, isti job stoji u istom
stanju > 60 min, odgođeni članak ne pomogne ni nakon 3 forsiranja, sve je terminalno,
ili prođe 10 h. Odgođeni članak (ograda Claude prozora) sam forsira istom SQL naredbom
kao admin gumb „▶ Članak ipak sada” (wrangler d1 na pipeline_domovina).

Upotreba (iz Claude Codea kao background task — bez progress obavijesti, vidi ~/.claude/CLAUDE.md):
  python3 tools/pilot_watch/watch.py [ids.txt]
Log: automatic/logs/pilot_2026-11-01_transitions.tsv
"""
import os, subprocess, sys, time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from status import IDS, REPO, fetch_jobs  # noqa: E402

BACKEND = os.path.join(os.path.dirname(REPO), "pipeline.domovina.ai", "backend")
LOG = os.path.join(REPO, "automatic", "logs", "pilot_2026-11-01_transitions.tsv")
TERMINAL = ("done", "failed", "skipped")

last, since, reported, forced = {}, {}, set(), Counter()
log = open(LOG, "a")
t0 = time.time()


def w(line):
    log.write(f"{time.strftime('%H:%M:%S')}\t{line}\n")
    log.flush()


while True:
    try:
        by = fetch_jobs()
    except Exception as e:  # mreža/API — pokušaj za 5 min
        w(f"API greška: {e}")
        time.sleep(300)
        continue
    now, reasons = time.time(), []
    for i in IDS:
        j = by.get(i, {})
        st = (j.get("state", "?"), str(j.get("llm_deferred") or ""), j.get("mag_hr_state") or "")
        if last.get(i) != st:
            w(f"{i}\t{st[0]}\t{st[1]}\tmag={st[2]}\t{(j.get('error') or '')[:120]}")
            last[i], since[i] = st, now
        if st[0] == "failed" and ("f", i) not in reported:
            reasons.append(f"FAILED {i}: {j.get('error')}")
            reported.add(("f", i))
        if st[1] and st[0] in ("transcribing", "processing"):
            r = subprocess.run(
                ["npx", "wrangler", "d1", "execute", "pipeline_domovina", "--remote", "--command",
                 "UPDATE jobs SET state='queued', priority=MAX(priority,1), llm_force=1, llm_deferred=NULL, "
                 f"error=NULL, updated_at=strftime('%s','now') WHERE youtube_id='{i}' AND llm_deferred IS NOT NULL "
                 "AND deleted_at IS NULL"],
                cwd=BACKEND, capture_output=True, text=True)
            forced[i] += 1
            w(f"{i}\tAUTO-FORCE #{forced[i]} rc={r.returncode}")
            if forced[i] >= 3:
                reasons.append(f"DEFERRED 3x {i}: forsiranje ne pomaže")
        if st[0] not in ("queued",) + TERMINAL and now - since[i] > 3600 and ("s", i, st) not in reported:
            reasons.append(f"STALL {i} u {st[0]} {int((now - since[i]) / 60)} min")
            reported.add(("s", i, st))
    terminal = all(last[i][0] in TERMINAL for i in IDS)
    if reasons or terminal or now - t0 > 10 * 3600:
        print("\n".join(reasons) or ("SVE TERMINALNO" if terminal else "TIMEOUT 10h"))
        print(Counter(v[0] for v in last.values()))
        break
    time.sleep(300)
