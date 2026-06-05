# ESP32-S3 WOL broker

This firmware connects an ESP32-S3 to Wi-Fi, polls the Rust backend for pending Wake-on-LAN tasks, sends WOL magic packets on the LAN, and reports task status back to the backend.

## Build

Install the esp-rs toolchain and `cargo-espflash`, then build/flash with:

```bash
cd broker/esp32-s3
WIFI_SSID="your-ssid" \
WIFI_PASS="your-password" \
WOLMGR_API_BASE_URL="http://192.168.1.10:8787" \
BROKER_API_TOKEN="same-as-backend-token" \
MCU=esp32s3 \
cargo espflash flash --release --monitor
```

Optional compile-time settings:

- `POLL_INTERVAL_MS` defaults to `10000`.
- `WOL_BROADCAST_ADDR` defaults to `255.255.255.255`.
- `WOL_PORT` defaults to `9`.
