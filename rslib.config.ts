import { defineConfig } from "@rslib/core";

export default defineConfig({
	lib: [
		{
			format: "esm",
			bundle: true,
		},
	],
	source: {
		entry: {
			_worker: "./src/_worker.ts",
			waker: "./src/waker.ts",
		},
	},
	output: {
		cleanDistPath: false,
	},
});
