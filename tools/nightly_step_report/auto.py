#!/Library/Frameworks/Python.framework/Versions/3.13/bin/python3
"""Automatski dnevni report: čim je dan STVARNO gotov, složi PDF i pošalji ga u Telegram.

Pokreće ga launchd (tv.domovina.fetch.nightly-report, svakih 15 min). Svaki tick:
  1. Već poslano danas?                        → izlaz.
  2. Nightly još nije ispisao SAŽETAK?         → izlaz.
  3. Posao iz nightlyja još nije gotov?        → izlaz (do roka, vidi ispod).
     Gotov znači: svi Tier 2 poslovi koje je nightly poslao su done/failed, i svaka
     epizoda dana na CDN-u ima članak, EN članak, a uz Magisterium HR i Magisterium EN;
     nijedan Magisterium/EN posao tih epizoda ne čeka u redu.
  4. Složi report (dump → parse → parse_mag → build → Chrome PDF) i pošalji PDF kroz
     li.domovina.ai/telegram/document (bot ms-social-poster; token bota živi samo u Workeru).

Rok: u REPORT_DEADLINE (default 21:00) report ide i ako nije sve gotovo, s popisom što fali.
Nula LLM poziva. Radni dir: automatic/logs/nightly_report/<datum>/ (gitignored).

  auto.py                 # tick (što radi launchd)
  auto.py --date 2026-11-05 --force   # složi i pošalji odmah, bez provjere gotovosti
  auto.py --dry-run       # složi PDF, ne šalji (ispiše što bi poslao)
"""
import datetime as D, json, os, re, subprocess, sys, urllib.request, glob

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOL = os.path.join(REPO, 'tools', 'nightly_step_report')
LOGS = os.path.join(REPO, 'automatic', 'logs')
PY = sys.executable
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
CDN = 'https://cdn.domovina.ai'
POSTER = os.environ.get('POSTER_BASE', 'https://li.domovina.ai')
POSTER_VARS = os.path.expanduser('~/git/stepanic/linkedin-poster/.dev.vars')
DEADLINE = os.environ.get('REPORT_DEADLINE', '21:00')
ANSI = re.compile(r'\x1b\[[0-9;]*[mK]')
PRIO_NOISE = re.compile(r'Nema prioritetnih|Nema jobova|proxy .* ne odgovara|SLOT \d+ (START|DONE)|yt-dlp: /opt|slot \d+ . worker PID')

args = sys.argv[1:]
def opt(n):
    return args[args.index(n) + 1] if n in args and args.index(n) + 1 < len(args) else None
DATE = opt('--date') or D.date.today().isoformat()
FORCE, DRY = '--force' in args, '--dry-run' in args
W = os.path.join(LOGS, 'nightly_report', DATE)
SENT = os.path.join(W, 'sent.json')
def log(*a): print(D.datetime.now().strftime('%H:%M:%S'), *a, flush=True)
def ts(h):
    h, m, s = map(int, h.split(':')); return h * 3600 + m * 60 + s
def hm(sec): sec = int(sec); return f'{sec//3600:02d}:{sec%3600//60:02d}:{sec%60:02d}'

def read(name):
    p = os.path.join(LOGS, f'{name}_{DATE}.log')
    return ANSI.sub('', open(p, encoding='utf-8', errors='replace').read()) if os.path.exists(p) else ''

def http_json(url, timeout=20):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'domovina-nightly-report'}), timeout=timeout) as r:
            return json.load(r)
    except Exception:
        return None

def cdn_state(vid):
    """Što epizoda ima na CDN-u, iz episode.json (bundle 12.7 je zadnji upload u data/)."""
    d = http_json(f'{CDN}/data/{vid}/episode.json?x={int(D.datetime.now().timestamp())}')
    if not d: return dict(ok=False)
    files = d.get('files') or []
    names = {(f if isinstance(f, str) else f.get('key', f.get('name', ''))).split('/')[-1] for f in files} if isinstance(files, list) else set(files)
    info = (d.get('inline') or {}).get('info.json') or {}
    return dict(ok=True, art='article.json' in names, en='article.en.json' in names,
                mhr='article.magisterium.json' in names, men='article.magisterium.en.json' in names,
                title=info.get('title') or '', channel=info.get('channel') or info.get('uploader') or '',
                duration=info.get('duration'))

