# Fish Farm RAG — Environment Setup Plan

> Goal: a small, cheap, personal RAG system that lets me ask questions (in Vietnamese)
> over a **trusted** aquaculture knowledge base — scanned/printed books from the local
> library, articles, and short notes captured from social networks — and always get
> answers **with citations back to the source and its trust level**.
>
> Non-goals for now: low latency, multi-user, horizontal scale.

Status: **draft v3**
- Stack: Haystack + NestJS/TypeORM + Next.js/SCSS.
- Hosting: a **Mac mini (M1, 16 GB)** running Docker containers.
- Cost: **near-zero running cost** (local LLM by default, Claude only on demand).
- Tooling: our own, no dependency on `dirigeo-monorepo`.

Scope of this doc: environment + skeleton only (no real RAG logic yet).

---

## 0. Guiding decisions (TL;DR)

| Concern | Decision | Why |
|---|---|---|
| RAG framework | **Haystack 2.x** in a **Python** service (`apps/rag`), FastAPI + worker | Haystack is Python-only; ships pgvector, Ollama, Anthropic integrations |
| App API | **NestJS + TypeORM** (`apps/api`) | TypeORM first-class; `@Sse()` for streaming chat |
| Frontend | **Next.js + SCSS** modules + React Query (`apps/web`) | Your stack |
| Chat transport | **SSE end-to-end**: rag-api → Nest → browser `EventSource` | Token streaming; simple, HTTP-only, auto-reconnect |
| Entry point | **Caddy** reverse proxy: `/api/*` → Nest, rest → Next | One origin (no CORS); Caddy doesn't buffer SSE |
| Database | Postgres 17 + `pgvector` + `unaccent` (container) | Vectors, metadata, FTS, job queue in one place |
| Schema ownership | TypeORM migrations → app tables; Haystack `PgvectorDocumentStore` → chunk table | Each tool owns what it understands |
| Job queue | `ingest_jobs` table + Python worker `FOR UPDATE SKIP LOCKED` | No Redis |
| **LLM runtime** | **Ollama native on macOS** (not in Docker) | Docker on macOS can't use the Apple GPU; native Ollama uses Metal → 5–10× faster |
| Embeddings | `bge-m3` via native Ollama | $0, multilingual, good Vietnamese |
| **Answer generation** | **Local model by default** (Ollama) + **"Hỏi Claude" on demand** with `claude-haiku-4-5` under a monthly budget cap | ~$0–2/month (see §5) |
| OCR | `ocrmypdf` + Tesseract `vie` inside the rag image | Free |
| Container runtime | **OrbStack** (recommended) or Docker Desktop | OrbStack is lighter on RAM/CPU and faster on Mac, free for personal use |
| Remote access | **Tailscale** (free) → `tailscale serve` to Caddy | Use it from your phone at the farm; no ports opened on the router |

---

## 1. Architecture

```
                      ┌────────────────────────── Mac mini (macOS) ──────────────────────────────────┐
 Phone / laptop       │                                                                             │
 (Tailscale) ──https──┼─▶ tailscale serve ─▶ ┌───────── Docker (OrbStack) ───────────────────────┐ │
 Browser on Mac ──────┼─▶ 127.0.0.1:8080 ──▶ │ caddy ─┬─ /api/* ─▶ api (NestJS+TypeORM) ──┐      │ │
                      │                      │        └─ /*     ─▶ web (Next.js+SCSS)     │      │ │
                      │                      │                                            │ SSE  │ │
                      │                      │  rag-api (FastAPI+Haystack) ◀──────────────┘      │ │
                      │                      │  rag-worker (Haystack indexing, OCR)              │ │
                      │                      │  db (Postgres 17 + pgvector)                      │ │
                      │                      └───────────────┬───────────────────────────────────┘ │
                      │                                      │ http://host.docker.internal:11434    │
                      │                      ┌───────────────▼────────────┐                         │
                      │                      │ Ollama (native, Metal GPU) │  bge-m3 + local chat LLM│
                      │                      └────────────────────────────┘                         │
                      └───────────────────────────────────────────────┬─────────────────────────────┘
                                                                      │ only when "Hỏi Claude" is used
                                                                      ▼
                                                             Anthropic API (Haiku 4.5)
```

