import re,json,sys
S=sys.argv[1]
def lines(f): return open(f,encoding='utf-8',errors='replace').read().splitlines()
# ---- priority runs
# Od 05.11. rade dva slota istodobno: linije workera imaju prefiks [s1]/[s2] i ispreplete se
# u logu, pa se trenutni posao prati po slotu (bez prefiksa = slot 1, stari log s jednim slotom).
runs=[];cur={}
for l in lines(S+'/prio_f.log'):
    ps=re.match(r'\[s(\d+)\] ?',l)
    slot=int(ps[1]) if ps else 1
    if ps: l=l[ps.end():]
    m=re.search(r'→ ⚡ (\S{11}) \(([0-9a-f-]+)\)',l)
    if m: cur[slot]={'vid':m[1],'job':m[2],'slot':slot,'steps':[],'notes':[]};runs.append(cur[slot]);continue
    c=cur.get(slot)
    if not c: continue
    m=re.search(r'Početak: \d{4}-\d\d-\d\d (\S+)',l)
    if m: c['start']=m[1]
    m=re.search(r'📢 \[(\d\d:\d\d:\d\d) \+[\d:]+\] KORAK ([\d.]+[a-z]?)(?:/\d+)?: (.*)',l)
    if m: c['steps'].append((m[2],m[1],m[3][:70]))
    m=re.search(r'🤖 koraci 7\+8: (\w+)',l)
    if m: c['llm']=m[1]
    m=re.search(r'Kraj: \d{4}-\d\d-\d\d (\S+)',l)
    if m: c['end']=m[1]
    if re.search(r'❌|anti-bot|Sign in|ODGOĐ|pauz',l,re.I): c['notes'].append(l.strip()[:160])
    for k,rx in [('soniox',r'Soniox: .*obrada (\d\d:\d\d:\d\d)'),('sm',r'Speechmatics.*obrada (\d\d:\d\d:\d\d)')]:
        m=re.search(rx,l)
        if m: c[k]=m[1]
json.dump(runs,open(S+'/runs.json','w'),ensure_ascii=False,indent=1)
for r in runs: print(r['slot'],r['vid'],r.get('start'),r.get('end'),len(r['steps']),r['notes'][:2])
