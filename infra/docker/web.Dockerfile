# syntax=docker/dockerfile:1
# Build context: repository root.  docker build -f infra/docker/web.Dockerfile .

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Manifests first so dependency installation stays cached until a lockfile changes.
# Every workspace manifest is needed for `--frozen-lockfile` to see a consistent workspace.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/rag/package.json apps/rag/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @ffr/web...
COPY packages/config packages/config
COPY apps/web apps/web
RUN pnpm --filter @ffr/web build

FROM node:22-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
# `output: 'standalone'` + outputFileTracingRoot=<repo root> nests the server under apps/web.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
