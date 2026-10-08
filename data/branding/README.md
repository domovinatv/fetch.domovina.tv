# Branding za izvedene artefakte

Boje, font i logotip za izvedene artefakte (zasad reelsi, `tools/render_reel.py --brand`).

**Brendovi kanala i organizacija NISU u repou.** Repo je dio pipelinea i ostaje
univerzalan. Brendovi su lokalna konfiguracija: u gitu su samo ovaj README, predložak
`_example/` i `domovina_ai/` (naš potpis). Sve ostalo pod `data/branding/` je
gitignored. Isti direktorij može živjeti i izvan repoa:

```bash
export DOMOVINA_BRANDING_DIR=~/domovina-branding   # default: data/branding/
python3 tools/render_reel.py ... --brand <ime> --partner domovina_ai
```

`--brand <ime>` čita `$DOMOVINA_BRANDING_DIR/<ime>/brand.json`; može i puna putanja.

```
<DOMOVINA_BRANDING_DIR>/
  fonts/                 fontovi (OFL ili zamjene za licencirane)
  domovina_ai/           tehnološki partner (role: technology), potpis u kutu, U REPOU
  _example/brand.json    predložak, U REPOU
  <ime>/brand.json       role: creator (autor kanala) ili guest (organizacija gosta)
  <ime>/logo_wide.png    vodoravni logo (iznad naslova); na tamnoj pozadini bijela verzija
```

## brand.json

| Polje | Što |
|---|---|
| `role` | `creator` (kanal je autor), `guest` (organizacija gosta), `technology` (partner) |
| `colors` | imenovane boje (hex) |
| `color_roles` | gdje se koja boja vidi na izvoru, da se zna zašto je izabrana |
| `typography.original` | izvorni font; ako je pod licencom (Adobe Fonts, komercijalni), **ne skida se** |
| `typography.title/body/caption` | putovi do TTF-a, relativni na brand.json |
| `logo.*` | putovi do logotipa, relativni na brand.json |
| `reel.*` | uloge za reel: `caption_active`, `badge_bg`, `badge_text`, `bg_tint` (ime boje ili hex), `stripe` (dvije boje) |
| `credit` | (samo partner) tekst potpisa uz logo |

## Kako se skuplja (≈10 min)

1. Otvoriti službenu stranicu u browseru. Čitati CSS varijable (npr. Elementor
   `--e-global-color-*`, `--e-global-typography-*`), `getComputedStyle` po elementima
   (h1/h2, nav, header/footer), `meta[name=theme-color]`, izvor fonta
   (`link[rel=stylesheet]`), logo (`img.custom-logo`, inline `<svg>`).
2. Paziti na disambiguaciju domena: ista kratica često pripada drugoj organizaciji.
3. Logo SVG skinuti `curl`-om; rasterizirati **`rsvg-convert`**, ne ImageMagickom
   (`magick` krivo crta gradijente s tvrdim prijelazima).
4. Ako organizacija već ima vlastiti brand book ili design tokene (npr. u nekom drugom
   projektu), oni su izvor istine. Boje koje izvedeš sam (npr. tamniju pozadinu) zamijeni
   njihovim tokenima.
5. Ako je font licenciran, izabrati OFL zamjenu sličnog karaktera s hrvatskim
   dijakriticima i zapisati oboje u `typography`.

## Pravila

- **Svaki reel nosi `--partner domovina_ai`**, bez obzira čiji je brend primaran. Bez
  toga reel izgleda kao da ga je napravila organizacija s loga. Kad je zadan i
  `--footer` (izvor, npr. „Podcast X #N“), crtaju se oba retka.
- Logotipi i boje pripadaju vlasnicima. Za javnu objavu pod tuđim brendom treba
  suglasnost vlasnika brenda i autora snimke.