**Ingestion:** upload in `web` → `api` stores file in `/data/raw/<sha256>.<ext>`, inserts `sources` (`pending`)
\+ `ingest_jobs` row → `rag-worker` claims job → OCR if scanned → Haystack indexing pipeline → chunks in
`haystack_chunks` with `meta.source_id` → `sources.status = ready`.

### 1.1 Chat over SSE

```
web                            api (NestJS)                              rag-api (FastAPI)
 │ POST /api/chat/messages      │                                          │
 │ {question, mode, filters} ──▶│ insert qa_log (pending) → {id}           │
 │◀──────────── {id} ───────────│                                          │
 │ EventSource GET              │                                          │
 │ /api/chat/messages/:id/stream▶│ @Sse(): POST /ask/stream (fetch, ────────▶│ retrieve (hybrid)
 │                              │   AbortController)                       │ event: sources
 │◀── event: sources ───────────│◀─────────────────────────────────────────│ generate (stream)
 │◀── event: token (×n) ────────│◀─────────────────────────────────────────│ event: token …
 │◀── event: done {usage} ──────│ update qa_log (answer, cited, tokens,    │ event: done
 │                              │   cost) ◀────────────────────────────────│
```
- Two steps (POST, then GET stream): `@Sse()` and `EventSource` are GET-only. This also keeps the question
  body out of the URL, and you get reconnect for free.
- Events: `sources` (sent **before** generation, so citations + trust levels show immediately), `token`,
  `done` (model, tokens, cost), `error`. Nest adds a heartbeat comment every 15 s.
- Client disconnects → Nest aborts the upstream fetch → rag-api cancels generation, so you never pay for
  tokens nobody reads.
- In rag-api, **retrieval and generation are separate steps**: a Haystack retrieval pipeline returns
  documents, then the chosen generator streams through `streaming_callback` into an asyncio queue → FastAPI
  `StreamingResponse`. `mode` (`local` | `claude`) only swaps the generator, so retrieval is identical and
  the two modes can be compared fairly.

### 1.2 Haystack pipelines (skeleton targets)

Indexing (`rag-worker`):
```
FileTypeRouter → PyPDFToDocument / TextFileToDocument (after ocrmypdf for scans)
  → DocumentCleaner → (custom) VietnameseNormalizer [Unicode NFC, OCR line-break/hyphen fixes]
  → RecursiveDocumentSplitter (~500–700 tokens, ~10% overlap)
  → OllamaDocumentEmbedder(model="bge-m3")
  → DocumentWriter(PgvectorDocumentStore, policy=OVERWRITE)
```
Retrieval (`rag-api`):
```
OllamaTextEmbedder ─▶ PgvectorEmbeddingRetriever(top_k=8) ─┐
query ──────────────▶ PgvectorKeywordRetriever(top_k=8) ───┴▶ DocumentJoiner(reciprocal_rank_fusion, top_k=5)
```
Generation (streamed; one of):
- `OllamaChatGenerator(model=$LOCAL_CHAT_MODEL)` — default, free
- `AnthropicChatGenerator(model=$CLAUDE_MODEL)` — "Hỏi Claude", budget-guarded

Both get the same Vietnamese `ChatPromptBuilder` template:
- answer only from the numbered sources `[1]..[n]`, citing them
- say "không đủ thông tin" when the sources don't cover it
- warn when only trust level 3–4 sources support a claim

Notes:
- Avoid NLTK sentence splitting because its models don't cover Vietnamese.
- Keep **top 5 chunks** in the prompt. This controls both local speed and Claude cost.

