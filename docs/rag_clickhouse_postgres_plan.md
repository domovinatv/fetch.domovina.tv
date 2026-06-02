# RAG arhitektura: ClickHouse + PostgreSQL + MCP — plan za samohostani Coolify deployment

> **📦 Status implementacije:** Ovaj plan opisuje arhitekturu koja će biti implementirana u
> **odvojenom repozitoriju `domovina-rag`** (u parent direktoriju, fresh git init).
> Ovaj repo (`fetch.domovina.tv`) ostaje **data producer** — proizvodi `*.rag_combined.jsonl`,
> `*.canary.summary.json`, `*.article.json`, SRT itd. Shema tih datoteka je formalizirana u
> [`docs/data_contract.md`](./data_contract.md) i to je stabilni ugovor između repova.
>
> Ovaj dokument se zadržava ovdje zbog dva razloga:
> 1. Sav kontekst o podacima (struktura, šum u Gemini guess-ovima, idiosinkrazije pipelinea) je tu
> 2. Plan je nastao iz produbljene diskusije o stvarnim podacima — vrijedi sačuvati u izvornom kontekstu
>
> Kad se kreira novi repo, dokument se može **referencirati** odavde (cross-link u README oba repa)
> ili **migrirati** u novi repo s linkom natrag. Odluka je otvorena.

**Datum:** 2026-05-12
**Status:** Plan (još nije implementirano)
**Cilj:** Zamijeniti / nadopuniti Vertex AI Agent Builder put potpuno open-source stackom koji
       se može deployati na vlastiti Coolify (docker-compose) i ostati 100% FOSS, dok backend
       izlaže podatke kroz **MCP (Model Context Protocol)** — standardni protokol pa se bilo
       koji LLM klijent (Claude.ai, Claude Desktop, ChatGPT, Gemini app, Cursor, custom agent)
       može spojiti bez vendor lock-ina.
**Opseg podataka:** ~2 559 epizoda, ~120 911 chunkova, ~120M tokena hrvatskog teksta + metapodaci.
**Izvor istine za chunkove:** `*.rag_combined.jsonl` koji već generira `prepare_rag_combined.js`.

---

## 1. Sažetak (TL;DR)

Razdvajamo radne uloge:

| Uloga | Database | Zašto baš tu |
|---|---|---|
| **Transakcijski izvor istine** (epizode, kanali, speakeri, korisnici, agent sesije, feedback, audit log) | **PostgreSQL** | ACID, referential integrity, mature ORM ecosystem, mutations su jeftine. |
| **Analitičko + vektorsko spremište** (chunkovi, embeddings, full-text, agregati) | **ClickHouse** | Columnar storage savršen za metadata pre-filter prije vector search, sub-sekundne agregacije nad 120k+ redaka, ANN index `USearch` (HNSW) je production-ready od 24.x. |
| **API sloj prema LLM klijentima** (Claude.ai, ChatGPT, Claude Desktop, custom agenti) | **MCP server** | Standardni protokol; tool calling, OAuth 2.1 i resources discovery su "for free". Bez vlastitog chat UI-a. |

Sinkronizacija je **jednosmjerna**: PostgreSQL je owner entiteta, ClickHouse dobiva read-only kopiju
kroz batch ETL korak nakon pipeline run-a (idempotentno, kao i sve ostalo u pipelineu).

Sve komponente imaju OSI-approved FOSS licence i deployabilne su kao **jedan docker-compose** na Coolify.

---

## 2. Zašto baš oba, a ne samo jedna

### Zašto ne samo PostgreSQL + pgvector
- Funkcionira do par stotina tisuća vektora s HNSW indexom, ali:
  - **Agregacije** nad chunkovima (npr. "broj chunkova po kanalu × mjesec × topic") trebaju sekvencijalni scan ili kompleksne materijalizirane view-ove jer PG je row-store.
  - **Full-text + vector hybrid** zahtijeva `pg_trgm` + pgvector + RRF ručno; ide, ali tuning je naporan.
  - **Cold scan** velikih tablica je sporiji nego u columnar engine-u.
- pgvector se i dalje koristi za male, vrlo transakcijske vektorske skupove (npr. user embeddings), ali je suboptimalan za "data warehouse" stil chunk storea.

### Zašto ne samo ClickHouse
- **OLTP ga ubija**: česti UPDATE/DELETE/INSERT s referential integrity-jem. Mutations u CH su asinkrone i skupe.
- **Foreign keys, transakcijska konzistentnost, multi-row ACID** — nema (po dizajnu).
- **Auth, sessions, user-generated content** — anti-pattern za columnar engine.
- Agent conversation history sa svojim "branch / edit prijašnju poruku" potreba bi se borila s CH dizajnom.

### Zašto oba — sinergija

| Scenarij | PostgreSQL radi | ClickHouse radi |
|---|---|---|
| Pipeline upiše novu epizodu | INSERT u `episodes` (PG) | Ne ide u CH dok nije transcribed |
| RAG chunkanje za epizodu | INSERT u `chunks_pending` ili pisanje JSONL-a | Batch INSERT chunkova s embeddinzima |
| Korisnik postavlja pitanje agentu | INSERT u `conversations`, `messages` | Vector + metadata search za retrieval |
| Korisnik označi članak kao netočan | UPDATE `articles.feedback_count` | — |
| Dashboard: "top 10 govornika po vremenu govora u 2026" | — | Jedan `GROUP BY` upit, <1s |
| Speaker rename ("SPEAKER_00" → "Marin Perić") | UPDATE u PG + audit log | Trigger batch UPDATE u CH (ili samo na novim chunkovima) |

---

## 3. Visokorazinska arhitektura

```
   ┌────────────────────────────────────────────────────────────────────┐
   │                MCP klijenti (bilo koji LLM agent)                  │
   │  Claude.ai · Claude Desktop · ChatGPT · Gemini app · Cursor · ...  │
   └────────────────────────────────────────────────────────────────────┘
                                  │  HTTPS + SSE (MCP transport)
                                  │  OAuth 2.1 (public) ili API key (private)
                                  ▼
                   ┌──────────────────────────────────────────────────┐
                   │                  Coolify host                    │
                   │  (Mac Mini M4 Pro ili sličan; Docker daemon)     │
                   └──────────────────────────────────────────────────┘
                                          │
       ┌──────────────┬─────────────┬─────┴────┬─────────────┬──────────────────┐
       │              │             │          │             │                  │
   ┌───▼───┐     ┌────▼─────┐  ┌────▼─────┐ ┌──▼──────┐ ┌────▼─────────┐  ┌────▼────┐
   │Postgres│    │ClickHouse│  │ Embedder │ │Reranker │ │ MCP server   │  │ OAuth   │
   │  16    │    │   24.x   │  │ (FastAPI │ │(FastAPI │ │ (Node/Python │  │ provider│
   │        │    │          │  │  bge-m3) │ │ bge-rr) │ │  + MCP SDK)  │  │ (opc.)  │
   └────────┘    └──────────┘  └──────────┘ └─────────┘ └──────────────┘  └─────────┘
       ▲              ▲             ▲            ▲             │
       │              │             │            │             │
       │              │             └────────────┴─────────────┘
       │              │
       │       (CH čita iz PG-a kroz
       │        PostgreSQL table engine
       │        za enrichment lookupe)

   Pipeline (offline):
   ┌────────────────────────────────────────────────────────────────────┐
   │  run_pipeline.sh   →   *.rag_combined.jsonl   →   etl_to_warehouse  │
   │                                                   ↓                 │
   │                                          INSERT PG (entities)       │
   │                                          INSERT CH (chunks + embed) │
   └────────────────────────────────────────────────────────────────────┘
```

**Tok jednog upita:**

1. Korisnik u Claude.ai (ili kojem god MCP klijentu) postavi pitanje
2. LLM odluči pozvati MCP tool `search_podcasts(query="...", channel="...")`
3. MCP klijent šalje JSON-RPC poziv preko HTTPS+SSE-a na `https://mcp.domovina.ai`
4. MCP server autentificira (OAuth bearer token ili API key)
5. MCP server zove embedder → dobije query vektor
6. MCP server izvrši ClickHouse upit s metadata filterom + vector ORDER BY
7. (Opcionalno) Reranker preuredi top N kandidata
8. MCP server vraća strukturirani JSON klijentu
9. LLM klijent koristi rezultat da sintetizira odgovor korisniku

Sve interne komunikacije su preko Docker mreže (`internal`); Coolify javno izlaže **samo MCP server**
(i opcionalno OAuth provider) na FQDN `mcp.domovina.ai`. PG i CH nikad nisu javno dostupni.

---

## 4. Podjela podataka

### PostgreSQL (transakcijski izvor istine)

```sql
-- Entiteti
channels        (id, slug, name, youtube_handle, first_video_at, last_video_at, video_count)
episodes        (id, channel_id, youtube_id, title, description, duration_sec, upload_date,
                 status_enum, blocked_reason, retry_count, processed_at)
speakers        (id, canonical_name, aliases_jsonb, episode_count)
episode_speakers (episode_id, speaker_id, total_speech_sec)
articles        (id, episode_id, version, model, generated_at, jsonb_payload, feedback_score)
summaries       (id, episode_id, model, generated_at, jsonb_payload)

-- Korisnička strana (kad/ako bude agent web UI)
users           (id, email, role, created_at)
conversations   (id, user_id, title, created_at, updated_at)
messages        (id, conversation_id, role, content, citations_jsonb, created_at)
feedback        (id, message_id, user_id, kind_enum, comment, created_at)

-- Operativno
pipeline_runs   (id, started_at, finished_at, exit_code, args_jsonb, log_path)
sync_state      (table_name, last_synced_at, last_row_id)
```

**Tipično ~5-10 GB ukupno** za tvoj scale; svakako stane u jedan PostgreSQL container s 4-8 GB RAM-a.

### ClickHouse (analitički + vektorski sloj)

