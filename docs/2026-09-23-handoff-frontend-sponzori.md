# Handoff: prikaz sponzora u domovina.ai (Flutter)

**Datum:** 23.09.2026. · Prompt za Claude Code sesiju u `/Users/ms/git/domovinatv/domovina.ai`.
Zalijepi sve ispod crte kao prvu poruku. Ujedno je ovo ugovor podataka `sponsors_in_video.json` za frontend.

---

Zadatak: prikaži „sponzore epizode" na stranici epizode u domovina.ai (Flutter), iskodiraj, testiraj i deployaj po uobičajenoj proceduri ovog repoa.

## Kontekst

Pipeline (sibling repo `../fetch.domovina.tv`) od 23.09.2026. za SVAKU epizodu objavljuje na CDN-u:

    https://cdn.domovina.ai/data/{youtubeId}/sponsors_in_video.json

To su sponzori UGRAĐENI u snimku: partneri koje je autor podcasta sam doveo i koji su omogućili epizodu. Nije riječ o YouTube-ovim oglasima. Ne sakrivamo ih i ne preskačemo. Dajemo im vidljivo, dostojanstveno mjesto i gumb „poslušaj" za točan raspon u snimci.

VAŽNO — imenovanje: ovo su `sponsors_in_video`, namjerno odvojeni od budućih DINAMIČKIH sponzorstava koja će se na domovina.ai kupovati nakon snimanja (zaseban proizvod, zaseban izvor podataka). U kodu i UI-ju drži ih odvojeno: model/servis/widget s imenom tipa `SponsorsInVideo`, ne generičko `Sponsors`, da kasnije dinamički sponzori dođu kao zaseban sloj.

Podaci na CDN-u su živi: 3290 objavljenih epizoda, 475 ih ima barem jednog sponzora, a 65 segmenata ima `playable: true`.

## Ugovor podataka (schema_version 1)

```json
{
  "type": "sponsors_in_video",
  "schema_version": 1,
  "generator": "detect_sponsors.js@1",
  "video_id": "B8xUC-nIVkM",
  "has_transcript": true,
  "sponsors": [
    {
      "id": "plazma",                        // slug, stabilan unutar epizode
      "name": "Plazma",                      // može biti null (vidi dolje)
      "role": "sponsor",                     // sponsor | partner | wardrobe | studio
      "url": "https://www.plazma.rs/",       // web sponzora, može biti null
      "instagram": null,                     // može biti null
      "blurb": "Jedinstven ukus, …",         // autorov reklamni tekst iz opisa, može biti null (≤600 zn.)
      "description_lines": ["Plazma: https://www.plazma.rs/"],
      "source": "description",               // description | channel | transcript
      "segments": [
        {
          "kind": "rubric",                  // spot | host_read | rubric | mention | chapter
          "start": 3601, "end": 3830,        // sekunde u snimci (već s ±1 s zalihe)
          "duration": 229,
          "start_hms": "01:00:01", "end_hms": "01:03:50",
          "playable": true,                  // true = granice pouzdane → smije „▶ poslušaj"
          "confidence": "high",              // high | medium | low
          "signals": ["rubric_intro_with_sponsor", "rubric_outro"],
          "url": "https://domovina.ai/v/B8xUC-nIVkM/t/3601",
          "text": "Dragi, svi dobrodošli u plazmin. …"   // transkript segmenta (≤1200 zn.)
        }
      ]
    }
  ]
}
```

