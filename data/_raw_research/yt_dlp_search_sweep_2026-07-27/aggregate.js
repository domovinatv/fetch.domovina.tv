const fs=require('fs'),path=require('path');
const SP=process.argv[2];
const reg=JSON.parse(fs.readFileSync('data/podcasts_registry.json','utf8'));
const known=new Set();
reg.podcasts.forEach(p=>{
  const y=p.youtube||{};
  if(y.handle) known.add(y.handle.toLowerCase().replace(/[^a-z0-9]/g,''));
  if(y.channel_id) known.add(y.channel_id);
  if(y.url){const m=y.url.match(/channel\/([\w-]+)/); if(m) known.add(m[1]);}
  known.add((p.display_name||'').toLowerCase().replace(/[^a-z0-9]/g,''));
});
const ch={};
for(const f of fs.readdirSync(SP+'/sweep')){
  for(const line of fs.readFileSync(SP+'/sweep/'+f,'utf8').split('\n')){
    const [name,url,dur,title,cat]=line.split(String.raw`\t`);
    if(!name||!url||url==='NA') continue;
    const d=parseFloat(dur); if(isNaN(d)||d<1800) continue;
    const id=(url.match(/channel\/([\w-]+)/)||[])[1]||url;
    ch[id]=ch[id]||{name,url,id,hits:0,cats:new Set(),titles:[],maxDur:0};
    ch[id].hits++; ch[id].cats.add(cat); ch[id].maxDur=Math.max(ch[id].maxDur,d);
    if(ch[id].titles.length<3) ch[id].titles.push(title);
  }
}
const isKnown=c=>known.has(c.id)||known.has(c.name.toLowerCase().replace(/[^a-z0-9]/g,''));
const nw=Object.values(ch).filter(c=>!isKnown(c)).sort((a,b)=>b.hits-a.hits);
console.log('ukupno kanala u sweepu:',Object.values(ch).length,'| poznatih:',Object.values(ch).length-nw.length,'| NOVIH:',nw.length);
fs.writeFileSync(SP+'/new_channels.json',JSON.stringify(nw.map(c=>({...c,cats:[...c.cats]})),null,2));
nw.forEach(c=>console.log(String(c.hits).padStart(3),'|',[...c.cats].join(','),'|',c.name,'|',c.url));
