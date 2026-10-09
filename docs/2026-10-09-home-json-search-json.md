# home.json, search.json i stabilan `generated_at` (9.10.2026.)

Pipeline strana koraka P1/P2 iz frontend plana
`../domovina.ai/docs/2026-10-08-brzina-ucitavanja-naslovnice.md` (ugovor, mjerenja
naslovnice, odluka protiv Workera). Ovdje samo ono što se tiče `fetch.domovina.tv`.

## Što generira `generate_channel_index.js`

| datoteka | sadržaj | 9.10.2026. |
|---|---|---|
| `channels/data/home.json` | bazen epizoda za naslovnicu, v1 | 85 ep, 18,3 KB sirovo / 5,7 KB brotli |
| `channels/data/search.json` | `{id: {a, t, s}}` za lokalnu pretragu, v1 | 3 318 ep, 2,74 MB / 0,66 MB brotli q11 (CDN šalje 0,86 MB) |

`home.json` = unija bez duplikata: (1) sve unutar 45 dana (lokalni datum, ne UTC —
nightly krene u ~03 h), (2) do 20 s `has_magisterium` i score ≥ 70, (3) 30 najnovijih
s `has_article`. `p` je bitmask čiji redoslijed određuje `VideoPipeline.fromBits` u
frontendu — samo nadopunjavati na kraju. Hero izbor ostaje u klijentu.

Oba se računaju nad cijelim katalogom. Uz `--channel` uzimaju ostale kanale iz
postojećeg `index_bundle.json`; bez njega se preskaču (inače bi bio samo jedan kanal).

## Stabilan ETag

Prije: noćni run prepisivao je svih 50 listinga s novim `generated_at`, pa se MD5
(ETag) mijenjao svaki dan i 304 je vrijedio samo unutar dana.

Sad `writeJsonStable` zapiše datoteku samo ako se sadržaj bez `generated_at`
promijenio. Inače je ostavi bajt-istu → `upload_to_r2.js --meta-dir` je preskoči po
MD5-u → ETag ostaje. Izmjereno: ponovni run nad nepromijenjenim katalogom ostavio
je svih 50 listinga + index + bundle bajt-iste; upload 2 nova / 152 preskočeno.

Uploader nije trebalo mijenjati: `cacheControlFor` već daje
`public, max-age=60, must-revalidate` svemu pod `channels/`, a meta upload uvijek
uspoređuje MD5. Uvjetni GET s ETag-om vraća `304 0`.

`home.json` se ipak mijenja i bez novih epizoda — kad neka ispadne iz 45-dnevnog
prozora. To je očekivano.

## Prvi upload

404 za obje datoteke CDN je cachirao do 4 h, pa je nakon prvog uploada rađen purge
oba URL-a u obje `Vary: Origin` varijante (gol + `Origin: https://domovina.ai`).
Ponavljati ne treba — od tada su 200 s `max-age=60`.

## Provjera ekvivalencije nad stvarnim podacima

Privremeni Flutter test u domovina.ai (obrisan) pustio je `HomeFeed` nad
`home.json` i nad `index_bundle.json`:

- hero (ID-evi i razlozi): isti
- „Upravo stiglo": isto
- „Najnovije": isti skup, ali 5 parova s istim datumom u drugom redu. Uzrok je u
  klijentu — Dart `List.sort` nije stabilan (iznad 32 elementa), a rail sortira
  samo po datumu. Popravak, ako se želi, je drugi ključ (`id`) u frontendu.

## Otvoreno

- Listing v2 (bez `abstract`/`topics`/`speakers`, `p` umjesto `pipeline`) — tek kad
  stari native buildovi ispadnu iz upotrebe; `version` tada mora biti STRING `"2.0"`.
- Tablica stanja (§0) u frontend dokumentu još kaže „treba napraviti" — ažurirati
  iz domovina.ai sesije.
- Otvoreno pitanje iz frontend doca (koliko se kanala sadržajno mijenja dnevno)
  sad je mjerljivo iz logova: `generate_channel_index.js` piše „(nepromijenjeno)"
  uz svaki listing koji nije dirao.
