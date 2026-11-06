#!/usr/bin/env node
// NaPOD 2026: dohvat podataka za procjenu publike (YouTube Data API v3, samo čitanje).
//  1) statistika videa za zadnjih <=20 originala po podcastu (videos.list, 1 jedinica / 50 videa)
//  2) komentari tih videa (commentThreads.list + replies, 1 jedinica / stranica od 100)
//  3) država s kanala komentatora (channels.list, 1 jedinica / 50 kanala)
// Svaki odgovor se kešira u data/output/cache/, pa ponovni run ne troši kvotu.
// Pokretanje iz korijena repoa: node experiments/2026-11-06-napod-publika/fetch_audience.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'data', 'output');
const CACHE = path.join(ROOT, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
const KEY = fs.readFileSync('.env', 'utf8').match(/^YOUTUBE_API_KEY=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '');
const MAX_EP = 20;            // epizoda po podcastu
const MAX_PAGES = 10;         // max 1000 top-level komentara po videu
let units = 0;

// Podcast jedinice (Apparatus spojen u jedan kanal za preklapanje publike)
const UNITS = [
  ['Podcast Inkubator', 'HR', ['podcast-inkubator']],
  ['LOOD', 'HR', ['lood-podcast']],
  ['Explora (HRT)', 'HR', ['explora-hrt']],
  ['Mjesto zločina', 'HR', ['mjesto-zlocina']],
  ['Špica s Mačanom', 'HR', ['spica-s-macanom']],
  ['Lider', 'HR', ['lider-podcast']],
  ['Netokracija', 'HR', ['netokracija-podcast']],
  ['Tribina', 'HR', null],
  ['La Vie Podcast', 'HR', ['la-vie-podcast']],
  ['Games Croatia', 'HR', ['games-croatia']],
  ['book&zvook', 'HR', ['bookaravision']],
  ['Podcasting for Solopreneurs', 'HR', ['podcasting-for-solopreneurs']],
  ['Rastući s djecom', 'BA', ['rastuci-s-djecom']],
  ['Agelast', 'RS', ['agelast']],
  ['Pojačalo', 'RS', ['pojacalo']],
  ['Tampon zona', 'RS', ['tampon-zona']],
  ['Zdrava priča sa Dolores', 'RS', ['zdrava-prica-sa-dolores']],
  ['Apparatus', 'SI', ['apparatus-ce-ves-kaj-mislim', 'apparatus-opazovalnica', 'apparatus-glave']],
];

function findRegistry() {
  const reg = JSON.parse(fs.readFileSync('data/podcasts_registry.json'));
  const by = {};
  (function w(o) { if (Array.isArray(o)) o.forEach(w); else if (o && typeof o === 'object') { if (o.slug && !by[o.slug]) by[o.slug] = o; Object.values(o).forEach(w); } })(reg);
  return by;
}

async function api(endpoint, params, cacheName) {
  const f = path.join(CACHE, cacheName + '.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f));
  const qs = new URLSearchParams({ ...params, key: KEY });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`);
    units++;
    const j = await res.json();
    if (j.error) {
      const reason = j.error.errors?.[0]?.reason;
      if (reason === 'commentsDisabled' || reason === 'videoNotFound' || reason === 'forbidden') {
        fs.writeFileSync(f, JSON.stringify({ items: [], disabled: reason })); return { items: [], disabled: reason };
      }
      if (reason === 'quotaExceeded') throw new Error('KVOTA POTROŠENA nakon ' + units + ' jedinica');
      if (attempt < 3) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
      throw new Error(endpoint + ' ' + JSON.stringify(j.error).slice(0, 300));
    }
    fs.writeFileSync(f, JSON.stringify(j));
    return j;
  }
}

(async () => {
  const by = findRegistry();
  const bf = JSON.parse(fs.readFileSync('automatic/watchlist/backfill.json')).channels;
  const tribSlugs = by.tribina.child_slugs.filter(s => bf[s]);
  const plan = [];
  for (const [name, country, slugs0] of UNITS) {
    const slugs = slugs0 || tribSlugs;
    const orig = {};
    for (const s of slugs) if (bf[s]) for (const [id, e] of Object.entries(bf[s].originals)) orig[id] = e;
    const eps = Object.entries(orig).filter(([, e]) => e.date).sort((a, b) => (a[1].date < b[1].date ? 1 : -1)).slice(0, MAX_EP);
    plan.push({ name, country, channel_id: by[slugs[0]].youtube.channel_id, videos: eps.map(([id, e]) => ({ id, date: e.date, title: e.title, duration: e.duration })) });
  }

  // 1) statistika videa
  for (const p of plan) {
    const ids = p.videos.map(v => v.id);
    const j = await api('videos', { part: 'statistics', id: ids.join(','), maxResults: 50 }, 'videos_' + ids[0] + '_' + ids.length);
    const st = Object.fromEntries((j.items || []).map(it => [it.id, it.statistics]));
    for (const v of p.videos) { const s = st[v.id] || {}; v.views = +s.viewCount || 0; v.likes = +s.likeCount || 0; v.comments = +s.commentCount || 0; }
  }
  console.log('1) statistika videa gotova, jedinica:', units);

  // 2) komentari
  const comments = [];
  for (const p of plan) {
    let n = 0;
    for (const v of p.videos) {
      let token = '';
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = { part: 'snippet,replies', videoId: v.id, maxResults: 100, textFormat: 'plainText', order: 'time' };
        if (token) params.pageToken = token;
        const j = await api('commentThreads', params, `ct_${v.id}_${page}`);
        for (const t of j.items || []) {
          const all = [t.snippet.topLevelComment, ...((t.replies && t.replies.comments) || [])];
          for (const c of all) {
            const s = c.snippet;
            comments.push({ unit: p.name, video: v.id, author: s.authorChannelId?.value || null, at: s.publishedAt, likes: s.likeCount, text: s.textDisplay });
            n++;
          }
        }
        token = j.nextPageToken;
        if (!token) break;
      }
    }
    console.log(`   ${p.name}: ${n} komentara (jedinica ukupno ${units})`);
  }
  fs.writeFileSync(path.join(ROOT, 'comments.jsonl'), comments.map(c => JSON.stringify(c)).join('\n') + '\n');
  console.log('2) komentari gotovi:', comments.length, 'jedinica:', units);

  // 3) država komentatora
  const authors = [...new Set(comments.map(c => c.author).filter(Boolean))].sort();
  const countries = {};
  for (let i = 0; i < authors.length; i += 50) {
    const chunk = authors.slice(i, i + 50);
    const j = await api('channels', { part: 'snippet', id: chunk.join(','), maxResults: 50 }, 'ch_' + chunk[0] + '_' + chunk.length);
    for (const it of j.items || []) countries[it.id] = it.snippet.country || null;
  }
  fs.writeFileSync(path.join(ROOT, 'author_countries.json'), JSON.stringify(countries));
  fs.writeFileSync(path.join(ROOT, 'plan.json'), JSON.stringify(plan, null, 1));
  console.log('3) države komentatora:', authors.length, 'autora; s državom:', Object.values(countries).filter(Boolean).length);
  console.log('gotovo, ukupno jedinica kvote:', units);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
