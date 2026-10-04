# Fish Farm RAG — Environment Setup Plan

> Goal: a small, cheap, personal RAG system that lets me ask questions (in Vietnamese)
> over a **trusted** aquaculture knowledge base — scanned/printed books from the local
> library, articles, and short notes captured from social networks — and always get
> answers **with citations back to the source and its trust level**.
>
> Non-goals for now: low latency, multi-user, horizontal scale.

Status: **draft v2** — stack fixed to **Haystack + TypeORM + SCSS, everything in Docker Compose on the local machine**.
Scope of this doc: environment + skeleton only (no real RAG logic yet).

---

## 0. Guiding decisions (TL;DR)

| Concern | Decision | Why |
|---|---|---|
| RAG framework | **Haystack 2.x** (`haystack-ai`) in a **Python** service (`apps/rag`) | Haystack is Python-only; it ships pgvector, Ollama and Anthropic integrations |
| RAG service API | FastAPI wrapping Haystack pipelines + a worker process from the same image | Explicit endpoints we control; worker handles slow ingestion |
| App API | **NestJS + TypeORM** (`apps/api`) | TypeORM works best with NestJS: decorators, DI, migrations CLI. See §1.4 for the Next-only alternative |
| Frontend | **Next.js + SCSS** (CSS Modules `*.module.scss`) + React Query (`apps/web`) | Your existing stack |
| Database | **One Postgres 17** with `pgvector`, `unaccent`, `pg_trgm` | Vectors, metadata, full-text search and job queue in one container |
| Schema ownership | TypeORM migrations own all **app** tables; Haystack's `PgvectorDocumentStore` owns the **chunk** table | Each tool manages what it understands; no second ORM in Python |
| Job queue | `ingest_jobs` table + Python worker using `SELECT … FOR UPDATE SKIP LOCKED` | No Redis; jobs survive restarts; works across TS↔Python |
| Embeddings | `bge-m3` via **Ollama** (1024-dim, multilingual, good Vietnamese) | $0 per token; CPU speed is fine |
| Retrieval | Hybrid: `PgvectorEmbeddingRetriever` + `PgvectorKeywordRetriever` → `DocumentJoiner` (reciprocal rank fusion) | Lexical match matters for species names and technical terms |
| Generation | `AnthropicChatGenerator` (anthropic-haystack), model set by env var | Strong Vietnamese; switch model without code change |
| OCR | `ocrmypdf` + Tesseract `vie` **installed in the rag image** (Python lib + CLI) | Free; Claude vision only as a per-page fallback later |
| TS ↔ Python contract | FastAPI OpenAPI → generated TS client (`openapi-typescript`) used by `apps/api` | Typed boundary without hand-written DTO duplication |
| Hosting | Local machine, `docker compose`, ports bound to `127.0.0.1` only | $0; nothing exposed to the network |

---

## 1. Architecture

```
 Browser
   │  http://localhost:3000
   ▼
┌──────────────┐  REST (React Query)  ┌───────────────┐   HTTP (generated client)   ┌──────────────────────┐
│ web          │ ───────────────────▶ │ api           │ ──────────────────────────▶ │ rag-api (FastAPI)    │
│ Next.js+SCSS │                      │ NestJS+TypeORM│   /ask, /health              │ Haystack query pipe  │
└──────────────┘                      └──────┬────────┘                              └─────────┬────────────┘
                                             │ TypeORM: sources, tags,                         │ embed query (Ollama)
                                             │ ingest_jobs, qa_log                             │ retrieve (pgvector+FTS)
                                             │ writes uploads → ./data/raw                     │ generate (Claude API)
                                             ▼                                                 ▼
                                   ┌──────────────────────────────────────────────────────────────────┐
                                   │ db: Postgres 17 + pgvector + unaccent                            │
                                   │  app tables (TypeORM)  │  haystack_chunks (PgvectorDocumentStore)│
                                   └──────────────────────────────────────────────────────────────────┘
                                             ▲                                                 ▲
                                             │ poll ingest_jobs (SKIP LOCKED)                  │
                                   ┌─────────┴────────────┐   embed chunks   ┌─────────────────┴──┐
                                   │ rag-worker (Python)  │ ───────────────▶ │ ollama (bge-m3)    │
                                   │ OCR → convert → clean│                  └────────────────────┘
                                   │ → split → embed →    │
                                   │ write (Haystack)     │  reads ./data/raw, writes ./data/ocr
                                   └──────────────────────┘
```

