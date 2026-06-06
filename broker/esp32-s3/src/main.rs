#![no_std]
#![no_main]

extern crate alloc;

use alloc::boxed::Box;
use core::num::NonZero;

use embassy_executor::Spawner;
use embassy_net::{
    Config as NetConfig, IpAddress, IpEndpoint, Ipv4Address, Runner, Stack, StackResources,
    dns::DnsQueryType,
    tcp::TcpSocket,
    udp::{PacketMetadata, UdpSocket},
};
use embassy_time::{Duration, Timer, with_timeout};
use embedded_io_async::{Error as EmbeddedIoError, ErrorKind, ErrorType, Read, Write};
use embedded_tls::{Aes128GcmSha256, TlsConfig, TlsConnection, TlsContext, UnsecureProvider};
use embedded_websocket_embedded_io::{
    Client as WebSocketClientType, Error as WebSocketError, WebSocket, WebSocketOptions,
    WebSocketReceiveMessageType, WebSocketSendMessageType,
};
use esp_alloc as _;
use esp_backtrace as _;
use esp_hal::{
    clock::CpuClock,
    interrupt::software::SoftwareInterruptControl,
    ram,
    rng::{Rng, Trng, TrngSource},
    timer::timg::TimerGroup,
};
use esp_println::println;
use esp_radio::wifi::{
    Config as WifiConfig, ControllerConfig, Interface, WifiController, sta::StationConfig,
};
use rust_mqtt::{
    Bytes,
    buffer::AllocBuffer,
    client::{
        Client,
        event::Event,
        options::{ConnectOptions, PublicationOptions, SubscriptionOptions, TopicReference},
    },
    config::{KeepAlive, SessionExpiryInterval},
    io::Transport,
    types::{MqttBinary, MqttString, TopicName},
};
use serde::{Deserialize, Serialize};

esp_bootloader_esp_idf::esp_app_desc!();

macro_rules! mk_static {
    ($t:ty, $val:expr) => {{
        static STATIC_CELL: static_cell::StaticCell<$t> = static_cell::StaticCell::new();
        STATIC_CELL.uninit().write($val)
    }};
}

const WIFI_SSID: &str = match option_env!("WIFI_SSID") {
    Some(value) => value,
    None => "",
};
const WIFI_PASS: &str = match option_env!("WIFI_PASS") {
    Some(value) => value,
    None => "",
};
const MQTT_URL: &str = match option_env!("MQTT_URL") {
    Some(value) => value,
    None => "mqtt://127.0.0.1:1883",
};
const MQTT_USERNAME: &str = match option_env!("MQTT_USERNAME") {
    Some(value) => value,
    None => "",
};
const MQTT_PASSWORD: &str = match option_env!("MQTT_PASSWORD") {
    Some(value) => value,
    None => "",
};
const MQTT_TOPIC_PREFIX: &str = match option_env!("MQTT_TOPIC_PREFIX") {
    Some(value) => value,
    None => "wolmgr/wol",
};
const MQTT_TLS_INSECURE: bool = parse_bool(option_env!("MQTT_TLS_INSECURE"), true);
const MQTT_CLIENT_ID: &str = match option_env!("MQTT_CLIENT_ID") {
    Some(value) => value,
    None => "wolmgr-esp32s3",
};
const WOL_BROADCAST_ADDR: &str = match option_env!("WOL_BROADCAST_ADDR") {
    Some(value) => value,
    None => "255.255.255.255",
};
const MQTT_KEEPALIVE_SECS: u16 = parse_u16(option_env!("MQTT_KEEPALIVE_SECS"), 30);
const WOL_PORT: u16 = parse_u16(option_env!("WOL_PORT"), 9);

const WS_BUFFER_SIZE: usize = 4096;
const WS_TX_FRAME_SIZE: usize = WS_BUFFER_SIZE + 14;

type MqttClient<'a, T> = Client<'a, T, AllocBuffer, 4, 4, 4, 4>;
type EspWebSocket = WebSocket<Trng, WebSocketClientType>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MqttScheme {
    Mqtt,
    Mqtts,
    Ws,
    Wss,
}

