#!/usr/bin/env python3
"""
machine_guard.py — mjerenje pritiska na stroj i nadzornik nad child procesom.

Zamjenjuje nadzornika iz prve verzije `02_diarize.py`, koji je mjerio KRIVE
veličine. Sve u ovoj datoteci je mjereno na ovom stroju 2026-08-25; brojke i
izvori su u `docs/pipeline_memorija_i_propusnost_2026-08.md` §5.7 i §5.8.

═══ ZAŠTO RSS NE VALJA, A phys_footprint VALJA ═══

MPS alocira iz unified memorije preko IOAcceleratora i te alokacije **ne ulaze u
RSS**. Mjereno (dvaput neovisno, §5.7 i ponovljeno pri pisanju ovog modula):

    2 GiB tenzor na MPS-u  →  RSS +3..207 MB,  phys_footprint +2198 MB

Prag na RSS-u je zato mrtvo slovo — nikad ne opali za GPU memoriju. Ispravna
metrika je `proc_pid_rusage(pid, RUSAGE_INFO_V4).ri_phys_footprint`: jedan
syscall, radi cross-process bez sudo (provjereno), i pokriva CPU-side nizove
(scipy klasteriranje) i MPS/IOAccelerator u JEDNOM broju.

═══ ZAŠTO SE SWAP MJERI KAO RAST, A NE KAO OMJER ═══

§5.8 predlaže `swap_used / swap_total > 0.75` kao najraniji signal. Na ovom
stroju taj uvjet je ISPUNJEN U MIROVANJU:

    vm.swapusage: total = 11264 M, used = 9575 M   →  omjer 0.85
    kern.memorystatus_vm_pressure_level = 1 (NORMAL)
    memory_pressure: "System-wide memory free percentage: 68%"

Uzrok nije naš posao nego Docker Desktopov Linux VM, koji drži fiksno
rezerviranih 14 GiB od 24 GB (`MemoryMiB = 14336`). macOS swap `total` raste po
potrebi, pa je omjer visok kad god swap uopće postoji i nije baš narastao —
apsolutni prag na omjeru bi prekinuo svaki posao odmah, na zdravom stroju.

Zato mjerimo **rast od početka posla**: koliko je swapa dodano OTKAKO smo
krenuli. To je jedina veličina koja govori o NAŠEM poslu, a zadržava svojstvo
zbog kojeg je swap izabran kao prvi u nizu — pojavi se prije nego stroj počne
štucati.

═══ df JE ISPRAVAN ═══

`shutil.disk_usage('/')` je konzervativniji i od Appleovog
`ForImportantUsage`; Finderov „purgeable" prostor je
`ForOpportunisticUsage` i za swap je fatamorgana (§5.7, nalaz koji je obrnuo
raniji zaključak). Disk-prag se ZADRŽAVA.
"""

import ctypes
import os
import shutil
import signal
import subprocess
import time

# ─── phys_footprint preko libproc ────────────────────────────────────────────

_libproc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
_libproc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int,
                                     ctypes.POINTER(ctypes.c_void_p)]
_libproc.proc_pid_rusage.restype = ctypes.c_int

_RUSAGE_INFO_V4 = 4
# Offset `ri_phys_footprint` unutar `struct rusage_info_v0` (prefiks je isti u
# svim verzijama v0..v6, pa vrijedi i za V4):
#   ri_uuid[16]=0, user_time=16, system_time=24, pkg_idle_wkups=32,
#   interrupt_wkups=40, pageins=48, wired_size=56, resident_size=64,
#   phys_footprint=72
_FOOTPRINT_OFFSET = 72


def phys_footprint_gb(pid):
    """Stvarni memorijski otisak procesa u GB, ukljucujuci MPS. 0.0 ako ne uspije.

    Za razliku od RSS-a vidi i IOAccelerator alokacije — vidi doc-string modula.
    """
    buf = ctypes.create_string_buffer(1024)
    rc = _libproc.proc_pid_rusage(
        pid, _RUSAGE_INFO_V4,
        ctypes.cast(ctypes.byref(buf), ctypes.POINTER(ctypes.c_void_p)))
    if rc != 0:
        return 0.0
    return int.from_bytes(
        buf.raw[_FOOTPRINT_OFFSET:_FOOTPRINT_OFFSET + 8], "little") / 2**30


def rss_gb(pid):
    """RSS u GB — zadrzan SAMO za ispis uz footprint, nikad kao prag."""
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=5)
        return int(out.stdout.strip()) / 2**20
    except Exception:
        return 0.0


