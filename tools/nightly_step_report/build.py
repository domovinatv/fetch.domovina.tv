import json, re, sys, datetime as D, html, io, base64
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

S = sys.argv[1]
runs = json.load(open(S + '/runs.json'))
mag = json.load(open(S + '/mag.json'))
jobs = {j['id']: j for j in json.load(open(S + '/jobs.json'))['jobs']}

def ts(hms):  # 'HH:MM:SS' -> seconds of day
    h, m, s = map(int, hms.split(':')); return h * 3600 + m * 60 + s
def ep(x):
    if not x: return None
    x = x / 1000 if x > 1e11 else x
    d = D.datetime.fromtimestamp(x); return d.hour * 3600 + d.minute * 60 + d.second
def hm(sec):
    sec = int(sec); return f"{sec//3600:02d}:{sec%3600//60:02d}:{sec%60:02d}"
def dur(sec):
    if sec is None: return '–'
    sec = int(round(sec))
    if sec < 60: return f"{sec} s"
    return f"{sec//60}:{sec%60:02d}"
def esc(s): return html.escape(str(s))

PH = [
    ('Preuzimanje (0–1)', ['0', '1', '1b'], '#4C78A8'),
    ('WAV (2, 2.5)', ['2', '2.5'], '#9ecae9'),
    ('Modal Canary (2.6)', ['2.6'], '#bab0ac'),
    ('ASR (2.7b)', ['2.7b'], '#F58518'),
    ('pyannoteAI (2.7c)', ['2.7c'], '#ffbf79'),
    ('Kostur (2.8)', ['2.8'], '#d6d6d6'),
    ('Sažetak Opus (7)', ['7'], '#54A24B'),
    ('Članak Opus (8)', ['8'], '#2E7D32'),
    ('RAG + sličice (9–9.7)', ['9', '9.4', '9.5', '9.7'], '#b7d7a8'),
    ('Screenshotovi (10)', ['10'], '#E45756'),
    ('OG/EPUB/sponz./words (9.6–9.87)', ['9.6', '9.8', '9.85', '9.87'], '#ff9d98'),
    ('Reels Opus (9.9)', ['9.9'], '#B279A2'),
    ('R2 upload (12)', ['12'], '#72B7B2'),
    ('H.264 video (12.5)', ['12.5'], '#3a8f8a'),
    ('CDN ostalo (12.6–13)', ['12.6', '12.65', '12.66', '12.68', '12.7', '12.8', '13'], '#c7e9e6'),
]
STEP2PH = {s: i for i, (_, ss, _) in enumerate(PH) for s in ss}
WAIT_C, PRE_C, POST_C = '#eeeeee', '#888888', '#555555'

# ---------- Tier 2 (prioritetni red) ----------
T2 = []
for r in runs:
    j = jobs.get(r['job'], {})
    st = r['steps']
    steps = []
    for i, (k, t, name) in enumerate(st):
        a = ts(t); b = ts(st[i + 1][1]) if i + 1 < len(st) else ts(r['end'])
        steps.append(dict(k=k, name=name, start=a, end=b, d=b - a))
    phase = [0] * len(PH)
    for s in steps:
        phase[STEP2PH.get(s['k'], len(PH) - 1)] += s['d']
    e = dict(vid=r['vid'], channel=j.get('channel') or '', title=j.get('title') or '', audio=j.get('duration_seconds'),
             state=j.get('state'), err=j.get('error'), created=ep(j.get('created_at')), claimed=ep(j.get('claimed_at')),
             done=ep(j.get('done_at')), start=ts(r['start']), end=ts(r['end']), steps=steps, phase=phase,
             asr=j.get('asr_provider'), notes=r['notes'], tier='T2')
    e['pre'] = e['start'] - e['claimed'] if e['claimed'] else 0
    e['post'] = (e['done'] - e['end']) if e['done'] else None
    e['pyannote402'] = any('HTTP 402' in n for n in r['notes'])
    T2.append(e)

# ---------- Magisterium HR / EN po epizodi ----------
MHR, MEN = {}, {}
for t in mag['hr']:
    for v in t['vids']:
        if v == 'KLPD-Meu4e8': continue
        MHR[v] = dict(start=ts(t['start']), end=ts(t['end']), calls=t.get('calls'))
for t in mag['en']:
    for (kind, sec, v) in t['items']:
        if not v: continue
        d = MEN.setdefault(v, dict(items=[], ticks=[]))
        d['items'].append((kind, sec, ts(t['start']), ts(t['end'])))
for v, d in MEN.items():
    main = [x for x in d['items'] if x[0] in ('summary', 'article')]
    late = [x for x in d['items'] if x[0] == 'magisterium']
    d['main'] = (min(x[2] for x in main), max(x[3] for x in main), sum(x[1] for x in d['items'] if x[0] != 'magisterium')) if main else None
    late = [x for x in late if d['main'] and x[2] > d['main'][1]]
    d['mag'] = (late[0][2], late[0][3], late[0][1]) if late else None

