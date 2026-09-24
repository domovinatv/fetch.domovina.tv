// Gradi candidates.json + rejected.json iz triage.json, classified*.json, probe_playlists/.
const fs=require('fs'),SP=__dirname;
const tri=JSON.parse(fs.readFileSync(SP+'/triage.json','utf8'));
const rows=[...tri.strong,...tri.maybe,...tri.weak]; const byId={}; rows.forEach(r=>byId[r.id]=r);
const cls=JSON.parse(fs.readFileSync(SP+'/classified.json','utf8'));
const clp=JSON.parse(fs.readFileSync(SP+'/classified_playlists.json','utf8'));
const plc={}; fs.readFileSync(SP+'/playlist_candidates.txt','utf8').trim().split('\n').forEach(l=>{const[ch,pl]=l.split(' ');plc[pl]=ch;});
const rr=JSON.parse(fs.readFileSync(SP+'/reject_reasons.json','utf8'));
const CUT90='20260626', fmtD=d=>d?d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6):null;
const RSN={sr:'srpski',bs:'bosanski / BiH nehrvatski',tv:'TV/radio/medijska kuća, ne podcast',ai:'AI-sinkronizirani/generirani dokumentarci ili priče',audiobook:'audio knjige (ne podcast, autorska prava)',reupload:'re-upload tuđih emisija (npr. Povijest četvrtkom već u registryju)',events:'institucionalna događanja/predavanja/tribine/stranački kanal',vlog:'vlog/gameplay/tutorial/kratki video, ne razgovorni podcast',hr_minor:'HR, ali premalo pravih epizoda / uglavnom kratki ili miješani sadržaj',existing:'već u registryju (stub bez channel_id ili handle) — kandidat za enrichment, ne novi'};
const reasonOf={}; for(const[k,ids] of Object.entries(rr)) ids.forEach(id=>reasonOf[id]=RSN[k]);
function stats(vids){ // vids: [{d,u,t}]
  const w=vids.filter(v=>v.d!=null); const L=w.filter(v=>v.d>=1800), S=w.filter(v=>v.d<600);
  const dates=vids.map(v=>v.u).filter(Boolean).sort();
  const ds=w.map(v=>v.d).sort((a,b)=>a-b); let gap=0,thr=null;
  for(let i=1;i<ds.length;i++){ if(ds[i]<300||ds[i-1]>=1800) continue; const g=ds[i]-ds[i-1]; if(g>gap){gap=g;thr=(ds[i]+ds[i-1])/2;} }
  if(thr==null||!S.length&&ds[0]>=1200) thr=Math.min(1200,Math.floor(ds[0]*0.8));
  thr=Math.max(600,Math.min(1800,Math.round(thr/60)*60));
  const titles=w.map(v=>(v.t||'').toLowerCase().slice(0,40)); const dup=titles.length-new Set(titles).size;
  const sr=S.length/(w.length||1); const dr=(sr>0.35||dup/(w.length||1)>0.15)?'high':(sr>0.15||dup>2)?'medium':'low';
  return {long_episodes:L.length,sampled:w.length,avg_duration_min:L.length?Math.round(L.reduce((a,b)=>a+b.d,0)/L.length/60):0,
    first_upload:fmtD(dates[0]),last_upload:fmtD(dates[dates.length-1]),uploads_last_90d:vids.filter(v=>v.u&&v.u>=CUT90).length,
    derivative_risk:dr,suggested_min_duration_sec:thr,short_ratio:+sr.toFixed(2)};
}
function readTsv(f){ if(!fs.existsSync(f)) return {vids:[],subs:null}; let subs=null; const vids=[];
  for(const l of fs.readFileSync(f,'utf8').split('\n')){ if(!l) continue; const p=l.split(';;'); if(p[0]==='META'){subs=parseInt(p[1])||null;continue;}
    const d=parseFloat(p[0]); vids.push({d:isNaN(d)?null:d,u:/^\d{8}$/.test(p[1])?p[1]:null,id:p[2],t:p[3]}); } return {vids,subs}; }
