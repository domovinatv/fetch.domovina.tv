# fmp4 bez interleavinga — iOS app zapinje (24. 10. 2026.)

Simptom: `kmVTa8OjHpc` (ad-hoc, 22.10.) u iOS aplikaciji stalno staje i ne može
bufferirati; isti video u Chromeu na iOS-u radi. Datoteka NIJE bila korumpirana.

## Uzrok

| Klijent | Što pušta | Zašto |
|---|---|---|
| iOS/Android/macOS app (libmpv) | `video_h264_fmp4.mp4` | `data_service.dart` bira fmp4 kad ga bundle navodi |
| Chrome/Safari na iOS-u (WebKit) | `video_h264.mp4` | `isWebKitBrowser()` isključuje fmp4 |

`ffmpeg -c copy -movflags +frag_keyframe+…+global_sidx` u svaki fragment (~10 s,
od keyframea do keyframea) stavi **jedan trun videa pa jedan trun audija** —
100–200 KB razmaka. ffmpeg-ov mov demuxer (pa i libmpv) bira idući uzorak po dts-u
(unutar 1 s → manji `pos`), pa skače natrag-naprijed između dva runa:

```mermaid
flowchart LR
  A[video uzorak @ pos X] -->|naprijed ~130 KB| B[audio uzorak @ pos X+130K]
  B -->|natrag| C[video uzorak @ pos X+δ]
  C -->|naprijed| D[audio ...]
```

Na prvih 5 min: ~6500 skokova unatrag (≈22/s). Je li skok jeftin ovisi o tome
je li ciljni bajt već u bufferu; ako nije → novi HTTP zahtjev. CDN vraća
`Connection: close` → **svaki skok = novi TCP+TLS handshake**. Mobilni player ima readahead (media_kit: `cache=yes`, 32 MB), ali ga uz ping-pong ne stiže puniti; TV sesija je imala `cache=no` (ispravljeno u domovina.ai `b39f9fe`).

## Mjerenja (ffmpeg 8.1.1 s Maca preko cdn.domovina.ai, `-ss 18 -t 120`)

| Datoteka | HTTP zahtjeva |
|---|---|
| kmVTa8OjHpc fmp4 (stari) | 460 |
| w7YR_yMrsIU fmp4 (stari, nightly 24.10.) | 1967 |
| dYqKlE_pEXI fmp4 (stari, nightly 24.10.) | 15 |
| `video_h264.mp4` (klasični faststart) | 1–2 |
| svi fmp4 s `-frag_interleave 25` | 4–9 |

`dYqKlE_pEXI` ima JEDNAK broj skokova kao ostali — samo je imao sreće s
bufferom. „Druge epizode rade" zato nije dokaz.

## Zamke pri dijagnozi

- **Localhost ne reproducira.** Isti fajl preko lokalnog range servera (i uz
  simuliranu latenciju 80 ms / 1,5 MB/s) = 15–19 zahtjeva. Mjeri preko pravog CDN-a.
- Struktura (ftyp/moov/sidx/moof), dekodiranje, timestampovi, sidx pokrivenost —
  sve je bilo ispravno. Pravi signal je broj `request: GET` u `ffmpeg -v debug`,
  ili deterministički: redoslijed `pos` paketa (`ffprobe -show_entries packet=pos,size`)
  i broj skokova unatrag.
- Cloudflare 403-a Python `urllib` (UA); koristi `curl -r`.

## Popravak (commit `aa84a0f7`)

- `backfill_video_h264.js`: remux s `-frag_interleave 25` (+0,15 % veličine,
  zaglavlje i sidx isti → brzi start u Chromeu ostaje).
- `verifyFmp4` odbija fmp4 čiji prvi moof ima ≤ 1 trun po trafu → epizoda tada
  ostaje samo s `video_h264.mp4` umjesto s pokvarenim fmp4.
- Svih 55 fmp4 na R2 (11.–24.10.) prepisano `--fmp4-only --force` + CF purge
  (obje `Vary: Origin` varijante). Provjereno s CDN-a: 55/55 interleaved.

Provjera za buduće:
```bash
ffmpeg -nostdin -v debug -ss 18 -i https://cdn.domovina.ai/data/<ID>/video_h264_fmp4.mp4 -t 120 -f null - 2>&1 | grep -c 'request: GET'   # zdravo < 15
```

## Otvoreno

- Na iPhoneu potvrđen samo `kmVTa8OjHpc`; ostale epizode provjerene samo ffmpegom.
- Opcija u appu: na native platformama puštati klasični `video_h264.mp4`
  (libmpv ga otvara s 1–2 zahtjeva; fmp4 je uveden zbog Chromea). Nije rađeno.

## Vezani dokumenti

- `../domovina.ai/docs/2026-10-11-brzi-start-videa-fmp4.md` — zašto fmp4 postoji
- `docs/data_contract.md` §15 — episode.json bundle (navodi `video_h264_fmp4.mp4`)