impl MqttScheme {
    fn as_str(self) -> &'static str {
        match self {
            Self::Mqtt => "mqtt",
            Self::Mqtts => "mqtts",
            Self::Ws => "ws",
            Self::Wss => "wss",
        }
    }

    fn default_port(self) -> u16 {
        match self {
            Self::Mqtt => 1883,
            Self::Mqtts => 8883,
            Self::Ws => 80,
            Self::Wss => 443,
        }
    }

    fn is_tls(self) -> bool {
        matches!(self, Self::Mqtts | Self::Wss)
    }

    fn is_websocket(self) -> bool {
        matches!(self, Self::Ws | Self::Wss)
    }
}

#[derive(Debug, Clone, Copy)]
struct MqttEndpoint {
    scheme: MqttScheme,
    username: Option<&'static str>,
    password: Option<&'static str>,
    host: &'static str,
    port: u16,
    path: &'static str,
}

#[derive(Debug)]
enum MqttWsError<E> {
    Io(E),
    WebSocket(WebSocketError),
    BufferTooSmall,
    ConnectionClosed,
    MissingSubProtocol,
}

impl<E: core::fmt::Debug> core::fmt::Display for MqttWsError<E> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl<E: EmbeddedIoError> core::error::Error for MqttWsError<E> {}

impl<E: EmbeddedIoError> EmbeddedIoError for MqttWsError<E> {
    fn kind(&self) -> ErrorKind {
        match self {
            Self::Io(err) => err.kind(),
            Self::ConnectionClosed => ErrorKind::NotConnected,
            Self::BufferTooSmall => ErrorKind::OutOfMemory,
            Self::WebSocket(err) => {
                let _ = err;
                ErrorKind::InvalidData
            }
            Self::MissingSubProtocol => ErrorKind::InvalidData,
        }
    }
}

struct MqttWebSocket<T> {
    inner: T,
    websocket: EspWebSocket,
    rx_buf: Box<[u8; WS_BUFFER_SIZE]>,
    frame_buf: Box<[u8; WS_BUFFER_SIZE]>,
    tx_buf: Box<[u8; WS_TX_FRAME_SIZE]>,
    frame_cursor: usize,
    rx_remainder_len: usize,
    read_pos: usize,
    read_len: usize,
}

