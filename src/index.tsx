import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WolTask } from "./shared";

import "./index.css";

function App() {
	const [tasks, setTasks] = useState<WolTask[]>([]);
	const [macAddress, setMacAddress] = useState("");
	const [error, setError] = useState("");

	const [isSubmitting, setIsSubmitting] = useState(false);

	const fetchTasks = useCallback(async () => {
		try {
			const response = await fetch("/api/wol/tasks");
			if (!response.ok) {
				throw new Error("Failed to load tasks");
			}
			const data = (await response.json()) as { tasks?: WolTask[] };
			setTasks(data.tasks ?? []);
		} catch (err) {
			console.error(err);
			setError("Unable to load wake tasks right now.");
		}
	}, []);

	useEffect(() => {
		fetchTasks();
		const intervalId = setInterval(fetchTasks, 5000);
		return () => clearInterval(intervalId);
	}, [fetchTasks]);

	const validateMacAddress = (mac: string): boolean => {
		const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
		return macRegex.test(mac);
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");

		if (!validateMacAddress(macAddress)) {
			setError("Invalid MAC address format. Please use XX:XX:XX:XX:XX:XX");
			return;
		}

		setIsSubmitting(true);
		try {
			const response = await fetch("/api/wol/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ macAddress: macAddress.toUpperCase() }),
			});
			if (!response.ok) {
				const payload = await response.json().catch(() => null);
				setError(payload?.error ?? "Failed to queue the wake task.");
				return;
			}
			await fetchTasks();
			setMacAddress("");
		} catch (err) {
			console.error(err);
			setError("Unable to queue the task. Please try again.");
		} finally {
			setIsSubmitting(false);
		}
	};

	const getStatusBadgeClass = (status: string): string => {
		switch (status) {
			case "pending":
				return "bg-yellow-100 text-yellow-800";
			case "processing":
				return "bg-blue-100 text-blue-800";
			case "success":
				return "bg-green-100 text-green-800";
			case "failed":
				return "bg-red-100 text-red-800";
			default:
				return "bg-gray-100 text-gray-800";
		}
	};

	const formatDate = (timestamp: number): string => {
		return new Date(timestamp).toLocaleString();
	};

	return (
		<div className="max-w-7xl mx-auto px-4 py-8">
			<h1 className="text-3xl font-bold text-gray-800 mb-8 text-center">
				WOL Wake-on-LAN Manager
			</h1>

			<div className="bg-white shadow-md rounded-lg p-6 mb-8">
				<form onSubmit={handleSubmit} className="space-y-4">
					<div className="flex gap-4">
						<div className="flex-1">
							<input
								type="text"
								value={macAddress}
								onChange={(e) => setMacAddress(e.target.value)}
								placeholder="Enter MAC address (XX:XX:XX:XX:XX:XX)"
								className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
								autoComplete="off"
							/>
						</div>
						<div className="w-32">
							<button
								type="submit"
								disabled={isSubmitting}
								className={`w-full bg-blue-500 hover:bg-blue-600 text-white font-medium py-2 px-4 rounded-md transition-colors ${
									isSubmitting ? "opacity-50 cursor-not-allowed" : ""
								}`}
							>
								{isSubmitting ? "Queueing..." : "Wake Device"}
							</button>
						</div>
					</div>
					{error && <p className="text-red-500 text-sm mt-2">{error}</p>}
				</form>
			</div>

			<div className="bg-white shadow-md rounded-lg p-6">
				<h2 className="text-xl font-semibold text-gray-800 mb-4">Wake Tasks</h2>
				<div className="overflow-x-auto">
					<table className="w-full text-left">
						<thead className="bg-gray-50 border-b">
							<tr>
								<th className="px-4 py-3 text-sm font-medium text-gray-600">
									MAC Address
								</th>
								<th className="px-4 py-3 text-sm font-medium text-gray-600">
									Status
								</th>
								<th className="px-4 py-3 text-sm font-medium text-gray-600">
									Attempts
								</th>
								<th className="px-4 py-3 text-sm font-medium text-gray-600">
									Created At
								</th>
								<th className="px-4 py-3 text-sm font-medium text-gray-600">
									Updated At
								</th>
							</tr>
						</thead>
						<tbody>
							{tasks.length === 0 ? (
								<tr className="border-b">
									<td
										colSpan={5}
										className="px-4 py-8 text-center text-gray-500"
									>
										No wake tasks yet
									</td>
								</tr>
							) : (
								tasks.map((task) => (
									<tr key={task.id} className="border-b hover:bg-gray-50">
										<td className="px-4 py-3 text-gray-700 font-mono">
											{task.macAddress}
										</td>
										<td className="px-4 py-3">
											<span
												className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusBadgeClass(task.status)}`}
											>
												{task.status}
											</span>
										</td>
										<td className="px-4 py-3 text-gray-700">{task.attempts}</td>
										<td className="px-4 py-3 text-gray-600 text-sm">
											{formatDate(task.createdAt)}
										</td>
										<td className="px-4 py-3 text-gray-600 text-sm">
											{formatDate(task.updatedAt)}
										</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(<App />);
