# Fish Farm RAG — Environment Setup Plan

> Goal: a small, cheap, personal RAG system that lets me ask questions (in Vietnamese)
> over a **trusted** aquaculture knowledge base — scanned/printed books from the local
> library, articles, and short notes captured from social networks — and always get
> answers **with citations back to the source and its trust level**.
>
> Non-goals for now: low latency, multi-user, horizontal scale.

Status: **draft v1** · Scope of this doc: environment + skeleton only (no RAG logic yet).

---

## 0. Guiding decisions (TL;DR)

| Concern | Decision | Why |
|---|---|---|
| Repo shape | pnpm + Turborepo monorepo, TypeScript end-to-end | Reuse `dirigeo-monorepo` setup; one language for web, worker, and shared code |
| Web app | Next.js (App Router) — chat, upload, library browser, quick-capture | Existing stack; Route Handlers cover the API, no separate backend needed |
| Database | **One Postgres** with `pgvector` + `unaccent` | Vectors, metadata, full-text, and job queue in one cheap box |
| ORM | Drizzle (or whatever dirigeo uses — keep consistent) | Typed schema, plain SQL escape hatch for vector/FTS queries |
| Job queue | `pg-boss` (Postgres-backed) | No Redis to run/pay for; ingestion is slow & batchy anyway |
| Embeddings | **`bge-m3` via Ollama, local** (1024-dim, multilingual, good Vietnamese) | $0 per token; CPU is fine because speed doesn't matter |
| Keyword search | Postgres FTS, `simple` config over `unaccent(content)` | No built-in Vietnamese stemmer; unaccent lets `ca ro phi` match `cá rô phi` |
| Retrieval | Hybrid (vector + FTS) merged with Reciprocal Rank Fusion; reranker later | Vietnamese technical terms + species names benefit a lot from lexical match |
| Generation | Claude API via `@anthropic-ai/sdk`, model set by env var | Strong Vietnamese, native citations support; swap model without code change |
| OCR | `ocrmypdf` + Tesseract `vie` in Docker; Claude vision as fallback for bad pages | Free for clean scans; pay only for pages Tesseract butchers |
| Hosting (phase 1) | Local machine via Docker Compose | $0; move to a small VPS only when needed |

---

## 1. Reusing `dirigeo-monorepo`

