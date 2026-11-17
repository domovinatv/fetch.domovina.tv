"""Soniox riječi isječka + ručne ispravke (glasanje 5 prijepisa) → src/transcript.json za titl.
Vremena: Soniox; zamjena iste duljine nosi vremena, inače se raspon bloka dijeli ravnomjerno."""
import json, difflib, re, os
A = os.path.dirname(os.path.abspath(__file__)); CS = 1816.0
W = json.load(open(f"{A}/vote.json"))["words"]
src = [w[0] for w in W]
txt = " ".join(src)
FIX = [  # (Soniox, ispravak) — glasanje Soniox / Gemini 4 Hydrogen (isječak, agy) / Canary nightly
    ("znaš da te posao ubija", "znaš da te taj posao ubija"),                 # Canary; H4/A4 app
    ("nikad 100% pozitivna", "nikad sto posto pozitivna"),                    # H + C
    ("joj, što će reći", "joj, šta će reći"), ("ili što će se", "ili šta će se"),  # H + C
    ("ne odlučuju onako", "ne odlučuju na onako"),                            # H + C
    ("propo, etiketa, točno,", "propo… Etiketu. Etiketa, točno,"),            # H: voditelj dobacuje „Etiketu.”
    ("kako sam fulo,", "kako sam fulao,"),                                    # H (C „pulo”)
    ("Niško je isti luzer, ovo-ono.", "niškoristi, luzer, ovo-ono."),           # H „niš koristi”; Soniox conf 0,29
    ("biraju trpiti", "biraju trpjeti"),
    ("sve procesi, sve traje", "sve je proces i sve traje"),                  # H + C
    ("oslobodimo. Psihički proces prije svega.", "oslobodimo, da u onom… Psihički, prije svega."),  # H + C „da u onom”; voditelj
    ("ne da imam nešto", "ne da ja imam nešto"),                              # H
    ("puno zalaganje, proći će", "puno zalaganja i proći će"),                # C; H4/A4 app
    ("su čisti failovi,", "su čisti fejlovi,"),                               # H
    ("djeca s njima tamo,", "djeca, simo-tamo,"),                             # H „simo-tamo”, C „sima tamo”
    ("To je kao vrh Santa Leda, di se vrha, a ispod se ne vidi.", "To je ko vrh sante leda. Točno. Vidi se vrh, a ovo ispod se ne vidi. Točno."),  # H (voditelj + Ante)
    ("Znači, svatko priča", "Znači, svako priča"),                            # H + C
    ("nekako miču taj tabu", "nekako krše taj, miču taj tabu"),               # H; H4/A4 app
    ("jedno, dva, tri faila na projekta.", "jedno, dva-tri fejlana projekta."),  # H + C
    ("On kaže, daj Bože,", "On kaže, pa daj Bože,"),                          # H „Ha”, H4/A4 app „pa”
    ("Tek kasnije sam", "I tek kasnije sam"),                                 # H + C
]
for a, b in FIX:
    assert txt.count(a) == 1, a
    txt = txt.replace(a, b)
dst = txt.split()
k = lambda w: re.sub(r"[^\wčćžšđ]", "", w.lower())
out = []
for t, i1, i2, j1, j2 in difflib.SequenceMatcher(None, [k(x) for x in src], [k(x) for x in dst], autojunk=False).get_opcodes():
    if t == "equal" or (t == "replace" and i2 - i1 == j2 - j1):
        for n in range(j2 - j1): out.append([dst[j1 + n], W[i1 + n][1], W[i1 + n][2]])
        continue
    s = W[i1][1] if i1 < i2 else (W[i1 - 1][2] if i1 else W[0][1])
    e = W[i2 - 1][2] if i1 < i2 else (W[i1][1] if i1 < len(W) else s + 0.3)
    if e - s < 0.12 * (j2 - j1):   # ubačaj bez prostora: posudi od susjeda
        s = max(out[-1][1] + 0.05, s - 0.12 * (j2 - j1)) if out else s
        if out: out[-1][2] = min(out[-1][2], s)
    d = (e - s) / max(1, j2 - j1)
    for n in range(j2 - j1): out.append([dst[j1 + n], s + n * d, s + (n + 1) * d])
for x in out:
    if x[2] - x[1] < 0.05: x[2] = x[1] + 0.05
tr = [{"id": f"w{i}", "text": w, "start": round(a - CS, 3), "end": round(b - CS, 3)} for i, (w, a, b) in enumerate(out)]
json.dump(tr, open(f"{A}/transcript_3asr.json", "w"), ensure_ascii=False, indent=0)
bad = [x for x in tr if x["end"] <= x["start"]] + [y for x, y in zip(tr, tr[1:]) if y["start"] < x["start"]]
print("riječi", len(tr), "loših vremena", len(bad), bad[:3])