# ---------------- 1+2: već poslano / nightly gotov ----------------
if os.path.exists(SENT) and not FORCE:
    sys.exit(0)
night = read('nightly')
if 'NIGHTLY PIPELINE — SAŽETAK' not in night:
    log(f'nightly {DATE} još nije gotov'); sys.exit(0)
os.makedirs(W, exist_ok=True)

# ---------------- nightly: koje epizode i koliko je što trajalo ----------------
lines = night.splitlines()
m = re.search(r'Kraj: \d{4}-\d\d-\d\d (\d\d:\d\d:\d\d)', night)
night_end = m[1] if m else '04:00:00'
m = re.search(r'NIGHTLY PIPELINE — SAŽETAK.*?Kraj:\s+\d{4}-\d\d-\d\d (\d\d:\d\d:\d\d)', night, re.S)
nightly_done = m[1] if m else night_end
m = re.search(r'NIGHTLY PIPELINE — SAŽETAK.*?Status:\s+(.*?)(?:\n\n|\Z)', night, re.S)
night_status = re.sub(r'\s+', ' ', m[1]).strip()[:300] if m else '?'
N = {}
def nv(vid): return N.setdefault(vid, dict(vid=vid, soniox=None, summ=None, art=0.0, reels=None, audio=None, dir=''))
cur_art = None
step = None
for i, l in enumerate(lines):
    ms = re.search(r'📢 \[[\d:]+ \+[\d:]+\] KORAK ([\d.]+[a-z]?)', l)
    if ms: step = ms[1]
    mv = re.search(r'_yt_([A-Za-z0-9_-]{11})\.mp3\s+\(.*?, (\d\d:\d\d:\d\d), \w+\)', l)
    if mv and step == '2.7b':
        sv = mv[1]; nv(sv)['audio'] = ts(mv[2])
        for l2 in lines[i + 1:i + 6]:
            m2 = re.search(r'(Soniox|Speechmatics): .*obrada (\d\d:\d\d:\d\d)', l2)
            if m2: N[sv]['soniox'] = ts(m2[2]); break
    if step == '7':
        m2 = re.search(r'\[GOTOVO\] .*_yt_([A-Za-z0-9_-]{11}) \(([\d.]+)s\)', l)
        if m2: nv(m2[1])['summ'] = float(m2[2])
    m2 = re.search(r'━━━ \[\d+/\d+\] \[([^\]]+)\] .*_yt_([A-Za-z0-9_-]{11})\.wav\.canary\.diarized\.srt', l)
    if m2 and step == '8': cur_art = m2[2]; nv(cur_art)['dir'] = m2[1]
    if step == '8' and cur_art:
        m3 = re.search(r'\[FAZA 1\] Outline spremljen.*\(([\d.]+)s\)|Iteracija \d+ završena \(([\d.]+)s\)', l)
        if m3: N[cur_art]['art'] += float(m3[1] or m3[2])
    m2 = re.search(r'✅ \d+ reelova .*?, (\d+) s → .*_yt_([A-Za-z0-9_-]{11})\.reels\.json', l)
    if m2: nv(m2[2])['reels'] = int(m2[1])
# nightly epizoda = ona kojoj je nightly napisao sažetak ili članak
night_eps = [n for n in N.values() if n['summ'] or n['art']]
ny402 = len(re.findall(r'pyannoteAI POST /diarize: HTTP 402', night))

# ---------------- 3: je li sve gotovo ----------------
key = re.search(r'^PIPELINE_QUEUE_INGEST_KEY=(.*)$', open(os.path.join(REPO, '.env')).read(), re.M)[1].strip().strip('"\'')
def api(path):
    req = urllib.request.Request('https://pipeline.domovina.ai' + path, headers={'authorization': f'Bearer {key}', 'User-Agent': 'domovina-nightly-report'})
    with urllib.request.urlopen(req, timeout=30) as r: return json.load(r)
