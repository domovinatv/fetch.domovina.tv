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
