// Triage "je li podcast": >=8 ep >=30 min I >=35% kataloga dugo I avg(dugih) >=35 min.
const fs=require('fs'),SP=__dirname;
const cands=JSON.parse(fs.readFileSync(SP+'/new_channels.json','utf8'));
const CUT90='20260626';
const rows=[];
for(const c of cands){
  const f=SP+'/probe/'+c.id+'.tsv'; if(!fs.existsSync(f)) continue;
  let subs=null, vids=[];
  for(const l of fs.readFileSync(f,'utf8').split('\n')){
    if(!l) continue; const p=l.split(';;');
    if(p[0]==='META'){subs=parseInt(p[1])||null;continue;}
    const d=parseFloat(p[0]); vids.push({d:isNaN(d)?null:d,u:/^\d{8}$/.test(p[1])?p[1]:null,id:p[2],t:p[3]});
  }
  // + /streams tab (live podcasti); dedupe po video ID-u
  const fs2=SP+'/probe_streams/'+c.id+'.tsv'; let nStreams=0;
  if(fs.existsSync(fs2)){ const seen=new Set(vids.map(v=>v.id));
    for(const l of fs.readFileSync(fs2,'utf8').split('\n')){ if(!l) continue; const p=l.split(';;'); if(seen.has(p[2])) continue;
      const d=parseFloat(p[0]); vids.push({d:isNaN(d)?null:d,u:/^\d{8}$/.test(p[1])?p[1]:null,id:p[2],t:p[3],live:true}); nStreams++; } }
  const withD=vids.filter(v=>v.d!=null); if(!withD.length) continue;
  const longs=withD.filter(v=>v.d>=1800), shorts=withD.filter(v=>v.d<600);
  const dates=vids.map(v=>v.u).filter(Boolean).sort();
  const avgLong=longs.length?Math.round(longs.reduce((a,b)=>a+b.d,0)/longs.length/60):0;
  // prag: najveći razmak u sortiranim trajanjima između 5 i 40 min
  const ds=withD.map(v=>v.d).sort((a,b)=>a-b); let gap=0,thr=1800;
  for(let i=1;i<ds.length;i++){ if(ds[i]<300||ds[i-1]>2400) continue; const g=ds[i]-ds[i-1]; if(g>gap){gap=g;thr=Math.round((ds[i]+ds[i-1])/2/60)*60;} }
  thr=Math.max(600,Math.min(thr,2400));
  rows.push({name:c.name,id:c.id,url:c.url,cats:c.cats,hits:c.hits,searchTitles:c.titles,
    sampled:withD.length,streams:nStreams,longStreams:withD.filter(v=>v.live&&v.d>=1800).length,longs:longs.length,longRatio:+(longs.length/withD.length).toFixed(2),
    shortRatio:+(shorts.length/withD.length).toFixed(2),avgLongMin:avgLong,subs,
    first:dates[0]||null,last:dates[dates.length-1]||null,last90:vids.filter(v=>v.u&&v.u>=CUT90).length,
    thr,sample:longs.sort((a,b)=>(b.u||'').localeCompare(a.u||'')).slice(0,4).map(v=>v.t),shortSample:shorts.slice(0,2).map(v=>v.t)});
}
const strong=rows.filter(r=>r.longs>=8&&r.longRatio>=0.35&&r.avgLongMin>=35);
const maybe=rows.filter(r=>!strong.includes(r)&&r.longs>=5&&r.avgLongMin>=30);
const weak=rows.filter(r=>!strong.includes(r)&&!maybe.includes(r));
fs.writeFileSync(SP+'/triage.json',JSON.stringify({strong,maybe,weak},null,1));
const fmt=r=>`${r.id} ${String(r.longs).padStart(2)}/${String(r.sampled).padStart(2)} avg${String(r.avgLongMin).padStart(4)}m sh${r.shortRatio} ${String(r.subs||'?').padStart(7)} ${r.first}-${r.last} 90d:${r.last90} | ${r.name} | ${r.sample.slice(0,2).join(' || ')}`;
console.log('=== STRONG',strong.length); strong.sort((a,b)=>(b.subs||0)-(a.subs||0)).forEach(r=>console.log(fmt(r)));
console.log('=== MAYBE',maybe.length); maybe.sort((a,b)=>(b.subs||0)-(a.subs||0)).forEach(r=>console.log(fmt(r)));
console.log('=== WEAK',weak.length);
