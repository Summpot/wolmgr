import { type Client, createClient } from "@libsql/client/web";
import { nanoid } from "nanoid";
import type { RouterOSWolResponse, WolTask } from "./shared";

type AssetsFetcher = {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export interface Env {
	TURSO_DATABASE_URL: string;
	TURSO_AUTH_TOKEN: string;
	ASSETS: AssetsFetcher;
}

const TASKS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS wol_tasks (
	id TEXT PRIMARY KEY,
	mac_address TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	attempts INTEGER NOT NULL
)`;

const VALID_STATUS = new Set<WolTask["status"]>([
	"pending",
	"processing",
	"success",
	"failed",
]);

let tasksTableInitialized: Promise<void> | null = null;

let cachedClient: Client | null = null;

function getDbClient(env: Env): Client {
	if (cachedClient) return cachedClient;
	const url = String(env.TURSO_DATABASE_URL ?? "").trim();
	const authToken = String(env.TURSO_AUTH_TOKEN ?? "").trim();
	if (!url) {
		throw new Error("Missing TURSO_DATABASE_URL");
	}
	if (!authToken) {
		throw new Error("Missing TURSO_AUTH_TOKEN");
	}
	cachedClient = createClient({ url, authToken });
	return cachedClient;
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

async function ensureTasksTable(env: Env) {
	if (!tasksTableInitialized) {
		const client = getDbClient(env);
		tasksTableInitialized = client
			.execute({ sql: TASKS_TABLE_SQL })
			.then(() => undefined);
	}
	await tasksTableInitialized;
}

function mapRowToTask(row: Record<string, unknown>): WolTask {
	return {
		id: toText(row.id),
		macAddress: toText(row.mac_address).toUpperCase(),
		status: (row.status ?? "pending") as WolTask["status"],
		createdAt: toNumber(row.created_at),
		updatedAt: toNumber(row.updated_at),
		attempts: toNumber(row.attempts),
	};
}

async function getTasks(env: Env): Promise<WolTask[]> {
	const client = getDbClient(env);
	const result = await client.execute({
		sql: "SELECT id, mac_address, status, created_at, updated_at, attempts FROM wol_tasks ORDER BY created_at DESC",
	});
	const rows = (result.rows ?? []) as Record<string, unknown>[];
	return rows.map(mapRowToTask);
}

async function getPendingTasks(env: Env): Promise<RouterOSWolResponse> {
	const client = getDbClient(env);
	const result = await client.execute({
		sql: "SELECT id, mac_address FROM wol_tasks WHERE status = 'pending' ORDER BY created_at DESC",
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
		sql: "SELECT id, mac_address, status, created_at, updated_at, attempts FROM wol_tasks WHERE id = ? LIMIT 1",
		args: [id],
	});
	const row = (result.rows?.[0] ?? null) as Record<string, unknown> | null;
	if (!row) return null;
	return mapRowToTask(row);
}

async function getTaskByMac(
	env: Env,
	macAddress: string,
): Promise<WolTask | null> {
	const normalizedMac = macAddress.toUpperCase();
	const client = getDbClient(env);
	const result = await client.execute({
		sql: "SELECT id, mac_address, status, created_at, updated_at, attempts FROM wol_tasks WHERE mac_address = ? ORDER BY created_at DESC LIMIT 1",
		args: [normalizedMac],
	});
	const row = (result.rows?.[0] ?? null) as Record<string, unknown> | null;
	if (!row) return null;
	return mapRowToTask(row);
}

async function persistTask(env: Env, task: WolTask) {
	const client = getDbClient(env);
	await client.execute({
		sql: `INSERT INTO wol_tasks (id, mac_address, status, created_at, updated_at, attempts)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				mac_address = excluded.mac_address,
				status = excluded.status,
				created_at = excluded.created_at,
				updated_at = excluded.updated_at,
				attempts = excluded.attempts`,
		args: [
			task.id,
			task.macAddress,
			task.status,
			task.createdAt,
			task.updatedAt,
			task.attempts,
		],
	});
}

async function createTask(env: Env, macAddress: string): Promise<WolTask> {
	const normalizedMac = macAddress.toUpperCase();
	const now = Date.now();
	const task: WolTask = {
		id: nanoid(8),
		macAddress: normalizedMac,
		status: "pending",
		createdAt: now,
		updatedAt: now,
		attempts: 0,
	};
	await persistTask(env, task);
	return task;
}

async function updateTaskStatus(
	env: Env,
	id: string,
	status: WolTask["status"],
): Promise<WolTask | null> {
	if (!VALID_STATUS.has(status)) return null;
	const task = await getTaskById(env, id);
	if (!task) return null;
	const attempts = status === "processing" ? task.attempts + 1 : task.attempts;
	const updatedTask: WolTask = {
		...task,
		status,
		updatedAt: Date.now(),
		attempts,
	};
	await persistTask(env, updatedTask);
	return updatedTask;
}

async function notifySuccess(
	env: Env,
	payload: { id?: string; macAddress?: string },
): Promise<WolTask | null> {
	const { id, macAddress } = payload;
	if (!id && !macAddress) return null;
	let task: WolTask | null = null;
	if (id) task = await getTaskById(env, id);
	if (!task && macAddress) task = await getTaskByMac(env, macAddress);
	if (!task) return null;
	if (task.status === "success") return task;
	const updatedTask: WolTask = {
		...task,
		status: "success",
		updatedAt: Date.now(),
	};
	await persistTask(env, updatedTask);
	return updatedTask;
}

async function handleRequest(request: Request, env: Env) {
	const url = new URL(request.url);
	const pathname = url.pathname;
	await ensureTasksTable(env);

	if (pathname === "/api/wol/tasks/pending" && request.method === "GET") {
		const response = await getPendingTasks(env);
		return new Response(JSON.stringify(response), {
			headers: { "Content-Type": "application/json" },
		});
	}

	if (pathname === "/api/wol/tasks" && request.method === "GET") {
		const tasks = await getTasks(env);
		return new Response(JSON.stringify({ tasks }), {
			headers: { "Content-Type": "application/json" },
		});
	}

	if (pathname === "/api/wol/tasks" && request.method === "POST") {
		const body = (await request.json()) as { macAddress?: string };
		if (!body?.macAddress) {
			return new Response(JSON.stringify({ error: "macAddress is required" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}
		const task = await createTask(env, body.macAddress);
		return new Response(JSON.stringify({ task }), {
			headers: { "Content-Type": "application/json" },
		});
	}

	if (pathname === "/api/wol/tasks" && request.method === "PUT") {
		const body = (await request.json()) as {
			id?: string;
			status?: WolTask["status"];
		};
		if (!body?.id || !body?.status) {
			return new Response(
				JSON.stringify({ error: "id and status are required" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		const updatedTask = await updateTaskStatus(env, body.id, body.status);
		if (!updatedTask) {
			return new Response(
				JSON.stringify({ error: "Task not found or invalid status" }),
				{
					status: 404,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		return new Response(JSON.stringify({ task: updatedTask }), {
			headers: { "Content-Type": "application/json" },
		});
	}

	if (pathname === "/api/wol/tasks/notify" && request.method === "POST") {
		const body = (await request.json()) as { id?: string; macAddress?: string };
		const task = await notifySuccess(env, body ?? {});
		if (!task) {
			return new Response(JSON.stringify({ error: "Task not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ task }), {
			headers: { "Content-Type": "application/json" },
		});
	}

	return env.ASSETS.fetch(request);
}

export const onRequest = async ({
	request,
	env,
}: {
	request: Request;
	env: Env;
}) => handleRequest(request, env);

const worker = {
	async fetch(request: Request, env: Env) {
		return handleRequest(request, env);
	},
};

export default worker;