### 1.3 Chunk table & schema ownership

- `PgvectorDocumentStore(table_name="haystack_chunks", embedding_dimension=1024, vector_function="cosine_similarity", search_strategy="hnsw", language="simple", create_table=True)`.
- `meta` per chunk: `source_id`, `page_from`, `page_to`, `heading_path`, `trust_level`, `tags`,
  `embedding_model`. Haystack filters on these handle "only trust ≤ 2" and "only cá tra".
- TypeORM runs all DDL for **app** tables (`synchronize: false`, explicit migrations). `apps/api` reads chunks
  via `@Entity({ name: 'haystack_chunks', synchronize: false })`, and never writes them.
- Python touches app tables only via a few plain `psycopg` statements in `ffr_rag/db.py` (claim job, update
  job/source status).
- Pin the `pgvector-haystack` version, because it defines the chunk table DDL and the keyword query.
- Known v1 limitation: keyword search doesn't fold accents. `cá rô phi` matches; `ca ro phi` relies on
  vectors. A custom retriever using `f_unaccent` can fix this later.

---

## 2. Repository layout

```
fish-farm-rag/
├─ apps/
│  ├─ web/                    # Next.js (App Router, output: 'standalone'), SCSS modules, React Query
│  │  └─ src/styles/          # _tokens.scss, _mixins.scss, globals.scss
│  ├─ api/                    # NestJS + TypeORM, global prefix /api
│  │  └─ src/
│  │     ├─ database/         # data-source.ts (shared by app + CLI), migrations/
│  │     ├─ sources/          # upload, list, status
│  │     ├─ ingest-jobs/
│  │     ├─ chat/             # POST message, @Sse stream proxy, budget guard
│  │     └─ rag-client/       # generated from rag-api OpenAPI
│  └─ rag/                    # Python 3.12, uv
│     ├─ pyproject.toml / uv.lock
│     └─ src/ffr_rag/
│        ├─ api.py            # FastAPI: /health, /ask/stream (SSE)
│        ├─ worker.py         # job loop
│        ├─ pipelines/        # indexing.py, retrieval.py, generators.py
│        ├─ components/       # VietnameseNormalizer, (later) UnaccentKeywordRetriever
│        ├─ db.py             # psycopg SQL for jobs/status
│        └─ settings.py       # pydantic-settings
├─ packages/
│  └─ config/                 # tsconfig bases, eslint flat config, prettier
├─ infra/
│  ├─ compose.yml             # prod-like (what the Mac mini runs)
│  ├─ compose.dev.yml         # dev overrides: bind mounts + hot reload
│  ├─ caddy/Caddyfile
│  ├─ postgres/init.sql
│  ├─ docker/                 # web / api / rag Dockerfiles (multi-stage)
│  └─ macos/                  # launchd plist for nightly backup, setup notes
├─ scripts/                   # backup.sh, restore.sh, bulk-import, update.sh
├─ data/                      # ⛔ gitignored, bind-mounted: raw/, ocr/, backups/
├─ docs/
├─ .env.example
└─ Makefile
```

---

## 3. Phase-by-phase setup

Each phase ends with a **done when** check. Do them in order; each is roughly an evening.

### Phase 0 — Mac mini host preparation

**Install**
- Homebrew
- `brew install --cask orbstack`, or Docker Desktop
- `brew install ollama git make`
- `brew install --cask tailscale`
- Node LTS + pnpm (`corepack enable`) and Python 3.12 + `uv`. These are only needed if you also develop on the Mac mini.

**Ollama (native)**
```bash
brew services start ollama            # launchd → starts on boot
ollama pull bge-m3                    # embeddings (~1.2 GB)
ollama pull <local chat model>        # see §5 for choosing by RAM
```
Ollama env, set via `launchctl setenv` or the brew service plist. The full list and the reasoning for M1 16 GB are in §5.3:
- `OLLAMA_FLASH_ATTENTION=1`
- `OLLAMA_KV_CACHE_TYPE=q8_0`
- `OLLAMA_MAX_LOADED_MODELS=2` keeps embedding + chat loaded together.
- `OLLAMA_NUM_PARALLEL=1`
- `OLLAMA_KEEP_ALIVE=15m` unloads models when idle, which frees RAM.

