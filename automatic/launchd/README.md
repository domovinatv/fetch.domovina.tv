# Nightly pipeline (launchd)

Automatsko pokretanje cijelog pipeline-a jednom dnevno u **03:00 lokalno**, na macOS-u, preko `launchd`.

## Što se pokreće

Wrapper: [`automatic/nightly_pipeline.sh`](../nightly_pipeline.sh) — jedan idempotentan prolaz:

| Faza | Što radi | Skripta |
|---|---|---|
| **A** — priprema za Colab | rclone sync, fetch novih videa, MP3→WAV, upload WAV-ova na Drive | `run_pipeline.sh` koraci 0–2.5 |
| **B** — post-Colab catch-up | diarizacija (lokalno), summary, article, RAG, og-share, og-sections, screenshots, R2 upload | `run_pipeline.sh` koraci 5–10, 12 |
| **Završno** | regen channel index + upload `channels/data/*` na CDN | `generate_channel_index.js` + `upload_to_r2.js --meta-dir storage/meta` |

Sve je idempotentno — svaki korak skipa već dovršen posao. Manualno pokretanje istog scripta ide ručno:

```bash
./automatic/nightly_pipeline.sh
```

## Što NIJE uključeno

- **`--with-vertex-import`** — chain dependency na završenu Canary transkripciju (vidi memory `pipeline_catchup_pass_without_transcription.md`). Pokreni manualno kad si siguran da Canary nije in-flight na Colabu.
- **Colab notebook** — nije automatiziran. Nakon faze A, WAV-ovi čekaju na Drive-u; ručno pokreni `colab_canary/domovina_tv_canary_transcribe.ipynb` na G4. Faza B sljedeće noći će pokupiti `.canary.srt` koje Colab digne natrag na Drive.

## Instalacija

```bash
./automatic/launchd/install.sh
```

Što radi:
1. Kopira `tv.domovina.fetch.nightly.plist` u `~/Library/LaunchAgents/`
2. Boot-strap-a u GUI launchd domenu (`gui/$UID`)
3. Provjeri status preko `launchctl print`

Reinstall (npr. nakon edit-a plist-a): pokreni `install.sh` ponovo — automatski unload-a stari boot-strap pa load-a novi.

## Uninstall

```bash
./automatic/launchd/uninstall.sh
```

## Manualno trigger-anje (bez čekanja na 03:00)

```bash
launchctl kickstart -k gui/$(id -u)/tv.domovina.fetch.nightly
```

`-k` ubije postojeću instancu ako je još running, pa pokrene novu. Korisno za debug.

## Status & dijagnostika

```bash
# Je li boot-an?
launchctl print gui/$(id -u)/tv.domovina.fetch.nightly

# Sljedeći scheduled run + zadnji exit code
launchctl print gui/$(id -u)/tv.domovina.fetch.nightly | grep -E "state|next run|last exit"

# Live pipeline log za današnji run
tail -f automatic/logs/nightly_$(date +%Y-%m-%d).log

# launchd boot/load output (rijetko korisno, osim kod load failure-a)
cat automatic/logs/launchd.out.log
cat automatic/logs/launchd.err.log
```

## Lokacija logova

```
automatic/logs/
├── nightly_2026-05-26.log    # detaljni log po danu, rotirano nakon 30 dana
├── nightly_2026-05-27.log
├── launchd.out.log            # launchd capture, append-only
├── launchd.err.log
└── .nightly.lock              # lockfile (sadrži PID active run-a)
```

Wrapper sam briše log-ove starije od 30 dana.

## Sleep & wake ponašanje

Ako je Mac u sleep-u u 03:00, `launchd` queue-a job i pokreće ga na sljedećem wake-u. Tipično je to ujutro kad sjedneš za Mac → pipeline krene oko 09:00.

Ako želiš **da se Mac sam probudi za job**, dodaj `pmset` schedule:

```bash
# Probudi Mac svaki dan u 02:55 (5 min prije launchd-a) — traži sudo
sudo pmset repeat wakeorpoweron MTWRFSU 02:55:00

# Provjeri postojeći schedule
pmset -g sched

# Ukloni
sudo pmset repeat cancel
```

Nije preporučeno za prvi rollout — bolje pustiti da se vrti na prirodni wake dok ne potvrdiš da pipeline radi bez babysitting-a.

## Očekivani failure-i

Pipeline je dizajniran da **ne aborta** na YouTube anti-bot greške (vidi memory `pipeline_anti_bot_silent_continue.md`):

- `fetch.js` exit 0 čak i kod ABORT-a — failed video-i ostaju u `failed[]` state-u
- `screenshot_youtube.js` exit 0 — manjkajući screenshoti ostavljaju video bez tih asset-a

U 03:00 Mac je tipično na **direct (Ethernet/WiFi residential) connection-u**, ne na iPhone tethering-u. To znači da je vjerojatnost YouTube anti-bot blokova **visoka**. Pipeline će probati, sve što prođe — proći će; ostatak ostaje za sljedeći **ručni** pass tijekom dana kad pokreneš `yt-dlp --via-iphone` (vidi memory `yt_dlp_source_address_via_iphone.md`).

To je **dizajn**, ne bug:
- Automatika ulovi sve "lake" videe noću dok je Mac slobodan
- Ručni pass na iPhone tethering-u dohvati ostatak

### Buduća faza: remote residential proxy

Trenutno tethering radi samo dok je iPhone fizički blizu Mac-a. Sljedeća faza dodaje **remote proxy** (npr. dedicated residential server) da nightly job ne mora čekati lokalni iPhone — javit ćeš kad implementiraš pa wrapper dobije `--remote-proxy` flag.

## Promjena vremena

Edit `tv.domovina.fetch.nightly.plist`:

```xml
<key>StartCalendarInterval</key>
<dict>
    <key>Hour</key>
    <integer>3</integer>   <!-- ovdje -->
    <key>Minute</key>
    <integer>0</integer>
</dict>
```

Pa ponovo `./install.sh`.

Za više vremena (npr. 03:00 **i** 15:00), promijeni `<dict>` u `<array>` s dva `<dict>` element-a:

```xml
<key>StartCalendarInterval</key>
<array>
    <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>0</integer></dict>
</array>
```

## Trošak

Pipeline na "tipičnom" run-u kad ima 1-2 nova videa:
- Vertex AI Gemini (summary + article): ~$0.05–$0.20 per video, billing na `domovina-sync-ms` (memory `gcp_project_domovina_sync_ms.md`)
- R2 upload: free egress, storage ~$0.015/GB/mjesec
- Colab G4 (kad ručno trigger-aš): ~$0.003 per file (memory `transcription_only_g4_colab.md`)

Idle run (nema novih videa): ~$0 — sve idempotentne provjere su lokalne disk operacije.
