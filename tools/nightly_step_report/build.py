import json, re, sys, datetime as D, html, io, base64
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

S = sys.argv[1]
DAY = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else None
if not DAY: sys.exit('upotreba: build.py <W> days/<YYYY-MM-DD>.json')
DATE = DAY['date']; DHR = '.'.join(DATE.split('-')[::-1]) + '.'
IGN = set(DAY.get('ignore_vids', []))
runs = [r for r in json.load(open(S + '/runs.json')) if r.get('start') and r.get('end')]  # posao koji još traje nema Kraj
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
             asr=j.get('asr_provider'), notes=r['notes'], tier='T2', slot=r.get('slot', 1))
    e['pre'] = e['start'] - e['claimed'] if e['claimed'] else 0
    e['post'] = (e['done'] - e['end']) if e['done'] else None
    e['pyannote402'] = any('HTTP 402' in n for n in r['notes'])
    T2.append(e)

# ---------- Magisterium HR / EN po epizodi ----------
MHR, MEN = {}, {}
for t in mag['hr']:
    for v in t['vids']:
        if v in IGN: continue
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
NIGHT_END = ts(DAY['night_end'])
NS = []
for i, (k, a, name) in enumerate(NIGHT_STEPS):
    b = NIGHT_STEPS[i + 1][1] if i + 1 < len(NIGHT_STEPS) else NIGHT_END
    NS.append(dict(k=k, name=name, start=a, end=b, d=b - a))
NIGHT = DAY['night']
# Magisterium/EN samo za epizode ovog dana (tickovi znaju dirati i starije epizode)
DAYV = {e['vid'] for e in T2} | {n['vid'] for n in NIGHT}
MHR = {k: v for k, v in MHR.items() if k in DAYV}
MEN = {k: v for k, v in MEN.items() if k in DAYV}

def fig_b64(fig):
    b = io.BytesIO(); fig.savefig(b, format='png', dpi=170, bbox_inches='tight'); plt.close(fig)
    return 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode()

plt.rcParams.update({'font.family': 'Helvetica', 'font.size': 8})
def xfmt(ax, lo, hi, step=1800):
    t0 = lo - lo % step
    ticks = list(range(t0, hi + step, step))
    ax.set_xticks(ticks); ax.set_xticklabels([hm(t)[:5] for t in ticks]); ax.set_xlim(lo, hi)
    ax.grid(axis='x', color='#ddd', lw=0.5); ax.set_axisbelow(True)

# osi: iz day.json ako ih ima, inače od nightlyja do zadnjeg kraja bilo koje trake
if 'x1' not in DAY:
    lo = min([s['start'] for s in NS] + [e['claimed'] for e in T2]) - 300
    hi = max([NIGHT_END] + [e['done'] or e['end'] for e in T2] + [d['end'] for d in MHR.values()]
             + [x[3] for v in MEN.values() for x in v['items']]) + 600
    DAY['x1'] = [hm(lo - lo % 1800), hm(hi - hi % 1800 + 1800)]
if 'x2' not in DAY and T2:
    lo = min(e['claimed'] for e in T2) - 600; hi = max([e['done'] or e['end'] for e in T2] + [d['end'] for d in MHR.values()]) + 600
    DAY['x2'] = [hm(lo - lo % 900), hm(hi - hi % 900 + 900)]
# ---------- Graf 1: dan po trakama ----------
SLOTS = sorted({e['slot'] for e in T2})
lanes = ['Nightly (praćeni)'] + [f'Slot {k} (Tier 2)' for k in SLOTS] + ['Magisterium HR', 'EN prijevod + Mag. EN']
fig, ax = plt.subplots(figsize=(11, 0.9 * len(lanes)))
y = {n: i for i, n in enumerate(lanes[::-1])}
for s in NS:
    ax.barh(y[lanes[0]], s['d'], left=s['start'], color=PH[STEP2PH.get(s['k'], 14)][2], edgecolor='white', lw=0.3, height=0.6)
for e in T2:
    yy = y[f"Slot {e['slot']} (Tier 2)"]
    ax.barh(yy, e['end'] - e['start'], left=e['start'], color='#E45756' if e['state'] == 'failed' else '#4C78A8', edgecolor='white', lw=0.6, height=0.6)
    ax.text(e['start'] + (e['end'] - e['start']) / 2, yy, e['vid'][:4], ha='center', va='center', fontsize=5, color='white')
for v, d in MHR.items():
    ax.barh(y['Magisterium HR'], d['end'] - d['start'], left=d['start'], color='#B279A2', edgecolor='white', lw=0.6, height=0.6)