impl<T> MqttWebSocket<T>
where
    T: Read + Write,
{
    async fn connect(mut inner: T, endpoint: &MqttEndpoint) -> Result<Self, MqttWsError<T::Error>> {
        let trng = Trng::try_new().map_err(|_| MqttWsError::WebSocket(WebSocketError::RandCore))?;
        let mut websocket = EspWebSocket::new_client(trng);
        let mut rx_buf = Box::new([0_u8; WS_BUFFER_SIZE]);
        let frame_buf = Box::new([0_u8; WS_BUFFER_SIZE]);
        let mut tx_buf = Box::new([0_u8; WS_TX_FRAME_SIZE]);
        let mut host = heapless::String::<128>::new();
        let mut origin = heapless::String::<160>::new();

        host.push_str(endpoint.host)
            .map_err(|_| MqttWsError::BufferTooSmall)?;
        if endpoint.port != endpoint.scheme.default_port() {
            host.push(':').map_err(|_| MqttWsError::BufferTooSmall)?;
            push_u16(&mut host, endpoint.port).ok_or(MqttWsError::BufferTooSmall)?;
        }

        origin
            .push_str(if endpoint.scheme.is_tls() {
                "https://"
            } else {
                "http://"
            })
            .map_err(|_| MqttWsError::BufferTooSmall)?;
        origin
            .push_str(host.as_str())
            .map_err(|_| MqttWsError::BufferTooSmall)?;

        let sub_protocols = ["mqtt"];
        let options = WebSocketOptions {
            path: endpoint.path,
            host: host.as_str(),
            origin: origin.as_str(),
            sub_protocols: Some(&sub_protocols),
            additional_headers: None,
        };

        let (len, websocket_key) = websocket
            .client_connect(&options, &mut tx_buf[..])
            .map_err(MqttWsError::WebSocket)?;
        inner
            .write_all(&tx_buf[..len])
            .await
            .map_err(MqttWsError::Io)?;
        inner.flush().await.map_err(MqttWsError::Io)?;

        let mut rx_remainder_len = 0;
        loop {
            if rx_remainder_len == rx_buf.len() {
                return Err(MqttWsError::BufferTooSmall);
            }

            let read_len = inner
                .read(&mut rx_buf[rx_remainder_len..])
                .await
                .map_err(MqttWsError::Io)?;
            if read_len == 0 {
                return Err(MqttWsError::ConnectionClosed);
            }
            rx_remainder_len += read_len;

            match websocket.client_accept(&websocket_key, &rx_buf[..rx_remainder_len]) {
                Ok((consumed, sub_protocol)) => {
                    if !sub_protocol.is_some_and(|protocol| protocol.as_str() == "mqtt") {
                        return Err(MqttWsError::MissingSubProtocol);
                    }
                    let remaining = rx_remainder_len.saturating_sub(consumed);
                    if remaining > 0 {
                        rx_buf.copy_within(consumed..rx_remainder_len, 0);
                    }
                    return Ok(Self {
                        inner,
                        websocket,
                        rx_buf,
                        frame_buf,
                        tx_buf,
                        frame_cursor: 0,
                        rx_remainder_len: remaining,
                        read_pos: 0,
                        read_len: 0,
                    });
                }
                Err(WebSocketError::HttpHeaderIncomplete) => {}
                Err(err) => return Err(MqttWsError::WebSocket(err)),
            }
        }
    }

    async fn read_message(&mut self) -> Result<usize, MqttWsError<T::Error>> {
        loop {
            if self.rx_remainder_len == 0 {
                let read_len = self
                    .inner
                    .read(&mut self.rx_buf[..])
                    .await
                    .map_err(MqttWsError::Io)?;
                if read_len == 0 {
                    return Err(MqttWsError::ConnectionClosed);
                }
                self.rx_remainder_len = read_len;
            }

            let ws_result = match self.websocket.read(
                &self.rx_buf[..self.rx_remainder_len],
                &mut self.frame_buf[self.frame_cursor..],
            ) {
                Ok(result) => result,
                Err(WebSocketError::ReadFrameIncomplete) => {
                    if self.rx_remainder_len == self.rx_buf.len() {
                        return Err(MqttWsError::BufferTooSmall);
                    }
                    let read_len = self
                        .inner
                        .read(&mut self.rx_buf[self.rx_remainder_len..])
                        .await
                        .map_err(MqttWsError::Io)?;
                    if read_len == 0 {
                        return Err(MqttWsError::ConnectionClosed);
                    }
                    self.rx_remainder_len += read_len;
                    continue;
                }
                Err(err) => return Err(MqttWsError::WebSocket(err)),
            };

            let remaining = self.rx_remainder_len.saturating_sub(ws_result.len_from);
            if remaining > 0 {
                self.rx_buf
                    .copy_within(ws_result.len_from..self.rx_remainder_len, 0);
            }
            self.rx_remainder_len = remaining;

            match ws_result.message_type {
                WebSocketReceiveMessageType::Binary => {
                    self.frame_cursor += ws_result.len_to;
                    if ws_result.end_of_message {
                        let len = self.frame_cursor;
                        self.frame_cursor = 0;
                        return Ok(len);
                    }
                }
                WebSocketReceiveMessageType::Ping => {
                    self.write_control(WebSocketSendMessageType::Pong, ws_result.len_to)
                        .await?;
                }
                WebSocketReceiveMessageType::Pong => {}
                WebSocketReceiveMessageType::CloseMustReply => {
                    self.write_control(WebSocketSendMessageType::CloseReply, ws_result.len_to)
                        .await?;
                    return Err(MqttWsError::ConnectionClosed);
                }
                WebSocketReceiveMessageType::CloseCompleted => {
                    return Err(MqttWsError::ConnectionClosed);
                }
                WebSocketReceiveMessageType::Text => return Err(MqttWsError::MissingSubProtocol),
            }
        }
    }

    async fn write_control(
        &mut self,
        message_type: WebSocketSendMessageType,
        payload_len: usize,
    ) -> Result<(), MqttWsError<T::Error>> {
        let payload = &self.frame_buf[self.frame_cursor..self.frame_cursor + payload_len];
        let len = self
            .websocket
            .write(message_type, true, payload, &mut self.tx_buf[..])
            .map_err(MqttWsError::WebSocket)?;
        self.inner
            .write_all(&self.tx_buf[..len])
            .await
            .map_err(MqttWsError::Io)?;
        self.inner.flush().await.map_err(MqttWsError::Io)
    }
}

