# Ručni isječak epizode → cdn.domovina.ai (17.11.2026.)

Ad-hoc zahtjev: isječak objavljene epizode u originalnom 16:9 formatu, na javni link,
pa link u WhatsApp „Matija Only”. Ne ide kroz pipeline ni kroz `render_reels.js`.

Prvi primjer: re:DEFINICIJA ep. 11, Ante Lučić (`RdEN7Ny1bV8`), 30:16–36:32 →
`https://cdn.domovina.ai/clips/RdEN7Ny1bV8/RdEN7Ny1bV8_30m16s-36m32s_1080p.mp4`

## Postupak

```bash
source automatic/resolve_ytdlp.sh          # najnoviji yt-dlp na PATH-u (vidi memoriju o 403)
yt-dlp -f "bv*+ba/b" --merge-output-format mkv -o "$TMP/src.%(ext)s" "https://www.youtube.com/watch?v=<ID>"
ffmpeg -ss 30:16 -to 36:32 -i "$TMP/src.mkv" \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart "$TMP/<ID>_<od>-<do>.mp4"
```

Upload (`@aws-sdk/client-s3` je u repou; `dotenv` NIJE, pa `node --env-file=.env`):

```bash
node --env-file=.env -e '...PutObjectCommand({Bucket:process.env.R2_BUCKET_NAME,
  Key:"clips/<ID>/<ID>_30m16s-36m32s_1080p.mp4", ContentType:"video/mp4",
  CacheControl:"public, max-age=31536000, immutable"})'
```

Slanje: bridge `curl 127.0.0.1:8080/api/send -d '{"recipient":"385989679022-1532363185@g.us","message":"..."}'`
(radi i kad se WhatsApp MCP ne spoji).

## Odluke i brojke

- **Ključ `clips/<ID>/…`**, izvan `data/{id}/`: isječak nije dio ugovora epizode
  (`episode.json` ga ne treba vidjeti), a `immutable` cache traži jedinstveno ime,
  zato su granice isječka u imenu datoteke.
- **Prekodiranje u H.264, ne `-c copy`**: YouTube je najbolju kvalitetu dao kao AV1
  1080p (`av01.0.08M.08`, format 399). AV1 ne puštaju pouzdano WhatsApp, Safari ni ciljni TV-i,
  a `-c copy` reže samo na keyframeu. CRF 17 / slow: 6:16 min = 131 MB.
- **Link umjesto videa u WhatsApp**: 131 MB je iznad ograničenja za video poruku.
- Puni izvor (cijela epizoda, ~2 h) je bio 356 MB. Skidanje je trajalo oko minute.

## Zamka: vanjski SSD nedostupan iz Claude sesije

Korisnik želi temp downloade na vanjskom SSD-u, ne na internom disku (koji zna biti pun).
Iz Claude Code sesije `mkdir`/`touch` na `/Volumes/DOMOVINA1TB` i `/Volumes/DOMOVINA2TB`
vraća `EPERM`, i iz basha i iz nodea, i bez sandboxa. Terminal nema macOS TCC dozvolu
„Removable Volumes”. Dok je ne dobije (System Settings → Privacy & Security → Files and
Folders → iTerm), temp ide u scratchpad i briše se odmah nakon uploada.

## Vezani dokumenti

- `docs/2026-10-25-reels-kandidati.md` (automatski 9:16 reelovi, drugi tok)
- `docs/whatsapp_share_epizode.md`

## Varijanta s titlom riječ po riječ (YouTube, 16:9)

Isti isječak, ostaje 16:9 1080p25, uz samo dvije stvari: titl koji prati izgovorene riječi
i logo Muževni budite gore desno. Nema kartica ni reframea. Generator:
`tools/hyperframes_reel/clip_captions_169.py` (HyperFrames: `index.html` + sub-kompozicija
`compositions/captions.html` s `data-track-kind="captions"`).

- **Ulaz:** isječak s CDN-a (`clips/<ID>/…_1080p.mp4`, ne ponovno s YouTubea),
  `data/<ID>/diarized.srt` + `data/<ID>/words.json` s CDN-a. Riječi se uparuju po poziciji
  u cue-u, kao `render_reel.load_words`. Ep. 11: 405/405 cue-ova, 0 neusklađenih, 867 riječi.
- **Titl:** grupe ≤5 riječi / ≤32 znaka, lom na interpunkciji ili pauzi >0,3 s (307 grupa).
  Source Sans 3 Black 60 px, bijelo na tamnoj pločici (#0D1216, 82 %), aktivna riječ u zlatnoj
  boji brenda (#C6A15B). Pozadina studija je bijela cigla, pa bez pločice titl nije čitljiv.
- **Ugrađena grafika:** snimka ima karticu „Podupri naš rad” dolje lijevo (263–291 s isječka).
  Nađena skenom crvene boje po sekundi; u tom prozoru titl se pomiče udesno (`SHIFT`).
- **Render:** 376 s za ~3 min (GPU capture), H.264 High, CRF 16, 263 MB.
- **CDN:** `https://cdn.domovina.ai/clips/RdEN7Ny1bV8/RdEN7Ny1bV8_30m16s-36m32s_1080p_titl.mp4`
  (isti upload kao gore, sufiks `_titl`), link poslan u WhatsApp „Matija Only”.

### Zamke

- `~/.cache/hyperframes` je iz Claude sesije nečitljiv (EPERM i bez sandboxa, TCC/provenance).
  Pokreni s `XDG_RUNTIME_DIR=<scratch>/xdg HYPERFRAMES_CACHE_DIR=<scratch>/hfcache`.
- **`--video-frame-format png` je napunio interni disk** (ENOSPC na 6,4 GB, 9400 kadrova).
  Koristi `jpg` (default `auto`). Kad pukne, ostaje `$TMPDIR/hyperframes-extract-cache-501/*.partial-*`, pa ga obriši.