Containers reach it at `http://host.docker.internal:11434`. Both OrbStack and Docker Desktop route this to the
host's loopback, so Ollama stays bound to `127.0.0.1`.

**macOS settings for a home server**
- Energy: *Prevent automatic sleeping*, *Start up automatically after a power failure*, *Wake for network access*.
- Users & Groups: automatic login for the server user, so OrbStack/Docker and Ollama start after a reboot.
- OrbStack/Docker: *Start at login*. **Memory limit 4 GB.** The LLM runs outside the VM and needs the rest (§5.3).
- FileVault: if it's on, an unattended reboot after power loss waits at the unlock screen. Accept that, or turn it off on this machine.

**Tailscale:** sign in. After Phase 2: `tailscale serve --bg 8080` → `https://<mac-mini>.<tailnet>.ts.net`
from your phone. Nothing is exposed to the public internet.

**Done when:** after a reboot with nobody touching the machine:
- `curl 127.0.0.1:11434/api/tags` lists the models
- `docker info` works

### Phase 1 — Monorepo skeleton (own tooling)

1. Root: `pnpm-workspace.yaml` (`apps/web`, `apps/api`, `packages/*`), `turbo.json`, `packageManager` pin,
   `.nvmrc`, `.editorconfig`.
2. `packages/config`: `tsconfig.base.json` (strict), ESLint flat config (typescript-eslint, react, next),
   Prettier, Stylelint (`stylelint-config-standard-scss`).
3. Git hooks: husky + lint-staged (eslint/prettier/stylelint on TS/SCSS, `ruff` on Python).
4. `apps/web`: `create-next-app` (TS, App Router, no Tailwind) + `sass`, `@tanstack/react-query`. SCSS tokens
   in `src/styles/_tokens.scss` and CSS Modules per component. Set `output: 'standalone'`.
5. `apps/api`: `nest new` + `@nestjs/typeorm typeorm pg @nestjs/config zod`. One `data-source.ts` used by
   `TypeOrmModule.forRootAsync` and by the migrations CLI. Global prefix `api`.
6. `apps/rag`:
   - `uv init --package`
   - `uv add haystack-ai pgvector-haystack ollama-haystack anthropic-haystack fastapi "uvicorn[standard]" "psycopg[binary]" pydantic-settings ocrmypdf pypdf`
   - dev deps: `ruff pyright pytest`
   - Add a tiny `package.json` with `lint`/`test` scripts that call `uv run …`, so Turbo covers it.
7. Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `db:migrate`, `db:migration:generate`, `codegen:rag-client`.
8. `.gitignore`: `data/`, `.env`, `.venv/`, `__pycache__/`, `node_modules/`, `.next/`, `dist/`, `*.dump`.

**Done when:** `pnpm turbo lint typecheck test build` is green on the empty skeleton.

### Phase 2 — Docker Compose

`infra/compose.yml`. All services use `restart: unless-stopped`, healthchecks, and `depends_on: condition: service_healthy`.
Each service also gets a `mem_limit`, which must fit the 4 GB VM:

| Service | `mem_limit` |
|---|---|
| `db` | 512m |
| `rag-worker` | 1g (OCR bursts) |
| `rag-api` | 512m |
| `api` | 256m |
| `web` | 256m |
| `caddy` | 64m |

