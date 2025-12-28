import { nanoid } from "nanoid";
import type { RouterOSWolResponse, WolTask } from "./shared";

type AssetsFetcher = {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export interface Env extends Cloudflare.Env {
	WOL_DB: D1Database;
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

async function ensureTasksTable(env: Env) {
	if (!tasksTableInitialized) {
		tasksTableInitialized = env.WOL_DB.prepare(TASKS_TABLE_SQL).run().then(() => undefined);
	}
	await tasksTableInitialized;
}

function mapRowToTask(row: Record<string, unknown>): WolTask {
	return {
		id: String(row.id ?? ""),
		macAddress: String(row.mac_address ?? "").toUpperCase(),
		status: (row.status ?? "pending") as WolTask["status"],
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
		attempts: Number(row.attempts ?? 0),
	};
}

async function getTasks(env: Env): Promise<WolTask[]> {
	const result = await env.WOL_DB
		.prepare("SELECT * FROM wol_tasks ORDER BY created_at DESC")
		.all();
	const rows = result.results ?? [];
	return rows.map(mapRowToTask);
}

async function getPendingTasks(env: Env): Promise<RouterOSWolResponse> {
	const result = await env.WOL_DB
		.prepare(
			"SELECT id, mac_address FROM wol_tasks WHERE status = 'pending' ORDER BY created_at DESC",
		)
		.all();
	const rows = result.results ?? [];
	return {
		tasks: rows.map((row) => ({
			macAddress: String(row.mac_address ?? "").toUpperCase(),
			id: String(row.id ?? ""),
		})),
	};
}

async function getTaskById(env: Env, id: string): Promise<WolTask | null> {
	const result = await env.WOL_DB
		.prepare("SELECT * FROM wol_tasks WHERE id = ? LIMIT 1")
		.bind(id)
		.first();
	if (!result?.results?.length) return null;
	return mapRowToTask(result.results[0]);
}

async function getTaskByMac(env: Env, macAddress: string): Promise<WolTask | null> {
	const normalizedMac = macAddress.toUpperCase();
	const result = await env.WOL_DB
		.prepare("SELECT * FROM wol_tasks WHERE mac_address = ? ORDER BY created_at DESC LIMIT 1")
		.bind(normalizedMac)
		.first();
	if (!result?.results?.length) return null;
	return mapRowToTask(result.results[0]);
}

async function persistTask(env: Env, task: WolTask) {
	await env.WOL_DB
		.prepare(
			`INSERT INTO wol_tasks (id, mac_address, status, created_at, updated_at, attempts)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			 mac_address = excluded.mac_address,
			 status = excluded.status,
			 created_at = excluded.created_at,
			 updated_at = excluded.updated_at,
			 attempts = excluded.attempts`,
		)
		.bind(
			task.id,
			task.macAddress,
			task.status,
			task.createdAt,
			task.updatedAt,
			task.attempts,
		)
		.run();
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

async function updateTaskStatus(env: Env, id: string, status: WolTask["status"]): Promise<WolTask | null> {
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

async function notifySuccess(env: Env, payload: { id?: string; macAddress?: string }): Promise<WolTask | null> {
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
		const body = (await request.json()) as { id?: string; status?: WolTask["status"] };
		if (!body?.id || !body?.status) {
			return new Response(JSON.stringify({ error: "id and status are required" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}
		const updatedTask = await updateTaskStatus(env, body.id, body.status);
		if (!updatedTask) {
			return new Response(JSON.stringify({ error: "Task not found or invalid status" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
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

export const onRequest = async ({ request, env }: { request: Request; env: Env }) =>
	handleRequest(request, env);

const worker = {
	async fetch(request: Request, env: Env) {
		return handleRequest(request, env);
	},
} satisfies ExportedHandler<Env>;

export default worker;
