const fs=require('fs');
const reg=JSON.parse(fs.readFileSync('data/podcasts_registry.json'));
const bf=JSON.parse(fs.readFileSync('automatic/watchlist/backfill.json')).channels;
const yt=JSON.parse(fs.readFileSync(process.argv[2]));
const bySlug={};(function w(o){if(Array.isArray(o))o.forEach(w);else if(o&&typeof o==='object'){if(o.slug)bySlug[o.slug]=bySlug[o.slug]||o;Object.values(o).forEach(w);}})(reg);
const TODAY=new Date('2026-11-06');
const groups=[
 ['🇭🇷 Hrvatska',[
  ['Podcast Inkubator',['podcast-inkubator']],['LOOD',['lood-podcast']],  ['Explora (HRT)',['explora-hrt']],['Mjesto zločina',['mjesto-zlocina']],['Špica s Mačanom',['spica-s-macanom']],
  ['Lider (playlista podcasta)',['lider-podcast']],['Netokracija Podcast (playlista)',['netokracija-podcast']],
  ['Tribina (sve emisije)',null],['La Vie Podcast',['la-vie-podcast']],['Games Croatia',['games-croatia']],
  ['book&zvook (bookaravision)',['bookaravision']],['Podcasting for Solopreneurs (EN)',['podcasting-for-solopreneurs']]]],
 ['🇧🇦 Bosna i Hercegovina',[['Rastući s djecom',['rastuci-s-djecom']]]],
 ['🇷🇸 Srbija',[['Agelast',['agelast']],['Pojačalo',['pojacalo']],['Tampon zona',['tampon-zona']],['Zdrava priča sa Dolores',['zdrava-prica-sa-dolores']],['Podcast.rs (imenik, ne emisija)',['podcast-rs']]]],
 ['🇸🇮 Slovenija',[['Apparatus: Če veš, kaj mislim!',['apparatus-ce-ves-kaj-mislim']],['Apparatus: Opazovalnica',['apparatus-opazovalnica']],['Apparatus: Glave',['apparatus-glave']]]],
];
const trib=bySlug.tribina.child_slugs.filter(s=>bf[s]);
const fmtN=n=>n==null||isNaN(n)?'—':n>=1e6?(n/1e6).toFixed(1).replace('.',',')+' M':n>=1e4?Math.round(n/1e3)+' k':n.toLocaleString('hr-HR');
const d=s=>s?`${s.slice(8,10)}.${s.slice(5,7)}.${s.slice(0,4)}.`:'—';
const freq=g=>g==null?'—':g<=3?'više puta tjedno':g<=9?'tjedno':g<=18?'svaka 2 tjedna':g<=45?'mjesečno':'rijetko';
const rows=[];const speakers=[];
for(const [country,list] of groups){
 for(const [name,slugs0] of list){
  const slugs=slugs0||['tribina',...trib];const r=bySlug[slugs[0]];
  const ev=(r.events||[]).find(e=>/napod/i.test(e.name));if(ev)speakers.push([name,ev.speaker,ev.talk]);
  const orig={};let der=0,sh=0;
  for(const s of slugs){const b=bf[s];if(!b)continue;Object.assign(orig,b.originals);der+=b.counts?.derivative||0;sh+=b.counts?.short||0;}
  const eps=Object.values(orig).filter(e=>e.date).sort((a,b)=>a.date<b.date?-1:1);
  const c=yt[r.youtube?.channel_id]||{};
  const n=eps.length;const first=eps[0]?.date,last=eps[n-1]?.date;
  const y1=eps.filter(e=>(TODAY-new Date(e.date))/864e5<=365);
  const gaps=[];for(let i=1;i<y1.length;i++)gaps.push((new Date(y1[i].date)-new Date(y1[i-1].date))/864e5);
  gaps.sort((a,b)=>a-b);const med=gaps.length?gaps[Math.floor(gaps.length/2)]:null;
  const hours=eps.reduce((a,e)=>a+(e.duration||0),0)/3600;
  const avg=n?Math.round(hours*60/n):null;
  const years=first?((new Date(last)-new Date(first))/864e5/365.25):0;
  const since=last?Math.round((TODAY-new Date(last))/864e5):null;
  rows.push({yc:c.country,rc:r.metadata?.country,country,name,subs:c.subs,videos:c.videos,views:c.views,created:c.created?.slice(0,10),chTitle:c.title,n,first,last,since,y1:y1.length,med,f:y1.length<2?(n?'neaktivan':'—'):freq(med),hours,avg,years,der,sh,min:bf[slugs[0]]?.min_duration_sec||bf[slugs[1]]?.min_duration_sec});
 }
}
let md=`---
title: "NaPOD festival 2026 — statistika podcasta predavača"
date: "06.11.2026."
---

Podcasti čiji su autori predavači na [NaPOD festivalu 2026](https://napodfest.com/predavaci/). Brojke su izračunate lokalno iz podataka koje pipeline već ima (bez ručnog brojanja).

**Izvori**

- **Pratitelji, ukupno videa, pregledi, otvoren kanal:** YouTube Data API, 06.11.2026. To su brojke cijelog YouTube kanala. Za Lider, Netokraciju i tri Apparatus emisije kanal je zajednički pa vrijede za kanal, ne za tu emisiju.
- **Epizode, prva/zadnja, frekvencija, trajanje:** \`automatic/watchlist/backfill.json\` — točni datumi objave svih videa s kanala/playliste. **Epizoda = original**, video dulji od praga emisije (stupac *prag*), bez isječaka, Q&A-ova i shortsova; oni su izbrojani zasebno.
- **Država:** oznaka koju kanal sam upisuje na YouTubeu (\`snippet.country\`). Gdje je nema (Apparatus, Podcasting for Solopreneurs), uzeta je država iz registryja. Svi podcasti iz Hrvatske i BiH su na hrvatskom, osim Podcasting for Solopreneurs (engleski). Srpski su na srpskom, a Apparatus na slovenskom.
- **Frekvencija:** medijan razmaka između epizoda u zadnjih 365 dana.

## Sažetak po državi

| Država | Podcasta | Epizoda ukupno | Sati sadržaja | Epizoda u zadnjih 12 mj. |
|---|--:|--:|--:|--:|
`;
for(const [country] of groups){const g=rows.filter(r=>r.country===country);md+=`| ${country} | ${g.filter(r=>r.n).length} | ${fmtN(g.reduce((a,r)=>a+r.n,0))} | ${fmtN(Math.round(g.reduce((a,r)=>a+r.hours,0)))} | ${g.reduce((a,r)=>a+r.y1,0)} |\n`;}
md+=`| **Ukupno** | **${rows.filter(r=>r.n).length}** | **${fmtN(rows.reduce((a,r)=>a+r.n,0))}** | **${fmtN(Math.round(rows.reduce((a,r)=>a+r.hours,0)))}** | **${rows.reduce((a,r)=>a+r.y1,0)}** |\n\nApparatus se broji kao tri emisije, a Tribina kao jedna, iako ima ${trib.length} playlisti emisija. Podcast.rs je imenik i nema epizode.\n`;
for(const [country] of groups){
 md+=`\n## ${country}\n\n### YouTube kanal\n\n| Podcast | Pratitelji | Videa na kanalu | Pregledi | Kanal otvoren | Država (YouTube) |\n|---|--:|--:|--:|--:|:-:|\n`;
 for(const r of rows.filter(r=>r.country===country))md+=`| ${r.name} | ${fmtN(r.subs)} | ${fmtN(r.videos)} | ${fmtN(r.views)} | ${d(r.created)} | ${r.yc||'— (registry: '+(r.rc||'?')+')'} |\n`;
 md+=`\n### Epizode\n\n| Podcast | Epizoda | Prva | Zadnja | Prije (dana) | Zadnjih 12 mj. | Frekvencija | Prosj. trajanje | Sati ukupno | Isječci / shortsi | Prag |\n|---|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|\n`;
 for(const r of rows.filter(r=>r.country===country))md+=r.n?`| ${r.name} | ${r.n} | ${d(r.first)} | ${d(r.last)} | ${r.since} | ${r.y1} | ${r.f}${r.med!=null&&r.y1>1?` (${Math.round(r.med)} d)`:''} | ${r.avg} min | ${Math.round(r.hours)} | ${fmtN(r.der)} / ${fmtN(r.sh)} | ${Math.round(r.min/60)} min |\n`:`| ${r.name} | — | — | — | — | — | — | — | — | — | — |\n`;
}
md+=`\n## Predavači i teme\n\n| Podcast | Predavač | Tema na festivalu |\n|---|---|---|\n`;
for(const [n,s,t] of speakers)md+=`| ${n} | ${s||'—'} | ${t||'—'} |\n`;
md+=`
## Napomene

- **Tribina** se zbraja preko ${trib.length} playlisti emisija s kanala @Tribina_HR (Tribina NFL, HNL ponedjeljak, F1 puls, Fantasy…). Video koji je u više playlisti broji se jednom.
- **Apparatus: Glave**: provjereno 06.11., nijedna epizoda se ne ponavlja u druge dvije Apparatus emisije (0 od 197). Zadnja epizoda je iz svibnja 2026., pa je emisija trenutačno neaktivna.
- **book&zvook (bookaravision)** zadnju je epizodu objavio ${d(rows.find(r=>r.name.startsWith('book')).last)} i trenutačno je neaktivan.
- **Podcast Inkubator** ima ${fmtN(rows.find(r=>r.name==='Podcast Inkubator').der)} isječaka uz originale. Broj epizoda ovisi o pragu (${Math.round(rows.find(r=>r.name==='Podcast Inkubator').min/60)} min), pa je usporediv s procjenom iz registryja (1405), ali nije službeni broj.
- **Rastući s djecom** ima na YouTubeu upisanu državu BiH, a podcast je na hrvatskom jeziku.
- **Podcasting for Solopreneurs** je hrvatska autorica (Anja Lordanić) koja snima na engleskom. Epizode su kratke, pa joj je prag 5 min.
- Brojke epizoda su donja granica za kanale koji dio epizoda imaju samo na Spotifyju/RSS-u (npr. audio-only ranih godina).
`;
fs.writeFileSync(process.argv[3],md);console.log('ok');
