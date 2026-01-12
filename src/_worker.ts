import { type Client, createClient } from "@libsql/client/web";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { nanoid } from "nanoid";
import type { Device, MeResponse, User, WolTask } from "./shared";

type AssetsFetcher = {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export interface Env {
	TURSO_DATABASE_URL: string;
	TURSO_AUTH_TOKEN: string;

	// GitHub OAuth (optional)
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;

	// Optional: protect automation endpoints (RouterOS script / bots)
	WAKER_API_TOKEN?: string;

	ASSETS: AssetsFetcher;
}

const SESSION_COOKIE_NAME = "wolmgr_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

const VALID_TASK_STATUS = new Set<WolTask["status"]>([
	"pending",
	"processing",
	"success",
	"failed",
]);

let schemaInitialized: Promise<void> | null = null;
let cachedClient: Client | null = null;

function getDbClient(env: Env): Client {
	if (cachedClient) return cachedClient;
	const url = String(env.TURSO_DATABASE_URL ?? "").trim();
	const authToken = String(env.TURSO_AUTH_TOKEN ?? "").trim();
	if (!url) throw new Error("Missing TURSO_DATABASE_URL");
	if (!authToken) throw new Error("Missing TURSO_AUTH_TOKEN");
	cachedClient = createClient({ url, authToken });
	return cachedClient;
}

function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("Content-Type", "application/json");
	return new Response(JSON.stringify(data), { ...init, headers });
}

function toNumber(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string") return Number(value);
	return 0;
}

function toText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return String(value);
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
	if (!cookieHeader) return {};
	const out: Record<string, string> = {};
	for (const part of cookieHeader.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		const key = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (!key) continue;
		out[key] = decodeURIComponent(value);
	}
	return out;
}

function makeSetCookie(options: {
	name: string;
	value: string;
	url: URL;
	maxAgeSeconds?: number;
	expires?: Date;
	path?: string;
	httpOnly?: boolean;
	sameSite?: "Lax" | "Strict" | "None";
}): string {
	const parts: string[] = [];
	parts.push(`${options.name}=${encodeURIComponent(options.value)}`);
	parts.push(`Path=${options.path ?? "/"}`);
	if (options.httpOnly !== false) parts.push("HttpOnly");
	if (options.url.protocol === "https:") parts.push("Secure");
	parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
	if (options.maxAgeSeconds != null) parts.push(`Max-Age=${options.maxAgeSeconds}`);
	if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
	return parts.join("; ");
}

function normalizeMacAddress(input: string): string | null {
	const raw = input.trim().toUpperCase();
	const hex = raw.replace(/[^0-9A-F]/g, "");
	if (hex.length !== 12) return null;
	const chunks = hex.match(/.{1,2}/g) ?? [];
	if (chunks.length !== 6) return null;
	return chunks.join(":");
}

function base64urlToBytes(input: string): Uint8Array {
	if (typeof Buffer !== "undefined") {
		const padLen = (4 - (input.length % 4)) % 4;
		const padded = `${input}${"=".repeat(padLen)}`.replace(/-/g, "+").replace(/_/g, "/");
		return new Uint8Array(Buffer.from(padded, "base64"));
	}
	const padLen = (4 - (input.length % 4)) % 4;
	const padded = `${input}${"=".repeat(padLen)}`.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
	return out;
}

function bytesToBase64url(bytes: Uint8Array): string {
	if (typeof Buffer !== "undefined") {
		return Buffer.from(bytes)
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/g, "");
	}
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

