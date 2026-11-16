#!/usr/bin/env python3
"""Točnost VREMENA u SRT-u bez pravih vremena: svaka riječ SRT-a poravna se na Soniox riječ
(sirovi tokeni, ms) i usporedi početak cue-a sa stvarnim početkom njegove prve poravnate riječi."""
import os,re,json,difflib,statistics,sys
E=os.path.dirname(os.path.abspath(__file__))
k=lambda w:re.sub(r"[^a-zčćžšđ0-9]","",w.lower())
raw=json.load(open(f'{E}/soniox_sirovi_izlaz.json'))['tokens']
SW=[];cur=None
for t in raw:
    if t['text'].startswith(' ') or cur is None:
        if cur: SW.append(cur)
        cur=[t['text'].strip(),t['start_ms']/1000]
    else: cur[0]+=t['text']
SW.append(cur); SW=[(k(w),s) for w,s in SW if k(w)]
def hms(s):
    h,m,x=s.replace(',','.').split(':'); return int(h)*3600+int(m)*60+float(x)
def load(p):
    txt=open(p).read().replace('\\[','[').replace('\\]',']')
    cues=[]
    for blk in re.split(r'\n\s*\n',txt.strip()):
        l=blk.strip().split('\n')
        if len(l)<3 or '-->' not in l[1]: continue
        a=hms(l[1].split(' --> ')[0]); t=re.sub(r'^\[[^\]]+\]\s*','',' '.join(l[2:]))
        cues.append((a,[k(w) for w in t.split() if k(w)]))
    return cues
name=sys.argv[1]; C=load(name)
W=[];owner=[]
for ci,(a,ws) in enumerate(C):
    W+=ws; owner+=[ci]*len(ws)
first={}
for t,i1,i2,j1,j2 in difflib.SequenceMatcher(None,[w for w,_ in SW],W,autojunk=False).get_opcodes():
    if t=='equal':
        for x in range(i2-i1):
            ci=owner[j1+x]
            if ci not in first: first[ci]=SW[i1+x][1]
D=[(C[ci][0],C[ci][0]-first[ci]) for ci in sorted(first)]
print(f'{os.path.basename(name)}: cue-ova {len(C)}, zadnji cue počinje {int(C[-1][0]//60)}:{int(C[-1][0]%60):02d}, poravnato {len(D)}')
for lo in range(0,4500,600):
    sel=[d for t,d in D if lo <= (t-d) < lo+600]
    if sel: print(f'  stvarno {lo//60:2d}–{(lo+600)//60:2d} min: pomak medijan {statistics.median(sel):+7.1f} s, |pomak|≤2 s: {sum(abs(x)<=2 for x in sel)*100//len(sel)} %')
ab=[abs(d) for _,d in D]; print(f'  ukupno: medijan |pomak| {statistics.median(ab):.1f} s, ≤2 s {sum(x<=2 for x in ab)*100//len(ab)} %, >30 s {sum(x>30 for x in ab)*100//len(ab)} %')