```sql
-- Chunkovi s embeddinzima
CREATE TABLE rag_chunks (
    chunk_id       String,
    episode_id     UInt64,                              -- FK na PG.episodes.id (logički)
    channel        LowCardinality(String),              -- denormalizirano radi filtriranja
    youtube_id     String,
    upload_date    Date,
    speaker        LowCardinality(String),              -- canonical name iz PG, fallback "SPEAKER_XX"
    start_ts       Float32,
    end_ts         Float32,
    text           String,
    text_summary   String,                              -- iz outline/summary, za context
    chunk_index    UInt32,
    chunk_strategy LowCardinality(String),              -- 'combined' | 'fixed' | 'outline'
    embedding      Array(Float32) CODEC(NONE),          -- 1024 dims za bge-m3
    metadata       String,                              -- raw JSONB iz JSONL-a za rezervne dimenzije
    inserted_at    DateTime DEFAULT now(),

    INDEX idx_text_tokens text TYPE tokenbf_v1(8192, 3, 0) GRANULARITY 4,
    INDEX idx_embedding   embedding TYPE usearch('cosineDistance') GRANULARITY 1000
) ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(upload_date)
ORDER BY (channel, upload_date, episode_id, chunk_index);

-- Dnevni agregati (materijalizirani, refresh nightly)
CREATE MATERIALIZED VIEW mv_channel_daily
ENGINE = SummingMergeTree
ORDER BY (channel, day)
AS SELECT
    channel,
    toDate(upload_date) AS day,
    count() AS chunk_count,
    countDistinct(episode_id) AS episode_count,
    sum(end_ts - start_ts) AS total_speech_sec
FROM rag_chunks
GROUP BY channel, day;

-- Opcionalno: lookup iz PG-a kroz PostgreSQL table engine
CREATE TABLE pg_episodes (
    id UInt64, channel_id UInt32, youtube_id String, title String, ...
) ENGINE = PostgreSQL('postgres:5432', 'rag', 'episodes', 'rag_user', 'pwd');
-- Sad CH može JOIN-ati live s PG bez ETL-a kad treba.
```

**Storage estimate:** 120 911 chunkova × ~3 KB tekst + (1024 dims × 4 B = 4 KB embed) + ~1 KB metadata
≈ **~1 GB ukupno**. ANN index ~200 MB. RAM: 2-4 GB za udobno održavanje.

---

## 5. Sinkronizacija PG ↔ CH

**Jednosmjerno: PG → CH. CH se ne zapisuje direktno iz aplikacije** (osim ETL koraka).

### Strategija A — Batch nakon pipeline run-a (preporuka)

Novi pipeline korak (npr. `etl_to_warehouse.js`):

1. Pročitaj sve nove `*.rag_combined.jsonl` (ili po `sync_state.last_synced_at`)
2. Upiši `episodes` + `speakers` u PG (idempotentno, ON CONFLICT)
3. Za svaki chunk u JSONL-u:
   - Pozovi embedder service (`POST /embed` s tekstom) → dobiš 1024-dim vektor
   - Pripremi red za CH s embeddingom + flat metadata
4. Bulk INSERT u CH u batchu od 1000 redaka (učinkovito za columnar engine)
5. Ažuriraj `sync_state` u PG

Vrijeme: za 120k chunkova s embedder-om na M4 Pro MPS-u (~50-100 chunkova/s) — **~30-60 min** za full
re-build. Inkrementalno tjedno: ~5 minuta za nove epizode.

### Strategija B — CDC (preskoči ako ti nije bitno)

Debezium ili `pg_logical` extension može stream-ati PG promjene direktno u CH (preko Kafka ili
direct sink). Overkill za tvoj use case — Strategija A je dovoljna i jednostavnija na Coolify-ju.

---

## 6. Query patterns (kako agent stvarno koristi sve ovo)

### 6.1. Tipičan agent flow

```
User: "Što je Domagoj Dalbello rekao o psihologiji domovinaca u 2026?"

Step 1 [Backend → Embedder]
   POST /embed → vektor za pitanje

Step 2 [Backend → ClickHouse]
   SELECT chunk_id, episode_id, text, text_summary, start_ts,
          cosineDistance(embedding, {q_vec:Array(Float32)}) AS dist
   FROM rag_chunks
   WHERE speaker = 'Domagoj Dalbello' AND upload_date >= '2026-01-01'
   ORDER BY dist ASC
   LIMIT 30;
   -- ~10ms za ovaj scale

Step 3 [Backend → Reranker]
   POST /rerank s 30 kandidata + query → top 8

Step 4 [Backend → PG]
   SELECT episode.title, episode.youtube_id, article.jsonb_payload
   FROM episodes JOIN articles ON ...
   WHERE episodes.id IN (...) -- iz top 8
   -- ~5ms

Step 5 [Backend → Gemini/Claude/Local LLM]
   System prompt + retrieved chunks + question → odgovor

Step 6 [Backend → PG]
   INSERT u messages (citations = [chunk_id, ...])
```

### 6.2. Analytics queries (gdje CH stvarno sija)

```sql
-- Top govornici po vremenu govora u zadnjih 90 dana
SELECT speaker, sum(end_ts - start_ts) AS sec
FROM rag_chunks
WHERE upload_date >= today() - 90 AND speaker NOT LIKE 'SPEAKER_%'
GROUP BY speaker ORDER BY sec DESC LIMIT 20;

-- Tematska distribucija po kanalu (semantic clustering offline → tag)
SELECT channel, topic_tag, count() FROM rag_chunks_with_topics
GROUP BY channel, topic_tag ORDER BY count() DESC;

-- Brzi semantic search bez filtra
SELECT chunk_id, text, cosineDistance(embedding, {q:Array(Float32)}) AS dist
FROM rag_chunks ORDER BY dist LIMIT 10;
```

---

## 7. Embedding i reranking modeli

Sve open-source, MIT/Apache licence, lokalno servirano kroz mali FastAPI wrapper.

| Komponenta | Model | Licenca | Veličina | M4 Pro throughput |
|---|---|---|---|---|
| Embedder | `BAAI/bge-m3` | MIT | 568M params | ~50-100 chunkova/s (MPS) |
| Embedder (alt) | `intfloat/multilingual-e5-large` | MIT | 560M params | sličan |
| Reranker | `BAAI/bge-reranker-v2-m3` | Apache 2.0 | 568M params | ~20-30 parova/s |

Oba imaju izvrsnu hrvatsku/južnoslavensku perfomansu (multilingual treniran na 100+ jezika).
Dimenzionalnost izlaza: **1024** za bge-m3 (i to konfigurirano u CH shemi).

Embedder server (kratki Python):

```python
# embedder/server.py
from fastapi import FastAPI
from sentence_transformers import SentenceTransformer
import torch

app = FastAPI()
device = "mps" if torch.backends.mps.is_available() else "cpu"
model = SentenceTransformer("BAAI/bge-m3", device=device)

@app.post("/embed")
def embed(payload: dict):
    texts = payload["texts"]
    vecs = model.encode(texts, normalize_embeddings=True)
    return {"vectors": vecs.tolist()}
```

Reranker isto tako, par desetaka linija.

---

## 7.5. MCP server — API sloj prema LLM klijentima

Umjesto da gradimo custom backend + custom chat frontend, **eksponiramo retrieval kao MCP server**.
Bilo koji MCP-aware klijent (Claude.ai od 2025, Claude Desktop, ChatGPT od kraja 2025, Gemini,
Cursor, Cline, vlastiti agent na Anthropic/OpenAI/Google SDK-u) može se spojiti i koristiti
tools bez ikakve customizacije po klijentu.

### 7.5.1. Tools koje eksponiramo

```typescript
// MCP tool definicije (TypeScript pseudokod kroz @modelcontextprotocol/sdk)

server.tool("search_podcasts", {
    description: "Pretražuje transkripte hrvatskih katoličkih/političkih podcasta. " +
                 "Vraća chunkove iz transkripata s relevantnim metadata.",
    inputSchema: {
        query: { type: "string", description: "Pitanje ili tema na hrvatskom" },
        channel: { type: "string", optional: true, enum: [/* lista iz PG-a */] },
        speaker: { type: "string", optional: true },
        date_from: { type: "string", format: "date", optional: true },
        date_to: { type: "string", format: "date", optional: true },
        limit: { type: "integer", default: 10, max: 50 }
    }
}, async (args) => {
    const queryVec = await fetchEmbedding(args.query);
    const chunks = await clickhouse.query(`
        SELECT chunk_id, episode_id, channel, youtube_id, speaker,
               text, text_summary, start_ts, end_ts,
               cosineDistance(embedding, {q:Array(Float32)}) AS dist
        FROM rag_chunks
        WHERE 1=1
          ${args.channel ? "AND channel = {ch:String}" : ""}
          ${args.speaker ? "AND speaker = {sp:String}" : ""}
          ${args.date_from ? "AND upload_date >= {df:Date}" : ""}
          ${args.date_to ? "AND upload_date <= {dt:Date}" : ""}
        ORDER BY dist ASC
        LIMIT {n:UInt32}
    `, { q: queryVec, ch: args.channel, sp: args.speaker,
         df: args.date_from, dt: args.date_to, n: args.limit });

    return { content: [{ type: "text", text: JSON.stringify(chunks) }] };
});

server.tool("get_episode", { /* dohvaća punu epizodu po youtube_id */ });
server.tool("list_speakers", { /* lista govornika, opcionalno po kanalu */ });
server.tool("list_channels", { /* lista kanala s brojem epizoda */ });
server.tool("get_related_episodes", { /* "more like this" */ });
server.tool("analytics_top_speakers", { /* GROUP BY upit za dashboard tools */ });
```

### 7.5.2. Resources (read-only podaci)

```typescript
server.resource("podcast://channels", async () => {
    const rows = await pg.query("SELECT slug, name, video_count FROM channels");
    return { uri: "podcast://channels", mimeType: "application/json", text: JSON.stringify(rows) };
});

server.resource("podcast://episode/{youtube_id}", async (params) => { /* puna epizoda + članak */ });
server.resource("podcast://article/{episode_id}", async (params) => { /* generirani članak */ });
```

Razlika tools vs resources:
- **Tools** = poziv s argumentima (LLM ih bira dinamički prema upitu)
- **Resources** = stabilni read-only URI-ji (LLM ih može subscribe-ati ili periodički čitati)

### 7.5.3. Transport

| Mode | Kad koristiti | Implementacija |
|---|---|---|
| **stdio** | Lokalni development; Claude Desktop konfiguracija | `npx @modelcontextprotocol/server-stdio` u terminalu |
| **HTTP + SSE** | Production (Coolify) | Express/Fastify handler na `/mcp` endpointu, SSE za streaming |

Za Coolify deployment koristi se isključivo HTTP+SSE; stdio je za lokalno testiranje.

### 7.5.4. Autentikacija — Public vs Private MCP