| Service | Image / build | Host port | Volumes | Notes |
|---|---|---|---|---|
| `caddy` | `caddy:2-alpine` | `127.0.0.1:8080` | `./caddy/Caddyfile`, `caddy_data` | single entry point |
| `web` | `docker/web.Dockerfile` | — | — | Next standalone server |
| `api` | `docker/api.Dockerfile` | — | `../data:/data` | runs `migration:run`, then `node dist/main` |
| `rag-api` | `docker/rag.Dockerfile` | — | `../data:/data` | `uvicorn ffr_rag.api:app` |
| `rag-worker` | same image | — | `../data:/data` | `python -m ffr_rag.worker` |
| `db` | `pgvector/pgvector:pg17` | `127.0.0.1:5432` (dev convenience) | `pgdata` (named volume), `./postgres/init.sql` | `pg_isready` |
| `adminer` (profile `tools`) | `adminer` | `127.0.0.1:8081` | — | only when needed |

- `rag-api`, `rag-worker` and `api` set `extra_hosts: ["host.docker.internal:host-gateway"]`. It's harmless on OrbStack/Docker Desktop and keeps Linux working too.
- Postgres data stays in a **named volume** (bind-mounting PG data on macOS is slow and has permission quirks).
  Backups go to `./data/backups` (Phase 6), which Time Machine can cover.

`infra/caddy/Caddyfile`:
```
:8080 {
  handle /api/* {
    reverse_proxy api:4000 {
      flush_interval -1        # stream SSE immediately
    }
  }
  handle {
    reverse_proxy web:3000
  }
}
```

Dockerfiles:
- **rag**: `python:3.12-slim` + `apt-get install tesseract-ocr tesseract-ocr-vie ghostscript qpdf unpaper` + `uv sync --frozen --no-dev`, multi-stage.
- **api / web**: `node:<lts>-slim`, `pnpm fetch` + `pnpm deploy --filter <app>` for small images.
- All images build natively for **arm64** (Apple Silicon). Don't pin `platform: linux/amd64` anywhere.

`infra/compose.dev.yml` (for development; the Mac mini itself runs only `compose.yml`):
- `web`: `pnpm --filter web dev`, with source bind-mounted.
- `api`: `start:dev`.
- `rag-api`: `uvicorn --reload`.
- `node_modules` and `.venv` live in named volumes.

`init.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent', $1) $$;
```
(Mirrored in the first TypeORM migration with `IF NOT EXISTS`, so the migrations stay the source of truth.)

**Done when:**
- `make up` → everything is `healthy`
- `http://127.0.0.1:8080` shows the Next page and `/api/health` returns OK, including the `rag-api` → Ollama check
- `docker compose exec rag-api curl -s host.docker.internal:11434/api/tags` lists the models

### Phase 3 — Database schema (TypeORM migrations)

**`sources`**
- `id uuid`, `kind` (`book | article | paper | social_post | video | personal_note`)
- `title`, `author`, `publisher`, `published_at`, `url`, `language` (default `vi`)
- `trust_level smallint` 1–4, `trust_note`
- `file_path`, `checksum` (unique), `status` (`pending | processing | ready | failed`), `error`
- `chunk_count`, timestamps

**`ingest_jobs`**
- `id`, `source_id`, `type` (`index | reindex | resync_meta | delete_chunks`)
- `status` (`queued | running | done | failed`), `attempts`, `last_error`, `run_after`, `locked_at`, timestamps
- index `(status, run_after)`

**`tags`**, **`source_tags`**: species (`cá tra`, `rô phi`, `tôm thẻ`…) and topic (`nước`, `bệnh`, `thức ăn`, `con giống`, `kinh tế`).

**`qa_log`**
- `id`, `question`, `filters` jsonb, `mode` (`local | claude`), `model`, `answer`, `cited` jsonb
- `status` (`pending | streaming | done | error | aborted`)
- `tokens_in`, `tokens_out`, **`cost_usd numeric(10,5)`**, `latency_ms`, `rating`, `note`, timestamps
- Two purposes: the budget guard sums `cost_usd` for the current month, and the table becomes the eval set later.

