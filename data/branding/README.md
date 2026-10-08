# Branding po kanalu

Boje, font i logotip kanala za izvedene artefakte (zasad reelsi — `tools/render_reel.py
--brand`). Jedan direktorij po kanalu, ključ = ime kanala u `storage/output/`.

```
data/branding/
  fonts/                      slobodni fontovi (OFL) — zamjene za licencirane
  domovina_ai/brand.json      tehnološki partner (role: technology) — potpis u kutu
  <kanal>/brand.json          autor sadržaja (role: creator) — primaran brend
  <kanal>/logo_wide.png|svg   vodoravni logo (reel ga stavlja iznad naslova)
  <kanal>/emblem.png|svg      samo znak, bez teksta
```

## brand.json

| Polje | Što |
|---|---|
| `colors` | imenovane boje kanala (hex) |
| `color_roles` | gdje se koja boja vidi na izvoru — da se zna zašto je izabrana |
| `typography.original` | font kanala; ako je pod licencom (Adobe Fonts, komercijalni), **ne skida se** |
| `typography.title/body/caption` | putovi do TTF-a, relativni na brand.json |
| `logo.*` | putovi do logotipa, relativni na brand.json |
| `reel.*` | uloge za reel: `caption_active`, `badge_bg`, `badge_text`, `bg_tint` (ime boje ili hex), `stripe` (dvije boje) |
| `credit` | (samo partner) tekst potpisa uz logo |

## Kako se skuplja (≈10 min po kanalu)

1. Stranica kanala u claude-in-chrome (Brave `ms@ff.hr`). `getComputedStyle` po
   elementima (h1/h2, nav, istaknuti tekst, header/footer), `meta[name=theme-color]`,
   `link[rel=stylesheet]` za izvor fonta, `img.custom-logo` / inline `<svg>` za logo.
2. Logo SVG skinuti `curl`-om; rasterizirati **`rsvg-convert`**, ne ImageMagickom —
   `magick` krivo crta gradijent s tvrdim prijelazima (zastava u domovina.ai logu
   ispala je bijeli kvadrat).
3. Ako je font licenciran, izabrati OFL zamjenu sličnog karaktera s hrvatskim
   dijakriticima i zapisati oboje u `typography`.

## Prava

Logotipi i boje pripadaju kanalima. Koriste se isključivo za izvedene artefakte
**njihova vlastitog** sadržaja. Prije javne objave reela pod brendom kanala treba
suglasnost kanala. `mladi_za_domovinu`: skinuto s mladizadomovinu.hr 08.10.2026.,
suglasnost još nije potvrđena.
