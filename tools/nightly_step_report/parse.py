import re,json,sys
S=sys.argv[1]
def lines(f): return open(f,encoding='utf-8',errors='replace').read().splitlines()
# ---- priority runs
runs=[];cur=None
for l in lines(S+'/prio_f.log'):
    m=re.search(r'→ ⚡ (\S{11}) \(([0-9a-f-]+)\)',l)
    if m: cur={'vid':m[1],'job':m[2],'steps':[],'notes':[]};runs.append(cur);continue
    if not cur: continue
    m=re.search(r'Početak: \d{4}-\d\d-\d\d (\S+)',l)
    if m: cur['start']=m[1]
    m=re.search(r'📢 \[(\d\d:\d\d:\d\d) \+[\d:]+\] KORAK ([\d.]+[a-z]?)(?:/\d+)?: (.*)',l)
    if m: cur['steps'].append((m[2],m[1],m[3][:70]))
    m=re.search(r'Kraj: \d{4}-\d\d-\d\d (\S+)',l)
    if m: cur['end']=m[1]
    if re.search(r'❌|anti-bot|Sign in|ODGOĐ|pauz',l,re.I): cur['notes'].append(l.strip()[:160])
    for k,rx in [('soniox',r'Soniox: .*obrada (\d\d:\d\d:\d\d)'),('sm',r'Speechmatics.*obrada (\d\d:\d\d:\d\d)')]:
        m=re.search(rx,l)
        if m: cur[k]=m[1]
json.dump(runs,open(S+'/runs.json','w'),ensure_ascii=False,indent=1)
for r in runs: print(r['vid'],r.get('start'),r.get('end'),len(r['steps']),r['notes'][:3])
