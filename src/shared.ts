export type WolTask = {
	id: string;
	macAddress: string;
	status: "pending" | "processing" | "success" | "failed";
	createdAt: number;
	updatedAt: number;
	attempts: number;
};

export type RouterOSWolResponse = {
	tasks: {
		macAddress: string;
		id: string;
	}[];
};