async function ensureSchema(env: Env) {
	if (!schemaInitialized) {
		const client = getDbClient(env);
		schemaInitialized = (async () => {
			await client.execute({
				sql: `CREATE TABLE IF NOT EXISTS users (
					id TEXT PRIMARY KEY,
					github_id TEXT UNIQUE,
					github_login TEXT,
					github_name TEXT,
					avatar_url TEXT,
					created_at INTEGER NOT NULL
				)`,
			});
			await client.execute({
				sql: `CREATE TABLE IF NOT EXISTS sessions (
					id TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL,
					last_seen_at INTEGER NOT NULL,
					FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
				)`,
			});
			await client.execute({
				sql: "CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)",
			});
			await client.execute({
				sql: "CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)",
			});
			await client.execute({
				sql: `CREATE TABLE IF NOT EXISTS oauth_states (
					id TEXT PRIMARY KEY,
					provider TEXT NOT NULL,
					redirect_to TEXT,
					created_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL
				)`,
			});
			await client.execute({
				sql: "CREATE INDEX IF NOT EXISTS oauth_states_expires_at_idx ON oauth_states(expires_at)",
			});
			await client.execute({
				sql: `CREATE TABLE IF NOT EXISTS devices (
					id TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					name TEXT,
					mac_address TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
					UNIQUE(user_id, mac_address)
				)`,
			});
			await client.execute({
				sql: "CREATE INDEX IF NOT EXISTS devices_user_id_idx ON devices(user_id)",
			});
			await client.execute({
				sql: `CREATE TABLE IF NOT EXISTS passkeys (
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
				)`,
			});
			await client.execute({
				sql: "CREATE INDEX IF NOT EXISTS passkeys_user_id_idx ON passkeys(user_id)",
			});
			await client.execute({
				sql: `CREATE TABLE IF NOT EXISTS webauthn_states (
					id TEXT PRIMARY KEY,
					purpose TEXT NOT NULL,
					user_id TEXT,
					challenge TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL
				)`,
			});
			await client.execute({
				sql: "CREATE INDEX IF NOT EXISTS webauthn_states_expires_at_idx ON webauthn_states(expires_at)",
			});

			await client.execute({
				sql: `CREATE TABLE IF NOT EXISTS wol_tasks (
					id TEXT PRIMARY KEY,
					mac_address TEXT NOT NULL,
					status TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					attempts INTEGER NOT NULL,
					user_id TEXT,
					device_id TEXT
				)`,
			});
			await ensureColumn(client, "wol_tasks", "user_id", "TEXT");
			await ensureColumn(client, "wol_tasks", "device_id", "TEXT");
			await client.execute({
				sql: "CREATE INDEX IF NOT EXISTS wol_tasks_status_created_at_idx ON wol_tasks(status, created_at)",
			});
			await client.execute({
				sql: "CREATE INDEX IF NOT EXISTS wol_tasks_user_id_created_at_idx ON wol_tasks(user_id, created_at)",
			});
		})();
	}
	await schemaInitialized;
}

