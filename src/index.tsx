import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WolTask } from "./shared";

import "./index.css";

const Icons = {
	Zap: () => (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className="w-5 h-5"
		>
			<title>Wake</title>
			<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
		</svg>
	),
	Refresh: ({ className }: { className?: string }) => (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
		>
			<title>Refresh</title>
			<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
			<path d="M3 3v5h5" />
			<path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
			<path d="M16 16h5v5" />
		</svg>
	),
	Server: () => (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className="w-8 h-8 text-blue-600"
		>
			<title>Server</title>
			<rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
			<rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
			<line x1="6" y1="6" x2="6.01" y2="6" />
			<line x1="6" y1="18" x2="6.01" y2="18" />
		</svg>
	),
	AlertCircle: () => (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className="w-5 h-5 text-red-500"
		>
			<title>Error</title>
			<circle cx="12" cy="12" r="10" />
			<line x1="12" y1="8" x2="12" y2="12" />
			<line x1="12" y1="16" x2="12.01" y2="16" />
		</svg>
	),
	CheckCircle: () => (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<title>Success</title>
			<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
			<polyline points="22 4 12 14.01 9 11.01" />
		</svg>
	),
	Clock: () => (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<title>Pending</title>
			<circle cx="12" cy="12" r="10" />
			<polyline points="12 6 12 12 16 14" />
		</svg>
	),
	Activity: () => (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<title>Processing</title>
			<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
		</svg>
	),
	XCircle: () => (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<title>Failed</title>
			<circle cx="12" cy="12" r="10" />
			<line x1="15" y1="9" x2="9" y2="15" />
			<line x1="9" y1="9" x2="15" y2="15" />
		</svg>
	),
};