# ---------- Nightly (praćeni kanali) ----------
NIGHT_STEPS = []
for l in open(S + '/nightly.log', encoding='utf-8', errors='replace'):
    m = re.search(r'📢 \[(\d\d:\d\d:\d\d) \+[\d:]+\] KORAK ([\d.]+[a-z]?)(?:/\d+)?: (.*)', l)
    if m: NIGHT_STEPS.append((m[2], ts(m[1]), m[3][:60]))
NIGHT_END = ts('03:58:13')
NS = []
for i, (k, a, name) in enumerate(NIGHT_STEPS):
    b = NIGHT_STEPS[i + 1][1] if i + 1 < len(NIGHT_STEPS) else NIGHT_END
    NS.append(dict(k=k, name=name, start=a, end=b, d=b - a))
NIGHT = [
    dict(vid='pIx_7N-6HJ4', channel='Mreže riječi', title='Jedno ti nedostaje: EP 65 – Večera je spremna (fra Ante Vučković i Stanko Stojić)', audio=32*60+7,
         soniox=45, summ=19.3, art=20.2+145.1, reels=94),
    dict(vid='uw5vYIdAHeM', channel='Ora et Labora', title='128. Milosrđe Božje – Odreći se i samoga sebe radi spasenja!', audio=57*60+44,
         soniox=76, summ=31.7, art=33.4+76.4+110.3, reels=76),
    dict(vid='3GGuSVt4Q4Y', channel='Radio Mrežnica', title='Andrijanić: Berlin želi kontrolu Poljske, Tusk ima zadaću', audio=81*60+14,
         soniox=119, summ=36.9, art=40.2+148.6+181.5, reels=149),
    dict(vid='uMVmX4GDYag', channel='Radio Mrežnica', title='C. Macgregor: Trump u Iranu (snimka iz ožujka, EN izvornik)', audio=28*60,
         soniox=46, summ=27.5, art=20.6+158.0, reels=None),
]

def fig_b64(fig):
    b = io.BytesIO(); fig.savefig(b, format='png', dpi=170, bbox_inches='tight'); plt.close(fig)
    return 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode()

plt.rcParams.update({'font.family': 'Helvetica', 'font.size': 8})
def xfmt(ax, lo, hi, step=1800):
    t0 = lo - lo % step
    ticks = list(range(t0, hi + step, step))
    ax.set_xticks(ticks); ax.set_xticklabels([hm(t)[:5] for t in ticks]); ax.set_xlim(lo, hi)
    ax.grid(axis='x', color='#ddd', lw=0.5); ax.set_axisbelow(True)

# ---------- Graf 1: dan po trakama ----------
fig, ax = plt.subplots(figsize=(11, 3.6))
lanes = ['Nightly (praćeni)', 'Prioritetni slot (Tier 2)', 'Magisterium HR', 'EN prijevod + Mag. EN']
y = {n: i for i, n in enumerate(lanes[::-1])}
for s in NS:
    ax.barh(y[lanes[0]], s['d'], left=s['start'], color=PH[STEP2PH.get(s['k'], 14)][2], edgecolor='white', lw=0.3, height=0.6)
for e in T2:
    ax.barh(y[lanes[1]], e['end'] - e['start'], left=e['start'], color='#E45756' if e['state'] == 'failed' else '#4C78A8', edgecolor='white', lw=0.6, height=0.6)
for v, d in MHR.items():
    ax.barh(y[lanes[2]], d['end'] - d['start'], left=d['start'], color='#B279A2', edgecolor='white', lw=0.6, height=0.6)
for t in mag['en']:
    if t['items']:
        ax.barh(y[lanes[3]], ts(t['end']) - ts(t['start']), left=ts(t['start']), color='#F58518', edgecolor='white', lw=0.6, height=0.6)
ax.axvline(ts('04:02:02'), color='k', ls=':', lw=0.8); ax.text(ts('04:02:02') + 60, 3.42, 'enqueue_all_new 04:02 (19 poslova)', fontsize=7)
ax.set_yticks(range(len(lanes))); ax.set_yticklabels(lanes[::-1])
xfmt(ax, ts('02:55:00'), ts('11:20:00'))
ax.set_title('04.11.2026. – rad po trakama (CET)', loc='left', fontsize=10)
G1 = fig_b64(fig)

# ---------- Graf 2: Tier 2 po epizodi, stvarna vremena po fazi ----------
rows = T2
fig, ax = plt.subplots(figsize=(11, 0.32 * len(rows) + 1.2))
for i, e in enumerate(rows[::-1]):
    yy = i
    if e['claimed'] and e['created']:
        pass
    ax.barh(yy, e['pre'], left=e['claimed'], color=PRE_C, height=0.7)
    for s in e['steps']:
        if s['d'] > 0:
            ax.barh(yy, s['d'], left=s['start'], color=PH[STEP2PH.get(s['k'], 14)][2], height=0.7)
    if e['post']:
        ax.barh(yy, e['post'], left=e['end'], color=POST_C, height=0.7)
    if e['vid'] in MHR:
        d = MHR[e['vid']]; ax.barh(yy, d['end'] - d['start'], left=d['start'], color='#B279A2', height=0.35, alpha=0.9)
    lab = f"{e['channel'][:22]} · {e['vid']}"
    ax.text(e['claimed'] - 90, yy, lab, ha='right', va='center', fontsize=6.5)
