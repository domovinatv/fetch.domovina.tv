#!/usr/bin/env python3
"""test_guard.py — provjera nadzornika stroja iz diarize_canary.py (P3).

Ne dira pyannote ni GPU: samo dokazuje da MachineGuard opali na svaki prag i da
sutke prode kad je sve unutar granica. Pokreni:

    python3 colab_diarize/test_guard.py
"""

import importlib.util
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("diarize_canary", HERE / "diarize_canary.py")
dc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dc)


def _run_guard(min_disk, rss_cap, wait_s=2.5):
    """Vrati razlog prekida (ili None) nakon `wait_s` sekundi nadzora."""
    fired = {}
    guard = dc.MachineGuard(pids_fn=lambda: [os.getpid()],
                            abort_fn=lambda reason: fired.setdefault("reason", reason),
                            min_free_disk_gb=min_disk, rss_cap_gb=rss_cap,
                            interval_s=1).start()
    time.sleep(wait_s)
    guard.stop()
    return fired.get("reason")


def main():
    print(f"   stroj: {sys.platform} | slobodno na / {dc.free_disk_gb():.1f} GB "
          f"| RSS ovog procesa {dc.rss_gb(os.getpid()):.2f} GB "
          f"| swap {dc.swap_usage()[1]:.1f}/{dc.swap_usage()[0]:.1f} GB")

    assert dc.guard_enabled("on") is True
    assert dc.guard_enabled("off") is False
    assert dc.guard_enabled("auto") == (sys.platform == "darwin")
    print("   OK  guard_enabled: on/off eksplicitni, auto = samo macOS")

    reason = _run_guard(min_disk=99999, rss_cap=15)
    assert reason and "slobodno na /" in reason, f"disk prag nije opalio: {reason}"
    print(f"   OK  disk prag  -> {reason}")

    reason = _run_guard(min_disk=0.001, rss_cap=0.0001)
    assert reason and "RSS" in reason, f"RSS prag nije opalio: {reason}"
    print(f"   OK  RSS prag   -> {reason}")

    reason = _run_guard(min_disk=0.001, rss_cap=9999)
    assert reason is None, f"nadzornik je opalio bez razloga: {reason}"
    print("   OK  unutar pragova nadzornik sutke prolazi")

    print("\n   SVI TESTOVI PROSLI")


if __name__ == "__main__":
    main()
