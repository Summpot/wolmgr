use std::{env, net::SocketAddr, sync::Arc, time::Duration as StdDuration};

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{delete, get, post},
};
use cookie::{Cookie, SameSite};
use nanoid::nanoid;
use reqwest::Client as HttpClient;
use rmqtt::{
    context::ServerContext,
    hook::{self, Handler, HookResult, Parameter, ReturnType},
    net::Builder as RmqttBuilder,
    server::MqttServer,
    types::AuthResult,
};
use rumqttc::{AsyncClient as MqttAsyncClient, Event, Incoming, MqttOptions, QoS, Transport};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use time::{Duration as TimeDuration, OffsetDateTime};
use toasty::{Db, Executor, sql, stmt::Value};
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

const SESSION_COOKIE_NAME: &str = "wolmgr_session";
const SESSION_TTL_MS: i64 = 1000 * 60 * 60 * 24 * 30;
const INDEX_HTML: &str = "index.html";

#[derive(RustEmbed)]
#[folder = "../frontend/dist/"]
#[allow_missing = true]
struct FrontendAssets;

#[derive(Clone)]
struct AppState {
    db: Db,
    http: HttpClient,
    mqtt: MqttPublisher,
    config: Arc<AppConfig>,
}

#[derive(Debug)]
struct AppConfig {
    public_origin: String,
    github_client_id: Option<String>,
    github_client_secret: Option<String>,
    cookie_secure: bool,
}

#[derive(Clone)]
struct MqttPublisher {
    client: MqttAsyncClient,
    command_topic: String,
}

#[derive(Debug, Clone)]
struct MqttConfig {
    url: String,
    username: Option<String>,
    password: Option<String>,
    client_id: String,
    topic_prefix: String,
    embedded: Option<EmbeddedMqttConfig>,
}

