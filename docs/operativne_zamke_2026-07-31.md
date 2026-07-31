# Operativne zamke — sesija 2026-07-29/31

Zamke koje su stvarno pukle tijekom backfilla 115 epizoda i prelaska na single-pass nightly.
Sve su reproducibilne i nijedna nije očita iz koda, pa su zapisane ovdje.

---

## 1. `--rebuild-state` NIJE "popravi zapelu epizodu" — re-queue-a cijeli kanal

**Što se dogodilo:** 5 epizoda je imalo `.canary.diarized.srt` ali ne i `.canary.summary.json`,
a skripta ih je javljala kao `⏭️ preskočeno (cache)`. Done-cache je bio stale. Pokrenuto je
`--rebuild-state` nad cijelim `_unlisted` kanalom da se to popravi.

**Posljedica:** rebuild briše cijeli state i gradi ga ispočetka, a kao "gotov" priznaje samo
članak koji odgovara **trenutnom model slugu**. Svih 58 `_unlisted` epizoda imalo je članke od
`gemini-3.5-flash`, što pod `GEMINI_BACKEND=claude` izgleda kao "nema članka" → 35 epizoda je
regenerirano na Opusu prije prekida. ~7.5 h i ≈15 M tokena kvote na posao koji nije trebao.

**Kako ispravno:** scope-aj na konkretan video, ne na kanal:

```bash
node summarize_gemini.js --input-dir storage/output --channel launched \
    --video-id 029f40caafc --rebuild-state        # BEZ --dry-run
```

**Druga zamka u istom potezu:** `--rebuild-state` **s** `--dry-run` ne zapiše rebuildani state,
pa ghost preživi i izgleda kao da ispravak ne radi. Potvrđeno empirijski: isti video s
`--rebuild-state` bez `--dry-run` prošao je iz prve (22.8 s).

**Nije bilo štete na podacima** — regenerirani članci su valjani. Dedup uzima leksikografski
najveći `_{datum}_{model}`, pa `2026-07-31_opus` pobjeđuje `2026-07-27_gemini-3.5-flash`.
Posljedica je da ti članci imaju **nove timestampove**, pa im trebaju i novi screenshotovi —
sljedeći prolaz s `--with-screenshots` to sanira sam.

---

## 2. Dugotrajni ručni driver koji drži `PIPELINE_LOCK` blokira nightly

**Što se dogodilo:** driver pokrenut u 00:24 uzeo je `PIPELINE_LOCK` i držao ga 7.5 h.
Nightly je startao u 03:00, uredno čekao (`acquire_pipeline_lock wait`) — i stajao 5 sati.
Nova epizoda `domovina_tv` ostala je neobrađena, što je izgledalo kao kvar nightlyja.

**Zaključak:** lock radi točno kako treba; problem je bio što ručni posao nije bio ograničen.
Prije pokretanja bilo čega što drži lock preko 03:00, procijeni trajanje. Ako posao može
prijeći u nightly prozor, ili ga rasporedi da završi prije, ili ga svjesno pusti bez locka
(uz rizik od race-a nad state datotekama), ili ga prekini prije 03:00.

**Dijagnostika:** `cat automatic/logs/.pipeline.lock.d/pid` daje PID holdera. Ako je holder
mrtav, sljedeći `acquire` ga sam detektira kao stale i preuzima.

---

## 3. Diarizacija s `--workers 4` je srušila stroj (OOM)

Mac Mini M4 Pro, **24 GB RAM**. Svaki pyannote worker troši ~3 GB + 2 threada. `--workers 4`
uz paralelni Modal upload i node procese potrošio je memoriju i ubio Claude Code sesiju.

**Praktično pravilo na 24 GB:** `--workers 2` kad išta drugo radi, `--workers 4` samo ako je
stroj inače prazan. Izmjereno: 115 epizoda / `--workers 4` ≈ 30 min, `--workers 2` ≈ 8.5 min
za 4 epizode — diarizacija nije usko grlo, pa agresivan paralelizam ne donosi dovoljno da bi
se isplatio rizik.

---

## 4. Stvarni ključevi u `article.json` / `outline.json` — za skripte koje ih validiraju

Tri puta u istoj sesiji ad-hoc provjera dala je **lažni rezultat** zbog krivo pogođenih
ključeva ili regexa. Ovo je stvarna struktura:

```jsonc
// *.article.json
{
  "metadata": { "source_file": "...", "generated_at": "...", "model": "claude-code:opus" },
  "iterations": [ { "iteration_number": 1, "start_time": "00:00:04", ... } ]
}
```

- Ključ je **`iterations`** (engleski), **ne** `iteracije`. Skener koji gleda samo hrvatsku
  varijantu vrati 0 i svaki članak prijavi kao prazan.
- Model slug u imenu datoteke **sadrži točke** (`gemini-3.5-flash`), pa regex
  `_(\d{4}-\d{2}-\d{2})_([^.]+)\.article\.json$` **ne matcha** — ispadne da su svi članci
  `opus`. Koristi `(.+)` ili matchaj s kraja.