def free_disk_gb(path="/"):
    return shutil.disk_usage(path).free / 2**30


def swap_usage():
    """(total_gb, used_gb) iz `sysctl vm.swapusage`."""
    try:
        out = subprocess.run(["sysctl", "-n", "vm.swapusage"],
                             capture_output=True, text=True, timeout=5)
    except Exception:
        return 0.0, 0.0
    tot = used = 0.0
    parts = out.stdout.replace("=", " ").split()
    for i, p in enumerate(parts):
        if p == "total" and i + 1 < len(parts):
            tot = _mb(parts[i + 1]) / 1024
        if p == "used" and i + 1 < len(parts):
            used = _mb(parts[i + 1]) / 1024
    return tot, used


def _mb(token):
    """'9575.19M' / '1.50G' → MB."""
    token = token.strip()
    mult = {"M": 1.0, "G": 1024.0, "K": 1 / 1024.0}.get(token[-1:], 1.0)
    try:
        return float(token.rstrip("MGK")) * mult
    except ValueError:
        return 0.0


def vm_pressure_level():
    """1=NORMAL, 2=WARN, 4=CRITICAL. 1 ako se ne moze procitati.

    NAPOMENA: `vm.memory_pressure` NE koristiti — na ovom stroju vraca
    konstantnu 0 (§5.8).
    """
    try:
        out = subprocess.run(
            ["sysctl", "-n", "kern.memorystatus_vm_pressure_level"],
            capture_output=True, text=True, timeout=5)
        return int(out.stdout.strip())
    except Exception:
        return 1


def total_ram_gb():
    try:
        out = subprocess.run(["sysctl", "-n", "hw.memsize"],
                             capture_output=True, text=True, timeout=5)
        return int(out.stdout.strip()) / 2**30
    except Exception:
        return 0.0


# ─── Nadzornik ───────────────────────────────────────────────────────────────

