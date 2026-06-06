# ESP32-S3 WOL broker

This firmware uses `esp-rs/esp-hal` with Embassy networking. It connects to Wi-Fi, subscribes to MQTT WOL commands, sends Wake-on-LAN magic packets on the LAN, and publishes task status back to MQTT.

## Build

Install the esp-rs Xtensa toolchain and `cargo-espflash`, then build/flash with:

```bash
WIFI_SSID="your-ssid" \
WIFI_PASS="your-password" \
MQTT_URL="ws://192.168.1.10:8083/mqtt" \
MQTT_TOPIC_PREFIX="wolmgr/wol" \
cargo espflash flash --release --monitor
```

PowerShell:

```powershell
. "$HOME/export-esp.ps1"
$env:WIFI_SSID = "your-ssid"
$env:WIFI_PASS = "your-password"
$env:MQTT_URL = "ws://192.168.1.10:8083/mqtt"
$env:MQTT_TOPIC_PREFIX = "wolmgr/wol"
cargo +esp espflash flash --release --monitor
```

If `export-esp.ps1` does not exist, install the esp-rs toolchain first with `cargo install espup` and `espup install`.

`MQTT_URL` should point at the MQTT listener reachable from the ESP32. The backend embeds an MQTT broker by default, so no separate broker is needed unless `MQTT_URL` is configured on the backend.

Supported URL schemes:

- `mqtt://host:1883` uses plain MQTT over TCP.
- `mqtts://host:8883` uses MQTT over TLS.
- `ws://host:8083/mqtt` uses MQTT over WebSocket.
- `wss://host/mqtt` uses MQTT over TLS plus WebSocket.

For Cloudflare Tunnel, point the public hostname at the backend WebSocket listener, for example service `http://127.0.0.1:8083`, and flash with:

```powershell
. "$HOME/export-esp.ps1"
$env:WIFI_SSID = "CU_DbDA"
$env:WIFI_PASS = "your-password"
$env:MQTT_URL = "wss://mqtt.ohmyaitrash.org/mqtt"
$env:MQTT_TOPIC_PREFIX = "wolmgr/wol"
cargo +esp espflash flash --release --monitor --port COM3
```

TLS mode currently encrypts the connection and sends SNI but does not verify the server certificate; `MQTT_TLS_INSECURE` defaults to `1`.

Optional compile-time settings:

- `MQTT_URL` defaults to `mqtt://127.0.0.1:1883`; URL credentials such as `wss://user:pass@example.com/mqtt` are supported.
- `MQTT_USERNAME` and `MQTT_PASSWORD` authenticate to the MQTT broker when credentials are not embedded in `MQTT_URL`.
- `MQTT_CLIENT_ID` defaults to `wolmgr-esp32s3`.
- `MQTT_TLS_INSECURE` defaults to `1`; certificate verification is not implemented yet.
- `MQTT_KEEPALIVE_SECS` defaults to `30`.
- `WOL_BROADCAST_ADDR` defaults to `255.255.255.255`.
- `WOL_PORT` defaults to `9`.