**Trust levels**
| Level | Meaning | Examples |
|---|---|---|
| 1 | Official / academic | Bộ NN&PTNT / Cục Thủy sản guidelines, university textbooks, khuyến nông manuals, papers |
| 2 | Reputable practitioner | Published farming handbooks, trade magazines |
| 3 | Verified community | Posts from people I've checked, or corroborated by level 1–2 |
| 4 | Unverified | Captured "for later checking" |

**Done when:**
- `docker compose down -v && make up` recreates all tables (and `haystack_chunks` via rag-api)
- `pnpm db:migration:generate` reports no changes

### Phase 4 — Configuration & secrets

`.env.example` (validated at startup: zod in `api`, `pydantic-settings` in `rag`):
```dotenv
# Postgres
POSTGRES_USER=ffr
POSTGRES_PASSWORD=change-me
POSTGRES_DB=ffr
DATABASE_URL=postgresql://ffr:change-me@db:5432/ffr
PG_CONN_STR=postgresql://ffr:change-me@db:5432/ffr        # name read by PgvectorDocumentStore

# Ollama (native on the Mac mini)
OLLAMA_BASE_URL=http://host.docker.internal:11434
EMBEDDING_MODEL=bge-m3
EMBEDDING_DIM=1024
LOCAL_CHAT_MODEL=                                          # chosen in the Phase 5 bake-off, see §5

# Claude (optional, on demand)
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-haiku-4-5
MONTHLY_LLM_BUDGET_USD=3                                   # api refuses mode=claude above this

# Retrieval
RETRIEVAL_TOP_K=5

# Services
RAG_API_URL=http://rag-api:8000
DATA_DIR=/data
```
- `.env` is never committed, and neither is anything in `data/`.
- Leaving `ANTHROPIC_API_KEY` empty is valid: the app runs fully local and hides the "Hỏi Claude" button.

**Done when:** each service fails fast on a missing required var, and the app boots with no Anthropic key.

### Phase 5 — Service shells + local model bake-off

- **rag-api**: `/health`; `/ask/stream` streams a stub, then real retrieval plus the local generator. Exposes OpenAPI.
- **rag-worker**: claim loop (5 s poll, backoff, ≤ 3 attempts); indexes a `.txt` end-to-end.
- **api**:
  - `/api/health`
  - `POST /api/sources` (multer → `/data/raw`, sha256 dedupe, plus a job)
  - `GET /api/sources[/:id]`
  - `POST /api/chat/messages`, then `@Sse() GET /api/chat/messages/:id/stream` (budget guard checked on POST)
- **web**:
  - `/`: chat with streamed answer, source cards with trust badges, and a "Hỏi Claude" button
  - `/sources`: status polling
  - `/sources/new`: upload, or paste a note with URL + trust level + tags
- **Bake-off:**
  1. Write 15–20 real questions after indexing a couple of books.
  2. Run them through 2–3 candidate local models, plus `claude-haiku-4-5` as a reference.
  3. Score each answer: correct, cites the right source, Vietnamese reads naturally, admits when info is missing.
  4. Pick `LOCAL_CHAT_MODEL`.

**Done when:**
- An uploaded `.txt` becomes `ready`.
- A question streams tokens into the browser through Caddy → Nest → rag-api.
- Closing the tab mid-answer marks the `qa_log` row `aborted`.

### Phase 6 — Operations, CI, backups

- **Makefile**: `up`, `down`, `logs s=<svc>`, `migrate`, `psql`, `backup`, `restore f=<file>`, `update`
  (`git pull && docker compose build && docker compose up -d`).
- **Backups**:
  1. A nightly launchd job (`infra/macos/com.ffr.backup.plist`) runs `scripts/backup.sh`.
  2. The script runs `pg_dump -Fc` inside the `db` container and tars `data/raw`, writing both into `data/backups/<date>/`. It keeps 14 days.
  3. **Time Machine** to an external disk covers the repo folder, including `data/`.
  4. Named Docker volumes live inside the VM and Time Machine can't see them. That's why the dumps matter.
