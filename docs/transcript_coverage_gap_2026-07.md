# Tihi gubitak transkripta na engleskim kanalima (2026-07-27)

**Status:** nalaz potvrđen, detektor u produkciji, sanacija sadržaja NIJE napravljena.

SSOT za: zašto Canary ispušta sadržaj na engleskom zvuku, kako se to mjeri, i što
YouTube auto-captions donose kao protuteža.

---

## 1. Kako je otkriveno

Polazno pitanje nije bilo o gubitku sadržaja. Traženo je da se u pipeline aditivno
doda skidanje YouTube auto-generated captiona kao **referenca** za engleske kanale
(catholic_futurist, subclub, launched), uz pretpostavku da bi engleski podcasti time
mogli odmah ići na diarizaciju.

Usporedba Canary transkripta i YouTube captiona na epizodi
`biRibr8NByE` ("Why the Pope invited Anthropic to the Vatican") pokazala je da Canary
ima **36-sekundnu rupu** koja kod YouTubea sadrži punih 20 rečenica govora. Provjera
je zatim proširena na cijeli kanal, pa na sve kanale.

## 2. Uzrok

`run_pipeline.sh:624` i `colab_canary/transcribe_canary.py:290` hardkodiraju
`--source-lang hr --target-lang hr` za **sav** zvuk. Na engleskom zvuku to znači da
Canary radi EN→HR **speech-translation**, ne transkripciju.

Dvije posljedice:

1. **Izvorni engleski tekst nigdje ne postoji.** Engleska verzija na siteu nastaje
   kao `EN govor → HR (Canary) → HR članak → EN (translate_to_english.js)`, dakle
   round-trip strojni prijevod vlastitog izvornika.
2. **Canary na dijelovima koje ne uspije prevesti ne emitira ništa.** Bez greške,
   bez upozorenja, bez praznog cue-a — segment jednostavno ne postoji u `.canary.srt`.

Trajanja rupa su gotovo redom višekratnici ~36s, što upućuje na ispadanje cijelih
inference chunkova, ne na nasumičan gubitak.

## 3. Izmjereno

Metoda: zbroj rupa > 10s između uzastopnih SRT cue-ova, plus rep od zadnjeg cue-a do
kraja zvuka, protiv `duration` iz `.info.json`.

| kanal | uzorak | izgubljeno | epizoda >10% |
|---|---|---|---|
| mladi_za_domovinu | 40 | 0.4% | 0/40 |
| iva_kraljevic | 40 | 0.7% | 0/40 |
| domovina_tv | 7 | 0.9% | 0/7 |
| bozanstvena_komedija | 35 | 1.3% | 0/35 |
| glas_koncila | 4 | 1.5% | 0/4 |
| muzevni_budite | 40 | 1.9% | 1/40 |
| **subclub** | 40 | **3.1%** | 3/40 |
| **launched** | 40 | **7.7%** | 6/40 |
| **catholic_futurist** | 18 (svi) | **8.9%** | 7/18 |

Hrvatski kanali sjede na 0.4–1.9%, što je uvjerljivo stvarna tišina, špice i glazba.
Engleski su 3–9× iznad toga.

### Najgori pojedinačni slučajevi (catholic_futurist)

| epizoda | izgubljeno |
|---|---|
| `0NSAfYAnbm8` should_you_be_kind_to_your_ai_chatbot | **56.7%** (1041s od 1836s) |
| `oY_cqjnAI5g` would_you_trust_a_robot_doctor | **53.6%** (583s od 1088s) |
| `TVt4pRtuvF8` ai_loneliness_and_the_need_for_real_presence | **41.3%** (1040s od 2518s) |
| `NWuKcDgUhcE` the_ai_conversation_silicon_valley_isn_t_having | 18.5% (426s od 2296s) |

### Verifikacija da rupe sadrže govor

Za `0NSAfYAnbm8` svaka od 10 rupa provjerena je protiv YouTube EN captiona. Nijedna
nije tišina ni glazba. Nedostaje 3457 od 5961 riječi. Sadržaj u rupama:

```
RUPA 937s→1296s (359s) — 1160 riječi
RUPA 865s→901s  (37s)  — "...a resurgence of an old Christian heresy pelagianism..."
RUPA 685s→756s  (71s)  — "...the word I turn to again and again is incarnation..."
RUPA 252s→468s  (216s) — pravna osobnost strojeva, odgovornost prema stroju
RUPA 1331s→1368s (37s) — Anthropicov rad o introspekciji
```

Dakle upravo teološki najgušći dijelovi — oni zbog kojih Magisterium obogaćivanje
uopće postoji.

## 4. Canary vs YouTube auto-caption — head-to-head

Na `biRibr8NByE`, tri verzije: Canary HR, YouTube EN (izvorni ASR), YouTube HR
(strojni prijevod tog ASR-a).

| dimenzija | Canary | YouTube auto |
|---|---|---|
| segmentacija | 909 cue-ova, čiste rečenice | 2383 fragmenta, medijan 7 riječi |
| preklapanje cue-ova | nema | **100%** (rolling window) |
| interpunkcija | potpuna | u 45% cue-ova |
| disfluencije | očišćene | sirove (`"I I think"`, `"the the"`) |
| **pokrivenost** | **rupe** | **0s ispušteno** |
| markeri govornika | nema | **91× `>>`** (pyannote na istoj epizodi nađe 72 turnusa) |
| izvorni jezik | izgubljen | sačuvan |