for t in mag['en']:
    if t['items']:
        ax.barh(y['EN prijevod + Mag. EN'], ts(t['end']) - ts(t['start']), left=ts(t['start']), color='#F58518', edgecolor='white', lw=0.6, height=0.6)
mk = DAY.get('marker')
if mk:
    ax.axvline(ts(mk['t']), color='k', ls=':', lw=0.8); ax.text(ts(mk['t']) + 60, len(lanes) - 0.58, mk['label'], fontsize=7)
ax.set_yticks(range(len(lanes))); ax.set_yticklabels(lanes[::-1])
xfmt(ax, ts(DAY['x1'][0]), ts(DAY['x1'][1]))
ax.set_title(f'{DHR} – rad po trakama (CET)', loc='left', fontsize=10)
G1 = fig_b64(fig)

ok = [e for e in T2 if e['state'] == 'done']
# Dan bez ijednog gotovog Tier 2 posla (npr. 06.11.2026., ograda tjedne kvote): grafovi 2–4 nemaju što crtati.
G2 = G3 = G4 = None
if ok:
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
        lab = f"s{e['slot']} · {e['channel'][:22]} · {e['vid']}"
        ax.text(e['claimed'] - 90, yy, lab, ha='right', va='center', fontsize=6.5)
    ax.set_yticks([])
    xfmt(ax, ts(DAY['x2'][0]), ts(DAY['x2'][1]))
    handles = [Patch(color=c, label=n) for n, _, c in PH] + [Patch(color=PRE_C, label='start slota'), Patch(color=POST_C, label='zatvaranje (reconcile)'), Patch(color='#B279A2', label='Magisterium HR (tanka traka)')]
    ax.legend(handles=handles, ncol=6, fontsize=6, loc='upper center', bbox_to_anchor=(0.5, -0.06), frameon=False)
    ax.set_title('Tier 2: svaka epizoda od preuzimanja posla do kraja, obojeno po koraku', loc='left', fontsize=10)
    G2 = fig_b64(fig)

    # ---------- Graf 3: trajanje po fazi (min), stacked, po epizodi ----------
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
import statistics as st
first_claim = min((e['claimed'] for e in T2), default=0); last_done = max((e['done'] for e in T2 if e['done']), default=first_claim)
audio_ok = sum(e['audio'] or 0 for e in ok)
proc = [sum(e['phase']) for e in ok]
waits = [e['claimed'] - e['created'] for e in T2]
mhr_d = [MHR[v]['end'] - MHR[v]['start'] for v in MHR]
en_d = [MEN[v]['main'][1] - MEN[v]['main'][0] for v in MEN if MEN[v]['main']]
n402 = sum(1 for e in ok if e['pyannote402'])
n_late = sum(1 for v in MEN.values() if v['mag'])
last_all = max([d['end'] for d in MHR.values()] + [x[3] for v in MEN.values() for x in v['items']], default=0)
# Magisterium/EN poslovi koji još čekaju u redu (stanje iz API-ja u trenutku dumpa)
MQ = {}
for m in json.load(open(S + '/jobs.json')).get('mags', []):
    if m['state'] in ('queued', 'claimed', 'running') and m['youtube_id'] not in IGN:
        MQ.setdefault(m['youtube_id'], set()).add(m['lang'])
# preklapanje slotova i prazan hod slota 2 dok red nije prazan
busy = {k: sorted((e['claimed'], e['done'] or e['end']) for e in T2 if e['slot'] == k) for k in SLOTS}
def overlap(a, b):
    tot = 0
    for x0, x1 in a:
        for y0, y1 in b: tot += max(0, min(x1, y1) - max(x0, y0))
    return tot
both = overlap(busy[SLOTS[0]], busy[SLOTS[1]]) if len(SLOTS) > 1 else 0
last_claim = max((e['claimed'] for e in T2), default=0)
s2_idle = 0
if len(SLOTS) > 1:
    iv = busy[SLOTS[1]]
    for (a0, a1), (b0, b1) in zip(iv, iv[1:]):
        s2_idle += max(0, min(b0, last_claim) - a1)
