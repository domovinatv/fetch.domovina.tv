#!/usr/bin/env python3
# Realni podaci o trajanju Magisterium MCP batch obrade (sesija 2026-06-15 -> 2026-06-17)
# Polja: (channel, vid, sections, score, duration_ms)  -- duration_ms = trajanje subagenta
import statistics as st

DATA = [
# --- mladi_za_domovinu (121 obrađenih ove sesije) ---
("mladi","G0ar7TRuwzY",53,93,1483546),("mladi","ZnHXj-R7hBU",16,98,698044),
("mladi","7uLpm9zLbsA",8,97,513233),("mladi","fIdYMq-CNe0",13,97,596187),
("mladi","9nLZyYR4BMY",5,98,350887),("mladi","DgxNotap0gw",15,95,487073),
("mladi","wJkoUXMgs20",9,99,407926),("mladi","rulbwVciJWE",15,93,604807),
("mladi","Q_lYvCZDXvA",24,93,705486),("mladi","b8rijVHPpIs",41,89,1088739),
("mladi","VznQhKgJI6k",12,90,544795),("mladi","98_N6iZ7WaQ",11,95,523583),
("mladi","znsDkfXy3Dk",33,94,843865),("mladi","vhLrS0ht95Q",13,93,868041),
("mladi","4F7l6DRE2BE",27,89,695108),("mladi","Gn78w0wVjuc",26,92,766059),
("mladi","nGtCg2aQF-Q",12,94,483498),("mladi","w0SclQumCrU",31,91,773849),
("mladi","FfzleguzGUo",17,98,559939),("mladi","48dlOuxfH_A",37,92,1027256),
("mladi","HXMPa_XIZHY",30,94,786290),("mladi","0DvE9sDhwOM",42,93,999793),
("mladi","Ijr-OQbVPhs",19,95,626043),("mladi","wuZjzNF2saI",24,92,697457),
("mladi","dIxEMIvGPfQ",17,82,655506),("mladi","VJJNZ-xj76I",30,82,845555),
("mladi","7CxvTav5ad0",16,93,728252),("mladi","dNY5MVIh2jE",96,76,2038112),
("mladi","dDfSZ88A_8Q",21,98,639849),("mladi","JNxtmshvV54",90,94,1743786),
("mladi","O4EjSWPuI64",22,97,750879),("mladi","ieE_wXIZ0BM",29,79,1018877),
("mladi","LRci7pibY5Q",21,92,699164),("mladi","yk7SRYnv7ns",18,90,590461),
("mladi","BGfp9LSM5iY",13,97,476463),("mladi","9P8G5jsYLGc",27,96,780899),
("mladi","sdyaNNBIn6g",22,93,681274),("mladi","TASZwLmfR0s",30,96,967674),
("mladi","YpHnvIcwXDE",22,93,734157),("mladi","2g7ALhZT1HE",28,89,895149),
("mladi","qDHPQCCWViE",47,84,1428843),("mladi","YnVEpHZSi8U",32,76,1029760),
("mladi","d-sZ4hYZj4o",20,94,815218),("mladi","U8QUrtCh6-c",24,92,823645),
("mladi","d0vUHqOZ1PQ",52,90,1374441),("mladi","bQX4eNJx4DY",19,94,647148),
("mladi","8iDfsDYGKdQ",43,80,1489154),("mladi","hmLZQ34mjAg",25,86,879583),
("mladi","z8rFx6e7A7M",26,88,945825),("mladi","hYYBlX4xn20",21,85,752597),
("mladi","zX5kGh9URyY",18,84,621954),("mladi","x61tpsoXenw",16,93,616440),
("mladi","faBG-ocUmEs",26,96,812921),("mladi","ixwyv7KCQRo",48,90,1154226),
("mladi","0tQFEtMoIH0",25,97,869314),("mladi","sYkzARm_5YY",17,97,696587),
("mladi","Hg-NNJHGc8g",37,95,1066987),("mladi","OjuXwE2ywec",23,82,785076),
("mladi","EU8s3jN_iAc",17,96,790452),("mladi","Z-ElGw4pz5w",20,94,813738),
("mladi","lvVUHYp_Mxw",22,90,844420),("mladi","M60PEY4XFA0",25,95,878017),
("mladi","AffYqUPgYiQ",23,85,743300),("mladi","qsnm9Y7WVNg",6,81,525274),
("mladi","7ow8o0L8daA",16,88,690859),("mladi","OOMwD5e-Quo",10,84,496985),
("mladi","kf82tbTL4Qg",47,81,1532596),("mladi","aO9YUTqglco",22,89,749388),
("mladi","cdXl1Cpc7VE",34,94,1034848),("mladi","lI0ldjuE5S8",23,77,762903),
("mladi","WzbHupOQuMw",16,80,580439),("mladi","pXNN_Kh9lxE",29,93,1108549),
("mladi","RBxKAZp3Hs8",23,90,741803),("mladi","Qus7gzPRk7c",21,87,801977),
("mladi","J4wUiRZ0N9w",16,98,731680),("mladi","DxCWz816HYE",22,92,815032),
("mladi","jqjABMHx_ww",11,80,509008),("mladi","W3mUf9uCtkw",32,81,1002909),
("mladi","HfjCLe6W1RU",18,89,637326),("mladi","DK2lEINyqjY",24,78,856787),
("mladi","-puDr7qFa6s",31,96,981321),("mladi","6aW5sYs6e00",22,90,1027333),
("mladi","4QLvLdkkRvY",13,96,529317),("mladi","I_l_L-dntWI",30,95,987623),
("mladi","kbB_3d54iJU",19,85,674477),("mladi","AYUH3-8vPk0",23,96,1465071),
("mladi","pLk2J1K4SGE",30,96,928476),("mladi","C9MqtPV4l0w",18,96,675565),
("mladi","09TaSqmzF9g",15,88,778438),("mladi","lvpl8uRcK9U",49,93,1410904),
("mladi","LJtqwpxbB84",21,90,955683),("mladi","QxMBYO-ed-8",29,91,906985),
("mladi","KNH1YvCKWf0",21,94,712901),("mladi","ggLiWaJ4pJU",23,86,627604),
("mladi","iP5X9Q93sSY",33,87,976818),("mladi","ppGpBPbNmZs",6,84,570853),
("mladi","5yvyr1SfwH4",23,91,807148),("mladi","EGv7LZGh2-0",49,83,1487886),
("mladi","XnspyAbKF2s",21,93,682600),("mladi","Kubw_KnCI28",39,94,992892),
("mladi","FrnEOY9az7o",19,93,714690),("mladi","xOWNSHgzXwI",22,93,654474),
("mladi","uLKgfrfNYE0",14,97,550993),("mladi","pkmMdCttLAM",19,88,529481),
("mladi","MC3hAiod9Eg",48,88,1128192),("mladi","Df--kDZSIYU",18,88,618901),
("mladi","MMPBBfDCIzw",14,76,530913),("mladi","HVWIKpR6k_Y",30,88,991646),
("mladi","dvjXCCM1Vlc",11,93,556577),("mladi","oM0SZAst29U",55,91,1340206),
("mladi","6ok_B9YUYt0",22,85,719318),("mladi","HsS-yz76cWQ",39,87,1183643),
("mladi","FNF2BOFPDAs",23,80,697263),("mladi","F94SKx2wH0k",16,88,621556),
("mladi","t8xxDJnrIvc",31,90,933135),("mladi","ASEmonKI2YQ",17,91,640246),
("mladi","5zRBuReyPTw",20,94,678995),("mladi","Lti4OSq6Ibc",17,87,887236),
("mladi","y5zP9s5_G7g",31,78,893799),("mladi","J9ui7iNdaio",15,70,690627),
("mladi","KuWqx0TJaVM",22,89,726559),
# --- prioritetna (hitna_pomoc_za_nemirne) ---
("hitna","6e1MW97dv10",10,94,590035),
# --- bozanstvena_komedija (27 obrađenih) ---
("bozanstvena","tHqmEJbtnAc",32,96,895560),("bozanstvena","RDIUk-Ci_Cs",28,95,989147),
("bozanstvena","T2G0wKAChhI",12,92,517027),("bozanstvena","4GI-a62FYyY",71,90,1847043),
("bozanstvena","UIJYradvdbE",42,88,1036558),("bozanstvena","NkBSmiUApvM",24,83,734782),
("bozanstvena","8fvtiUk9TjE",33,87,883784),("bozanstvena","hfVwETk2meY",43,98,1135548),
("bozanstvena","WoX1U7YyLB8",34,93,944111),("bozanstvena","lbJvjq8sU-o",25,90,796882),
("bozanstvena","IuUdtMkuiGA",46,88,1214792),("bozanstvena","wRvW8BN0Y_I",49,93,1298362),
("bozanstvena","UanVMi1CPkQ",49,92,600676),("bozanstvena","OEb4EwVl7JY",59,93,1365787),
("bozanstvena","ZRxrabcOMGA",22,93,743069),("bozanstvena","MExx_p_elW4",25,93,1047584),
("bozanstvena","RA4bHbq2MkE",18,67,659571),("bozanstvena","_O0KAcA_O6A",23,96,749590),
("bozanstvena","iD5QueFlTBc",34,92,987375),("bozanstvena","h0jvFrRU7no",29,90,959016),
("bozanstvena","4gCI7i1Bh6w",7,76,459755),("bozanstvena","qKKYiURbYCo",10,91,411697),
("bozanstvena","ws2m0wwuH4M",8,91,400799),("bozanstvena","K2LmAZ8f-9U",11,94,509727),
("bozanstvena","peoHMghoXys",13,94,551343),("bozanstvena","Abi7wrnpaVo",14,91,591128),
("bozanstvena","lJ-Aiiwvhl4",12,95,474393),
]