ax.set_yticks([])
xfmt(ax, ts('03:15:00'), ts('11:15:00'))
handles = [Patch(color=c, label=n) for n, _, c in PH] + [Patch(color=PRE_C, label='start slota'), Patch(color=POST_C, label='zatvaranje (reconcile)'), Patch(color='#B279A2', label='Magisterium HR (tanka traka)')]
ax.legend(handles=handles, ncol=6, fontsize=6, loc='upper center', bbox_to_anchor=(0.5, -0.06), frameon=False)
ax.set_title('Tier 2: svaka epizoda od preuzimanja posla do kraja, obojeno po koraku', loc='left', fontsize=10)
G2 = fig_b64(fig)

# ---------- Graf 3: trajanje po fazi (min), stacked, po epizodi ----------
ok = [e for e in T2 if e['state'] == 'done']
fig, ax = plt.subplots(figsize=(11, 0.3 * len(ok) + 1.3))
for i, e in enumerate(ok[::-1]):
    left = 0
    for p, (n, _, c) in enumerate(PH):
        w = e['phase'][p] / 60
        if w > 0: ax.barh(i, w, left=left, color=c, height=0.7)
        left += w
    tot = sum(e['phase']) / 60
    ax.text(left + 0.3, i, f"{tot:.0f} min  (audio {e['audio']//60} min)", va='center', fontsize=6.5)
ax.set_yticks(range(len(ok))); ax.set_yticklabels([f"{e['channel'][:22]} · {e['vid']}" for e in ok[::-1]], fontsize=6.5)
ax.set_xlabel('minute (zbroj koraka pipelinea, bez čekanja u redu)')
ax.grid(axis='x', color='#ddd', lw=0.5); ax.set_axisbelow(True)
ax.legend(handles=[Patch(color=c, label=n) for n, _, c in PH], ncol=5, fontsize=6, loc='upper center', bbox_to_anchor=(0.5, -0.12), frameon=False)
ax.set_title('Tier 2: kamo ide vrijeme po epizodi', loc='left', fontsize=10)
G3 = fig_b64(fig)

# ---------- Graf 4: ukupno po fazi ----------
tot = [sum(e['phase'][p] for e in ok) / 60 for p in range(len(PH))]
order = sorted(range(len(PH)), key=lambda p: tot[p])
fig, ax = plt.subplots(figsize=(7, 3.6))
ax.barh(range(len(order)), [tot[p] for p in order], color=[PH[p][2] for p in order])
for i, p in enumerate(order):
    ax.text(tot[p] + 1, i, f"{tot[p]:.0f} min · {100*tot[p]/sum(tot):.0f} %", va='center', fontsize=7)
ax.set_yticks(range(len(order))); ax.set_yticklabels([PH[p][0] for p in order])
ax.set_xlim(0, max(tot) * 1.25); ax.grid(axis='x', color='#ddd', lw=0.5); ax.set_axisbelow(True)
ax.set_title(f'Tier 2: zbroj po koraku, {len(ok)} epizoda ({sum(tot):.0f} min ukupno)', loc='left', fontsize=10)
G4 = fig_b64(fig)

# ---------- brojke za sažetak ----------
first_claim = min(e['claimed'] for e in T2); last_done = max(e['done'] for e in T2 if e['done'])
audio_ok = sum(e['audio'] or 0 for e in ok)
proc = [sum(e['phase']) for e in ok]
import statistics as st
waits = [e['claimed'] - e['created'] for e in T2]
mhr_d = [MHR[v]['end'] - MHR[v]['start'] for v in MHR]
en_d = [MEN[v]['main'][1] - MEN[v]['main'][0] for v in MEN if MEN[v]['main']]
n402 = sum(1 for e in ok if e['pyannote402'])
n_late = sum(1 for v in MEN.values() if v['mag'])
last_all = max([d['end'] for d in MHR.values()] + [x[3] for v in MEN.values() for x in v['items']])