- **CI** (GitHub Actions, free on private repos within limits):
  - TS: lint, typecheck, test, build.
  - Python: `ruff`, `pyright`, `pytest`.
  - A job with a `pgvector/pgvector:pg17` service container runs migrations plus job-claim tests.
  - No model calls in CI.
- **Monitoring (lightweight)**: `/api/health` with OrbStack/Docker restart policies is enough. Optional: a
  free uptime ping via Tailscale from your phone.

**Done when:**
- CI is green.
- A reboot brings everything back unattended.
- `make restore` on a fresh volume reproduces the same `sources` and chunk counts.

---

## 4. Repository housekeeping

- **Make the repo private**: GitHub → Settings → General → Danger Zone → *Change visibility*. My tools in this
  session can't change repo settings, so this has to be done by you.
- `dirigeo-monorepo` is not needed. Phase 1 defines our own tooling.

---

## 5. Cost optimisation

Fixed costs: **$0**. You already own the Mac mini. Electricity at ~5–15 W average is a few kWh/month.
Embeddings and OCR run locally. Tailscale and GitHub private repos are free for this use.

The only variable cost is Claude, and it is opt-in per question.

### 5.1 Levers (applied in this plan)

| Lever | Effect |
|---|---|
| **Local LLM by default** (native Ollama on Metal) | Most questions cost $0 |
| **Claude only on demand** ("Hỏi Claude" button), `claude-haiku-4-5` | Cheapest current Claude model ($1 / $5 per 1M tokens in/out) |
| **Lean context**: top 5 chunks × ~600 tokens, short system prompt | ~3.5k input tokens per question instead of ~8k |
| **Cap answer length** (`max_tokens` ≈ 800, prompt asks for concise answers) | Bounds output cost |
| **Monthly budget guard** (`MONTHLY_LLM_BUDGET_USD`, summed from `qa_log.cost_usd`) + spend limit in the Anthropic console | Can't overspend, even by accident |
| **Abort on disconnect** | No paying for unread tokens |
| **Answer reuse**: identical normalised question + same filters within N days → reuse `qa_log` answer | Repeat questions free |
| **Batch API (50% off)** for non-interactive Claude work later (e.g. auto-tagging, OCR clean-up of bad pages) | Halves offline costs |

### 5.2 Expected spend

Per Claude question at ~3.5k input + ~600 output tokens:

| Model | Per question | 100 Claude questions / month | 600 / month (everything via Claude) |
|---|---|---|---|
| `claude-haiku-4-5` | ≈ $0.0065 | ≈ **$0.65** | ≈ $3.90 |
| `claude-sonnet-5-5` | ≈ $0.013 | ≈ $1.30 | ≈ $7.80 |

With local-first plus a budget of $3, the expected bill is **~$0–2/month**. Haiku 4.5 is the default for
"Hỏi Claude". Switching `CLAUDE_MODEL` to Sonnet 5.5 for harder questions is a one-line change.

### 5.3 Local model on the target machine: Mac mini M1, 16 GB

**Memory budget** (unified memory is shared by CPU and GPU):

| Consumer | ≈ RAM |
|---|---|
| macOS + background apps | 3.5–4 GB |
| OrbStack VM: all containers (Postgres ~0.3, rag-api + rag-worker ~1, api ~0.15, web ~0.15, caddy, OCR bursts) | capped at **4 GB** |
| Ollama: `bge-m3` (embeddings) | ~1.2 GB |
| Ollama: chat model 7–9B @ Q4_K_M | ~4.5–5.5 GB |
| Ollama: KV cache for `num_ctx` 6144 (q8_0) | ~0.5 GB |
| **Total** | **~14–15 GB** → workable, but no room for a bigger model or for dev tooling on this machine |