jobs = api('/api/jobs?limit=500')['jobs']; mags = api('/api/magisterium?limit=500')['jobs']
json.dump(dict(jobs=jobs, mags=mags), open(os.path.join(W, 'jobs.json'), 'w'), ensure_ascii=False)
def sec(x): return x / 1000 if x and x > 1e11 else x
day0 = D.datetime.fromisoformat(DATE + 'T03:00:00').timestamp()
batch_end = D.datetime.fromisoformat(DATE + 'T' + nightly_done).timestamp() + 1800
batch = [j for j in jobs if j.get('created_at') and day0 <= sec(j['created_at']) <= batch_end]
pending_jobs = [j for j in batch if j['state'] not in ('done', 'failed', 'cancelled', 'deleted')]
vids = [n['vid'] for n in night_eps] + [j['youtube_id'] for j in batch if j['state'] == 'done']
cdn = {v: cdn_state(v) for v in vids}
pending_mags = sorted({f"{m['youtube_id']}:{m['lang']}" for m in mags if m['youtube_id'] in vids and m['state'] in ('queued', 'claimed', 'running')})
missing = []
for v, c in cdn.items():
    if not c.get('ok') or not c['art']: missing.append(f'{v}: članak'); continue
    if not c['en']: missing.append(f'{v}: EN članak')
    if c['mhr'] and not c['men']: missing.append(f'{v}: Magisterium EN')
mag_wanted = {j['youtube_id'] for j in batch if j.get('with_magisterium')}
for v in mag_wanted:
    if v in cdn and cdn[v].get('ok') and not cdn[v]['mhr']: missing.append(f'{v}: Magisterium HR')
ready = not pending_jobs and not pending_mags and not missing
late = D.datetime.now().strftime('%H:%M') >= DEADLINE
log(f'{DATE}: nightly {len(night_eps)} ep, Tier 2 {len(batch)} poslova (čeka {len(pending_jobs)}), '
    f'Magisterium/EN u redu {len(pending_mags)}, fali {len(missing)} → {"GOTOVO" if ready else ("ROK" if late else "čekam")}')
if not (ready or late or FORCE):
    sys.exit(0)

# ---------------- 4: report ----------------
prio = read('priority')
open(os.path.join(W, 'prio_f.log'), 'w').write('\n'.join(l for l in prio.splitlines() if not PRIO_NOISE.search(l)))
for x in ('nightly', 'magisterium', 'magisterium-en'):
    open(os.path.join(W, x + '.log'), 'w').write(read(x))
open(os.path.join(W, 'priority.log'), 'w').write(prio)
subprocess.run([PY, os.path.join(TOOL, 'parse.py'), W], check=True, stdout=subprocess.DEVNULL)
subprocess.run([PY, os.path.join(TOOL, 'parse_mag.py'), W, DATE], check=True, stdout=subprocess.DEVNULL)

ssd = re.findall(r'^\S+ (\d\d:\d\d):\d\d ⏭️  nema slobodnog slota: .*SSD (\d+) GB', prio, re.M)
day_file = os.path.join(TOOL, 'days', DATE + '.json')
if os.path.exists(day_file) and '--manual' in args:
    day = json.load(open(day_file))           # ručno pisan dan, samo uz --manual
else:
    runs = json.load(open(os.path.join(W, 'runs.json')))
    starts = [ts(r['start']) for r in runs if r.get('start')] or [ts('04:00:00')]
    ends = [ts(r['end']) for r in runs if r.get('end')] or [ts('08:00:00')]
    day = dict(date=DATE, night_end=night_end, nightly_done=nightly_done, ignore_vids=[],
               night=[dict(vid=n['vid'], channel=cdn.get(n['vid'], {}).get('channel') or n['dir'],
                           title=cdn.get(n['vid'], {}).get('title') or n['vid'], audio=n['audio'] or cdn.get(n['vid'], {}).get('duration'),
                           soniox=n['soniox'], summ=n['summ'], art=round(n['art'], 1) or None, reels=n['reels']) for n in night_eps],
               night_note='Soniox = vrijeme obrade na Sonioxu; sažetak i članak = trajanje Opus poziva (članak = outline + iteracije); reels = select_reels.'
                          + (f' ⚠️ pyannoteAI je u nightlyju {ny402}× vratio HTTP 402.' if ny402 else ''))
    if batch:
        c0 = min(sec(j['created_at']) for j in batch)
        day['marker'] = dict(t=D.datetime.fromtimestamp(c0).strftime('%H:%M:%S'), label=f"enqueue_all_new {D.datetime.fromtimestamp(c0).strftime('%H:%M')} ({len(batch)} poslova)")
