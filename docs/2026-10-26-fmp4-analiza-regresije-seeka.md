# fmp4 „brzi start": što je sve rađeno i zašto seek sad puca (26. 10. 2026.)

## Zaključak

1. **Seek puca zbog popravka od 24.10., ne zbog prvotnog fmp4-a.** Remux s
   `-frag_interleave 25` (bez `+cmaf`) daje datoteku koja se od početka
   dekodira ispravno, ali nakon skoka dekoder sjedne na kadar bez referentnih
   slika. Chrome/Brave tada javi `PIPELINE_ERROR_DECODE: video decode error` i
   video stane; ffmpeg javlja `reference picture missing`, `co located POCs
   unavailable`, `mmco: unref short failure`.
2. **„Zvuk ide, slika stoji / drugo se čuje nego što se vidi"** je ista greška:
   audio track u istom fajlu je ispravan i svira dalje, video dekoder je pao.
3. **„Nakon refresha se video više ne može učitati"** je druga, zasebna greška:
   fajl je 24.10. prepisan na ISTOM URL-u, a CDN ga servira kao
   `Cache-Control: public, max-age=31536000, immutable`. Cloudflare je purgean,
   ali preglednik koji je epizodu gledao prije 24.10. drži stare range-ove i
   lijepi ih s novima (drugi byte offseti) → pokvaren stream bez revalidacije.
4. **`video_h264.mp4` (klasični faststart) je cijelo vrijeme zdrav.** Isti test
   seekova: 0 grešaka. Problem je isključivo `video_h264_fmp4.mp4`.

## Mjerenje na epizodi iz prijave (`ja70p_gJWZA`, nightly 26.10.)

`ffmpeg -ss <t> -i <CDN url> -t 8 -f null -` na 8 pozicija (327, 900, 1500,
2100, 2777, 3231, 3403, 4400 s):

| Datoteka | h264 grešaka nakon seeka | HTTP GET po seeku |
|---|---|---|
| `video_h264_fmp4.mp4` | **17** | 6–9 |
| `video_h264.mp4` | **0** | 1–2 |

Druga sesija (domovina.ai, `PPXbSP14H4Y`) isto je izmjerila u Braveu, nasumični
seekovi preko lokalnog range servera (`no-store`, dakle bez utjecaja cachea):

| Varijanta (iste struje, `-c copy`) | Brave: decode error nakon seeka | ffmpeg h264 greške |
|---|---|---|
| klasični `video_h264.mp4` | ne (3/3 čisto) | 0 |
| fmp4 **bez** interleavea (stanje 11.–24.10.) | ne | 0 |
| fmp4 `-frag_interleave 25` (**današnji CDN**, bajt-identičan) | **da** (@327, @3231, @3403) | 12 |
| fmp4 `-frag_interleave 1` / `100` | — | 4 / 22 |
| fmp4 `-frag_interleave 25` **+ `+cmaf`** | ne (10/10 čisto) | 0 |

Interleave je jednak u obje zadnje varijante (isti broj trunova po trafu, nula
skokova unatrag u `pos`), pa `+cmaf` zadržava iOS popravak i miče seek grešku.
Mehanizam (nalaz domovina.ai sesije, `../domovina.ai/docs/2026-10-26-fmp4-seek-decode-error.md`):
bez `+cmaf` video `sidx` nosi `earliest_presentation_time` 1024 (pomak
B-frameova), a `tfdt` fragmenta je 0. Chromium po `sidx`-u izračuna krivo
mjesto i nakon skoka sjedne usred GOP-a, bez ključnog kadra.

## Kronologija — što je rađeno

