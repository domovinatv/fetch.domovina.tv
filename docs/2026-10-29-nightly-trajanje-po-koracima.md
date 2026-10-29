# Nightly: trajanje po koracima i trošak preskakanja (29.10.2026.)

Pitanje: troše li koraci koji „samo preskaču" (idempotencija po disku) primjetno
vrijeme, i treba li ih zamijeniti state datotekom „ovo je već riješeno".

## Kako izmjeriti (bez učitavanja loga u kontekst)

Nightly log je `automatic/logs/nightly_YYYY-MM-DD.log` (~1,4 MB, 17–25k linija,
ANSI + `\r`). `pipeline_log_digest.sh` gleda samo stare `pipeline_run_*.log`.

```bash
perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g; s/.*\r(?!\n)//g' automatic/logs/nightly_2026-10-29.log > /tmp/n.log
grep -a '📢 \[' /tmp/n.log | sed -E 's/.*\[([0-9:]+) \+([0-9:]+)\] (KORAK [0-9.]+[^:]*):.*/\2 \3/' \
 | awk '{split($1,a,":"); s=a[1]*3600+a[2]*60+a[3]; if(p!="") printf "%5ds  %s\n", s-ps, p; p=$2" "$3; ps=s}'
```

Usporedi s prethodnim noćima — skok trajanja jednog koraka je regresija.

## Mjerenje 29.10.2026. (start 03:00, kraj 05:12)

| Korak | Trajanje | Stvarni rad ili preskakanje |
|---|---|---|
| 9.6 og-sections | **3903 s** | regresija: Vision OCR nad ~70k kadrova prije provjere idempotencije (popravljeno `aac673d4`, sada ~20 s) |
| 9.9 reels kandidati | 1569 s | stvarni rad: 14 Opus poziva (13 odgođenih s 28.10. + 1 nova) |
| 8 članci | 593 s | stvarni rad (LLM) |
| 2.6 / 2.7b / 2.7c | 237 / 253 / 111 s | stvarni rad (ASR) |
| 10 screenshotovi | 269 s | 2 nove epizode, 63 kadra s Vision izborom; samo preskakanje kataloga ≈ 15 s (izmjereno: kanal od 137 ep. 0,5 s) |
| 12.5 H.264 | 168 s | jedan stvarni transkod; preskakanje O(1) iz `.r2_keys_cache.json` |
| 12 R2 upload | 93 s | ~50 s sken 196k datoteka + ~40 s HEAD na 6462 mutable manifesta |
| 9.85 sponzori | 27 s | preskakanje |
| 12.65 / 12.7 | 19 / 20 s | preskakanje |

Nakon popravka 9.6 preskakanje ukupno ≈ 3 min od ~2 h.

## Odluka: bez state ledgera „već riješeno"

Odbačeno. Dobitak je 2–3 min, a rizik je poznat: izvedene datoteke su signal
idempotencije, manifest nije dokaz, a mtime laže nakon bulk restorea. Regresija
9.6 nije bila od listanja diska nego od skupog posla (OCR) pozvanog **prije**
provjere idempotencije. Pravilo: skupi posao (Vision, ffmpeg, LLM, mreža) tek iza
provjere „treba li".

Jedini otvoren kandidat: KORAK 12 HEAD na mutable manifeste zamijeniti
usporedbom s ETag/MD5 iz keys-cachea (~40 s).

## Usput popravljeno

- `audit_pipeline.js` (`118e6222`): Soniox/Speechmatics prijepis vrijedi kao
  transkripcija. EF4owB1WMio je 8 noći bila lažna rupa i nightly je javljao exit 1.

## Vezani dokumenti

- `docs/2026-10-26-screenshot-izbor-kadra.md` — zamka OCR-a u 9.6
- `docs/2026-08-28-konvergencija-pipelinea.md` — audit i konvergencija