#[derive(Debug, Clone)]
struct EmbeddedMqttConfig {
    bind_addr: SocketAddr,
    ws_bind_addr: SocketAddr,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct User {
    id: String,
    github_login: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    github_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar_url: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    mac_address: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WolTask {
    id: String,
    mac_address: String,
    status: String,
    created_at: i64,
    updated_at: i64,
    attempts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    user: Option<User>,
    passkey_count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddDeviceRequest {
    name: Option<String>,
    mac_address: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTaskRequest {
    mac_address: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WolCommand {
    id: String,
    mac_address: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WolStatusUpdate {
    id: String,
    status: String,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
}

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("Unauthorized")]
    Unauthorized,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    NotImplemented(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match self {
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::NotImplemented(_) => StatusCode::NOT_IMPLEMENTED,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let message = self.to_string();
        (status, Json(ErrorBody { error: message })).into_response()
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "wolmgr_backend=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let database_url =
        env_optional("DATABASE_URL").unwrap_or_else(|| "sqlite:./wolmgr.sqlite3".to_string());
    let bind_addr: SocketAddr = env_optional("BIND_ADDR")
        .unwrap_or_else(|| "127.0.0.1:8787".to_string())
        .parse()
        .context("invalid BIND_ADDR")?;

    let mut db = Db::builder()
        .models(toasty::models!())
        .connect(&database_url)
        .await
        .with_context(|| format!("failed to connect Toasty database at {database_url}"))?;
    ensure_schema(&mut db).await?;

    let public_origin =
        env_optional("PUBLIC_ORIGIN").unwrap_or_else(|| format!("http://{bind_addr}"));
    let config = AppConfig {
        cookie_secure: public_origin.starts_with("https://"),
        public_origin,
        github_client_id: env_optional("GITHUB_CLIENT_ID"),
        github_client_secret: env_optional("GITHUB_CLIENT_SECRET"),
    };
    let mqtt_config = MqttConfig::from_env()?;
    if let Some(embedded) = &mqtt_config.embedded {
        start_embedded_mqtt_broker(embedded, &mqtt_config)?;
    }
    let mqtt = setup_mqtt(&db, &mqtt_config).await?;

    let state = AppState {
        db,
        http: HttpClient::new(),
        mqtt,
        config: Arc::new(config),
    };

    let app = api_router()
        .with_state(state)
        .fallback(embedded_static)
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        );

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    tracing::info!(%bind_addr, "wolmgr backend listening");
    axum::serve(listener, app).await?;
    Ok(())
}

fn api_router() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/me", get(me))
        .route("/api/auth/github/start", get(github_start))
        .route("/api/auth/github/callback", get(github_callback))
        .route("/api/auth/logout", post(logout))
        .route("/api/passkey/register/start", post(passkey_not_implemented))
        .route(
            "/api/passkey/register/finish",
            post(passkey_not_implemented),
        )
        .route("/api/passkey/login/start", post(passkey_not_implemented))
        .route("/api/passkey/login/finish", post(passkey_not_implemented))
        .route("/api/devices", get(list_devices).post(add_device))
        .route("/api/devices/{device_id}", delete(delete_device))
        .route("/api/devices/{device_id}/wake", post(wake_device))
        .route("/api/wol/tasks", get(list_tasks).post(create_task))
}

impl MqttConfig {
    fn from_env() -> Result<Self> {
        let external_url = env_optional("MQTT_URL");
        let bind_addr: SocketAddr = env_optional("MQTT_BIND_ADDR")
            .unwrap_or_else(|| "0.0.0.0:1883".to_string())
            .parse()
            .context("invalid MQTT_BIND_ADDR")?;
        let ws_bind_addr: SocketAddr = env_optional("MQTT_WS_BIND_ADDR")
            .unwrap_or_else(|| "0.0.0.0:8083".to_string())
            .parse()
            .context("invalid MQTT_WS_BIND_ADDR")?;
        let embedded = external_url.is_none().then_some(EmbeddedMqttConfig {
            bind_addr,
            ws_bind_addr,
        });
        let url =
            external_url.unwrap_or_else(|| format!("ws://127.0.0.1:{}/mqtt", ws_bind_addr.port()));

        Ok(Self {
            url,
            username: env_optional("MQTT_USERNAME"),
            password: env_optional("MQTT_PASSWORD"),
            client_id: env_optional("MQTT_CLIENT_ID")
                .unwrap_or_else(|| format!("wolmgr-backend-{}", nanoid!(8))),
            topic_prefix: env_optional("MQTT_TOPIC_PREFIX")
                .unwrap_or_else(|| "wolmgr/wol".to_string())
                .trim_matches('/')
                .to_string(),
            embedded,
        })
    }

    fn command_topic(&self) -> String {
        format!("{}/commands", self.topic_prefix)
    }

    fn status_topic(&self) -> String {
        format!("{}/status", self.topic_prefix)
    }
}

fn start_embedded_mqtt_broker(embedded: &EmbeddedMqttConfig, mqtt: &MqttConfig) -> Result<()> {
    let allow_anonymous = mqtt.username.is_none();
    let tcp_listener = RmqttBuilder::new()
        .name("wolmgr-mqtt/tcp")
        .laddr(embedded.bind_addr)
        .allow_anonymous(allow_anonymous)
        .bind()
        .context("failed to bind embedded MQTT TCP listener")?
        .tcp()
        .context("failed to configure embedded MQTT TCP listener")?;
    let ws_listener = RmqttBuilder::new()
        .name("wolmgr-mqtt/ws")
        .laddr(embedded.ws_bind_addr)
        .allow_anonymous(allow_anonymous)
        .bind()
        .context("failed to bind embedded MQTT WebSocket listener")?
        .ws()
        .context("failed to configure embedded MQTT WebSocket listener")?;

    let username = mqtt.username.clone();
    let password = mqtt.password.clone().unwrap_or_default();
    let bind_addr = embedded.bind_addr;
    let ws_bind_addr = embedded.ws_bind_addr;

    tokio::spawn(async move {
        let scx = ServerContext::new().build().await;
        if let Some(username) = username {
            let register = scx.extends.hook_mgr().register();
            register
                .add(
                    hook::Type::ClientAuthenticate,
                    Box::new(EmbeddedBrokerAuth { username, password }),
                )
                .await;
            register.start().await;
        }

        let server = MqttServer::new(scx)
            .listener(tcp_listener)
            .listener(ws_listener)
            .build();
        tracing::info!(%bind_addr, %ws_bind_addr, "embedded MQTT broker starting");
        if let Err(err) = server.run().await {
            tracing::error!(error = ?err, "embedded MQTT broker stopped");
        }
    });

    Ok(())
}

struct EmbeddedBrokerAuth {
    username: String,
    password: String,
}

#[async_trait::async_trait]
impl Handler for EmbeddedBrokerAuth {
    async fn hook(&self, param: &Parameter, _acc: Option<HookResult>) -> ReturnType {
        let Parameter::ClientAuthenticate(connect_info) = param else {
            return (true, None);
        };

        let username_matches = connect_info
            .username()
            .is_some_and(|username| username.as_ref() == self.username);
        let password_matches = connect_info
            .password()
            .is_some_and(|password| password.as_ref() == self.password.as_bytes());

        if username_matches && password_matches {
            (
                false,
                Some(HookResult::AuthResult(AuthResult::Allow(false, None))),
            )
        } else {
            (
                false,
                Some(HookResult::AuthResult(AuthResult::BadUsernameOrPassword)),
            )
        }
    }
}

async fn setup_mqtt(db: &Db, config: &MqttConfig) -> Result<MqttPublisher> {
    let command_topic = config.command_topic();
    let status_topic = config.status_topic();
    let options = mqtt_options(config)?;
    let (client, eventloop) = MqttAsyncClient::new(options, 32);

    client
        .subscribe(status_topic.clone(), QoS::AtLeastOnce)
        .await
        .context("failed to enqueue MQTT status subscription")?;

    tokio::spawn(mqtt_event_loop(db.clone(), eventloop, status_topic.clone()));
    tracing::info!(
        mqtt_url = %config.url,
        command_topic = %command_topic,
        status_topic = %status_topic,
        "MQTT bridge configured"
    );

    Ok(MqttPublisher {
        client,
        command_topic,
    })
}

fn mqtt_options(config: &MqttConfig) -> Result<MqttOptions> {
    let parsed = url::Url::parse(&config.url).context("invalid MQTT_URL")?;
    let scheme = parsed.scheme();
    let host = parsed
        .host_str()
        .context("MQTT_URL must include a host")?
        .to_string();
    let default_port = match scheme {
        "mqtt" | "tcp" => 1883,
        "mqtts" | "ssl" => 8883,
        "ws" => 80,
        "wss" => 443,
        other => anyhow::bail!("unsupported MQTT_URL scheme: {other}"),
    };
    let mut options = MqttOptions::new(
        config.client_id.clone(),
        if matches!(scheme, "ws" | "wss") {
            config.url.clone()
        } else {
            host
        },
        parsed.port().unwrap_or(default_port),
    );
    options.set_keep_alive(StdDuration::from_secs(30));

    match scheme {
        "mqtts" | "ssl" => {
            options.set_transport(Transport::tls_with_default_config());
        }
        "ws" => {
            options.set_transport(Transport::ws());
        }
        "wss" => {
            options.set_transport(Transport::wss_with_default_config());
        }
        _ => {}
    }

    let username = config
        .username
        .clone()
        .or_else(|| (!parsed.username().is_empty()).then(|| parsed.username().to_string()));
    let password = config
        .password
        .clone()
        .or_else(|| parsed.password().map(ToOwned::to_owned));
    if let Some(username) = username {
        options.set_credentials(username, password.unwrap_or_default());
    }

    Ok(options)
}

async fn mqtt_event_loop(db: Db, mut eventloop: rumqttc::EventLoop, status_topic: String) {
    loop {
        match eventloop.poll().await {
            Ok(Event::Incoming(Incoming::Publish(publish))) if publish.topic == status_topic => {
                if let Err(err) = handle_mqtt_status(&db, &publish.payload).await {
                    tracing::warn!(error = ?err, "failed to process MQTT status update");
                }
            }
            Ok(Event::Incoming(Incoming::ConnAck(_))) => {
                tracing::info!("MQTT bridge connected");
            }
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(error = ?err, "MQTT bridge disconnected; retrying");
                tokio::time::sleep(StdDuration::from_secs(2)).await;
            }
        }
    }
}

async fn handle_mqtt_status(db: &Db, payload: &[u8]) -> Result<()> {
    let update: WolStatusUpdate =
        serde_json::from_slice(payload).context("failed to decode MQTT status payload")?;
    let task = update_task_status(db, &update.id, &update.status)
        .await
        .map_err(|err| anyhow::anyhow!(err.to_string()))?;
    tracing::info!(
        task_id = %task.id,
        mac_address = %task.mac_address,
        status = %task.status,
        "WOL task status updated from MQTT"
    );
    Ok(())
}

async fn publish_wol_command(state: &AppState, task: &WolTask) -> Result<(), AppError> {
    let command = WolCommand {
        id: task.id.clone(),
        mac_address: task.mac_address.clone(),
    };
    let payload = serde_json::to_vec(&command)
        .context("failed to encode MQTT WOL command")
        .map_err(AppError::Internal)?;
    state
        .mqtt
        .client
        .publish(
            state.mqtt.command_topic.clone(),
            QoS::AtLeastOnce,
            false,
            payload,
        )
        .await
        .context("failed to publish MQTT WOL command")
        .map_err(AppError::Internal)
}

async fn embedded_static(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    if path.starts_with("api/") {
        return not_found().await;
    }

    if path.is_empty() || path == INDEX_HTML {
        return index_html().await;
    }

    match FrontendAssets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], content.data).into_response()
        }
        None if path.contains('.') => not_found().await,
        None => index_html().await,
    }
}

