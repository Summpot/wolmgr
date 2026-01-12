# syntax=docker/dockerfile:1

# Build stage: use the existing pnpm + rslib pipeline to produce a bundled waker.
FROM node:22-alpine AS builder

WORKDIR /app

# pnpm via Corepack (matches package.json "packageManager")
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
COPY tsconfig.json rslib.config.ts rsbuild.config.ts biome.json postcss.config.mjs ./
COPY public ./public
COPY src ./src

RUN corepack prepare pnpm@10.26.2 --activate
RUN pnpm install --frozen-lockfile

# rslib builds dist/waker.js (and dist/_worker.js for Pages)
RUN pnpm -s build:worker


# Runtime stage: bun executes the bundled script.
FROM oven/bun:alpine AS runtime

WORKDIR /app

COPY --from=builder /app/dist/waker.js ./waker.js

# Required:
# - TURSO_DATABASE_URL
# - TURSO_AUTH_TOKEN
# Optional:
# - POLL_INTERVAL_MS (default 10000)
# - WOL_BROADCAST_ADDR (default 255.255.255.255)
# - WOL_PORT (default 9)
# - ROUTEROS_ENABLED (true/false)
# - ROUTEROS_HOST / ROUTEROS_USER / ROUTEROS_PASSWORD / ROUTEROS_PORT / ROUTEROS_TLS
# - ROUTEROS_WOL_INTERFACE

CMD ["bun", "./waker.js"]