impl<T: ErrorType> ErrorType for MqttWebSocket<T> {
    type Error = MqttWsError<T::Error>;
}

impl<T> Read for MqttWebSocket<T>
where
    T: Read + Write,
{
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, Self::Error> {
        if buf.is_empty() {
            return Ok(0);
        }

        if self.read_pos == self.read_len {
            self.read_len = self.read_message().await?;
            self.read_pos = 0;
        }

        let len = buf.len().min(self.read_len - self.read_pos);
        buf[..len].copy_from_slice(&self.frame_buf[self.read_pos..self.read_pos + len]);
        self.read_pos += len;
        Ok(len)
    }
}

impl<T> Write for MqttWebSocket<T>
where
    T: Read + Write,
{
    async fn write(&mut self, buf: &[u8]) -> Result<usize, Self::Error> {
        if buf.is_empty() {
            return Ok(0);
        }

        let payload_len = buf.len().min(WS_BUFFER_SIZE);
        let encoded_len = self
            .websocket
            .write(
                WebSocketSendMessageType::Binary,
                true,
                &buf[..payload_len],
                &mut self.tx_buf[..],
            )
            .map_err(MqttWsError::WebSocket)?;
        self.inner
            .write_all(&self.tx_buf[..encoded_len])
            .await
            .map_err(MqttWsError::Io)?;
        Ok(payload_len)
    }

    async fn flush(&mut self) -> Result<(), Self::Error> {
        self.inner.flush().await.map_err(MqttWsError::Io)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WolCommand {
    id: heapless::String<32>,
    mac_address: heapless::String<24>,
}

#[derive(Serialize)]
struct WolStatus<'a> {
    id: &'a str,
    status: &'a str,
}

#[esp_rtos::main]
async fn main(spawner: Spawner) -> ! {
    esp_println::logger::init_logger_from_env();

    let config = esp_hal::Config::default().with_cpu_clock(CpuClock::max());
    let peripherals = esp_hal::init(config);
    let _trng_source = TrngSource::new(peripherals.RNG, peripherals.ADC1);

    esp_alloc::heap_allocator!(#[ram(reclaimed)] size: 64 * 1024);
    esp_alloc::heap_allocator!(size: 36 * 1024);

    let timg0 = TimerGroup::new(peripherals.TIMG0);
    let sw_int = SoftwareInterruptControl::new(peripherals.SW_INTERRUPT);
    esp_rtos::start(timg0.timer0, sw_int.software_interrupt0);

    if WIFI_SSID.is_empty() {
        println!("WIFI_SSID must be provided at compile time");
        loop {
            Timer::after(Duration::from_secs(60)).await;
        }
    }

    let station_config = WifiConfig::Station(
        StationConfig::default()
            .with_ssid(WIFI_SSID)
            .with_password(WIFI_PASS.into()),
    );
    let wifi_interface = Interface::station();
    let controller = WifiController::new(
        peripherals.WIFI,
        ControllerConfig::default().with_initial_config(station_config),
    )
    .expect("failed to create Wi-Fi controller");

    let seed_rng = Rng::new();
    let seed = ((seed_rng.random() as u64) << 32) | seed_rng.random() as u64;
    let (stack, runner) = embassy_net::new(
        wifi_interface,
        NetConfig::dhcpv4(Default::default()),
        mk_static!(StackResources<4>, StackResources::<4>::new()),
        seed,
    );

    spawner.spawn(connection(controller).unwrap());
    spawner.spawn(net_task(runner).unwrap());

    stack.wait_config_up().await;
    if let Some(config) = stack.config_v4() {
        println!("DHCP address: {}", config.address);
    }

    loop {
        if mqtt_session(stack).await.is_err() {
            println!("MQTT session ended; reconnecting soon");
        }
        Timer::after(Duration::from_secs(5)).await;
    }
}

async fn mqtt_session(stack: Stack<'static>) -> Result<(), ()> {
    let endpoint = parse_mqtt_url(MQTT_URL).ok_or_else(|| {
        println!("Invalid MQTT_URL: {}", MQTT_URL);
    })?;
    let mqtt_ip = resolve_host(stack, endpoint.host).await.ok_or(())?;
    let mut tcp_rx = [0_u8; 4096];
    let mut tcp_tx = [0_u8; 4096];
    let mut socket = TcpSocket::new(stack, &mut tcp_rx, &mut tcp_tx);

    println!(
        "Connecting to MQTT {}://{}:{}{}",
        endpoint.scheme.as_str(),
        endpoint.host,
        endpoint.port,
        endpoint.path
    );
    socket
        .connect(IpEndpoint::new(mqtt_ip, endpoint.port))
        .await
        .map_err(|err| {
            println!("MQTT TCP connect failed: {:?}", err);
        })?;

    if endpoint.scheme.is_tls() {
        let mut tls_read = [0_u8; 16_384];
        let mut tls_write = [0_u8; 16_384];
        let mut tls = TlsConnection::new(socket, &mut tls_read, &mut tls_write);
        let config = TlsConfig::new()
            .with_server_name(endpoint.host)
            .enable_rsa_signatures();

        if !MQTT_TLS_INSECURE {
            println!("MQTT_TLS_INSECURE=0 is not supported yet; set MQTT_TLS_INSECURE=1");
            return Err(());
        }

        println!("Opening MQTT TLS session for {}", endpoint.host);
        let trng = Trng::try_new().map_err(|err| {
            println!("Failed to create TRNG for MQTT TLS: {:?}", err);
        })?;
        tls.open(TlsContext::new(
            &config,
            UnsecureProvider::new::<Aes128GcmSha256>(trng),
        ))
        .await
        .map_err(|err| {
            println!("MQTT TLS handshake failed: {:?}", err);
        })?;
        println!("MQTT TLS session opened");

        if endpoint.scheme.is_websocket() {
            println!("Opening MQTT WebSocket session at {}", endpoint.path);
            let ws = MqttWebSocket::connect(tls, &endpoint)
                .await
                .map_err(|err| {
                    println!("MQTT WebSocket handshake failed: {:?}", err);
                })?;
            return run_mqtt_session(ws, stack, &endpoint).await;
        }

        return run_mqtt_session(tls, stack, &endpoint).await;
    }

    if endpoint.scheme.is_websocket() {
        println!("Opening MQTT WebSocket session at {}", endpoint.path);
        let ws = MqttWebSocket::connect(socket, &endpoint)
            .await
            .map_err(|err| {
                println!("MQTT WebSocket handshake failed: {:?}", err);
            })?;
        return run_mqtt_session(ws, stack, &endpoint).await;
    }

    run_mqtt_session(socket, stack, &endpoint).await
}

async fn run_mqtt_session<T>(
    transport: T,
    stack: Stack<'static>,
    endpoint: &MqttEndpoint,
) -> Result<(), ()>
where
    T: Transport,
{
    let command_topic = topic_path::<96>("commands").ok_or(())?;
    let status_topic = topic_path::<96>("status").ok_or(())?;
    let mut buffer = AllocBuffer;
    let mut client: MqttClient<'_, T> = Client::new(&mut buffer);
    let connect_options = connect_options(endpoint)?;
    let client_id = MqttString::from_str(MQTT_CLIENT_ID).map_err(|_| ())?;

    client
        .connect(transport, &connect_options, Some(client_id))
        .await
        .map_err(|err| {
            println!("MQTT connect failed: {:?}", err);
        })?;
    println!("MQTT connected");

    let topic = topic_name(command_topic.as_str())?;
    client
        .subscribe(topic.into(), SubscriptionOptions::new().at_least_once())
        .await
        .map_err(|err| {
            println!("MQTT subscribe failed: {:?}", err);
        })?;

    match client.poll().await.map_err(|err| {
        println!("MQTT subscribe ack failed: {:?}", err);
    })? {
        Event::Suback(suback) => println!("Subscribed to {}: {:?}", command_topic, suback),
        event => println!("Unexpected MQTT event after subscribe: {:?}", event),
    }

    let poll_timeout = Duration::from_secs((MQTT_KEEPALIVE_SECS.saturating_sub(5)).max(1) as u64);
    loop {
        match with_timeout(poll_timeout, client.poll()).await {
            Ok(Ok(Event::Publish(publish)))
                if publish.topic.as_ref().as_str() == command_topic.as_str() =>
            {
                if let Ok((command, _)) =
                    serde_json_core::from_slice::<WolCommand>(&publish.message)
                {
                    handle_command(&mut client, stack, &status_topic, command).await;
                } else {
                    println!("Invalid WOL command payload");
                }
            }
            Ok(Ok(event)) => println!("MQTT event: {:?}", event),
            Ok(Err(err)) => {
                println!("MQTT poll failed: {:?}", err);
                return Err(());
            }
            Err(_) => {
                client.ping().await.map_err(|err| {
                    println!("MQTT ping failed: {:?}", err);
                })?;
            }
        }
    }
}

async fn handle_command(
    client: &mut MqttClient<'_, impl Transport>,
    stack: Stack<'static>,
    status_topic: &str,
    command: WolCommand,
) {
    println!("WOL command {} -> {}", command.id, command.mac_address);
    let _ = publish_status(client, status_topic, command.id.as_str(), "processing").await;

    let status = match send_magic_packet(stack, command.mac_address.as_str()).await {
        Ok(()) => "success",
        Err(()) => "failed",
    };

    let _ = publish_status(client, status_topic, command.id.as_str(), status).await;
}

async fn publish_status(
    client: &mut MqttClient<'_, impl Transport>,
    status_topic: &str,
    id: &str,
    status: &str,
) -> Result<(), ()> {
    let topic = topic_name(status_topic)?;
    let options = PublicationOptions::new(TopicReference::Name(topic))
        .at_least_once()
        .payload_format_indicator(true);
    let mut payload = [0_u8; 128];
    let status = WolStatus { id, status };
    let len = serde_json_core::to_slice(&status, &mut payload).map_err(|err| {
        println!("Failed to encode status JSON: {:?}", err);
    })?;

    client
        .publish(&options, Bytes::from(&payload[..len]))
        .await
        .map_err(|err| {
            println!("Failed to publish status: {:?}", err);
        })?;
    Ok(())
}

async fn send_magic_packet(stack: Stack<'static>, mac_address: &str) -> Result<(), ()> {
    let packet = build_magic_packet(mac_address)?;
    let broadcast = parse_ipv4(WOL_BROADCAST_ADDR).unwrap_or(Ipv4Address::new(255, 255, 255, 255));
    let mut rx_meta = [PacketMetadata::EMPTY; 1];
    let mut tx_meta = [PacketMetadata::EMPTY; 1];
    let mut rx_buffer = [0_u8; 16];
    let mut tx_buffer = [0_u8; 128];
    let mut socket = UdpSocket::new(
        stack,
        &mut rx_meta,
        &mut rx_buffer,
        &mut tx_meta,
        &mut tx_buffer,
    );
    socket.bind(0).map_err(|err| {
        println!("UDP bind failed: {:?}", err);
    })?;
    socket
        .send_to(
            &packet,
            IpEndpoint::new(IpAddress::Ipv4(broadcast), WOL_PORT),
        )
        .await
        .map_err(|err| {
            println!("UDP WOL send failed: {:?}", err);
        })?;
    Ok(())
}

fn build_magic_packet(mac_address: &str) -> Result<[u8; 102], ()> {
    let mac = mac_to_bytes(mac_address)?;
    let mut packet = [0xff_u8; 102];
    for idx in 0..16 {
        packet[6 + idx * 6..6 + (idx + 1) * 6].copy_from_slice(&mac);
    }
    Ok(packet)
}

fn mac_to_bytes(mac_address: &str) -> Result<[u8; 6], ()> {
    let mut out = [0_u8; 6];
    let mut nibble_count = 0;
    let mut byte = 0_u8;

    for ch in mac_address.bytes() {
        let value = match ch {
            b'0'..=b'9' => ch - b'0',
            b'a'..=b'f' => ch - b'a' + 10,
            b'A'..=b'F' => ch - b'A' + 10,
            b':' | b'-' => continue,
            _ => return Err(()),
        };

        if nibble_count % 2 == 0 {
            byte = value << 4;
        } else {
            byte |= value;
            let idx = nibble_count / 2;
            if idx >= out.len() {
                return Err(());
            }
            out[idx] = byte;
        }
        nibble_count += 1;
    }

    if nibble_count == 12 { Ok(out) } else { Err(()) }
}

async fn resolve_host(stack: Stack<'static>, host: &str) -> Option<IpAddress> {
    if let Some(ip) = parse_ipv4(host) {
        return Some(IpAddress::Ipv4(ip));
    }

    match stack.dns_query(host, DnsQueryType::A).await {
        Ok(addrs) => addrs.first().copied(),
        Err(err) => {
            println!("DNS lookup failed for {}: {:?}", host, err);
            None
        }
    }
}

fn parse_ipv4(input: &str) -> Option<Ipv4Address> {
    let mut octets = [0_u8; 4];
    let mut octet_idx = 0;
    let mut value: u16 = 0;
    let mut saw_digit = false;

    for ch in input.bytes() {
        match ch {
            b'0'..=b'9' => {
                saw_digit = true;
                value = value.saturating_mul(10).saturating_add((ch - b'0') as u16);
                if value > 255 {
                    return None;
                }
            }
            b'.' if saw_digit && octet_idx < 3 => {
                octets[octet_idx] = value as u8;
                octet_idx += 1;
                value = 0;
                saw_digit = false;
            }
            _ => return None,
        }
    }

    if saw_digit && octet_idx == 3 {
        octets[3] = value as u8;
        Some(Ipv4Address::new(octets[0], octets[1], octets[2], octets[3]))
    } else {
        None
    }
}

fn connect_options<'a>(endpoint: &'a MqttEndpoint) -> Result<ConnectOptions<'a>, ()> {
    let keepalive = NonZero::new(MQTT_KEEPALIVE_SECS.max(1)).ok_or(())?;
    let mut options = ConnectOptions::new()
        .clean_start()
        .session_expiry_interval(SessionExpiryInterval::Seconds(0))
        .keep_alive(KeepAlive::Seconds(keepalive));

    if let Some(username) = endpoint.username {
        options = options.user_name(MqttString::from_str(username).map_err(|_| ())?);
        options = options.password(
            MqttBinary::from_slice(endpoint.password.unwrap_or("").as_bytes()).map_err(|_| ())?,
        );
    }

    Ok(options)
}