# ---------- HTML ----------
H = []
A = H.append
A(f"""<!doctype html><html lang="hr"><head><meta charset="utf-8"><title>Nightly 04.11.2026. – vremena po koraku</title>
<style>
@page {{ size: A4 landscape; margin: 11mm 10mm; }}
body {{ font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 8.6pt; color:#1a1a1a; background:#fff; }}
h1 {{ font-size: 16pt; margin: 0 0 2mm; }} h2 {{ font-size: 12pt; margin: 5mm 0 2mm; border-bottom: 1px solid #ccc; padding-bottom: 1mm; }}
h3 {{ font-size: 9.5pt; margin: 3mm 0 1mm; }}
.meta {{ color:#555; margin-bottom: 3mm; }}
ul {{ margin: 1mm 0 2mm 5mm; padding: 0; }} li {{ margin: 0.6mm 0; }}
table {{ border-collapse: collapse; width: 100%; font-size: 7.2pt; }}
th, td {{ border: 1px solid #d8d8d8; padding: 0.8mm 1.2mm; text-align: right; white-space: nowrap; }}
th {{ background: #f3f3f3; font-weight: 600; }} td.l, th.l {{ text-align: left; }}
tr.fail td {{ background: #fde8e8; }} tr.warn td.w {{ background: #fff4dc; }}
.pb {{ page-break-before: always; }} img {{ width: 100%; }}
.small {{ font-size: 7pt; color: #555; }}
.grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; }}
.box {{ border:1px solid #ddd; padding: 1.5mm 2mm; break-inside: avoid; margin-bottom: 2.5mm; }}
.box table {{ font-size: 6.8pt; }}
.k {{ display:inline-block; min-width: 9mm; }}
</style></head><body>
<h1>Nightly 04.11.2026. – vrijeme po koraku za svaku epizodu</h1>
<div class="meta">Stanje u {D.datetime.now().strftime('%H:%M')} (CET). Izvori: <code>automatic/logs/nightly_2026-11-04.log</code>, <code>priority_2026-11-04.log</code>, <code>magisterium_2026-11-04.log</code>, <code>magisterium-en_2026-11-04.log</code>, API <code>pipeline.domovina.ai/api/jobs</code> i <code>cdn.domovina.ai/data/&lt;id&gt;/episode.json</code>. Trajanje koraka = razmak između dva uzastopna „📢 KORAK” zapisa u logu.</div>
<h2>Sažetak</h2>
<ul>
<li><b>23 nove epizode, 22 s člankom.</b> 4 iz nightlyja (praćeni kanali, 03:00–03:58) i 18 iz prioritetnog reda (Tier 2, nepraćeni kanali). 1 posao pao: <code>KyMHBGFS5Gc</code> (PSIHOLOGiJA HRT) – download ne prolazi, isti video pao je i 03.11.</li>
<li><b>Sve je gotovo.</b> Svih 18 Tier 2 epizoda na CDN-u ima članak, EN članak, Magisterium HR i Magisterium EN (provjereno u <code>episode.json</code>). Nightly: sve 4 imaju HR i EN članak; Magisterium HR/EN samo Ora et Labora (ostala tri kanala ga nemaju u planu). Zadnji posao (Magisterium EN za <code>NbLmTuhikJ4</code>) završio je u {hm(last_all)}.</li>
<li><b>Prioritetni slot:</b> prvi posao preuzet u {hm(first_claim)}, zadnji gotov u {hm(last_done)} ({(last_done-first_claim)/3600:.1f} h). Obrađeno {audio_ok/3600:.1f} h zvuka. Obrada po epizodi (zbroj koraka) medijan <b>{st.median(proc)/60:.0f} min</b>, raspon {min(proc)/60:.0f}–{max(proc)/60:.0f} min. Čekanje u redu od slanja do preuzimanja: medijan {st.median(waits)/60:.0f} min, najdulje {max(waits)/60:.0f} min.</li>
<li><b>Najveći potrošači vremena</b> (zbroj svih Tier 2 epizoda): {', '.join(f'{PH[p][0]} {tot[p]:.0f} min' for p in order[::-1][:4])}. Članak (Opus) sam je {100*tot[7]/sum(tot):.0f} % vremena.</li>
<li><b>Magisterium HR:</b> {len(MHR)} epizoda, medijan {st.median(mhr_d)/60:.0f} min po epizodi, ide jedna po jedna (tick svakih 10 min). Red je kasnio za slotom: zadnja HR obrada završila je u {hm(max(d['end'] for d in MHR.values()))}, {dur(max(d['end'] for d in MHR.values())-last_done)} (min:s) nakon zadnjeg članka. <b>EN prijevod:</b> {len(en_d)} epizoda, medijan {st.median(en_d)/60:.1f} min.</li>
<li><b>Magisterium EN zakasnio za {n_late} epizoda.</b> EN tick je prevodio članak čim je bio gotov, a HR Magisterium je tada još čekao u redu. Zakašnjeli Magisterium EN pokupio je novi kod iz <code>c2af6ac7</code> (<code>EN_MAG_LATE_SINCE</code>, 3 po ticku) između 10:14 i 11:11. Bez toga bi tih {n_late} ostalo bez Magisterium EN.</li>
<li><b>⚠️ pyannoteAI je ostao bez kredita u 05:51.</b> Od epizode <code>fUFlhmqBVMs</code> nadalje svaki poziv vraća HTTP 402 („Insufficient credits and no active subscription”). {n402} od {len(ok)} Tier 2 epizoda zato ima govornike iz Speechmaticsove vlastite dijarizacije, ne iz pyannoteAI. Pipeline nije stao (korak je non-fatal), ali kvaliteta govornika je niža i to se nigdje ne javlja kao greška. Nightly sutra u 03:00 udarit će u isto.</li>
<li><b>Samo jedan slot cijeli dan:</b> 184 puta u logu „slot 2+: disk 12–14 GB &lt; 25 GB”. Drugi slot se ne otvara jer je SSD pun, pa je red išao strogo serijski.</li>
<li><b>Modal Canary (2.6) se vrti kao osigurač na svakoj Tier 2 epizodi</b> iako je ASR Speechmatics: {tot[2]:.0f} min ukupno, oko {tot[2]/len(ok)*60/60:.1f} min po epizodi.</li>
<li>Rupa od 12 min iza <code>-kSZAvMDzC8</code> (08:15 → 08:27): <code>reconcile</code> je zapeo na mreži (<code>fetch failed</code>, uz to <code>PATCH … EPIPE</code>), pa je idući posao preuzet tek u idućem ticku.</li>
<li>Nightly: <code>audit_pipeline.js</code> exit 1 (rupe disk ↔ CDN), kao i jučer. Nightly ne staje zbog toga.</li>
</ul>
<img src="{G1}">
<div class="pb"></div>
<img src="{G2}">
<div class="small">Siva traka lijevo = od preuzimanja posla do početka pipelinea; tamna traka desno = zatvaranje (reconcile, inventar, PATCH na API). Tanka ljubičasta traka = Magisterium HR iste epizode.</div>
<div class="pb"></div>
<img src="{G3}">
<div class="grid"><div><img src="{G4}"></div><div>
<h3>Kako čitati</h3>
<ul>
<li>Trajanje je zbroj koraka pipelinea za tu epizodu, bez čekanja u redu i bez Magisteriuma/EN-a (oni idu u zasebnim trakama, paralelno sa slotom).</li>
<li><b>Članak (8)</b> = outline + jedan Opus poziv po iteraciji od ~35–45 min snimke; zato raste s duljinom.</li>
<li><b>H.264 (12.5)</b> = transkodiranje i upload videa; raste s duljinom videa.</li>
<li><b>Screenshotovi (10)</b> = yt-dlp stream + Apple Vision izbor kadra (21 kandidat po kadru).</li>
<li><b>Reels (9.9)</b> = 1 Opus poziv po epizodi.</li>
</ul></div></div>
""")