async fn index_html() -> Response {
    match FrontendAssets::get(INDEX_HTML) {
        Some(content) => Html(content.data).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            "frontend assets are not embedded; run pnpm build:frontend before building the backend",
        )
            .into_response(),
    }
}

async fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            error: "Not found".to_string(),
        }),
    )
        .into_response()
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "service": "wolmgr-backend" }))
}

async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MeResponse>, AppError> {
    let user = get_user_from_session(&state.db, &headers).await?;
    let passkey_count = match &user {
        Some(user) => count_passkeys(&state.db, &user.id).await?,
        None => 0,
    };
    Ok(Json(MeResponse {
        user,
        passkey_count,
    }))
}

async fn github_start(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Redirect, AppError> {
    let client_id = state
        .config
        .github_client_id
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("GitHub OAuth is not configured".to_string()))?;
    let redirect_to = query
        .get("redirectTo")
        .cloned()
        .unwrap_or_else(|| "/".to_string());
    let state_id = nanoid!(24);
    let now = now_ms();

    exec_statement(
        &state.db,
        sql::statement(
            "INSERT INTO oauth_states (id, provider, redirect_to, created_at, expires_at) VALUES (?1, 'github', ?2, ?3, ?4)",
        )
        .bind(state_id.clone())
        .bind(redirect_to)
        .bind(now)
        .bind(now + 1000 * 60 * 10),
    )
    .await?;

    let redirect_uri = format!(
        "{}/api/auth/github/callback",
        state.config.public_origin.trim_end_matches('/')
    );
    let mut github_url = url::Url::parse("https://github.com/login/oauth/authorize").unwrap();
    github_url
        .query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("state", &state_id)
        .append_pair("scope", "read:user user:email");
    Ok(Redirect::temporary(github_url.as_str()))
}

