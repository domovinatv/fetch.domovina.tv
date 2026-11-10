# Magisterium HR+EN za sve Tier 1 kanale + zapeli `running` (10.11.2026.)

## Zašto

Do 10.11. Tier 2 (sve nove epizode nepraćenih kanala) dobivao je Magisterium HR+EN za svaku
epizodu (`with_magisterium: true` u `automatic/enqueue_all_new.js`), a Tier 1 (52 praćena kanala)
samo 5 kanala iz `automatic/full_backfill_channels.txt`. Primjer: nightly 10.11. — `0TqV6TbQ58E`
(nanovoroeni) imao je članak i EN, bez Magisteriuma. Odluka: puna obrada (članak, EN, Mag HR,
Mag EN) za SVE nove epizode oba tiera, od nightlyja 11.11.

## Što je promijenjeno

| Gdje | Commit | Što |
|---|---|---|
| `automatic/enqueue_magisterium_backfill.js` | c2a2031f | kanali = `full_backfill_channels.txt` ∪ sve `automatic/podcasts/*-lista.txt` (`-`→`_`). Novi kanal: baseline bez epizoda datiranih >= `MAGBF_ALL_SINCE` (2026-11-09) → samo naprijed. `MAGBF_ALL_TIER1=0` gasi |
| `../pipeline.domovina.ai/bridge/magisterium_poller.js` | 5a57ea4 | `sweepStuck()` prije claima: zahtjev svoje trake `running` dulje od timeout + objava + 15 min (HR ~2 h, EN ~3 h) → `queued`; drugi put → `failed` (`error` = `stuck-requeue`) |
| `tools/nightly_step_report/auto.py` | 226ad4e8 | od datuma 2026-11-11 report traži Mag HR i za nightly (Tier 1) epizode |

EN Magisterium nije trebalo mijenjati: `enqueue_en_new.js` `lateMagisteriumEn()` skenira sve
kanale na disku (HR Mag nastao >= `EN_MAG_LATE_SINCE`, a EN članak postoji → prevede Mag EN).
Kanali izvan `full_backfill_channels.txt` dobiju EN članak odmah, a Mag EN kasnije tim putem.

## Provjera

Suhi prolaz na kopiji `full_backfill_state.json` s lažnim `PIPELINE_QUEUE_BASE`: prvi run je
adoptirao 47 novih kanala (0 enqueuea), drugi je našao točno 1 kandidata — `0TqV6TbQ58E [hr]`.
Sve 52 liste imaju `storage/output/<kanal>` i `channels/data/<kanal>.json` (200).

## Zamka: zapeli `running`

10.11. `hPc9eoApFJ0 [hr]` stajao je 5 h u `running`: proces je umro nakon 7/8 batchova, idući tick
je javio „stale pipeline lock (PID mrtav) — preuzimam”, a queue nema stuck sweep, pa zahtjev
nitko više ne claima (ostali prolaze mimo njega). Ručno: `PATCH /api/magisterium/<id>
{"state":"queued"}`. Od 5a57ea4 to radi poller sam.

## Otvoreno

- Stari katalog Tier 1 kanala bez Magisteriuma (npr. nanovoroeni 319, radio_mreznica 221,
  zeljka_markic 167 …, ukupno nekoliko tisuća) — namjerno NIJE u redu (pravilo 4, bez backfilla).
- Propusnost: Mag HR ~10 min/ep, jedan po ticku; ~35 ep/dan → red se prazni do popodneva.
- Prva stvarna potvrda: dnevni report za 11.11. (`automatic/logs/launchd.nightly-report.out.log`).

Vezani dokumenti: `docs/2026-11-04-samo-nove-epizode-bez-backfilla.md`,
`docs/2026-10-24-magisterium-mcp-bez-llm-a.md`, `tools/nightly_step_report/README.md`.