| Datum | Repo / commit | Promjena | Posljedica |
|---|---|---|---|
| 01.–03.06. | fetch `fd760a4a`, `2c120aa7` | KORAK 12.5: `video_h264.mp4` (libx264 CRF 30, Main 3.1, AAC 128k, `+faststart`) | stabilno; jedina mana: `moov` ~2,7 MB/h → prvi frame 15,9 s na Slow 4G |
| 11.10. | fetch `57b75bcc` | uz njega `video_h264_fmp4.mp4`: `-c copy -movflags +frag_keyframe+empty_moov+default_base_moof+global_sidx`; `verifyFmp4` provjerava ftyp→moov→sidx→moof | prvi frame 2,6 s; seek u Chromeu radio |
| 11.10. | domovina.ai `a042eb4` | `resolveMedia` bira fmp4 kad ga `episode.json` navodi (osim WebKita) | **sve native platforme (libmpv) i Chromium prešli na fmp4** |
| 11.10. | domovina.ai `b89268b`, `aefb597` | player se montira odmah (spinner), screenshotovi čekaju `playing`, titl tek kad pozicija > 0 | kozmetika, nije uzrok |
| 17.10. | domovina.ai `b8d9c6e` | TV: zajednička `EpisodePlaybackSession`, hwdec za H.264 | samo TV |
| 22.–24.10. | — | iOS app zapinje na `kmVTa8OjHpc`: fmp4 bez interleavea tjera libmpv na ~22 skoka/s natrag-naprijed, preko CDN-a to je 460 HTTP zahtjeva za 2 min | stvarni problem, točno dijagnosticiran |
| 24.10. | fetch `aa84a0f7` | remux s `-frag_interleave 25`; `verifyFmp4` odbija ne-interleavan fmp4 | **uvedena regresija seeka (gore)** |
| 24.10. | ručno | svih ~55 fmp4 (11.–24.10.) prepisano `--fmp4-only --force` **na istom ključu** + CF purge | **uvedena greška s cacheom preglednika (gore)** |
| 24.10. | domovina.ai `b39f9fe` | TV: `cache=no` je gasio i memorijski readahead → vraćen readahead, gasi se samo disk cache | ispravno |
| 24.10.→ | nightly | svaka nova epizoda dobiva interleavani fmp4 | broj pogođenih epizoda raste svaku noć |

## Zašto to nijedna provjera nije uhvatila

- **11.10.** mjeren je prvi frame i JEDAN nastavak od 30:00 u Chromeu. Nije
  testirano nasumično skakanje ni libmpv preko pravog CDN-a.
- **24.10.** mjeren je samo broj HTTP zahtjeva za linearno puštanje
  (`ffmpeg -ss 18 -t 120`, broj `request: GET`) i potvrđen na iPhoneu na jednoj
  epizodi. Dekodiranje nakon seeka se nije provjeravalo — a broj zahtjeva je
  pao s 460 na 9, pa je popravak izgledao uspješno.
- `verifyFmp4` provjerava **strukturu** (redoslijed boxova, sidx, broj trunova),
  ne i to dekodira li se video nakon skoka. Struktura je ispravna i danas.