- `storage/output/*` su **symlinkovi**, pa `find` bez `-L` propusti ~95% korpusa
  (62,308 PNG-ova vs 621 bez `-L`).

Validator koji ovo poštuje: usporedi `iterations.length` u članku s istim brojem u pripadajućem
`outline.json` i provjeri da svaka iteracija ima tekstualni sadržaj. Nad 167 članaka iz
backfilla dao je 167/167 ispravnih.

---

## 6. ⚠️ NAJOPASNIJA: `hasCompleteArticle` je bio model-scoped samo u jednom smjeru

**Što se dogodilo:** nakon što je zamka #1 oštetila `storage/output/articles-done.json`
(rebuild scope-an na kanal **prepisuje globalnu datoteku** — ostalo je 46 zapisa umjesto
~3,200), nightly je u article koraku javio:

```
📊 Kanala s neobrađenim videima:  46
📊 Ukupno videa za obradu:        3097
```

i krenuo regenerirati **cijeli korpus na Opusu**. Uhvaćeno nakon ~50 min i 8 članaka.
Neprekinuto bi to bilo ~24 dana i reda veličine milijarda tokena.

**Pravi uzrok nije cache nego `hasCompleteArticle()`:** koristi
`findLatestFile(channelDir, basename, "article")` koji traži članak **trenutnog model
sluga**. Postojala je zaštita "ne-degradiraj" za smjer *gemini backend → nađen Claude
članak* (`if (!articlePath && !USING_CLAUDE)`), ali **ne i obrnuta**. Otkad nightly ide
`--gemini-backend claude` (2026-07-29), svaka epizoda s `gemini-*` člankom izgleda
nedovršeno — a jedino što je to skrivalo bio je done-cache.

Dakle cache je bio **jedina brana**, a trebao bi biti samo O(1) optimizacija.

**Ispravak (2026-07-31):** dodana simetrična zaštita — na Claude backendu prihvati
postojeći kompletan članak **bilo kojeg** modela. Provjereno: s namjerno praznim cacheom
red je pao s 3097 na 2, uz `Preskočeno (FS check): 3199`.

**Sanacija cachea** (ako se opet ošteti) — rekonstrukcija s diska je brža i sigurnija od
ponovnog pokretanja alata:

```js
// za svaki *.wav.canary.diarized.srt provjeri postoji li ijedan <base>_*.article.json
// → upiši baseKey u {"completed":[...]} u storage/output/articles-done.json
```

**Namjerni re-run boljim modelom** i dalje radi: scope-aj `--video-id`/`--channel` i obriši
odgovarajući zapis iz `articles-done.json`.

---

## 7. Dodavanje entrypointa u Modal app slomi sve `modal run <file>` pozive

**Što se dogodilo:** dodan je `batch` local entrypoint u `modal_canary/canary_modal.py`.
Time datoteka ima **više** local entrypointa (`main`, `batch`, `download_model`), pa
`modal run <file> --wav ...` više ne može sam odabrati koji pokrenuti:

```
Error: Specify a Modal Function or local entrypoint to run. E.g.
> modal run modal_canary/canary_modal.py::my_function [..args]
```

Poziv u KORAKU 2.6 je non-fatal (`|| echo "⚠️ Modal nije uspio..."`), pa je **padao bez
ikakvog vidljivog učinka**: single-pass logika je uredno našla kandidate, izuzela ih iz
Drive uploada i ostavila ih netranskribirane. Slomljen je time i `_unlisted` ad-hoc put
koji je radio od 2026-07-07 — regresija šira od promjene koja ju je izazvala.

**Pravilo:** kad dodaješ `@app.local_entrypoint()` u postojeći Modal app, **odmah** prođi
kroz sve pozivatelje (`grep -rn "modal run"`) i dopiši `::<entrypoint>`. Jedan entrypoint
radi bez njega, dva ne rade nikad.

**Ispravljeno:** `run_pipeline.sh` i `modal_canary/README.md` sada koriste `::main`.
Provjereno stvarnim pozivom: 200 MB WAV → 559 segmenata, inference 46s.

---

## 8. `| tail -N` na dugotrajnom runu sakrije log do samog kraja

Tri puta u ovoj sesiji izlaz pipelinea je proveden kroz `| tail -70` "da log ne naraste".
Posljedica: dok proces radi, log je **prazan** — nema načina vidjeti gdje je i što je
puklo. Dijagnostika zamke #7 zbog toga je trajala sat vremena umjesto sekunde: poruka o
grešci je cijelo vrijeme postojala, samo je bila zarobljena u bufferu.

**Pravilo:** izlaz dugotrajnog runa piši **direktno u datoteku** (`> log 2>&1`), pa filtriraj
pri čitanju (`grep -aE "KORAK|GREŠKA" log`). Skraćuj na čitanju, nikad na pisanju.

---

## 5. `setsid` ne postoji na macOS-u

Za pozadinski posao koji mora preživjeti pad sesije: `nohup ... &` + `disown`. Log piši u
repo (`automatic/logs/`), **ne** u scratchpad — scratchpad se briše sa sesijom i s njim sav
trag o tome što je run radio.