function App() {
	const [tasks, setTasks] = useState<WolTask[]>([]);
	const [macAddress, setMacAddress] = useState("");
	const [error, setError] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isRefreshing, setIsRefreshing] = useState(false);

	const fetchTasks = useCallback(async () => {
		try {
			setIsRefreshing(true);
			const response = await fetch("/api/wol/tasks");
			if (!response.ok) {
				throw new Error("Failed to load tasks");
			}
			const data = (await response.json()) as { tasks?: WolTask[] };
			setTasks(data.tasks ?? []);
		} catch (err) {
			console.error(err);
			// Only set error if we don't have tasks yet, to avoid annoyance on polling failure
			setTasks((prev) => (prev.length === 0 ? [] : prev));
		} finally {
			setIsRefreshing(false);
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

	const _formatMacAddress = (value: string) => {
		// Basic formatter: remove non-hex, add colons
		const raw = value.replace(/[^0-9A-Fa-f]/g, "");
		const chunks = raw.match(/.{1,2}/g) || [];
		return chunks.slice(0, 6).join(":").toUpperCase();
	};

	const handleMacChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const newValue = e.target.value;
		// If user is deleting, just let them delete
		if (newValue.length < macAddress.length) {
			setMacAddress(newValue);
			return;
		}
		// Otherwise try to format helpful-ly
		// (Optional: can be annoying, but often requested for MAC inputs)
		// For now, let's just uppercase it to be safe and simple
		setMacAddress(newValue.toUpperCase());
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

	const getStatusConfig = (status: string) => {
		switch (status) {
			case "pending":
				return {
					className: "bg-yellow-100 text-yellow-800 border-yellow-200",
					icon: <Icons.Clock />,
					label: "Pending",
				};
			case "processing":
				return {
					className: "bg-blue-100 text-blue-800 border-blue-200",
					icon: <Icons.Activity />,
					label: "Processing",
				};
			case "success":
				return {
					className: "bg-emerald-100 text-emerald-800 border-emerald-200",
					icon: <Icons.CheckCircle />,
					label: "Sent",
				};
			case "failed":
				return {
					className: "bg-red-100 text-red-800 border-red-200",
					icon: <Icons.XCircle />,
					label: "Failed",
				};
			default:
				return {
					className: "bg-gray-100 text-gray-800 border-gray-200",
					icon: <Icons.Clock />,
					label: status,
				};
		}
	};

	const formatDate = (timestamp: number): string => {
		return new Date(timestamp).toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	};

	return (
		<div className="min-h-screen py-12 px-4 sm:px-6 lg:px-8">
			<div className="max-w-4xl mx-auto space-y-8">
				{/* Header */}
				<div className="text-center space-y-2">
					<div className="flex justify-center mb-4">
						<div className="p-3 bg-white rounded-2xl shadow-sm border border-slate-200">
							<Icons.Server />
						</div>
					</div>
					<h1 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
						Wake-on-LAN Manager
					</h1>
					<p className="text-lg text-slate-600">
						Queue wake requests for your devices efficiently.
					</p>
				</div>

				{/* Input Card */}
				<div className="bg-white rounded-2xl shadow-xl shadow-slate-200/60 border border-slate-100 overflow-hidden">
					<div className="p-6 sm:p-8">
						<form onSubmit={handleSubmit} className="relative">
							<div className="flex flex-col sm:flex-row gap-4">
								<div className="flex-1 relative group">
									<div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
										<span className="text-slate-400 font-mono text-sm">
											MAC:
										</span>
									</div>
									<input
										type="text"
										value={macAddress}
										onChange={handleMacChange}
										placeholder="XX:XX:XX:XX:XX:XX"
										className="block w-full pl-14 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all font-mono"
										autoComplete="off"
									/>
								</div>
								<button
									type="submit"
									disabled={isSubmitting}
									className={`inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-xl text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 shadow-lg shadow-blue-500/30 transition-all ${
										isSubmitting
											? "opacity-75 cursor-not-allowed"
											: "hover:-translate-y-0.5"
									}`}
								>
									{isSubmitting ? (
										<Icons.Refresh className="animate-spin w-5 h-5" />
									) : (
										<>
											<Icons.Zap />
											<span className="ml-2">Wake Device</span>
										</>
									)}
								</button>
							</div>
							{error && (
								<div className="mt-4 p-3 bg-red-50 border border-red-100 rounded-lg flex items-center text-red-700 text-sm">
									<Icons.AlertCircle />
									<span className="ml-2">{error}</span>
								</div>
							)}
						</form>
					</div>
				</div>

				{/* Tasks List */}
				<div className="space-y-4">
					<div className="flex items-center justify-between px-2">
						<h2 className="text-xl font-semibold text-slate-900">
							Recent Tasks
						</h2>
						<button
							type="button"
							onClick={fetchTasks}
							className={`p-2 text-slate-400 hover:text-blue-600 rounded-full hover:bg-blue-50 transition-colors ${
								isRefreshing ? "animate-spin text-blue-600" : ""
							}`}
							title="Refresh tasks"
						>
							<Icons.Refresh className="w-5 h-5" />
						</button>
					</div>

					<div className="bg-white rounded-2xl shadow-xl shadow-slate-200/60 border border-slate-100 overflow-hidden">
						<div className="overflow-x-auto">
							<table className="min-w-full divide-y divide-slate-100">
								<thead className="bg-slate-50/50">
									<tr>
										<th
											scope="col"
											className="px-6 py-4 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider"
										>
											Device
										</th>
										<th
											scope="col"
											className="px-6 py-4 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider"
										>
											Status
										</th>
										<th
											scope="col"
											className="px-6 py-4 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider"
										>
											Attempts
										</th>
										<th
											scope="col"
											className="px-6 py-4 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider"
										>
											Last Updated
										</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-slate-100 bg-white">
									{tasks.length === 0 ? (
										<tr>
											<td colSpan={4} className="px-6 py-12 text-center">
												<div className="flex flex-col items-center justify-center space-y-3">
													<div className="p-3 bg-slate-50 rounded-full">
														<Icons.Clock />
													</div>
													<p className="text-slate-500">No wake tasks found.</p>
												</div>
											</td>
										</tr>
									) : (
										tasks.map((task) => {
											const statusConfig = getStatusConfig(task.status);
											return (
												<tr
													key={task.id}
													className="hover:bg-slate-50/50 transition-colors"
												>
													<td className="px-6 py-4 whitespace-nowrap">
														<div className="flex items-center">
															<div className="font-mono text-sm font-medium text-slate-700 bg-slate-100 px-2 py-1 rounded">
																{task.macAddress}
															</div>
														</div>
													</td>
													<td className="px-6 py-4 whitespace-nowrap">
														<span
															className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${statusConfig.className}`}
														>
															<span className="mr-1.5">
																{statusConfig.icon}
															</span>
															{statusConfig.label}
														</span>
													</td>
													<td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
														{task.attempts}
													</td>
													<td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500 text-right">
														{formatDate(task.updatedAt)}
													</td>
												</tr>
											);
										})
									)}
								</tbody>
							</table>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const root = document.getElementById("root");
if (!root) {
	throw new Error('Missing root element: expected an element with id="root"');
}
createRoot(root).render(<App />);