async fn github_callback(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Response, AppError> {
    let client_id = state
        .config
        .github_client_id
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("GitHub OAuth is not configured".to_string()))?;
    let client_secret = state
        .config
        .github_client_secret
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("GitHub OAuth is not configured".to_string()))?;
    let code = query.get("code").cloned().unwrap_or_default();
    let state_id = query.get("state").cloned().unwrap_or_default();
    if code.is_empty() || state_id.is_empty() {
        return Err(AppError::BadRequest("Missing code/state".to_string()));
    }

    let state_row = select_one(
        &state.db,
        sql::query("SELECT redirect_to, expires_at FROM oauth_states WHERE id = ?1 AND provider = 'github' LIMIT 1")
            .bind(state_id.clone())
            .column_types([toasty::stmt::Type::String, toasty::stmt::Type::I64]),
    )
    .await?;
    let Some(row) = state_row else {
        return Err(AppError::BadRequest("Invalid OAuth state".to_string()));
    };
    let redirect_to = value_to_string(row.get(0)).unwrap_or_else(|| "/".to_string());
    let expires_at = value_to_i64(row.get(1)).unwrap_or_default();
    exec_statement(
        &state.db,
        sql::statement("DELETE FROM oauth_states WHERE id = ?1").bind(state_id),
    )
    .await?;
    if expires_at <= now_ms() {
        return Err(AppError::BadRequest("Expired OAuth state".to_string()));
    }

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: Option<String>,
    }
    let redirect_uri = format!(
        "{}/api/auth/github/callback",
        state.config.public_origin.trim_end_matches('/')
    );
    let token: TokenResponse = state
        .http
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "redirect_uri": redirect_uri,
        }))
        .send()
        .await
        .context("failed to exchange GitHub code")?
        .error_for_status()
        .context("GitHub token endpoint returned an error")?
        .json()
        .await
        .context("failed to decode GitHub token response")?;
    let access_token = token
        .access_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest("Missing GitHub access token".to_string()))?;

    #[derive(Deserialize)]
    struct GithubUser {
        id: i64,
        login: String,
        name: Option<String>,
        avatar_url: Option<String>,
    }
    let gh: GithubUser = state
        .http
        .get("https://api.github.com/user")
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("User-Agent", "wolmgr")
        .send()
        .await
        .context("failed to fetch GitHub user")?
        .error_for_status()
        .context("GitHub user endpoint returned an error")?
        .json()
        .await
        .context("failed to decode GitHub user")?;

    let user = upsert_github_user(
        &state.db,
        &gh.id.to_string(),
        &gh.login,
        gh.name,
        gh.avatar_url,
    )
    .await?;
    let session_id = create_session(&state.db, &user.id).await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::LOCATION,
        HeaderValue::from_str(&redirect_to).unwrap_or_else(|_| HeaderValue::from_static("/")),
    );
    headers.append(
        header::SET_COOKIE,
        session_cookie(&session_id, &state.config, Some(SESSION_TTL_MS / 1000))?,
    );
    Ok((StatusCode::FOUND, headers).into_response())
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, AppError> {
    if let Some(session_id) = session_id_from_headers(&headers) {
        exec_statement(
            &state.db,
            sql::statement("DELETE FROM sessions WHERE id = ?1").bind(session_id),
        )
        .await?;
    }
    let mut response = Json(serde_json::json!({ "ok": true })).into_response();
    response
        .headers_mut()
        .append(header::SET_COOKIE, expire_session_cookie(&state.config)?);
    Ok(response)
}