fn parse_mqtt_url(url: &'static str) -> Option<MqttEndpoint> {
    let (scheme_raw, rest) = split_once_str(url, "://")?;
    let scheme = match scheme_raw {
        "mqtt" | "tcp" => MqttScheme::Mqtt,
        "mqtts" | "ssl" => MqttScheme::Mqtts,
        "ws" => MqttScheme::Ws,
        "wss" => MqttScheme::Wss,
        _ => return None,
    };

    let (authority, path) = match find_byte(rest, b'/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        return None;
    }

    let (userinfo, host_port) = match find_last_byte(authority, b'@') {
        Some(idx) => (Some(&authority[..idx]), &authority[idx + 1..]),
        None => (None, authority),
    };
    if host_port.is_empty() {
        return None;
    }

    let (url_username, url_password) = userinfo
        .filter(|value| !value.is_empty())
        .map(|value| match find_byte(value, b':') {
            Some(idx) => (&value[..idx], Some(&value[idx + 1..])),
            None => (value, None),
        })
        .unwrap_or(("", None));
    let username = if !url_username.is_empty() {
        Some(url_username)
    } else if !MQTT_USERNAME.is_empty() {
        Some(MQTT_USERNAME)
    } else {
        None
    };
    let password = if !url_username.is_empty() {
        url_password
    } else if !MQTT_USERNAME.is_empty() {
        Some(MQTT_PASSWORD)
    } else {
        None
    };

    let (host, port) = parse_host_port(host_port, scheme.default_port())?;
    Some(MqttEndpoint {
        scheme,
        username,
        password,
        host,
        port,
        path: if path.is_empty() { "/" } else { path },
    })
}

