# re:DEFINICIJA 11: reelovi 1, 2, 4, 6 bez ijednog „domovina.ai” (18.11.2026.)

Zvonimir Žulj, 18.11. 20:45: „Ovo na kraju gdje piše domovina.ai ne smije biti, kaže Kruno.”
Reelovi od 17.11. (`../2026-11-17-reelsi-ep11-bez-potpisa/`) su bili bez potpisa dolje desno,
ali završna kartica je još imala `domovina.ai/v/RdEN7Ny1bV8`.

- Kod: `--no-credit` sada gasi i taj link (`compose_reel.js`, `premium/compose_premium.js`).
  Kartica ostaje: logo kanala, naslov, ime kanala. Default (bez zastavice) nepromijenjen.
- Ulaz isti kao 17.11.: `../2026-11-17-reelsi-ep11-bez-potpisa/build_root.py <root>` + njegov `reels.json`.
- Render: `render_reels.js --input-dir <root> --video-id RdEN7Ny1bV8 --render-only --no-credit --force --top 6`
  s istim HyperFrames env varijablama kao 17.11. (README tamo, §Zamke). 4 reela, ~8 min.
- Provjera: `zadnji_kadrovi.png` (zadnji kadar sva 4 reela) i `storyboard/`.
- CDN (novi ključevi `_v2`, stari su immutable), `upload_reels.js`:
  - https://cdn.domovina.ai/clips/RdEN7Ny1bV8/RdEN7Ny1bV8_reel1_05m29s-06m52s_9x16_v2.mp4
  - https://cdn.domovina.ai/clips/RdEN7Ny1bV8/RdEN7Ny1bV8_reel2_12m28s-13m52s_9x16_v2.mp4
  - https://cdn.domovina.ai/clips/RdEN7Ny1bV8/RdEN7Ny1bV8_reel4_35m13s-36m31s_9x16_v2.mp4
  - https://cdn.domovina.ai/clips/RdEN7Ny1bV8/RdEN7Ny1bV8_reel6_57m08s-58m21s_9x16_v2.mp4
- Poslano Zvonimiru (`1013763305630@lid`) s PDF-om `docs/2026-11-18-kako-nastaje-reel.md`
  (pandoc → HTML → Chrome `--print-to-pdf`) i odgovorom o aplikaciji: Reel Studio ne postoji,
  sve ide iz skripti u Claude Code sesiji. Windows aplikacija dolazi kad nekoliko epizoda prođe
  bez ručnih popravaka.
- Tražio je i „cijelu aplikaciju” da je koristi doma: odgovoreno kao gore (Matijina odluka).
