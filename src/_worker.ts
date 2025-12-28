import { nanoid } from "nanoid";
import {
	type Connection,
	routePartykitRequest,
	Server,
	type WSMessage,
} from "partyserver";
import type { Message, RouterOSWolResponse, WolTask } from "./shared";

export class WolManager extends Server<Env> {
	static options = { hibernate: true };

	tasks = [] as WolTask[];

	broadcastMessage(message: Message, exclude?: string[]) {
		this.broadcast(JSON.stringify(message), exclude);
	}

	onStart() {
		// create the wol_tasks table if it doesn't exist
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS wol_tasks (
				id TEXT PRIMARY KEY,
				mac_address TEXT NOT NULL,
				status TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				attempts INTEGER NOT NULL
			)`,
		);

		// load the tasks from the database
		this.tasks = this.ctx.storage.sql
			.exec(`SELECT * FROM wol_tasks`)
			.toArray()
			.map((row: any) => ({
				id: row.id,
				macAddress: row.mac_address,
				status: row.status,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				attempts: row.attempts,
			})) as WolTask[];
	}

	onConnect(connection: Connection) {
		connection.send(
			JSON.stringify({
				type: "all-tasks",
				tasks: this.tasks,
			} satisfies Message),
		);
	}

	saveTask(task: WolTask) {
		// check if the task already exists
		const existingTaskIndex = this.tasks.findIndex((t) => t.id === task.id);
		let messageType: "add-task" | "update-task" = "add-task";

		if (existingTaskIndex >= 0) {
			this.tasks[existingTaskIndex] = task;
			messageType = "update-task";
		} else {
			this.tasks.push(task);
		}

		this.ctx.storage.sql.exec(
			`INSERT INTO wol_tasks (id, mac_address, status, created_at, updated_at, attempts) 
			 VALUES ('${task.id}', '${task.macAddress}', '${task.status}', ${task.createdAt}, ${task.updatedAt}, ${task.attempts}) 
			 ON CONFLICT (id) DO UPDATE SET 
			 mac_address = '${task.macAddress}', 
			 status = '${task.status}', 
			 created_at = ${task.createdAt}, 
			 updated_at = ${task.updatedAt}, 
			 attempts = ${task.attempts}`,
		);

		// broadcast the task to all clients with the appropriate message type
		this.broadcastMessage({
			type: messageType,
			task,
		});
	}

	onMessage(connection: Connection, message: WSMessage) {
		const parsed = JSON.parse(message as string) as Message;
		if (parsed.type === "add-task") {
			this.saveTask(parsed.task);
		} else if (parsed.type === "update-task") {
			this.saveTask(parsed.task);
		}
	}

	// Handle HTTP requests for RouterOS integration
	async fetch(request: Request) {
		const url = new URL(request.url);
		const pathname = url.pathname;

		// Ensure the tasks are loaded
		await this.onStart();

		// RouterOS API endpoint to get pending WOL tasks
		if (pathname === "/api/wol/tasks" && request.method === "GET") {
			// Get pending tasks
			const pendingTasks = this.tasks.filter(
				(task) => task.status === "pending",
			);

			// Format response for RouterOS
			const response: RouterOSWolResponse = {
				tasks: pendingTasks.map((task) => ({
					macAddress: task.macAddress,
					id: task.id,
				})),
			};

			return new Response(JSON.stringify(response), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// API endpoint to update task status
		if (pathname === "/api/wol/tasks" && request.method === "PUT") {
			const body = (await request.json()) as {
				id: string;
				status: WolTask["status"];
			};
			const { id, status } = body;

			if (!id || !status) {
				return new Response(JSON.stringify({ error: "Missing id or status" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}

			// Find the task
			const task = this.tasks.find((t) => t.id === id);
			if (!task) {
				return new Response(JSON.stringify({ error: "Task not found" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				});
			}

			// Update task status
			const updatedTask: WolTask = {
				...task,
				status: status,
				updatedAt: Date.now(),
				attempts: status === "processing" ? task.attempts + 1 : task.attempts,
			};

			this.saveTask(updatedTask);

			return new Response(
				JSON.stringify({ success: true, task: updatedTask }),
				{
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		return new Response(JSON.stringify({ error: "Not found" }), {
			status: 404,
			headers: { "Content-Type": "application/json" },
		});
	}
}

// Handle HTTP requests for RouterOS integration
export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const pathname = url.pathname;

		// Create a durable object ID for the default room
		const id = env.Chat.idFromName("default");
		// Get the stub for the durable object
		const stub = env.Chat.get(id);

		// RouterOS API endpoint to get pending WOL tasks
		if (pathname === "/api/wol/tasks" && request.method === "GET") {
			// Forward the request to the durable object
			return await stub.fetch(
				new Request(request.url, {
					method: "GET",
					headers: request.headers,
				}),
			);
		}

		// API endpoint to update task status
		if (pathname === "/api/wol/tasks" && request.method === "PUT") {
			// Forward the request to the durable object
			return await stub.fetch(
				new Request(request.url, {
					method: "PUT",
					headers: request.headers,
					body: request.body,
				}),
			);
		}

		// Handle PartyKit WebSocket requests
		return (
			(await routePartykitRequest(request, { ...env })) ||
			env.ASSETS.fetch(request)
		);
	},
} satisfies ExportedHandler<Env>;