# Tranzijentni neuspjeli subagenti (potrošeno vrijeme, 0 outputa) + blocker
WASTED = [("nGtCg2aQF-Q",246860),("HXMPa_XIZHY",73849),("UanVMi1CPkQ",845534),("AHAoSdr3IRU(blocker)",70605)]

def fmt(ms):
    s=ms/1000; m=int(s//60); return f"{m}m{int(s%60):02d}s"

def report(name, rows):
    durs=[r[4] for r in rows]; secs=[r[2] for r in rows]; scs=[r[3] for r in rows]
    print(f"\n=== {name} (n={len(rows)}) ===")
    print(f"  trajanje: ukupno {fmt(sum(durs))} | prosjek {fmt(int(st.mean(durs)))} | median {fmt(int(st.median(durs)))} | min {fmt(min(durs))} | max {fmt(max(durs))}")
    print(f"  sekcije:  ukupno {sum(secs)} | prosjek {st.mean(secs):.1f} | median {st.median(secs)} | min {min(secs)} | max {max(secs)}")
    print(f"  score:    prosjek {st.mean(scs):.1f} | median {st.median(scs)} | min {min(scs)} | max {max(scs)}")
    # per-sekcija throughput
    persec=[d/s for d,s in zip(durs,secs)]
    print(f"  po sekciji: prosjek {st.mean(persec)/1000:.1f}s/sek | median {st.median(persec)/1000:.1f}s/sek")

mladi=[r for r in DATA if r[0]=="mladi"]
boz=[r for r in DATA if r[0]=="bozanstvena"]
report("SVE USPJEŠNE", DATA)
report("mladi_za_domovinu", mladi)
report("bozanstvena_komedija", boz)

# Linearna regresija duration ~ sections (svi)
xs=[r[2] for r in DATA]; ys=[r[4]/1000 for r in DATA]
n=len(xs); mx=st.mean(xs); my=st.mean(ys)
b=sum((x-mx)*(y-my) for x,y in zip(xs,ys))/sum((x-mx)**2 for x in xs)
a=my-b*mx
print(f"\n=== REGRESIJA trajanje(s) ~ sekcije ===")
print(f"  trajanje ≈ {a:.0f}s + {b:.1f}s × sekcije   (fiksni overhead {a:.0f}s + ~{b:.1f}s po sekciji)")
# korelacija
import math
sx=math.sqrt(sum((x-mx)**2 for x in xs)); sy=math.sqrt(sum((y-my)**2 for y in ys))
r=sum((x-mx)*(y-my) for x,y in zip(xs,ys))/(sx*sy)
print(f"  Pearson r = {r:.3f}")

# Distribucija po veličini
buckets={"XS (≤10 sek)":0,"S (11-20)":0,"M (21-35)":0,"L (36-50)":0,"XL (>50)":0}
bdur={k:[] for k in buckets}
for r in DATA:
    s=r[2]
    k="XS (≤10 sek)" if s<=10 else "S (11-20)" if s<=20 else "M (21-35)" if s<=35 else "L (36-50)" if s<=50 else "XL (>50)"
    buckets[k]+=1; bdur[k].append(r[4])
print(f"\n=== DISTRIBUCIJA po broju sekcija ===")
for k in buckets:
    if bdur[k]:
        print(f"  {k}: {buckets[k]} ep | prosj trajanje {fmt(int(st.mean(bdur[k])))}")

# Overhead i totali
wasted_ms=sum(w[1] for w in WASTED)
all_active=sum(r[4] for r in DATA)+wasted_ms
print(f"\n=== TOTALI ===")
print(f"  uspješnih epizoda: {len(DATA)} (mladi {len(mladi)} + bozanstvena {len(boz)} + prioritetna 1)")
print(f"  ukupno sekcija ocijenjeno: {sum(r[2] for r in DATA)}")
print(f"  kumulativno aktivno procesiranje (samo uspješni subagenti): {fmt(sum(r[4] for r in DATA))} = {sum(r[4] for r in DATA)/3600000:.1f} h")
print(f"  potrošeno na tranzijentne fail/blocker: {fmt(wasted_ms)} ({len(WASTED)} subagenta)")
print(f"  UKUPNO subagent-vrijeme (uspješni+neuspjeli): {fmt(all_active)} = {all_active/3600000:.1f} h")
print(f"  prosječni overall_score (svi): {st.mean([r[3] for r in DATA]):.1f}")
