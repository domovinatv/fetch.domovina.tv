# re:DEFINICIJA 11: reelovi 1, 2, 4, 6 bez potpisa, titl iz pet ASR-a (17.11.2026.)

Zvonimir Žulj (Muževni budite) je 17.11. tražio iste reelove kao 12.11., ali bez potpisa
„Napravljeno s domovina.ai” dolje desno. Logo kanala gore desno i završna kartica
(`domovina.ai/v/RdEN7Ny1bV8`) ostaju. Usput je titl ispravljen glasanjem: 12.11. je išao
samo iz Sonioxa.

| Reel | Naslov | Raspon |
|---|---|---|
| 1 | Nisam ponosan, zahvalan sam što sam Hrvat | 05:29–06:52 |
| 2 | Preživljavaju Hrvati, Srbi i žohari | 12:28–13:52 |
| 4 | Bilo bi bolje da imaš deset neuspjeha | 35:13–36:31 |
| 6 | Ocjene mog sina me ne zanimaju | 57:08–58:21 |

## Izvori

- Izbor i kartice od 12.11.: `raw_reels_2026-11-12.json`, izvučen iz transkripta sesije
  `240b2256` (privatni korijen u njezinom scratchpadu je obrisan). Kartica citata u reelu 4 je
  `context` sa „Stariji kolega: …”, kao u konačnom renderu od 12.11.
- Titl: cue-ovi `../2026-11-16-ep11-soniox-vs-canary/soniox_ep11.diarized.srt` (isti `seq` kao
  12.11.), vremena riječi iz `soniox_sirovi_izlaz.json`.
- Glasovi: Gemini 4 Hydrogen i Argon (app, cijela epizoda), Speechmatics, Canary sirovi
  (`canary.asr.srt` = CDN `diarized.asr.srt`) i Canary nakon Opus ispravka (`canary_opus.srt`).

## Skripte

1. `vote_reels.py` → `glasanje.txt` (regije gdje se Soniox ne slaže s ≥2 od 5 glasova) i
   `soniox_tokens.json` (svaki token cue-a s vremenom).
2. `build_root.py <root>` → `<root>/muzevni_budite/<base>.{segments.jsonl,words.json,info.json}`.
   Ispravci (`FIX`): „uređenom” → „uvriježenom” (5/5), „ishendali” → „ishendlali”,
   „ali klinci” → „jer klinci”, „5-0” → „5,0” (×3). Reel 4 preuzima riječi i vremena iz
   titla 16:9 isječka (`../2026-11-17-isjecak-ep11-3asr/transcript_3asr.json`, ~20 ispravaka:
   „krše taj”, „dva-tri fejlana projekta”, „pa daj Bože”, „I tek kasnije”…). Voditeljev
   „Točno.” prije reza je izbačen.
3. `reels.json`: `normalizeReels()` nad sirovim izborom, rang po redoslijedu iz poruke, samo 1/2/4/6.
4. `render_reels.js --render-only --no-credit --top 6` (nova zastavica; potpis je i dalje default).

Ostalo (poštapalice „jel”, „ne”, „ovaj”, „Da, znači”) namjerno nije ubačeno: titl reela je čitljiv
govor, ne doslovni zapis.

## Rezultat

CDN (`clips/<ID>/`, immutable, kao 16:9 isječak), poslano Zvonimiru izravno (`1013763305630@lid`),
uvod s napomenom da piše Claude, svaki video s vlastitim opisom i linkom:

- https://cdn.domovina.ai/clips/RdEN7Ny1bV8/RdEN7Ny1bV8_reel1_05m29s-06m52s_9x16.mp4
- https://cdn.domovina.ai/clips/RdEN7Ny1bV8/RdEN7Ny1bV8_reel2_12m28s-13m52s_9x16.mp4
- https://cdn.domovina.ai/clips/RdEN7Ny1bV8/RdEN7Ny1bV8_reel4_35m13s-36m31s_9x16.mp4
- https://cdn.domovina.ai/clips/RdEN7Ny1bV8/RdEN7Ny1bV8_reel6_57m08s-58m21s_9x16.mp4

Storyboardi u `storyboard/`, konačni `reels.json` uz njih. Upload: `upload_reels.js` (odbija prepis postojećeg ključa).

## Zamke

- **Kartica `quote` potpisuje `reel.speaker`**, a to dolazi iz `speaker` u segments.jsonl. Sa sirovim
  `SPEAKER_00` reel kaže „— SPEAKER_00”: uhvaćeno na storyboardu, reelovi 1, 2, 6 renderirani ponovno.
  `build_root.py` zato preimenuje govornike (`NAMES`).
- **HyperFrames Chrome** je u `~/.cache/hyperframes/chrome` (symlink na DOMOVINA2TB, EPERM iz sesije),
  a `HYPERFRAMES_CACHE_DIR` ga ne preusmjerava. Radi s puppeteerovim headless shellom s internog diska:
  `HYPERFRAMES_BROWSER_PATH=PRODUCER_HEADLESS_SHELL_PATH=~/.cache/puppeteer/chrome-headless-shell/mac_arm-153.0.8010.36/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  uz `HYPERFRAMES_EXTRACT_CACHE_DIR`, `HYPERFRAMES_FONT_CACHE_DIR`, `PRODUCER_RENDERS_DIR`,
  `REELS_WORK_DIR`, `XDG_RUNTIME_DIR` u scratchpadu. Render ~2,2 min po reelu.
- Stari `$TMPDIR/hyperframes-extract-cache-501` (1,9 GB, 16:9 isječak) ostaje iza rendera; obrisan.

## Usput: Apple DictationTranscriber (hr-HR) na istom 6-min isječku

`apple_dictation.swift` (SpeechAnalyzer + `DictationTranscriber`, on-device; prvi poziv skine model,
prvi pokušaj je pao s „Network Error”, drugi prošao). 376 s zvuka za 6 s. Prema referenci
(`../2026-11-17-isjecak-ep11-3asr/transcript_3asr.json`, 880 riječi):

| | riječi | razlika prema referenci |
|---|---|---|
| Soniox sirovi | 869 | 4,8 % |
| Apple Dictation | 779 | 24,8 % |

Ispušta riječi, nema interpunkcije između rečenica, griješi u sadržaju („Yes moram priznati”,
„fikcija”). Za razgovor dvoje u studiju nije kandidat. Izlaz: `apple_dictation_isjecak.json`.
Iz Claude Code sesije nema puta da se audio preda Claudeu na transkripciju (Opus ovdje prima tekst,
slike i PDF).