| Aspekt | **Private MCP** (preporuka za start) | **Public MCP** (kasnije, opcionalno) |
|---|---|---|
| Tko se može spojiti | Samo ti i pozvani korisnici s API ključem | Bilo tko na internetu nakon OAuth handshake-a |
| Auth | API key u `Authorization: Bearer ...` header | OAuth 2.1 + Dynamic Client Registration (DCR) |
| Implementacija | 10 linija middleware-a | OAuth provider container (npr. `mcp-oauth-provider` Apache 2.0 lib) ili Hydra/Authelia |
| Rate limit | Po API ključu | Po OAuth client + IP, Redis-backed |
| Discovery | URL podijeliš ručno | Eventualno u MCP server registry (još raste) |
| Kad krenuti | Faza 1 i 2 plana | Faza 4, ako želiš da zajednica može dodati svoj Claude.ai na tvoju bazu |

Konkretna preporuka: **kreni s private MCP s API ključem**, public OAuth dodaj kasnije ako/kad
odlučiš da bi htio public service. Migracija je netrivijalna ali nije velika (auth middleware swap).

### 7.5.5. Rate limiting i abuse protection

Public MCP otvara ti backend prema bilo kome — moraš očekivati nekoga tko će probati DoS, scraping,
ili prompt-injection napade kroz tool descriptions. Mitigacije:

- **Per-key rate limit** (Redis sliding window) — npr. 60 req/min, 1000 req/h
- **Per-IP rate limit** (Coolify Traefik labels ili custom middleware)
- **Tool response size cap** — limit `limit` parametra na 50, max response 1 MB
- **Embedder cache** — Redis cache za query → vector mapping (česti upiti su jeftiniji)
- **Audit log** u PG: `mcp_calls (id, client_id, tool_name, args_jsonb, latency_ms, ts)` — radi
  visibility i kasnijih heuristika za blokiranje
- **Tool descriptions** ne smiju sadržavati user-generated content (potencijalni prompt injection
  vector — LLM klijent ih čita doslovno)

### 7.5.6. Prednost MCP pristupa nad custom REST API-jem

| Aspekt | Custom REST | MCP |
|---|---|---|
| Klijenti | Treba pisati integraciju po svakom LLM provideru | Svi MCP-aware klijenti rade out of the box |
| Tool discovery | OpenAPI spec → prepare-aš za svaki SDK ručno | LLM klijent automatski lista tools |
| Auth | Tvoja shema | Standard OAuth 2.1 (Claude.ai i ChatGPT već imaju UI za to) |
| Streaming | SSE/WebSocket — sam dizajniraš | Built-in u protokol |
| Frontend | Moraš graditi | Ne moraš — koristiš tuđi (Claude.ai) |
| Vendor lock | Često kreće LLM-specific | Vendor-neutralan po dizajnu |

Glavni minus MCP-a: **u maju 2026** ekosistem klijenata je još mlad. Većina ljudi koristi Claude.ai
ili Claude Desktop. ChatGPT remote MCP support je tek dodan kraj 2025. Cursor/Cline rade.
Custom agenti preko Anthropic/OpenAI/Google SDK-a moraju imati MCP klijent biblioteku (postoji za
sve tri). Za interni use case to je nebitno; za public service znači da neki korisnici sa starijim
verzijama klijenata trebaju update.

---

## 8. LLM za generaciju odgovora

**Hibridna preporuka:** stalno koristi cloud LLM za hrvatsku generaciju (Gemini 2.5 Flash kroz Vertex
AI ili Claude Sonnet); RAG retrieval je open-source. Hrvatska perfomansa local LLM-ova još uvijek
zaostaje za top cloud modelima.

| Opcija LLM-a za generaciju | Licenca | Hardware | Hrvatska kvaliteta |
|---|---|---|---|
| **Gemini 2.5 Flash (Vertex AI)** | Cloud, plaća se | — | ★★★★★ |
| **Claude Sonnet 4.6 (API)** | Cloud, plaća se | — | ★★★★★ |
| **GPT-4o-mini (OpenAI API)** | Cloud, plaća se | — | ★★★★ |
| **Llama 3.3 70B Q4 (local, Ollama)** | Llama Community License | 40+ GB unified RAM | ★★★ |
| **Qwen 2.5 32B Q4** | Apache 2.0 | 20 GB RAM | ★★★ |
| **Gemma 2 27B Q4** | Gemma License | 16 GB RAM | ★★ (hrvatski slab) |

Backend može u env varijabli imati `LLM_PROVIDER=vertex|claude|openai|ollama` i prebaciti se
deklarativno. Tako možeš čak A/B testirati lokalni vs cloud bez mijenjanja koda.

**Napomena o open-source garanciji:** ako želiš zaista 100% FOSS produkcijski stack uključujući
generaciju, ide se s Qwen 2.5 32B na M4 Pro 64 GB. Kvaliteta hrvatskog je solidna, ali primjetno
ispod Gemini-ja. Najpragmatičniji put: retrieval stack je 100% FOSS, generation layer je swap-able
(cloud sad, lokalno kad/ako modeli sazriju za HR).

---

## 9. Coolify deployment plan

Coolify v4 podržava docker-compose deploymente kao Application Resource. Sve niže ide u jedan
`docker-compose.yml` koji daš Coolify-ju.

### Direktorij projekta

```
domovina-rag/
├── docker-compose.yml
├── .env                              # secrets (PG password, MCP_API_KEY, Coolify ga renda)
├── postgres/
│   └── init.sql                      # CREATE TABLE statements
├── clickhouse/
│   ├── config.xml                    # custom XML overrides
│   └── init.sql                      # CREATE TABLE rag_chunks ...
├── embedder/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── server.py
├── reranker/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── server.py
└── mcp_server/                       # MCP server (Node.js + @modelcontextprotocol/sdk)
    ├── Dockerfile
    ├── package.json
    └── src/
        ├── index.ts                  # MCP server entry + transport (HTTP+SSE)
        ├── auth.ts                   # API key ili OAuth middleware
        ├── tools/
        │   ├── search_podcasts.ts
        │   ├── get_episode.ts
        │   ├── list_speakers.ts
        │   └── analytics.ts
        ├── resources/
        │   └── channels.ts
        └── clients/
            ├── clickhouse.ts
            ├── postgres.ts
            └── embedder.ts
```

**Frontend NE TREBA** za core use case — Claude.ai/Claude Desktop/ChatGPT je frontend.
Vlastiti minimalni web UI (Next.js) dodaješ samo ako želiš branded landing page ili custom
korisnička iskustva van postojećih MCP klijenata.

### docker-compose.yml (skica)

```yaml
version: "3.9"

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: rag
      POSTGRES_USER: rag_user
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    networks: [internal]
    restart: unless-stopped

  clickhouse:
    image: clickhouse/clickhouse-server:24.10
    environment:
      CLICKHOUSE_DB: rag
      CLICKHOUSE_USER: rag_user
      CLICKHOUSE_PASSWORD: ${CLICKHOUSE_PASSWORD}
    ulimits:
      nofile: { soft: 262144, hard: 262144 }
    volumes:
      - ch_data:/var/lib/clickhouse
      - ./clickhouse/config.xml:/etc/clickhouse-server/config.d/custom.xml:ro
      - ./clickhouse/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    networks: [internal]
    restart: unless-stopped

  embedder:
    build: ./embedder
    environment:
      MODEL_NAME: BAAI/bge-m3
      DEVICE: cpu   # ili mps ako runtime to podržava; na linux serveru cpu ili cuda
    volumes:
      - hf_cache:/root/.cache/huggingface
    networks: [internal]
    restart: unless-stopped

  reranker:
    build: ./reranker
    environment:
      MODEL_NAME: BAAI/bge-reranker-v2-m3
    volumes:
      - hf_cache:/root/.cache/huggingface
    networks: [internal]
    restart: unless-stopped

  mcp_server:
    build: ./mcp_server
    environment:
      PG_URL: postgres://rag_user:${POSTGRES_PASSWORD}@postgres:5432/rag
      CH_URL: http://rag_user:${CLICKHOUSE_PASSWORD}@clickhouse:8123/rag
      EMBEDDER_URL: http://embedder:8000
      RERANKER_URL: http://reranker:8000
      # Auth: "apikey" za private MCP (Faza 1-3), "oauth" za public (Faza 4)
      AUTH_MODE: apikey
      MCP_API_KEY: ${MCP_API_KEY}
      # OAuth (samo ako AUTH_MODE=oauth)
      OAUTH_ISSUER: https://mcp.domovina.ai
      OAUTH_REDIS_URL: redis://redis:6379
      # Rate limiting
      RATE_LIMIT_PER_MINUTE: 60
      RATE_LIMIT_PER_HOUR: 1000
    networks: [internal, web]
    labels:
      - "coolify.managed=true"
      - "coolify.fqdn=https://mcp.domovina.ai"
    restart: unless-stopped

  # Opcionalno za rate limiting state + OAuth nonce/session (Faza 4)
  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    networks: [internal]
    restart: unless-stopped

volumes:
  pg_data:
  ch_data:
  hf_cache:
  redis_data:

networks:
  internal:
    internal: true
  web:
    external: true
```