# ---------- Tablica 1: Tier 2 matrica faza ----------
A('<div class="pb"></div><h2>Tier 2 – trajanje svakog koraka po epizodi (min:s)</h2>')
A('<table><tr><th class="l">#</th><th class="l">video</th><th class="l">kanal</th><th>audio</th><th>poslano</th><th>preuzeto</th><th>čekanje</th>')
for n, _, _ in PH: A(f'<th>{esc(n.split(" (")[0])}</th>')
A('<th>start</th><th>zatv.</th><th>gotovo</th><th>obrada</th><th>ASR</th></tr>')
for i, e in enumerate(T2, 1):
    cls = 'fail' if e['state'] == 'failed' else ('warn' if e['pyannote402'] else '')
    A(f'<tr class="{cls}"><td class="l">{i}</td><td class="l"><code>{e["vid"]}</code></td><td class="l">{esc(e["channel"][:24])}</td><td>{dur(e["audio"]) if e["audio"] else "–"}</td>')
    A(f'<td>{hm(e["created"])}</td><td>{hm(e["claimed"])}</td><td>{dur(e["claimed"]-e["created"])}</td>')
    for p in range(len(PH)):
        v = e['phase'][p]; w = ' class="w"' if (p == 4 and e['pyannote402']) else ''
        A(f'<td{w}>{dur(v) if v else "·"}</td>')
    A(f'<td>{dur(e["pre"])}</td><td>{dur(e["post"])}</td><td>{hm(e["done"]) if e["done"] else "❌"}</td><td><b>{dur(sum(e["phase"])) if e["state"]=="done" else "–"}</b></td><td class="l">{esc(e["asr"] or "–")}{" +SM govornici" if e["pyannote402"] else ""}</td></tr>')
A('</table><div class="small">Žuto = pyannoteAI vratio HTTP 402 (nema kredita); govornici su iz Speechmaticsa. Crveno = posao pao (KyMHBGFS5Gc: „prioritetni download nije uspio (private/anti-bot?)”, nema info.json).</div>')