const out=[];
for(const [id,[name,tags,conf,ev]] of Object.entries(cls)){
  const a=readTsv(SP+'/probe/'+id+'.tsv'), b=readTsv(SP+'/probe_streams/'+id+'.tsv');
  const seen=new Set(a.vids.map(v=>v.id)); const vids=[...a.vids,...b.vids.filter(v=>!seen.has(v.id))];
  const s=stats(vids); if(id==='UC9E5DkcSknr4eN5DISCB3Mg') s.suggested_min_duration_sec=1500; const live=b.vids.filter(v=>v.d>=1800).length;
  out.push({display_name:name,youtube_url:`https://www.youtube.com/channel/${id}/videos`,type:'channel',channel_id:id,playlist_id:null,parent_channel:null,
    follower_count:a.subs,long_episodes:s.long_episodes,avg_duration_min:s.avg_duration_min,first_upload:s.first_upload,last_upload:s.last_upload,
    uploads_last_90d:s.uploads_last_90d,tags,language:'hr',confidence:conf,derivative_risk:s.derivative_risk,suggested_min_duration_sec:s.suggested_min_duration_sec,
    evidence:`${ev}. Uzorak: ${s.long_episodes}/${s.sampled} ≥30 min${live?`, od toga ${live} live (/streams)`:''}, kratkih <10 min ${Math.round(s.short_ratio*100)} %.`});
}
for(const [pl,[name,tags,conf,ev]] of Object.entries(clp)){
  const ch=plc[pl]; const a=readTsv(SP+'/probe_playlists/'+pl+'.tsv'); const parent=byId[ch];
  const s=stats(a.vids);
  out.push({display_name:name,youtube_url:`https://www.youtube.com/playlist?list=${pl}`,type:'playlist',channel_id:ch,playlist_id:pl,
    parent_channel:{name:parent?parent.name:null,url:`https://www.youtube.com/channel/${ch}`},follower_count:parent?parent.subs:null,
    long_episodes:s.long_episodes,avg_duration_min:s.avg_duration_min,first_upload:s.first_upload,last_upload:s.last_upload,uploads_last_90d:s.uploads_last_90d,
    tags,language:'hr',confidence:conf,derivative_risk:s.derivative_risk,suggested_min_duration_sec:s.suggested_min_duration_sec,
    evidence:`${ev}. Playlista: ${s.long_episodes}/${s.sampled} ≥30 min.`});
}
const co={high:0,medium:1,low:2}; out.sort((x,y)=>co[x.confidence]-co[y.confidence]||(y.follower_count||0)-(x.follower_count||0));
fs.writeFileSync(SP+'/candidates.json',JSON.stringify(out,null,1));
const acc=new Set(Object.keys(cls)); Object.values(plc).forEach(c=>acc.add(c));
const rej=[];
for(const r of rows){ if(acc.has(r.id)&&!(rr.existing||[]).includes(r.id)) continue;
  let why=reasonOf[r.id];
  if(!why) why= tri.weak.includes(r)?`ne prolazi triage: ${r.longs}/${r.sampled} ≥30 min, avg ${r.avgLongMin} min`:'strani jezik (EN/ostali) — van HR scopea';
  rej.push({name:r.name,channel_id:r.id,reason:why}); }
// kanali bez probe (nema /videos taba)
const cands=JSON.parse(fs.readFileSync(SP+'/new_channels.json','utf8'));
cands.filter(c=>!byId[c.id]).forEach(c=>rej.push({name:c.name,channel_id:c.id,reason:'probe neuspješan (kanal nema /videos tab ili prazan)'}));
rej.push({name:'Pametni ljudi (COO Čakovec) — playlista PLS9hJy-IsPT0ZJM84vvZU1ue_HoqUYYmf',channel_id:'UCvIcKYF3DHMmTEbhku0is6w',reason:'već u registryju kao stub "pametni-ljudi" bez URL-a — ovo je njegov URL (enrichment)'});
fs.writeFileSync(SP+'/rejected.json',JSON.stringify(rej,null,1));
const c={}; out.forEach(x=>{c[x.confidence]=(c[x.confidence]||0)+1;});
const rc={}; rej.forEach(x=>{const k=x.reason.split(':')[0].split('(')[0].trim(); rc[k]=(rc[k]||0)+1;});
console.log('candidates',out.length,c,'channels',out.filter(x=>x.type==='channel').length,'playlists',out.filter(x=>x.type==='playlist').length,'| rejected',rej.length); console.log(rc);
