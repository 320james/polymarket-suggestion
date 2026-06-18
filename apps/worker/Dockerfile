# syntax=docker/dockerfile:1.7
# Worker image — runs the polling loop + sends Telegram alerts.
#
# Build from the REPO ROOT so monorepo paths resolve:
#   docker build -f apps/worker/Dockerfile -t poly-worker .
#
# At runtime the container expects `./data` to be bind-mounted at /app/data
# (compose handles this) so it shares the SQLite file with the web service.
FROM node:20-alpine

# Prisma's query engine needs OpenSSL + glibc shim on Alpine.
RUN apk add --no-cache openssl libc6-compat

RUN corepack enable && corepack prepare pnpm@10.18.2 --activate
WORKDIR /app

# --- Dependency layer (cached unless lockfile/manifests change) -------------
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY prisma ./prisma
COPY packages/shared/package.json ./packages/shared/
COPY packages/polymarket-api/package.json ./packages/polymarket-api/
COPY apps/worker/package.json ./apps/worker/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# --- Source layer (invalidates only when code changes) ----------------------
COPY packages/shared ./packages/shared
COPY packages/polymarket-api ./packages/polymarket-api
COPY apps/worker ./apps/worker

# Generate the Prisma client against the schema.
RUN pnpm prisma:generate

ENV NODE_ENV=production
# Apply DB migrations first, then start the worker.
CMD ["sh", "-c", "pnpm prisma:deploy && pnpm -C apps/worker start"]
