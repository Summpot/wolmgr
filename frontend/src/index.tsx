import {
	type AuthenticationResponseJSON,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON,
	startAuthentication,
	startRegistration,
} from "@simplewebauthn/browser";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { apiFetch, apiPath } from "./api";
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
			className="w-8 h-8 text-indigo"
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
			className="w-5 h-5 text-terracotta"
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

const CARD =
	"relative bg-cream rounded-[1.25rem] border border-dashed border-stitch p-[clamp(16px,2.2vw,24px)] transition-all duration-200 ease-out";
const CARD_HOVER = "hover:shadow-card-hover hover:-translate-y-0.5";
const CARD_ACTIVE = "active:shadow-card-active active:translate-y-0.5";

const BTN_BASE =
	"inline-flex items-center justify-center gap-2.5 px-4 py-3 rounded-full font-semibold tracking-[0.01em] border border-dashed border-stitch transition-all duration-200 ease-out select-none";
const BTN_HOVER = "hover:shadow-btn-hover hover:-translate-y-0.5";
const BTN_ACTIVE = "active:shadow-btn-active active:translate-y-0.5";
const BTN_DISABLED = "disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none";
const BTN_FOCUS =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ochre/50 focus-visible:ring-offset-2";

const TAG =
	"absolute -top-3 right-3.5 rotate-[5deg] px-3 py-1.5 rounded-full border border-dashed border-stitch text-xs font-extrabold tracking-wider shadow-btn";

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
			const res = await apiFetch("/api/me");
			const data = (await res.json()) as MeResponse;
			setMe(data);
		} catch (err) {
			console.error(err);
			setMe({ user: null, passkeyCount: 0 });
		}
	}, []);

	const fetchDevices = useCallback(async () => {
		if (!user) return;
		const res = await apiFetch("/api/devices");
		if (!res.ok) return;
		const data = (await res.json()) as { devices?: Device[] };
		setDevices(data.devices ?? []);
	}, [user]);

	const fetchTasks = useCallback(async () => {
		if (!user) return;
		try {
			setIsRefreshing(true);
			const response = await apiFetch("/api/wol/tasks");
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
		window.location.href = apiPath(
			`/api/auth/github/start?redirectTo=${encodeURIComponent("/")}`,
		);
	};

	const handleLogout = async () => {
		setAuthError("");
		setIsAuthBusy(true);
		try {
			await apiFetch("/api/auth/logout", { method: "POST" });
			await fetchMe();
		} finally {
			setIsAuthBusy(false);
		}
	};

	const handlePasskeyLogin = async () => {
		setAuthError("");
		setIsPasskeyBusy(true);
		try {
			const startRes = await apiFetch("/api/passkey/login/start", {
				method: "POST",
			});
			if (!startRes.ok) {
				const payload = (await startRes.json().catch(() => null)) as {
					error?: string;
				} | null;
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

			const finishRes = await apiFetch("/api/passkey/login/finish", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ stateId: startPayload.stateId, response }),
			});
			if (!finishRes.ok) {
				const payload = (await finishRes.json().catch(() => null)) as {
					error?: string;
				} | null;
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
			const startRes = await apiFetch("/api/passkey/register/start", {
				method: "POST",
			});
			if (!startRes.ok) {
				const payload = (await startRes.json().catch(() => null)) as {
					error?: string;
				} | null;
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

			const finishRes = await apiFetch("/api/passkey/register/finish", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ stateId: startPayload.stateId, response }),
			});
			if (!finishRes.ok) {
				const payload = (await finishRes.json().catch(() => null)) as {
					error?: string;
				} | null;
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
			const res = await apiFetch("/api/devices", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: deviceName.trim() || undefined,
					macAddress: deviceMac.toUpperCase(),
				}),
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as {
					error?: string;
				} | null;
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
			const res = await apiFetch(`/api/devices/${encodeURIComponent(id)}`, {
				method: "DELETE",
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as {
					error?: string;
				} | null;
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
			const res = await apiFetch(
				`/api/devices/${encodeURIComponent(id)}/wake`,
				{
					method: "POST",
				},
			);
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as {
					error?: string;
				} | null;
				setError(payload?.error ?? "Failed to queue wake task.");
				return;
			}
			await fetchTasks();
		} finally {
			setIsSubmitting(false);
		}
	};

	const chipBase =
		"inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full font-extrabold text-xs border border-dashed border-stitch shadow-chip";

	const getStatusConfig = (status: string) => {
		switch (status) {
			case "pending":
				return {
					className: `${chipBase} bg-ochre-dim/70`,
					icon: <Icons.Clock />,
					label: "Pending",
				};
			case "processing":
				return {
					className: `${chipBase} bg-indigo-dim/70`,
					icon: <Icons.Activity />,
					label: "Processing",
				};
			case "success":
				return {
					className: `${chipBase} bg-sage-dim/70`,
					icon: <Icons.CheckCircle />,
					label: "Sent",
				};
			case "failed":
				return {
					className: `${chipBase} bg-red-100/70`,
					icon: <Icons.XCircle />,
					label: "Failed",
				};
			default:
				return {
					className: `${chipBase} bg-white`,
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

	const BrandBlock = ({ tagline }: { tagline: string }) => (
		<div className="inline-flex items-center gap-2.5 px-3.5 py-2.5 bg-ochre-dim rounded-[1.25rem] border border-dashed border-stitch shadow-btn">
			<Icons.Server />
			<div>
				<div className="font-extrabold tracking-tight text-[22px] leading-none">
					wolmgr
				</div>
				<div className="text-sm opacity-90 leading-snug">{tagline}</div>
			</div>
		</div>
	);

	if (!me) {
		return (
			<div className="min-h-screen p-[clamp(18px,3vw,40px)]">
				<div className="max-w-[980px] mx-auto grid gap-[18px]">
					<div className="flex items-center justify-between gap-3.5 flex-wrap">
						<BrandBlock tagline="Wake-on-LAN manager with GitHub OAuth + Passkeys." />
						<div className="text-sm opacity-80" aria-hidden="true">
							* ~ . ~ *
						</div>
					</div>
					<div className={`${CARD} bg-ochre-dim/50 shadow-card`}>
						<span className={`${TAG} bg-sage-dim text-thread`}>BOOTING</span>
						<p>Loading your dashboard...</p>
						<p className="mt-2.5 text-[13px] opacity-80">
							If this takes long, check your backend/API availability.
						</p>
					</div>
				</div>
			</div>
		);
	}

	if (!user) {
		return (
			<div className="min-h-screen p-[clamp(18px,3vw,40px)]">
				<div className="max-w-[980px] mx-auto grid gap-[18px]">
					<div className="flex items-center justify-between gap-3.5 flex-wrap">
						<div>
							<BrandBlock tagline="Sign in to manage devices and wake them in one click." />
							<p className="mt-2.5 opacity-80 text-[13px]">
								<span aria-hidden="true">~</span> Cozy, reliable Wake-on-LAN.
							</p>
						</div>
						<div className="text-sm opacity-80" aria-hidden="true">
							sign in ~ welcome
						</div>
					</div>

					<div className={`${CARD} bg-terracotta-dim/40 shadow-card ${CARD_HOVER} ${CARD_ACTIVE}`}>
						<span className={`${TAG} bg-sage-dim text-thread`}>SIGN IN</span>
						<div className="flex flex-wrap gap-2.5">
							<button
								type="button"
								onClick={handleGitHubLogin}
								disabled={isAuthBusy || isPasskeyBusy}
								className={`${BTN_BASE} ${BTN_HOVER} ${BTN_ACTIVE} ${BTN_DISABLED} ${BTN_FOCUS} bg-thread text-white shadow-btn`}
							>
								Sign in with GitHub
							</button>
							<button
								type="button"
								onClick={handlePasskeyLogin}
								disabled={isAuthBusy || isPasskeyBusy}
								className={`${BTN_BASE} ${BTN_HOVER} ${BTN_ACTIVE} ${BTN_DISABLED} ${BTN_FOCUS} bg-ochre shadow-btn`}
							>
								Sign in with Passkey
							</button>
						</div>
						{authError && (
							<div className="flex items-start gap-2.5 mt-3 px-3.5 py-3 bg-red-100/60 rounded-xl border border-dashed border-stitch shadow-btn">
								<Icons.AlertCircle />
								<div className="text-[13px] leading-[1.35]">{authError}</div>
							</div>
						)}
					</div>
				</div>
			</div>
		);
	}

	const deviceNameById = new Map(
		devices.map((d) => [d.id, d.name ?? d.macAddress]),
	);

	return (
		<div className="min-h-screen p-[clamp(18px,3vw,40px)]">
			<div className="max-w-[980px] mx-auto grid gap-[18px]">
				<div className="flex items-center justify-between gap-3.5 flex-wrap">
					<BrandBlock
						tagline={`Signed in as ${user.githubLogin}`}
					/>
					<div className="inline-flex items-center gap-2.5 px-2.5 py-2 rounded-full bg-cream border border-dashed border-stitch shadow-btn">
						{user.avatarUrl && (
							<img
								src={user.avatarUrl}
								alt={user.githubLogin}
								className="w-[38px] h-[38px] rounded-full border border-dashed border-stitch"
							/>
						)}
						<button
							type="button"
							onClick={handleLogout}
							disabled={isAuthBusy}
							className={`${BTN_BASE} ${BTN_HOVER} ${BTN_ACTIVE} ${BTN_DISABLED} ${BTN_FOCUS} bg-white shadow-btn`}
						>
							Logout
						</button>
					</div>
				</div>

				<div className={`${CARD} bg-indigo-dim/40 shadow-card ${CARD_HOVER} ${CARD_ACTIVE}`}>
					<span className={`${TAG} bg-sage-dim text-thread`}>PASSKEYS</span>
					<div className="flex items-baseline justify-between gap-3 flex-wrap mb-2.5">
						<h2 className="font-extrabold tracking-tight text-lg">
							Passkeys
						</h2>
						<div className="text-xs opacity-75">
							Registered: {me.passkeyCount}
						</div>
					</div>
					<button
						type="button"
						onClick={handlePasskeyRegister}
						disabled={isPasskeyBusy}
						className={`${BTN_BASE} ${BTN_HOVER} ${BTN_ACTIVE} ${BTN_DISABLED} ${BTN_FOCUS} bg-indigo text-white shadow-btn`}
					>
						Register a Passkey
					</button>
				</div>

				<div className={`${CARD} bg-sage-dim/40 shadow-card ${CARD_HOVER} ${CARD_ACTIVE}`}>
					<span className={`${TAG} bg-ochre-dim text-thread`}>DEVICES</span>
					<div className="flex items-baseline justify-between gap-3 flex-wrap mb-2.5">
						<h2 className="font-extrabold tracking-tight text-lg">
							Your devices
						</h2>
						<div className="text-xs opacity-75" aria-hidden="true">
							add ~ wake ~ done
						</div>
					</div>
					<form
						onSubmit={handleAddDevice}
						className="grid grid-cols-1 sm:grid-cols-[1.2fr_1fr_auto] gap-2.5 items-stretch"
					>
						<input
							type="text"
							value={deviceName}
							onChange={(e) => setDeviceName(e.target.value)}
							placeholder="Name (optional)"
							className="w-full px-3.5 py-3 bg-white rounded-xl border border-dashed border-stitch shadow-btn transition-all duration-200 ease-out focus:outline-none focus:ring-2 focus:ring-ochre/50 focus:ring-offset-1"
						/>
						<input
							type="text"
							value={deviceMac}
							onChange={(e) => setDeviceMac(e.target.value.toUpperCase())}
							placeholder="AA:BB:CC:DD:EE:FF"
							className="w-full px-3.5 py-3 bg-white rounded-xl border border-dashed border-stitch shadow-btn transition-all duration-200 ease-out focus:outline-none focus:ring-2 focus:ring-ochre/50 focus:ring-offset-1 tracking-[0.02em]"
							autoComplete="off"
						/>
						<button
							type="submit"
							disabled={isSubmitting}
							className={`${BTN_BASE} ${BTN_HOVER} ${BTN_ACTIVE} ${BTN_DISABLED} ${BTN_FOCUS} bg-thread text-white shadow-btn`}
						>
							Add device
						</button>
					</form>

					{devices.length === 0 ? (
						<p className="mt-3 opacity-80">No devices yet. Add one above.</p>
					) : (
						<div className="grid gap-2.5 mt-2.5">
							{devices.map((d) => (
								<div
									key={d.id}
									className="flex items-center justify-between gap-3 px-3 py-3 bg-white rounded-xl border border-dashed border-stitch shadow-btn transition-all duration-200 ease-out hover:shadow-card-hover hover:-translate-y-0.5"
								>
									<div className="min-w-0">
										<div className="font-bold whitespace-nowrap overflow-hidden text-ellipsis">
											{d.name ?? "Unnamed device"}
										</div>
										<div className="text-xs opacity-75">
											{d.macAddress}
										</div>
									</div>
									<div className="flex flex-wrap gap-2.5">
										<button
											type="button"
											onClick={() => handleWakeDevice(d.id)}
											disabled={isSubmitting}
											className={`${BTN_BASE} ${BTN_HOVER} ${BTN_ACTIVE} ${BTN_DISABLED} ${BTN_FOCUS} bg-ochre shadow-btn`}
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
											className={`${BTN_BASE} ${BTN_HOVER} ${BTN_ACTIVE} ${BTN_DISABLED} ${BTN_FOCUS} bg-white shadow-btn`}
										>
											Remove
										</button>
									</div>
								</div>
							))}
						</div>
					)}

					{error && (
						<div className="flex items-start gap-2.5 mt-3 px-3.5 py-3 bg-red-100/60 rounded-xl border border-dashed border-stitch shadow-btn">
							<Icons.AlertCircle />
							<div className="text-[13px] leading-[1.35]">{error}</div>
						</div>
					)}
				</div>

				<div className="flex items-center justify-between gap-3.5 flex-wrap mt-1">
					<div>
						<div className="font-extrabold tracking-tight text-lg">
							Recent tasks
						</div>
						<div className="text-xs opacity-80">
							Auto-refreshes every 5s.
						</div>
					</div>
					<button
						type="button"
						onClick={fetchTasks}
						className="w-11 h-11 grid place-items-center rounded-full bg-white border border-dashed border-stitch shadow-btn transition-all duration-200 ease-out hover:shadow-btn-hover hover:-translate-y-0.5 active:shadow-btn-active active:translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ochre/50 focus-visible:ring-offset-2"
						title="Refresh tasks"
					>
						<Icons.Refresh
							className={`w-5 h-5 ${isRefreshing ? "animate-[fabric-spin_900ms_linear_infinite]" : ""}`}
						/>
					</button>
				</div>

				<div className="overflow-x-auto rounded-[1.25rem]">
					<table className="w-full border-separate border-spacing-0 bg-white rounded-[1.25rem] border border-dashed border-stitch overflow-hidden shadow-card">
						<thead>
							<tr>
								<th className="px-4 py-3.5 text-xs uppercase tracking-[0.12em] font-extrabold text-left bg-ochre-dim/50">
									Device
								</th>
								<th className="px-4 py-3.5 text-xs uppercase tracking-[0.12em] font-extrabold text-left bg-ochre-dim/50">
									Status
								</th>
								<th className="px-4 py-3.5 text-xs uppercase tracking-[0.12em] font-extrabold text-right bg-ochre-dim/50">
									Last Updated
								</th>
							</tr>
						</thead>
						<tbody>
							{tasks.length === 0 ? (
								<tr>
									<td
										colSpan={3}
										className="px-4 py-[22px] text-center opacity-80"
									>
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
										<tr
											key={task.id}
											className="transition-colors duration-200 hover:bg-indigo-dim/30"
										>
											<td className="px-4 py-3.5 border-b border-stitch/30">
												<div className="font-bold">{label}</div>
												<div className="text-xs opacity-75">
													{task.macAddress}
												</div>
											</td>
											<td className="px-4 py-3.5 border-b border-stitch/30">
												<span className={statusConfig.className}>
													<span aria-hidden="true">
														{statusConfig.icon}
													</span>
													{statusConfig.label}
												</span>
											</td>
											<td className="px-4 py-3.5 border-b border-stitch/30 text-right whitespace-nowrap text-xs opacity-80">
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
