# Revizija nepraćenih unosa registra — 2026-09-24

Obuhvat: 227 unosa (`tracking.enabled !== true` + `youtube.url`). Metoda: yt-dlp samo metapodaci — `/videos` 60, `/streams` 30, `/shorts` 30, `/playlists` svih kanala, playliste do 400 stavki, plus jedan ne-flat poziv po unosu za točan datum najnovijeg originala. Detalji: `revisions.json`; sirovo: `_raw/`. Primijenjeno: `node data/discovery/discover.js revise-apply --file …/revisions.json`.

**Zaključak:** živih je 114 od 227 (70 active + 44 active-slowing). Registry je tvrdio 181. Ostalo: 66 inactive, 44 not-a-podcast, 3 dead-url. 89 kanala ima naslovni regex, 58 ima visok rizik derivata, 18 aktivnih mora pratiti i /streams.

## Top 10 po udjelu derivata (orig/deriv u zadnjih ~60)

- vida-podcast 4/56 — include U pravom licu|Zavidavanje; bolje 2 playliste
- podcast-inkubator 5/55 — videos+streams, `Podcast Inkubator #\d+`, excl Q&A, 2881 s
- domovinski-rat 8/52 — `GDJE SI BIO`, 3600 s
- etvos-osijek 8/52 — `ETVOS podcast EP\d+`
- salesiana-hr 8/52 — `SOV #\d+`
- ril-tok 9/51 — `Ril Tok Podcast #\d+`, excl ŠORC
- sportske-novosti 9/51 — playlista VAR soba
- podcast-sekstant 11/49 — `PODCAST SEKSTANT #\d+`, 3600 s
- sbs-croatian 11/49 — `Program SBS-a na hrvatskom` (ostalo su izrezani segmenti)
- zeleno-zuti-korner 11/45 — `Zeleno-Žuti Korner #`, excl HAKL PO ISTRI

## Obrasci derivata

1. citatni isječci „Gost: "citat"" 3–15 min;
2. Q&A kao zaseban video (PI, A1) — ali kod tribina-qa i Mysteriuma Q&A JE puna epizoda, pa exclude nije globalan;
3. reprize/re-uploadi: Velebit „(R)", Surove Strasti, Na Rubu Znanosti (HRT 2007), Podcast Hrvatska Uživo, Povijest četvrtkom samo kod trećih kanala;
4. analize tuđih podcasta (podcast-o-zdravlju) i prijevodi (kyrios-books);
5. best-of/bloopers;
6. teaseri/najave;
7. isti naslov za original i isječak (Zaja Mind, Veza Dom, Bez pauze #89) — pomaže samo prag;
8. drugi dugi formati na istom kanalu (Tonecast recenzije, nemoj-me vlogovi, Ora et Labora molitve) — pomaže samo regex ili playlista.

## Zamke

1. `approximate_date` ima skokove mjesec/godina (sve „prije 1 mj." = 2026-08-25) — za granice 60/180 dana treba točan datum po videu.
2. /streams se ne vidi u /videos, a mnogi objavljuju epizode kao live.
3. /streams nosi i mise, sjednice, konferencije i gameplay — pravilo vrijedi i tamo.
4. Prag nije dovoljan kad derivati traju 45–56 min.
5. Ni playliste nisu čiste (Agroklub, IZDVOJENO, podkist).
6. Numeracija vara: Kriminalno dobre priče imaju samo parne brojeve na YT; isječci nose „#N".
7. Handle zna umrijeti dok kanal živi; 4/5 dead-handle unosa nema `channel_id`.
8. Shorts su zaseban tab — navedeni samo u evidence.
9. 365d brojke plodnih kanala su donja granica (uzorak 60).

**Semantika `watch_rule`:** original = trajanje ≥ `min_duration_sec` ∧ include regex (ako je zadan) ∧ ¬exclude regex; `(?i)` prefiks = case-insensitive.