**Ingestion flow:** upload in `web` → `api` saves the file to `/data/raw/<sha256>.<ext>`, inserts `sources`
(status `pending`) and an `ingest_jobs` row → `rag-worker` claims the job → OCR if needed → Haystack indexing
pipeline writes chunks with `meta.source_id` → worker sets `sources.status = ready` (or `failed` + error).

**Query flow:** `web` → `api` `POST /ask` → `rag-api` runs the query pipeline → returns the answer and the cited
chunk metadata → `api` writes `qa_log` and returns to `web`.

### 1.1 Haystack pipelines (skeleton targets)

Indexing (`rag-worker`):
```
FileTypeRouter → PyPDFToDocument / TextFileToDocument (after ocrmypdf for scans)
  → DocumentCleaner → (custom) VietnameseNormalizer [NFC, OCR line-break/hyphen fixes]
  → RecursiveDocumentSplitter (~600–800 tokens, overlap ~10%)
  → OllamaDocumentEmbedder(model="bge-m3")
  → DocumentWriter(PgvectorDocumentStore, policy=OVERWRITE)
```
Query (`rag-api`):
```
OllamaTextEmbedder ─▶ PgvectorEmbeddingRetriever ─┐
query text ──────────▶ PgvectorKeywordRetriever  ──┴▶ DocumentJoiner(reciprocal_rank_fusion)
  → ChatPromptBuilder (Vietnamese system prompt, numbered sources [1]..[n] with trust level)
  → AnthropicChatGenerator(model=$LLM_MODEL)
```
Note: Don't use NLTK sentence splitting (`split_by="sentence"`). Its models don't cover Vietnamese.
Use the recursive/passage splitting above. Start with numbered `[n]` citations in the prompt. Native
Claude citations would need a custom component; consider them later.

### 1.2 Chunk table (owned by Haystack)

`PgvectorDocumentStore(table_name="haystack_chunks", embedding_dimension=1024, vector_function="cosine_similarity", search_strategy="hnsw", language="simple", create_table=True)`.

- `language="simple"`: Postgres has no Vietnamese text-search config.
- Every chunk's `meta` holds `source_id`, `page_from`, `page_to`, `heading_path`, `trust_level`,
  `tags`, `embedding_model`. This lets Haystack metadata filters do "only trust ≤ 2" or "only cá tra".
- `trust_level` is copied into `meta` at index time. If a source's trust level changes, `api` enqueues a
  `resync_meta` job (rare, cheap).
- Known limitation: the built-in keyword retriever doesn't apply `unaccent`. Queries typed **with** diacritics
  match fine. Queries typed without them (`ca ro phi`) rely on vector search alone. If that hurts in practice,
  add a small custom Haystack component that runs our own SQL with `f_unaccent` (function created in §3 Phase 2).
- Pin the `pgvector-haystack` version, because the table schema and the keyword query are defined by the
  integration. Check the generated DDL after each upgrade.

### 1.3 Schema ownership rule

- TypeORM is the **only** thing that runs DDL for app tables (`synchronize: false` always, explicit migrations).
- Haystack creates and owns `haystack_chunks`. `apps/api` can read it through an entity marked
  `@Entity({ name: 'haystack_chunks', synchronize: false })`, so migration generation ignores it. It never
  writes to it.
- Python touches app tables only through a handful of plain SQL statements (`psycopg`): claim a job, update job
  status, update source status. These live in one module (`apps/rag/src/ffr_rag/db.py`). No SQLAlchemy.

### 1.4 Why NestJS for TypeORM (and the alternative)

TypeORM inside Next.js route handlers works, but it causes friction:
- decorator/metadata config for SWC
- keeping a DataSource singleton alive across HMR
- `serverExternalPackages`
- running migrations outside the Next runtime

A small NestJS app avoids all of that, and it gives job orchestration and the rag-api proxy a natural home.
The cost is one more container (~100 MB RAM).
**Alternative:** Next.js only (web + route handlers + TypeORM), which means one fewer service. Pick this if
`dirigeo-monorepo` already solves TypeORM in Next.

---

## 2. Repository layout