⚠️ **Blocker:** this session could not access `dirigeo-monorepo` (not in the list of repos my GitHub
credential can see — it may live under another owner/org, or the Claude GitHub App isn't installed there).
The structure below is therefore **assumed**; once access is granted, step 1.2 becomes a concrete diff.

### 1.1 What to carry over (expected)
- Root tooling: `package.json` (workspaces/scripts), `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`/`engines`
- Shared configs: `packages/config` (or equivalent) — `tsconfig` bases, ESLint, Prettier
- Git hygiene: `.editorconfig`, `.gitignore`, commit hooks (husky/lefthook + lint-staged), commitlint if used
- CI: GitHub Actions workflow for install → lint → typecheck → test → build
- Next.js app conventions: folder structure, SCSS setup, React Query provider, API client pattern, env validation (zod/t3-env)
- Docker Compose patterns, if any

### 1.2 What to drop
- Product-specific apps/packages, auth providers, analytics, deploy targets (Vercel/etc.), domain code
- Any paid services not needed for a single-user tool

### 1.3 Procedure
1. Copy the root tooling + `packages/config` into this repo (no git history needed — fresh start is cleaner).
2. Rename package scope to `@ffr/*` (fish-farm-rag).
3. Scaffold apps/packages from section 2 using dirigeo's Next.js app as the template for `apps/web`.
4. `pnpm install && pnpm turbo lint typecheck build` must pass on an empty skeleton before adding anything.

---

## 2. Target repository layout

```
fish-farm-rag/
├─ apps/
│  ├─ web/                 # Next.js: chat UI, source library, upload, quick-capture, API route handlers
│  └─ worker/              # Node process: pg-boss consumers for the ingestion pipeline
├─ packages/
│  ├─ config/              # tsconfig / eslint / prettier (from dirigeo)
│  ├─ db/                  # Drizzle schema, migrations, SQL helpers (hybrid search query lives here)
│  ├─ core/                # Shared types + zod schemas (Source, Chunk, TrustLevel, job payloads)
│  ├─ ingest/              # Extract → clean → chunk → embed (pure functions, used by worker)
│  └─ rag/                 # Retrieve → build prompt → call Claude → map citations
├─ infra/
│  ├─ docker-compose.yml   # postgres+pgvector, ollama, (optional) adminer
│  ├─ postgres/init.sql    # CREATE EXTENSION vector, unaccent, pg_trgm; immutable unaccent wrapper
│  └─ ocr/                 # ocrmypdf invocation notes / Dockerfile if customised
├─ scripts/                # one-off CLIs: bulk import a folder, re-embed, backup
├─ data/                   # ⛔ gitignored: raw PDFs/images, OCR output, backups
├─ docs/
└─ .env.example
```

Why `ingest` and `rag` are packages and not inside the apps: both the worker and CLI scripts need
ingestion, and both the web app and a future eval script need retrieval. Keeping them as pure-ish
packages also makes them unit-testable without Next.js.

---

## 3. Phase-by-phase setup

Each phase ends with a **done when** check. Do them in order; each is roughly an evening.

### Phase 0 — Prerequisites on the dev machine

| Tool | Version | Notes |
|---|---|---|
| Node.js | Current LTS (match dirigeo's `.nvmrc`) | Use `fnm`/`nvm` |
| pnpm | via `corepack enable` | Version pinned in root `packageManager` field |
| Docker + Compose v2 | latest | Postgres, Ollama, OCR all run in containers |
| Ollama | latest | Can run in Docker **or** natively (native is easier for GPU/Apple Silicon) |
| Git, VS Code | — | Recommended extensions from dirigeo's `.vscode/` |
| Anthropic API key | — | console.anthropic.com → set a **monthly spend limit** (e.g. $20) |

Hardware: 8 GB RAM is enough (bge-m3 ≈ 1.2 GB on disk, ~2–3 GB RAM at runtime). ~20 GB free disk for
models, DB, and raw scans.

**Done when:** `node -v`, `pnpm -v`, `docker compose version`, `ollama -v` all work.

### Phase 1 — Monorepo skeleton

1. Port tooling from dirigeo (section 1.3).
2. Create empty workspaces from section 2, each with `package.json`, `tsconfig.json`, `src/index.ts`.
3. Root scripts (turbo pipelines): `dev`, `build`, `lint`, `typecheck`, `test`, `db:generate`, `db:migrate`, `db:studio`.
4. Test runner: Vitest (or dirigeo's choice).
5. `.gitignore` must include `data/`, `.env*` (except `.env.example`), `*.dump`.

**Done when:** `pnpm turbo lint typecheck test build` is green on the empty skeleton and CI runs it on push.

### Phase 2 — Local infrastructure (Docker Compose)

`infra/docker-compose.yml` services:

| Service | Image | Port | Volume |
|---|---|---|---|
| `db` | `pgvector/pgvector:pg17` | 5432 | `pgdata` |
| `ollama` | `ollama/ollama` (skip if running natively) | 11434 | `ollama` |
| `adminer` (optional) | `adminer` | 8080 | — |

OCR is **not** a long-running service — the worker shells out to it on demand:
`docker run --rm -v $PWD/data:/data jbarlow83/ocrmypdf --language vie+eng --deskew --clean in.pdf out.pdf`
(check `tesseract --list-langs` includes `vie`; install `tesseract-ocr-vie` in a custom image if not).

`infra/postgres/init.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() is STABLE, so it can't be used in a generated column/index directly.
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent', $1) $$;
```

Pull the embedding model once: `ollama pull bge-m3`.

**Done when:**
- `docker compose up -d` → `psql` shows `vector`, `unaccent` in `\dx`
- `curl localhost:11434/api/embed -d '{"model":"bge-m3","input":"Nuôi cá rô phi trong ao đất"}'` returns a 1024-length vector

### Phase 3 — Database schema (first migration)

Minimal tables — enough to support trust-aware citations from day one:

**`sources`** — one row per book / article / social post / note
- `id`, `kind` (`book | article | paper | social_post | video | personal_note`)
- `title`, `author`, `publisher`, `published_at`, `url`, `language` (default `vi`)
- `trust_level` smallint 1–4 (see below), `trust_note` (why I trust/distrust it)
- `file_path`, `checksum` (dedupe), `status` (`pending | processing | ready | failed`), `error`
- `created_at`, `updated_at`

**`chunks`**
- `id`, `source_id` FK, `ordinal`, `content`, `heading_path` (e.g. `Chương 3 > Quản lý chất lượng nước`)
- `page_from`, `page_to` (books), `token_count`
- `embedding vector(1024)` + **HNSW** index (`vector_cosine_ops`)
- `tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', f_unaccent(content))) STORED` + GIN index
- `metadata jsonb` (OCR confidence, etc.)

**`tags`** / **`source_tags`** — species (`cá tra`, `rô phi`, `tôm thẻ`…), topic (`nước`, `bệnh`, `thức ăn`, `con giống`, `kinh tế`)

**`qa_log`** — `question`, `answer`, `cited_chunk_ids`, `model`, `tokens_in/out`, `rating` (👍/👎), `note`
→ becomes the evaluation set later; costs nothing to start collecting now.

**Trust levels** (shown next to every citation in answers):
| Level | Meaning | Examples |
|---|---|---|
| 1 | Official / academic | Bộ NN&PTNT / Cục Thủy sản guidelines, university textbooks, extension centre (khuyến nông) manuals, peer-reviewed papers |
| 2 | Reputable practitioner | Published farming handbooks, established trade magazines |
| 3 | Verified community | Social posts from people I've checked, or claims corroborated by a level-1/2 source |
| 4 | Unverified | Anything else captured "for later checking" |

**Done when:** `pnpm db:migrate` on a fresh DB creates all tables + indexes; a seed script inserts one
source with two chunks and a hand-written hybrid query returns them.

### Phase 4 — Configuration & secrets

`.env.example` (validated at startup with zod in `packages/core`):
```dotenv
DATABASE_URL=postgres://ffr:ffr@localhost:5432/ffr
OLLAMA_BASE_URL=http://localhost:11434
EMBEDDING_MODEL=bge-m3
EMBEDDING_DIM=1024
ANTHROPIC_API_KEY=
LLM_MODEL=claude-opus-5-5          # see cost table in §5 — switch to claude-sonnet-5-5 / claude-haiku-4-5 if you prefer cheaper
OCR_FALLBACK_MODEL=claude-sonnet-5-5
DATA_DIR=./data
```

- Never commit `.env`. **This repository is currently public** → either make it private, or be extra strict
  that nothing under `data/` and no library scans ever get committed (copyright + privacy).
- `EMBEDDING_MODEL` + `EMBEDDING_DIM` are stored per chunk batch (in `metadata`) so a later model switch can
  re-embed incrementally instead of silently mixing vector spaces.

**Done when:** `apps/web` and `apps/worker` both fail fast with a clear message if a required var is missing.

### Phase 5 — App & worker shells

- `apps/web`: Next.js app from dirigeo template; pages `/` (chat), `/sources` (list + status), `/sources/new`
  (upload file / paste URL / quick note), health route `GET /api/health` that pings DB + Ollama.
- `apps/worker`: starts pg-boss, registers no-op handlers for queues `extract`, `ocr`, `chunk`, `embed`.
  Each handler updates `sources.status` so the UI can show progress.
- Dev command: `pnpm dev` runs both via turbo (`docker compose up -d` as a pre-step or documented).

**Done when:** uploading a file in the UI creates a `sources` row, enqueues `extract`, and the worker log shows it
flowing through all four no-op stages to `ready`.

### Phase 6 — Developer workflow & CI

- CI (GitHub Actions): pnpm cache → lint → typecheck → unit tests → build. Add a job with a
  `pgvector/pgvector` service container to run migration + repository tests.
- No AI calls in CI (mock `rag` / `ingest` boundaries) — keeps CI free and deterministic.
- `scripts/backup.sh`: `pg_dump -Fc` + tar of `data/raw` → `data/backups/` (later: sync to R2/B2, cents/month).

**Done when:** a PR runs CI green, and a backup can be restored into a fresh container.

---

## 4. What comes after environment setup (for context, not in scope here)

1. **Ingestion v1** — PDF (text layer) via `pdfjs-dist`/`unpdf`; scanned PDF/images via ocrmypdf; plain text/notes.
   Chunking: ~500–800 tokens, split on headings/paragraphs, 10–15% overlap; keep page numbers.
2. **Vietnamese text cleanup** — Unicode NFC normalisation (OCR and copy-paste mix NFC/NFD, which breaks
   both FTS and dedupe), fix hyphenation/line breaks from OCR, strip headers/footers/page numbers.
3. **Retrieval v1** — hybrid query (top-k vector + top-k FTS → RRF) with filters on tags and min trust level.
4. **Answering v1** — Claude with retrieved chunks passed as `document` blocks with **citations enabled**,
   system prompt in Vietnamese: answer only from sources, say "không đủ thông tin" when unsure, flag when
   only level-3/4 sources support a claim, surface disagreements between sources.
5. **Quick-capture for social posts** — a paste form (text + URL + author + trust level) first; a bookmarklet later.
6. **Eval** — 30–50 real questions from `qa_log`, re-run after any chunking/model change.
7. Later: reranker (`bge-reranker-v2-m3`), image-heavy pages (disease photos), farm journal data.

---

## 5. Cost estimate (personal use)

Embeddings and OCR run locally → **$0**. Only answer generation and occasional OCR fallback cost money.

Assume 20 questions/day × ~8k input tokens (retrieved chunks + prompt) and ~800 output tokens
→ ≈ 4.8 M input + 0.5 M output tokens/month.

| Model (`LLM_MODEL`) | Price in/out per 1M tok | ≈ Monthly |
|---|---|---|
| `claude-opus-5-5` | $4 / $20 | ≈ $29 |
| `claude-sonnet-5-5` | $2 / $10 | ≈ $15 |
| `claude-haiku-4-5` | $1 / $5 | ≈ $7 |

OCR fallback with Claude vision: roughly 1–2k tokens per page → a 300-page bad scan is a few dollars
on Sonnet 5.5; only used for pages where Tesseract confidence is low.

Infra: $0 on a local machine. If you later want access from your phone at the farm: a 4 GB VPS
(≈ $5–8/month) runs Postgres + Ollama + Next.js comfortably at this scale.

Set a hard monthly spend limit in the Anthropic console and log `tokens_in/out` per answer in `qa_log`.

---

## 6. Risks & open questions

| # | Item | Proposed handling |
|---|---|---|
| 1 | **Access to `dirigeo-monorepo`** | Grant access (or tell me its `owner/repo`) so Phase 1 reuses it precisely |
| 2 | OCR quality on old Vietnamese prints (diacritics) | Measure on 2–3 real books early; Claude vision fallback per page |
| 3 | Copyright of library material | Personal use only; keep raw files and full text out of git; private repo recommended |
| 4 | Social-media misinformation | Trust levels + mandatory citations + "only low-trust sources" warning in answers |
| 5 | Embedding model lock-in | Model name/dim stored with chunks; re-embed script |
| 6 | Data loss over a multi-year horizon | Automated `pg_dump` + raw file backup to object storage from Phase 6 |

Questions for you:
1. Where does `dirigeo-monorepo` live (owner/org), and should I copy its ORM/test runner choices as-is?
2. Make `fish-farm-rag` private? (recommended given library material)
3. Dev machine: macOS (Apple Silicon) / Windows+WSL / Linux? — affects running Ollama natively vs in Docker.
4. Answer model default: keep `claude-opus-5-5`, or start cheaper with Sonnet 5.5 / Haiku 4.5?
