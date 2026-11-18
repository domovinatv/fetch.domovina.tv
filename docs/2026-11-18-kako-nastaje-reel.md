---
title: "Kako nastaje reel: od epizode do 9:16 videa s titlom"
subtitle: "Za Zvonimira Žulja (Muževni budite), 18.11.2026."
---

# Kako nastaje reel

Ovaj dokument opisuje kako zasad radimo reelove za Muževni budite, npr. četiri reela iz
re:DEFINICIJE 11 (Ante Lučić). Sve pokreću **skripte iz Claude Code sesije**: Matija napiše
što treba, a Claude pokrene skripte, pregleda rezultat i ispravlja ga. Aplikacije s
gumbima još nema.

Sav kod je javan na GitHubu, u repozitoriju
[domovinatv/fetch.domovina.tv](https://github.com/domovinatv/fetch.domovina.tv).
Linkovi ispod vode na točne datoteke. Ne moraš razumjeti kod; kratki opis kaže čemu
svaka datoteka služi.

## Plan: Reel Studio za Windows

Dogovor je ovakav:

1. **Sada:** reelove radimo ručno iz skripti, epizodu po epizodu. Svaka nova epizoda
   otkrije neki slučaj koji skripte još ne pokrivaju. Na ep. 11 to su bili potpis
   „Napravljeno s domovina.ai”, link na završnoj kartici, ime govornika na kartici
   citata i greške u prijepisu.
2. **Kad nekoliko epizoda prođe bez ručnog popravljanja**, znamo da skripte pokrivaju
   sve slučajeve.
3. **Tada radimo Reel Studio**, Windows aplikaciju u kojoj sam odabereš epizodu, klikneš
   i dobiješ reelove. Ispod će raditi iste skripte kao sada, samo bez Claudea u sredini.

## Tok u pet koraka

```
YouTube epizoda
  → 1. prijepis s vremenom svake riječi          (words.json)
  → 2. izbor najboljih trenutaka od 30–90 s      (reels.json)
  → 3. isječak u 1080p + praćenje lica           (faces.json)
  → 4. kompozicija: titl, kartice, logo kanala   (HyperFrames, HTML)
  → 5. render u MP4 9:16 (1080×1920)
```

### 1. Prijepis i vrijeme svake riječi

Epizoda se transkribira kroz više servisa za prepoznavanje govora (Soniox, Speechmatics,
Canary), a pyannote odredi tko kada govori. Rezultat je prijepis s imenom govornika i
vremenom svake riječi. Iz toga se radi titl riječ po riječ.

- [`generate_words_json.js`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/generate_words_json.js):
  slaže `words.json`, točno vrijeme početka i kraja svake riječi. Bez toga titl ne može
  isticati riječ koja se upravo izgovara.

### 2. Izbor trenutaka

- [`select_reels.js`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/select_reels.js):
  jezični model (Claude Opus) pročita cijeli prijepis i predloži do 8 trenutaka od 30 do
  90 sekundi koji stoje sami za sebe: priču, uvid, emociju, humor. Za svaki da naslov,
  rečenicu za početak („hook”), kartice koje se pojavljuju preko videa (ime i uloga
  govornika, citat, broj, završna kartica) te opis i hashtagove za objavu.
  Model vraća redne brojeve rečenica iz prijepisa, ne vremena, pa reel nikad ne počinje ni
  ne završava usred rečenice.

### 3. Isječak i lice

- [`render_reels.js`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/render_reels.js):
  **glavna skripta** koja vodi korake 3–5. Skine samo traženi dio epizode u 1080p
  (ne cijelu epizodu), pa pozove ostale alate redom.
- [`tools/hyperframes_reel/face_track.py`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/tools/hyperframes_reel/face_track.py):
  pronađe lice u svakom kadru (model YuNet, radi lokalno). Iz vodoravnog 16:9 videa izreže
  uspravni 9:16 kadar tako da govornik ostane u sredini. Kadar se ne pomiče unutar iste
  snimke kamere, nego skoči tek na rezu, kao kad snima kamerman.

### 4. Kompozicija: titl, kartice, logo

- [`tools/hyperframes_reel/compose_reel.js`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/tools/hyperframes_reel/compose_reel.js):
  od kartica iz koraka 2 napravi HTML stranicu s animacijama i titlom riječ po riječ.
  Ovdje se uključuje i isključuje potpis „Napravljeno s domovina.ai” (zastavica
  `--no-credit`, od danas skida i link `domovina.ai` sa završne kartice).
- [`tools/hyperframes_reel/generic.template.html`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/tools/hyperframes_reel/generic.template.html):
  predložak reela, tj. pozadina, raspored, fontovi i mjesto za logo kanala gore desno.
- [`tools/hyperframes_reel/reel_layout.js`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/tools/hyperframes_reel/reel_layout.js):
  pazi da tekst nikad ne prekrije lice i da je sav tekst u „sigurnoj zoni” koju ne
  prekrivaju gumbi Instagrama, TikToka i YouTube Shortsa. Ako kartica ne stane, pomakne
  kameru ili smanji karticu.
- Boje, font i logo kanala čitaju se iz datoteke `brand.json` za Muževni budite. Ona
  namjerno nije u javnom repozitoriju.

### 5. Render

[HyperFrames](https://www.npmjs.com/package/hyperframes) je alat koji HTML stranicu s
animacijama „snimi” u video, kadar po kadar, u pregledniku bez prozora. Prije rendera
složi i storyboard (jedna slika sa svim karticama) da se greška vidi prije nego što
render potraje 2–3 minute po reelu.

## Ručni popravci na ep. 11 (sve što je Claude radio „sa strane”)

Za ep. 11 titl nije išao samo iz jednog prijepisa. Pet automatskih prijepisa je
uspoređeno riječ po riječ i gdje se nisu slagali, uzela se većina (npr. „uvriježenom”
umjesto „uređenom”). Sve je zapisano u jednoj mapi:
[`experiments/2026-11-17-reelsi-ep11-bez-potpisa/`](https://github.com/domovinatv/fetch.domovina.tv/tree/main/experiments/2026-11-17-reelsi-ep11-bez-potpisa).

- [`README.md`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/experiments/2026-11-17-reelsi-ep11-bez-potpisa/README.md):
  što je i zašto napravljeno, korak po korak.
- [`vote_reels.py`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/experiments/2026-11-17-reelsi-ep11-bez-potpisa/vote_reels.py):
  „glasanje” pet prijepisa, ispiše mjesta gdje se ne slažu.
- [`build_root.py`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/experiments/2026-11-17-reelsi-ep11-bez-potpisa/build_root.py):
  upiše ispravke u titl i pripremi sve za render.
- [`reels.json`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/experiments/2026-11-17-reelsi-ep11-bez-potpisa/reels.json):
  četiri odabrana reela s karticama, točno ono što je renderirano.

To ručno glasanje je upravo dio koji u Reel Studiju mora raditi sam. Zato prvo
iteriramo kroz nekoliko epizoda.

## 16:9 isječak s titlom (za YouTube)

Isječak 30:16–36:32 iz ep. 11 radi se drugim alatom, jer ostaje vodoravan i nema
kartica, samo titl i logo:

- [`tools/hyperframes_reel/clip_captions_169.py`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/tools/hyperframes_reel/clip_captions_169.py):
  titl riječ po riječ za vodoravni isječak; zaobilazi trake s imenima koje su već
  ugrađene u snimku.
- Postupak: [`docs/2026-11-17-rucni-isjecak-epizode-na-cdn.md`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/docs/2026-11-17-rucni-isjecak-epizode-na-cdn.md).

## Dodatno čitanje

- [`docs/2026-10-25-reels-kandidati.md`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/docs/2026-10-25-reels-kandidati.md):
  kako se biraju trenuci i kako izgleda `reels.json`.
- [`docs/2026-10-08-reels-layout-best-practices.md`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/docs/2026-10-08-reels-layout-best-practices.md):
  istraživanje sigurnih zona i rasporeda za Reels, TikTok i Shorts.
