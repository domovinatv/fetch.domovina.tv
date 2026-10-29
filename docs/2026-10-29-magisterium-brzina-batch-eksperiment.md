# Magisterium HR: više sekcija po chat pozivu (eksperiment 29.10.2026.)

**Ukratko.** Od 29.10.2026. `tools/magisterium_mcp_episode.js` šalje **2 sekcije po
`chat` pozivu** (default `--batch-size 2`, env `MAGISTERIUM_BATCH_SIZE`). Na
`QkcpHsj43rE` (42 sekcije) sekcijski chat traje **756 s umjesto ~1413 s (1,9×)**.
Ocjene ostaju unutar šuma koji Magisterium ima i između dva runa istog prompta.
Cijena: **~17 % manje citata** po sekciji (3,0 umjesto 3,6) i ~10 % kraće obogaćenje.
Za staru gustoću citata vrati se na `--batch-size 1`.

Usput su ispravljene dvije greške koje su postojale i prije batchanja: strano pismo
koje 2b provjera nije prepoznavala (armenski i češki tekst objavljen na CDN-u) i
pokvaren JSON koji nije pokretao ponovni poziv.

Kod i sirovi rezultati: `experiments/2026-10-29-magisterium-brze/` (izlazi su u
`data/output/`, gitignored).

## Zašto je Magisterium HR usko grlo

| korak (`QkcpHsj43rE`, 28.10., batch 1) | vrijeme |
|---|---|
| 2 chat: 43 poziva (42 sekcije + holistički), ~34 s/poziv | 1446,8 s |
| 2b jezični retry | 42,2 s |
| 4 publish + 5 md5 | 32,4 s |
| **ukupno** | **25,4 min** |

Server propušta ~2,5 chata/min po korisniku, a jedan poziv traje 30–50 s. Paralelni
pozivi samo skupljaju `rate_limit_exceeded` (izmjereno 24.10.), pa jedina poluga
ostaje **manje poziva**.

Slanje cijelog članka u jednom pozivu ne radi, i to nije zbog promptanja:
**`chat` vraća najviše 10 referenci po pozivu** (`refs=10` u svakom od 42 batch
poziva ovog eksperimenta). Odgovor je uz to ograničen izlaznim tokenima, pa
42 sekcije u jednom pozivu daju površne, generičke procjene. To je i razlog zašto
je integracija od ožujka do listopada išla prema manjim batchevima.

## Magisterium MCP alati (stanje 29.10.2026., server 1.0.1)

`search, fetch, chat, get_mass_readings, get_martyrology, get_saint, get_person,
get_pope, get_diocese, get_diocese_statistics`. Popis je isti kao 24.10. Nema alata
za batch ili više pitanja odjednom: `chat` prima samo `prompt`, bez parametara za
duljinu odgovora ili model. Novo u odnosu na ranije bilješke:

- svi alati imaju `outputSchema` (strukturirani izlaz);
- `chat` uz `answer` i `references` vraća i `related_questions`;
- `search` vraća 10 pogodaka `{id, url, title}`, a hrvatski upit nalazi točne izvore
  (npr. KKC 2293, Caritas in Veritate 69 za tekst o tehnologiji i dostojanstvu);
- `fetch` vraća puni tekst odlomka i `metadata.author/ref` za ~0,5 s. Naši citati
  danas imaju prazan `cited_text`, pa bi ga se iz `fetch` moglo popuniti;
- `get_saint/get_pope/get_person` daju strukturirane podatke o osobama. Za brzinu
  nisu korisni, ali mogli bi obogatiti entitete koje članak spominje.

## Mjerenja

Ista epizoda, isti promptovi (`magisterium_mcp_prep.js --max-words 600`), holistički
odgovor preuzet iz produkcijskog runa, sve sekvencijalno. Baseline je objavljeni
`article.magisterium.json` od 28.10.

| | batch 1 (produkcija) | **batch 2** | batch 3 | batch 6 | batch 3 + `search` dopuna |
|---|---|---|---|---|---|
| sekcijskih chat poziva | 42 | 21 | 14 | 7 | 14 + 39 search + 71 fetch |
| zid | ~1413 s | **756 s** | 687 s | 444 s | 687 + 516 = 1203 s |
| s/poziv | ~34 | 36,0 | 41,7 | 48,7 | — |
| ocijenjeno | 42/42 | 42/42 | 39/42 ⚠️ | 42/42 | 39/42 |
| prosječna ocjena | 77,2 | 76,9 | 75,3 | 74,5 | 75,3 |
| odstupanje ocjene po sekciji, prosjek / najviše | — | 3,3 / 10 | 3,8 / 13 | 4,7 / 17 | 3,8 / 13 |
| riječi u procjeni | 51,5 | 51,5 | 50,4 | 48,1 | 50,4 |
| riječi u obogaćenju | 60,3 | 54,1 | 47,7 | 43,0 | 47,7 |
| citata po sekciji | 3,6 | 3,0 | 2,2 | 2,4 | 4,0 |

