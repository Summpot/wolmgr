use std::{env, net::SocketAddr, path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
    routing::{delete, get, post},
};
use cookie::{Cookie, SameSite};
use nanoid::nanoid;
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};
use toasty::{Db, Executor, sql, stmt::Value};
use tower_http::{
    cors::{Any, CorsLayer},
    services::ServeDir,
    trace::TraceLayer,
};
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

const SESSION_COOKIE_NAME: &str = "wolmgr_session";
const SESSION_TTL_MS: i64 = 1000 * 60 * 60 * 24 * 30;

#[derive(Clone)]
struct AppState {
    db: Db,
    http: HttpClient,
    config: Arc<AppConfig>,
}

#[derive(Debug)]
struct AppConfig {
    public_origin: String,
    github_client_id: Option<String>,
    github_client_secret: Option<String>,
    broker_api_token: Option<String>,
    cookie_secure: bool,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTaskRequest {
    id: String,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotifyTaskRequest {
    id: Option<String>,
    mac_address: Option<String>,
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
    let static_dir = env_optional("STATIC_DIR").map(PathBuf::from);
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
        broker_api_token: env_optional("BROKER_API_TOKEN"),
    };

    let state = AppState {
        db,
        http: HttpClient::new(),
        config: Arc::new(config),
    };

    let api = api_router().with_state(state);
    let app = if let Some(static_dir) = static_dir {
        api.fallback_service(ServeDir::new(static_dir))
    } else {
        api
    }
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
        .route(
            "/api/wol/tasks",
            get(list_tasks).post(create_task).put(update_task),
        )
        .route("/api/wol/tasks/pending", get(pending_tasks))
        .route("/api/wol/tasks/notify", post(notify_task))
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
    Ok(Json(serde_json::json!({ "task": task })))
}

async fn pending_tasks(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    require_broker(&state, &headers)?;
    let rows = select_rows(
        &state.db,
        sql::query("SELECT id, mac_address FROM wol_tasks WHERE status = 'pending' ORDER BY created_at DESC LIMIT 200")
            .column_types([toasty::stmt::Type::String, toasty::stmt::Type::String]),
    )
    .await?;
    let tasks: Vec<_> = rows
        .iter()
        .map(|row| {
            serde_json::json!({
                "id": value_to_string(row.get(0)).unwrap_or_default(),
                "macAddress": value_to_string(row.get(1)).unwrap_or_default().to_uppercase(),
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "tasks": tasks })))
}

async fn update_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UpdateTaskRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_broker(&state, &headers)?;
    let task = update_task_status(&state.db, &input.id, &input.status).await?;
    Ok(Json(serde_json::json!({ "task": task })))
}

async fn notify_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<NotifyTaskRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_broker(&state, &headers)?;
    let task = notify_success(&state.db, input).await?;
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

fn require_broker(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let Some(token) = &state.config.broker_api_token else {
        return Ok(());
    };
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if auth == format!("Bearer {token}") {
        Ok(())
    } else {
        Err(AppError::Unauthorized)
    }
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

async fn notify_success(db: &Db, input: NotifyTaskRequest) -> Result<WolTask, AppError> {
    let task = if let Some(id) = input.id.filter(|id| !id.trim().is_empty()) {
        get_task_by_id(db, &id).await?
    } else if let Some(mac) = input.mac_address {
        let mac = normalize_mac_address(&mac)?;
        let row = select_one(
            db,
            sql::query(
                "SELECT id, mac_address, status, created_at, updated_at, attempts, user_id, device_id
                 FROM wol_tasks
                 WHERE mac_address = ?1
                 ORDER BY created_at DESC
                 LIMIT 1",
            )
            .bind(mac)
            .column_types(task_column_types()),
        )
        .await?;
        row.as_ref().map(|row| map_task_row(row))
    } else {
        None
    };
    let task = task.ok_or_else(|| AppError::NotFound("Task not found".to_string()))?;
    if task.status == "success" {
        return Ok(task);
    }
    exec_statement(
        db,
        sql::statement("UPDATE wol_tasks SET status = 'success', updated_at = ?1 WHERE id = ?2")
            .bind(now_ms())
            .bind(task.id.clone()),
    )
    .await?;
    get_task_by_id(db, &task.id)
        .await?
        .context("failed to load notified task")
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
        cookie = cookie.max_age(Duration::seconds(max_age_seconds));
    }
    HeaderValue::from_str(&cookie.build().to_string()).map_err(|err| AppError::Internal(err.into()))
}

fn expire_session_cookie(config: &AppConfig) -> Result<HeaderValue, AppError> {
    let cookie = Cookie::build((SESSION_COOKIE_NAME, ""))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(config.cookie_secure)
        .max_age(Duration::seconds(0))
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