async function ensureColumn(
	client: Client,
	table: "wol_tasks",
	column: string,
	columnType: string,
) {
	const res = await client.execute({ sql: `PRAGMA table_info(${table})` });
	const rows = (res.rows ?? []) as Array<Record<string, unknown>>;
	const names = new Set(rows.map((r) => String(r.name ?? "")));
	if (names.has(column)) return;
	await client.execute({ sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${columnType}` });
}

function mapRowToUser(row: Record<string, unknown>): User {
	return {
		id: toText(row.id),
		githubLogin: toText(row.github_login),
		githubName: toText(row.github_name) || undefined,
		avatarUrl: toText(row.avatar_url) || undefined,
	};
}

function mapRowToTask(row: Record<string, unknown>): WolTask {
	return {
		id: toText(row.id),
		macAddress: toText(row.mac_address).toUpperCase(),
		status: (row.status ?? "pending") as WolTask["status"],
		createdAt: toNumber(row.created_at),
		updatedAt: toNumber(row.updated_at),
		attempts: toNumber(row.attempts),
		userId: toText(row.user_id) || undefined,
		deviceId: toText(row.device_id) || undefined,
	};
}

function mapRowToDevice(row: Record<string, unknown>): Device {
	return {
		id: toText(row.id),
		name: toText(row.name) || undefined,
		macAddress: toText(row.mac_address).toUpperCase(),
		createdAt: toNumber(row.created_at),
		updatedAt: toNumber(row.updated_at),
	};
}

async function getUserFromSession(env: Env, request: Request): Promise<User | null> {
	const cookies = parseCookies(request.headers.get("Cookie"));
	const sessionId = cookies[SESSION_COOKIE_NAME];
	if (!sessionId) return null;
	const client = getDbClient(env);
	const now = Date.now();
	const result = await client.execute({
		sql: `SELECT u.id, u.github_login, u.github_name, u.avatar_url, s.expires_at
			FROM sessions s
			JOIN users u ON u.id = s.user_id
			WHERE s.id = ?
			LIMIT 1`,
		args: [sessionId],
	});
	const row = (result.rows?.[0] ?? null) as Record<string, unknown> | null;
	if (!row) return null;
	if (toNumber(row.expires_at) <= now) {
		await client.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [sessionId] });
		return null;
	}
	await client.execute({ sql: "UPDATE sessions SET last_seen_at = ? WHERE id = ?", args: [now, sessionId] });
	return mapRowToUser(row);
}

async function createSession(env: Env, userId: string): Promise<string> {
	const client = getDbClient(env);
	const now = Date.now();
	const sessionId = nanoid(48);
	await client.execute({
		sql: "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
		args: [sessionId, userId, now, now + SESSION_TTL_MS, now],
	});
	return sessionId;
}

async function upsertGithubUser(env: Env, profile: { githubId: string; login: string; name?: string; avatarUrl?: string }): Promise<User> {
	const client = getDbClient(env);
	const now = Date.now();
	const id = nanoid(12);
	await client.execute({
		sql: `INSERT INTO users (id, github_id, github_login, github_name, avatar_url, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(github_id) DO UPDATE SET
				github_login = excluded.github_login,
				github_name = excluded.github_name,
				avatar_url = excluded.avatar_url`,
		args: [id, profile.githubId, profile.login, profile.name ?? null, profile.avatarUrl ?? null, now],
	});
	const res = await client.execute({
		sql: "SELECT id, github_login, github_name, avatar_url FROM users WHERE github_id = ? LIMIT 1",
		args: [profile.githubId],
	});
	const row = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
	if (!row) throw new Error("Failed to upsert GitHub user");
	return mapRowToUser(row);
}

function isAutomationAuthorized(env: Env, request: Request): boolean {
	const token = String(env.WAKER_API_TOKEN ?? "").trim();
	if (!token) return true;
	const auth = request.headers.get("Authorization") ?? "";
	return auth === `Bearer ${token}`;
}

async function getTasksForUser(env: Env, userId: string): Promise<WolTask[]> {
	const client = getDbClient(env);
	const result = await client.execute({
		sql: "SELECT id, mac_address, status, created_at, updated_at, attempts, user_id, device_id FROM wol_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 200",
		args: [userId],
	});
	const rows = (result.rows ?? []) as Record<string, unknown>[];
	return rows.map(mapRowToTask);
}

async function getPendingTasks(env: Env): Promise<{ tasks: { macAddress: string; id: string }[] }> {
	const client = getDbClient(env);
	const result = await client.execute({
		sql: "SELECT id, mac_address FROM wol_tasks WHERE status = 'pending' ORDER BY created_at DESC LIMIT 200",
	});
	const rows = (result.rows ?? []) as Record<string, unknown>[];
	return {
		tasks: rows.map((row) => ({
			macAddress: toText(row.mac_address).toUpperCase(),
			id: toText(row.id),
		})),
	};
}

async function getTaskById(env: Env, id: string): Promise<WolTask | null> {
	const client = getDbClient(env);
	const result = await client.execute({
		sql: "SELECT id, mac_address, status, created_at, updated_at, attempts, user_id, device_id FROM wol_tasks WHERE id = ? LIMIT 1",
		args: [id],
	});
	const row = (result.rows?.[0] ?? null) as Record<string, unknown> | null;
	return row ? mapRowToTask(row) : null;
}

async function persistTask(env: Env, task: WolTask) {
	const client = getDbClient(env);
	await client.execute({
		sql: `INSERT INTO wol_tasks (id, mac_address, status, created_at, updated_at, attempts, user_id, device_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				mac_address = excluded.mac_address,
				status = excluded.status,
				created_at = excluded.created_at,
				updated_at = excluded.updated_at,
				attempts = excluded.attempts,
				user_id = excluded.user_id,
				device_id = excluded.device_id`,
		args: [
			task.id,
			task.macAddress,
			task.status,
			task.createdAt,
			task.updatedAt,
			task.attempts,
			task.userId ?? null,
			task.deviceId ?? null,
		],
	});
}

async function createTask(env: Env, input: { macAddress: string; userId?: string; deviceId?: string }): Promise<WolTask> {
	const mac = normalizeMacAddress(input.macAddress);
	if (!mac) throw new Error("Invalid MAC address");
	const now = Date.now();
	const task: WolTask = {
		id: nanoid(8),
		macAddress: mac,
		status: "pending",
		createdAt: now,
		updatedAt: now,
		attempts: 0,
		userId: input.userId,
		deviceId: input.deviceId,
	};
	await persistTask(env, task);
	return task;
}

async function updateTaskStatus(env: Env, id: string, status: WolTask["status"]): Promise<WolTask | null> {
	if (!VALID_TASK_STATUS.has(status)) return null;
	const task = await getTaskById(env, id);
	if (!task) return null;
	const attempts = status === "processing" ? task.attempts + 1 : task.attempts;
	const updatedTask: WolTask = { ...task, status, updatedAt: Date.now(), attempts };
	await persistTask(env, updatedTask);
	return updatedTask;
}

async function notifySuccess(env: Env, payload: { id?: string; macAddress?: string }): Promise<WolTask | null> {
	const client = getDbClient(env);
	const id = toText(payload.id);
	const mac = payload.macAddress ? normalizeMacAddress(payload.macAddress) : null;
	let row: Record<string, unknown> | null = null;
	if (id) {
		const res = await client.execute({
			sql: "SELECT id, mac_address, status, created_at, updated_at, attempts, user_id, device_id FROM wol_tasks WHERE id = ? LIMIT 1",
			args: [id],
		});
		row = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
	}
	if (!row && mac) {
		const res = await client.execute({
			sql: "SELECT id, mac_address, status, created_at, updated_at, attempts, user_id, device_id FROM wol_tasks WHERE mac_address = ? ORDER BY created_at DESC LIMIT 1",
			args: [mac],
		});
		row = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
	}
	if (!row) return null;
	const task = mapRowToTask(row);
	if (task.status === "success") return task;
	const updatedTask: WolTask = { ...task, status: "success", updatedAt: Date.now() };
	await persistTask(env, updatedTask);
	return updatedTask;
}

async function getDevices(env: Env, userId: string): Promise<Device[]> {
	const client = getDbClient(env);
	const res = await client.execute({
		sql: "SELECT id, name, mac_address, created_at, updated_at FROM devices WHERE user_id = ? ORDER BY created_at DESC",
		args: [userId],
	});
	const rows = (res.rows ?? []) as Record<string, unknown>[];
	return rows.map(mapRowToDevice);
}

async function addDevice(env: Env, userId: string, input: { name?: string; macAddress: string }): Promise<Device> {
	const mac = normalizeMacAddress(input.macAddress);
	if (!mac) throw new Error("Invalid MAC address");
	const name = (input.name ?? "").trim() || null;
	const now = Date.now();
	const id = nanoid(10);
	const client = getDbClient(env);
	await client.execute({
		sql: `INSERT INTO devices (id, user_id, name, mac_address, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, mac_address) DO UPDATE SET
				name = excluded.name,
				updated_at = excluded.updated_at`,
		args: [id, userId, name, mac, now, now],
	});
	const res = await client.execute({
		sql: "SELECT id, name, mac_address, created_at, updated_at FROM devices WHERE user_id = ? AND mac_address = ? LIMIT 1",
		args: [userId, mac],
	});
	const row = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
	if (!row) throw new Error("Failed to create device");
	return mapRowToDevice(row);
}

async function deleteDevice(env: Env, userId: string, deviceId: string): Promise<boolean> {
	const client = getDbClient(env);
	const res = await client.execute({ sql: "DELETE FROM devices WHERE id = ? AND user_id = ?", args: [deviceId, userId] });
	return toNumber(res.rowsAffected) > 0;
}

async function getDeviceById(env: Env, userId: string, deviceId: string): Promise<Device | null> {
	const client = getDbClient(env);
	const res = await client.execute({
		sql: "SELECT id, name, mac_address, created_at, updated_at FROM devices WHERE id = ? AND user_id = ? LIMIT 1",
		args: [deviceId, userId],
	});
	const row = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
	return row ? mapRowToDevice(row) : null;
}

async function countPasskeys(env: Env, userId: string): Promise<number> {
	const client = getDbClient(env);
	const res = await client.execute({ sql: "SELECT COUNT(1) AS cnt FROM passkeys WHERE user_id = ?", args: [userId] });
	const row = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
	return row ? toNumber(row.cnt) : 0;
}

async function createWebauthnState(env: Env, input: { purpose: "register" | "authenticate"; userId?: string; challenge: string; ttlMs: number }): Promise<string> {
	const client = getDbClient(env);
	const id = nanoid(24);
	const now = Date.now();
	await client.execute({
		sql: "INSERT INTO webauthn_states (id, purpose, user_id, challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
		args: [id, input.purpose, input.userId ?? null, input.challenge, now, now + input.ttlMs],
	});
	return id;
}

async function consumeWebauthnState(env: Env, input: { id: string; purpose: "register" | "authenticate" }): Promise<{ userId?: string; challenge: string } | null> {
	const client = getDbClient(env);
	const now = Date.now();
	const res = await client.execute({
		sql: "SELECT id, user_id, challenge, expires_at FROM webauthn_states WHERE id = ? AND purpose = ? LIMIT 1",
		args: [input.id, input.purpose],
	});
	const row = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
	if (!row) return null;
	if (toNumber(row.expires_at) <= now) {
		await client.execute({ sql: "DELETE FROM webauthn_states WHERE id = ?", args: [input.id] });
		return null;
	}
	await client.execute({ sql: "DELETE FROM webauthn_states WHERE id = ?", args: [input.id] });
	const userId = toText(row.user_id);
	return { userId: userId || undefined, challenge: toText(row.challenge) };
}

async function storePasskey(env: Env, userId: string, regInfo: { credentialId: Uint8Array; publicKey: Uint8Array; counter: number; transports?: string[] }) {
	const client = getDbClient(env);
	const now = Date.now();
	await client.execute({
		sql: `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, created_at, last_used_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(credential_id) DO UPDATE SET
				user_id = excluded.user_id,
				public_key = excluded.public_key,
				counter = excluded.counter,
				transports = excluded.transports`,
		args: [
			nanoid(10),
			userId,
			bytesToBase64url(regInfo.credentialId),
			bytesToBase64url(regInfo.publicKey),
			regInfo.counter,
			regInfo.transports ? JSON.stringify(regInfo.transports) : null,
			now,
			now,
		],
	});
}

async function getPasskeyByCredentialId(env: Env, credentialIdB64u: string): Promise<{ userId: string; credentialId: Uint8Array; publicKey: Uint8Array; counter: number; transports?: string[] } | null> {
	const client = getDbClient(env);
	const res = await client.execute({
		sql: "SELECT user_id, credential_id, public_key, counter, transports FROM passkeys WHERE credential_id = ? LIMIT 1",
		args: [credentialIdB64u],
	});
	const row = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
	if (!row) return null;
	return {
		userId: toText(row.user_id),
		credentialId: base64urlToBytes(toText(row.credential_id)),
		publicKey: base64urlToBytes(toText(row.public_key)),
		counter: toNumber(row.counter),
		transports: row.transports ? (JSON.parse(toText(row.transports)) as string[]) : undefined,
	};
}

async function updatePasskeyCounter(env: Env, credentialIdB64u: string, counter: number) {
	const client = getDbClient(env);
	await client.execute({
		sql: "UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?",
		args: [counter, Date.now(), credentialIdB64u],
	});
}

async function handleRequest(request: Request, env: Env) {
	const url = new URL(request.url);
	const pathname = url.pathname;

	// In Pages (advanced mode via dist/_worker.js) every request is routed through this Worker.
	// Avoid hard-requiring the DB for static assets so the UI can still load even if Turso is
	// temporarily unavailable or not configured in local dev.
	if (!pathname.startsWith("/api/")) {
		return env.ASSETS.fetch(request);
	}

	try {
		await ensureSchema(env);
		const user = await getUserFromSession(env, request);
		const client = getDbClient(env);

	if (pathname === "/api/me" && request.method === "GET") {
		const response: MeResponse = {
			user,
			passkeyCount: user ? await countPasskeys(env, user.id) : 0,
		};
		return json(response);
	}

	if (pathname === "/api/auth/github/start" && request.method === "GET") {
		const clientId = String(env.GITHUB_CLIENT_ID ?? "").trim();
		if (!clientId) return json({ error: "GitHub OAuth is not configured" }, { status: 500 });
		const redirectTo = url.searchParams.get("redirectTo") ?? "/";
		const state = nanoid(24);
		const now = Date.now();
		await client.execute({
			sql: "INSERT INTO oauth_states (id, provider, redirect_to, created_at, expires_at) VALUES (?, 'github', ?, ?, ?)",
			args: [state, redirectTo, now, now + 1000 * 60 * 10],
		});
		const redirectUri = `${url.origin}/api/auth/github/callback`;
		const githubUrl = new URL("https://github.com/login/oauth/authorize");
		githubUrl.searchParams.set("client_id", clientId);
		githubUrl.searchParams.set("redirect_uri", redirectUri);
		githubUrl.searchParams.set("state", state);
		githubUrl.searchParams.set("scope", "read:user user:email");
		return Response.redirect(githubUrl.toString(), 302);
	}

	if (pathname === "/api/auth/github/callback" && request.method === "GET") {
		const clientId = String(env.GITHUB_CLIENT_ID ?? "").trim();
		const clientSecret = String(env.GITHUB_CLIENT_SECRET ?? "").trim();
		if (!clientId || !clientSecret) return json({ error: "GitHub OAuth is not configured" }, { status: 500 });
		const code = url.searchParams.get("code") ?? "";
		const state = url.searchParams.get("state") ?? "";
		if (!code || !state) return json({ error: "Missing code/state" }, { status: 400 });

		const stateRes = await client.execute({
			sql: "SELECT redirect_to, expires_at FROM oauth_states WHERE id = ? AND provider = 'github' LIMIT 1",
			args: [state],
		});
		const stateRow = (stateRes.rows?.[0] ?? null) as Record<string, unknown> | null;
		if (!stateRow) return json({ error: "Invalid OAuth state" }, { status: 400 });
		if (toNumber(stateRow.expires_at) <= Date.now()) {
			await client.execute({ sql: "DELETE FROM oauth_states WHERE id = ?", args: [state] });
			return json({ error: "Expired OAuth state" }, { status: 400 });
		}
		const redirectTo = toText(stateRow.redirect_to) || "/";
		await client.execute({ sql: "DELETE FROM oauth_states WHERE id = ?", args: [state] });

		const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				redirect_uri: `${url.origin}/api/auth/github/callback`,
			}),
		});
		if (!tokenRes.ok) {
			const txt = await tokenRes.text().catch(() => "");
			return json({ error: "Failed to exchange GitHub code", details: txt }, { status: 502 });
		}
		const tokenJson = (await tokenRes.json()) as { access_token?: string };
		const accessToken = String(tokenJson.access_token ?? "").trim();
		if (!accessToken) return json({ error: "Missing GitHub access token" }, { status: 502 });

		const userRes = await fetch("https://api.github.com/user", {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${accessToken}`,
				"User-Agent": "wolmgr",
			},
		});
		if (!userRes.ok) {
			const txt = await userRes.text().catch(() => "");
			return json({ error: "Failed to fetch GitHub user", details: txt }, { status: 502 });
		}
		const gh = (await userRes.json()) as { id: number; login: string; name?: string; avatar_url?: string };
		const appUser = await upsertGithubUser(env, {
			githubId: String(gh.id),
			login: String(gh.login ?? ""),
			name: gh.name ? String(gh.name) : undefined,
			avatarUrl: gh.avatar_url ? String(gh.avatar_url) : undefined,
		});

		const sessionId = await createSession(env, appUser.id);
		const headers = new Headers({ Location: redirectTo });
		headers.append(
			"Set-Cookie",
			makeSetCookie({
				name: SESSION_COOKIE_NAME,
				value: sessionId,
				url,
				maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
			}),
		);
		return new Response(null, { status: 302, headers });
	}

	if (pathname === "/api/auth/logout" && request.method === "POST") {
		const cookies = parseCookies(request.headers.get("Cookie"));
		const sessionId = cookies[SESSION_COOKIE_NAME];
		if (sessionId) {
			await client.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [sessionId] });
		}
		const headers = new Headers();
		headers.append(
			"Set-Cookie",
			makeSetCookie({ name: SESSION_COOKIE_NAME, value: "", url, maxAgeSeconds: 0, expires: new Date(0) }),
		);
		return json({ ok: true }, { headers });
	}

	if (pathname === "/api/passkey/register/start" && request.method === "POST") {
		if (!user) return json({ error: "Unauthorized" }, { status: 401 });

		const existingRes = await client.execute({ sql: "SELECT credential_id FROM passkeys WHERE user_id = ?", args: [user.id] });
		const existing = (existingRes.rows ?? []) as Record<string, unknown>[];
		const excludeCredentials = existing
			.map((r) => toText(r.credential_id))
			.filter(Boolean)
			.map((id) => ({ id, type: "public-key" as const }));

		const options = await generateRegistrationOptions({
			rpName: "wolmgr",
			rpID: url.hostname,
			userID: new TextEncoder().encode(user.id),
			userName: user.githubLogin,
			userDisplayName: user.githubName ?? user.githubLogin,
			attestationType: "none",
			excludeCredentials,
			authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
		});
		const stateId = await createWebauthnState(env, { purpose: "register", userId: user.id, challenge: options.challenge, ttlMs: 1000 * 60 * 10 });
		return json({ stateId, options });
	}

	if (pathname === "/api/passkey/register/finish" && request.method === "POST") {
		if (!user) return json({ error: "Unauthorized" }, { status: 401 });
		const body = (await request.json().catch(() => null)) as { stateId?: string; response?: RegistrationResponseJSON } | null;
		if (!body?.stateId || !body.response) return json({ error: "stateId and response are required" }, { status: 400 });
		const state = await consumeWebauthnState(env, { id: body.stateId, purpose: "register" });
		if (!state || state.userId !== user.id) return json({ error: "Invalid/expired state" }, { status: 400 });
		const verification = await verifyRegistrationResponse({
			response: body.response,
			expectedChallenge: state.challenge,
			expectedOrigin: url.origin,
			expectedRPID: url.hostname,
		});
		if (!verification.verified || !verification.registrationInfo) {
			return json({ error: "Registration verification failed" }, { status: 400 });
		}
		const { credential } = verification.registrationInfo;
		await storePasskey(env, user.id, {
			credentialId: base64urlToBytes(credential.id),
			publicKey: new Uint8Array(credential.publicKey),
			counter: credential.counter,
			transports: credential.transports,
		});
		return json({ ok: true });
	}

	if (pathname === "/api/passkey/login/start" && request.method === "POST") {
		const options = await generateAuthenticationOptions({ rpID: url.hostname, userVerification: "preferred" });
		const stateId = await createWebauthnState(env, { purpose: "authenticate", challenge: options.challenge, ttlMs: 1000 * 60 * 10 });
		return json({ stateId, options });
	}

	if (pathname === "/api/passkey/login/finish" && request.method === "POST") {
		const body = (await request.json().catch(() => null)) as { stateId?: string; response?: AuthenticationResponseJSON } | null;
		if (!body?.stateId || !body.response) return json({ error: "stateId and response are required" }, { status: 400 });
		const state = await consumeWebauthnState(env, { id: body.stateId, purpose: "authenticate" });
		if (!state) return json({ error: "Invalid/expired state" }, { status: 400 });
		const credentialIdB64u = body.response.id;
		const pk = await getPasskeyByCredentialId(env, credentialIdB64u);
		if (!pk) return json({ error: "Unknown credential" }, { status: 400 });
		const verification = await verifyAuthenticationResponse({
			response: body.response,
			expectedChallenge: state.challenge,
			expectedOrigin: url.origin,
			expectedRPID: url.hostname,
			credential: {
				id: credentialIdB64u,
				publicKey: new Uint8Array(pk.publicKey),
				counter: pk.counter,
				transports: pk.transports as unknown as NonNullable<
					Parameters<typeof verifyAuthenticationResponse>[0]["credential"]["transports"]
				>,
			},
			requireUserVerification: true,
		});
		if (!verification.verified) return json({ error: "Authentication verification failed" }, { status: 400 });
		if (verification.authenticationInfo?.newCounter != null) {
			await updatePasskeyCounter(env, credentialIdB64u, verification.authenticationInfo.newCounter);
		}
		const sessionId = await createSession(env, pk.userId);
		const headers = new Headers();
		headers.append(
			"Set-Cookie",
			makeSetCookie({ name: SESSION_COOKIE_NAME, value: sessionId, url, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) }),
		);
		return json({ ok: true }, { headers });
	}

	if (pathname === "/api/devices" && request.method === "GET") {
		if (!user) return json({ error: "Unauthorized" }, { status: 401 });
		return json({ devices: await getDevices(env, user.id) });
	}

	if (pathname === "/api/devices" && request.method === "POST") {
		if (!user) return json({ error: "Unauthorized" }, { status: 401 });
		const body = (await request.json().catch(() => null)) as { name?: string; macAddress?: string } | null;
		if (!body?.macAddress) return json({ error: "macAddress is required" }, { status: 400 });
		try {
			const device = await addDevice(env, user.id, { name: body.name, macAddress: body.macAddress });
			return json({ device });
		} catch (err) {
			return json({ error: (err as Error).message || "Failed to add device" }, { status: 400 });
		}
	}

	if (pathname.startsWith("/api/devices/") && request.method === "DELETE") {
		if (!user) return json({ error: "Unauthorized" }, { status: 401 });
		const deviceId = pathname.split("/")[3] ?? "";
		if (!deviceId) return json({ error: "deviceId is required" }, { status: 400 });
		const ok = await deleteDevice(env, user.id, deviceId);
		return ok ? json({ ok: true }) : json({ error: "Device not found" }, { status: 404 });
	}

	if (pathname.startsWith("/api/devices/") && pathname.endsWith("/wake") && request.method === "POST") {
		if (!user) return json({ error: "Unauthorized" }, { status: 401 });
		const deviceId = pathname.split("/")[3] ?? "";
		if (!deviceId) return json({ error: "deviceId is required" }, { status: 400 });
		const device = await getDeviceById(env, user.id, deviceId);
		if (!device) return json({ error: "Device not found" }, { status: 404 });
		const task = await createTask(env, { macAddress: device.macAddress, userId: user.id, deviceId: device.id });
		return json({ task });
	}

	if (pathname === "/api/wol/tasks" && request.method === "GET") {
		if (!user) return json({ error: "Unauthorized" }, { status: 401 });
		return json({ tasks: await getTasksForUser(env, user.id) });
	}

	if (pathname === "/api/wol/tasks" && request.method === "POST") {
		if (!user) return json({ error: "Unauthorized" }, { status: 401 });
		const body = (await request.json().catch(() => null)) as { macAddress?: string } | null;
		if (!body?.macAddress) return json({ error: "macAddress is required" }, { status: 400 });
		try {
			const task = await createTask(env, { macAddress: body.macAddress, userId: user.id });
			return json({ task });
		} catch (err) {
			return json({ error: (err as Error).message || "Failed to queue task" }, { status: 400 });
		}
	}

	if (pathname === "/api/wol/tasks/pending" && request.method === "GET") {
		if (!isAutomationAuthorized(env, request)) return json({ error: "Unauthorized" }, { status: 401 });
		return json(await getPendingTasks(env));
	}

	if (pathname === "/api/wol/tasks" && request.method === "PUT") {
		if (!isAutomationAuthorized(env, request)) return json({ error: "Unauthorized" }, { status: 401 });
		const body = (await request.json().catch(() => null)) as { id?: string; status?: WolTask["status"] } | null;
		if (!body?.id || !body.status) return json({ error: "id and status are required" }, { status: 400 });
		const updatedTask = await updateTaskStatus(env, body.id, body.status);
		if (!updatedTask) return json({ error: "Task not found or invalid status" }, { status: 404 });
		return json({ task: updatedTask });
	}

	if (pathname === "/api/wol/tasks/notify" && request.method === "POST") {
		if (!isAutomationAuthorized(env, request)) return json({ error: "Unauthorized" }, { status: 401 });
		const body = (await request.json().catch(() => null)) as { id?: string; macAddress?: string } | null;
		const task = await notifySuccess(env, body ?? {});
		if (!task) return json({ error: "Task not found" }, { status: 404 });
		return json({ task });
	}

		return env.ASSETS.fetch(request);
	} catch (err) {
		console.error(err);
		const message = err instanceof Error ? err.message : String(err);
		// Surface common misconfiguration errors (safe + helpful for local dev).
		if (message.startsWith("Missing TURSO_")) {
			return json({ error: message }, { status: 500 });
		}
		return json({ error: "Internal Server Error" }, { status: 500 });
	}
}

export const onRequest = async ({ request, env }: { request: Request; env: Env }) =>
	handleRequest(request, env);

const worker = {
	async fetch(request: Request, env: Env) {
		return handleRequest(request, env);
	},
};

export default worker;