```
fish-farm-rag/
├─ apps/
│  ├─ web/                    # Next.js (App Router), SCSS modules, React Query
│  │  └─ src/styles/          # _tokens.scss, _mixins.scss, globals.scss
│  ├─ api/                    # NestJS + TypeORM
│  │  └─ src/
│  │     ├─ database/         # data-source.ts (CLI + app), migrations/
│  │     ├─ sources/          # entity, controller, service (upload, list, status)
│  │     ├─ ingest-jobs/      # entity + enqueue service
│  │     ├─ ask/              # proxy to rag-api, writes qa_log
│  │     └─ rag-client/       # generated from rag-api OpenAPI
│  └─ rag/                    # Python 3.12, uv-managed
│     ├─ pyproject.toml / uv.lock
│     ├─ src/ffr_rag/
│     │  ├─ api.py            # FastAPI app: /health, /ask
│     │  ├─ worker.py         # job loop: claim → run indexing pipeline → update status
│     │  ├─ pipelines/        # indexing.py, query.py (Haystack)
│     │  ├─ components/       # VietnameseNormalizer, (later) UnaccentKeywordRetriever
│     │  ├─ db.py             # psycopg: ingest_jobs + sources status SQL
│     │  └─ settings.py       # pydantic-settings, reads env
│     └─ tests/
├─ packages/
│  └─ config/                 # shared tsconfig / eslint / prettier (from dirigeo)
├─ infra/
│  ├─ compose.yml             # all services, prod-like builds
│  ├─ compose.dev.yml         # overrides: bind mounts + hot reload
│  ├─ postgres/init.sql       # extensions + f_unaccent
│  └─ docker/                 # Dockerfiles: web, api, rag (multi-stage)
├─ scripts/                   # backup.sh, restore.sh, bulk-import
├─ data/                      # ⛔ gitignored, bind-mounted: raw/, ocr/, backups/
├─ docs/
├─ .env.example
└─ Makefile                   # thin wrappers: up, down, logs, migrate, pull-models, backup
```

The pnpm/Turborepo workspace covers `apps/web`, `apps/api` and `packages/*`. `apps/rag` is a standalone
`uv` project. Turbo can still call its `lint`/`test` through a tiny `package.json` with scripts that run
`uv run ruff check` / `uv run pytest`, so `pnpm turbo lint test` covers everything.

---

## 3. Phase-by-phase setup

Each phase ends with a **done when** check. Do them in order; each is roughly an evening.

### Phase 0 — Prerequisites on the host

| Tool | Version | Notes |
|---|---|---|
| Docker Engine / Docker Desktop + Compose v2 | latest | Runs everything |
| Node.js + pnpm (`corepack enable`) | current LTS (match dirigeo `.nvmrc`) | For IDE, type-checking, codegen outside containers |
| Python 3.12 + `uv` | — | For IDE/pyright and running tests outside containers |
| Git, VS Code (+ Docker, Python, ESLint, Stylelint extensions) | — | |
| Anthropic API key | — | console.anthropic.com → set a **monthly spend limit** (e.g. $20) |

Hardware: **16 GB RAM recommended** (8 GB works if you stop `web` dev mode while batch-indexing). Rough
footprint: Postgres ~300 MB, Ollama + bge-m3 ~2–3 GB, Haystack services ~0.5–1 GB, Nest + Next dev
~1 GB. Disk: ~20 GB for images, models, DB and scans.

macOS note: Docker Desktop on Mac can't use the Apple GPU. CPU embedding in the Ollama container is fine at
this scale. If bulk-indexing many books feels too slow, run Ollama natively and point
`OLLAMA_BASE_URL=http://host.docker.internal:11434`.

**Done when:** `docker compose version`, `pnpm -v`, `uv --version` all work.

### Phase 1 — Monorepo skeleton

1. Port root tooling from `dirigeo-monorepo`: workspace, turbo, `packages/config`, git hooks, CI (see §4).
2. `apps/web`: `create-next-app` (TS, App Router, no Tailwind) + `sass`; create `src/styles/_tokens.scss`
   (colors, spacing, typography) and use CSS Modules per component. Add Stylelint (`stylelint-config-standard-scss`).