async fn passkey_not_implemented() -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::NotImplemented(
        "Passkey endpoints are reserved for the Rust backend migration and are not implemented yet"
            .to_string(),
    ))
}

async fn list_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = require_user(&state, &headers).await?;
    let devices = get_devices(&state.db, &user.id).await?;
    Ok(Json(serde_json::json!({ "devices": devices })))
}

async fn add_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<AddDeviceRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = require_user(&state, &headers).await?;
    let mac = normalize_mac_address(&input.mac_address)?;
    let name = input
        .name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty());
    let now = now_ms();
    let id = nanoid!(10);
    exec_statement(
        &state.db,
        sql::statement(
            "INSERT INTO devices (id, user_id, name, mac_address, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(user_id, mac_address) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
        )
        .bind(id)
        .bind(user.id.clone())
        .bind(name)
        .bind(mac.clone())
        .bind(now)
        .bind(now),
    )
    .await?;
    let device = get_device_by_mac(&state.db, &user.id, &mac)
        .await?
        .context("failed to load saved device")?;
    Ok(Json(serde_json::json!({ "device": device })))
}

async fn delete_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = require_user(&state, &headers).await?;
    let affected = exec_statement(
        &state.db,
        sql::statement("DELETE FROM devices WHERE id = ?1 AND user_id = ?2")
            .bind(device_id)
            .bind(user.id),
    )
    .await?;
    if affected == 0 {
        return Err(AppError::NotFound("Device not found".to_string()));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn wake_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = require_user(&state, &headers).await?;
    let device = get_device_by_id(&state.db, &user.id, &device_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Device not found".to_string()))?;
    let task = insert_task(
        &state.db,
        &device.mac_address,
        Some(&user.id),
        Some(&device.id),
    )
    .await?;
    publish_wol_command(&state, &task).await?;
    Ok(Json(serde_json::json!({ "task": task })))
}

async fn list_tasks(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = require_user(&state, &headers).await?;
    let tasks = get_tasks_for_user(&state.db, &user.id).await?;
    Ok(Json(serde_json::json!({ "tasks": tasks })))
}

async fn create_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateTaskRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = require_user(&state, &headers).await?;
    let task = insert_task(&state.db, &input.mac_address, Some(&user.id), None).await?;
    publish_wol_command(&state, &task).await?;
    Ok(Json(serde_json::json!({ "task": task })))
}

async fn ensure_schema(db: &mut Db) -> Result<()> {
    let statements = [
        "CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            github_id TEXT UNIQUE,
            github_login TEXT,
            github_name TEXT,
            avatar_url TEXT,
            created_at INTEGER NOT NULL
        )",
        "CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )",
        "CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)",
        "CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)",
        "CREATE TABLE IF NOT EXISTS oauth_states (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            redirect_to TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        )",
        "CREATE INDEX IF NOT EXISTS oauth_states_expires_at_idx ON oauth_states(expires_at)",
        "CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT,
            mac_address TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, mac_address)
        )",
        "CREATE INDEX IF NOT EXISTS devices_user_id_idx ON devices(user_id)",
        "CREATE TABLE IF NOT EXISTS passkeys (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            credential_id TEXT NOT NULL,
            public_key TEXT NOT NULL,
            counter INTEGER NOT NULL,
            transports TEXT,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(credential_id)
        )",
        "CREATE INDEX IF NOT EXISTS passkeys_user_id_idx ON passkeys(user_id)",
        "CREATE TABLE IF NOT EXISTS wol_tasks (
            id TEXT PRIMARY KEY,
            mac_address TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL,
            user_id TEXT,
            device_id TEXT
        )",
        "CREATE INDEX IF NOT EXISTS wol_tasks_status_created_at_idx ON wol_tasks(status, created_at)",
        "CREATE INDEX IF NOT EXISTS wol_tasks_user_id_created_at_idx ON wol_tasks(user_id, created_at)",
    ];
    for statement in statements {
        sql::statement(statement)
            .exec(db as &mut dyn Executor)
            .await?;
    }
    Ok(())
}