Coolify automatski riješi:
- TLS sertifikate (Let's Encrypt) za FQDN
- Reverse proxy (Traefik ili Caddy interno)
- Restart policy
- Backup volumena (ako konfiguriraš)
- Health checks na svaki servis

### Hardware sizing (Coolify host)

| Resurs | Minimum | Preporuka |
|---|---|---|
| RAM | 8 GB | **16 GB** (8 za CH+PG, ostalo za embedder/reranker/backend) |
| CPU | 4 core | 8 core (embedder CPU inference je vrijedan paralelizacijom) |
| Disk | 50 GB SSD | 100 GB SSD (CH compresion je ~10× pa stane lako) |
| GPU | nije potrebno | NVIDIA L4/A10 ili Apple Silicon ako želiš 10× brži embedding throughput |

**Ako Coolify host nije Mac:** embedder ide na CPU u Linux containeru. Throughput pada na ~10-20
chunkova/s, ali za inkrementalne dnevne batch-eve to je nebitno. Inicijalni full embed (120k
chunkova) ide ~2-4 h na CPU, ili napraviš jednokratno offline na M4 Pro i samo importiraš
vektore u CH.

---

## 10. Open-source provjera (licenca matrica)

| Komponenta | Licenca | Komercijalno OK? | Vendor-neutralna? |
|---|---|---|---|
| PostgreSQL 16 | PostgreSQL License (BSD-style) | ✅ | ✅ |
| pgvector (ako bude trebao) | PostgreSQL License | ✅ | ✅ |
| ClickHouse 24.x | Apache 2.0 | ✅ | ✅ |
| `BAAI/bge-m3` (embedder) | MIT | ✅ | ✅ |
| `BAAI/bge-reranker-v2-m3` | Apache 2.0 | ✅ | ✅ |
| `intfloat/multilingual-e5-large` (alt) | MIT | ✅ | ✅ |
| sentence-transformers (Python lib) | Apache 2.0 | ✅ | ✅ |
| FastAPI (Python web framework) | MIT | ✅ | ✅ |
| Node.js / Express / Fastify | MIT | ✅ | ✅ |
| `@modelcontextprotocol/sdk` (MCP server SDK) | MIT | ✅ | ✅ |
| MCP spec (open protocol) | MIT (Anthropic) | ✅ | ✅ |
| `mcp-oauth-provider` (za public MCP) | Apache 2.0 | ✅ | ✅ |
| Redis (rate limiting / OAuth state) | RSALv2/SSPL (Redis 7.4+) ili Valkey (BSD) | ⚠️ ovisi o verziji | ✅ s Valkey-em |
| Docker / docker-compose | Apache 2.0 | ✅ | ✅ |
| Coolify | Apache 2.0 | ✅ | ✅ |
| **LLM (Gemini API)** | proprietary, plaća se | ✅ | ❌ |
| LLM alt: **Qwen 2.5 32B** | Apache 2.0 | ✅ | ✅ |
| LLM alt: **Llama 3.3 70B** | Llama Community License | ✅ (do 700M MAU) | ⚠️ uvjetno |

Retrieval + MCP sloj (PG + CH + embedder + reranker + MCP server) je **100% Apache/MIT/BSD-stil** —
bez gates, bez tier-ova, bez enterprise verzija. Generation layer je swap-able između cloud i potpuno
open-source modela; sami zaključuješ je li ti to bitno za danas ili sutra.

**Napomena o Redis-u:** od verzije 7.4 (2024) Redis se distribuira pod dual RSALv2/SSPL licencom,
što nije OSI-approved open-source. Ako želiš zaista 100% FOSS stack, **swap Redis za Valkey**
(Linux Foundation fork pod BSD-3-Clause licencom, drop-in zamjena). Coolify Redis template
dopušta zamijeniti image, npr. `valkey/valkey:7.2-alpine`.

---

## 11. Migracijski plan iz trenutnog Vertex AI puta

**Pretpostavka:** Vertex AI Agent Builder već radi (ili će raditi nakon što riješiš
bucket + Data Store). Ovaj stack ne mora ga zamijeniti; može supostojati kao alternativni
backend tijekom evaluacije.

### Faza 1: Paralelni prototip (1-2 tjedna)
1. Stvori `docker-compose.yml` po skici iz §9 lokalno (ne na Coolify-ju još).
2. Pokreni embedder + ClickHouse, importiraj prvih 100 epizoda (~5 000 chunkova).
3. Napravi minimalni backend endpoint `POST /search` koji embeda upit i vraća top 10 chunkova.
4. Usporedi retrieval kvalitetu protiv Vertex AI Discovery Engine na 20 ručno odabranih pitanja
   (precision@5, recall@10, MRR).

### Faza 2: Production import + MCP server (1-2 tjedna)
5. Ako Faza 1 pokaže paritet kvalitete (vjerojatno hoće): napiši `etl_to_warehouse.js`,
   import-aj svih 2 559 epizoda u CH.
6. Implementiraj MCP server (`mcp_server/`) s privatnim API key auth-om i 4-5 osnovnih tools
   (`search_podcasts`, `get_episode`, `list_speakers`, `list_channels`).
7. Testiraj lokalno preko Claude Desktop: dodaj MCP server u `~/Library/Application Support/Claude/claude_desktop_config.json`,
   pitaj Claude da te koristi.
8. Implementiraj retrieval citing format (`source_url`, `start_ts`, `speaker`, `episode_title`) koji
   MCP klijent može prikazati kao linkove na YouTube + timestamp.

### Faza 3: Coolify deployment (par dana)
9. Push docker-compose u Coolify, postavi FQDN `mcp.domovina.ai`, TLS certifikate, env vars.
10. Spoji Claude.ai (Settings → Connectors → Add custom MCP) na production URL s API ključem.
11. Postavi backup za PG volume i CH volume (Coolify scheduled backups ili rclone na R2).
12. Health monitoring (Coolify ima built-in, alt: Uptime Kuma container).

### Faza 4: Odluka o Vertex AI putu + (opcionalno) public MCP
13. Ako self-hosted bolji ili jednako dobar: ostavi Vertex import kao fallback ili ga ugasi.
14. Ako Vertex bolji za neku dimenziju (npr. quality on long-tail queries): hibridni rezultat —
    retrieval iz oba, ensemble re-ranking.
15. Ako želiš javni service: zamijeni `AUTH_MODE=apikey` s `AUTH_MODE=oauth`, dodaj OAuth provider
    container, dokumentiraj na npr. `https://mcp.domovina.ai/.well-known/oauth-authorization-server`,
    najavi zajednici.

---

## 12. Rizici i mitigacije

| Rizik | Vjerojatnost | Impact | Mitigacija |
|---|---|---|---|
| ClickHouse USearch ANN recall pada s povećanjem podataka | Niska | Srednji | Periodički eval recall@k; ako padne ispod 90%, swap-aj na Qdrant za vektore (CH ostaje za analitiku) |
| Embedder spor na CPU-only Coolify hostu | Srednja | Niska | Inicijalni full embed jednokratno offline na M4 Pro; inkrementalno na hostu OK |
| Hrvatska kvaliteta open-source LLM-a nedovoljna | Visoka | Srednji | Cloud LLM API ostaje opcija; generation layer je swap-able |
| Coolify host bačen u down | Srednja | Visok | Backups na R2 (PG dump + CH backup tool), restore procedura dokumentirana |
| Drift između PG i CH (npr. failed sync) | Niska | Niska | `sync_state` tablica, `etl_to_warehouse.js` idempotentno detektira nesinkronizirane epizode |
| Vertex AI free credits ostanu nepotrošeni / istek prije migracije | — | — | Neutralno; ova arhitektura niti smeta niti pomaže s tim |

---

## 13. Otvorena pitanja prije implementacije

1. **MCP visibility:** Private MCP (samo ti i pozvani) na startu, ili odmah public OAuth?
   Preporuka: private na startu, public kasnije ako odlučiš da bi htio podijeliti bazu sa zajednicom.
2. **Klijent skala:** spaja li se samo Claude.ai/Desktop, ili planiraš i ChatGPT/Cursor/Cline/custom?
   Određuje koliko transport edge-case-ova testirati (svi su HTTP+SSE, ali pojedine implementacije
   imaju kvirke).
3. **Multi-tenant:** koristi li više osoba istu instancu s razdvojenim podacima/dozvolama?
   Određuje napor oko user/session modela u PG i `client_id` u MCP audit logu.
4. **Real-time vs batch:** trebaju li novi episode chunkovi biti pretraživi u 1 min, ili je
   dnevni ETL OK? Sad je dnevno (`run_pipeline.sh` cron); za real-time treba CDC.
5. **LLM odluka:** Gemini se ostaje koristiti za generaciju (preporuka), ili eksperimentirati s
   lokalnim Qwen 2.5 32B na novom Mac Mini Studio?
   *(MCP je orthogonal — server radi isto bez obzira koji LLM klijent ga zove.)*
6. **Storage backup strategija:** R2 ima već upload pipeline; isti rclone target za PG/CH dumpove
   ili odvojeno?
7. **Redis vs Valkey:** ako želiš strogo 100% OSI-approved licence, koristi Valkey umjesto Redis-a
   (drop-in). Inače Redis je OK.

---

## 14. Eval rig za retrieval kvalitetu (golden set + paralelni backendi)

**Status:** Izdvojeno od produkcijskog stacka u §3-§11. Eval rig je razvojni alat za **mjerenje
kvalitete retrievala** i (opcionalno) A/B testiranje različitih vector store backendova ili
embedding modela. Production deployment koristi **jedan** primarni backend (ClickHouse po
preporuci §2); eval rig može vrtjeti više paralelno.

### 14.1. Zašto formalni eval rig

Retrieval kvaliteta je **subjektivna** dimenzija — top-5 chunkova za pitanje "što je Marko rekao
o ekonomiji" su "dobri" ili "loši" ovisno o čovjeku koji čita. Bez golden seta i ponovljivih
metrika sve odluke o:
- Promjeni embedding modela (bge-m3 → e5-large → mxbai)
- Mijenjanju chunkanja (combined → outline-aware → speaker-aware)
- Dodavanju re-rankera (s bge-rerankerom ili bez)
- Switchanju vector store backenda (ClickHouse ↔ Qdrant)

su **anegdotalne**. S golden setom su mjerljive — vidiš da li je MRR pao s 0.72 na 0.68 nakon
neke izmjene i odlučiš deterministički.

Ovo je ista logika kao tvoja diarizacijska usporedba (pyannote vs sortformer s DER metrikom),
samo što za retrieval moraš ručno označiti referent set jer nema "ground truth" speakera —
nema "ground truth" relevantnosti dok je čovjek ne procijeni.

### 14.2. Golden query set — format i kreacija

**Cilj:** 30-50 ručno označenih Q&A parova koji pokrivaju tipove upita koje očekuješ od korisnika.

**Distribucija** (prijedlog za tvoj korpus):

| Tip upita | Primjer | Udio |
|---|---|---|
| Faktička pretraga | "Što je Domagoj Dalbello rekao o psihologiji domovinaca?" | 30% |
| Tematska eksploracija | "Što katoličko učiteljstvo kaže o pornografiji?" | 25% |
| Vremenska / kanal-specifična | "Najnoviji intervjui u Cuspajz podcastu 2026" | 15% |
| Speaker × tema unakrsno | "Sve gdje Stepinac spominje obrazovanje" | 10% |
| Long-tail / rare | "Tko je spomenuo Ivu Pilara u 2025?" | 10% |
| Adversarial / neasje | "Što je Modi rekao o Indiji" (van korpusa) | 10% |

**Format** (`eval/golden_set.jsonl`):

```jsonl
{"id": "q001", "question": "Što katoličko učiteljstvo kaže o pornografiji?", "type": "thematic", "relevant_chunks": ["chunk_id_1", "chunk_id_2", "chunk_id_3"], "relevant_episodes": ["yt_Tt0FN_oPLsQ", "yt_Aov_fOtzYB4"], "notes": "Pokriva CCC 2354 i Filip Dekić epizodu"}
{"id": "q002", "question": "Najnoviji intervjui u Cuspajz podcastu 2026", "type": "temporal", "filter": {"channel": "podcast_cuspajz", "date_from": "2026-01-01"}, "relevant_chunks": ["..."], "must_be_top_5": true}
{"id": "q003", "question": "Što je Modi rekao o Indiji", "type": "adversarial", "relevant_chunks": [], "expected_empty": true}
```

**Postupak označavanja:**

1. Generiraj 50 kandidata pitanja (sam ili tražimo Claude da napravi prijedlog na temelju summarja
   epizoda — semi-automatski, ti prepravljaš)
2. Za svako pitanje ručno označi 3-10 chunkova kao "stvarno relevantni" (gleda u
   `*.rag_combined.jsonl` ili u CH-u kroz manual SQL)
3. Spremi u JSONL, commit-aj u repo (npr. `dataset.domovina.tv/eval/`)
4. Ovo je jednokratni napor od **~2-3 sata**; vrijedi mjesecima dok se podaci značajno ne promijene

Golden set treba revidirati svakih 3-6 mjeseci jer:
- Novi sadržaj može učiniti neke "relevantne" chunkove zastarjelima
- Tvoje očekivano ponašanje agenta evoluira

### 14.3. Metrike

Standardne IR (Information Retrieval) metrike, sve izračunane nad golden setom:

| Metrika | Što mjeri | Cilj |
|---|---|---|
| **Precision@k** (k=5, 10) | Koliko top-k rezultata su stvarno relevantni | >0.6 za k=5 dobar baseline |
| **Recall@k** (k=10, 20) | Koliko relevantnih chunkova je u top-k | >0.8 za k=20 dobar baseline |
| **MRR** (Mean Reciprocal Rank) | Prosječna 1/rank prvog relevantnog rezultata | >0.7 odličan, >0.5 OK |
| **nDCG@10** | Penalizira relevantne ali nisko rangirane | >0.6 OK |
| **Empty-result rate na adversarial** | Koliko adversarial pitanja vrati prazno/upozorenje | >0.8 (želiš da kaže "nemam podataka") |

Sve su skripta od ~50 linija Pythona (postoji `ranx` biblioteka, Apache 2.0, koja sve to računa
iz JSONL inputa).

### 14.4. Eval rig arhitektura (paralelno više backendova)

**Ključno:** ovaj setup je **izvan produkcijskog Coolify deploymentcma**. Vrti se lokalno na M4
Pro tijekom razvoja ili kao CI workflow.

```
              ┌────────────────────────────────────┐
              │   eval/run_eval.py                 │
              │   - učita golden_set.jsonl         │
              │   - za svako pitanje pozove svaki  │
              │     backend, zabilježi top-20      │
              │   - izračuna metrike s ranx        │
              │   - ispiše tablicu + CSV report    │
              └─────────────┬──────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   ┌─────────┐         ┌─────────┐         ┌─────────┐
   │ClickHse │         │ Qdrant  │         │pgvector │
   │ (prod)  │         │ (eval)  │         │ (eval)  │
   └─────────┘         └─────────┘         └─────────┘
        │                   │                   │
        └───────────────────┴───────────────────┘
                            ▲
                            │
                     ┌──────┴──────┐
                     │   Shared    │
                     │ embedder    │
                     │  (bge-m3)   │
                     └─────────────┘
```

Svi backendi dobivaju **identične embeddinge** za iste chunkove i query-je, tako da se mjeri
**samo backend retrieval razlika**, ne razlika u embedding kvaliteti.

### 14.5. docker-compose za eval rig (zaseban file, NE produkcijski)

```yaml
# eval/docker-compose.yml — samo za razvojnu mašinu, ne ide na Coolify
version: "3.9"
services:
  clickhouse_eval:
    image: clickhouse/clickhouse-server:24.10
    volumes: [ ch_eval_data:/var/lib/clickhouse ]
    ports: ["8123:8123"]

  qdrant_eval:
    image: qdrant/qdrant:v1.12.0
    volumes: [ qdrant_eval_data:/qdrant/storage ]
    ports: ["6333:6333", "6334:6334"]

  pgvector_eval:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_PASSWORD: eval
    volumes: [ pgvector_eval_data:/var/lib/postgresql/data ]
    ports: ["5432:5432"]

  embedder:
    build: ../embedder    # isti embedder kao u prod
    ports: ["8000:8000"]

volumes:
  ch_eval_data:
  qdrant_eval_data:
  pgvector_eval_data:
```

`docker compose -f eval/docker-compose.yml up` na M4 Pro pojede ~1 GB RAM-a u idle stanju, ništa
strašno za development mašinu.

### 14.6. Skripta `eval/run_eval.py` (skica)

```python
import json
from ranx import Qrels, Run, evaluate

# Učitaj golden set
golden = [json.loads(l) for l in open("eval/golden_set.jsonl")]

# Qrels (ground truth) format za ranx
qrels = Qrels({q["id"]: {chunk: 1 for chunk in q["relevant_chunks"]} for q in golden})

results_per_backend = {}
for backend_name, backend in [("clickhouse", CHBackend()), ("qdrant", QdrantBackend()), ("pgvector", PgvectorBackend())]:
    run = {}
    for q in golden:
        results = backend.search(q["question"], k=20, filter=q.get("filter"))
        run[q["id"]] = {r["chunk_id"]: 1 / (i + 1) for i, r in enumerate(results)}
    results_per_backend[backend_name] = Run(run)

# Izračunaj sve metrike za sve backende
metrics = ["precision@5", "precision@10", "recall@10", "recall@20", "mrr", "ndcg@10"]
for name, run in results_per_backend.items():
    print(f"\n=== {name} ===")
    print(evaluate(qrels, run, metrics))
```

Output (primjer):
```
=== clickhouse ===
{'precision@5': 0.642, 'precision@10': 0.501, 'recall@10': 0.810, 'recall@20': 0.892, 'mrr': 0.723, 'ndcg@10': 0.687}

=== qdrant ===
{'precision@5': 0.654, 'precision@10': 0.508, 'recall@10': 0.821, 'recall@20': 0.898, 'mrr': 0.731, 'ndcg@10': 0.694}

=== pgvector ===
{'precision@5': 0.618, 'precision@10': 0.485, 'recall@10': 0.795, 'recall@20': 0.882, 'mrr': 0.708, 'ndcg@10': 0.669}
```

### 14.7. Decision rules — kad djelovati na rezultate

Eval rig je samo alat — odluke su tvoje. Pragmatični thresholdovi:

| Razlika između backendova | Akcija |
|---|---|
| < 2% u svim metrikama | **Pobjeđuje operacionalno jednostavniji backend** (ClickHouse, ako već imaš metadata workload) |
| 2-5% konzistentno u korist X | Razmotriti switch ali tek nakon **3 sukcesivna eval run-a** (možda je golden set noisy) |
| > 5% konzistentno u korist X | **Switch.** Ali provjeri konfiguraciju gubitnika prvo (HNSW M, efConstruction, distance metric) |
| Razlika ovisi o tipu upita | **Hybrid** — koristi različite backende za različite tool varijante (npr. analytics → CH, semantic → Qdrant) |

### 14.8. Kad eval rig pokrenuti

Ne svaki dan. Pokreni nakon:
- Promjene embedding modela
- Bilo koje promjene chunkanja u `prepare_rag_*.js`
- Dodavanja ili uklanjanja re-rankera
- Velikog batcha nove podataka (>10% korpusa)
- Switcha backenda

Idealno: commit `eval/results/{date}_{commit_hash}.json` u repo nakon svakog eval run-a, da imaš
**historijat kvalitete** kroz vrijeme. Jedan small `eval/CHANGELOG.md` u kojem ručno bilježiš
"što sam izmijenio i zašto" daje long-term context.

### 14.9. Zaključak: kad uvesti eval rig

**Ne odmah.** Faza 1 plana (paralelni prototip Vertex vs lokalni za 2 tjedna) se može odraditi
"vibrationally" — pogledaš 5-10 query-ja oboje i dobiješ instinkt. Eval rig formaliziraj kad:

- Imaš stabilnu prvu verziju ClickHouse retrievala (Faza 2 plana završena)
- Razmišljaš o nekoj **konkretnoj promjeni** (drugi embedding, drugi backend, dodati re-ranker)
- Imaš 2-3 sata vremena za inicijalno označavanje golden seta

Bez toga, eval rig je zanimljivo ali ne-aktivno parče infrastrukture. Sa golden setom, postaje
glavni guardrail koji te štedi od "izmijenio sam tri stvari odjednom i sad ne znam što je pokvarilo
kvalitetu".

---

## 15. Speaker entity resolution — globalni identitet osoba

**Problem koji rješavamo (canonical primjer):**
Korisnik upiše u Claude.ai *"što je fra Ante rekao o..."* i očekuje da agent pronađe **sve chunkove**
gdje je govorio fra Ante Vučković — bez obzira što je u jednoj epizodi označen kao `SPEAKER_00`,
u drugoj kao `SPEAKER_02`, u trećoj Gemini ga nazove samo "Ante", u četvrtoj "fra Vučković", a u
petoj možda krivo kao "Ante Stojić" (drugi gost u istoj epizodi).

Ovo je standardni problem **entity resolution / record linkage** iz NLP-a. Episode-local
`SPEAKER_XX` labele iz pyannote/sortformer su **nezavisne po epizodi**, a Geminijevi "name hint"-ovi
su nepouzdani. Globalni speaker identitet **mora se izvesti u importu** s puno signala.

### 15.1. Zašto pipeline-time ne radi, import-time radi

| Aspekt | Pipeline-time (sad, ad-hoc kroz Gemini) | Import-time (predloženo, u domovina-rag) |
|---|---|---|
| Dostupne info | Samo jedna epizoda | Cijeli korpus + povijest svih ranije viđenih speakera |
| Mogu li koristiti voice similarity? | Ne (jedna epizoda) | Da (cross-episode cosine similarity) |
| Mogu li koristiti graf co-occurrence-a? | Ne | Da (Marin + Stanko često zajedno → vjerojatno Vučković + Stojić) |
| Re-iterabilno kad pristignu novi podaci? | Ne (Gemini bi morao re-procesirati sve) | Da (algoritam ponovi za sve dvojbene s novim signalom) |
| Human-in-the-loop review? | Komplicirano | Direktno (review queue, merge/split UI) |
| Cost | Skup (Gemini per pojavi) | Jeftin (lokalni algoritam, voice embedding compute jednokratno) |

Zaključak: Gemini ostaje **samo izvor "kandidatskih imena"** koji se trpaju u
`speaker_hints` polje (vidi `data_contract.md` §2 i §4). Importer ih tretira kao još jedan signal,
**ne kao truth**.

### 15.2. Signali za entity resolution (rangirano po snazi)

| # | Signal | Snaga | Trošak | Implementacijska prepreka |
|---|---|---|---|---|
| 1 | **Voice embedding cosine similarity** | Najjaća | Niska po queryju, jednokratan extraction | **Pyannote pipeline ne ekstrahira embeddings trenutno** — treba modifikacija (vidi §15.5) |
| 2 | Name string match (normalizirano, Levenshtein, prefix match) | Srednja | Trivijalan | Nema |
| 3 | Channel + datum era (Marin u 2024 ≠ Marin u 2026 nužno) | Slabi-srednji | Trivijalan | Nema |
| 4 | Co-occurring speaker graph | Srednji | Trivijalan | Nema |
| 5 | LLM disambiguation za ambiguous parove | Srednji-jak | Skupo (~$0.005 po paru) | Nema, ali treba ograničiti potrošnju |

### 15.3. Algoritam (skica)

```python
def resolve_speaker_at_import(
    local_tag: str,                    # "SPEAKER_00"
    episode: Episode,                  # PG entitet
    name_hints: list[str],             # od Geminija
    voice_embedding: np.array | None,  # ako je ekstrahiran iz pipelinea
    co_speakers_local: list[str]       # ["SPEAKER_01", ...] u istoj epizodi
) -> ResolutionResult:

    candidates = []

    # 1) Voice match (ako imamo embedding)
    if voice_embedding is not None:
        # Ilustrativno jedan model; u praksi RRF preko oba modela — vidi §15.5
        voice_matches = pg.query("""
            SELECT id, canonical_name, voice_embedding_titanet, channels
            FROM speakers
            ORDER BY voice_embedding_titanet <=> %(emb)s  -- pgvector cosine
            LIMIT 10
        """, emb=voice_embedding)
        for s in voice_matches:
            sim = cosine_sim(voice_embedding, s.voice_embedding_avg)
            if sim > 0.75:
                candidates.append((s, "voice", sim))

    # 2) Name match
    for hint in name_hints:
        norm = normalize_name(hint)  # lowercase, strip dijakritika, strip "fra "
        name_matches = pg.query("""
            SELECT id, canonical_name, aliases
            FROM speakers
            WHERE normalized_name = %(n)s
               OR %(n)s = ANY(SELECT normalize_name(a) FROM jsonb_array_elements_text(aliases) a)
        """, n=norm)
        for s in name_matches:
            candidates.append((s, "name", 0.7))  # base score

    # 3) Channel + co-speaker bonus
    for cand, signal, score in candidates:
        if episode.channel in cand.channels:
            score += 0.1  # boost za isti kanal
        co_canon = resolve_co_speakers(episode, co_speakers_local)
        if any(c in cand.frequent_co_speakers for c in co_canon):
            score += 0.05

    # 4) Sortiraj, odluči
    candidates.sort(key=lambda x: x[2], reverse=True)
    if not candidates:
        return create_new_speaker(name_hints, voice_embedding, needs_review=False)

    top = candidates[0]
    if top[2] > 0.9:
        return link_to_existing(top[0], confidence="high")
    elif top[2] > 0.75:
        return link_to_existing(top[0], confidence="medium", needs_review=True)
    elif top[2] > 0.6 and len(candidates) > 1:
        # Ambiguous — LLM disambiguation
        winner = llm_disambiguate(top, candidates[1], context=episode)
        return link_to_existing(winner, confidence="medium", needs_review=True)
    else:
        return create_new_speaker(name_hints, voice_embedding, needs_review=True)
```

### 15.4. PostgreSQL shema za speakers (proširena verzija §4)

```sql
CREATE EXTENSION IF NOT EXISTS vector;  -- pgvector za speaker voice embeddings

CREATE TABLE speakers (
    id              BIGSERIAL PRIMARY KEY,
    canonical_name  TEXT NOT NULL,                  -- "fra Ante Vučković"
    normalized_name TEXT GENERATED ALWAYS AS (normalize_name(canonical_name)) STORED,
    aliases         JSONB DEFAULT '[]'::jsonb,      -- ["Ante", "fra Ante", "Vučković", ...]
    voice_embedding_titanet   VECTOR(192),          -- prosjek TitaNet utterance embeddinga (NeMo, 192-dim)
    voice_embedding_wespeaker VECTOR(256),          -- prosjek pyannote-wespeaker embeddinga (256-dim)
    voice_embedding_count INT DEFAULT 0,            -- broj segmenata koji su ušli u prosjek
    channels        JSONB DEFAULT '[]'::jsonb,      -- u kojim kanalima se pojavljuje
    first_seen_episode_id BIGINT REFERENCES episodes(id),
    last_seen_episode_id BIGINT REFERENCES episodes(id),
    total_speech_sec FLOAT DEFAULT 0,
    confidence      FLOAT DEFAULT 0.5,              -- agregirana confidence ovog entiteta
    needs_review    BOOLEAN DEFAULT TRUE,           -- za review queue
    review_notes    TEXT,
    created_at      TIMESTAMP DEFAULT now(),
    updated_at      TIMESTAMP DEFAULT now()
);

CREATE INDEX speakers_norm_name_idx ON speakers(normalized_name);
CREATE INDEX speakers_voice_titanet_idx   ON speakers USING ivfflat (voice_embedding_titanet   vector_cosine_ops);
CREATE INDEX speakers_voice_wespeaker_idx ON speakers USING ivfflat (voice_embedding_wespeaker vector_cosine_ops);

CREATE TABLE speaker_episode_appearances (
    speaker_id      BIGINT REFERENCES speakers(id),
    episode_id      BIGINT REFERENCES episodes(id),
    local_tag       TEXT NOT NULL,                  -- "SPEAKER_00"
    name_hints      JSONB DEFAULT '[]'::jsonb,      -- ["Ante", "fra Ante"] iz Gemini hintova
    voice_embedding_titanet   VECTOR(192),          -- per-epizoda prosjek (TitaNet)
    voice_embedding_wespeaker VECTOR(256),          -- per-epizoda prosjek (pyannote-wespeaker)
    total_speech_sec FLOAT,
    confidence      FLOAT,                          -- confidence linka, ne speakera
    resolution_method TEXT,                         -- "voice" | "name" | "llm" | "manual"
    PRIMARY KEY (episode_id, local_tag)
);

CREATE TABLE speaker_review_queue (
    id              BIGSERIAL PRIMARY KEY,
    speaker_id      BIGINT REFERENCES speakers(id),
    candidate_alternatives JSONB,                   -- [{speaker_id, similarity_score, reason}]
    suggestion_type TEXT,                           -- "merge" | "split" | "rename" | "low_conf_link"
    raised_at       TIMESTAMP DEFAULT now(),
    resolved_at     TIMESTAMP,
    resolved_by     TEXT,
    resolution      TEXT
);
```

### 15.5. Pipeline modifikacija — embedding extraction

Za signal #1 (najjači) trebamo extraction **average speaker embeddinga po lokalnom tag-u**
iz audija. Bilo koji moderni speaker verification model radi posao; razlika je samo u kvaliteti
(EER) i licenci.

#### Izbor modela

| Model | Licenca | EER (VoxCeleb1) | Embedding dim | Komentar |
|---|---|---|---|---|
| `pyannote/wespeaker-voxceleb-resnet34-LM` | Apache 2.0 | ~1.5% | 192 | Baseline, integriran u `pyannote.audio`. Solidno za 80% slučajeva. |
| **`nvidia/speakerverification_en_titanet_large`** 🟢 | NVIDIA Open Model License | **~0.7%** | 192 | **Preporuka.** ~3-4× točniji od baseline-a, dijeli NeMo dependency ecosystem s postojećim Canary pipelineom (`colab_canary/transcribe_canary.py`). |
| `Wespeaker/voxceleb_resnet293_LM` | Apache 2.0 | ~0.6% | 256 | Najbolji čisto FOSS izbor; ali treba raw `wespeaker` lib, nova dependency. |
| 3D-Speaker ERes2NetV2 | Apache 2.0 | ~0.5% | 192 | SOTA na papiru; manji ekosistem, manje primjera za podcast use case. |

**Preporuka: multi-model ensemble s TitaNet + pyannote-wespeaker baseline.** Razlozi:
1. NeMo je već u pipeline-u (Canary) → TitaNet je zero-marginal dep
2. pyannote je već u pipeline-u (diarizacija) → wespeaker-resnet34 je zero-marginal dep
3. Različite arhitekture (Conformer hybrid vs ResNet) → različiti failure modes → ensemble lift
4. Storage trošak trivijalan (~4 KB po epizodi za oba)

**Ensemble strategija — Reciprocal Rank Fusion (RRF), u Postgresu/pgvector:**

Embeddings iz različitih modela **nisu** direktno kombinabilni (različite dimenzije — TitaNet 192,
wespeaker 256 — i različiti vektorski prostori). ALI rezultati rangirani po cosine similarity
**JESU** kombinabilni preko RRF-a. Na ovoj skali (par tisuća glasovnih vektora) sve staje u
Postgres uz `pgvector`; ClickHouse nije potreban (vidi **Odluku** ispod).

Dva odvojena pgvector upita (jedan po modelu, svaki nad svojim stupcem) + fuzija u kodu importera
koji ionako radi u Pythonu (§15.3):

```python
def rrf_speaker_candidates(emb_titanet, emb_wespeaker, k=60, limit=50):
    titanet = pg.query("""
        SELECT id AS speaker_id
        FROM speakers
        WHERE voice_embedding_titanet IS NOT NULL
        ORDER BY voice_embedding_titanet <=> %(e)s   -- pgvector cosine
        LIMIT %(n)s
    """, e=emb_titanet, n=limit)
    wespeaker = pg.query("""
        SELECT id AS speaker_id
        FROM speakers
        WHERE voice_embedding_wespeaker IS NOT NULL
        ORDER BY voice_embedding_wespeaker <=> %(e)s
        LIMIT %(n)s
    """, e=emb_wespeaker, n=limit)

    scores = {}
    for rank, row in enumerate(titanet, 1):     # rang 1 = najsličniji
        scores[row.speaker_id] = scores.get(row.speaker_id, 0) + 1.0 / (k + rank)
    for rank, row in enumerate(wespeaker, 1):
        scores[row.speaker_id] = scores.get(row.speaker_id, 0) + 1.0 / (k + rank)

    return sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:10]
```

Isto se može izraziti i čistim SQL-om (dva `ROW_NUMBER()` CTE-a nad pgvector `<=>` + `FULL OUTER
JOIN`), ali na ovoj skali Python fuzija je jednostavnija i drži svu resolution logiku na jednom
mjestu. RRF:
- **Boosta** rezultate koji su top kod oba modela (jaka konvergencija)
- **Detektira anomalije** kad se modeli radikalno razilaze (kandidat za `needs_review`)
- Nema pretpostavki o vektorskim prostorima — samo o rangovima

Treći ili četvrti model lako se doda u istoj formuli; trošak je linearan u broju modela.

> **Odluka (2026-06-02): glasovni embeddings idu POTPUNO u Postgres/pgvector, NE ClickHouse.**
> Ranija skica je RRF pisala u ClickHouse (`speaker_voice_signatures`, `cosineDistance`); to je bila
> premature optimization za broj vektora koji stvarno imamo. Razlozi za pgvector:
> 1. **Skala je mala** — ~2700 epizoda × 2-3 govornika ≈ 5-8k per-appearance vektora, nekoliko
>    stotina kanonskih osoba. I pgvector i brute-force scan su <1 ms; performansa nije faktor odluke.
> 2. **Workload je mutation-heavy** — `voice_embedding_*` se stalno reračunava (nova epizoda;
>    merge/split iz review queue-a). To je transakcijski row-level UPDATE → Postgres teritorij;
>    ClickHouse (kolonarni OLAP) je loš za česte point-update (async `ALTER … UPDATE` mutacije).
> 3. **Relacijski kontekst je već u PG** — `speakers`, `speaker_episode_appearances`,
>    `speaker_review_queue`, FK na `episodes`. Vektor drugdje = cross-engine JOIN za svaku resoluciju.
>
> ClickHouse ostaje gdje je jak: veliki **tekstualni** embedding store (`rag_chunks.embedding`,
> bge-m3 1024-dim, HNSW USearch) — to je prava OLAP/scale stvar. Glasove ne cijepamo onamo.
>
> **Iznimka koja bi promijenila odluku:** realtime "snimi 5s glasa, nađi tko je to" pretraga nad
> stotinama tisuća *pojedinačnih* utterance vektora (ne po-govornik prosjeka). Tada bi append-only
> signature tablica u ClickHouse imala smisla zbog skale. Nije u scope-u — YAGNI dok se ne dokaže potreba.

**Croatian-specific napomena:** TitaNet ima `_en_` u imenu jer je trening korpus pretežno engleski
(VoxCeleb-fokus). Cross-lingual transfer za speaker verification je dobro istražen i daje ~10-30%
EER degradaciju za HR (procjena ~1.0-1.5%). Za **entity resolution use case** (intra-speaker
comparison kroz epizode iste osobe) razlika je u praksi neprimjetna. Pyannote wespeaker baseline
ima identičan VoxCeleb bias. Ako se kasnije pokaže potreba za hrvatsku robustnost, **3D-Speaker
ERes2NetV2** (VoxBlink2-trained, najmultilingual) je realna upgrade meta.

Implementacija (modifikacija `colab_diarize/diarize_canary.py` ili novi `colab_speaker_embeddings/`
notebook za backfill):

```python
from nemo.collections.asr.models import EncDecSpeakerLabelModel
import torch, numpy as np, json
from datetime import datetime

device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
embedding_model = EncDecSpeakerLabelModel.from_pretrained("nvidia/speakerverification_en_titanet_large").to(device)
embedding_model.eval()

# Tijekom diarizacije, za svaki SPEAKER_XX:
speaker_embeddings = {}
for speaker_id, segments in diarization_segments.items():
    usable = [s for s in segments if s.duration > 1.0]
    if not usable:
        continue

    embeds = []
    for seg in usable:
        segment_audio = wav_array[int(seg.start*16000):int(seg.end*16000)]
        with torch.no_grad():
            emb = embedding_model.infer_segment(torch.tensor(segment_audio).to(device))
        embeds.append(emb.cpu().numpy())

    avg = np.mean(embeds, axis=0)
    avg = avg / np.linalg.norm(avg)  # L2 normalize, omogućava direktnu cosine similarity

    speaker_embeddings[speaker_id] = {
        "vector": avg.tolist(),
        "total_speech_sec": sum(s.duration for s in usable),
        "num_segments": len(usable),
        "confidence": min(1.0, len(usable) / 50.0)
    }

# Spremi pored .diarized.srt:
output_path = wav_path.replace(".wav", ".wav.canary.diarized.embeddings.json")
json.dump({
    "version": 1,
    "generated_at": datetime.utcnow().isoformat() + "Z",
    "model": "nvidia/speakerverification_en_titanet_large",
    "embedding_dim": 192,
    "embeddings": speaker_embeddings
}, open(output_path, "w"))
```

#### Performance i storage

| Resurs | TitaNet-Large |
|---|---|
| Per-episode compute (G4 GPU) | ~3-8s |
| Per-episode compute (M4 Pro MPS) | ~30-60s |
| Per-episode compute (CPU) | ~120-180s |
| Storage per episode | ~2 KB |
| RAM (model) | ~150 MB |

#### Deploy strategija

**Going-forward (incremental):** modifikacija `colab_diarize/diarize_canary.py` — sve nove epizode
od deploy-a dobivaju embeddings as side-effect dijarizacije. Marginal trošak: ~30s/epizoda.

**Backfill (jednokratno):** zaseban `colab_speaker_embeddings/domovina_tv_speaker_embeddings.ipynb`
notebook po uzoru na `colab_canary/`. Vrti se na Colab G4, **~3-5h za sve 2 559 epizoda**, ~$0.50-1.00
u Colab compute units. Idempotentno — skipa datoteke s postojećim `.embeddings.json`. Vidi
[`colab_speaker_embeddings/README.md`](../colab_speaker_embeddings/README.md) za detalje pokretanja.

### 15.6. Review queue — human-in-the-loop

Algoritam će **uvijek imati nekih ambiguous slučajeva**. Per scale 2 559 epizoda + budući rast,
očekivano ~50-100 inicijalnih ambiguous na pune backfill-u, plus 1-5 po tjednu novih.

**`needs_review = TRUE`** slučajevi idu u `speaker_review_queue`. Review UI (kasnije u
domovina.ai admin panelu, ili minimalno kao CLI tool) prikaže:

```
Speaker #142 (canonical: "Ante")
  Pojavljuje se u 12 epizoda, 3 kanala (jedno_ti_nedostaje, ad_deum_podcast, bozanstvena_komedija)
  Voice embedding: dostupan
  Sugerirani merge kandidati:
    [a] Speaker #87 "fra Ante Vučković" — voice sim 0.81, name overlap "Ante"
    [b] Speaker #203 "Ante Šarić" — voice sim 0.34, name overlap "Ante"
    [c] Speaker #511 "fra Ante Vučković" — voice sim 0.92, name overlap "fra Ante" 🟢
    [d] Ne mergaj — to je posebna osoba
  Odluka? [a/b/c/d/skip]
```

User: `c` → backend merge-aj #142 i #511 (alias se dodaje, sve appearance se prenose, history u
audit log).