fn parse_host_port(input: &'static str, default_port: u16) -> Option<(&'static str, u16)> {
    if input.starts_with('[') {
        let end = find_byte(input, b']')?;
        let host = &input[1..end];
        if host.is_empty() {
            return None;
        }
        let rest = &input[end + 1..];
        let port = if rest.is_empty() {
            default_port
        } else if let Some(port_raw) = rest.strip_prefix(':') {
            parse_port(port_raw)?
        } else {
            return None;
        };
        return Some((host, port));
    }

    match find_last_byte(input, b':') {
        Some(idx) => {
            let host = &input[..idx];
            let port_raw = &input[idx + 1..];
            if host.is_empty() {
                None
            } else {
                Some((host, parse_port(port_raw)?))
            }
        }
        None => Some((input, default_port)),
    }
}

fn parse_port(input: &str) -> Option<u16> {
    if input.is_empty() {
        return None;
    }
    let mut out = 0_u16;
    for ch in input.bytes() {
        if !ch.is_ascii_digit() {
            return None;
        }
        out = out.checked_mul(10)?.checked_add((ch - b'0') as u16)?;
    }
    Some(out)
}

fn split_once_str<'a>(input: &'a str, delimiter: &str) -> Option<(&'a str, &'a str)> {
    let idx = input.find(delimiter)?;
    Some((&input[..idx], &input[idx + delimiter.len()..]))
}

