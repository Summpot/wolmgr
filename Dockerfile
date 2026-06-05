# syntax=docker/dockerfile:1

FROM node:22-alpine AS frontend-builder
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend ./frontend
RUN corepack prepare pnpm@10.28.2 --activate
RUN pnpm install --frozen-lockfile

RUN pnpm -s build:frontend

FROM rust:1.95-alpine AS backend-builder
WORKDIR /app
RUN apk add --no-cache musl-dev pkgconfig sqlite-dev

COPY Cargo.toml Cargo.lock ./
COPY backend ./backend
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist
RUN cargo build -p wolmgr-backend --release

FROM alpine:3.22 AS runtime
WORKDIR /app
RUN apk add --no-cache ca-certificates sqlite-libs

COPY --from=backend-builder /app/target/release/wolmgr-backend /usr/local/bin/wolmgr-backend

ENV BIND_ADDR=0.0.0.0:8787
ENV DATABASE_URL=sqlite:/data/wolmgr.sqlite3
ENV MQTT_BIND_ADDR=0.0.0.0:1883
VOLUME ["/data"]
EXPOSE 8787 1883

CMD ["wolmgr-backend"]