### 15.7. Concrete example: "fra Ante" → fra Ante Vučković

Tipičan flow:

```
Korisnikov upit kroz Claude.ai MCP klijent:
  "Što je fra Ante rekao o muževima?"

MCP server:
  1. Normalize query → embedding
  2. Pozove search_podcasts(query, speaker_filter_hint="fra Ante")
     ↳ MCP tool prvo razriješi "fra Ante" → canonical speaker ID:
        SELECT id FROM speakers
        WHERE normalized_name LIKE 'fra ante%' OR aliases @> '["fra Ante"]'
        ORDER BY total_speech_sec DESC LIMIT 5;
     ↳ Vraća: [
          { id: 511, name: "fra Ante Vučković", speech_sec: 14523 },  -- glavna match
          { id: 88,  name: "fra Ante Pavlović",  speech_sec: 432 }     -- drugi
        ]
     ↳ Top kandidat (po total speech) ide kao default; ako su skoroviše ravnomjerni,
        tool vraća disambiguation prompt: "Mislili ste fra Ante Vučković ili fra Ante Pavlović?"
  3. Filter chunkove po speaker_id = 511 u svim epizodama
     SELECT * FROM rag_chunks
     WHERE speaker_id = 511
     ORDER BY cosineDistance(embedding, :q_vec) LIMIT 10;
  4. Vrati strukturirano LLM-u za sintezu odgovora.
```

