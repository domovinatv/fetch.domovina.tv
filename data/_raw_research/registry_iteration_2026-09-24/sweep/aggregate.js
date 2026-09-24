// Agregacija sweepa: group po channel_id, dedupe vs registry (_existing.json) + prošli ciklus (2026-07-27).
const fs=require('fs'),path=require('path');
const SP=__dirname, ROOT=path.resolve(SP,'../../../..');
const norm=s=>(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/đ/g,'d').replace(/[^a-z0-9]/g,'');
const ex=JSON.parse(fs.readFileSync(SP+'/../_existing.json','utf8'));
const knownId=new Set(), knownName=new Set();
ex.forEach(p=>{ if(p.channel_id) knownId.add(p.channel_id);
  const m=(p.url||'').match(/channel\/([\w-]+)/); if(m) knownId.add(m[1]);
  if(norm(p.name).length>=5) knownName.add(norm(p.name)); });
const PREV=ROOT+'/data/_raw_research/yt_dlp_search_sweep_2026-07-27';
const prevId=new Set();
JSON.parse(fs.readFileSync(PREV+'/triage.json','utf8')).all.forEach(x=>prevId.add(x.id));
JSON.parse(fs.readFileSync(PREV+'/new_channels_raw.json','utf8')).forEach(x=>prevId.add(x.id));
const ch={}; let rows=0, longRows=0;
for(const f of fs.readdirSync(SP+'/raw').filter(f=>f.endsWith('.tsv'))){
  for(const line of fs.readFileSync(SP+'/raw/'+f,'utf8').split('\n')){
    const [name,cid,url,dur,title,cat]=line.split(';;'); if(!name) continue; rows++;
    if(!cid||cid==='NA') continue;
    const d=parseFloat(dur); if(isNaN(d)||d<1800) continue; longRows++;
    const c=ch[cid]=ch[cid]||{name,id:cid,url:'https://www.youtube.com/channel/'+cid,hits:0,cats:new Set(),titles:[],maxDur:0};
    c.hits++; c.cats.add(cat); c.maxDur=Math.max(c.maxDur,d); if(c.titles.length<4) c.titles.push(title);
  }
}
const all=Object.values(ch);
const st={known:0,prev:0,nameMatch:0};
const nw=all.filter(c=>{ if(knownId.has(c.id)){st.known++;return false;}
  if(prevId.has(c.id)){st.prev++;return false;}
  if(knownName.has(norm(c.name))){st.nameMatch++;return false;} return true;})
  .sort((a,b)=>b.hits-a.hits).map(c=>({...c,cats:[...c.cats]}));
const funnel={result_rows:rows,long_rows:longRows,channels_with_long:all.length,...st,new:nw.length};
console.log(funnel);
fs.writeFileSync(SP+'/new_channels.json',JSON.stringify(nw,null,1));
fs.writeFileSync(SP+'/_funnel_aggregate.json',JSON.stringify(funnel,null,1));
nw.forEach(c=>console.log(String(c.hits).padStart(3),'|',c.cats.join(','),'|',c.name,'|',c.titles[0]));
