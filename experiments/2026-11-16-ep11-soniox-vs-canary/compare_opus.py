#!/usr/bin/env python3
"""Canary vs Opus-ispravljen Canary: koliko puta je kandidat sam protiv ČETIRI neovisna
prijepisa koja se slažu (Soniox, Speechmatics, Gemini Hydrogen 4, Gemini Argon 4)."""
import os,re,difflib,collections,json
E=os.path.dirname(os.path.abspath(__file__))
exec(open(f'{E}/compare3.py').read().split("print('== osnovno")[0])
B='20261114_re_definicija_ante_lucic_nisam_ponosan_vec_sam_zahvalan_sto_sam_hrvat_ep_11_yt_RdEN7Ny1bV8'
SYS['Opus']=[c for c in srt(f'{E}/../2026-11-16-ep11-opus-ispravak/kanal/muzevni_budite/{B}.wav.canary.diarized.srt') if c[0]<END]
for n in ('Opus',): T[n]=toks(SYS[n]); K[n]=[k(w) for w,_ in T[n]]
def gem(f):
    g=open(f'{E}/{f}').read()
    g=re.split(r'^.*(?:### Dodatni isječak|\*\*\[Najava iduće).*$',g,flags=re.M)[0]
    g=re.sub(r'\*\*\[[^\]]*\]\*\*','',g); g=re.sub(r'\*\*[^*]+:\*\*',' ',g); g=re.sub(r'^#.*$','',g,flags=re.M)
    return [k(w) for w in g.split() if k(w)]
K['Hydrogen']=gem('gemini_hydrogen4_app.md'); K['Argon']=gem('gemini_argon4_app.md')
REFS=['Speechmatics','Hydrogen','Argon']   # + Soniox kao os
def wer(a,b):
    e=sum(max(i2-i1,j2-j1) for t,i1,i2,j1,j2 in difflib.SequenceMatcher(None,a,b,autojunk=False).get_opcodes() if t!='equal'); return e/len(a)*100
print('razlika riječi prema referencama (%):')
for c in ('Canary','Opus'):
    print(f"  {c:7s}"+''.join(f"  {r} {wer(K[r],K[c]):5.1f}" for r in ['Soniox']+REFS))
FILL=set('a i u o s sa je se si to ta te ti mi me ne da li pa ma ja eto evo ovaj ovoga ono onako znači dakle mislim recimo jel ajde e eh hm aha okej ok sad sada jest bi bih l'.split())
NUMV=set('nula jedan dva tri četiri pet šest sedam osam devet deset dvadeset trideset četrdeset pedeset osamdeset sto'.split())
cnt=lambda x:[w for w in x if w not in FILL and not w.isdigit() and w not in NUMV]
res={}
for cand in ('Canary','Opus'):
    names=REFS+[cand]
    O={n:difflib.SequenceMatcher(None,K['Soniox'],K[n],autojunk=False).get_opcodes() for n in names}
    spans=sorted((i1,i2) for n in O for t,i1,i2,j1,j2 in O[n] if t!='equal'); reg=[]
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
    bad=[]; agree=0
    for a,b in reg:
        s=K['Soniox'][a:b]; refs=[mp(r,a,b) for r in REFS]; x=mp(cand,a,b)
        if all(cnt(r)==cnt(s) for r in refs):
            agree+=1
            if cnt(x)!=cnt(s): bad.append((round(T['Soniox'][min(a,len(T['Soniox'])-1)][1]),' '.join(x),' '.join(s)))
    res[cand]=bad
    print(f'{cand}: sam protiv 4 slažne reference (sadržajno): {len(bad)}')
fixed=len(res['Canary'])-len(res['Opus'])
cs={(t,s) for t,x,s in res['Canary']}; os_={(t,s) for t,x,s in res['Opus']}
print(f'Opus ispravio {len(cs-os_)} Canary grešaka, uveo {len(os_-cs)} novih, ostalo {len(cs&os_)}')
json.dump(res,open(f'{E}/out_opus.json','w'),ensure_ascii=False,indent=0)
print('-- nove greške koje je uveo Opus:')
for t,x,s in res['Opus']:
    if (t,s) not in cs: print(f'   {t//60:02d}:{t%60:02d} Opus«{x}» ostali«{s}»')
print('== govornici po sekundi (oznake SPEAKER_00/01 iste u svim izvorima)')
def lab(c,x):
    for a,b,sp,_ in c:
        if a<=x<b: return sp
for cand in ('Canary','Opus'):
    for ref in ('Soniox','Speechmatics'):
        P=collections.Counter()
        for x in range(int(END)):
            p,q=lab(SYS[ref],x+.5),lab(SYS[cand],x+.5)
            if p and q: P[(p,q)]+=1
        print(f'  {cand} ↔ {ref}: {sum(n for (p,q),n in P.items() if p==q)/sum(P.values())*100:.2f} %')
