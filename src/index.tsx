import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	startAuthentication,
	startRegistration,
	type AuthenticationResponseJSON,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import type { Device, MeResponse, WolTask } from "./shared";

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
	const [me, setMe] = useState<MeResponse | null>(null);
	const user = me?.user ?? null;
	const [devices, setDevices] = useState<Device[]>([]);
	const [tasks, setTasks] = useState<WolTask[]>([]);

	const [deviceName, setDeviceName] = useState("");
	const [deviceMac, setDeviceMac] = useState("");

	const [error, setError] = useState("");
	const [authError, setAuthError] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [isAuthBusy, setIsAuthBusy] = useState(false);
	const [isPasskeyBusy, setIsPasskeyBusy] = useState(false);

	const fetchMe = useCallback(async () => {
		try {
			const res = await fetch("/api/me");
			const data = (await res.json()) as MeResponse;
			setMe(data);
		} catch (err) {
			console.error(err);
			setMe({ user: null, passkeyCount: 0 });
		}
	}, []);

	const fetchDevices = useCallback(async () => {
		if (!user) return;
		const res = await fetch("/api/devices");
		if (!res.ok) return;
		const data = (await res.json()) as { devices?: Device[] };
		setDevices(data.devices ?? []);
	}, [user]);

	const fetchTasks = useCallback(async () => {
		if (!user) return;
		try {
			setIsRefreshing(true);
			const response = await fetch("/api/wol/tasks");
			if (!response.ok) {
				return;
			}
			const data = (await response.json()) as { tasks?: WolTask[] };
			setTasks(data.tasks ?? []);
		} catch (err) {
			console.error(err);
		} finally {
			setIsRefreshing(false);
		}
	}, [user]);

	useEffect(() => {
		fetchMe();
	}, [fetchMe]);

	useEffect(() => {
		if (!user) {
			setDevices([]);
			setTasks([]);
			return;
		}
		fetchDevices();
		fetchTasks();
		const intervalId = setInterval(fetchTasks, 5000);
		return () => clearInterval(intervalId);
	}, [user, fetchDevices, fetchTasks]);

	const handleGitHubLogin = () => {
		setAuthError("");
		window.location.href = `/api/auth/github/start?redirectTo=${encodeURIComponent("/")}`;
	};

	const handleLogout = async () => {
		setAuthError("");
		setIsAuthBusy(true);
		try {
			await fetch("/api/auth/logout", { method: "POST" });
			await fetchMe();
		} finally {
			setIsAuthBusy(false);
		}
	};

	const handlePasskeyLogin = async () => {
		setAuthError("");
		setIsPasskeyBusy(true);
		try {
			const startRes = await fetch("/api/passkey/login/start", { method: "POST" });
			if (!startRes.ok) {
				const payload = (await startRes.json().catch(() => null)) as { error?: string } | null;
				setAuthError(payload?.error ?? "Failed to start passkey login.");
				return;
			}
			const startPayload = (await startRes.json()) as {
				stateId: string;
				options: PublicKeyCredentialRequestOptionsJSON;
			};

			const response = (await startAuthentication({
				optionsJSON: startPayload.options,
			})) as AuthenticationResponseJSON;

			const finishRes = await fetch("/api/passkey/login/finish", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ stateId: startPayload.stateId, response }),
			});
			if (!finishRes.ok) {
				const payload = (await finishRes.json().catch(() => null)) as { error?: string } | null;
				setAuthError(payload?.error ?? "Passkey login failed.");
				return;
			}
			await fetchMe();
		} catch (err) {
			console.error(err);
			setAuthError("Passkey login was cancelled or failed.");
		} finally {
			setIsPasskeyBusy(false);
		}
	};

	const handlePasskeyRegister = async () => {
		setError("");
		setIsPasskeyBusy(true);
		try {
			const startRes = await fetch("/api/passkey/register/start", { method: "POST" });
			if (!startRes.ok) {
				const payload = (await startRes.json().catch(() => null)) as { error?: string } | null;
				setError(payload?.error ?? "Failed to start passkey registration.");
				return;
			}
			const startPayload = (await startRes.json()) as {
				stateId: string;
				options: PublicKeyCredentialCreationOptionsJSON;
			};

			const response = (await startRegistration({
				optionsJSON: startPayload.options,
			})) as RegistrationResponseJSON;

			const finishRes = await fetch("/api/passkey/register/finish", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ stateId: startPayload.stateId, response }),
			});
			if (!finishRes.ok) {
				const payload = (await finishRes.json().catch(() => null)) as { error?: string } | null;
				setError(payload?.error ?? "Passkey registration failed.");
				return;
			}
			await fetchMe();
		} catch (err) {
			console.error(err);
			setError("Passkey registration was cancelled or failed.");
		} finally {
			setIsPasskeyBusy(false);
		}
	};

	const validateMacAddress = (mac: string): boolean => {
		const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
		return macRegex.test(mac);
	};

	const handleAddDevice = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");
		if (!validateMacAddress(deviceMac)) {
			setError("Invalid MAC address format. Please use XX:XX:XX:XX:XX:XX");
			return;
		}
		setIsSubmitting(true);
		try {
			const res = await fetch("/api/devices", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: deviceName.trim() || undefined,
					macAddress: deviceMac.toUpperCase(),
				}),
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(payload?.error ?? "Failed to add device.");
				return;
			}
			await fetchDevices();
			setDeviceName("");
			setDeviceMac("");
		} catch (err) {
			console.error(err);
			setError("Failed to add device.");
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleRemoveDevice = async (id: string) => {
		setError("");
		setIsSubmitting(true);
		try {
			const res = await fetch(`/api/devices/${encodeURIComponent(id)}`, {
				method: "DELETE",
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(payload?.error ?? "Failed to remove device.");
				return;
			}
			await fetchDevices();
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleWakeDevice = async (id: string) => {
		setError("");
		setIsSubmitting(true);
		try {
			const res = await fetch(`/api/devices/${encodeURIComponent(id)}/wake`, {
				method: "POST",
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(payload?.error ?? "Failed to queue wake task.");
				return;
			}
			await fetchTasks();
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

	if (!me) {
		return (
			<div className="min-h-screen py-12 px-4 sm:px-6 lg:px-8">
				<div className="max-w-3xl mx-auto space-y-8">
					<div className="text-center space-y-2">
						<div className="flex justify-center mb-4">
							<div className="p-3 bg-white rounded-2xl shadow-sm border border-slate-200">
								<Icons.Server />
							</div>
						</div>
						<h1 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
							wolmgr
						</h1>
						<p className="text-lg text-slate-600">
							Wake-on-LAN manager with GitHub OAuth + Passkeys.
						</p>
					</div>
				</div>
			</div>
		);
	}

	if (!user) {
		return (
			<div className="min-h-screen py-12 px-4 sm:px-6 lg:px-8">
				<div className="max-w-3xl mx-auto space-y-8">
					<div className="text-center space-y-2">
						<div className="flex justify-center mb-4">
							<div className="p-3 bg-white rounded-2xl shadow-sm border border-slate-200">
								<Icons.Server />
							</div>
						</div>
						<h1 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
							wolmgr
						</h1>
						<p className="text-lg text-slate-600">
							Sign in to manage devices and wake them in one click.
						</p>
					</div>

					<div className="bg-white rounded-2xl shadow-xl shadow-slate-200/60 border border-slate-100 overflow-hidden">
						<div className="p-6 sm:p-8 space-y-4">
							<div className="flex flex-col sm:flex-row gap-3">
								<button
									type="button"
									onClick={handleGitHubLogin}
									disabled={isAuthBusy || isPasskeyBusy}
									className="inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-xl text-white bg-slate-900 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-900 shadow-lg transition-all"
								>
									Sign in with GitHub
								</button>
								<button
									type="button"
									onClick={handlePasskeyLogin}
									disabled={isAuthBusy || isPasskeyBusy}
									className="inline-flex items-center justify-center px-6 py-3 border border-slate-200 text-base font-medium rounded-xl text-slate-900 bg-white hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 shadow-sm transition-all"
								>
									Sign in with Passkey
								</button>
							</div>
							{authError && (
								<div className="p-3 bg-red-50 border border-red-100 rounded-lg flex items-center text-red-700 text-sm">
									<Icons.AlertCircle />
									<span className="ml-2">{authError}</span>
								</div>
							)}
						</div>
					</div>
				</div>
			</div>
		);
	}

	const deviceNameById = new Map(devices.map((d) => [d.id, d.name ?? d.macAddress]));

	return (
		<div className="min-h-screen py-12 px-4 sm:px-6 lg:px-8">
			<div className="max-w-4xl mx-auto space-y-8">
				<div className="flex items-center justify-between">
					<div className="space-y-1">
						<h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
							wolmgr
						</h1>
						<p className="text-slate-600">
							Signed in as <span className="font-medium">{user.githubLogin}</span>
						</p>
					</div>
					<div className="flex items-center gap-3">
						{user.avatarUrl && (
							<img
								src={user.avatarUrl}
								alt={user.githubLogin}
								className="w-10 h-10 rounded-full border border-slate-200"
							/>
						)}
						<button
							type="button"
							onClick={handleLogout}
							disabled={isAuthBusy}
							className="px-4 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700"
						>
							Logout
						</button>
					</div>
				</div>

				<div className="bg-white rounded-2xl shadow-xl shadow-slate-200/60 border border-slate-100 overflow-hidden">
					<div className="p-6 sm:p-8 space-y-4">
						<div className="flex items-center justify-between">
							<h2 className="text-lg font-semibold text-slate-900">Passkeys</h2>
							<div className="text-sm text-slate-500">
								Registered: {me.passkeyCount}
							</div>
						</div>
						<button
							type="button"
							onClick={handlePasskeyRegister}
							disabled={isPasskeyBusy}
							className="inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-xl text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 shadow-lg shadow-blue-500/30 transition-all"
						>
							Register a Passkey
						</button>
					</div>
				</div>

				<div className="bg-white rounded-2xl shadow-xl shadow-slate-200/60 border border-slate-100 overflow-hidden">
					<div className="p-6 sm:p-8 space-y-4">
						<h2 className="text-lg font-semibold text-slate-900">Your devices</h2>
						<form onSubmit={handleAddDevice} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
							<input
								type="text"
								value={deviceName}
								onChange={(e) => setDeviceName(e.target.value)}
								placeholder="Name (optional)"
								className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl"
							/>
							<input
								type="text"
								value={deviceMac}
								onChange={(e) => setDeviceMac(e.target.value.toUpperCase())}
								placeholder="AA:BB:CC:DD:EE:FF"
								className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-mono"
								autoComplete="off"
							/>
							<button
								type="submit"
								disabled={isSubmitting}
								className="inline-flex items-center justify-center px-6 py-3 rounded-xl text-white bg-slate-900 hover:bg-slate-800"
							>
								Add device
							</button>
						</form>

						{devices.length === 0 ? (
							<p className="text-slate-500">No devices yet. Add one above.</p>
						) : (
							<div className="divide-y divide-slate-100 border border-slate-100 rounded-xl overflow-hidden">
								{devices.map((d) => (
									<div key={d.id} className="p-4 flex items-center justify-between gap-3">
										<div className="min-w-0">
											<div className="font-medium text-slate-900 truncate">{d.name ?? "Unnamed device"}</div>
											<div className="font-mono text-sm text-slate-600">{d.macAddress}</div>
										</div>
										<div className="flex items-center gap-2">
											<button
												type="button"
												onClick={() => handleWakeDevice(d.id)}
												disabled={isSubmitting}
												className="px-4 py-2 rounded-xl text-white bg-blue-600 hover:bg-blue-700"
											>
												Wake
											</button>
											<button
												type="button"
												onClick={() => handleRemoveDevice(d.id)}
												disabled={isSubmitting}
												className="px-4 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700"
											>
												Remove
											</button>
										</div>
									</div>
								))}
							</div>
						)}

						{error && (
							<div className="p-3 bg-red-50 border border-red-100 rounded-lg flex items-center text-red-700 text-sm">
								<Icons.AlertCircle />
								<span className="ml-2">{error}</span>
							</div>
						)}
					</div>
				</div>

				<div className="space-y-4">
					<div className="flex items-center justify-between px-2">
						<h2 className="text-xl font-semibold text-slate-900">Recent tasks</h2>
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
										<th className="px-6 py-4 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
											Device
										</th>
										<th className="px-6 py-4 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
											Status
										</th>
										<th className="px-6 py-4 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">
											Last Updated
										</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-slate-100 bg-white">
									{tasks.length === 0 ? (
										<tr>
											<td colSpan={3} className="px-6 py-12 text-center text-slate-500">
												No tasks yet.
											</td>
										</tr>
									) : (
										tasks.map((task) => {
											const statusConfig = getStatusConfig(task.status);
											const label =
												task.deviceId && deviceNameById.get(task.deviceId)
												? deviceNameById.get(task.deviceId)
												: task.macAddress;
											return (
												<tr key={task.id} className="hover:bg-slate-50/50 transition-colors">
													<td className="px-6 py-4 whitespace-nowrap">
														<div className="text-sm font-medium text-slate-700">{label}</div>
														<div className="font-mono text-xs text-slate-500">{task.macAddress}</div>
													</td>
													<td className="px-6 py-4 whitespace-nowrap">
														<span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${statusConfig.className}`}>
															<span className="mr-1.5">{statusConfig.icon}</span>
															{statusConfig.label}
														</span>
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
