# Postavke kanala u pipelineu (12. 11. 2026.)

Vlasnik YouTube kanala s potvrđenim vlasništvom na domovina.ai uključuje i isključuje 20
funkcionalnosti nad svojim kanalom. Lanac je u `domovina.ai/postavke-kanala/` (ovo je
sesija S7, odluke 700–709 u `postavke-kanala/docs/decisions.md`). Ovaj dokument opisuje samo
pipeline.

## Izvor stanja

Katalog `GET https://domovina.ai/api/katalog/v1/settings`, jednom po runu:

```
{"version":"1","settings":{"UC…":{"status":"active|withdrawn|deleted","off":["ebook",…]}}}
```

Navedeni su samo UC-ovi s nečim isključenim. Kanal kojeg nema = sve uključeno.

```bash
node tools/channel_settings.js fetch --out /tmp/s.json   # exit 0 ok, 2 nedostupno
node tools/channel_settings.js show                      # što je isključeno
node tools/channel_settings.js check --key ebook --file storage/output/<kanal>/<base>.info.json
```

`run_pipeline.sh` na početku napravi `storage/.channel_settings.run.<PID>.json` i izveze
`CHANNEL_SETTINGS_FILE`; svi koraci čitaju tu snimku. Skripta pokrenuta sama dohvati jednom
i spremi u `storage/.channel_settings.json` (15 min svježe). Uspješna snimka se kopira i u
`storage/.channel_settings.last_ok.json`.

UC epizode: `channel_id` iz `<base>.info.json` (vlasnik sadržaja) **i** UC kanala liste iz
`data/podcasts_registry.json` po slugu (direktorij `domovina_tv` = registry `domovina-tv`).
Isključeno kod bilo kojeg od njih = preskoči.

## Dvije vrste ograde

| | Obrada (`gate()`) | Čitači (`readerGate()`) |
|---|---|---|
| Tko | fetch, ingest, WAV, ASR, AI koraci, Tier 2 enqueue, EN/Magisterium red, Vertex | KORAK 13 indeksi, watch_candidates, discover, WhatsApp, glasački bazen |
| Katalog nedostupan | **fail-closed**: ništa se ne obrađuje, `⛔ POSTAVKE KANALA NEDOSTUPNE` | zadnja uspješna snimka; bez nje bez filtra i upozorenje |
| Zašto | zadano uključeno bi obradilo povučen kanal | čitač je druga linija (aplikacija i worker filtriraju sami); pad kataloga ne smije isprazniti naslovnicu |

## Ključ → korak

| Ključ | Gdje se ne generira novo |
|---|---|
| `channel_enabled`, `processing` | `fetch.js` (prije skidanja; ne piše state), `ingest_beamly.mjs`, `ingest_rss.mjs`, `automatic/enqueue_all_new.js`, i svaki korak ispod (checkStep) |
| `cdn_playback` + `transcript_subtitles` oba off | medij se ne skida (nema što objaviti, odluka 108) |
| `transcript_subtitles` | `convert_to_wav.js`, 2.6 `tools/scan_modal_candidates.js`, 2.7, 2.7b, 2.7c, 2.8, 9.87 `generate_words_json.js`, `segments.jsonl` |
| `article_summary` | 7 `summarize_gemini.js`, 8 `generate_article_gemini.js` |
| `english_translation` | `translate_to_english.js`, `automatic/enqueue_en_new.js` |
| `magisterium` | `tools/magisterium_mcp_episode.js`, `automatic/enqueue_magisterium_backfill.js` |
| `highlights_reels` | 9.9 `select_reels.js`, `render_reels.js` (+ `share_clips`) |
| `share_clips` | 9.6 `generate_og_sections.py` (batch `node lib/channel_settings_steps.js filter`), `share_to_whatsapp.js` poglavlja |
| `ebook` | 9.8 `generate_ebook.js`, `tools/force_upload_epubs.js` |
| `sponsors_in_video` | 9.85 `detect_sponsors.js` |
| `ai_assistants` | 11 `import_to_vertex.js` |
| `home_featured`, `in_app_search` | 13 `generate_channel_index.js` (`home.json`, `search.json`) |
| povučen/obrisan | 13 izvan `index.json`, listinga, `home.json`, `search.json`; glasački bazen → `withdrawn` |
| tombstone (`deleted`) | `watch_candidates.js`, `data/discovery/discover.js`, Tier 2: nikad se ne vraća |

Ovisnosti (odluka 108) zatvara `closeOff` u `lib/channel_settings.js`: master gasi sve,
`transcript_subtitles` gasi sve AI ključeve, `article_summary` gasi ebook, Magisterium, EN,
isječke i vijesti.

## Pravila

- **Ništa se ne briše** (odluka 8). Postojeće datoteke na disku i R2 ostaju; samo se ne
  generira novo. Brisanje je `channel-delete.sh` u lancu (S9).
- **Preskočena epizoda ne dobiva marker ni state** (`failed[]`, `.words.skipped.json`,
  done-cache). Kad vlasnik uključi ključ, sljedeći run je obradi sam.
- Preskakanje se vidi u logu kao `⏭️ postavke kanala: <razlog>`.

## Poznate rupe

- KORAK 2.5 (rclone WAV na Drive) i ugašeni KORAK 6 nemaju ogradu.
- Lista Tier 1 se provjerava po kanalu liste prije skidanja; epizoda tuđeg kanala na listi
  hvata se tek u `convert_to_wav`/ASR (po `info.json`).
- `render_reels.js` objava (`publishPhase`) i dalje šalje već postojeći `reels.json`.
- Magisterium job koji ručno pokrene admin: skripta izađe 0, a bridge
  (`pipeline.domovina.ai/bridge/magisterium_poller.js`) ga označi kao failed.
- `lib/channel_settings_filter.js` (ulaz) i `lib/channel_settings_steps.js` (AI koraci) su
  dva tanka pomoćnika nad istim modulom; spojiti kad se prvi put diraju.