fn find_byte(input: &str, needle: u8) -> Option<usize> {
    input.bytes().position(|ch| ch == needle)
}

fn find_last_byte(input: &str, needle: u8) -> Option<usize> {
    input.bytes().rposition(|ch| ch == needle)
}

fn push_u16<const N: usize>(out: &mut heapless::String<N>, value: u16) -> Option<()> {
    let mut digits = [0_u8; 5];
    let mut idx = digits.len();
    let mut value = value;
    loop {
        idx -= 1;
        digits[idx] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            break;
        }
    }

    for digit in &digits[idx..] {
        out.push(*digit as char).ok()?;
    }
    Some(())
}

fn topic_path<const N: usize>(suffix: &str) -> Option<heapless::String<N>> {
    let mut topic = heapless::String::<N>::new();
    let prefix = MQTT_TOPIC_PREFIX.trim_matches('/');
    if !prefix.is_empty() {
        topic.push_str(prefix).ok()?;
        topic.push('/').ok()?;
    }
    topic.push_str(suffix).ok()?;
    Some(topic)
}

fn topic_name(topic: &str) -> Result<TopicName<'_>, ()> {
    let topic = MqttString::from_str(topic).map_err(|_| ())?;
    TopicName::new(topic).ok_or(())
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

const fn parse_bool(value: Option<&'static str>, fallback: bool) -> bool {
    match value {
        Some(value) => match value.as_bytes() {
            b"1" => true,
            b"0" | b"" => false,
            _ => fallback,
        },
        None => fallback,
    }
}

#[embassy_executor::task]
async fn connection(mut controller: WifiController<'static>) {
    loop {
        println!("Connecting to Wi-Fi");
        match controller.connect_async().await {
            Ok(info) => {
                println!("Wi-Fi connected: {:?}", info);
                let info = controller.wait_for_disconnect_async().await.ok();
                println!("Wi-Fi disconnected: {:?}", info);
            }
            Err(err) => println!("Wi-Fi connect failed: {:?}", err),
        }

        Timer::after(Duration::from_secs(5)).await;
    }
}

#[embassy_executor::task]
async fn net_task(mut runner: Runner<'static, Interface>) {
    runner.run().await;
}
