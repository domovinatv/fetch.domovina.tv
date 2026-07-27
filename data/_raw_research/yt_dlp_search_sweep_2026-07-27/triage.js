const fs=require('fs'),SP=process.argv[2];
const cands=JSON.parse(fs.readFileSync(SP+'/new_channels.json','utf8'));
const rows=[];
for(const c of cands){
  const f=SP+'/probe/'+c.id+'.tsv';
  if(!fs.existsSync(f)) continue;
  const vids=fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean)
    .map(l=>{const[d,u,t]=l.split(';;');return{d:parseFloat(d),u,t}}).filter(v=>!isNaN(v.d));
  if(!vids.length) continue;
  const longs=vids.filter(v=>v.d>=1800);
  const meta=fs.existsSync(SP+'/probe/'+c.id+'.meta')?fs.readFileSync(SP+'/probe/'+c.id+'.meta','utf8').trim().split(';;'):[];
  const subs=parseInt(meta[1])||null, last=meta[2]&&/^\d{8}$/.test(meta[2])?meta[2]:null;
  const avgLong=longs.length?Math.round(longs.reduce((a,b)=>a+b.d,0)/longs.length/60):0;
  rows.push({name:c.name,id:c.id,url:c.url,cats:[...c.cats],hits:c.hits,
    sampled:vids.length,longs:longs.length,longRatio:+(longs.length/vids.length).toFixed(2),
    avgLongMin:avgLong,subs,last,sample:longs.slice(0,2).map(v=>v.t)});
}
// podcast-likelihood: >=8 dugih epizoda I >=35% kataloga dugo I avg >=35min
const strong=rows.filter(r=>r.longs>=8&&r.longRatio>=0.35&&r.avgLongMin>=35);
const maybe=rows.filter(r=>!strong.includes(r)&&r.longs>=5&&r.avgLongMin>=30);
fs.writeFileSync(SP+'/triage.json',JSON.stringify({strong,maybe,all:rows},null,2));
const fmt=r=>`${String(r.longs).padStart(2)}/${String(r.sampled).padStart(2)} ep≥30m  avg ${String(r.avgLongMin).padStart(3)}m  ${r.subs?String(r.subs).padStart(7):'      ?'} subs  ${r.last||'  ?     '}  ${r.name}  [${r.cats.join(',')}]  ${r.url}`;
console.log('=== JAKI KANDIDATI ('+strong.length+') ===');
strong.sort((a,b)=>(b.subs||0)-(a.subs||0)).forEach(r=>console.log(fmt(r)));
console.log('\n=== MOŽDA ('+maybe.length+') ===');
maybe.sort((a,b)=>(b.subs||0)-(a.subs||0)).forEach(r=>console.log(fmt(r)));
console.log('\nodbačeno (prekratko/premalo):',rows.length-strong.length-maybe.length);
