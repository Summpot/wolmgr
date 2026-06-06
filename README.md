# wolmgr

wolmgr is a Wake-on-LAN manager with a separated React frontend, a Rust backend, and a Rust ESP32-S3 broker that sends WOL magic packets inside your LAN.

## Architecture

- **Frontend:** React + Rsbuild in `frontend/`. Production assets are embedded into the Rust backend binary.
- **Backend:** Axum + Toasty in `backend/`. It owns authentication/session state, devices, WOL task rows, and the MQTT bridge.
- **Database:** Toasty with the SQLite driver by default. Set `DATABASE_URL`, for example `sqlite:./wolmgr.sqlite3`.
- **MQTT:** The backend embeds an RMQTT broker by default, publishes WOL commands, and subscribes to broker status updates.
- **Broker:** ESP32-S3 Rust firmware in `broker/esp32-s3/`. It uses `esp-rs/esp-hal`, connects to Wi-Fi, subscribes to MQTT commands, sends UDP WOL packets, and publishes task status.

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

## MQTT Protocol

Default topic prefix: `wolmgr/wol`.

| Topic | Direction | Payload |
| --- | --- | --- |
| `wolmgr/wol/commands` | Backend -> ESP32-S3 broker | `{ "id": "task-id", "macAddress": "AA:BB:CC:DD:EE:FF" }` |
| `wolmgr/wol/status` | ESP32-S3 broker -> backend | `{ "id": "task-id", "status": "processing" }` |

Status values are `processing`, `success`, or `failed`. The backend also stores newly queued tasks as `pending`.

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
cargo run -p wolmgr-backend
```

The backend embeds `frontend/dist` at compile time. Rebuild the frontend before building/running the backend when frontend assets change.

## Environment

Backend variables:

- `DATABASE_URL` defaults to `sqlite:./wolmgr.sqlite3`.
- `BIND_ADDR` defaults to `127.0.0.1:8787`.
- `PUBLIC_ORIGIN` is used for OAuth callback URLs and secure cookie detection.
- `MQTT_BIND_ADDR` defaults to `0.0.0.0:1883` and controls the embedded MQTT broker TCP listener.
- `MQTT_WS_BIND_ADDR` defaults to `0.0.0.0:8083` and controls the embedded MQTT over WebSocket listener.
- `MQTT_URL` optionally points the backend at an external broker. Supported schemes are `mqtt`, `mqtts`, `ws`, and `wss`. When unset, the embedded broker starts automatically and the backend connects to `ws://127.0.0.1:8083/mqtt`.
- `MQTT_USERNAME` and `MQTT_PASSWORD` optionally authenticate to the MQTT broker. For the embedded broker, setting `MQTT_USERNAME` enables simple username/password auth.
- `MQTT_CLIENT_ID` defaults to a generated backend client ID.
- `MQTT_TOPIC_PREFIX` defaults to `wolmgr/wol`.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` enable GitHub OAuth.

Frontend variable:

- `PUBLIC_API_BASE_URL` optionally points browser API calls to another backend origin. Leave it empty for same-origin/proxy mode.

## ESP32-S3 Broker

The broker lives in `broker/esp32-s3` and is intentionally excluded from the root Cargo workspace because it targets `xtensa-esp32s3-none-elf`.

```bash
cd broker/esp32-s3
WIFI_SSID="your-ssid" \
WIFI_PASS="your-password" \
MQTT_URL="ws://192.168.1.10:8083/mqtt" \
MQTT_TOPIC_PREFIX="wolmgr/wol" \
cargo espflash flash --release --monitor
```

PowerShell:

```powershell
. "$HOME/export-esp.ps1"
Set-Location broker/esp32-s3
$env:WIFI_SSID = "your-ssid"
$env:WIFI_PASS = "your-password"
$env:MQTT_URL = "ws://192.168.1.10:8083/mqtt"
$env:MQTT_TOPIC_PREFIX = "wolmgr/wol"
cargo +esp espflash flash --release --monitor
```

If `export-esp.ps1` does not exist, install the esp-rs toolchain first with `cargo install espup` and `espup install`.

If multiple serial ports are connected, specify the ESP32-S3 port explicitly, for example `cargo +esp espflash flash --release --monitor --port COM3`.

Use the LAN IP of the machine running the backend in `MQTT_URL`; when the backend runs in Docker, publish `-p 1883:1883 -p 8083:8083` as shown below. The firmware selects transport from the URL scheme:

- `mqtt://host:1883` uses plain MQTT over TCP.
- `mqtts://host:8883` uses MQTT over TLS.
- `ws://host:8083/mqtt` uses MQTT over WebSocket.
- `wss://host/mqtt` uses MQTT over TLS plus WebSocket.

For Cloudflare Tunnel, point the public hostname at the backend WebSocket listener, for example service `http://127.0.0.1:8083`, and flash the ESP32 with:

```powershell
. "$HOME/export-esp.ps1"
Set-Location broker/esp32-s3
$env:WIFI_SSID = "CU_DbDA"
$env:WIFI_PASS = "your-password"
$env:MQTT_URL = "wss://mqtt.ohmyaitrash.org/mqtt"
$env:MQTT_TOPIC_PREFIX = "wolmgr/wol"
cargo +esp espflash flash --release --monitor --port COM3
```

TLS mode currently encrypts the connection and sends SNI but does not verify the server certificate; `MQTT_TLS_INSECURE` defaults to `1`.

Optional broker compile-time variables:

- `MQTT_URL` defaults to `mqtt://127.0.0.1:1883`; supported schemes are `mqtt`, `mqtts`, `ws`, and `wss`. URL credentials such as `wss://user:pass@example.com/mqtt` are supported.
- `MQTT_USERNAME` and `MQTT_PASSWORD` authenticate to the MQTT broker when credentials are not embedded in `MQTT_URL`.
- `MQTT_CLIENT_ID` defaults to `wolmgr-esp32s3`.
- `MQTT_TLS_INSECURE` defaults to `1`; certificate verification is not implemented yet.
- `MQTT_KEEPALIVE_SECS` defaults to `30`.
- `WOL_BROADCAST_ADDR` defaults to `255.255.255.255`.
- `WOL_PORT` defaults to `9`.

## Docker

```bash
docker build -t wolmgr .
docker run --rm -p 8787:8787 -p 1883:1883 -p 8083:8083 -v wolmgr-data:/data \
  -e PUBLIC_ORIGIN=http://localhost:8787 \
  wolmgr
```

By default this container starts the HTTP backend plus embedded MQTT TCP and WebSocket listeners. Set `MQTT_URL` only if you want to use a separate external MQTT broker.

## Current Notes

- Passkey routes are preserved but return `501` in the Rust backend until WebAuthn is migrated from the old TypeScript implementation.
- GitHub OAuth, sessions, devices, WOL task queueing, and MQTT status updates are implemented in Rust.
