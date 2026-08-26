# `sabor_review` — ljudski pregled imenovanja govornika

Lokalna aplikacija bez ijedne vanjske ovisnosti (isti obrazac kao
`dashboard/server.js`).

```bash
node sabor_review/server.js                       # → http://localhost:8788
node sabor_review/server.js --port 8790 --output-dir storage/output/sabor
SABOR_REVIEWER="Ime Prezime" node sabor_review/server.js
```

Zamisao: AI obradi što više, čovjek pregleda **samo ono gdje je pouzdanost
niska**. Odluka → faza 03 → razlika, sve u ~0.4 s.

## ⛔ Jedno pravilo

Aplikacija **nikad** ne piše u `aligned_transcript.json`. Piše isključivo u
`human_overrides.json`; transkript proizvodi samo faza 03. Zbog toga se
transkript smije baciti i proizvesti iznova, a ljudski rad preživi.

## ⚠️ Nakon izmjene `server.js` — restartaj proces

Keš sjednice ide **po mtime-u**, pa se podaci osvježe sami. Aplikacija zato
izgleda živa dok vrti stari kod, i lako je zaključiti da nova značajka „ne
radi". Node ne prekapča kod uživo.

```bash
pkill -f "sabor_review/server.js"; node sabor_review/server.js
# provjeri poljem koje postoji samo u novom kodu:
curl -s "localhost:8788/api/queue?session=<id>" | grep -c has_ocr
```

## Red čekanja

| razina | značenje |
|---|---|
| `nerazriješeno` | glasovi najava se ne slažu |
| `srednja` | identitet stoji na **jednoj jedinoj** najavi |
| `neimenovano` | protokol je za tu oznaku nijem (~33 % vremena) |
| `visoka` | dvije ili više složnih najava |

Unutar razine: po govornom vremenu silazno.

### Izvori prijedloga — tri, i ne vrijede jednako

| značka | izvor | čemu vjerovati |
|---|---|---|
| `najava` | predsjedavajući je izgovorio ime | najjače, ali šuti za ~33 % vremena |
| `ekran` | natpis koji je režija ispisala | ne ovisi ni o čijem govoru; 67/67 slaganja s protokolom, 0 proturječja |
| `model` | slijepa provjera modelom | zaključuje iz teksta, zna pogriješiti |

Oznaka bez prijedloga s ekrana nije nužno propust: ogradu pale slaba
pokrivenost natpisa (oznaka skuplja upadice) i zajednički termin više govornika.
Predsjedatelja režija ne titula uopće. Vidi
`docs/sabor_ocr_imena_s_ekrana_2026-08.md`.

## Raspored (tri stupca)

Ciljani ekran je 16:9 desktop, a mjera dobrog rasporeda je koliko se odluka
donese bez skrolanja.

| stupac | sadržaj | skrola |
|---|---|---|
| **lijevi** (~300 px) | stanje sjednice, rangovi, filtar, red čekanja | samo red čekanja — brojke i filtar stoje |
| **srednji** (1fr) | odluka, kandidati, najave-sidra, istupi s tekstom | cijeli |
| **desni** (~340–460 px) | snimka, dokazi natpisa, skok na istup | sve ispod snimke |

Snimka je prije stajala `position:sticky` na vrhu srednjeg stupca i pri
skrolanju prekrivala tekst istupa. Sada je zaglavlje zasebnog stupca i ništa ne
pokriva, a odluka + kandidati + sidra stanu na ekran odjednom.

Ispod ~1360 px raspored pada na dva stupca: snimka ide iznad detalja, red
čekanja zadržava punu visinu. Pogled „Petlja i revizija" nema pojedinačnu
oznaku pa se desni stupac sklanja (`.layout.noside`).

## Snimka

Popis „Skok na istup" u desnom stupcu služi uzorkovanju glasa — tekst se čita
u srednjem.

| način | što daje | ograničenje |
|---|---|---|
| **snimka (lokalno)** | slika i zvuk s diska, trenutačan skok, `▶` odmah svira | traži `video/part_NN.mp4` (`tools/fetch_video.js`) |
| **zvuk (lokalno)** | isto, ali bez slike — `raw/part_NN.m4a` | dio za koji slika nije preuzeta |
| **YouTube (pričuva)** | slika kad lokalne nema | traži internet; premotavanje ponovno učita okvir i ne pokreće se samo |

