#!/usr/bin/env python3
"""Glasanje 3:1 za četiri prijepisa (Soniox os): sustav koji je sam protiv tri slažna."""
import os,re,json,collections,difflib
E=os.path.dirname(os.path.abspath(__file__))
src=open(f'{E}/gemini_gaps.py').read().split("print('Gemini riječi")[0]; exec(src)
K['Gemini']=G
O={n:difflib.SequenceMatcher(None,K['Soniox'],K[n],autojunk=False).get_opcodes() for n in ('Canary','Speechmatics','Gemini')}
spans=sorted((i1,i2) for n in O for t,i1,i2,j1,j2 in O[n] if t!='equal')
reg=[]
for a,b in spans:
    if reg and a<=reg[-1][1]: reg[-1][1]=max(reg[-1][1],b)
    else: reg.append([a,b])
def mp(n,a,b):
    out=[]
    for t,i1,i2,j1,j2 in O[n]:
        if t=='equal':
            lo,hi=max(i1,a),min(i2,b)
            if lo<hi: out+=K[n][j1+lo-i1:j1+hi-i1]
        elif (i1<b and i2>a) or (i1==i2 and a<=i1<=b): out+=K[n][j1:j2]
    return out
FILL=set('a i u o s sa je se si to ta te ti mi me ne da li pa ma ja eto evo ovaj ovoga ono onako znači dakle mislim recimo jel ajde e eh hm aha okej ok sad sada jest bi bih'.split())
NUMV=set('nula jedan dva tri četiri pet šest sedam osam devet deset dvadeset trideset četrdeset pedeset osamdeset sto'.split())
cnt=lambda x:[w for w in x if w not in FILL and not w.isdigit() and w not in NUMV]
names=['Soniox','Canary','Speechmatics','Gemini']
odd=collections.Counter(); oddc=collections.Counter(); ex=collections.defaultdict(list)
for a,b in reg:
    v={'Soniox':K['Soniox'][a:b]}; v.update({n:mp(n,a,b) for n in names[1:]})
    for n in names:
        others=[tuple(v[m]) for m in names if m!=n]
        if len(set(others))==1 and tuple(v[n])!=others[0]:
            odd[n]+=1
            if cnt(v[n])!=cnt(list(others[0])):
                oddc[n]+=1; ex[n].append((round(T['Soniox'][min(a,len(T['Soniox'])-1)][1]),' '.join(v[n]),' '.join(others[0])))
print('== glasanje 3:1 (sam protiv tri koja se slažu)')
for n in names: print(f'  {n:13s} {odd[n]:4d} regija, od toga sadržajnih {oddc[n]:4d}')
json.dump(ex,open(f'{E}/out_glasanje4.json','w'),ensure_ascii=False,indent=0)
for n in ('Gemini','Soniox'):
    print(f'-- {n}, sadržajne (sve/prvih 25):')
    for t,me,ot in ex[n][:25]: print(f'   {t//60:02d}:{t%60:02d} {n}«{me}» ostali«{ot}»')