async fn get_user_from_session(db: &Db, headers: &HeaderMap) -> Result<Option<User>, AppError> {
    let Some(session_id) = session_id_from_headers(headers) else {
        return Ok(None);
    };
    let row = select_one(
        db,
        sql::query(
            "SELECT u.id, u.github_login, u.github_name, u.avatar_url, s.expires_at
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.id = ?1
             LIMIT 1",
        )
        .bind(session_id.clone())
        .column_types([
            toasty::stmt::Type::String,
            toasty::stmt::Type::String,
            toasty::stmt::Type::String,
            toasty::stmt::Type::String,
            toasty::stmt::Type::I64,
        ]),
    )
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if value_to_i64(row.get(4)).unwrap_or_default() <= now_ms() {
        exec_statement(
            db,
            sql::statement("DELETE FROM sessions WHERE id = ?1").bind(session_id),
        )
        .await?;
        return Ok(None);
    }
    exec_statement(
        db,
        sql::statement("UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2")
            .bind(now_ms())
            .bind(session_id),
    )
    .await?;
    Ok(Some(map_user_row(&row)))
}

async fn require_user(state: &AppState, headers: &HeaderMap) -> Result<User, AppError> {
    get_user_from_session(&state.db, headers)
        .await?
        .ok_or(AppError::Unauthorized)
}

async fn count_passkeys(db: &Db, user_id: &str) -> Result<i64, AppError> {
    let row = select_one(
        db,
        sql::query("SELECT COUNT(1) FROM passkeys WHERE user_id = ?1")
            .bind(user_id.to_string())
            .column_types([toasty::stmt::Type::I64]),
    )
    .await?;
    Ok(row
        .and_then(|row| value_to_i64(row.get(0)))
        .unwrap_or_default())
}

async fn upsert_github_user(
    db: &Db,
    github_id: &str,
    login: &str,
    name: Option<String>,
    avatar_url: Option<String>,
) -> Result<User, AppError> {
    let id = nanoid!(12);
    exec_statement(
        db,
        sql::statement(
            "INSERT INTO users (id, github_id, github_login, github_name, avatar_url, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(github_id) DO UPDATE SET
                github_login = excluded.github_login,
                github_name = excluded.github_name,
                avatar_url = excluded.avatar_url",
        )
        .bind(id)
        .bind(github_id.to_string())
        .bind(login.to_string())
        .bind(name)
        .bind(avatar_url)
        .bind(now_ms()),
    )
    .await?;
    let row = select_one(
        db,
        sql::query("SELECT id, github_login, github_name, avatar_url FROM users WHERE github_id = ?1 LIMIT 1")
            .bind(github_id.to_string())
            .column_types([
                toasty::stmt::Type::String,
                toasty::stmt::Type::String,
                toasty::stmt::Type::String,
                toasty::stmt::Type::String,
            ]),
    )
    .await?
    .context("failed to load GitHub user")?;
    Ok(map_user_row(&row))
}

