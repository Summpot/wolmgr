# ESP32-S3 WOL broker

This firmware uses `esp-rs/esp-hal` with Embassy networking. It connects to Wi-Fi, subscribes to MQTT WOL commands, sends Wake-on-LAN magic packets on the LAN, and publishes task status back to MQTT.

## Build

Install the esp-rs Xtensa toolchain and `cargo-espflash`, then build/flash with:

```bash
WIFI_SSID="your-ssid" \
WIFI_PASS="your-password" \
MQTT_HOST="192.168.1.10" \
MQTT_PORT="1883" \
MQTT_TOPIC_PREFIX="wolmgr/wol" \
cargo espflash flash --release --monitor
```

Optional compile-time settings:

- `MQTT_USERNAME` and `MQTT_PASSWORD` authenticate to the MQTT broker.
- `MQTT_CLIENT_ID` defaults to `wolmgr-esp32s3`.
- `MQTT_KEEPALIVE_SECS` defaults to `30`.
- `WOL_BROADCAST_ADDR` defaults to `255.255.255.255`.
- `WOL_PORT` defaults to `9`.
