import dgram from "node:dgram";
import process from "node:process";
import { createClient } from "@libsql/client";
import RouterOSClient from "ros-client";

type PendingTask = {
	id: string;
	macAddress: string;
};

const TASKS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS wol_tasks (
	id TEXT PRIMARY KEY,
	mac_address TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	attempts INTEGER NOT NULL
)`;

function env(name: string, fallback?: string): string {
	const value = process.env[name];
	if (value == null || value.trim() === "") {
		if (fallback != null) return fallback;
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
}

function envOptional(name: string): string | undefined {
	const value = process.env[name];
	if (value == null) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
	if (!value) return fallback;
	return (
		value === "1" ||
		value.toLowerCase() === "true" ||
		value.toLowerCase() === "yes"
	);
}

function parseIntEnv(name: string, fallback: number): number {
	const value = envOptional(name);
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeMac(mac: string): string {
	return mac.trim().toUpperCase();
}

function macToBytes(mac: string): Uint8Array {
	const cleaned = mac.replace(/[^0-9A-Fa-f]/g, "");
	if (cleaned.length !== 12) {
		throw new Error(`Invalid MAC address: ${mac}`);
	}
	const bytes = new Uint8Array(6);
	for (let i = 0; i < 6; i += 1) {
		bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function buildWolMagicPacket(mac: string): Uint8Array {
	const macBytes = macToBytes(mac);
	const packet = new Uint8Array(6 + 16 * 6);
	packet.fill(0xff, 0, 6);
	for (let i = 0; i < 16; i += 1) {
		packet.set(macBytes, 6 + i * 6);
	}
	return packet;
}

async function sendWolBroadcast(options: {
	macAddress: string;
	broadcastAddress: string;
	port: number;
}): Promise<void> {
	const packet = buildWolMagicPacket(options.macAddress);
	const socket = dgram.createSocket("udp4");

	await new Promise<void>((resolve, reject) => {
		socket.once("error", (err) => {
			socket.close();
			reject(err);
		});

		socket.bind(0, () => {
			try {
				socket.setBroadcast(true);
				socket.send(packet, options.port, options.broadcastAddress, (err) => {
					socket.close();
					if (err) reject(err);
					else resolve();
				});
			} catch (err) {
				socket.close();
				reject(err);
			}
		});
	});
}

async function sendWolViaRouterOS(options: {
	macAddress: string;
	interfaceName?: string;
}): Promise<void> {
	const host = env("ROUTEROS_HOST");
	const username = env("ROUTEROS_USER");
	const password = env("ROUTEROS_PASSWORD");
	const port = parseIntEnv("ROUTEROS_PORT", 8728);
	const tls = parseBool(envOptional("ROUTEROS_TLS"), false);
	const timeout = parseIntEnv("ROUTEROS_TIMEOUT_MS", 10_000);

	const api = new RouterOSClient({
		host,
		username,
		password,
		port,
		tls,
		timeout,
	});

	try {
		await api.connect();

		const words: string[] = ["/tool/wol", `=mac=${options.macAddress}`];
		if (options.interfaceName) {
			words.push(`=interface=${options.interfaceName}`);
		}
		await api.send(words);
	} finally {
		try {
			await api.close();
		} catch {
			// ignore
		}
	}
}

async function main() {
	const tursoUrl = env("TURSO_DATABASE_URL");
	const tursoToken = env("TURSO_AUTH_TOKEN");

	// Polling defaults to 10 seconds as requested.
	const pollIntervalMs = parseIntEnv("POLL_INTERVAL_MS", 10_000);
	const claimLimit = parseIntEnv("CLAIM_LIMIT", 50);

	const broadcastAddress =
		envOptional("WOL_BROADCAST_ADDR") ?? "255.255.255.255";
	const wolPort = parseIntEnv("WOL_PORT", 9);

	const routerosHost = envOptional("ROUTEROS_HOST");
	const routerosUser = envOptional("ROUTEROS_USER");
	const routerosPassword = envOptional("ROUTEROS_PASSWORD");
	const routerosConfigured = Boolean(
		routerosHost && routerosUser && routerosPassword,
	);
	const routerosEnabled = parseBool(
		envOptional("ROUTEROS_ENABLED"),
		routerosConfigured,
	);
	const routerosInterface = envOptional("ROUTEROS_WOL_INTERFACE");

	const client = createClient({ url: tursoUrl, authToken: tursoToken });
	await client.execute({ sql: TASKS_TABLE_SQL });

	async function claimPendingTasks(): Promise<PendingTask[]> {
		const now = Date.now();
		const result = await client.execute({
			sql: `UPDATE wol_tasks
				SET status = 'processing', updated_at = ?, attempts = attempts + 1
				WHERE id IN (
					SELECT id FROM wol_tasks
					WHERE status = 'pending'
					ORDER BY created_at DESC
					LIMIT ?
				)
				RETURNING id, mac_address`,
			args: [now, claimLimit],
		});

		const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			id: String(row.id ?? ""),
			macAddress: normalizeMac(String(row.mac_address ?? "")),
		}));
	}

	async function setStatus(id: string, status: "success" | "failed") {
		await client.execute({
			sql: "UPDATE wol_tasks SET status = ?, updated_at = ? WHERE id = ?",
			args: [status, Date.now(), id],
		});
	}

	let shuttingDown = false;
	process.on("SIGINT", () => {
		shuttingDown = true;
	});
	process.on("SIGTERM", () => {
		shuttingDown = true;
	});

	console.log(
		JSON.stringify(
			{
				service: "wolmgr-waker",
				pollIntervalMs,
				claimLimit,
				routerosEnabled,
				broadcastAddress,
				wolPort,
			},
			null,
			2,
		),
	);

	while (!shuttingDown) {
		let tasks: PendingTask[] = [];
		try {
			tasks = await claimPendingTasks();
		} catch (err) {
			console.error("Failed to claim tasks:", err);
		}

		for (const task of tasks) {
			try {
				if (routerosEnabled) {
					await sendWolViaRouterOS({
						macAddress: task.macAddress,
						interfaceName: routerosInterface,
					});
				} else {
					await sendWolBroadcast({
						macAddress: task.macAddress,
						broadcastAddress,
						port: wolPort,
					});
				}

				await setStatus(task.id, "success");
				console.log(`WOL sent: ${task.macAddress} (task ${task.id})`);
			} catch (err) {
				console.error(`WOL failed: ${task.macAddress} (task ${task.id})`, err);
				try {
					await setStatus(task.id, "failed");
				} catch (updateErr) {
					console.error(`Failed to mark task failed: ${task.id}`, updateErr);
				}
			}
		}

		if (shuttingDown) break;
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	console.log("waker exiting");
}

await main();