async fn create_session(db: &Db, user_id: &str) -> Result<String, AppError> {
    let session_id = nanoid!(48);
    let now = now_ms();
    exec_statement(
        db,
        sql::statement(
            "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(session_id.clone())
        .bind(user_id.to_string())
        .bind(now)
        .bind(now + SESSION_TTL_MS)
        .bind(now),
    )
    .await?;
    Ok(session_id)
}

async fn get_devices(db: &Db, user_id: &str) -> Result<Vec<Device>, AppError> {
    let rows = select_rows(
        db,
        sql::query("SELECT id, name, mac_address, created_at, updated_at FROM devices WHERE user_id = ?1 ORDER BY created_at DESC")
            .bind(user_id.to_string())
            .column_types([
                toasty::stmt::Type::String,
                toasty::stmt::Type::String,
                toasty::stmt::Type::String,
                toasty::stmt::Type::I64,
                toasty::stmt::Type::I64,
            ]),
    )
    .await?;
    Ok(rows.iter().map(|row| map_device_row(row)).collect())
}

async fn get_device_by_id(
    db: &Db,
    user_id: &str,
    device_id: &str,
) -> Result<Option<Device>, AppError> {
    let row = select_one(
        db,
        sql::query("SELECT id, name, mac_address, created_at, updated_at FROM devices WHERE id = ?1 AND user_id = ?2 LIMIT 1")
            .bind(device_id.to_string())
            .bind(user_id.to_string())
            .column_types([
                toasty::stmt::Type::String,
                toasty::stmt::Type::String,
                toasty::stmt::Type::String,
                toasty::stmt::Type::I64,
                toasty::stmt::Type::I64,
            ]),
    )
    .await?;
    Ok(row.as_ref().map(|row| map_device_row(row)))
}

async fn get_device_by_mac(db: &Db, user_id: &str, mac: &str) -> Result<Option<Device>, AppError> {
    let row = select_one(
        db,
        sql::query("SELECT id, name, mac_address, created_at, updated_at FROM devices WHERE user_id = ?1 AND mac_address = ?2 LIMIT 1")
            .bind(user_id.to_string())
            .bind(mac.to_string())
            .column_types([
                toasty::stmt::Type::String,
                toasty::stmt::Type::String,
                toasty::stmt::Type::String,
                toasty::stmt::Type::I64,
                toasty::stmt::Type::I64,
            ]),
    )
    .await?;
    Ok(row.as_ref().map(|row| map_device_row(row)))
}

async fn get_tasks_for_user(db: &Db, user_id: &str) -> Result<Vec<WolTask>, AppError> {
    let rows = select_rows(
        db,
        sql::query(
            "SELECT id, mac_address, status, created_at, updated_at, attempts, user_id, device_id
             FROM wol_tasks
             WHERE user_id = ?1
             ORDER BY created_at DESC
             LIMIT 200",
        )
        .bind(user_id.to_string())
        .column_types(task_column_types()),
    )
    .await?;
    Ok(rows.iter().map(|row| map_task_row(row)).collect())
}

async fn get_task_by_id(db: &Db, id: &str) -> Result<Option<WolTask>, AppError> {
    let row = select_one(
        db,
        sql::query(
            "SELECT id, mac_address, status, created_at, updated_at, attempts, user_id, device_id
             FROM wol_tasks
             WHERE id = ?1
             LIMIT 1",
        )
        .bind(id.to_string())
        .column_types(task_column_types()),
    )
    .await?;
    Ok(row.as_ref().map(|row| map_task_row(row)))
}

async fn insert_task(
    db: &Db,
    mac_address: &str,
    user_id: Option<&str>,
    device_id: Option<&str>,
) -> Result<WolTask, AppError> {
    let mac = normalize_mac_address(mac_address)?;
    let now = now_ms();
    let id = nanoid!(8);
    exec_statement(
        db,
        sql::statement(
            "INSERT INTO wol_tasks (id, mac_address, status, created_at, updated_at, attempts, user_id, device_id)
             VALUES (?1, ?2, 'pending', ?3, ?4, 0, ?5, ?6)",
        )
        .bind(id.clone())
        .bind(mac)
        .bind(now)
        .bind(now)
        .bind(user_id.map(ToOwned::to_owned))
        .bind(device_id.map(ToOwned::to_owned)),
    )
    .await?;
    get_task_by_id(db, &id)
        .await?
        .context("failed to load created task")
        .map_err(AppError::from)
}

async fn update_task_status(db: &Db, id: &str, status: &str) -> Result<WolTask, AppError> {
    if !matches!(status, "pending" | "processing" | "success" | "failed") {
        return Err(AppError::BadRequest("Invalid task status".to_string()));
    }
    let task = get_task_by_id(db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("Task not found".to_string()))?;
    let attempts = if status == "processing" {
        task.attempts + 1
    } else {
        task.attempts
    };
    exec_statement(
        db,
        sql::statement(
            "UPDATE wol_tasks SET status = ?1, updated_at = ?2, attempts = ?3 WHERE id = ?4",
        )
        .bind(status.to_string())
        .bind(now_ms())
        .bind(attempts)
        .bind(id.to_string()),
    )
    .await?;
    get_task_by_id(db, id)
        .await?
        .context("failed to load updated task")
        .map_err(AppError::from)
}

async fn exec_statement(db: &Db, statement: sql::Statement) -> Result<u64, AppError> {
    let mut db = db.clone();
    statement
        .exec(&mut db as &mut dyn Executor)
        .await
        .map_err(|err| AppError::Internal(err.into()))
}

async fn select_rows(db: &Db, query: sql::Query) -> Result<Vec<Vec<Value>>, AppError> {
    let mut db = db.clone();
    let rows = query
        .exec(&mut db as &mut dyn Executor)
        .await
        .map_err(|err| AppError::Internal(err.into()))?;
    rows.into_iter()
        .map(|value| match value {
            Value::Record(record) => Ok(record.fields),
            other => Err(AppError::Internal(anyhow::anyhow!(
                "expected record row, got {other:?}"
            ))),
        })
        .collect()
}

async fn select_one(db: &Db, query: sql::Query) -> Result<Option<Vec<Value>>, AppError> {
    Ok(select_rows(db, query).await?.into_iter().next())
}

fn map_user_row(row: &[Value]) -> User {
    User {
        id: value_to_string(row.first()).unwrap_or_default(),
        github_login: value_to_string(row.get(1)).unwrap_or_default(),
        github_name: value_to_optional_string(row.get(2)),
        avatar_url: value_to_optional_string(row.get(3)),
    }
}

fn map_device_row(row: &[Value]) -> Device {
    Device {
        id: value_to_string(row.first()).unwrap_or_default(),
        name: value_to_optional_string(row.get(1)),
        mac_address: value_to_string(row.get(2))
            .unwrap_or_default()
            .to_uppercase(),
        created_at: value_to_i64(row.get(3)).unwrap_or_default(),
        updated_at: value_to_i64(row.get(4)).unwrap_or_default(),
    }
}

fn map_task_row(row: &[Value]) -> WolTask {
    WolTask {
        id: value_to_string(row.first()).unwrap_or_default(),
        mac_address: value_to_string(row.get(1))
            .unwrap_or_default()
            .to_uppercase(),
        status: value_to_string(row.get(2)).unwrap_or_else(|| "pending".to_string()),
        created_at: value_to_i64(row.get(3)).unwrap_or_default(),
        updated_at: value_to_i64(row.get(4)).unwrap_or_default(),
        attempts: value_to_i64(row.get(5)).unwrap_or_default(),
        user_id: value_to_optional_string(row.get(6)),
        device_id: value_to_optional_string(row.get(7)),
    }
}

fn value_to_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::I64(value)) => Some(value.to_string()),
        Some(Value::U64(value)) => Some(value.to_string()),
        Some(Value::Null) | None => None,
        Some(other) => Some(format!("{other:?}")),
    }
}