**Ključno za UX:** kad korisnik je dvosmislen ("fra Ante"), agent **eksplicitno vraća
disambiguation** umjesto da tiho odabere jednog. Claude će to dobro renderirati u svom UI-u.

### 15.8. Migration / phased rollout

Plan implementacije ove kompleksne logike:

**Faza A: Naive name match (1 dan)**
- PG `speakers` tablica, normalize_name funkcija
- Importer puni speakere iz `speaker_hints` čistim string matchom
- Zna se da će biti loših matcheva, ali pokriva 60-70% slučajeva
- Sve s niskim confidence-om → `needs_review=true`

**Faza B: Voice embedding pipeline (3-5 dana)**
- Modificirati `diarize_canary.py` da producira `.embeddings.json`
- Forward-only: nove epizode od trenutka deploy-a imaju embeddings
- Importer počinje koristiti voice signal za nove epizode

**Faza C: Backfill embeddings za high-value epizode (par tjedana wall clock)**
- Backfill skripta procesira top 200 epizoda po `total_speech_sec` per ključnim speakerima
- Ne radi se sve 2 559 odmah — fokus na "važne" osobe gdje cross-episode disambiguacija puno
  vrijedi (fra Ante Vučković, Damir Biloglav, itd.)

**Faza D: Review queue UI (2-3 dana)**
- Minimal admin panel ili CLI tool za procesiranje review queue-a
- Manual merge/split akcije
- Audit log