3. `apps/api`: `nest new` → add `@nestjs/typeorm typeorm pg @nestjs/config`. Use one `data-source.ts`
   exported for both the Nest module (`TypeOrmModule.forRootAsync`) and the CLI
   (`typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts`).
4. `apps/rag`: `uv init --package` → `uv add haystack-ai pgvector-haystack ollama-haystack anthropic-haystack fastapi uvicorn[standard] psycopg[binary] pydantic-settings ocrmypdf pypdf`;
   dev deps `ruff pytest pyright`. **Pin exact versions** in `uv.lock`.
5. Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `db:migrate`, `db:migration:generate`, `codegen:rag-client`.
6. `.gitignore`: `data/`, `.env`, `.venv/`, `__pycache__/`, `*.dump`.

**Done when:** `pnpm turbo lint typecheck test build` is green on the empty skeleton (including the Python app via its wrapper scripts).

### Phase 2 — Docker Compose infrastructure

`infra/compose.yml` (abridged — healthchecks + `depends_on: condition: service_healthy` everywhere):

| Service | Image / build | Port (host) | Volumes | Notes |
|---|---|---|---|---|
| `db` | `pgvector/pgvector:pg17` | `127.0.0.1:5432` | `pgdata`, `./postgres/init.sql:/docker-entrypoint-initdb.d/` | healthcheck `pg_isready` |
| `ollama` | `ollama/ollama` | `127.0.0.1:11434` | `ollama` (models) | |
| `ollama-pull` | `ollama/ollama` | — | — | one-shot: `ollama pull bge-m3` against `ollama`, then exits |
| `rag-api` | `infra/docker/rag.Dockerfile` | `127.0.0.1:8000` | `../data:/data` | `uvicorn ffr_rag.api:app` |
| `rag-worker` | same image as `rag-api` | — | `../data:/data` | `python -m ffr_rag.worker` |
| `api` | `infra/docker/api.Dockerfile` | `127.0.0.1:4000` | `../data:/data` | runs `migration:run` on start, then `node dist/main` |
| `web` | `infra/docker/web.Dockerfile` | `127.0.0.1:3000` | — | Next.js `output: 'standalone'` |
| `adminer` (profile `tools`) | `adminer` | `127.0.0.1:8080` | — | `docker compose --profile tools up` |

Dockerfile notes:
- **rag**: `python:3.12-slim` + `apt-get install tesseract-ocr tesseract-ocr-vie ghostscript qpdf unpaper`
  (needed by ocrmypdf) + `uv sync --frozen --no-dev`. Multi-stage so build tools don't ship.
- **api / web**: `node:<lts>-slim`, pnpm `fetch` + `--filter` deploy (`pnpm deploy`) for small images.

`infra/compose.dev.yml` overrides for daily development:
- `web`: `pnpm --filter web dev`, bind-mount source, `WATCHPACK_POLLING=true` if file watching is flaky on macOS/Windows
- `api`: `pnpm --filter api start:dev`, bind-mount source
- `rag-api`: `uvicorn --reload`, bind-mount `apps/rag/src`
- `rag-worker`: bind-mount source; restart manually (`docker compose restart rag-worker`) after changes
- `node_modules` / `.venv` kept in **named volumes**, not bind-mounted from the host

Usage: `make up` → `docker compose -f infra/compose.yml -f infra/compose.dev.yml --env-file .env up -d`.

`infra/postgres/init.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() is STABLE, so it can't be used in an index directly; this wrapper is for a future custom keyword retriever.
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent', $1) $$;
```
(`init.sql` only runs on an empty volume. Mirror it in the first TypeORM migration with `IF NOT EXISTS`, so
the migrations are the source of truth.)

**Done when:**
- `make up` → all services `healthy` in `docker compose ps`
- `docker compose exec db psql -U ffr -c '\dx'` lists `vector`, `unaccent`
- `curl 127.0.0.1:11434/api/embed -d '{"model":"bge-m3","input":"Nuôi cá rô phi trong ao đất"}'` returns 1024 floats

### Phase 3 — Database schema (TypeORM migrations)

App tables (entities in `apps/api`, snake_case naming strategy):

**`sources`** — one row per book / article / social post / note
- `id uuid`, `kind` enum (`book | article | paper | social_post | video | personal_note`)
- `title`, `author`, `publisher`, `published_at`, `url`, `language` (default `vi`)
- `trust_level smallint` 1–4, `trust_note`
- `file_path`, `checksum` (unique → dedupe), `status` enum (`pending | processing | ready | failed`), `error`
- `chunk_count`, `created_at`, `updated_at`