- Prepisivanje immutable ključa je kršenje vlastitog pravila (memorija
  „Immutable assets traže verzionirane filenameove": overwrite = stalo godinu).
  CF purge rješava edge, ne i preglednik.

## Što je sporedno (nije uzrok ovih simptoma)

- fmp4 nema edit listu (`advanced_editlist does not work with fragmented MP4`),
  pa video kreće na 0,083 s, a audio na 0 s — pomak od 83 ms. Nije primjetno.
- Seek u fmp4 traži 6–9 GET-ova umjesto 1–2 (moof + mdat po tracku); na sporoj
  vezi seek je zato nešto sporiji nego u klasičnom mp4-u, ali radi.
- Keyframe svakih ~10,4 s (x264 default `keyint` 250 pri 24 fps) — seek uvijek
  dekodira do 10 s unaprijed. Isto vrijedi za oba fajla.

## Što treba napraviti (nije napravljeno u ovom dokumentu)

Redom po hitnosti; svaka stavka je odluka:

1. **Odmah, bez novog builda appa:** prestati servirati fmp4. Najbrže je da
   `episode.json` više ne navodi `video_h264_fmp4.mp4` (klijent tada pušta
   `video_h264.mp4`, koji je zdrav) — ili maknuti fmp4 iz `resolveMedia` u
   domovina.ai. Cijena: prvi frame na sporoj vezi opet ~16 s.
2. **Pipeline (`backfill_video_h264.js`, ovaj repo):** `FMP4_MOVFLAGS` +
   `+cmaf` uz zadržani `-frag_interleave 25`, i **dekodni test nakon seeka** —
   strukturni test sam nije dovoljan. *Stanje 26.10.: domovina.ai sesija je to
   već upisala kao necommitanu izmjenu (`+cmaf` i `verifyFmp4Seek`: `ffmpeg -ss`
   na 6 pozicija, svaka linija `[h264`/`[aac` odbija izlaz). Na lokalnim
   fajlovima odbija današnji CDN fmp4 (4/6), a propušta cmaf i klasični.
   Ništa još nije uploadano.*
3. **Novi ključ, ne prepisivanje:** popravljeni fmp4 objaviti pod novim imenom
   (npr. `video_h264_fmp4_v3.mp4`, ili generacija u URL-u `?g=3` koju klijent
   dobiva iz `episode.json`), nikad opet na `video_h264_fmp4.mp4`.
   Druga sesija je već isprobala `?g=2` u klijentu — to rješava stari cache
   preglednika, ali NE i decode grešku (s `?g=2` je u Braveu opet puklo @3231),
   jer je sadržaj i dalje interleave-bez-cmaf.
4. **Provjera prije objave** (i za iOS i za web): nasumični seekovi u Braveu +
   libmpv na iPhoneu preko pravog CDN-a, na barem 3 epizode, ne jednoj.
5. Razmotriti treba li native app uopće fmp4: libmpv klasični `video_h264.mp4`
   otvara s 1–2 zahtjeva; fmp4 je uveden zbog Chromeovog `<video>`.

## Odluka (26.10.2026.)

Matija je odlučio: **isti ključ `video_h264_fmp4.mp4`, generacija u URL-u
`?g=3`** (`CdnConfig.videoH264FragmentedUrl` u domovina.ai), bez novog ključa.
Svih ~55 fmp4 prepisuje se `+cmaf` verzijom (`--fmp4-only --force`) + CF purge,
pa ide deploy klijenta. To pokreće domovina.ai sesija.

Posljedica koju treba imati na umu: `?g=3` štiti samo novi klijent od starih
range-ova u cacheu preglednika. Stari buildovi i web tabovi koji traže URL bez
`?g=` dobivaju prepisani fajl na istom immutable ključu; za native (libmpv,
nema trajnog HTTP cachea) to je popravak, za preglednik sa starim range-ovima
može opet biti miks dok se ne osvježi. Sljedeća promjena sadržaja fmp4-a mora
dobiti `?g=4` (ili novi ključ) — nikad prepisivanje bez nove generacije.

**Izvedeno 26.10.:** 59/59 fmp4 na R2 prepisano `+cmaf` (0 odbijenih od
`verifyFmp4Seek`), CF purge obje `Vary` varijante. Provjereno s CDN-a
(`?g=3`, `ffmpeg -ss` na 6 pozicija po fajlu): **59/59 s 0 h264/aac grešaka**.
`ja70p_gJWZA` i na URL-u bez `?g=`: 0 grešaka (prije 17).

## Reprodukcija

```bash
U=https://cdn.domovina.ai/data/ja70p_gJWZA
for f in video_h264_fmp4.mp4 video_h264.mp4; do e=0
  for s in 327 900 1500 2100 2777 3231 3403 4400; do
    c=$(ffmpeg -nostdin -v error -ss $s -i $U/$f -t 8 -f null - 2>&1 | grep -c h264); e=$((e+c))
  done; echo "$f h264_greske=$e"; done        # zdravo = 0
```

## Vezani dokumenti

- `docs/2026-10-24-fmp4-interleave-ios-zastajkivanje.md` — popravak od 24.10.
- `../domovina.ai/docs/2026-10-11-brzi-start-videa-fmp4.md` — zašto fmp4 postoji
- `docs/video_crossplatform_strategy_2026-06.md` — recept za `video_h264.mp4`

## Nastavak 28. 10. 2026.: `+cmaf` nije dovoljan

Interleavani fmp4 i s `+cmaf` ruši Chromium na **nizu** skokova (`QkcpHsj43rE`:
7/7 pada, isti remux bez interleavea 0/3, klasični mp4 0/6); ffmpeg i
`verifyFmp4Seek` na pojedinačnim skokovima ne vide ništa. Od danas
`backfill_video_h264.js` radi dvije varijante (`FMP4_VARIANTS`):
`video_h264_fmp4.mp4` (interleave, native/libmpv) i `video_h264_fmp4_web.mp4`
(bez interleavea, Chromium). Mjerenja i provjera da se ništa staro ne vraća:
`../domovina.ai/docs/2026-10-28-fmp4-interleave-chromium-seek.md`.
