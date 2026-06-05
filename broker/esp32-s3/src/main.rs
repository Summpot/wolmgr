#![allow(unknown_lints)]
#![allow(unexpected_cfgs)]

#[cfg(any(esp32h2, esp32h4, esp32p4))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("This broker needs an ESP32-S3 or another ESP chip with Wi-Fi");
}

#[cfg(not(any(esp32h2, esp32h4, esp32p4)))]
fn main() -> anyhow::Result<()> {
    broker::main()
}

#[cfg(not(any(esp32h2, esp32h4, esp32p4)))]
mod broker {
    use core::{convert::TryInto, time::Duration};
    use std::net::UdpSocket;

    use anyhow::{anyhow, Context, Result};
    use embedded_svc::{
        http::{client::Client as HttpClient, Method},
        io::{Read, Write},
        wifi::{AuthMethod, ClientConfiguration, Configuration},
    };
    use esp_idf_svc::{
        eventloop::EspSystemEventLoop,
        hal::peripherals::Peripherals,
        http::client::{Configuration as HttpConfiguration, EspHttpConnection},
        log::EspLogger,
        nvs::EspDefaultNvsPartition,
        wifi::{BlockingWifi, EspWifi},
    };
    use log::{error, info, warn};
    use serde::Deserialize;

    const WIFI_SSID: &str = match option_env!("WIFI_SSID") {
        Some(value) => value,
        None => "",
    };
    const WIFI_PASS: &str = match option_env!("WIFI_PASS") {
        Some(value) => value,
        None => "",
    };
    const API_BASE_URL: &str = match option_env!("WOLMGR_API_BASE_URL") {
        Some(value) => value,
        None => "http://127.0.0.1:8787",
    };
    const BROKER_API_TOKEN: &str = match option_env!("BROKER_API_TOKEN") {
        Some(value) => value,
        None => "",
    };
    const WOL_BROADCAST_ADDR: &str = match option_env!("WOL_BROADCAST_ADDR") {
        Some(value) => value,
        None => "255.255.255.255",
    };
    const WOL_PORT: u16 = parse_u16(option_env!("WOL_PORT"), 9);
    const POLL_INTERVAL_MS: u64 = parse_u64(option_env!("POLL_INTERVAL_MS"), 10_000);
    const MAX_TASKS_PER_POLL: usize = 32;

    esp_idf_sys::esp_app_desc!();

    #[derive(Debug, Deserialize)]
    struct PendingTasksResponse {
        tasks: Vec<PendingTask>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PendingTask {
        id: String,
        mac_address: String,
    }

    pub fn main() -> Result<()> {
        esp_idf_svc::sys::link_patches();
        EspLogger::initialize_default();

        if WIFI_SSID.is_empty() {
            anyhow::bail!("WIFI_SSID must be provided at compile time");
        }

        let peripherals = Peripherals::take().context("failed to take peripherals")?;
        let sys_loop = EspSystemEventLoop::take().context("failed to take system event loop")?;
        let nvs = EspDefaultNvsPartition::take().context("failed to take NVS partition")?;

        let mut wifi = BlockingWifi::wrap(
            EspWifi::new(peripherals.modem, sys_loop.clone(), Some(nvs))?,
            sys_loop,
        )?;
        connect_wifi(&mut wifi)?;
        info!("Broker connected to Wi-Fi");

        let http_config = HttpConfiguration {
            crt_bundle_attach: Some(esp_idf_svc::sys::esp_crt_bundle_attach),
            ..Default::default()
        };
        let mut client = HttpClient::wrap(EspHttpConnection::new(&http_config)?);

        loop {
            if let Err(err) = poll_once(&mut client) {
                error!("broker poll failed: {err:?}");
            }
            std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        }
    }

    fn poll_once(client: &mut HttpClient<EspHttpConnection>) -> Result<()> {
        let tasks = fetch_pending_tasks(client)?;
        if tasks.is_empty() {
            return Ok(());
        }

        info!("received {} pending WOL task(s)", tasks.len());
        for task in tasks.into_iter().take(MAX_TASKS_PER_POLL) {
            if let Err(err) = handle_task(client, &task) {
                error!("task {} failed: {err:?}", task.id);
                let _ = update_task_status(client, &task.id, "failed");
            }
        }

        Ok(())
    }

    fn handle_task(client: &mut HttpClient<EspHttpConnection>, task: &PendingTask) -> Result<()> {
        update_task_status(client, &task.id, "processing")?;
        send_magic_packet(&task.mac_address)
            .with_context(|| format!("failed to send WOL packet to {}", task.mac_address))?;
        update_task_status(client, &task.id, "success")?;
        info!("WOL sent for {} (task {})", task.mac_address, task.id);
        Ok(())
    }

    fn fetch_pending_tasks(client: &mut HttpClient<EspHttpConnection>) -> Result<Vec<PendingTask>> {
        let url = api_url("/api/wol/tasks/pending");
        let auth = authorization_header();
        let mut headers = vec![("Accept", "application/json")];
        if let Some(auth) = auth.as_deref() {
            headers.push(("Authorization", auth));
        }

        let request = client.request(Method::Get, &url, &headers)?;
        let mut response = request.submit()?;
        let status = response.status();
        let body = read_response_body(&mut response)?;
        if !(200..300).contains(&status) {
            anyhow::bail!("GET {url} returned {status}: {body}");
        }

        let payload: PendingTasksResponse =
            serde_json::from_str(&body).context("failed to parse pending tasks response")?;
        Ok(payload.tasks)
    }

    fn update_task_status(
        client: &mut HttpClient<EspHttpConnection>,
        task_id: &str,
        status: &str,
    ) -> Result<()> {
        let url = api_url("/api/wol/tasks");
        let payload = serde_json::json!({ "id": task_id, "status": status }).to_string();
        send_json(client, Method::Put, &url, &payload)
    }