# ---------- Tablica 2: Magisterium + EN ----------
A('<h2>Magisterium HR, EN prijevod i Magisterium EN po epizodi</h2>')
A('<table><tr><th class="l">#</th><th class="l">video</th><th class="l">kanal</th><th>članak gotov</th><th>EN tick</th><th>EN trajanje</th><th>Mag HR tick</th><th>Mag HR traj.</th><th>poziva</th><th>čekanje HR od članka</th><th>Mag EN</th><th>Mag EN traj.</th><th>sve gotovo</th></tr>')
allrows = [(n['vid'], n['channel'], ts('03:58:13')) for n in NIGHT] + [(e['vid'], e['channel'], e['done']) for e in T2 if e['state'] == 'done']
for i, (v, ch, done) in enumerate(allrows, 1):
    en = MEN.get(v, {}); hr = MHR.get(v)
    m = en.get('main'); mg = en.get('mag')
    mg_txt, mg_d = ('–', '–')
    if mg: mg_txt, mg_d = f'{hm(mg[0])}–{hm(mg[1])[3:]} (kasni)', dur(mg[2])
    elif hr and any(x[0] == 'magisterium' for x in en.get('items', [])):
        x = [x for x in en['items'] if x[0] == 'magisterium'][0]; mg_txt, mg_d = f'{hm(x[2])}–{hm(x[3])[3:]} (s EN)', dur(x[1])
    ends = [done] + ([hr['end']] if hr else []) + [x[3] for x in en.get('items', [])]
    A(f'<tr><td class="l">{i}</td><td class="l"><code>{v}</code></td><td class="l">{esc(ch[:24])}</td><td>{hm(done)}{" (nightly)" if i<=4 else ""}</td>'
      f'<td>{(hm(m[0])+"–"+hm(m[1])[3:]) if m else "–"}</td><td>{dur(m[1]-m[0]) if m else "–"}</td>'
      f'<td>{(hm(hr["start"])+"–"+hm(hr["end"])[3:]) if hr else "nije u planu"}</td><td>{dur(hr["end"]-hr["start"]) if hr else "–"}</td><td>{hr["calls"] if hr else "–"}</td>'
      f'<td>{dur(hr["start"]-done) if hr else "–"}</td><td>{mg_txt if hr else "–"}</td><td>{mg_d if hr else "–"}</td><td><b>{hm(max(ends))}</b></td></tr>')
A('</table><div class="small">EN tick prevodi sažetak, članak i reels jednim agy pozivom po dokumentu. „Mag EN (kasni)” = Magisterium EN preveden naknadno, kad je HR Magisterium stigao poslije EN članka. Mag HR = <code>tools/magisterium_mcp_episode.js</code>, 2 sekcije po MCP pozivu.</div>')

# ---------- Nightly ----------
A('<div class="pb"></div><h2>Nightly (praćeni kanali) – koraci su skupni za sve 4 epizode</h2>')
A('<div class="grid"><div><table><tr><th class="l">KORAK</th><th class="l">opis</th><th>početak</th><th>trajanje</th></tr>')
for s in NS:
    A(f'<tr><td class="l">{s["k"]}</td><td class="l">{esc(s["name"][:58])}</td><td>{hm(s["start"])}</td><td>{dur(s["d"])}</td></tr>')
A(f'<tr><td class="l"></td><td class="l"><b>ukupno run_pipeline.sh</b></td><td>{hm(NS[0]["start"])}</td><td><b>{dur(NIGHT_END-NS[0]["start"])}</b></td></tr></table>'
  '<div class="small">Iza toga do 04:15 nightly vrti audit, watchlist, enqueue Tier 2 i katalog.</div></div><div>')
A('<h3>Po epizodi (gdje log daje vrijeme po epizodi)</h3><table><tr><th class="l">video</th><th class="l">kanal</th><th>audio</th><th>Soniox</th><th>sažetak</th><th>članak</th><th>reels</th><th>EN</th><th>Mag HR</th></tr>')
for n in NIGHT:
    en = MEN.get(n['vid'], {}).get('main'); hr = MHR.get(n['vid'])
    A(f'<tr><td class="l"><code>{n["vid"]}</code></td><td class="l">{esc(n["channel"])}</td><td>{dur(n["audio"])}</td><td>{dur(n["soniox"])}</td><td>{dur(n["summ"])}</td><td>{dur(n["art"])}</td><td>{dur(n["reels"]) if n["reels"] else "–"}</td><td>{dur(en[1]-en[0]) if en else "–"}</td><td>{dur(hr["end"]-hr["start"]) if hr else "–"}</td></tr>')
A('</table><div class="small">Soniox = vrijeme obrade na Sonioxu; sažetak i članak = trajanje Opus poziva (članak = outline + iteracije); reels = select_reels. <code>uMVmX4GDYag</code> nema reelsa jer je snimka iz ožujka (reels samo za zadnjih 21 dan). pyannoteAI je u nightlyju još radio (sve 4 epizode OK). KORAK 10 (screenshotovi) prolazi kroz cijeli katalog od 3584 epizode, zato traje 6 min.</div>')
for n in NIGHT: A(f'<div class="small"><code>{n["vid"]}</code> – {esc(n["title"])}</div>')
A('</div></div>')

