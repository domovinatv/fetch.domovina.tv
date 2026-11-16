#!/usr/bin/env python3
"""Gemini (app, Hydrogen 4) doslovni prijepis bez vremena: što je ispušteno / dodano prema
Soniox (os) i potvrđeno Canaryjem + Speechmaticsom (ako i oni imaju te riječi, ispust je stvaran)."""
import re,difflib,os,json
E=os.path.dirname(os.path.abspath(__file__))
exec(open(f'{E}/compare3.py').read().split("print('== osnovno")[0])   # SYS, T, K, k
GF=os.environ.get('GEMINI_FILE','gemini_hydrogen4_app.md')
g=open(f'{E}/{GF}').read()
g=re.split(r'^.*(?:### Dodatni isječak|\*\*\[Najava iduće).*$',g,flags=re.M)[0]   # najava sljedeće ep. nije u Soniox SRT-u
g=re.sub(r'\*\*\[[^\]]*\]\*\*','',g)                            # **[Uvodni isječak]** i sl.
g=re.sub(r'\*\*[^*]+:\*\*',' ',g); g=re.sub(r'^#.*$','',g,flags=re.M)
G=[k(w) for w in g.split() if k(w)]
print('Gemini riječi (do odjave):',len(G),' Soniox:',len(K['Soniox']))
def ops(a,b): return difflib.SequenceMatcher(None,a,b,autojunk=False).get_opcodes()
o=ops(K['Soniox'],G)
err=sum(max(i2-i1,j2-j1) for t,i1,i2,j1,j2 in o if t!='equal')
print(f'razlika prema Sonioxu: {err/len(K["Soniox"])*100:.1f} %  (Canary 8,9 %, Speechmatics 11,5 %)')
# ispusti/dodaci >= 6 riječi
oc={n:ops(K['Soniox'],K[n]) for n in ('Canary','Speechmatics')}
def covered(n,i1,i2):   # koliko Soniox riječi [i1,i2) taj sustav ima jednako
    return sum(max(0,min(b,i2)-max(a,i1)) for t,a,b,_,_ in oc[n] if t=='equal')
big=[]
for t,i1,i2,j1,j2 in o:
    if t=='equal': continue
    if (i2-i1)-(j2-j1)>=6 or (j2-j1)-(i2-i1)>=6:
        ts=T['Soniox'][min(i1,len(T['Soniox'])-1)][1]
        big.append((ts,t,i2-i1,j2-j1,' '.join(K['Soniox'][i1:i2]),' '.join(G[j1:j2]),covered('Canary',i1,i2),covered('Speechmatics',i1,i2)))
miss=sum(b[2]-b[3] for b in big if b[2]>b[3]); add=sum(b[3]-b[2] for b in big if b[3]>b[2])
print(f'blokova ≥6 riječi: {len(big)}; ispušteno ukupno {miss} riječi, dodano {add}')
for ts,t,ns,ng,s,gg,cc,cm in big:
    print(f'\n{int(ts//60):02d}:{int(ts%60):02d} {t} Soniox {ns} → Gemini {ng} (Canary ima {cc}/{ns}, Speechmatics {cm}/{ns})\n   S: {s[:400]}\n   G: {gg[:300]}')