    fn send_json(
        client: &mut HttpClient<EspHttpConnection>,
        method: Method,
        url: &str,
        payload: &str,
    ) -> Result<()> {
        let content_length = payload.len().to_string();
        let auth = authorization_header();
        let mut headers = vec![
            ("Accept", "application/json"),
            ("Content-Type", "application/json"),
            ("Content-Length", content_length.as_str()),
        ];
        if let Some(auth) = auth.as_deref() {
            headers.push(("Authorization", auth));
        }

        let mut request = client.request(method, url, &headers)?;
        request.write_all(payload.as_bytes())?;
        request.flush()?;
        let mut response = request.submit()?;
        let status = response.status();
        let body = read_response_body(&mut response)?;
        if !(200..300).contains(&status) {
            anyhow::bail!("{method:?} {url} returned {status}: {body}");
        }
        Ok(())
    }

    fn send_magic_packet(mac_address: &str) -> Result<()> {
        let packet = build_magic_packet(mac_address)?;
        let socket = UdpSocket::bind("0.0.0.0:0").context("failed to bind UDP socket")?;
        socket.set_broadcast(true)?;
        socket
            .send_to(&packet, (WOL_BROADCAST_ADDR, WOL_PORT))
            .with_context(|| {
                format!("failed to send UDP packet to {WOL_BROADCAST_ADDR}:{WOL_PORT}")
            })?;
        Ok(())
    }

    fn build_magic_packet(mac_address: &str) -> Result<[u8; 102]> {
        let mac = mac_to_bytes(mac_address)?;
        let mut packet = [0xff_u8; 102];
        for idx in 0..16 {
            packet[6 + idx * 6..6 + (idx + 1) * 6].copy_from_slice(&mac);
        }
        Ok(packet)
    }

    fn mac_to_bytes(mac_address: &str) -> Result<[u8; 6]> {
        let cleaned: String = mac_address
            .chars()
            .filter(|ch| ch.is_ascii_hexdigit())
            .collect();
        if cleaned.len() != 12 {
            return Err(anyhow!("invalid MAC address: {mac_address}"));
        }

        let mut out = [0_u8; 6];
        for idx in 0..6 {
            out[idx] = u8::from_str_radix(&cleaned[idx * 2..idx * 2 + 2], 16)
                .with_context(|| format!("invalid MAC address: {mac_address}"))?;
        }
        Ok(out)
    }

    fn read_response_body(
        response: &mut impl Read<Error = impl core::fmt::Debug>,
    ) -> Result<String> {
        let mut body = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            let count = response
                .read(&mut buffer)
                .map_err(|err| anyhow!("failed to read HTTP response: {err:?}"))?;
            if count == 0 {
                break;
            }
            body.extend_from_slice(&buffer[..count]);
        }
        String::from_utf8(body).context("HTTP response body was not UTF-8")
    }

    fn connect_wifi(wifi: &mut BlockingWifi<EspWifi<'static>>) -> Result<()> {
        let auth_method = if WIFI_PASS.is_empty() {
            AuthMethod::None
        } else {
            AuthMethod::WPA2Personal
        };
        let wifi_configuration = Configuration::Client(ClientConfiguration {
            ssid: WIFI_SSID.try_into().unwrap(),
            password: WIFI_PASS.try_into().unwrap(),
            auth_method,
            ..Default::default()
        });

        wifi.set_configuration(&wifi_configuration)?;
        wifi.start()?;
        wifi.connect()?;
        wifi.wait_netif_up()?;

        let ip_info = wifi.wifi().sta_netif().get_ip_info()?;
        info!("Wi-Fi DHCP info: {ip_info:?}");
        Ok(())
    }

    fn api_url(path: &str) -> String {
        format!("{}{}", API_BASE_URL.trim_end_matches('/'), path)
    }

    fn authorization_header() -> Option<String> {
        if BROKER_API_TOKEN.is_empty() {
            None
        } else {
            Some(format!("Bearer {BROKER_API_TOKEN}"))
        }
    }

    const fn parse_u16(value: Option<&'static str>, fallback: u16) -> u16 {
        match value {
            Some(value) => parse_u16_inner(value.as_bytes(), fallback),
            None => fallback,
        }
    }

    const fn parse_u16_inner(bytes: &[u8], fallback: u16) -> u16 {
        let mut idx = 0;
        let mut out: u16 = 0;
        if bytes.is_empty() {
            return fallback;
        }
        while idx < bytes.len() {
            let ch = bytes[idx];
            if ch < b'0' || ch > b'9' {
                return fallback;
            }
            out = out.saturating_mul(10).saturating_add((ch - b'0') as u16);
            idx += 1;
        }
        out
    }

    const fn parse_u64(value: Option<&'static str>, fallback: u64) -> u64 {
        match value {
            Some(value) => parse_u64_inner(value.as_bytes(), fallback),
            None => fallback,
        }
    }

    const fn parse_u64_inner(bytes: &[u8], fallback: u64) -> u64 {
        let mut idx = 0;
        let mut out: u64 = 0;
        if bytes.is_empty() {
            return fallback;
        }
        while idx < bytes.len() {
            let ch = bytes[idx];
            if ch < b'0' || ch > b'9' {
                return fallback;
            }
            out = out.saturating_mul(10).saturating_add((ch - b'0') as u64);
            idx += 1;
        }
        out
    }

    #[allow(dead_code)]
    fn warn_missing_token() {
        if BROKER_API_TOKEN.is_empty() {
            warn!("BROKER_API_TOKEN is empty; backend broker endpoints must allow unauthenticated automation");
        }
    }
}
