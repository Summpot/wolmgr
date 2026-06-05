# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/package.json
RUN corepack prepare pnpm@10.28.2 --activate
RUN pnpm install --frozen-lockfile

COPY frontend ./frontend
RUN pnpm -s build:frontend

FROM rust:1.95-bookworm AS backend-builder
WORKDIR /app
RUN apt-get update \
	&& apt-get install -y --no-install-recommends pkg-config libsqlite3-dev \
	&& rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY backend ./backend
RUN cargo build -p wolmgr-backend --release

FROM debian:bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=backend-builder /app/target/release/wolmgr-backend /usr/local/bin/wolmgr-backend
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

ENV BIND_ADDR=0.0.0.0:8787
ENV DATABASE_URL=sqlite:/data/wolmgr.sqlite3
ENV STATIC_DIR=/app/frontend/dist
VOLUME ["/data"]
EXPOSE 8787

CMD ["wolmgr-backend"]
