#!/usr/bin/env python3
"""Stanje jobova pilota u pipeline.domovina.ai (Bearer INGEST_KEY iz .env).

Upotreba: python3 tools/pilot_watch/status.py [ids.txt]
Default popis: tools/pilot_watch/ids_2026-11-01.txt (19 kandidata noći 01.11.2026.).
"""
import json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
IDS = open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "ids_2026-11-01.txt")).read().split()


def fetch_jobs():
    key = re.search(r'^PIPELINE_QUEUE_INGEST_KEY="?([^"\n]+)', open(os.path.join(REPO, ".env")).read(), re.M).group(1)
    req = urllib.request.Request("https://pipeline.domovina.ai/api/jobs?limit=200",
                                 headers={"authorization": "Bearer " + key, "User-Agent": "pilot-watch"})
    by = {}
    for j in json.load(urllib.request.urlopen(req, timeout=30))["jobs"]:
        if j["youtube_id"] in IDS and j["youtube_id"] not in by:
            by[j["youtube_id"]] = j
    return by


if __name__ == "__main__":
    by = fetch_jobs()
    for i in IDS:
        j = by.get(i, {})
        print(f'{i:12} {j.get("state","?"):11} force={j.get("llm_force","?")} mag={j.get("mag_hr_state") or "-":8} '
              f'{(j.get("llm_deferred") or "")[:30]:30} {(j.get("error") or "")[:50]:50} {(j.get("title") or "")[:40]}')
