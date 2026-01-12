export type WolTask = {
	id: string;
	macAddress: string;
	status: "pending" | "processing" | "success" | "failed";
	createdAt: number;
	updatedAt: number;
	attempts: number;
	userId?: string;
	deviceId?: string;
};

export type User = {
	id: string;
	githubLogin: string;
	githubName?: string;
	avatarUrl?: string;
};

export type MeResponse = {
	user: User | null;
	passkeyCount: number;
};

export type Device = {
	id: string;
	name?: string;
	macAddress: string;
	createdAt: number;
	updatedAt: number;
};

export type RouterOSWolResponse = {
	tasks: {
		macAddress: string;
		id: string;
	}[];
};