fn value_to_optional_string(value: Option<&Value>) -> Option<String> {
    value_to_string(value).filter(|value| !value.is_empty())
}

fn value_to_i64(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::I64(value)) => Some(*value),
        Some(Value::I32(value)) => Some((*value).into()),
        Some(Value::U64(value)) => i64::try_from(*value).ok(),
        Some(Value::String(value)) => value.parse().ok(),
        _ => None,
    }
}

fn task_column_types() -> [toasty::stmt::Type; 8] {
    [
        toasty::stmt::Type::String,
        toasty::stmt::Type::String,
        toasty::stmt::Type::String,
        toasty::stmt::Type::I64,
        toasty::stmt::Type::I64,
        toasty::stmt::Type::I64,
        toasty::stmt::Type::String,
        toasty::stmt::Type::String,
    ]
}

fn normalize_mac_address(input: &str) -> Result<String, AppError> {
    let hex: String = input
        .trim()
        .chars()
        .filter(|ch| ch.is_ascii_hexdigit())
        .map(|ch| ch.to_ascii_uppercase())
        .collect();
    if hex.len() != 12 {
        return Err(AppError::BadRequest("Invalid MAC address".to_string()));
    }
    let chunks = (0..6)
        .map(|idx| &hex[idx * 2..idx * 2 + 2])
        .collect::<Vec<_>>();
    Ok(chunks.join(":"))
}

fn session_id_from_headers(headers: &HeaderMap) -> Option<String> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;
    for cookie in Cookie::split_parse(cookie_header) {
        let Ok(cookie) = cookie else {
            continue;
        };
        if cookie.name() == SESSION_COOKIE_NAME {
            return Some(cookie.value().to_string());
        }
    }
    None
}

fn session_cookie(
    value: &str,
    config: &AppConfig,
    max_age_seconds: Option<i64>,
) -> Result<HeaderValue, AppError> {
    let mut cookie = Cookie::build((SESSION_COOKIE_NAME, value.to_string()))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(config.cookie_secure);
    if let Some(max_age_seconds) = max_age_seconds {
        cookie = cookie.max_age(TimeDuration::seconds(max_age_seconds));
    }
    HeaderValue::from_str(&cookie.build().to_string()).map_err(|err| AppError::Internal(err.into()))
}

fn expire_session_cookie(config: &AppConfig) -> Result<HeaderValue, AppError> {
    let cookie = Cookie::build((SESSION_COOKIE_NAME, ""))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(config.cookie_secure)
        .max_age(TimeDuration::seconds(0))
        .expires(OffsetDateTime::UNIX_EPOCH)
        .build()
        .to_string();
    HeaderValue::from_str(&cookie).map_err(|err| AppError::Internal(err.into()))
}

fn env_optional(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn now_ms() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp_nanos() as i64 / 1_000_000
}
