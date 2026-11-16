import json,re,difflib,collections,sys
SP=__import__('os').path.dirname(__file__)+'/'
D='/Users/ms/git/domovinatv/fetch.domovina.tv/storage/output/muzevni_budite/20261114_re_definicija_ante_lucic_nisam_ponosan_vec_sam_zahvalan_sto_sam_hrvat_ep_11_yt_RdEN7Ny1bV8'
def hms(s):
    h,m,x=s.replace(',','.').split(':'); return int(h)*3600+int(m)*60+float(x)
def srt(path):
    out=[]
    for blk in open(path).read().strip().split('\n\n'):
        l=blk.split('\n'); a,b=l[1].split(' --> '); t=' '.join(l[2:]); m=re.match(r'\[(\w+)\]\s*',t)
        out.append((hms(a),hms(b),m.group(1) if m else '?',t[m.end():] if m else t))
    return out
S=srt(SP+'soniox_ep11.diarized.srt')  # originalni Soniox SRT poslan 12.11. (najava sljedeće ep. odrezana)
END=S[-1][1]
C=[c for c in srt(D+'.wav.canary.diarized.srt') if c[0]<END]
norm=lambda t:re.findall(r"[a-zčćžšđ0-9]+",t.lower())
def words(cues):
    out=[]
    for a,b,sp,t in cues:
        w=norm(t); n=len(w)
        for i,x in enumerate(w): out.append((x,a+(b-a)*i/max(n,1)))
    return out
SW=words(S)
CW=words(C)
txt=lambda c:' '.join(x[3] for x in c)
def st(cues,name):
    T=txt(cues); w=norm(T)
    print(f"{name}: cues {len(cues)}, riječi {len(w)}, rečenica (.?!) {len(re.findall(r'[.?!]',T))}, zarez {T.count(',')}, prosj. cue {sum(b-a for a,b,_,_ in cues)/len(cues):.1f}s, max cue {max(b-a for a,b,_,_ in cues):.1f}s, govornika {len(set(x[2] for x in cues))}, pokriva {cues[0][0]:.0f}-{cues[-1][1]:.0f}s")
st(S,'Soniox'); st(C,'Canary')
sm=difflib.SequenceMatcher(None,[w for w,_ in SW],[w for w,_ in CW],autojunk=False)
print('podudarnost riječi (ratio)',round(sm.ratio(),3))
ops=collections.Counter(); big=[]
for tag,i1,i2,j1,j2 in sm.get_opcodes():
    if tag=='equal': continue
    ops[tag]+=max(i2-i1,j2-j1)
    if max(i2-i1,j2-j1)>=8: big.append((tag,SW[i1][1] if i1<len(SW) else CW[j1][1],' '.join(w for w,_ in SW[i1:i2]),' '.join(w for w,_ in CW[j1:j2])))
print('razlike (riječi):',dict(ops))
print('VELIKI BLOKOVI (>=8 riječi):',len(big))
for tag,t,a,b in big[:25]: print(f"  {int(t//60):02d}:{int(t%60):02d} {tag}: S=«{a[:160]}» | C=«{b[:160]}»")
# govornici po sekundi
def lab(cues,T):
    for a,b,sp,_ in cues:
        if a<=T<b: return sp
L=int(min(S[-1][1],C[-1][1])); pairs=collections.Counter()
for T in range(L):
    x,y=lab(S,T+.5),lab(C,T+.5)
    if x and y: pairs[(x,y)]+=1
print('matrica govornika (Soniox,Canary):s',dict(pairs))
mp={}
for (x,y),n in pairs.most_common():
    if x not in mp and y not in mp.values(): mp[x]=y
agree=sum(n for (x,y),n in pairs.items() if mp.get(x)==y); tot=sum(pairs.values())
print('mapiranje',mp,'slaganje govornika',round(agree/tot*100,1),'% od',tot,'s')
for term in ['kotruljevi','lučić','lucic','sheraton','žohar','doomscroll','definicij','franklin','kajak','beno']:
    print(term,'S',txt(S).lower().count(term),'C',txt(C).lower().count(term))
json.dump({'S':S,'C':C},open(SP+'out_both.json','w'),ensure_ascii=False)
