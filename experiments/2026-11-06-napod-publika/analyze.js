#!/usr/bin/env node
// NaPOD 2026: procjena publike iz podataka koje je skupio fetch_audience.js. Nula API poziva.
// Ispis: data/output/audience.json + data/output/audience.md (poglavlje za izvještaj).
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'data', 'output');
const plan = JSON.parse(fs.readFileSync(path.join(OUT, 'plan.json')));
const comments = fs.readFileSync(path.join(OUT, 'comments.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const authorCountry = JSON.parse(fs.readFileSync(path.join(OUT, 'author_countries.json')));
const TODAY = new Date('2026-11-06');
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const fmt = n => n == null || isNaN(n) ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' M' : n >= 1e4 ? Math.round(n / 1e3) + ' k' : Math.round(n).toLocaleString('hr-HR');
const pct = x => x == null || isNaN(x) ? '—' : (x * 100).toFixed(x < 0.1 ? 1 : 0).replace('.', ',') + ' %';
const FLAG = { HR: '🇭🇷', BA: '🇧🇦', RS: '🇷🇸', SI: '🇸🇮' };

// ---------- 1) gledanost po epizodi ----------
const units = plan.map(p => {
  const aged = p.videos.filter(v => (TODAY - new Date(v.date)) / 864e5 >= 14);   // svježe epizode još skupljaju preglede
  const use = aged.length >= 3 ? aged : p.videos;
  return { name: p.name, country: p.country, nEp: use.length, medViews: median(use.map(v => v.views)), medLikes: median(use.map(v => v.likes)), medComments: median(use.map(v => v.comments)), sumViews: p.videos.reduce((a, v) => a + v.views, 0), firstDate: p.videos[p.videos.length - 1]?.date, lastDate: p.videos[0]?.date };
});
const U = Object.fromEntries(units.map(u => [u.name, u]));

// ---------- 2) komentatori i preklapanje ----------
const byUnit = {};
const videoOrder = {};
for (const p of plan) p.videos.forEach((v, i) => (videoOrder[v.id] = i));
for (const c of comments) {
  if (!c.author) continue;
  const o = (byUnit[c.unit] ||= { all: new Set(), odd: new Set(), even: new Set() });
  o.all.add(c.author);
  (videoOrder[c.video] % 2 ? o.odd : o.even).add(c.author);
}
// Lincoln–Petersen unutar podcasta: parne vs neparne epizode → procjena "populacije komentatora" i pokrivenosti uzorka
for (const u of units) {
  const o = byUnit[u.name];
  if (!o) { u.commenters = 0; continue; }
  u.commenters = o.all.size;
  const m = [...o.odd].filter(a => o.even.has(a)).length;
  if (m >= 10) {
    const N = ((o.odd.size + 1) * (o.even.size + 1)) / (m + 1) - 1;   // Chapman
    u.lpN = N; u.coverage = Math.min(1, o.all.size / N);
  }
}
// Preklapanje: koliki dio komentatora podcasta A komentira i na barem jednom drugom podcastu iz popisa
const names = units.map(u => u.name);
const owner = {};
for (const n of names) for (const a of byUnit[n]?.all || []) (owner[a] ||= new Set()).add(n);
for (const u of units) {
  const all = byUnit[u.name]?.all || new Set();
  u.sharedObs = all.size ? [...all].filter(a => owner[a].size > 1).length / all.size : null;
}
const totalAuthors = Object.keys(owner).length;
const sumAuthors = names.reduce((a, n) => a + (byUnit[n]?.all.size || 0), 0);
const multi = Object.values(owner).filter(s => s.size > 1).length;
// Pari s najvećim preklapanjem (Jaccard)
const pairs = [];
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
  const A = byUnit[names[i]]?.all, B = byUnit[names[j]]?.all;
  if (!A || !B || A.size < 30 || B.size < 30) continue;
  const inter = [...A].filter(a => B.has(a)).length;
  if (!inter) continue;
  pairs.push({ a: names[i], b: names[j], inter, jac: inter / (A.size + B.size - inter), ofSmaller: inter / Math.min(A.size, B.size) });
}
pairs.sort((x, y) => y.inter - x.inter);
// Korigirano preklapanje parova: opaženo presjecište / (pokrivenost A × pokrivenost B)
let corrOverlapSum = 0, sumN = 0;
for (const u of units) if (u.lpN) sumN += u.lpN;
for (const pr of pairs) {
  const ca = U[pr.a].coverage, cb = U[pr.b].coverage;
  if (ca && cb) { pr.corr = pr.inter / (ca * cb); corrOverlapSum += pr.corr; pr.corrPct = pr.corr / Math.min(U[pr.a].lpN, U[pr.b].lpN); }
}
// Faktor deduplikacije: opaženo (donja granica preklapanja) i korigirano (Bonferroni 2. reda nad procijenjenim populacijama)
const dedupObserved = totalAuthors / sumAuthors;
const dedupCorrected = sumN ? Math.max(0.3, (sumN - corrOverlapSum) / sumN) : null;

// ---------- 3) geografija ----------
const COUNTRY_GROUPS = { HR: 'Hrvatska', BA: 'BiH', RS: 'Srbija', SI: 'Slovenija', ME: 'Crna Gora', MK: 'S. Makedonija' };
const DIASPORA_EU = new Set(['DE', 'AT', 'CH', 'IE', 'GB', 'SE', 'NO', 'DK', 'NL', 'BE', 'FR', 'IT', 'ES', 'LU']);
const OVERSEAS = new Set(['US', 'CA', 'AU', 'NZ', 'AR', 'CL', 'BR', 'ZA']);
const geoBucket = c => !c ? null : COUNTRY_GROUPS[c] ? 'regija' : DIASPORA_EU.has(c) ? 'Zap. Europa' : OVERSEAS.has(c) ? 'prekomorske' : 'ostalo';
// a) država s kanala komentatora (po komentatoru, ne po komentaru)
const geoBy = {};
for (const [a, us] of Object.entries(owner)) {
  const c = authorCountry[a]; if (!c) continue;
  for (const n of us) { const g = (geoBy[U[n].country] ||= { n: 0, b: {}, c: {} }); g.n++; g.b[geoBucket(c)] = (g.b[geoBucket(c)] || 0) + 1; g.c[c] = (g.c[c] || 0) + 1; }
}
// b) sat komentara po zagrebačkom vremenu
const zgHour = iso => +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zagreb', hour: '2-digit', hour12: false }).format(new Date(iso)) % 24;
const hours = {};
for (const c of comments) { const k = U[c.unit].country; (hours[k] ||= Array(24).fill(0))[zgHour(c.at)]++; }
const nightShare = h => { const t = h.reduce((a, x) => a + x, 0); return [3, 4, 5, 6].reduce((a, i) => a + h[i], 0) / t; };
// c) jezik / pismo komentara
const RX = {
  cyr: /[Ѐ-ӿ]/,
  sl: /\b(zelo|hvala lepa|tudi|vendar|mogoče|ker|nisem|sem|bilo je|oddaj[aei]|podkast)\b/i,
  ek: /\b(vreme|lepo|lep[aeiu]?|reč|dete|deca|mesto|ovde|uopšte|pesm\w*|svet[aeu]?|mleko|cela|celo|sećam|vek[aeu]?|nedelj\w*|bež\w*|hteo|htela)\b/i,
  ijek: /\b(vrijeme|lijepo|lijep[aeiu]?|riječ|dijete|djeca|mjesto|ovdje|uopće|pjesm\w*|svijet[aeu]?|mlijeko|cijela|cijelo|sjećam|vijek[aeu]?|nedjelj\w*|bjež\w*|htio|htjela|prije)\b/i,
  en: /\b(the|and|you|this|thank you|great|episode|what|with)\b/i,
  de: /\b(und|ich|nicht|das|sehr|danke|aber)\b/i,
};
const lang = {};
for (const c of comments) {
  const k = U[c.unit].country, t = c.text || '';
  const L = (lang[k] ||= { n: 0, cyr: 0, sl: 0, ek: 0, ijek: 0, en: 0, de: 0 });
  L.n++;
  if (RX.cyr.test(t)) { L.cyr++; continue; }
  for (const key of ['sl', 'ek', 'ijek']) if (RX[key].test(t)) L[key]++;
  if (RX.en.test(t) && !RX.ijek.test(t) && !RX.ek.test(t)) L.en++;
  if (RX.de.test(t)) L.de++;
}

// ---------- procjena publike ----------
const regulars = units.reduce((a, u) => a + (u.medViews || 0), 0);
const est = { sumMedViews: regulars, dedupObserved, dedupCorrected, uniqueLow: regulars * (dedupCorrected ?? dedupObserved), uniqueHigh: regulars * dedupObserved };

fs.writeFileSync(path.join(OUT, 'audience.json'), JSON.stringify({ units, pairs: pairs.slice(0, 25), totalAuthors, sumAuthors, multi, geoBy, hours, lang, est }, null, 1));

// ---------- markdown ----------
const order = ['HR', 'BA', 'RS', 'SI'];
let md = `## Procjena publike\n\nYouTube ne objavljuje koliko *različitih ljudi* gleda kanal ni odakle su; to vidi samo autor u YouTube Studiju. Ovo je procjena izvana, iz javnih podataka (YouTube Data API, 06.11.2026., 539 jedinica kvote, $0): pregledi zadnjih do 20 epizoda po podcastu i **${fmt(comments.length)} komentara** od **${fmt(totalAuthors)} različitih komentatora** na tim epizodama.\n\n`;
md += `### Koliko ljudi redovito gleda\n\nMjera je **medijan pregleda po epizodi** (epizode starije od 14 dana, jer nove još skupljaju preglede). To je približno broj ljudi koji pogleda tipičnu epizodu, bolja mjera od pratitelja koji se nakupljaju godinama. Pregled nije osoba: isti čovjek može pogledati dvaput, a jedan pregled na TV-u može biti cijela obitelj.\n\n| Podcast | Država | Medijan pregleda / epizodi | Lajkova | Komentara | Komentatora u uzorku | Dio komentatora koji komentira i drugdje |\n|---|:-:|--:|--:|--:|--:|--:|\n`;
for (const u of [...units].sort((a, b) => b.medViews - a.medViews)) md += `| ${u.name} | ${FLAG[u.country]} | ${fmt(u.medViews)} | ${fmt(u.medLikes)} | ${fmt(u.medComments)} | ${fmt(u.commenters)} | ${u.commenters >= 30 ? pct(u.sharedObs) : '—'} |\n`;
md += `| **Zbroj** | | **${fmt(regulars)}** | | | **${fmt(sumAuthors)}** | |\n\n`;
md += `Zbroj po državama: ` + order.map(k => `${FLAG[k]} ${fmt(units.filter(u => u.country === k).reduce((a, u) => a + (u.medViews || 0), 0))}`).join(' · ') + `.\n\n`;

md += `### Koliko se publike preklapa\n\nOd ${fmt(totalAuthors)} komentatora njih **${fmt(multi)} (${pct(multi / totalAuthors)})** komentiralo je na barem dva različita podcasta s popisa. To je **donja granica** preklapanja: vidimo samo ljude koji su slučajno komentirali na oba mjesta u ovih 20 epizoda.\n\nKorekcija za nepotpun uzorak: za svaki podcast komentatori parnih i neparnih epizoda daju procjenu koliko komentatora podcast stvarno ima (metoda ulova i ponovnog ulova, Lincoln–Petersen/Chapman). Opaženo preklapanje para zatim se podijeli pokrivenošću uzorka oba podcasta.\n\n| Par | Zajedničkih komentatora | % manjeg podcasta | Korigirano: % manjeg podcasta |\n|---|--:|--:|--:|\n`;
for (const pr of pairs.slice(0, 12)) md += `| ${pr.a} ↔ ${pr.b} | ${pr.inter} | ${pct(pr.ofSmaller)} | ${pr.corrPct ? pct(Math.min(1, pr.corrPct)) : '—'} |\n`;
md += `\n**Faktor deduplikacije** (koliki dio zbroja su različiti ljudi): opaženo **${pct(dedupObserved)}**, korigirano **${pct(dedupCorrected)}**.\n\n`;
md += `> **Procjena: tipičnu epizodu nekog od ovih podcasta gleda otprilike ${fmt(Math.round(est.uniqueLow / 1e3) * 1e3)}–${fmt(Math.round(est.uniqueHigh / 1e3) * 1e3)} različitih ljudi** (zbroj medijana × faktor deduplikacije). Godišnji doseg je veći, jer ne gledaju svi svaku epizodu.\n\n`;
md += `Zašto je raspon širok: komentatori su najangažiraniji 1–3 % publike i vjerojatno prate više podcasta od prosječnog gledatelja, pa korigirana brojka može precijeniti preklapanje. Opažena brojka ga sigurno podcjenjuje. Prava vrijednost je između.\n\n`;

md += `### Odakle je publika\n\nTri neizravna signala, svaki sa svojom slabošću.\n\n**a) Država upisana na kanalu komentatora.** Upisalo ju je samo ${fmt(Object.values(authorCountry).filter(Boolean).length)} od ${fmt(totalAuthors)} komentatora (${pct(Object.values(authorCountry).filter(Boolean).length / totalAuthors)}), pa je ovo mali uzorak; to su uglavnom ljudi koji i sami objavljuju na YouTubeu.\n\n| Publika podcasta iz | Komentatora s državom | Regija (HR, BiH, RS, SI, ME, MK) | Zapadna Europa | Prekomorske (SAD, Kanada, Australija…) | Ostalo | Najčešće države |\n|---|--:|--:|--:|--:|--:|---|\n`;
for (const k of order) {
  const g = geoBy[k]; if (!g) continue;
  const top = Object.entries(g.c).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c} ${n}`).join(', ');
  md += `| ${FLAG[k]} ${COUNTRY_GROUPS[k]} | ${g.n} | ${pct((g.b['regija'] || 0) / g.n)} | ${pct((g.b['Zap. Europa'] || 0) / g.n)} | ${pct((g.b['prekomorske'] || 0) / g.n)} | ${pct((g.b['ostalo'] || 0) / g.n)} | ${top} |\n`;
}
md += `\n**b) Doba dana komentara (zagrebačko vrijeme).** Između 3 i 7 sati ujutro regija uglavnom spava, a u Sjevernoj Americi je večer. Udio komentara u tom prozoru je grubi pokazatelj prekomorske dijaspore.\n\n| Publika podcasta iz | Komentara | Udio 03–07 h |\n|---|--:|--:|\n`;
for (const k of order) if (hours[k]) md += `| ${FLAG[k]} ${COUNTRY_GROUPS[k]} | ${fmt(hours[k].reduce((a, x) => a + x, 0))} | ${pct(nightShare(hours[k]))} |\n`;
md += `\n**c) Jezik i pismo komentara.** Prepoznavanje po tipičnim riječima (kajkavski u Hrvatskoj daje dio „ekavice”), pa većina kratkih komentara ostane neodređena. Važan je omjer, ne apsolutni udio.\n\n| Publika podcasta iz | Komentara | Ćirilica | Ekavica | Ijekavica | Slovenski | Engleski | Njemački |\n|---|--:|--:|--:|--:|--:|--:|--:|\n`;
for (const k of order) { const L = lang[k]; if (L) md += `| ${FLAG[k]} ${COUNTRY_GROUPS[k]} | ${fmt(L.n)} | ${pct(L.cyr / L.n)} | ${pct(L.ek / L.n)} | ${pct(L.ijek / L.n)} | ${pct(L.sl / L.n)} | ${pct(L.en / L.n)} | ${pct(L.de / L.n)} |\n`; }
fs.writeFileSync(path.join(OUT, 'audience.md'), md);
console.log(md);
