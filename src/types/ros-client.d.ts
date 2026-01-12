declare module "ros-client" {
	import { EventEmitter } from "node:events";

	export type RouterOSClientOptions = {
		host: string;
		username: string;
		password: string;
		port?: number;
		tls?: boolean;
		timeout?: number;
		debug?: boolean;
	};

	class RouterOSClient extends EventEmitter {
		constructor(options: RouterOSClientOptions);
		connect(): Promise<void>;
		close(): Promise<void>;
		send(words: string[]): Promise<unknown>;
	}

	export default RouterOSClient;
}
