# Je li epizoda bila LIVE? Premijera vs prijenos (YouTube Data API)

16.10.2026. Ad-hoc mjerenje, ništa nije ugrađeno u pipeline.

Vezani dokumenti: `docs/2026-10-09-arhiva-po-danima-i-tocni-datumi.md` (isti
`YOUTUBE_API_KEY`, kvota).

## Pitanje

Koje su od objavljenih epizoda praćenih kanala bile emitirane uživo, i je li
neki praćeni kanal trenutno uživo?

## „Je li sada uživo"

`curl -sL https://www.youtube.com/channel/<UCID>/live`, pa u HTML-u treba tražiti:

- `"isLiveNow":true`: kanal je trenutno uživo;
- `"isUpcoming":true`: na stranici je zakazan prijenos;
- `<link rel="canonical" href="…watch?v=ID">`: ID tog videa.

Ovo ne troši kvotu. Za 48 kanala uz `xargs -P 8` traje nekoliko sekundi.

**Zamka:** `isUpcoming` hvata i **napuštene zakazane prijenose** koji mjesecima
ili godinama ostaju na `/live` stranici kanala. 16.10. su tako izgledali
Marijanski zavjet (zakazan za 8.8.2020.) i Miletić Marin (prazan „is live",
zakazan za studeni 2025.). Zato uvijek treba provjeriti `scheduledStartTime` iz
`watch?v=` HTML-a ili `yt-dlp` poruku („will begin in N hours/days" znači stvarni
prijenos; „in a few moments" s datumom u prošlosti znači mrtav placeholder).

## „Je li bila uživo", unatrag

`videos.list?part=snippet,liveStreamingDetails,contentDetails&id=<50 ID-jeva>`
troši 1 jedinicu po pozivu. Za 3.336 ID-jeva iz `automatic/podcasts/*-lista.txt`
to je bilo 67 poziva.

| | broj |
|---|---|
| ID-jeva na listama | 3.336 |
| API vratio | 3.104 (232 privatna ili obrisana) |
| s `liveStreamingDetails` | 605 |

**`liveStreamingDetails` imaju i PREMIJERE**, pa ta brojka ne znači „bilo uživo".
API nema polje koje razlikuje premijeru od prijenosa.

### Heuristika koja ih razdvaja

`razlika = (actualEndTime − actualStartTime) − contentDetails.duration`

- **Premijera:** razlika je 30–160 s. To je YouTubeovo odbrojavanje od oko 2 min
  prije premijere. Vrijedi za **591 od 605**, s medijanom 115–138 s po kanalu.
- **Pravi prijenos, naknadno skraćen:** razlika je negativna jer je snimka kraća
  od emitiranja. Takvih je bilo **6**.
- **Nejasno:** razlika je +170 do +980 s. Takvih je **8, svi s LOOD-a**, i
  najvjerojatnije su premijere koje su kasnije krenule.
- Neskraćen pravi prijenos dao bi razliku ≈ 0. U ovom skupu nije bilo nijednog.

Gotovo svi praćeni kanali objavljuju preko premijere: Željka Markić 150, LOOD 131,
Čušpajz 73, Muževni budite 71, Iva Kraljević 45, 40 dana za život 33…

Pravi prijenosi (sigurni):

| kanal | datum | ID |
|---|---|---|
| nanovoroeni | 2020-03-25 | TG1-o8D5erw |
| hitna-pomoc-za-nemirne | 2020-05-30 | NZLLZjmmjoI |
| lood-podcast | 2020-12-31 | TaJ8A_Sfiv0 |
| lood-podcast | 2021-09-05 | zbw55pbfQHY |
| mreze-rijeci | 2024-12-10 | -sZ5FsQe-P0 |
| eho-projekt | 2025-05-30 | 0URLFVf-K8A |

## Otvoreno

- Nije ugrađeno ni u jedan metapodatak. Ako zatreba polje `was_live` / `premiere`
  po epizodi, ova heuristika je polazište; kandidat za mjesto je
  `automatic/backfill_days.js`, jer već zove isti API.
- Heuristika nije provjerena na kanalu koji stvarno redovito ide uživo (dnevne
  mise, Nova Eva `/streams`). Tamo treba očekivati razliku ≈ 0 ili negativnu.