Šum za usporedbu (24.10., isti prompt dva puta): ±12 po sekciji, root prosjek ±1.

Zaključci:

1. **Batch 2 je jedini bez mjerljivog pada ocjena** (−0,3, prosječno odstupanje 3,3).
   Gubi se samo gustoća citata i dio obogaćenja.
2. **Batch 3 i 6** daju 2,1× i 3,3× brzine, ali sustavno snižavaju ocjenu (−2 do −3)
   i skraćuju obogaćenje za 21–29 %.
3. **Hibrid (`search` + `fetch` dopunjuje citate)** se ne isplati. `search` nije bez
   ograničenja: pojedinačno traje ~3–5 s, ali pod nizom poziva usporava na ~11 s
   (najviše 36 s), a tri paralelna poziva odmah dobiju `rate_limit_exceeded`. Dopuna
   za 39 sekcija trajala je 516 s, pa je ukupni dobitak samo 17 %. Dopunjeni citati
   su relevantni, ali ih Magisteriumov odgovor nije koristio.
   (`fill_citations.js` ostaje u eksperimentu.)

## Ispravljene greške (vrijede za svaki batch-size)

- **Strano pismo.** 2b je hvatala samo ćirilicu i baltičko-finske dijakritike.
  Objavljeno je bilo: `QkcpHsj43rE` („dostojanstvo ljudi **ու արդարորեն rozděluje**
  troškove”, armenski + češki) i `c2vZO7dHBTE` (armenski „և”, latvijski
  „Akvīnietis”). U eksperimentu se pojavilo i gruzijsko „Katolიცizam”. Novi regex
  hvata svako nelatinično slovo i ąęėįųūõäöåěřůňťďýĺľŕ. Audit cijelog kataloga:
  `node experiments/2026-10-29-magisterium-brze/audit_strani_jezik.js` → **2/433**
  datoteke (dvije gore). Obje su popravljene istog dana alatom
  `tools/magisterium_fix_foreign.js --video-id <VID>`: ponovno pita samo pogođene
  sekcije (isti batch-size kao produkcija), ubaci ih u postojeći JSON, preračuna prosjeke
  (oba `overall_score` ostala ista: 77 i 83) i staru datoteku preimenuje u `.bak.<ts>`.
  Objava: `force_upload.js --targets magisterium` + EPUB + bundle. EN overlay
  `QkcpHsj43rE` je bio preveden iz pokvarenog HR-a (11 armenskih znakova), pa je
  ponovno preveden (`translate_to_english.js`, 96 s) i objavljen. Audit nakon toga: 0/433.
- **Pokvaren JSON.** Odgovor s pokvarenim JSON-om (batch 3, batch_13) assemble je
  tiho preskočio, a sekcije su ostale bez ocjene. Sada 2b provjerava i ima li
  odgovor parsabilan `results` sa svim traženim indeksima (`missingResults`), pa se
  inače pita ponovno. Test: `tools/magisterium_mcp_episode.test.js`.
- **`client_stats.json`** je pri 2b ponavljanju pregazio mjerenja prvog runa. Stari se
  sada preimenuje u `client_stats.<ts>.json`.

## Procjena trajanja (batch 2)

≈ 1 min + **0,3 min × sekcija** (prije 0,5 min). Primjer: 42 sekcije ≈ 13 min
umjesto 25 min, 31 sekcija ≈ 10 min umjesto 17 min.

## Plan (nije započeto)

1. **Batch 2 na drugom žanru** (propovijed, apologetika) prije nego zaključimo da
   ocjene ostaju u šumu i izvan tehničkih tema. Ista skripta: `run_batches.sh` uz
   drugi `ART`.
2. **`cited_text` iz `fetch`.** Citati u `article.magisterium.json` imaju prazan
   `cited_text`. `chat` reference nose `source_url` (`…/docs/<doc>/ref/<n>`), ali ne
   i `id` odlomka za `fetch`. Put: `search` s naslovom i referencom citata → pogodak
   s istim `url` → `fetch(id)` → prvih ~300 znakova odlomka. Pazi na rate limit
   `search`-a (sekvencijalno, ~11 s pod opterećenjem): ~3 citata × 42 sekcije ≈
   125 poziva ≈ 20+ min po epizodi. Zato ide kao zaseban, odgođen korak (ne u
   kritičnom putu objave) ili samo za nove epizode. Prototip dopune je
   `experiments/2026-10-29-magisterium-brze/fill_citations.js` (puni `cited_text`
   za citate koje sam doda).

## Što nije isprobano

- **Agentni put kao EN prijevod**: `search`/`fetch` skupe izvore, pa jedan Opus ili
  agy poziv ocijeni cijelu epizodu. Bio bi najbrži, ali ocjenu tada piše naš model,
  a ne Magisterium. To je promjena proizvoda, ne optimizacija. Uz to `search` ima
  vlastiti rate limit (vidi gore).
- Jedna epizoda kao uzorak. Prije zaključka o batchu 3 treba barem još jedna epizoda
  drugog žanra (npr. propovijed, gdje ocjene nisu oko 75).
