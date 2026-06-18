# syntax=docker/dockerfile:1.7
# Web image — Next.js dashboard.
#
# Build from the REPO ROOT so monorepo paths resolve:
#   docker build -f apps/web/Dockerfile -t poly-web .
#
# At runtime the container expects `./data` to be bind-mounted at /app/data
# (compose handles this) so the dashboard reads the same SQLite file the
# worker writes.
FROM node:20-alpine AS deps

RUN apk add --no-cache openssl libc6-compat
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY prisma ./prisma
COPY packages/shared/package.json ./packages/shared/
COPY packages/polymarket-api/package.json ./packages/polymarket-api/
COPY apps/web/package.json ./apps/web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# --- Build stage ------------------------------------------------------------
FROM deps AS builder
COPY packages/shared ./packages/shared
COPY packages/polymarket-api ./packages/polymarket-api
COPY apps/web ./apps/web

RUN pnpm prisma:generate
RUN pnpm -C apps/web build

# --- Runtime stage ----------------------------------------------------------
FROM node:20-alpine AS runner

RUN apk add --no-cache openssl libc6-compat
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate
WORKDIR /app

ENV NODE_ENV=production

# Bring everything the runtime needs. Simpler + more reliable than the
# Next standalone output for a pnpm workspace with Prisma.
COPY --from=builder /app ./

EXPOSE 3000
CMD ["pnpm", "-C", "apps/web", "start"]
