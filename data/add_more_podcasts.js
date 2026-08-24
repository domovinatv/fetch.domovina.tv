const fs = require('fs');
const file = './podcasts_registry.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const vjeraINada = {
  "slug": "vjera-i-nada-varazdinska-biskupija",
  "display_name": "Vjera i nada",
  "youtube": {
    "url": "https://www.youtube.com/@VarazdinskaBiskupijaMediji",
    "handle": "@VarazdinskaBiskupijaMediji",
    "type": "playlist"
  },
  "tags": [
    "religion",
    "society"
  ],
  "voditelji": [],
  "metadata": {
    "status": "active"
  },
  "tracking": {
    "enabled": true
  },
  "tier": 4,
  "data_quality": "complete",
  "sources": [
    "manual"
  ],
  "notes": "Serijal / podcast Varaždinske biskupije sa svjedočanstvima, emitiran na VTV-u, Laudato TV-u i YouTube-u.",
  "quality_score": {
    "total": 40,
    "tier": "👀 moderate",
    "breakdown": {
      "activity": 20,
      "catalog": 10,
      "audience": 3,
      "format": 5,
      "substance": 2,
      "verification": 0,
      "recency": 0
    }
  }
};

const danZaPodcast = {
  "slug": "dan-za-podcast-kontra",
  "display_name": "Dan za podcast (Kontra)",
  "youtube": {
    "url": null,
    "handle": "Kontra Agency",
    "type": "channel"
  },
  "tags": [
    "business",
    "technology"
  ],
  "voditelji": [
    "Petar Bogdan",
    "Tibor Trupec"
  ],
  "metadata": {
    "status": "inactive"
  },
  "tracking": {
    "enabled": false,
    "reason_disabled": "Završen u listopadu 2025. Nema novih epizoda."
  },
  "tier": 4,
  "data_quality": "partial",
  "sources": [
    "manual"
  ],
  "notes": "Poslovni podcast digitalne agencije Kontra. Ugašen krajem 2025.",
  "quality_score": {
    "total": 35,
    "tier": "👀 moderate",
    "breakdown": {
      "activity": 0,
      "catalog": 15,
      "audience": 5,
      "format": 10,
      "substance": 5,
      "verification": 0,
      "recency": 0
    }
  }
};

// Idempotentno: registry je SSOT i dvostruki slug bi razbio upsert u
// `vote_candidates` (FK s glasova). Ponovno pokretanje skripte ne smije duplati.
for (const entry of [vjeraINada, danZaPodcast]) {
  if (data.podcasts.some(p => p.slug === entry.slug)) {
    console.log(`Preskačem — ${entry.slug} već postoji u registryju.`);
    continue;
  }
  data.podcasts.push(entry);
}

fs.writeFileSync(file, JSON.stringify(data, null, 2));
console.log("Dodana Vjera i nada te Dan za podcast!");