day['auto'] = dict(night_status=night_status, ny402=ny402, ssd_blocks=len(ssd), ssd_first=ssd[0][0] if ssd else None,
                   ssd_last=ssd[-1][0] if ssd else None, proxy_down=len(re.findall(r'proxy .* ne odgovara', prio)),
                   pending_jobs=[f"{j['youtube_id']} ({j['state']})" for j in pending_jobs], pending_mags=pending_mags,
                   missing=missing, failed=[f"{j['youtube_id']}: {(j.get('error') or '')[:90]}" for j in batch if j['state'] == 'failed'],
                   n_batch=len(batch), ready=ready, cdn={v: {k: c.get(k) for k in ('art', 'en', 'mhr', 'men')} for v, c in cdn.items()})
json.dump(day, open(os.path.join(W, 'day.json'), 'w'), ensure_ascii=False, indent=1)
subprocess.run([PY, os.path.join(TOOL, 'build.py'), W, os.path.join(W, 'day.json')], check=True, stdout=subprocess.DEVNULL)
pdf = os.path.join(W, f'nightly_{DATE}_vremena_po_koraku.pdf')
subprocess.run([CHROME, '--headless=new', '--no-pdf-header-footer', '--virtual-time-budget=15000',
                f'--user-data-dir={W}/chrome', f'--print-to-pdf={pdf}', 'file://' + os.path.join(W, 'report.html')],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
caption = open(os.path.join(W, 'caption.html')).read()
if DRY:
    log(f'dry-run: {pdf} ({os.path.getsize(pdf)//1024} KB)\n{caption}'); sys.exit(0)

# ---------------- slanje ----------------
# 1) album uspravnih slika s potpisom (mobitel i Telegram Desktop), 2) puni A4 PDF za desktop.
tok = os.environ.get('LINKEDIN_POSTER_TOKEN') or re.search(r'^API_TOKEN=(.+)$', open(POSTER_VARS).read(), re.M)[1].strip()
def post(path, form):
    cmd = ['curl', '-sS', '--max-time', '180', '-X', 'POST', '-H', f'Authorization: Bearer {tok}']
    for k, v, raw in form: cmd += (['--form-string', f'{k}={v}'] if raw else ['-F', f'{k}={v}'])
    r = subprocess.run(cmd + [POSTER + path], capture_output=True, text=True)
    try: return json.loads(r.stdout)
    except Exception: return dict(sent=False, raw=(r.stdout + r.stderr)[:300])
pngs = sorted(glob.glob(os.path.join(W, 'mobile_*.png')))
album = post('/telegram/photos', [('photo', f'@{p};type=image/png', False) for p in pngs] + [('caption', caption, True)]) if len(pngs) >= 2 else dict(sent=False, raw='nema slika')
log('Telegram album:', album)
doc = post('/telegram/document', [('document', f'@{pdf};type=application/pdf', False),
                                  ('caption', f'📄 Puni report {DATE} (A4, za desktop)' if album.get('sent') else caption, True)])
log('Telegram PDF:', doc)
if album.get('sent') or doc.get('sent'):
    json.dump(dict(at=D.datetime.now().isoformat(timespec='seconds'), ready=ready, pdf=pdf, album=album, pdf_result=doc), open(SENT, 'w'))
else:
    sys.exit(1)

# ---------------- drugi deploy javnog kataloga ----------------
# Nightly 5c deploya podcast.domovina.ai na početku dana, dok Tier 2 epizode još nisu
# obrađene, pa bi ih katalog do iduće noći vodio na YouTube bez oznake D. Report ide
# tek kad je dan gotov (zadnji Magisterium), pa je ovo jedini drugi rebuild u danu.
# Non-fatal: report je već poslan. launchd nema node u PATH-u → nvm kao nightly.
# CATALOG_REFRESH=0 gasi.
CATALOG = os.path.join(os.path.dirname(REPO), 'podcast.domovina.ai', 'scripts', 'refresh.sh')
if os.environ.get('CATALOG_REFRESH', '1') != '0' and os.access(CATALOG, os.X_OK):
    log('katalog podcast.domovina.ai: build + deploy …')
    try:
        r = subprocess.run(['/bin/bash', '-c', '. "$HOME/.nvm/nvm.sh" && nvm use default >/dev/null 2>&1; exec "$0"', CATALOG],
                           capture_output=True, text=True, timeout=900)
        tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
        log(f'katalog rc={r.returncode}', *tail, sep='\n  ')
    except Exception as e:
        log('katalog: greška', e)
