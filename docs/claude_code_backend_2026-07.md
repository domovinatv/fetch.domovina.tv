# Claude Code CLI kao LLM backend za korake 7+8 (2026-07-25)

SSOT za `--gemini-backend claude` — obradu sažetaka (KORAK 7) i članaka (KORAK 8) preko
lokalno prijavljenog `claude` CLI-ja umjesto Vertex AI Geminija.

**Namjena:** kvalitetnija obrada **aktualnih / prioritetnih** videa. Nightly batch ostaje na
Vertexu (`gemini-3.5-flash`) — vidi "Zašto ne cijeli batch" niže.

---

## Kako se pokreće

```bash
# Cijeli pipeline, ali koraci 7+8 na Opusu
./run_pipeline.sh --gemini-backend claude

# Samo članci, jedna epizoda (tipičan ad-hoc quality upgrade)
GEMINI_BACKEND=claude node generate_article_gemini.js --input-dir storage/output --video-id <VIDEO_ID>

# Samo sažetak
GEMINI_BACKEND=claude node summarize_gemini.js --input-dir storage/output --video-id <VIDEO_ID>

# Override modela / efforta
CLAUDE_MODEL=sonnet CLAUDE_EFFORT=medium ./run_pipeline.sh --gemini-backend claude
```

| Env var | Default | Napomena |
|---|---|---|
| `GEMINI_BACKEND` | `vertex` | `vertex` \| `cli` (gemini CLI) \| `claude` |
| `CLAUDE_MODEL` | `opus` | Alias, ne puni ID. **Vidi "Model slug" niže — alias ide u ime datoteke.** |
| `CLAUDE_EFFORT` | `high` | `low`/`medium`/`high`/`xhigh`/`max` |
| `CLAUDE_MAX_RETRIES` | `3` | Retry s eksponencijalnim backoffom |

---

## Autentikacija: PRETPLATA, ne API key

`claude -p` koristi lokalno prijavljeni Claude Code OAuth (pretplata). Nema per-token
naplate, ali **postoji rate limit**.

> ⚠️ **NIKAD ne dodavati `--bare`.** Taj flag forsira `ANTHROPIC_API_KEY` / `apiKeyHelper`
> i OAuth se uopće ne čita → tiho prebacivanje na per-token naplatu.
> `run_pipeline.sh` upozorava ako je `ANTHROPIC_API_KEY` postavljen u okolišu.

---

## Kritični flagovi (empirijski izmjereno 2026-07-25)

Invokacija u `callClaudeCli()` (duplicirana u obje skripte, po konvenciji repoa):

```
claude -p --model <opus> --effort <high> --output-format json
        --setting-sources '' --strict-mcp-config --max-turns 1
        --tools '' --system-prompt <SYSTEM_PROMPT>
```
User poruka (metapodaci + transkript) ide kroz **stdin** — izbjegava ARG_MAX za transkripte
od 100-500 KB. `cwd` je `$TMPDIR/domovina_claude_cli`.

| Flag | Zašto | Mjereno |
|---|---|---|
| `--tools ''` | **Najvažniji.** Bez njega se tool definicije učitavaju u kontekst svakog poziva. | overhead **21 000 → 233 tokena** po pozivu |
| `cwd` = neutralni dir | Inače `claude` auto-discovera repo `CLAUDE.md` (21 KB) u SVAKI poziv | — |
| `--setting-sources ''` | Ne učitava user/project settings, hookove, pluginove | — |
| `--strict-mcp-config` | Bez MCP servera u kontekstu | — |
| `--output-format json` | Daje `result` (tekst) + `usage` + `total_cost_usd` → sidecar preživi | — |
| `--max-turns 1` | Jedan prolaz, bez agentske petlje | — |

**Gotcha:** `--tools` je *variadic* (commander). Mora biti praćen sljedećim `--flagom`,
inače proguta idući argument. U kodu je namjerno neposredno prije `--system-prompt`.

Nema `responseMimeType: "application/json"` kao kod Vertexa → JSON se izvlači kroz postojeći
repair pipeline (`extractJsonFromText()` u članku, `parseJsonLoose()` u sažetku).

---

## Model slug u imenima datoteka — NE MIJENJATI NASLIJEPO

Izlazi su `{basename}_{date}_{MODEL_SLUG}.article.json`. Downstream (`generate_channel_index.js`,
CDN manifest) dedupa po **leksikografski najvećem** imenu (vidi memory
`article_json_dedup_latest_per_video`).

```
MODEL_SLUG = USING_CLAUDE ? CLAUDE_MODEL : GEMINI_MODEL     // "opus" | "gemini-3.5-flash"
```

Slug za Claude je namjerno **goli alias** (`opus` / `sonnet` / `haiku` / `fable`) jer svi
počinju slovom `> 'g'` → pri istom datumu **Claude članak pobjeđuje** gemini verziju.

> ❌ Da je slug `claude-opus`, vrijedilo bi `'c' < 'g'` i downstream bi tiho servirao
> **gemini** članak, a Opus izlaz bi bio mrtav na disku. Ovo je jedina stvar u cijeloj
> integraciji koja pada bez ijedne greške u logu.

Puna provenance (`claude-code:opus`) ide u **JSON metadata**, ne u ime datoteke —
dvotočka u filenameu je problem za R2 ključeve i Finder.