Značenje `kind`:
- `spot`: produciran oglas s posebnim glasom (npr. Iva Kraljević ep. 50, e-Duhovne vježbe, 5963–6008 s).
- `host_read`: voditelj čita poruku sponzora („Ovu epizodu podržava HiPP…").
- `rubric`: sponzorirana rubrika („Grickaj i biraj uz Plazmu").
- `mention`: jedna rečenica zahvale.
- `chapter`: autorovo poglavlje nazvano po sponzoru.

Uloge:
- `wardrobe` = „Voditeljicu odijeva…"
- `studio` = „Opremanje studija pomogli…"

Te dvije uloge nemaju segmenata; prikaži ih samo kao zahvalu ili kredit.

`sponsors: []` znači „epizoda nema sponzora" (to NIJE greška). Datoteka postoji za svaku objavljenu epizodu.

Zapis s `"name": null` i `"id": "_unattributed"` je segment za koji detektor zna da je sponzorski, ali ne zna čiji. Ne prikazuj ga istaknuto; smije ostati neprikazan.

Testni primjeri:
- `aue1GuuMsbA`: Iva Kraljević ep. 50. Spot e-Duhovnih vježbi 5963–6008, playable, high. Uz to Cafe Brazil (partner, mention) i jedan unattributed.
- `B8xUC-nIVkM`: Rastući s djecom. Plazma host_read + rubrika od 229 s, plus wardrobe.
- `NwLeHiokKSU`: jedan host_read pripisan dvama sponzorima (HiPP i Plazma, isti segment u oba; Plazma ima i rubriku na 1990 s).
- `AAzm0ftoqsg`: prazan `sponsors: []`.

## UX zahtjevi

1. Na stranici epizode (`/v/:id`) dodaj sekciju tipa „Uz podršku" / „Sponzori epizode". Prikazuj je samo kad postoji barem jedan sponzor s imenom.
   - Kartica po sponzoru: ime, uloga (npr. „Partner podcasta", „Sponzor epizode", „Garderoba"), link na web i/ili Instagram (otvara vanjski preglednik) i `blurb` ako postoji (skraćen, s „više").
   - Ton je zahvala partneru, a ne „reklama".
2. Za segmente s `playable: true`: gumb „▶ Poslušaj poruku sponzora" (ili za rubriku njezin naziv). Pušta snimku od `start` i automatski staje ili pauzira na `end`. Koristi postojeći player epizode; ne uvodi novi izvor medija.
3. Za segmente s `playable: false` (`mention`, `chapter`, ili bez imena): samo link „na {start_hms}" koji skače na trenutak (postojeća ruta `/v/:id/t/:sec`), bez auto-stopa.
4. Nikad ne linkaj na YouTube; svi timestampovi idu kroz domovina.ai rute.
5. Neobavezno, ako je jeftino: na vremenskoj crti playera diskretno označi playable raspone.

## Tehničke zamke (obavezno)

- Flutter čita SAMO CDN; veza je YouTube ID (polje `id` epizode).
- CDN odgovor ima `Cache-Control: public, max-age=31536000, immutable` i `Vary: Origin`. Pipeline ključ prepisuje i purgea kad se detektor poboljša, pa NE keširaj agresivno u aplikaciji preko sesije. Obično dohvaćanje s običnim HTTP cacheom je dovoljno.
- Na 404 ili grešku u mreži/parsiranju: tiho ne prikazuj sekciju. Nikad ne ruši stranicu epizode. Ne radi polling ni ponovno dohvaćanje u petlji: zapamćeni 404 na edgeu drži se godinu dana.
- Parsiraj defenzivno:
  - nepoznat `kind`/`role`: preskoči ili prikaži generički;
  - `schema_version` > 1: pokušaj, ali ne ruši;
  - `name`, `url`, `instagram`, `blurb` smiju biti null.
- Fetch je neovisan o article.json / summary.json. Učitaj ga paralelno i lijeno, da ne usporava prvi prikaz.
- Web (Flutter web) mora raditi: CDN vraća `access-control-allow-origin: *` (provjereno). Provjeri u pregledniku, ne samo curlom (curl bez `Origin` gađa drugi cache zapis).

## Postupak

1. Najprije istraži repo:
   - gdje se dohvaćaju ostali per-epizoda JSON-ovi s CDN-a (npr. summary.json, article.json) i slijedi isti obrazac (model, servis, state management);
   - gdje je player i kako se radi seek na `/t/:sec`.
2. Implementiraj model, servis i widget uz postojeće konvencije. Dodaj unit testove za parsiranje (uključujući null polja, prazan niz i nepoznat kind) i, ako repo to radi, widget test.
3. Provjeri u pravom pregledniku na `aue1GuuMsbA`, `B8xUC-nIVkM` i `AAzm0ftoqsg`:
   - kartica se prikazuje ili je nema, ovisno o epizodi;
   - „Poslušaj" na Ivinom spotu kreće na 01:39:23 i staje na 01:40:08;
   - konzola nema grešaka.
   Uskladi i mobilnu širinu.
4. Deployaj po proceduri koju repo već koristi (pročitaj CLAUDE.md/README; ne izmišljaj novi deploy put) i verificiraj na produkciji.
5. Commitaj s jasnom porukom i daj mi kratak sažetak s linkovima na tri testne epizode.

Izvor istine za detektor i pravila: `../fetch.domovina.tv/docs/2026-09-23-sponzori-u-snimci.md`.