# ---------- Prilog: svaki korak svake Tier 2 epizode ----------
A('<div class="pb"></div><h2>Prilog – svaki korak svake Tier 2 epizode (početak · trajanje)</h2><div class="grid">')
for i, e in enumerate(T2, 1):
    A(f'<div class="box"><b>{i}. <code>{e["vid"]}</code> · {esc(e["channel"])}</b> · audio {dur(e["audio"]) if e["audio"] else "–"} · {esc(e["state"])}<br><span class="small">{esc(e["title"][:110])}</span>')
    A(f'<div class="small">poslano {hm(e["created"])} · preuzeto {hm(e["claimed"])} · pipeline {hm(e["start"])}–{hm(e["end"])} · gotovo {hm(e["done"]) if e["done"] else "–"}'
      + (f' · Mag HR {hm(MHR[e["vid"]]["start"])}–{hm(MHR[e["vid"]]["end"])}' if e["vid"] in MHR else '') + '</div>')
    big = [s for s in e['steps'] if s['d'] >= 3]
    A('<table><tr>' + ''.join(f'<th>{s["k"]}</th>' for s in big) + '</tr><tr>' + ''.join(f'<td>{hm(s["start"])}</td>' for s in big) + '</tr><tr>' + ''.join(f'<td><b>{dur(s["d"])}</b></td>' for s in big) + '</tr></table>')
    if e['err']: A(f'<div class="small">❌ {esc(e["err"][:140])}</div>')
    if e['pyannote402']: A('<div class="small">⚠️ pyannoteAI HTTP 402 → govornici iz Speechmaticsa</div>')
    A('</div>')
A('</div><div class="small">Prikazani su koraci od 3 s naviše; kraći (0, 2.5, 9.4, 9.5, 9.7, 9.85, 12.6, 12.68, 12.8, 13) su zbrojeni u fazama u tablici gore. Prvi redak = korak, drugi = početak, treći = trajanje.</div>')
A('</body></html>')
open(S + '/report.html', 'w').write(''.join(H))
print('ok', len(T2), len(ok), st.median(proc) / 60, [round(t) for t in tot], n402)

# ---------- Markdown za docs/ ----------
M = []
W = M.append
W("# Nightly report 04.11.2026.: vrijeme po koraku za svaku epizodu\n")
W(f"Stanje u {D.datetime.now().strftime('%H:%M')} (CET). Izvori: `automatic/logs/nightly_2026-11-04.log`, `priority_2026-11-04.log`, `magisterium_2026-11-04.log`, `magisterium-en_2026-11-04.log`, API `pipeline.domovina.ai/api/jobs` i `cdn.domovina.ai/data/<id>/episode.json`. Trajanje koraka je razmak između dva uzastopna zapisa „📢 KORAK” u logu. Grafovi su u PDF-u: `docs/2026-11-04-nightly-report-vremena-po-koraku.pdf`.\n")
W("## Sažetak\n")
W(f"""- **23 nove epizode, 22 s člankom.** 4 iz nightlyja (praćeni kanali, 03:00–03:58) i 18 iz prioritetnog reda (Tier 2). Pao je 1 posao: `KyMHBGFS5Gc` (PSIHOLOGiJA HRT). Download ne prolazi, a isti video pao je i 03.11.
- **Sve je gotovo.** Svih 18 Tier 2 epizoda na CDN-u ima članak, EN članak, Magisterium HR i Magisterium EN. Nightly: sve 4 imaju HR i EN članak; Magisterium samo Ora et Labora (ostali kanali ga nemaju u planu). Zadnji posao završio je u {hm(last_all)}.
- **Prioritetni slot:** prvi posao preuzet u {hm(first_claim)}, zadnji gotov u {hm(last_done)}. Obrađeno je {audio_ok/3600:.1f} h zvuka. Obrada po epizodi traje medijan {st.median(proc)/60:.0f} min ({min(proc)/60:.0f}–{max(proc)/60:.0f} min). Čekanje u redu: medijan {st.median(waits)/60:.0f} min, najdulje {max(waits)/60:.0f} min.
- **Kamo ide vrijeme** (zbroj {len(ok)} Tier 2 epizoda, {sum(tot):.0f} min): {', '.join(f'{PH[p][0]} {tot[p]:.0f} min ({100*tot[p]/sum(tot):.0f} %)' for p in order[::-1][:5])}.
- **Magisterium HR:** {len(MHR)} epizoda, medijan {st.median(mhr_d)/60:.0f} min po epizodi, jedna po tick (10 min). Zadnja HR obrada završila je u {hm(max(d['end'] for d in MHR.values()))}. **EN prijevod:** {len(en_d)} epizoda, medijan {st.median(en_d)/60:.1f} min.
- **Magisterium EN je kasnio za {n_late} epizoda.** EN tick je preveo članak prije nego što je HR Magisterium stigao. Zakašnjeli Magisterium EN dodao je `c2af6ac7` (`EN_MAG_LATE_SINCE`, 3 po ticku) između 10:14 i 11:11.
- **⚠️ pyannoteAI je bez kredita od 05:51** (HTTP 402 „Insufficient credits and no active subscription”). {n402} od {len(ok)} Tier 2 epizoda ima govornike iz Speechmaticsove dijarizacije. Korak je non-fatal, pa se to ne javlja kao greška. Nightly 05.11. udarit će u isto.
- **Cijeli dan radio je samo jedan slot:** 184 zapisa „slot 2+: disk 12–14 GB < 25 GB”.
- **Modal Canary (2.6)** vrti se kao osigurač na svakoj Tier 2 epizodi iako je ASR Speechmatics: {tot[2]:.0f} min ukupno.
- Rupa od 12 min iza `-kSZAvMDzC8` (08:15 → 08:27): `reconcile` je zapeo na mreži (`fetch failed`, `PATCH … EPIPE`).
- Nightly: `audit_pipeline.js` exit 1 (rupe disk ↔ CDN), kao i 03.11.
""")
W("## Tier 2: trajanje faza po epizodi (min:s)\n")
hdr = ['#', 'video', 'kanal', 'audio', 'poslano', 'preuzeto', 'čekanje'] + [n.split(' (')[0] for n, _, _ in PH] + ['start', 'zatv.', 'gotovo', 'obrada', 'govornici']
W('| ' + ' | '.join(hdr) + ' |'); W('|' + '---|' * len(hdr))
for i, e in enumerate(T2, 1):
    c = [str(i), f"`{e['vid']}`", e['channel'][:24].replace('|', '/'), dur(e['audio']) if e['audio'] else '–', hm(e['created']), hm(e['claimed']), dur(e['claimed'] - e['created'])]
    c += [dur(v) if v else '·' for v in e['phase']]
    c += [dur(e['pre']), dur(e['post']), hm(e['done']) if e['done'] else '❌', dur(sum(e['phase'])) if e['state'] == 'done' else '–', ('Speechmatics (pyannoteAI 402)' if e['pyannote402'] else 'pyannoteAI') if e['state'] == 'done' else '–']
    W('| ' + ' | '.join(c) + ' |')
