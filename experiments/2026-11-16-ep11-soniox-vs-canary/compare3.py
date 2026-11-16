#!/usr/bin/env python3
"""Tri ASR-a iste epizode (re:DEFINICIJA ep. 11) bez referentnog prijepisa.
Glasanje 2 protiv 1 (ROVER-stil, Soniox kao os poravnanja): u svakoj regiji gdje se bilo koja
dva razlikuju, ako se dva slažu, treći je „sam protiv dva” (vjerojatna greška)."""
import re,difflib,collections,json,os,sys
E=os.path.dirname(os.path.abspath(__file__))
D='/Users/ms/git/domovinatv/fetch.domovina.tv/storage/output/muzevni_budite/20261114_re_definicija_ante_lucic_nisam_ponosan_vec_sam_zahvalan_sto_sam_hrvat_ep_11_yt_RdEN7Ny1bV8'
def hms(s):
    h,m,x=s.replace(',','.').split(':'); return int(h)*3600+int(m)*60+float(x)
def srt(p):
    out=[]
    for blk in open(p).read().strip().split('\n\n'):
        l=blk.split('\n'); a,b=l[1].split(' --> '); t=' '.join(l[2:]); m=re.match(r'\[(\w+)\]\s*',t)
        out.append((hms(a),hms(b),m.group(1) if m else '?',t[m.end():] if m else t))
    return out
S=srt(f'{E}/soniox_ep11.diarized.srt'); END=S[-1][1]
SYS={'Soniox':S,'Canary':[c for c in srt(D+'.wav.canary.diarized.srt') if c[0]<END],
     'Speechmatics':[c for c in srt(f'{E}/ep11.mp3.speechmatics.diarized.srt') if c[0]<END]}
k=lambda w:re.sub(r"[^a-zčćžšđ0-9]","",w.lower())
def toks(c):
    out=[]
    for a,b,sp,t in c:
        ws=[w for w in t.split() if k(w)]; n=len(ws)
        for i,w in enumerate(ws): out.append((w,a+(b-a)*i/max(n,1)))
    return out
T={n:toks(c) for n,c in SYS.items()}; K={n:[k(w) for w,_ in T[n]] for n in T}
print('== osnovno (do %d:%02d)'%(END//60,END%60))
for n,c in SYS.items():
    txt=' '.join(x[3] for x in c)
    print(f"{n:13s} riječi {len(K[n]):6d} | .?! {len(re.findall(r'[.?!]',txt)):4d} | zarez {txt.count(','):5d} | cue {len(c):4d} | govornika {len(set(x[2] for x in c))}")
print('== međusobna razlika riječi (WER jednog prema drugom, simetrično nije)')
def wer(a,b):
    sm=difflib.SequenceMatcher(None,a,b,autojunk=False); e=0
    for tg,i1,i2,j1,j2 in sm.get_opcodes():
        if tg!='equal': e+=max(i2-i1,j2-j1)
    return e/len(a)
for a,b in [('Soniox','Canary'),('Soniox','Speechmatics'),('Canary','Speechmatics')]:
    print(f"  {a} ↔ {b}: {wer(K[a],K[b])*100:.1f} %")
ops={n:difflib.SequenceMatcher(None,K['Soniox'],K[n],autojunk=False).get_opcodes() for n in ('Canary','Speechmatics')}
spans=sorted((i1,i2) for n in ops for tg,i1,i2,j1,j2 in ops[n] if tg!='equal')
reg=[]
for a,b in spans:
    if reg and a<=reg[-1][1]: reg[-1][1]=max(reg[-1][1],b)
    else: reg.append([a,b])
def mapped(n,a,b):
    out=[]
    for tg,i1,i2,j1,j2 in ops[n]:
        if tg=='equal':
            lo,hi=max(i1,a),min(i2,b)
            if lo<hi: out+=K[n][j1+lo-i1:j1+hi-i1]
        elif (i1<b and i2>a) or (i1==i2 and a<=i1<=b):
            out+=K[n][j1:j2]
    return out
odd=collections.Counter(); oddw=collections.Counter(); ex=collections.defaultdict(list); unres=0
for a,b in reg:
    s=K['Soniox'][a:b]; c=mapped('Canary',a,b); m=mapped('Speechmatics',a,b)
    if s==c==m: continue
    t=T['Soniox'][min(a,len(T['Soniox'])-1)][1]
    who=None
    if c==m: who='Soniox'
    elif s==m: who='Canary'
    elif s==c: who='Speechmatics'
    if who:
        odd[who]+=1; oddw[who]+=max(len(s),len(c),len(m)); ex[who].append((t,' '.join(s),' '.join(c),' '.join(m)))
    else: unres+=1
print('== glasanje 2:1 — koliko puta je sustav SAM protiv druga dva (regija / riječi)')
for n in ('Soniox','Canary','Speechmatics'): print(f"  {n:13s} {odd[n]:4d} regija, {oddw[n]:4d} riječi")
print(f"  sva tri različita: {unres} regija")
json.dump({n:sorted(v) for n,v in ex.items()},open(f'{E}/out_glasanje.json','w'),ensure_ascii=False,indent=0)
# govornici po sekundi
def lab(c,x):
    for a,b,sp,_ in c:
        if a<=x<b: return sp
print('== govornici: slaganje po sekundi (najbolje mapiranje 1:1)')
for a,b in [('Soniox','Canary'),('Soniox','Speechmatics'),('Canary','Speechmatics')]:
    P=collections.Counter()
    for x in range(int(END)):
        p,q=lab(SYS[a],x+.5),lab(SYS[b],x+.5)
        if p and q: P[(p,q)]+=1
    mp={}
    for (p,q),n in P.most_common():
        if p not in mp and q not in mp.values(): mp[p]=q
    ok=sum(n for (p,q),n in P.items() if mp.get(p)==q); tot=sum(P.values())
    print(f"  {a} ↔ {b}: {ok/tot*100:.1f} % od {tot} s; ostatak {dict((f'{p}→{q}',n) for (p,q),n in P.items() if mp.get(p)!=q)}")
# Sadržajne greške: izbaci regije gdje su sve razlike poštapalice/kratke funkcijske riječi ili brojke u drugom zapisu
FILL=set('a i u o s sa je se si to ta te ti mi me ne da li pa ma ja eto evo ovaj ovoga ono onako znači dakle mislim recimo jel ajde e eh hm aha da okej ok sad sada jest bi bih'.split())
NUM={'0':'nula','1':'jedan','2':'dva','3':'tri','4':'četiri','5':'pet','6':'šest','7':'sedam','8':'osam','9':'devet','10':'deset','20':'dvadeset','30':'trideset','40':'četrdeset','50':'pedeset','80':'osamdeset','100':'sto'}
def content(x): return [w for w in x.split() if w not in FILL and not w.isdigit() and w not in NUM.values()]
print('== samo SADRŽAJNE greške (bez poštapalica, funkcijskih riječi i brojki)')
for n,v in json.load(open(f'{E}/out_glasanje.json')).items():
    real=[r for r in v if content(r[1])!=content(r[2]) or content(r[1])!=content(r[3])]
    real=[r for r in real if not (n=='Soniox' and content(r[2])==content(r[3])==[] ) ]
    print(f"  {n:13s} {len(real):4d} regija (od {len(v)})")