**`ingest_jobs`** — the queue
- `id`, `source_id` FK, `type` (`index | reindex | resync_meta | delete_chunks`)
- `status` (`queued | running | done | failed`), `attempts`, `last_error`, `run_after`, `locked_at`, timestamps
- index on `(status, run_after)`. The worker claims with
  `UPDATE … WHERE id = (SELECT id … WHERE status='queued' AND run_after<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`

**`tags`**, **`source_tags`** — species (`cá tra`, `rô phi`, `tôm thẻ`…), topic (`nước`, `bệnh`, `thức ăn`, `con giống`, `kinh tế`)

**`qa_log`** — `question`, `answer`, `cited` jsonb (chunk ids + source ids), `model`, `tokens_in`, `tokens_out`, `latency_ms`, `rating`, `note`
→ becomes the evaluation set later.

**Trust levels** (shown next to every citation):
| Level | Meaning | Examples |
|---|---|---|
| 1 | Official / academic | Bộ NN&PTNT / Cục Thủy sản guidelines, university textbooks, khuyến nông manuals, peer-reviewed papers |
| 2 | Reputable practitioner | Published farming handbooks, established trade magazines |
| 3 | Verified community | Social posts from people I've checked, or corroborated by a level 1–2 source |
| 4 | Unverified | Captured "for later checking" |

`haystack_chunks` is created by `rag-api` on startup (`create_table=True`), not by TypeORM (§1.3).

**Done when:** a fresh `docker compose down -v && make up` creates every table through migrations plus
`haystack_chunks` through Haystack, and `pnpm db:migration:generate` reports **no changes** (it ignores the
Haystack table).

### Phase 4 — Configuration & secrets

`.env.example` (validated at startup: `@nestjs/config` + zod in `api`, `pydantic-settings` in `rag`):
```dotenv
# Postgres
POSTGRES_USER=ffr
POSTGRES_PASSWORD=change-me
POSTGRES_DB=ffr
DATABASE_URL=postgresql://ffr:change-me@db:5432/ffr
PG_CONN_STR=postgresql://ffr:change-me@db:5432/ffr      # name expected by PgvectorDocumentStore

# Models
OLLAMA_BASE_URL=http://ollama:11434
EMBEDDING_MODEL=bge-m3
EMBEDDING_DIM=1024
ANTHROPIC_API_KEY=
LLM_MODEL=claude-opus-5-5         # see §5 — claude-sonnet-5-5 / claude-haiku-4-5 are cheaper

# Services
RAG_API_URL=http://rag-api:8000
API_URL=http://api:4000            # used server-side by web
NEXT_PUBLIC_API_URL=http://localhost:4000
DATA_DIR=/data
```

- Hostnames are compose service names (`db`, `ollama`, …). When running a service outside Docker, override them with `localhost`.
- **The repo is public.** Never commit `.env` or anything under `data/`. Making the repo private is recommended.
- Every chunk stores `embedding_model` in `meta`, so switching models later means a controlled re-index instead of mixed vector spaces.

**Done when:** each service fails fast with a clear message when a required var is missing.

### Phase 5 — Service shells (end-to-end with no-op logic)

- **rag-api**: `GET /health` (checks DB + Ollama + that the document store opens), `POST /ask` returns a stub answer. OpenAPI at `/openapi.json`.
- **rag-worker**: claim loop (poll every 5 s, exponential backoff, `attempts` ≤ 3). An `index` job runs the
  real indexing pipeline on a plain `.txt` file. This is the first real Haystack run.
- **api**: `GET /health` (DB + rag-api), `POST /sources` (multipart upload with multer → `/data/raw`, sha256
  dedupe, insert source + job), `GET /sources`, `GET /sources/:id`, `POST /ask` (proxy + `qa_log`).
  `pnpm codegen:rag-client` generates the client from `rag-api`'s OpenAPI.
- **web**: layout + SCSS tokens; pages `/` (ask box + answer + sources list), `/sources` (table with status
  polling via React Query `refetchInterval`), `/sources/new` (upload / paste note with trust level + tags).