mhr_q = [v for v, l in MQ.items() if 'hr' in l]
mhr_per = st.median(mhr_d) if mhr_d else 0
mst = sorted(d['start'] for d in MHR.values())
mhr_cad = (mst[-1] - mst[0]) / (len(mst) - 1) if len(mst) > 1 else 16 * 60
eta = len(mhr_q) * mhr_cad
now_s = D.datetime.now().hour * 3600 + D.datetime.now().minute * 60
tot_ = [sum(e['phase'][p] for e in ok) / 60 for p in range(len(PH))]
order_ = sorted(range(len(PH)), key=lambda p: tot_[p])
V = dict(night_end=DAY['night_end'][:5], nightly_done=DAY.get('nightly_done', '')[:5],
         n_s1=sum(1 for e in T2 if e['slot'] == 1), n_s2=sum(1 for e in T2 if e['slot'] == 2),
         first_claim=hm(first_claim)[:5], last_done=hm(last_done)[:5], span_h=f"{(last_done-first_claim)/3600:.1f}".replace('.', ','),
         both_h=f"{both/3600:.1f}".replace('.', ','), s2_idle=round(s2_idle / 60),
         proc_med=round(st.median(proc) / 60) if proc else 0, proc_min=round(min(proc, default=0) / 60), proc_max=round(max(proc, default=0) / 60),
         audio_h=f"{audio_ok/3600:.1f}".replace('.', ','), wait_med=round(st.median(waits) / 60) if waits else 0, wait_max=round(max(waits, default=0) / 60),
         top_phases=', '.join(f'{PH[p][0]} {tot_[p]:.0f} min ({100*tot_[p]/max(sum(tot_), 1e-9):.0f} %)' for p in order_[::-1][:5]),
         n_mhr=len(MHR), mhr_cad=round(mhr_cad / 60), mhr_med=round(mhr_per / 60), mhr_last=hm(max(d['end'] for d in MHR.values()))[:5] if MHR else '–',
         n_mhr_q=len(mhr_q), mhr_q_list=', '.join(f'`{v}`' for v in mhr_q),
         mhr_eta=f"{eta/3600:.1f}".replace('.', ','), mhr_eta_t=hm(now_s + eta)[:5],
         canary_min=round(tot_[2]), canary_per=f"{tot_[2]/max(1,len(ok)):.1f}".replace('.', ','))
def auto_summary():
    """Nalazi kad dan nema ručno pisan sažetak (auto.py): samo činjenice iz logova, API-ja i CDN-a."""
    A_ = DAY.get('auto', {}); cdn = A_.get('cdn', {}); out = []
    n_n, n_t = len(NIGHT), len(T2)
    n_art = sum(1 for c in cdn.values() if c.get('art'))
    failed = A_.get('failed', [])
    out.append(f"**{n_n + n_t} novih epizoda, {n_art} s člankom na CDN-u, {len(failed)} palih poslova.** {n_n} iz nightlyja (praćeni kanali, run_pipeline 03:00–{V['night_end']}, cijeli nightly gotov {V['nightly_done']}: {A_.get('night_status', '?')}) i {n_t} iz prioritetnog reda (Tier 2)."
               + (' Pali: ' + '; '.join(f'`{x}`' for x in failed) + '.' if failed else ''))
    if len(SLOTS) > 1:
        out.append(f"**Slotovi:** " + ', '.join(f"slot {k} {sum(1 for e in T2 if e['slot'] == k)} ep." for k in SLOTS)
                   + f" Prvi posao preuzet u {V['first_claim']}, zadnji gotov u {V['last_done']} ({V['span_h']} h, {V['audio_h']} h zvuka). Oba slota istodobno {V['both_h']} h; slot 2 prazan {V['s2_idle']} min dok je red imao posla.")
    elif T2:
        out.append(f"**Samo jedan slot.** Prvi posao preuzet u {V['first_claim']}, zadnji gotov u {V['last_done']} ({V['span_h']} h, {V['audio_h']} h zvuka).")
    if A_.get('ssd_blocks'):
        out.append(f"**Ograda diska:** {A_['ssd_blocks']}× „nema slobodnog slota” zbog SSD-a (prvi {A_['ssd_first']}, zadnji {A_['ssd_last']}).")
    if T2:
        out.append(f"**Obrada po epizodi** (zbroj koraka) medijan **{V['proc_med']} min**, raspon {V['proc_min']}–{V['proc_max']} min. Čekanje u redu: medijan {V['wait_med']} min, najdulje {V['wait_max']} min.")
        out.append(f"**Kamo ide vrijeme** (zbroj Tier 2): {V['top_phases']}.")
    if V['n_mhr_q']:
        out.append(f"**⚠️ Magisterium HR još nije gotov:** {V['n_mhr']} gotovo (medijan {V['mhr_med']} min), u redu još {V['n_mhr_q']} ({V['mhr_q_list']}), procjena oko {V['mhr_eta_t']}.")
    elif MHR:
        out.append(f"**Magisterium HR:** {V['n_mhr']} epizoda, medijan {V['mhr_med']} min, zadnja gotova u {V['mhr_last']}.")
    n_en = sum(1 for c in cdn.values() if c.get('en')); n_mhr = sum(1 for c in cdn.values() if c.get('mhr')); n_men = sum(1 for c in cdn.values() if c.get('men'))
    if cdn:
        out.append(f"**CDN:** EN članak {n_en}/{len(cdn)}, Magisterium HR {n_mhr}, Magisterium EN {n_men}/{n_mhr}.")
    if A_.get('missing') or A_.get('pending_mags') or A_.get('pending_jobs'):
        out.append("**⚠️ Nije sve gotovo u trenutku slanja:** " + '; '.join(f'`{x}`' for x in (A_.get('pending_jobs', []) + A_.get('pending_mags', []) + A_.get('missing', []))[:20]) + '.')
    if A_.get('ny402') or n402:
        out.append(f"**⚠️ pyannoteAI HTTP 402:** nightly {A_.get('ny402', 0)}×, Tier 2 {n402} epizoda. Govornici su tada iz Sonioxa/Speechmaticsa.")
    if A_.get('proxy_down'):
        out.append(f"YouTube proxy (iPhone) nije odgovarao {A_['proxy_down']}× u prioritetnom logu; download je išao bez njega.")
    if T2:
        out.append(f"Modal Canary (2.6) kao osigurač: {V['canary_min']} min ukupno, oko {V['canary_per']} min po epizodi.")
    return out
