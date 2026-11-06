const fs=require('fs');
const key=fs.readFileSync('.env','utf8').match(/^YOUTUBE_API_KEY=(.*)$/m)[1].trim().replace(/^["']|["']$/g,'');
const reg=JSON.parse(fs.readFileSync('data/podcasts_registry.json'));
const all=[];(function w(o){if(Array.isArray(o))o.forEach(w);else if(o&&typeof o==='object'){if(o.slug&&o.events&&JSON.stringify(o.events).match(/napod/i))all.push(o);Object.values(o).forEach(w);}})(reg);
const ids=[...new Set(all.map(r=>r.youtube?.channel_id).filter(Boolean))];
console.error('bez channel_id:',all.filter(r=>!r.youtube?.channel_id).map(r=>r.slug));
(async()=>{const u=`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${ids.join(',')}&key=${key}`;
const j=await (await fetch(u)).json();const out={};for(const it of j.items||[])out[it.id]={title:it.snippet.title,country:it.snippet.country||null,created:it.snippet.publishedAt,subs:+it.statistics.subscriberCount,videos:+it.statistics.videoCount,views:+it.statistics.viewCount};
if(j.error)console.error(j.error);fs.writeFileSync(process.argv[2],JSON.stringify(out,null,1));console.log(Object.keys(out).length,'od',ids.length);})();
