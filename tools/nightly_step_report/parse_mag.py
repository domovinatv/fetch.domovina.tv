import re,json,sys
S=sys.argv[1]
out={}
for lang,f in [('hr','magisterium.log'),('en','magisterium-en.log')]:
    ticks=[];cur=None
    for l in open(S+'/'+f,encoding='utf-8',errors='replace'):
        l=l.rstrip()
        m=re.match(r'(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) 🕊 ─── MAGISTERIUM \[\w+\] TICK (START|DONE)',l)
        if m:
            if m[3]=='START': cur={'date':m[1],'start':m[2],'items':[],'vids':[]}
            elif cur: cur['end']=m[2]; ticks.append(cur); cur=None
            continue
        if not cur: continue
        m=re.search(r'→ 🕊 (\S{11}) \[(\w+)\]',l)
        if m: cur['vids'].append(m[1])
        m=re.search(r'🔄 (\w+): prevod….*?\(([\d.]+)s',l)
        if m:
            v=re.search(r'_yt_(.{11})\.',l); cur['items'].append((m[1],float(m[2]),v[1] if v else None))
        m=re.search(r'chat poziva \(procjena\).*= (\d+)',l)
        if m: cur['calls']=int(m[1])
        m=re.search(r'zid ([\d.]+) s',l)
        if m: cur.setdefault('wall',[]).append(float(m[1]))
        if '❌' in l and 'Grešaka:         0' not in l and 'neuspjelih' not in l: cur.setdefault('err',[]).append(l.strip()[:150])
    ticks=[t for t in ticks if t['date']==(sys.argv[2] if len(sys.argv)>2 else '2026-11-04') and (t['items'] or [v for v in t['vids'] if v!='KLPD-Meu4e8'])]
    out[lang]=ticks
    for t in ticks: print(lang,t['start'],t['end'],[v for v in t['vids'] if v!='KLPD-Meu4e8'],t.get('calls'),[(a,b,c) for a,b,c in t['items']],t.get('err','')[:2] if t.get('err') else '')
json.dump(out,open(S+'/mag.json','w'),ensure_ascii=False,indent=1)