Lokalna snimka je zadana. Slika se preuzima zasebno:

```bash
node sabor_pipeline/tools/fetch_video.js --session <id>
```

Poslužitelj je nalazi po **dogovoru o imenu** (`video/part_NN.*`), pa se vidi
odmah, bez ponovnog ingesta i bez diranja `session_manifest.json`.

### Tri zamke koje su ovo držale slomljenim

1. **URL snimke mora nositi otisak datoteke.** `/api/media?part=1` je stalna
   adresa uz `Cache-Control: max-age=3600`; kad dio dobije sliku, preglednik sat
   vremena servira stari zvuk iz keša — i to **bez ijednog zahtjeva** na
   poslužitelj, pa u logu nema ni traga. Zato `&v=<veličina>-<mtime>` (+ ETag).
2. **Stari `<video>` se mora ugasiti prije zamjene.** `innerHTML = …` ga samo
   otkvači; Chrome mu drži player dok ga ne pokupi GC, a nakon dovoljno skokova
   novi element više ne krene (`networkState` LOADING, nula zahtjeva).
   `pause()` → `removeAttribute("src")` → `load()`.
3. **`#pBody` se ne smije prepisivati pri svakom crtanju.** Prije je
   `renderPlayer` gradio cijeli player iznova, pa je svaki skok značio novo
   učitavanje i izgubljen buffer. Sada se osvježava samo traka.

## Player

Zaglavlje desnog stupca. **Svaka radnja kojom čovjek kaže „ovim se sada bavim"
pokreće snimku**: klik na slučaj u redu čekanja (namjesti se na najduži istup)
i svaki `▶` uz istup ili najavu. `↗` otvara isti trenutak na YouTubeu.

Ponovno crtanje detalja **nakon spremanja odluke** namjerno NE pokreće snimku —
zastavica `S.autoplay` postavlja se samo u `selectSpeaker`.

⚠️ Posluživanje snimke **mora** podržavati HTTP Range (`206`), inače preglednik
vuče cijelih ~350 MB prije prvog skoka. Otvoreni raspon (`bytes=0-`) se namjerno
ograničava na 4 MB po zahtjevu; sufiksni oblik (`bytes=-N`, za `moov` atom) se
ne dira.

## Nova sjednica

Aplikacija čita disk pri svakom zahtjevu — nova sjednica se pojavi **bez
ponovnog pokretanja poslužitelja**, dovoljno je osvježiti stranicu.

1. `sabor_pipeline/data/sessions/<session_id>.json` (video ID-ovi po dijelovima)
2. `sabor_pipeline/run_sabor_session.sh --session <session_id>`
3. osvježi `localhost:8788` i odaberi sjednicu iz padajućeg izbornika

Sjednice koje još nisu prošle fazu 03 **vide se u izborniku** (onemogućene, uz
fazu koja nedostaje) — da se ne čini kako ih aplikacija ne vidi.

**Registar se čita po sjednici**, iz `roster.path` koji faza 03 zapisuje u
`aligned_transcript.json`. Sjednica iz drugog saziva time automatski dobiva svoj
popis zastupnika; da je registar bio globalan, imena bi se razrješavala u krive
ljude bez ijedne poruke.

## Što gdje živi

| datoteka | tko piše |
|---|---|
| `human_overrides.json` | aplikacija (i ruka) |
| `aligned_transcript.json` | **samo** faza 03 |
| `aligned_transcript.protokol.json` | faza 03 `--no-human` — referenca za mjerenje |
| `human_review/audit_overrides.json` | `tools/audit_overrides.js` |
| `ocr_captions/prijedlozi.json` + `frames/` | `tools/ocr_captions.js` (prijedlozi + dokazne sličice) |
| `human_review/rerun_*.log` | pozadinsko pokretanje faze 03/04 |

Puni opis, mjerenja i zamke: `docs/sabor_human_in_the_loop_2026-08.md`.
Natpis s ekrana kao izvor: `docs/sabor_ocr_imena_s_ekrana_2026-08.md`.