### Kako griješe (t≈458s, stvarno izgovoreno "the presence of Anthropic")

| izvor | tekst |
|---|---|
| YouTube EN | „the presence of **entropic**" |
| YouTube HR | „prisutnost **entropije**" |
| Canary HR | „prisutnost **tog predmeta**" |

Bitna razlika u **vrsti** greške: YouTube halucinira uvjerljiv ali krivi tehnički
pojam koji se u prijevodu dodatno pogorša — za RAG i pretragu aktivno štetno. Canary
omane u neodređeno, što je manje opasno.

**Zaključak:** nisu zamjena jedno za drugo. Canary je bolji jezični model, YouTube je
bolji zapisničar.

## 5. Što je napravljeno

| # | Promjena | Datoteka |
|---|---|---|
| 1 | `--write-auto-subs` + `--sub-format srt/vtt` uz svaki novi download | `fetch.js` |
| 2 | `TRANSCRIPT_GAP` detektor (warn >5%, error >15%) | `inspect_pipeline.js` |
| 3 | Backfill titlova za već preuzete epizode, bez re-downloada zvuka | `backfill_youtube_subs.js` |

```bash
node inspect_pipeline.js --channel catholic_futurist   # nađi rupe
node backfill_youtube_subs.js --english-only           # povuci reference
node backfill_youtube_subs.js --video-id <VID>         # jedna epizoda
```

### Napomene o `--sub-lang`

- **Bez wildcarda.** `en.*` povuče i `en-orig`, koji je bajt-identičan `en`.
- `hr` na engleskom videu **nije** hrvatski ASR nego strojni prijevod engleskog
  auto-captiona. Nasljeđuje sve ASR greške i dodaje svoje.
- YouTube servira `srt` nativno za auto-captions — nema konverzije iz vtt.

## 6. Ograničenja nalaza — pročitati prije djelovanja

- **Puni scan flaga 285 od 5875 videa (4.9%), ne samo engleske.** Najviše: hnb 34,
  nanovoroeni 23, 40_dana_za_zivot 20, budi_frajer 18. Ti **nisu** verificirani.
  Dio je gotovo sigurno legitiman — među flagiranima su Thompsonov koncert i
  ceremonije otvorenja, gdje je glazba stvarna „tišina" za govor. Prag od 5% je
  namjerno nisko postavljen za dijagnostiku; ne tretirati flag kao dokaz gubitka.
- **Hrvatska bazna linija nije nezavisno verificirana.** Nema pouzdanog HR
  referentnog transkripta. Kontrast prema engleskim kanalima je jasan, ali tvrdnja
  „hrvatski kanali su zdravi" počiva na razlici u redu veličine, ne na provjeri.
- **YouTube auto-captions ne postoje uvijek.** Provjereni hnb videi iz 2017
  (`UNl-tEsAM0E`, `sNgK9dYO680`) nemaju **nikakve** auto-captions. Backfill na
  starijim hrvatskim kanalima vratit će mnogo „nema titlova".
- **Beamly epizode nemaju YouTube izvor.** 169 od 307 epizoda na subclub/launched
  ima sintetički `_yt_` ID (`_yt_matched: false`) — za njih referenca ne postoji.
  Backfill ih preskače. Ostaje 138 epizoda s pravim YouTube ID-om.

## 7. Otvoreno — NIJE napravljeno

1. **Sanacija postojećeg sadržaja.** 138 epizoda je objavljeno s nepotpunim
   transkriptom. Članci, RAG chunkovi i Magisterium obogaćivanje za njih su
   generirani nad tekstom kojem nedostaje sadržaj. Ništa od toga nije regenerirano.
2. **Odluka o smjeru prijevoda za engleske kanale.** Opcija A: EN transkript je
   master, HR nastaje prijevodom (traži novu granu u koracima 7+8 i obrće
   `translate_to_english.js`). Opcija B: HR ostaje master, EN caption samo kao
   referenca. Nalaz iz ovog dokumenta jako podupire A.
3. **Zašto Canary ispušta chunkove.** Nije istraženo je li to svojstvo
   `--source-lang hr` na stranom zvuku, long-form inference postavki u
   `transcribe_canary.py`, ili nešto treće. Bez toga je popravak nagađanje.
4. **`>>` markeri kao diarizacijski signal.** 91 marker vs 72 pyannote turnusa na
   istoj epizodi — neistraženo kao ulaz u `assign_speakers`.
5. **Re-segmentacija auto-captiona.** Ako YT caption ikad postane ulaz u
   diarizaciju, 100% preklapajući rolling cue-ovi traže spajanje na rečenične
   granice (~50 linija deterministickog koda).

## 8. Povezano

- `docs/PIPELINE_FULL.md` — koraci 0→13
- `docs/translation_throughput_vision_2026-06.md` — EN prijevod
- `docs/transcription_colab_vs_modal_cost_2026-07.md` — gdje se transkribira
- `docs/content_gaps_audit_2026-07-25.md` — raniji audit rupa (druge vrste)
