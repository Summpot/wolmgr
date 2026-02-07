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
					className: "nb-chip nb-chip--pending",
					icon: <Icons.Clock />,
					label: "Pending",
				};
			case "processing":
				return {
					className: "nb-chip nb-chip--processing",
					icon: <Icons.Activity />,
					label: "Processing",
				};
			case "success":
				return {
					className: "nb-chip nb-chip--success",
					icon: <Icons.CheckCircle />,
					label: "Sent",
				};
			case "failed":
				return {
					className: "nb-chip nb-chip--failed",
					icon: <Icons.XCircle />,
					label: "Failed",
				};
			default:
				return {
					className: "nb-chip",
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
			<div className="nb-page">
				<div className="nb-container nb-stack">
					<div className="nb-topbar">
						<div className="nb-brand">
							<Icons.Server />
							<div>
								<div className="nb-brand__title">wolmgr</div>
								<div className="nb-tagline">Wake-on-LAN manager with GitHub OAuth + Passkeys.</div>
							</div>
						</div>
						<div className="nb-doodles" aria-hidden="true">
							✷ ⚡ ★
						</div>
					</div>
					<div className="nb-card nb-card--yellow">
						<span className="nb-sticker">BOOTING</span>
						<p style={{ margin: 0 }}>
							Loading your dashboard…
						</p>
						<p style={{ margin: "10px 0 0", opacity: 0.8, fontSize: 13 }}>
							If this takes long, check your Worker/API availability.
						</p>
					</div>
				</div>
			</div>
		);
	}

	if (!user) {
		return (
			<div className="nb-page">
				<div className="nb-container nb-stack">
					<div className="nb-topbar">
						<div>
							<div className="nb-brand">
								<Icons.Server />
								<div>
									<div className="nb-brand__title">wolmgr</div>
									<div className="nb-tagline">Sign in to manage devices and wake them in one click.</div>
								</div>
							</div>
							<div style={{ marginTop: 10, opacity: 0.85, fontSize: 13 }}>
								<span aria-hidden="true">↳</span> Startup vibes, serious packets.
							</div>
						</div>
						<div className="nb-doodles" aria-hidden="true">
							⚡︎ NEW ✶ STUFF
						</div>
					</div>

					<div className="nb-card nb-card--pink">
						<span className="nb-sticker">SIGN IN</span>
						<div className="nb-btnrow">
							<button
								type="button"
								onClick={handleGitHubLogin}
								disabled={isAuthBusy || isPasskeyBusy}
								className="nb-btn nb-btn--black"
							>
								Sign in with GitHub
							</button>
							<button
								type="button"
								onClick={handlePasskeyLogin}
								disabled={isAuthBusy || isPasskeyBusy}
								className="nb-btn nb-btn--yellow"
							>
								Sign in with Passkey
							</button>
						</div>
						{authError && (
							<div className="nb-alert nb-alert--error" style={{ marginTop: 12 }}>
								<Icons.AlertCircle />
								<div className="nb-alert__text">{authError}</div>
							</div>
						)}
					</div>
				</div>
			</div>
		);
	}

	const deviceNameById = new Map(devices.map((d) => [d.id, d.name ?? d.macAddress]));

	return (
		<div className="nb-page">
			<div className="nb-container nb-stack">
				<div className="nb-topbar">
					<div>
						<div className="nb-brand">
							<Icons.Server />
							<div>
								<div className="nb-brand__title">wolmgr</div>
								<div className="nb-tagline">
									Signed in as <span style={{ fontWeight: 900 }}>{user.githubLogin}</span>
								</div>
							</div>
						</div>
					</div>
					<div className="nb-userchip">
						{user.avatarUrl && (
							<img
								src={user.avatarUrl}
								alt={user.githubLogin}
								className="nb-avatar"
							/>
						)}
						<button
							type="button"
							onClick={handleLogout}
							disabled={isAuthBusy}
							className="nb-btn nb-btn--ghost"
						>
							Logout
						</button>
					</div>
				</div>

				<div className="nb-card nb-card--blue">
					<span className="nb-sticker">PASSKEYS</span>
					<div className="nb-card__header">
						<h2 className="nb-card__title">Passkeys</h2>
						<div className="nb-card__meta">Registered: {me.passkeyCount}</div>
					</div>
					<button
						type="button"
						onClick={handlePasskeyRegister}
						disabled={isPasskeyBusy}
						className="nb-btn nb-btn--blue"
					>
						Register a Passkey
					</button>
				</div>

				<div className="nb-card nb-card--green">
					<span className="nb-sticker">DEVICES</span>
					<div className="nb-card__header">
						<h2 className="nb-card__title">Your devices</h2>
						<div className="nb-card__meta" aria-hidden="true">
							⌁ add → wake → boom
						</div>
					</div>
					<form onSubmit={handleAddDevice} className="nb-form">
						<input
							type="text"
							value={deviceName}
							onChange={(e) => setDeviceName(e.target.value)}
							placeholder="Name (optional)"
							className="nb-input"
						/>
						<input
							type="text"
							value={deviceMac}
							onChange={(e) => setDeviceMac(e.target.value.toUpperCase())}
							placeholder="AA:BB:CC:DD:EE:FF"
							className="nb-input nb-input--mono"
							autoComplete="off"
						/>
						<button
							type="submit"
							disabled={isSubmitting}
							className="nb-btn nb-btn--black"
						>
							Add device
						</button>
					</form>

					{devices.length === 0 ? (
						<p style={{ margin: "12px 0 0", opacity: 0.8 }}>
							No devices yet. Add one above.
						</p>
					) : (
						<div className="nb-list">
							{devices.map((d) => (
								<div key={d.id} className="nb-item">
									<div style={{ minWidth: 0 }}>
										<div className="nb-item__title" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
											{d.name ?? "Unnamed device"}
										</div>
										<div className="nb-item__sub">{d.macAddress}</div>
									</div>
									<div className="nb-btnrow">
										<button
											type="button"
											onClick={() => handleWakeDevice(d.id)}
											disabled={isSubmitting}
											className="nb-btn nb-btn--yellow"
										>
											<span aria-hidden="true">
												<Icons.Zap />
											</span>
											Wake
										</button>
										<button
											type="button"
											onClick={() => handleRemoveDevice(d.id)}
											disabled={isSubmitting}
											className="nb-btn nb-btn--ghost"
										>
											Remove
										</button>
									</div>
								</div>
							))}
						</div>
					)}

					{error && (
						<div className="nb-alert nb-alert--error" style={{ marginTop: 12 }}>
							<Icons.AlertCircle />
							<div className="nb-alert__text">{error}</div>
						</div>
					)}
				</div>

				<div className="nb-topbar" style={{ marginTop: 4 }}>
					<div>
						<div style={{ fontWeight: 900, fontSize: 18, letterSpacing: "-0.03em" }}>
							Recent tasks
						</div>
						<div style={{ fontSize: 12, opacity: 0.8 }}>
							Auto-refreshes every 5s (and you can smack the refresh button).
						</div>
					</div>
					<button type="button" onClick={fetchTasks} className="nb-iconbtn" title="Refresh tasks">
						<Icons.Refresh className={`w-5 h-5 ${isRefreshing ? "nb-spin" : ""}`} />
					</button>
				</div>

				<div className="nb-tablewrap">
					<table className="nb-table">
						<thead>
							<tr>
								<th style={{ textAlign: "left" }}>Device</th>
								<th style={{ textAlign: "left" }}>Status</th>
								<th style={{ textAlign: "right" }}>Last Updated</th>
							</tr>
						</thead>
						<tbody>
							{tasks.length === 0 ? (
								<tr>
									<td colSpan={3} style={{ padding: "22px 16px", textAlign: "center", opacity: 0.8 }}>
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
										<tr key={task.id}>
											<td>
												<div style={{ fontWeight: 900 }}>{label}</div>
												<div style={{ fontSize: 12, opacity: 0.78 }}>{task.macAddress}</div>
											</td>
											<td>
												<span className={statusConfig.className}>
													<span aria-hidden="true">{statusConfig.icon}</span>
													{statusConfig.label}
												</span>
											</td>
											<td style={{ textAlign: "right", whiteSpace: "nowrap", fontSize: 12, opacity: 0.82 }}>
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
	);
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const root = document.getElementById("root");
if (!root) {
	throw new Error('Missing root element: expected an element with id="root"');
}
createRoot(root).render(<App />);
