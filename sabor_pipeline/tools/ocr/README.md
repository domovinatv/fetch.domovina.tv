# vision_ocr — offline OCR sličica (macOS Vision)

Mali binarni alat koji `ocr_captions.js` zove za čitanje natpisa s ekrana.

```bash
swiftc -O -o sabor_pipeline/tools/ocr/vision_ocr sabor_pipeline/tools/ocr/vision_ocr.swift
```

Binarni izlaz **nije u gitu** (arm64 Mach-O, gradi se u sekundi). Izvor jest.

## Zašto Vision, a ne Tesseract ili model

Traži se izvor identiteta koji **ne ovisi ni o čemu izvan ovog stroja** — cijela
je svrha natpisa s ekrana da bude neovisan i o najavi predsjedavajućeg i o
modelu. Vision je na disku, ide na Neural Engine, ne šalje ništa nikamo, i
izmjereno troši **55 ms po sličici** (1191 sličica za 44 s).

## Hrvatski nije podržan — i to je izmjereno, ne pretpostavljeno

`--list-languages` ne vraća `hr-HR`. Provjereno je koliko to smeta:

| jezik | čitanje | pouzdanost |
|---|---|---|
| `en-US` | „Siniša Hajdaš Dončić", „Urša Raukar Gamulin" | **1.00** |
| `cs-CZ` | isti tekst | 0.50 |
| `pl-PL` | isti tekst | 0.50 |

Dijakritika prolazi i bez hrvatskog modela jer je `usesLanguageCorrection`
**isključen** — imena nisu rječnik, a jezična korekcija ih upravo kvari.
Zato je zadani jezik `en-US`.

## Koordinate

`box` je `[x, y, w, h]` u Visionovim normaliziranim koordinatama s ishodištem
**dolje-lijevo** (y raste prema gore). Pozivatelj filtrira po tome gdje natpis
stoji — vidi `POLJE_IME` / `POLJE_VRSTA` u `ocr_captions.js`.
