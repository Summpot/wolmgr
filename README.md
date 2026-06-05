# wolmgr

wolmgr is a Wake-on-LAN manager with a separated React frontend, a Rust backend, and a Rust ESP32-S3 broker that sends WOL magic packets inside your LAN.

## Architecture

- **Frontend:** React + Rsbuild in `frontend/`. It calls the REST API and polls recent tasks.
- **Backend:** Axum + Toasty in `backend/`. It owns authentication/session state, devices, WOL task rows, and broker endpoints.
- **Database:** Toasty with the SQLite driver by default. Set `DATABASE_URL`, for example `sqlite:./wolmgr.sqlite3`.
- **Broker:** ESP32-S3 Rust firmware in `broker/esp32-s3/`. It connects to Wi-Fi, polls pending tasks, sends UDP WOL packets, and updates task status.

## REST API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/me` | Returns current session user and passkey count. |
| `GET` | `/api/devices` | Lists signed-in user's devices. |
| `POST` | `/api/devices` | Adds a device. Body: `{ "name": "NAS", "macAddress": "AA:BB:CC:DD:EE:FF" }`. |
| `DELETE` | `/api/devices/{id}` | Deletes a device. |
| `POST` | `/api/devices/{id}/wake` | Queues a WOL task for a saved device. |
| `GET` | `/api/wol/tasks` | Lists signed-in user's recent WOL tasks. |
| `POST` | `/api/wol/tasks` | Queues a WOL task by MAC address. |
| `GET` | `/api/wol/tasks/pending` | Broker endpoint: returns pending tasks. |
| `PUT` | `/api/wol/tasks` | Broker endpoint: updates task status. |
| `POST` | `/api/wol/tasks/notify` | Broker endpoint: marks a task success by `id` or `macAddress`. |

Broker endpoints accept `Authorization: Bearer <BROKER_API_TOKEN>` when `BROKER_API_TOKEN` is set on the backend.

## Local Development

```bash
pnpm install
cargo check -p wolmgr-backend

# Terminal 1
$env:DATABASE_URL="sqlite:./wolmgr.sqlite3"
$env:BIND_ADDR="127.0.0.1:8787"
cargo run -p wolmgr-backend

# Terminal 2
pnpm dev:frontend
```

The frontend dev server proxies `/api` to `http://127.0.0.1:8787`.

To serve the built frontend from the Rust backend:

```bash
pnpm build:frontend
$env:STATIC_DIR="frontend/dist"
cargo run -p wolmgr-backend
```

## Environment

Backend variables:

- `DATABASE_URL` defaults to `sqlite:./wolmgr.sqlite3`.
- `BIND_ADDR` defaults to `127.0.0.1:8787`.
- `PUBLIC_ORIGIN` is used for OAuth callback URLs and secure cookie detection.
- `STATIC_DIR` optionally serves frontend static files from the backend.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` enable GitHub OAuth.
- `BROKER_API_TOKEN` protects broker automation endpoints.

Frontend variable:

- `PUBLIC_API_BASE_URL` optionally points browser API calls to another backend origin. Leave it empty for same-origin/proxy mode.

## ESP32-S3 Broker

The broker lives in `broker/esp32-s3` and is intentionally excluded from the root Cargo workspace because it targets `xtensa-esp32s3-espidf`.

```bash
cd broker/esp32-s3
WIFI_SSID="your-ssid" \
WIFI_PASS="your-password" \
WOLMGR_API_BASE_URL="http://192.168.1.10:8787" \
BROKER_API_TOKEN="same-as-backend-token" \
MCU=esp32s3 \
cargo espflash flash --release --monitor
```

Optional broker compile-time variables:

- `POLL_INTERVAL_MS` defaults to `10000`.
- `WOL_BROADCAST_ADDR` defaults to `255.255.255.255`.
- `WOL_PORT` defaults to `9`.

## Docker

```bash
docker build -t wolmgr .
docker run --rm -p 8787:8787 -v wolmgr-data:/data \
  -e PUBLIC_ORIGIN=http://localhost:8787 \
  -e BROKER_API_TOKEN=change-me \
  wolmgr
```

## Current Notes

- Passkey routes are preserved but return `501` in the Rust backend until WebAuthn is migrated from the old TypeScript implementation.
- GitHub OAuth, sessions, devices, WOL task queueing, and broker polling/status updates are implemented in Rust.