**Decisions that follow:**
- **Chat model size: 7–9B, Q4_K_M.** A 12B+ model will push the machine into swap. Bake-off candidates:
  the current Qwen ~8B instruct, the current Gemma in the 4B / ≤9B range, and a Vietnamese-tuned 7B if
  one is on Ollama. Pick by the Phase 5 test.
- **Ollama settings** (`launchctl setenv …`, then restart the service):
  - `OLLAMA_FLASH_ATTENTION=1`
  - `OLLAMA_KV_CACHE_TYPE=q8_0` (halves KV-cache memory)
  - `OLLAMA_MAX_LOADED_MODELS=2`
  - `OLLAMA_NUM_PARALLEL=1`
  - `OLLAMA_KEEP_ALIVE=15m`
- **Context:** `num_ctx = 6144`. Budget: top 5 chunks × ~600 tokens + ~500 system/prompt + ≤ 800 answer ≈ 4.3k.
- **OrbStack:** memory limit 4 GB; per-service `mem_limit` in compose so one runaway service can't starve Ollama.
- **Don't develop on the Mac mini.** It runs only `compose.yml` (built images). `next dev`, `nest --watch`,
  IDEs and `compose.dev.yml` stay on your laptop.
- **Ingestion runs one job at a time**: worker concurrency 1, `ocrmypdf --jobs 2`. Bulk imports of whole books go
  overnight. Chatting during a bulk import works but is slower.

**Expected speed** (rough; measure in Phase 5):

| Step | M1 estimate | Comment |
|---|---|---|
| OCR (Tesseract, container) | ~3–6 s/page → 300-page book ≈ 15–30 min | overnight batch |
| Embedding (bge-m3, Metal) | 300-page book (~600 chunks) ≈ a few minutes | fine |
| Answer: time to first token | ~10–30 s (processing ~4k prompt tokens) | the `sources` SSE event arrives first, so the UI isn't blank |
| Answer: generation | ~12–20 tokens/s | a 400-token answer streams in ~20–30 s |

If time-to-first-token feels too slow:
1. Drop to top 4 × 500-token chunks.
2. Try a 4B model, if its Vietnamese still passes the bake-off.
3. Use "Hỏi Claude" for that question (answers in a few seconds, ≈ $0.0065).

**Upgrade path:** if you replace the Mac mini later, 24 GB+ allows a 12–14B model. Only `LOCAL_CHAT_MODEL`
changes; nothing else in the architecture does.

---

## 6. Risks & open questions

| # | Item | Proposed handling |
|---|---|---|
| 1 | Local model weaker than Claude on synthesis / Vietnamese nuance | Strict "answer only from sources" prompt + citations; bake-off; "Hỏi Claude" for hard questions |
| 2 | Two languages (TS + Python) | Python talks only to Postgres, Ollama, Claude; TS ↔ Python only via generated OpenAPI client |
| 3 | `pgvector-haystack` owns chunk-table schema | Pin version; read-only TypeORM entity; review DDL on upgrade |
| 4 | Keyword search without accent folding | Accept in v1; custom `f_unaccent` retriever if needed |
| 5 | OCR quality on old Vietnamese prints | Test 2–3 real books early; manual re-scan of bad pages; Claude Batch OCR only if needed |
| 6 | Mac mini power loss / sleep / FileVault | Phase 0 energy settings; auto-login; restart policies |
| 7 | Copyright of library material | Personal use; raw files never in git; private repo |
| 8 | Social-media misinformation | Trust levels in chunk meta + citations + low-trust warning |
| 9 | Data loss over years | Nightly dumps + Time Machine; optionally a second off-site copy later |

| 10 | M1 16 GB memory pressure (swap → very slow answers) | 7–9B Q4 model, KV cache q8_0, 4 GB VM cap, per-service `mem_limit`, no dev tooling on the mini; watch *Memory Pressure* in Activity Monitor and `ollama ps` |

All open questions are resolved. Target machine: **Mac mini M1, 16 GB**. Next step: Phase 1.