**Faza E: LLM disambiguation za rezidual (1 dan)**
- Za ambiguous parove koje algoritam ne riješi, LLM s kontekstom
- Hard limit: $5/dan, in queue

Iz perspektive korisnika kvaliteta se penje postepeno: Faza A → "fra Ante" radi za 60-70% upita,
Faza B+C → 85-90%, Faza D+E → 95%+.

### 15.10. Pyannote failure modes i Sortformer ensemble strategija

Empirijski, pyannote (i bilo koji diarization model) pravi 4 klase grešaka. Import-time entity
resolution **dvije rješava, dvije ne** — bitno je to znati prije implementacije da znamo realan
ceiling kvalitete:

| Failure mode | Što se događa | Importer može popraviti? | Mitigacija |
|---|---|---|---|
| **Intra-episode over-segmentation** | Marin u jednoj epizodi je istovremeno `SPEAKER_00` i `SPEAKER_03` (pyannote splitne kad mijenja ton, mikrofon, pauzira nakon prolaska) | ✅ Da | Voice embedding cosine > 0.9 unutar **iste epizode** → automatski merge prije globalnog resolution-a. Pristup: prvo intra-episode dedup, pa onda cross-episode link. |
| **Cross-episode under-detection** (Marin u 5 epizoda dobiva 5 različitih labela) | Različite epizode imaju različite SPEAKER_XX → ista osoba | ✅ Da | Glavni use case algoritma §15.3 — cross-episode voice similarity + name + metadata. |
| **Missing speaker** | Tihi gost, overlap sa drugim, audio dropouts → uopće ne detektiran | ❌ Ne | Audio-level problem, nije popravljiv iz JSONL-a. **Mitigacija:** Sortformer ensemble (vidi dolje). |
| **Krivo dodjeljen tekst** | Pyannote bound između dva speakera promaši, pripiše krivu osobu | ❌ Ne (lokalno) | Re-diarizacija drugim modelom (Sortformer). |

