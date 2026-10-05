# syntax=docker/dockerfile:1
# Build context: repository root.  docker build -f infra/docker/api.Dockerfile .

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/rag/package.json apps/rag/

FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @ffr/api...
COPY packages/config packages/config
COPY apps/api apps/api
RUN pnpm --filter @ffr/api build

# Production dependencies only. Kept at the same /repo layout so pnpm's relative symlinks stay valid.
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @ffr/api...

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo/apps/api
COPY --from=prod-deps /repo/node_modules /repo/node_modules
COPY --from=prod-deps /repo/apps/api/node_modules ./node_modules
COPY --from=build /repo/apps/api/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4000
# Apply pending migrations, then replace the shell with the server so it receives SIGTERM.
CMD ["sh", "-c", "node_modules/.bin/typeorm migration:run -d dist/database/data-source.js && exec node dist/main"]
