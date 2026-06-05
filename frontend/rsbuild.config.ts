import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

export default defineConfig({
	plugins: [pluginReact()],
	server: {
		proxy: {
			"/api": "http://127.0.0.1:8787",
		},
	},
});