**Ne-degradiraj guard:** `hasCompleteArticle()` na gemini backendu dodatno provjerava
postoji li kompletan `_opus`/`_sonnet`/`_haiku`/`_fable` članak i, ako da, preskače epizodu.
Bez toga bi nightly gemini pass svaki put uzalud regenerirao ručno nadograđene epizode.

---

## Trošak i kvota

Sidecar `{base}.gemini_usage.json` radi identično, samo s Claude poljima:

```json
{ "step": "summary", "model": "claude-code:opus", "project": "claude-code-subscription",
  "prompt_tokens": 16744, "output_tokens": 2002, "est_usd": 0.228928,
  "price_in_per_m": 5, "price_out_per_m": 25 }
```

`est_usd` se uzima iz CLI-jevog `total_cost_usd` (uračunava cache-write 2× / cache-read 0.1×).
Na pretplati je to **ekvivalentni** trošak — ne naplaćuje se, ali je dobar proxy za kvotu.
`prompt_tokens` zbraja `input + cache_creation + cache_read` jer sve troši kvotu.

### Zašto ne cijeli nightly batch

Izmjereno na 498 sidecara: **tipična epizoda = 5 poziva / ~430k input tokena** (članak je
dvofazan i svaka iteracija resenda transkript). Najveća viđena: 1.9M input / 11 poziva.

| | gemini-3.5-flash | Opus 5 |
|---|---|---|
| Cjenik | $1.50 / $9.00 po M | $5.00 / $25.00 po M |
| Tipična epizoda | ~$0.83 | ~$2.70 |
| Najveća viđena | ~$3.80 | ~$12.20 |
| Latencija (sažetak, 36 KB transkript) | sekunde | **39 s** |

Nightly od 13 epizoda ≈ **2.8M input tokena na Opusu**. To pojede tjednu kvotu pretplate
u par dana. Zato: `--gemini-backend claude` za prioritetne/ad-hoc videe, Vertex za backlog.

---

## Scoping: `--video-id` obrađuje OBJE kopije videa

Video praćenog kanala koji je prošao ad-hoc obradu postoji na **dva mjesta** —
`storage/output/_unlisted/` i `storage/output/<kanal>/` (vidi `reuse_unlisted_into_channel.js`).
Run scopean samo na `--video-id` zato obradi **obje kopije**, tj. dvostruko poziva i dvostruko
troši kvotu:

```bash
# 2× outline + 2× iteracije (_unlisted + kanal) — ~13 min, ~2× kvota
GEMINI_BACKEND=claude node generate_article_gemini.js --input-dir storage/output --video-id <VID>

# samo objavljena kopija — dodaj --channel
GEMINI_BACKEND=claude node generate_article_gemini.js --input-dir storage/output --channel <kanal> --video-id <VID>
```

Za publish je relevantna **channel kopija** (channel index čita nju). `_unlisted` kopija je
izvor za reuse; kad je već obrađena, nema je potrebe podizati na Opus.

## Verifikacija (2026-07-25)

| Što | Rezultat |
|---|---|
| Sažetak, 36 KB transkript | 39 s, valjan JSON, govornik ispravno atribuiran iz transkripta |
| Članak (outline + 1 iteracija) | ~6.5 min po kopiji |
| A/B vs `gemini-2.5-flash`, isti transkript | Opus 24 706 znakova vs 14 857; gemini je napisao krivo prezime ("Beselić"), Opus točno ("Bešlić") |
| Schema guard | Opalio i uspio: `⚠️ nedostaju polja: keywords, entities` → korektivni poziv → `🔧 Schema fix uspio (21 sekcija, sva polja prisutna)`, 51 jedinstveni entitet |
| Test suite | 60/60 (prije: 7 padova, vidi niže) |

**Zatečeni pad testova (popravljen u istom commitu):** `generate_article_gemini.test.js` je
hardkodirao `gemini-2.5-flash` u imenima fikstura, a `gemini.conf` je od 2026-06-27 na
`gemini-3.5-flash` → `findLatestFile` suffix se nije poklapao i 7 testova je padalo od tada.
Testovi sada uvoze `MODEL_SLUG` iz modula. **Pouka: sve što je vezano uz ime modela
(imena datoteka, fiksture) puca pri promjeni `GEMINI_MODEL` — nakon takve promjene pokreni
`node --test generate_article_gemini.test.js`.**

## Poznata ponašanja

- **Done cache.** `summarize-done.json` / `articles-done.json` su O(1) skip cache i **ne**
  znaju za backend. Ako epizoda već ima gemini članak, Claude run je neće dirati. Za ručni
  upgrade treba privremeno maknuti unos iz cachea (backup → filter → run → cache se sam
  rekonstruira jer se učitava cijeli pa prepisuje).
- **Resume.** `findLatestFile()` je scopean na `MODEL_SLUG`, pa Claude run nastavlja samo
  vlastite outline/article datoteke — isto ponašanje kao kod promjene Gemini modela.
- **Blocked content.** `PROHIBITED_CONTENT` marker fajlovi bilježe `model: claude-code:opus`.
- **Opus često ispusti `keywords`/`entities`.** Izmjereno **2 od 3 runa** na istom transkriptu
  (2026-07-25). Schema guard u FAZI 2 zato **nije kozmetika nego nosivi dio** ovog backenda —
  bez njega bi članci povremeno išli u RAG/index bez entiteta, i to bez ijedne greške u logu.
  Korektivni poziv gotovo udvostruči trošak iteracije (698 s / 2 poziva umjesto ~350 s / 1),
  što je uračunato u procjenu kvote.