class MachineGuard:
    """Pragovi + stanje mjerenja. `check(pid)` vraca razlog prekida ili None.

    Poredak provjera je iz §5.8, od najranijeg signala prema najkasnijem, uz
    jednu izmjenu (swap-rast umjesto swap-omjera) obrazlozenu u doc-stringu
    modula:

        1. rast swapa od pocetka posla   → ABORT  (rani; hvata uzrok)
        2. slobodan prostor na /          → ABORT  (df je ispravan)
        3. phys_footprint djeteta         → ABORT  (zamjena za RSS)
        4. kern.memorystatus_vm_pressure  → ABORT  (kasni; zadnja crta)
    """

    def __init__(self, min_free_disk_gb=7.0, footprint_cap_gb=14.0,
                 swap_growth_gb=3.0, disk_path="/", enabled=True,
                 warn_streak_abort=6):
        self.min_free_disk_gb = min_free_disk_gb
        self.footprint_cap_gb = footprint_cap_gb
        self.swap_growth_gb = swap_growth_gb
        self.disk_path = disk_path
        self.enabled = enabled
        self.warn_streak_abort = warn_streak_abort
        self.warn_streak = 0

        _, self.swap_baseline_gb = swap_usage()
        self.peak_footprint_gb = 0.0
        self.peak_rss_gb = 0.0
        self.min_free_disk_seen = free_disk_gb(disk_path)
        self.max_swap_growth_seen = 0.0
        self.last = {}

    def sample(self, pid):
        """Izmjeri sve i osvjezi vrhove. Vraca dict za ispis."""
        _, swap_used = swap_usage()
        s = {
            "footprint_gb": phys_footprint_gb(pid),
            "rss_gb": rss_gb(pid),
            "free_disk_gb": free_disk_gb(self.disk_path),
            "swap_used_gb": swap_used,
            "swap_growth_gb": swap_used - self.swap_baseline_gb,
            "pressure": vm_pressure_level(),
        }
        self.peak_footprint_gb = max(self.peak_footprint_gb, s["footprint_gb"])
        self.peak_rss_gb = max(self.peak_rss_gb, s["rss_gb"])
        self.min_free_disk_seen = min(self.min_free_disk_seen, s["free_disk_gb"])
        self.max_swap_growth_seen = max(self.max_swap_growth_seen,
                                        s["swap_growth_gb"])
        self.last = s
        return s

    def verdict(self, s):
        """None ako je sve u redu, inace razlog prekida (string)."""
        if not self.enabled:
            return None
        if s["swap_growth_gb"] > self.swap_growth_gb:
            return (f"swap narastao za {s['swap_growth_gb']:.1f} GB od starta "
                    f"(prag {self.swap_growth_gb:.1f} GB) — posao gura stroj u swap")
        if s["free_disk_gb"] < self.min_free_disk_gb:
            return (f"slobodan prostor na {self.disk_path} pao na "
                    f"{s['free_disk_gb']:.1f} GB (prag {self.min_free_disk_gb:.1f} GB)")
        if s["footprint_gb"] > self.footprint_cap_gb:
            return (f"phys_footprint djeteta {s['footprint_gb']:.1f} GB premasio prag "
                    f"{self.footprint_cap_gb:.1f} GB")
        # ⚠️ WARN (2) NE SMIJE prekidati sam. Mjereno 2026-08-25 na probnom
        # komadu (part_04, 1h56m): kroz cijelu fazu `embeddings` razina stoji na
        # 2, dok je footprint ravnih 4.9 GB, swap se SMANJUJE, disk se ne mice, a
        # `memory_pressure` javlja 63 % slobodno. U mirovanju je razina konstantno
        # 1 (40 uzoraka), dakle signal nije smece — ali on mjeri macOS-ovu ZELJU
        # da aplikacije otpuste cacheve, a ne blizinu rusenja. Na stroju gdje
        # Docker VM drzi 14 GiB rezervirano, svaki iole veci posao ga podigne.
        #
        # Zato je WARN ovdje KVALIFIKATOR, ne okidac: prekida tek ako je odrzan
        # I ako ga prati stvarni nepovoljan trend (swap raste). CRITICAL (4) je
        # prava nuzda i prekida odmah.
        if s["pressure"] >= 4:
            return f"kern.memorystatus_vm_pressure_level = {s['pressure']} (CRITICAL)"
        if s["pressure"] >= 2:
            self.warn_streak += 1
            if (self.warn_streak >= self.warn_streak_abort
                    and s["swap_growth_gb"] > self.swap_growth_gb / 2):
                return (f"WARN odrzan {self.warn_streak} uzoraka UZ rast swapa "
                        f"{s['swap_growth_gb']:.1f} GB — stroj stvarno tone")
        else:
            self.warn_streak = 0
        return None

    def preflight(self, need_free_disk_gb=None):
        """Provjera PRIJE starta. Vraca (ok, poruka)."""
        need = need_free_disk_gb if need_free_disk_gb is not None \
            else self.min_free_disk_gb + 2.0
        disk = free_disk_gb(self.disk_path)
        if self.enabled and disk < need:
            return False, (
                f"samo {disk:.1f} GB slobodno na {self.disk_path} "
                f"(predpolet trazi {need:.1f} GB).\n"
                f"   macOS ovdje drzi swap. Poluge za oslobadanje su u memoriji "
                f"[[docker_vm_reserves_14gib_of_24]] — Docker Desktop drzi 14 GiB "
                f"rezervirano.")
        return True, f"{disk:.1f} GB slobodno na {self.disk_path}"

    def summary(self):
        return {
            "peak_footprint_gb": round(self.peak_footprint_gb, 2),
            "peak_rss_gb": round(self.peak_rss_gb, 2),
            "min_free_disk_gb": round(self.min_free_disk_seen, 2),
            "max_swap_growth_gb": round(self.max_swap_growth_seen, 2),
        }


def kill_child(proc, grace_s=30):
    """SIGKILL djetetu (bez SIGTERM-a: pyannote ga u C-petljama zna progutati)."""
    try:
        os.kill(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.join(timeout=grace_s)


def hms(sec):
    sec = max(0, int(sec))
    return f"{sec // 3600}:{(sec % 3600) // 60:02d}:{sec % 60:02d}"


def format_sample(s, elapsed_min, where=""):
    return (f"   ⏱️  {elapsed_min:6.1f} min | footprint {s['footprint_gb']:5.1f} GB "
            f"(RSS {s['rss_gb']:4.1f}) | disk {s['free_disk_gb']:5.1f} GB | "
            f"swap {s['swap_growth_gb']:+.1f} GB | p{s['pressure']}{where}")


if __name__ == "__main__":
    # Samotest: ispisi trenutno stanje stroja.
    print(f"RAM ukupno            {total_ram_gb():.1f} GB")
    print(f"slobodno na /         {free_disk_gb():.1f} GB")
    tot, used = swap_usage()
    print(f"swap                  {used:.1f} / {tot:.1f} GB "
          f"(omjer {used / tot if tot else 0:.2f})")
    print(f"pressure level        {vm_pressure_level()} (1=NORMAL 2=WARN 4=CRITICAL)")
    print(f"footprint ovog proc.  {phys_footprint_gb(os.getpid()):.3f} GB")