#### Kad Sortformer ensemble ima smisla

Pipeline već producira **dva paralelna outputa** za rastući broj epizoda:
- `*.canary.diarized.srt` (pyannote — sazriva)
- `*.sortformer.diarized.srt` (NVIDIA Streaming Sortformer 4spk v2.1 — eksperimentalno)

Ovo je *case-by-case* dragocjeno za missing speakers i text mis-assignment. Strategija:

```
Importer per-episode:
  1. Procesiraj canary.diarized.srt → entity resolution
  2. Ako sortformer.diarized.srt postoji za istu epizodu:
      a. Usporedi broj globalnih speakera i total speech_sec po speakeru
      b. Ako Sortformer ima govornika kojeg canary nema (sa speech > 30s):
         → Ovo je MISSING SPEAKER kandidat
         → Linkaj sortformer chunke za tog speakera u rag_chunks dodatno
         → Označi epizodu s metadata flag "sortformer_recovered_speaker": true
      c. Ako se Sortformer i canary jako razilaze u dodjeli (overlap < 60%):
         → Označi epizodu za review (`needs_diarization_review`)
  3. Ako stvori se zaseban speaker_id za sortformer-recovered chunkove,
     entity resolution još jednom probleža da ih linkuje globalno.
```

Ovo nije O(n²) trošak — to je samo dodatni metadata join u importu, par redaka SQL/Python koda.

**Kada uključiti Sortformer ensemble:** tek kad imaš osnovni canary-only resolution stabilan
(Faza A-B u §15.8). Ensemble je optimizacija "long tail" 5-15% grešaka, ne baseline.

**Kada NE uključiti:** za epizode gdje Sortformer i canary daju radikalno različite outpute,
ensemble će dodati šum. Bolje označiti `needs_review` nego automatski merge-ati nepouzdane signale.

### 15.11. Voice aging i adaptive threshold

Speaker embeddings nisu invarijantni kroz vrijeme. Iz NIST SRE i drugih istraživanja (2023-2025):

| Vremenski razmak | Tipična cosine similarity istog speakera | Recall@1 s fiksnim t=0.75 |
|---|---|---|
| Ista epizoda / dan | 0.85-0.95 | 99% |
| Isti mjesec | 0.80-0.90 | 95% |
| 1-2 godine | 0.65-0.80 | 80% |
| 3-5 godina | 0.55-0.75 | 60% |
| 10+ godina | 0.45-0.65 | 40% |

Drugi degraderi (često JAČI od starenja):
- Promjena mikrofona / studija (npr. iz studija u kućno snimanje)
- Bolest, alkohol, umor, hladnoća
- Različite vrste mikrofona (lavalier vs cardioid vs USB)

**Fiksni threshold ne radi**. Treba **adaptivni threshold** koji koristi metapodatke za kompenzaciju.

#### Formula za adaptive threshold

```python
def adaptive_threshold(episode_a, episode_b, name_hints_overlap, co_speaker_overlap):
    """
    Vraća threshold koji se mora preći za auto-link.
    Niži threshold = lakše ulinkati (metadata signali daju confidence).
    """
    base = 0.75

    # 1) Penalize vremenski razmak
    years_apart = abs(episode_a.upload_date - episode_b.upload_date).days / 365.0
    if years_apart < 0.5:
        time_penalty = 0
    elif years_apart < 2:
        time_penalty = 0.05
    elif years_apart < 5:
        time_penalty = 0.10
    else:
        time_penalty = 0.15

    threshold = base + time_penalty

    # 2) Relax za podudaranje konteksta
    if episode_a.channel == episode_b.channel:
        threshold -= 0.05    # vjerojatno isti recording setup
    if name_hints_overlap:
        threshold -= 0.10    # imena se podudaraju
    if co_speaker_overlap >= 2:
        threshold -= 0.10    # 2+ zajednička gosta = jak signal
    elif co_speaker_overlap == 1:
        threshold -= 0.05

    # 3) Klamp
    return max(0.50, min(0.85, threshold))
```

**Primjer**: cosine sim = 0.62 između dva embedinga.
- Snimak A: jedno_ti_nedostaje, 2021-03
- Snimak B: jedno_ti_nedostaje, 2026-04 (5 godina razmak)
- Name hints overlap: "fra Ante" oboje
- Co-speakers: oboje sa "Stanko Stojić"

Threshold: 0.75 + 0.10 (5y) - 0.05 (kanal) - 0.10 (ime) - 0.10 (co-speakers) = **0.60**

Cosine 0.62 > threshold 0.60 → **MATCH** s medium confidence.

Bez metadata kompenzacije, fiksni 0.75 bi ovo propustio kao "nije match" — što je očita data
quality greška jer su to objektivno ista osoba.

#### Threshold-ovi kroz akcije

| Cosine - threshold | Akcija |
|---|---|
| > +0.10 | Auto-link, confidence=high |
| 0 to +0.10 | Auto-link, confidence=medium, `needs_review=true` |
| -0.05 to 0 | Vlažna zona — pošalji u LLM disambiguation s kontekstom |
| < -0.05 | Ne mergaj, kreiraj novi entity (možda kasnije revidiraj) |

#### Što s embeddinzima koji DRAMATIČNO dropnu

Ako se isti speaker između epizoda razlikuje za > 0.4 (npr. cosine sim 0.40 vs ~0.85 očekivano):
- **Mikrofon je gotovo sigurno promijenjen**, ne osoba
- Algoritam će ovo propustiti i kreirati novi entity
- **Mitigacija**: kasnije, kad imaš par mjeseci podataka, pokreni periodični "global re-cluster"
  job koji koristi LLM + name + channel + speech topic embedding za "sumnjiv slučajeve" (entity
  s 1-2 appearance koji ima sličnost s drugim entity-em u istom kanalu po ne-voice signalima)

Ovo je advanced feature za Faza E+ (LLM rezidual disambiguation). Ne baseline.

### 15.12. Sažetak za fetch.domovina.tv (data producer)

Što ovaj repo treba dati downstream-u za sve gornje:

| Što | Stanje | Akcija |
|---|---|---|
| `speaker_hints` u JSONL/JSON outputu | Postoji u trenutnim Gemini outputima | Formaliziraj kao `speaker_hints` polje u data contractu ([§2](./data_contract.md#2-rag_combinedjsonl-stabilna-shema-v10)) — već učinjeno |
| `*.canary.diarized.embeddings.json` | NE postoji | Modificirati `colab_diarize/diarize_canary.py` (§15.5) — TODO ovdje u repu, forward-only |
| Backfill embeddings za stare epizode | NE postoji | Zaseban `colab_speaker_embeddings/` Colab notebook (§15.5 deploy strategija) — kreiran |
| `*.sortformer.diarized.srt` paralelni output | Postoji za dio epizoda (eksperimentalno) | Nastaviti generirati — koristi se za ensemble (§15.10) |
| Canonical speakers tablica | NE postoji | Ide u domovina-rag (PG), NE ovdje |

---

## 16. Reference / further reading

- ClickHouse vector search: https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/annindexes
- ClickHouse PostgreSQL table engine: https://clickhouse.com/docs/en/engines/table-engines/integrations/postgresql
- BGE-M3 model card: https://huggingface.co/BAAI/bge-m3
- BGE Reranker v2-m3: https://huggingface.co/BAAI/bge-reranker-v2-m3
- Coolify docs: https://coolify.io/docs/applications/docker-compose
- pgvector vs ClickHouse benchmark (general): https://github.com/qdrant/vector-db-benchmark
- MCP specifikacija: https://modelcontextprotocol.io/specification
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Claude.ai custom connectors (kako spojiti remote MCP): https://support.anthropic.com/en/articles/9930211-connectors
- OAuth 2.1 + DCR za MCP: https://modelcontextprotocol.io/specification/authentication
- Valkey (FOSS Redis fork): https://valkey.io

---

**Kraj plana.** Nije implementiran kod — ovo je samo dizajn dokument za sustavno čitanje i odluke.
Pitanja iz §13 odgovori prije nego krenemo s Fazom 1, da ne radimo dvaput.