SUMMARY = [b.format(**V) for b in DAY['summary']] if DAY.get('summary') else auto_summary()
def md2html(t):
    t = esc(t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    return re.sub(r'`(.+?)`', r'<code>\1</code>', t)

# ---------- Mermaid gantogram ----------
def gname(t): return re.sub(r'[:#;,]', ' ', t).strip()
G = ['gantt', f'    title {DHR} – rad po trakama (CET)', '    dateFormat HH:mm:ss', '    axisFormat %H:%M', '    tickInterval 30minute', '    todayMarker off']
G.append('    section Nightly')
for sx in NS:
    if sx['d'] >= 60: G.append(f"    {gname('K' + sx['k'] + ' ' + sx['name'][:28])} :{hm(sx['start'])}, {hm(sx['end'])}")
for k in SLOTS:
    G.append(f'    section Slot {k}')
    for e in T2:
        if e['slot'] == k: G.append(f"    {gname(e['vid'] + ' ' + e['channel'][:16])} :{'crit, ' if e['state']=='failed' else ''}{hm(e['start'])}, {hm(e['end'])}")
G.append('    section Magisterium HR')
for v, d in sorted(MHR.items(), key=lambda x: x[1]['start']): G.append(f"    {gname(v)} :{hm(d['start'])}, {hm(d['end'])}")
# EN traka nije u gantogramu (40+ redaka bi ga stisnulo); vidi graf 1 i tablicu Magisterium/EN.
GANTT = '\n'.join(G)

# ---------- HTML ----------
H = []
T2_HTML = (f'''<img src="{G2}">
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
</ul></div></div>''' if ok else '<p class="small">Tier 2 danas nije obradio nijednu epizodu, pa grafova po epizodi nema.</p>')
A = H.append
A(f"""<!doctype html><html lang="hr"><head><meta charset="utf-8"><title>Nightly {DHR} – vremena po koraku</title>
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
pre.mermaid {{ margin:0; text-align:center; }} pre.mermaid svg {{ max-width:100% !important; max-height:172mm; width:auto; height:auto; }}
</style><script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script><script>mermaid.initialize({{startOnLoad:true, theme:'neutral', gantt:{{useWidth:2600, barHeight:18, barGap:4, fontSize:14, sectionFontSize:16, leftPadding:170}}}});</script></head><body>
<h1>Nightly {DHR} – vrijeme po koraku za svaku epizodu</h1>
<div class="meta">Stanje u {D.datetime.now().strftime('%H:%M')} (CET). Izvori: <code>automatic/logs/nightly_{DATE}.log</code>, <code>priority_{DATE}.log</code>, <code>magisterium_{DATE}.log</code>, <code>magisterium-en_{DATE}.log</code>, API <code>pipeline.domovina.ai/api/jobs</code> i <code>cdn.domovina.ai/data/&lt;id&gt;/episode.json</code>. Trajanje koraka = razmak između dva uzastopna „📢 KORAK” zapisa u logu.</div>
<h2>Sažetak</h2>
<ul>
{''.join('<li>' + md2html(x) + '</li>' for x in SUMMARY)}
</ul>
<img src="{G1}">
<div class="pb"></div><h2>Gantogram (Mermaid)</h2><pre class="mermaid">{esc(GANTT)}</pre>
<div class="pb"></div>
{T2_HTML}
""")

# ---------- Tablica 1: Tier 2 matrica faza ----------
A('<div class="pb"></div><h2>Tier 2 – trajanje svakog koraka po epizodi (min:s)</h2>')
A('<table><tr><th class="l">#</th><th>slot</th><th class="l">video</th><th class="l">kanal</th><th>audio</th><th>poslano</th><th>preuzeto</th><th>čekanje</th>')
for n, _, _ in PH: A(f'<th>{esc(n.split(" (")[0])}</th>')
A('<th>start</th><th>zatv.</th><th>gotovo</th><th>obrada</th><th>ASR</th></tr>')
for i, e in enumerate(T2, 1):
    cls = 'fail' if e['state'] == 'failed' else ('warn' if e['pyannote402'] else '')
    A(f'<tr class="{cls}"><td class="l">{i}</td><td>s{e["slot"]}</td><td class="l"><code>{e["vid"]}</code></td><td class="l">{esc(e["channel"][:24])}</td><td>{dur(e["audio"]) if e["audio"] else "–"}</td>')
    A(f'<td>{hm(e["created"])}</td><td>{hm(e["claimed"])}</td><td>{dur(e["claimed"]-e["created"])}</td>')
    for p in range(len(PH)):
        v = e['phase'][p]; w = ' class="w"' if (p == 4 and e['pyannote402']) else ''
        A(f'<td{w}>{dur(v) if v else "·"}</td>')
    A(f'<td>{dur(e["pre"])}</td><td>{dur(e["post"])}</td><td>{hm(e["done"]) if e["done"] else "❌"}</td><td><b>{dur(sum(e["phase"])) if e["state"]=="done" else "–"}</b></td><td class="l">{esc(e["asr"] or "–")}{" +SM govornici" if e["pyannote402"] else ""}</td></tr>')
A('</table><div class="small">Žuto = pyannoteAI vratio HTTP 402 (nema kredita); govornici su iz Speechmaticsa. Crveno = posao pao.</div>')

# ---------- Tablica 2: Magisterium + EN ----------
A('<h2>Magisterium HR, EN prijevod i Magisterium EN po epizodi</h2>')
A('<table><tr><th class="l">#</th><th class="l">video</th><th class="l">kanal</th><th>članak gotov</th><th>EN tick</th><th>EN trajanje</th><th>Mag HR tick</th><th>Mag HR traj.</th><th>poziva</th><th>čekanje HR od članka</th><th>Mag EN</th><th>Mag EN traj.</th><th>sve gotovo</th></tr>')
allrows = [(n['vid'], n['channel'], NIGHT_END) for n in NIGHT] + [(e['vid'], e['channel'], e['done']) for e in T2 if e['state'] == 'done']
for i, (v, ch, done) in enumerate(allrows, 1):
    en = MEN.get(v, {}); hr = MHR.get(v)
    m = en.get('main'); mg = en.get('mag')
    mg_txt, mg_d = ('–', '–')
    if mg: mg_txt, mg_d = f'{hm(mg[0])}–{hm(mg[1])[3:]} (kasni)', dur(mg[2])
    elif hr and any(x[0] == 'magisterium' for x in en.get('items', [])):
        x = [x for x in en['items'] if x[0] == 'magisterium'][0]; mg_txt, mg_d = f'{hm(x[2])}–{hm(x[3])[3:]} (s EN)', dur(x[1])
    ends = [done] + ([hr['end']] if hr else []) + [x[3] for x in en.get('items', [])]
    A(f'<tr><td class="l">{i}</td><td class="l"><code>{v}</code></td><td class="l">{esc(ch[:24])}</td><td>{hm(done)}{" (nightly)" if i<=len(NIGHT) else ""}</td>'
      f'<td>{(hm(m[0])+"–"+hm(m[1])[3:]) if m else "–"}</td><td>{dur(m[1]-m[0]) if m else "–"}</td>'
      f'<td>{(hm(hr["start"])+"–"+hm(hr["end"])[3:]) if hr else ("⏳ u redu" if "hr" in MQ.get(v, ()) else "nije u planu")}</td><td>{dur(hr["end"]-hr["start"]) if hr else "–"}</td><td>{hr["calls"] if hr else "–"}</td>'
      f'<td>{dur(hr["start"]-done) if hr else "–"}</td><td>{mg_txt if hr else "–"}</td><td>{mg_d if hr else "–"}</td><td><b>{hm(max(ends))}</b></td></tr>')
A('</table><div class="small">EN tick prevodi sažetak, članak i reels jednim agy pozivom po dokumentu. „Mag EN (kasni)” = Magisterium EN preveden naknadno, kad je HR Magisterium stigao poslije EN članka. Mag HR = <code>tools/magisterium_mcp_episode.js</code>, 2 sekcije po MCP pozivu.</div>')

# ---------- Nightly ----------
A('<div class="pb"></div><h2>Nightly (praćeni kanali) – koraci su skupni za sve epizode</h2>')
A('<div class="grid"><div><table><tr><th class="l">KORAK</th><th class="l">opis</th><th>početak</th><th>trajanje</th></tr>')
for s in NS:
    A(f'<tr><td class="l">{s["k"]}</td><td class="l">{esc(s["name"][:58])}</td><td>{hm(s["start"])}</td><td>{dur(s["d"])}</td></tr>')
A(f'<tr><td class="l"></td><td class="l"><b>ukupno run_pipeline.sh</b></td><td>{hm(NS[0]["start"])}</td><td><b>{dur(NIGHT_END-NS[0]["start"])}</b></td></tr></table>'
  '<div class="small">Iza toga nightly vrti audit, watchlist, enqueue Tier 2 i katalog.</div></div><div>')
A('<h3>Po epizodi (gdje log daje vrijeme po epizodi)</h3><table><tr><th class="l">video</th><th class="l">kanal</th><th>audio</th><th>Soniox</th><th>sažetak</th><th>članak</th><th>reels</th><th>EN</th><th>Mag HR</th></tr>')
for n in NIGHT:
    en = MEN.get(n['vid'], {}).get('main'); hr = MHR.get(n['vid'])
    A(f'<tr><td class="l"><code>{n["vid"]}</code></td><td class="l">{esc(n["channel"])}</td><td>{dur(n["audio"])}</td><td>{dur(n["soniox"])}</td><td>{dur(n["summ"])}</td><td>{dur(n["art"])}</td><td>{dur(n["reels"]) if n["reels"] else "–"}</td><td>{dur(en[1]-en[0]) if en else "–"}</td><td>{dur(hr["end"]-hr["start"]) if hr else "–"}</td></tr>')
A('</table><div class="small">' + md2html(DAY.get('night_note', '')) + '</div>')
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
print('ok', len(T2), len(ok), st.median(proc) / 60 if proc else 0, [round(t) for t in tot_], n402)

# ---------- Markdown za docs/ ----------
M = []
W = M.append
W(f"# Nightly report {DHR}: vrijeme po koraku za svaku epizodu\n")
W(f"Stanje u {D.datetime.now().strftime('%H:%M')} (CET). Izvori: `automatic/logs/nightly_{DATE}.log`, `priority_{DATE}.log`, `magisterium_{DATE}.log`, `magisterium-en_{DATE}.log`, API `pipeline.domovina.ai/api/jobs` i `cdn.domovina.ai/data/<id>/episode.json`. Trajanje koraka je razmak između dva uzastopna zapisa „📢 KORAK” u logu. Grafovi su u PDF-u: `docs/{DATE}-nightly-report-vremena-po-koraku.pdf`.\n")
W("## Sažetak\n")
for x in SUMMARY: W('- ' + x)
W("\n## Gantogram\n")
W("```mermaid\n" + GANTT + "\n```\n")
W("## Tier 2: trajanje faza po epizodi (min:s)\n")
hdr = ['#', 'slot', 'video', 'kanal', 'audio', 'poslano', 'preuzeto', 'čekanje'] + [n.split(' (')[0] for n, _, _ in PH] + ['start', 'zatv.', 'gotovo', 'obrada', 'govornici']
W('| ' + ' | '.join(hdr) + ' |'); W('|' + '---|' * len(hdr))
for i, e in enumerate(T2, 1):
    c = [str(i), f"s{e['slot']}", f"`{e['vid']}`", e['channel'][:24].replace('|', '/'), dur(e['audio']) if e['audio'] else '–', hm(e['created']), hm(e['claimed']), dur(e['claimed'] - e['created'])]
    c += [dur(v) if v else '·' for v in e['phase']]
    c += [dur(e['pre']), dur(e['post']), hm(e['done']) if e['done'] else '❌', dur(sum(e['phase'])) if e['state'] == 'done' else '–', (e['asr'] or '–') + (' (pyannoteAI 402)' if e['pyannote402'] else '') if e['state'] == 'done' else '–']
    W('| ' + ' | '.join(c) + ' |')
W("\n## Magisterium HR, EN prijevod i Magisterium EN\n")
W('| # | video | kanal | članak gotov | EN tick | EN | Mag HR tick | Mag HR | poziva | čekanje HR | Mag EN | sve gotovo |'); W('|' + '---|' * 12)
for i, (v, ch, done) in enumerate(allrows, 1):
    en = MEN.get(v, {}); hr = MHR.get(v); m = en.get('main'); mg = en.get('mag')
    mgt = f"{hm(mg[0])} (kasni, {dur(mg[2])})" if mg else ('s EN tickom' if hr else '–')
    ends = [done] + ([hr['end']] if hr else []) + [x[3] for x in en.get('items', [])]
    W(f"| {i} | `{v}` | {ch[:24].replace('|','/')} | {hm(done)}{' (nightly)' if i<=len(NIGHT) else ''} | {(hm(m[0])+'–'+hm(m[1])) if m else '–'} | {dur(m[1]-m[0]) if m else '–'} | {(hm(hr['start'])+'–'+hm(hr['end'])) if hr else ('⏳ u redu' if 'hr' in MQ.get(v, ()) else 'nije u planu')} | {dur(hr['end']-hr['start']) if hr else '–'} | {hr['calls'] if hr else '–'} | {dur(hr['start']-done) if hr else '–'} | {mgt} | {hm(max(ends))} |")
W("\n## Nightly: skupni koraci (sve epizode zajedno)\n")
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

# ---------- potpis uz PDF u Telegramu (HTML, max 1024 znaka) ----------
def tg(t):
    t = esc(t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    return re.sub(r'`(.+?)`', r'<code>\1</code>', t)
cap = f'🌙 <b>Nightly {DHR}</b> – vrijeme po koraku\n'
for x in SUMMARY:
    line = '• ' + tg(x) + '\n'
    if len(cap) + len(line) > 990: break
    cap += line
open(S + '/caption.html', 'w').write(cap.strip())

# ---------- Mobitel: 4 uspravne slike (album u Telegramu) ----------
# A4 landscape PDF je na mobitelu nečitljiv, a Telegram Desktop PDF ni ne prikazuje. Slike
# 1080 px širine (6 in × 180 dpi) s velikim fontom čitaju se svugdje.
plt.rcParams.update({'font.size': 11, 'font.family': ['Helvetica', 'DejaVu Sans']})
MW, DPI = 6, 180
def save(fig, name):
    fig.savefig(S + '/' + name, dpi=DPI, bbox_inches='tight', facecolor='white'); plt.close(fig)
# 1) okomiti gantogram: trake su stupci, vrijeme teče prema dolje
lanes_m = ['Nightly'] + [f'Slot {k}' for k in SLOTS] + ['Mag HR', 'EN']
fig, ax = plt.subplots(figsize=(MW, 10.5))
X = {n: i for i, n in enumerate(lanes_m)}
def vbar(lane, a, b, c, txt=None):
    ax.bar(X[lane], b - a, bottom=a, width=0.78, color=c, edgecolor='white', lw=0.6)
    if txt and b - a > 420: ax.text(X[lane], (a + b) / 2, txt, ha='center', va='center', fontsize=7.5, color='white', rotation=0)
for sx in NS: vbar('Nightly', sx['start'], sx['end'], PH[STEP2PH.get(sx['k'], 14)][2])
for e in T2: vbar(f"Slot {e['slot']}", e['start'], e['end'], '#E45756' if e['state'] == 'failed' else '#4C78A8', e['vid'][:5])
for v, d in MHR.items(): vbar('Mag HR', d['start'], d['end'], '#B279A2', v[:5])
for t in mag['en']:
    if t['items'] and any(x[2] in DAYV for x in t['items']): vbar('EN', ts(t['start']), ts(t['end']), '#F58518')
lo, hi = ts(DAY['x1'][0]), ts(DAY['x1'][1])
ax.set_ylim(hi, lo); tk = list(range(lo - lo % 1800, hi + 1, 1800))
ax.set_yticks(tk); ax.set_yticklabels([hm(t)[:5] for t in tk]); ax.grid(axis='y', color='#ddd', lw=0.6); ax.set_axisbelow(True)
ax.set_xticks(range(len(lanes_m))); ax.set_xticklabels(lanes_m); ax.xaxis.tick_top()
for sp in ('right', 'bottom'): ax.spines[sp].set_visible(False)
ax.set_title(f'{DHR} – tko je radio kada', loc='left', fontsize=13, pad=26)
save(fig, 'mobile_1_gantt.png')
# 2) Tier 2 po epizodi: natpis iznad trake, traka preko cijele širine
okm = [e for e in T2 if e['state'] == 'done']
if okm:  # dan bez gotovog Tier 2 posla: nema slika 2 i 3
    fig, ax = plt.subplots(figsize=(MW, 0.62 * max(1, len(okm)) + 1.6))
    mx = max([sum(e['phase']) / 60 for e in okm] or [1])
    for i, e in enumerate(okm):
        yy = -i; left = 0
        for p_, (n_, _, c_) in enumerate(PH):
            w = e['phase'][p_] / 60
            if w > 0: ax.barh(yy, w, left=left, color=c_, height=0.42)
            left += w
        ax.text(0, yy + 0.33, f"s{e['slot']} · {e['channel'][:24]}  ·  {sum(e['phase'])/60:.0f} min (audio {(e['audio'] or 0)//60} min)", fontsize=8.5, va='bottom')
    ax.set_ylim(-len(okm) + 0.4, 0.95); ax.set_xlim(0, mx * 1.02); ax.set_yticks([])
    ax.set_xlabel('minute obrade'); ax.grid(axis='x', color='#ddd', lw=0.5); ax.set_axisbelow(True)
    for sp in ('left', 'right', 'top'): ax.spines[sp].set_visible(False)
    ax.legend(handles=[Patch(color=c, label=n) for n, _, c in PH], ncol=2, fontsize=7.5, loc='upper center', bbox_to_anchor=(0.5, -0.06 if len(okm) > 8 else -0.2), frameon=False)
    ax.set_title(f'Tier 2 – {len(okm)} epizoda, vrijeme po koraku', loc='left', fontsize=13)
    save(fig, 'mobile_2_epizode.png')
    # 3) kamo ide vrijeme
    fig, ax = plt.subplots(figsize=(MW, 5.5))
    ax.barh(range(len(order)), [tot[p] for p in order], color=[PH[p][2] for p in order])
    for i, p_ in enumerate(order):
        ax.text(tot[p_] + 1, i, f"{tot[p_]:.0f} min · {100*tot[p_]/max(1,sum(tot)):.0f} %", va='center', fontsize=9)
    ax.set_yticks(range(len(order))); ax.set_yticklabels([PH[p][0] for p in order], fontsize=9)
    ax.set_xlim(0, max(tot or [1]) * 1.45); ax.grid(axis='x', color='#ddd', lw=0.5); ax.set_axisbelow(True)
    for sp in ('right', 'top'): ax.spines[sp].set_visible(False)
    ax.set_title(f'Kamo ide vrijeme (Tier 2, {sum(tot):.0f} min)', loc='left', fontsize=13)
    save(fig, 'mobile_3_koraci.png')
# 4) stanje po epizodi: članak / EN / Magisterium HR / Magisterium EN
cdn_ = DAY.get('auto', {}).get('cdn', {})
rows_m = [(n['vid'], n['channel'], 'N') for n in NIGHT] + [(e['vid'], e['channel'], f"s{e['slot']}") for e in T2]
fig, ax = plt.subplots(figsize=(MW, 0.36 * len(rows_m) + 1.3)); ax.axis('off')
cols = ['', 'kanal', 'video', 'članak', 'EN', 'Mag HR', 'Mag EN']
def mark(c, k, v):
    if c.get(k): return '✓'
    if k == 'mhr' and 'hr' in MQ.get(v, ()): return 'red'
    if k in ('en', 'men') and 'en' in MQ.get(v, ()): return 'red'
    return '–'
cells = []
for v, ch, src in rows_m:
    c = cdn_.get(v, {})
    cells.append([src, ch[:16], v, mark(c, 'art', v), mark(c, 'en', v), mark(c, 'mhr', v), mark(c, 'men', v)])
tb = ax.table(cellText=cells, colLabels=cols, loc='upper center', cellLoc='center', colLoc='center',
              colWidths=[0.06, 0.3, 0.22, 0.1, 0.08, 0.12, 0.12])
tb.auto_set_font_size(False); tb.set_fontsize(8.5); tb.scale(1, 1.35)
for (r, c), cell in tb.get_celld().items():
    cell.set_edgecolor('#ddd')
    if r == 0: cell.set_facecolor('#f0f0f0'); cell.set_text_props(weight='bold')
    t = cell.get_text().get_text()
    if t == '✓': cell.set_text_props(color='#2E7D32', weight='bold')
    if t == 'red': cell.set_facecolor('#fff4dc'); cell.get_text().set_text('u redu')
ax.set_title('Stanje na CDN-u po epizodi (N = nightly, s1/s2 = slot)', loc='left', fontsize=12)
save(fig, 'mobile_4_stanje.png')