**Done when:** uploading a `.txt` in the browser ends as `ready` with `chunk_count > 0`, and
`SELECT count(*) FROM haystack_chunks WHERE meta->>'source_id' = '<id>'` matches.

### Phase 6 — Developer workflow, CI, backups

- **Makefile**: `up`, `down`, `logs s=<svc>`, `migrate`, `pull-models`, `psql`, `backup`, `restore f=<file>`.
- **CI** (GitHub Actions): pnpm cache → lint/typecheck/test/build for TS; `uv sync` → `ruff`, `pyright`, `pytest`
  for rag. One job with a `pgvector/pgvector:pg17` service container runs migrations and the job-claim SQL tests.
  **No model calls in CI.** Ollama and Anthropic are mocked behind Haystack component boundaries.
- Optional: build all images in CI (`docker compose build`) to catch Dockerfile breakage.
- **Backups**: `scripts/backup.sh` runs `docker compose exec db pg_dump -Fc` plus a tar of `data/raw` into
  `data/backups/<date>/`. Keep the last N copies. Later, copy them off-machine (external drive or R2/B2, cents/month).
  The DB can always be rebuilt from `data/raw` by re-indexing, but OCR and trust metadata cost time, so back up both.

**Done when:** CI is green on a PR, and `make restore` brings a fresh volume back to the same `sources`/chunk counts.

---

## 4. Reusing `dirigeo-monorepo`

⚠️ This session still can't access `dirigeo-monorepo`. My GitHub credential can't see it under
`peter-955`, so it probably lives under another owner/org, or the Claude GitHub App isn't installed there.

Expected to carry over: root workspace/turbo config, `packages/config` (tsconfig/eslint/prettier), git hooks,
CI workflow, Next.js app conventions (SCSS structure, React Query provider, API client pattern, env validation),
and any NestJS/TypeORM module patterns or Dockerfiles it already has.
Drop: product-specific apps/packages, auth, analytics, cloud deploy targets.

Once I can read it, this section becomes an exact copy list, and §1.4 (NestJS vs Next-only TypeORM) can follow
whatever dirigeo already does.

---

## 5. Cost estimate (personal use)

Embeddings, OCR and hosting are local → **$0**. Only answer generation costs money.

Assume 20 questions/day × ~8k input tokens (retrieved chunks + prompt) and ~800 output tokens
→ ≈ 4.8 M input + 0.5 M output tokens/month.

| `LLM_MODEL` | Price in/out per 1M tok | ≈ Monthly |
|---|---|---|
| `claude-opus-5-5` | $4 / $20 | ≈ $29 |
| `claude-sonnet-5-5` | $2 / $10 | ≈ $15 |
| `claude-haiku-4-5` | $1 / $5 | ≈ $7 |

Set a hard monthly spend limit in the Anthropic console. `qa_log.tokens_in/out` tracks the real usage.

---

## 6. Risks & open questions

| # | Item | Proposed handling |
|---|---|---|
| 1 | Access to `dirigeo-monorepo` | Grant access / tell me its `owner/repo` |
| 2 | Two languages (TS + Python) | Strict boundary: Python only talks to Postgres, Ollama, Claude; TS talks to Python only via generated OpenAPI client |
| 3 | `pgvector-haystack` owns chunk table schema | Pin version; read-only TypeORM entity; review DDL on upgrade |
| 4 | Keyword search without accent folding | Accept for v1; custom retriever with `f_unaccent` if needed |
| 5 | OCR quality on old Vietnamese prints | Test 2–3 real books early; Claude vision fallback for low-confidence pages |
| 6 | Copyright of library material | Personal use; raw files never in git; private repo recommended |
| 7 | Social-media misinformation | Trust levels in chunk meta + mandatory citations + warning when only level 3–4 support a claim |
| 8 | Data loss over a multi-year horizon | Backups from Phase 6, copied off-machine |

Questions for you:
1. Where does `dirigeo-monorepo` live? Does it already use NestJS + TypeORM?
2. Is NestJS for the API OK (recommended), or do you want Next.js route handlers + TypeORM to save a service?
3. Host OS: macOS / Windows (WSL2) / Linux? This decides whether Ollama runs in Docker or natively.
4. Should the default answer model be Opus 5.5, or start cheaper with Sonnet 5.5 / Haiku 4.5?
