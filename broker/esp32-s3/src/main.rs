#![no_std]
#![no_main]

extern crate alloc;

use core::num::NonZero;

use embassy_executor::Spawner;
use embassy_net::{
    Config as NetConfig, IpAddress, IpEndpoint, Ipv4Address, Runner, Stack, StackResources,
    dns::DnsQueryType,
    tcp::TcpSocket,
    udp::{PacketMetadata, UdpSocket},
};
use embassy_time::{Duration, Timer, with_timeout};
use esp_alloc as _;
use esp_backtrace as _;
use esp_hal::{
    clock::CpuClock, interrupt::software::SoftwareInterruptControl, ram, rng::Rng,
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
const MQTT_HOST: &str = match option_env!("MQTT_HOST") {
    Some(value) => value,
    None => "127.0.0.1",
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
const MQTT_CLIENT_ID: &str = match option_env!("MQTT_CLIENT_ID") {
    Some(value) => value,
    None => "wolmgr-esp32s3",
};
const WOL_BROADCAST_ADDR: &str = match option_env!("WOL_BROADCAST_ADDR") {
    Some(value) => value,
    None => "255.255.255.255",
};
const MQTT_PORT: u16 = parse_u16(option_env!("MQTT_PORT"), 1883);
const MQTT_KEEPALIVE_SECS: u16 = parse_u16(option_env!("MQTT_KEEPALIVE_SECS"), 30);
const WOL_PORT: u16 = parse_u16(option_env!("WOL_PORT"), 9);

type MqttClient<'a> = Client<'a, TcpSocket<'a>, AllocBuffer, 4, 4, 4, 4>;

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

#[esp_hal::main]
async fn main(spawner: Spawner) -> ! {
    esp_println::logger::init_logger_from_env();

    let config = esp_hal::Config::default().with_cpu_clock(CpuClock::max());
    let peripherals = esp_hal::init(config);

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
    let mqtt_ip = resolve_host(stack, MQTT_HOST).await.ok_or(())?;
    let mut tcp_rx = [0_u8; 4096];
    let mut tcp_tx = [0_u8; 4096];
    let mut socket = TcpSocket::new(stack, &mut tcp_rx, &mut tcp_tx);

    println!("Connecting to MQTT {}:{}", MQTT_HOST, MQTT_PORT);
    socket
        .connect(IpEndpoint::new(mqtt_ip, MQTT_PORT))
        .await
        .map_err(|err| {
            println!("MQTT TCP connect failed: {:?}", err);
        })?;

    let command_topic = topic_path::<96>("commands").ok_or(())?;
    let status_topic = topic_path::<96>("status").ok_or(())?;
    let mut buffer = AllocBuffer;
    let mut client: MqttClient<'_> = Client::new(&mut buffer);
    let connect_options = connect_options()?;
    let client_id = MqttString::from_str(MQTT_CLIENT_ID).map_err(|_| ())?;

    client
        .connect(socket, &connect_options, Some(client_id))
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
    client: &mut MqttClient<'_>,
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
    client: &mut MqttClient<'_>,
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

fn connect_options<'a>() -> Result<ConnectOptions<'a>, ()> {
    let keepalive = NonZero::new(MQTT_KEEPALIVE_SECS.max(1)).ok_or(())?;
    let mut options = ConnectOptions::new()
        .clean_start()
        .session_expiry_interval(SessionExpiryInterval::Seconds(0))
        .keep_alive(KeepAlive::Seconds(keepalive));

    if !MQTT_USERNAME.is_empty() {
        options = options.user_name(MqttString::from_str(MQTT_USERNAME).map_err(|_| ())?);
        options =
            options.password(MqttBinary::from_slice(MQTT_PASSWORD.as_bytes()).map_err(|_| ())?);
    }

    Ok(options)
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
