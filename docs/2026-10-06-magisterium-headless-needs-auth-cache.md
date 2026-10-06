# Magisterium headless pada na „nije autoriziran“ iako je konektor Connected (06.10.2026.)

Kratko: od 04.10. do 06.10.2026. svaki headless Magisterium run (poller,
`claude -p "@docs/MAGISTERIUM_MCP_RUN.md <VID>"`) završavao je s „MCP nije
autoriziran“ i `❌ nema artefakta nakon runa → failed`. Uzrok nije bio na
claude.ai nego u **lokalnom cacheu Claude Codea** `~/.claude/mcp-needs-auth-cache.json`.

## Simptomi

| Gdje | Što pokazuje |
|---|---|
| claude.ai → Customize → Connectors | Magisterium AI **Connected** |
| `claude mcp list` | `claude.ai Magisterium AI … ✔ Connected` |
| interaktivna i headless sesija | Magisterium nudi samo `authenticate` (koji za claude.ai konektore samo kaže „pokreni /mcp“) |
| `automatic/logs/magisterium_*.log` | runbook stane nakon prep koraka, „konektor nije autoriziran“ |

Re-auth u pregledniku, `/mcp` i nova sesija **ne pomažu**. Isti račun potvrđen
(org `2754ceda-da33-4be0-96ef-b9913a5662d7` i u pregledniku i u `~/.claude.json`).

## Uzrok i popravak

`~/.claude/mcp-needs-auth-cache.json` je imao zapis
`"claude.ai Magisterium AI": {"timestamp": …, "id": "mcpsrv_…"}` (06.10. 06:50).
Dok zapis postoji, Claude Code ne pokušava spajanje.

```bash
cp ~/.claude/mcp-needs-auth-cache.json ~/.claude/mcp-needs-auth-cache.json.bak-$(date +%Y%m%d)
node -e 'const f=process.env.HOME+"/.claude/mcp-needs-auth-cache.json";const c=require(f);delete c["claude.ai Magisterium AI"];require("fs").writeFileSync(f,JSON.stringify(c))'
```

Brisati **samo** Magisterium ključ — ostali (Canva, Podscan, stripe…) su stvarno
neprijavljeni. Provjera iz neutralnog dira: headless `claude -p` koji pozove
ToolSearch `+Magisterium` pa `search("Eucharist")` — mora vratiti rezultate.
Već otvorena sesija drži stari popis alata; provjera mora biti svježi proces.

## Posljedice dok traje

- Tick (`tv.domovina.fetch.magisterium`, 10 min) gomila failed jobove; nakon
  `MAGBF_MAX_FAILED=3` epizoda je **trajno preskočena** (`⛔ … 3× failed`).
- Ponovni pokušaj: izravan `POST /api/magisterium {youtube_id, lang:"hr"}` —
  worker dedupe gleda samo queued/running, ne failed. Poller ga pokupi; za odmah
  pokreni `bridge/magisterium_poller.js` pod pipeline lockom (bez `CLAUDE_WINDOW_GUARD`).
- Pogođene epizode: `fln3cFCwHcs` (mladi_za_domovinu) i `rVX6hydI96w` (iva_kraljevic);
  obje obrađene 06.10. 08:53, CDN 200.

## Audit pokrivenosti (srpanj → 06.10.2026.)

Sve epizode izvan baselinea triju kanala iz `automatic/full_backfill_channels.txt`
imaju Magisterium: mladi_za_domovinu 2/2, iva_kraljevic 3/3, eho_projekt 0 novih.
Liste (`automatic/podcasts/*-lista.txt`) i CDN channel index imaju isti broj
epizoda (135/65/101) → nema rupe ni prije Magisteriuma. eho_projekt od srpnja
objavljuje samo videe od 3–6 min, koje `refresh_podcasts.sh` namjerno filtrira (>15 min).

## Vezani dokumenti

- `docs/MAGISTERIUM_MCP_RUN.md` — runbook koji poller pokreće
- `docs/2026-08-26-claude-window-ograda.md` — zašto tick ponekad „ODGODI“
- `docs/magisterium_ai_integration.md`
