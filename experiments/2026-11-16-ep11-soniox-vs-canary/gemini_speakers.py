#!/usr/bin/env python3
"""Govornici u Gemini prijepisu (imena, bez vremena) prema Sonioxu: oznaka po riječi kroz poravnanje."""
import os,re,difflib,collections
E=os.path.dirname(os.path.abspath(__file__))
exec(open(f'{E}/compare3.py').read().split("print('== osnovno")[0])
g=open(f'{E}/gemini_hydrogen4_app.md').read().split('### Dodatni isječak')[0]
GW=[];GL=[];cur=None
for part in re.split(r'(\*\*[^*]+:\*\*)',g):
    m=re.match(r'\*\*([^*]+):\*\*',part)
    if m: cur=m.group(1); continue
    for w in part.split():
        if k(w) and not w.startswith('#'): GW.append(k(w)); GL.append(cur)
SL=[]
for a,b,sp,t in SYS['Soniox']:
    SL+=[sp]*len([w for w in t.split() if k(w)])
P=collections.Counter()
for t,i1,i2,j1,j2 in difflib.SequenceMatcher(None,K['Soniox'],GW,autojunk=False).get_opcodes():
    if t=='equal':
        for x in range(i2-i1): P[(SL[i1+x],GL[j1+x])]+=1
print(dict(P))
tot=sum(P.values()); best=sum(max(n for (s,g2),n in P.items() if s==s0) for s0 in set(s for s,_ in P))
print(f'slaganje govornika po riječi: {best/tot*100:.2f} % od {tot}')
turns=lambda L:sum(1 for a,b in zip(L,L[1:]) if a!=b)
print('izmjena govornika: Soniox',turns(SL),'Gemini',turns(GL))