W("\n## Magisterium HR, EN prijevod i Magisterium EN\n")
W('| # | video | kanal | članak gotov | EN tick | EN | Mag HR tick | Mag HR | poziva | čekanje HR | Mag EN | sve gotovo |'); W('|' + '---|' * 12)
for i, (v, ch, done) in enumerate(allrows, 1):
    en = MEN.get(v, {}); hr = MHR.get(v); m = en.get('main'); mg = en.get('mag')
    mgt = f"{hm(mg[0])} (kasni, {dur(mg[2])})" if mg else ('s EN tickom' if hr else '–')
    ends = [done] + ([hr['end']] if hr else []) + [x[3] for x in en.get('items', [])]
    W(f"| {i} | `{v}` | {ch[:24].replace('|','/')} | {hm(done)}{' (nightly)' if i<=4 else ''} | {(hm(m[0])+'–'+hm(m[1])) if m else '–'} | {dur(m[1]-m[0]) if m else '–'} | {(hm(hr['start'])+'–'+hm(hr['end'])) if hr else 'nije u planu'} | {dur(hr['end']-hr['start']) if hr else '–'} | {hr['calls'] if hr else '–'} | {dur(hr['start']-done) if hr else '–'} | {mgt} | {hm(max(ends))} |")
W("\n## Nightly: skupni koraci (sve 4 epizode zajedno)\n")
W('| KORAK | opis | početak | trajanje |'); W('|---|---|---|---|')
for s in NS: W(f"| {s['k']} | {s['name'][:58].replace('|','/')} | {hm(s['start'])} | {dur(s['d'])} |")
W(f"| | **ukupno run_pipeline.sh** | {hm(NS[0]['start'])} | **{dur(NIGHT_END-NS[0]['start'])}** |\n")
W('| video | kanal | audio | Soniox | sažetak | članak | reels | EN | Mag HR |'); W('|---|---|---|---|---|---|---|---|---|')
for n in NIGHT:
    en = MEN.get(n['vid'], {}).get('main'); hr = MHR.get(n['vid'])
    W(f"| `{n['vid']}` | {n['channel']} | {dur(n['audio'])} | {dur(n['soniox'])} | {dur(n['summ'])} | {dur(n['art'])} | {dur(n['reels']) if n['reels'] else '–'} | {dur(en[1]-en[0]) if en else '–'} | {dur(hr['end']-hr['start']) if hr else '–'} |")
W("\n## Prilog: svaki korak svake Tier 2 epizode\n")
for i, e in enumerate(T2, 1):
    W(f"**{i}. `{e['vid']}` · {e['channel']}** · audio {dur(e['audio']) if e['audio'] else '–'} · {e['state']} · {e['title'][:100]}\n")
    big = [s for s in e['steps'] if s['d'] >= 3]
    if big:
        W('| ' + ' | '.join(s['k'] for s in big) + ' |'); W('|' + '---|' * len(big))
        W('| ' + ' | '.join(hm(s['start']) for s in big) + ' |'); W('| ' + ' | '.join(dur(s['d']) for s in big) + ' |')
    if e['err']: W(f"\n❌ {e['err'][:140]}")
    W('')
W("Prikazani su koraci od 3 s naviše; kraći su zbrojeni u fazama u tablici gore.\n")
open(S + '/report.md', 'w').write('\n'.join(M))
