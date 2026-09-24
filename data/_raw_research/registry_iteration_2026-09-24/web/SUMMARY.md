# Web research HR YouTube podcasta — 2026-09-24

87 verificiranih kandidata (yt-dlp): 15 samostalnih kanala + 72 playliste; 21 high / 49 medium / 17 low confidence. 259 odbijenih s razlogom (`rejected.json`). Dedupe protiv registryja po `channel_id` / `playlist_id`.

## Najplodniji izvori

1. **YouTube tab `/podcasts` medijskih kanala** (`/channel/<UC…>/podcasts`) — daleko najbolji: sve 22 HRT podcast playliste, HKM, HNS, Matica hrvatska, Nova TV, RTL, Večernji, Bljesak. Handle URL zna vratiti „nema podcasts taba" — koristi channel_id. → pretvoreno u `discover.js podcasts-tab` + `data/discovery/media_channels.txt`.
2. `/playlists` enumeracija kanala + provjera trajanja.
3. Apple Podcasts HR chart (Occamova britva, Andromeda, Sara Peranić).
4. Netokracija vodič (Filmopedija, Roze Koze, Tomislav Krajačić Talk, Zmajeva Garaža…) — većina već u registryju.
5. YouTube kanal medija: homepage + grep YouTube linkova; pogođeni `@handle` uglavnom 404.

Po roditelju: HRT 14, Večernji 9, Bljesak.info 8, TV Jadran 6, Jutarnji 5, HKM 5, N1 3, RTL 3, ostali 1–3; 15 samostalnih.

Bez kandidata: Index.hr, tportal, Slobodna Dalmacija, Novi list, Glas Istre, Direktno.hr, Bloomberg Adria, Faktograf, Dnevno, banke, HDZ, SDP (samo tribine 2020).

## Zamke

- Datumi su približni (YouTube „prije N mj."), `last_upload` ±1 mj.
- Broj epizoda velikih kanala je donja granica (skenirano ≤300 videa).
- Playliste kanala koji su u registryju kao cijeli kanal su u `rejected.json` (Laudato, Z1, VIDA, Poslovni dnevnik, srednja.hr, Most) — kandidati za playlist-unose ako se ti kanali prate: Z1 Press klub (188), Hrvatske povijesne istine (88); Laudato Novo srce (167), Nota bene (90); VIDA Zavidavanje (169), Kontrapovijest (74); Poslovni svijet s I. Jandrićem (71).
- N1 kanal je regionalan: Idemo dalje (SR), Izvan okvira / Druga strana (BA) odbijeni.
- Medijske playliste miješaju cijele emisije i isječke (Večernji, HRT Otvoreno) → `derivative_risk: high`, `suggested_min_duration_sec` ≥1800.
- Granični: HRT KRIK = radio drama (odbijen); HRT The Home Team Podcast = engleski (dijaspora, low); Bljesak.info (Mostar) često bošnjački/regionalni gosti.
- Duplikati: Bljesak „Rastući s djecom" = re-publikacija `rastuci-s-djecom`; kanal „Domaćin" re-uploada Povijest četvrtkom; TV Jadran „Bez pardona" vjerojatno = `bez-pardona`.
- Apple HR chart sadrži srpske podcaste (ALARM, Tragovi/CINS, Agelast, Nauka u kadru).
- TV razgovorne emisije (Točka na tjedan, Na prvoj crti, Bujica, TV Jadran/VTV) označene `tv-talk-show`.
