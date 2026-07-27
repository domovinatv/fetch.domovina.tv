const fs=require('fs'),SP=process.argv[2];
const P='data/podcasts_registry.json';
const r=JSON.parse(fs.readFileSync(P,'utf8'));
const cls=JSON.parse(fs.readFileSync(SP+'/classified.json','utf8'));
const tri=JSON.parse(fs.readFileSync(SP+'/triage.json','utf8'));
const byId={}; tri.all.forEach(x=>byId[x.id]=x);
const haveId=new Set(r.podcasts.map(p=>p.youtube&&p.youtube.channel_id).filter(Boolean));
const haveSlug=new Set(r.podcasts.map(p=>p.slug));
const ym=d=>d?d.slice(0,4)+'-'+d.slice(4,6):null;
let added=0,skipped=[];
for(const [id,c] of Object.entries(cls)){
  if(haveId.has(id)){skipped.push(c.slug+' (dupe id)');continue;}
  if(haveSlug.has(c.slug)){skipped.push(c.slug+' (dupe slug)');continue;}
  const t=byId[id]; if(!t){skipped.push(c.slug+' (nema probe)');continue;}
  const active = t.last && t.last >= '20260127';
  r.podcasts.push({
    slug:c.slug, display_name:c.name,
    youtube:{url:'https://www.youtube.com/channel/'+id+'/videos', channel_id:id, type:'channel'},
    tags:c.tags, voditelji:[],
    metadata:{
      last_episode: ym(t.last),
      average_duration_minutes: t.avgLongMin,
      episodes_sampled: t.sampled,
      episodes_over_30min_sampled: t.longs,
      subscribers: t.subs,
      status: active?'active':(t.last&&t.last>='20250127'?'active-slowing':'unknown')
    },
    tracking:{enabled:false, reason_disabled:'Backlog kandidat iz yt-dlp search sweepa 2026-07-27 — verificiran format, čeka editorial odluku o praćenju.', candidate_phase:1},
    tier:3, data_quality:'partial',
    sources:['yt-dlp-search-sweep-2026-07'],
    notes:'Otkriven determinističkim yt-dlp ytsearch sweepom po kategorijama; metrike iz probe zadnjih do 60 videa.'
  });
  haveId.add(id); haveSlug.add(c.slug); added++;
}
if(!r.tag_legend['religious-other']) r.tag_legend['religious-other']='Nekatolički vjerski sadržaj (protestantski, međuvjerski, ostalo)';
r.sources=[...new Set([...(r.sources||[]),'yt-dlp-search-sweep-2026-07'])];
r.generated_at='2026-07-27';
fs.writeFileSync(P,JSON.stringify(r,null,2)+'\n');
console.log('dodano:',added,'| preskočeno:',skipped.length, skipped.length?'→ '+skipped.join(', '):'');
console.log('ukupno u registryju:',r.podcasts.length);
