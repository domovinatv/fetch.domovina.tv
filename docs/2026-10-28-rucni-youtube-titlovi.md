# Ručni YouTube titlovi: detekcija, download, podcast.domovina.ai (28.10.2026.)

## Povod: „StartupBG” na domovina.ai, „StartupVG” na YouTubeu

Epizoda `QkcpHsj43rE` (AI u praksi, StartupVG) ima dva Soniox prijepisa s **istim**
postavkama (`stt-async-v5`, `language_hints: ["hr"]`, diarizacija uključena):

| | YouTube SRT (`../../stepanic/realtime-presentation/montaza`) | pipeline (domovina.ai) |
|---|---|---|
| audio | `rode.mp3`: RØDE mikrofon, sirova snimka, 8333 s | mp3 skinut s YouTubea: miks montaže, 7517 s |
| Soniox je napisao | „Startup VG” | „StartupBG” |
| završni tekst | „StartupVG”, jer `montaza/scripts/titlovi.py` ima `ISPRAVCI = {"Startup VG": "StartupVG", "Whisper Flow": "Wispr Flow"}` | „StartupBG” |

Riječi se nakon pomaka montaže (809,5 s) poklapaju u 96,5 % slučajeva. Razlika dolazi od
drugog ulaza, a ne od nedeterminizma. Gemini sluh nije dirao tekst (`calls: 0`,
`fallback: 647` u `.gemini.meta.json`; Vertex je isključen).

## Pipeline već skida ručni titl, ali ga ništa ne čita

`fetch.js` ima `--write-subs --sub-lang hr,en`, bez auto-subs. Za praćene kanale
`{base}.hr.srt` / `{base}.en.srt` već leže na disku. Nijedan korak ih ne koristi. Kandidat
za upotrebu: rječnik vlastitih imena (usporediti ručni titl sa Sonioxom i zamijeniti samo
imena). Prepisivanje kanonskog SRT-a ručnim tekstom bilo bi izuzetak od pravila
Soniox → Speechmatics → Canary, pa o tome odlučuje korisnik.

`.en.srt` na disku **nije uvijek ručni**: `backfill_youtube_subs.js` je za EN kanale
(catholic_futurist) skidao automatske `-orig` trackove pod istim imenom. Je li titl ručni,
zna samo `subtitles` u `.info.json`.

## Detekcija je besplatna: `contentDetails.caption`

YouTube Data API `videos.list part=contentDetails` vraća `caption: "true"` **samo za ručne**
titlove. Provjereno na uzorku s diska: 19/20 videa s ručnim titlom → `true` (jedan je
vjerojatno uklonjen nakon downloada), 20/20 bez titla i 10/10 samo s automatskim → `false`.
1 jedinica kvote na 50 videa. `captions.download` traži OAuth vlasnika kanala, pa sam titl
skida yt-dlp.

## Alati

- `node count_progress.js --with-subs`: ručni titlovi po kanalu iz `.info.json` praćenih
  epizoda. Prikazuje stanje u trenutku downloada, pa titl dodan kasnije ne vidi.
- `automatic/fetch_youtube_subs.js` (nightly, iza `backfill_days.js`, prije 5c):
  1. detekcija nad svim originalima iz `backfill.json`. Svaki original se provjeri
     jednom, a zadnjih 30 dana svaki dan iznova (autori titl dodaju naknadno).
  2. yt-dlp `--write-subs --sub-langs "hr.*,en.*"`, **po defaultu samo za epizode objavljene
     od 28.10.2026.** (odluka korisnika: bez backfilla; stari katalog ručno s `--backfill`),
     5 videa po pozivu, nasumična pauza
     8–20 s plus `--sleep-requests 1.5 --sleep-subtitles 3`. Izmjereno ~16 s po videu.
     `requested_subtitles` = NA znači da ručni titl postoji, ali nije HR ni EN; to je
     konačan ishod, ne greška.
  3. `cdn.domovina.ai/registry/subs/<id>.<lang>.srt` s `Content-Disposition: attachment`
     (ime = naslov epizode; atribut `download` cross-origin ne radi). Cloudflare `.srt`
     ne kešira (`cf-cache-status: DYNAMIC`), pa 404 prije uploada ne truje edge.
  4. `automatic/watchlist/subs.json` (commitan) = samo ono što je na CDN-u. Stanje je u
     `subs-state.json`, lokalne kopije u `subs/` (oboje gitignored).
- podcast.domovina.ai: `build-catalog.mjs` čita `subs.json` i dodaje `subs: [...]`
  epizodama, a `src/components/Subs.astro` prikazuje „SRT HR EN” u feedu, na danima i
  na stranici kanala.

## Brojke (prvi prolaz 28.10.2026.)

- Praćeni kanali, disk: ručni titl ima 146 od 3492 epizode u 20 od 57 kanala
  (HR 73, EN 105). EN je na HR kanalima uglavnom prijevod (budi_frajer, neuspjeh_prvaka, hnb).
- Cijeli registry: ručni titl ima 1443 od 43 440 originala (3,3 %) u 92 kanala. Prvi
  prolaz je potrošio 869 jedinica kvote.
- Sustavni (vjerojatno vlastiti ASR/alat pri objavi): prvi-glas-telegram 333/393 (85 %),
  atma-podcast 291/470, spica-s-macanom 106/106, ideje-hr 101/114, projekt-velebit 137/839,
  bijela-kronika 42/129, launched 19/28, karlo-cast 12/26.
- Prestali: lood-podcast (redovito 10/2023–08/2025, u zadnjih 90 dana 0/13),
  podcast-inkubator (do 06/2025).
