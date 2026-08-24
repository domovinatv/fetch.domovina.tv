const fs = require('fs');
const file = './podcasts_registry.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const abbaCast = {
  "slug": "abbacast",
  "display_name": "AbbaCast",
  "youtube": {
    "url": "https://www.youtube.com/@AbbaCastPodcast",
    "handle": "@AbbaCastPodcast",
    "type": "channel"
  },
  "tags": [
    "religion",
    "entrepreneurship",
    "lifestyle"
  ],
  "voditelji": [
    "Antonio Culej",
    "Marija Culej"
  ],
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
  "notes": "Katolički podcast brenda AbbaWear (Antonio i Marija Culej). Svjedočanstva, vjera i poduzetništvo.",
  "quality_score": {
    "total": 55,
    "tier": "👀 moderate",
    "breakdown": {
      "activity": 25,
      "catalog": 10,
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
for (const entry of [abbaCast]) {
  if (data.podcasts.some(p => p.slug === entry.slug)) {
    console.log(`Preskačem — ${entry.slug} već postoji u registryju.`);
    continue;
  }
  data.podcasts.push(entry);
}
fs.writeFileSync(file, JSON.stringify(data, null, 2));
console.log("Dodano!");
