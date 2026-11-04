import fs from 'node:fs';
const env = fs.readFileSync('.env','utf8'); const key = env.match(/^PIPELINE_QUEUE_INGEST_KEY=(.*)$/m)[1].replace(/^["']|["']$/g,'');
const BASE='https://pipeline.domovina.ai';
const api = async p => (await fetch(BASE+p,{headers:{authorization:`Bearer ${key}`}})).json();
const jobs=(await api('/api/jobs?limit=500')).jobs, mags=(await api('/api/magisterium?limit=500')).jobs;
fs.writeFileSync(process.argv[2]+'/jobs.json', JSON.stringify({jobs,mags},null,1));
console.log(jobs.length, mags.length, Object.keys(jobs[0]).join(','), '|', Object.keys(mags[0]).join(','));
