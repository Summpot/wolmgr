import { nanoid } from "nanoid";
import { usePartySocket } from "partysocket/react";
import type React from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Message, WolTask } from "./shared";

import "./index.css";

function App() {
	const [tasks, setTasks] = useState<WolTask[]>([]);
	const [macAddress, setMacAddress] = useState("");
	const [error, setError] = useState("");

	const socket = usePartySocket({
		party: "chat",
		room: "default",
		onMessage: (evt) => {
			const message = JSON.parse(evt.data as string) as Message;
			if (message.type === "all-tasks") {
				setTasks(message.tasks);
			} else if (message.type === "add-task") {
				setTasks((prevTasks) => [...prevTasks, message.task]);
			} else if (message.type === "update-task") {
				setTasks((prevTasks) =>
					prevTasks.map((task) =>
						task.id === message.task.id ? message.task : task,
					),
				);
			}
		},
	});

	const validateMacAddress = (mac: string): boolean => {
		const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
		return macRegex.test(mac);
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError("");

		if (!validateMacAddress(macAddress)) {
			setError("Invalid MAC address format. Please use XX:XX:XX:XX:XX:XX");
			return;
		}

		const newTask: WolTask = {
			id: nanoid(8),
			macAddress: macAddress.toUpperCase(),
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			attempts: 0,
		};

		socket.send(
			JSON.stringify({
				type: "add-task",
				task: newTask,
			} satisfies Message),
		);

		setMacAddress("");
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
								className="w-full bg-blue-500 hover:bg-blue-600 text-white font-medium py-2 px-4 rounded-md transition-colors"
							>
								Wake Device
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
