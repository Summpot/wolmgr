type ImportMetaWithEnv = ImportMeta & {
	env?: Record<string, string | undefined>;
};

const apiBaseUrl =
	(import.meta as ImportMetaWithEnv).env?.PUBLIC_API_BASE_URL?.replace(
		/\/+$/,
		"",
	) ?? "";

export function apiPath(path: string): string {
	if (!apiBaseUrl) return path;
	return path.startsWith("/")
		? `${apiBaseUrl}${path}`
		: `${apiBaseUrl}/${path}`;
}

export function apiFetch(
	input: string,
	init: RequestInit = {},
): Promise<Response> {
	return fetch(apiPath(input), {
		credentials: "include",
		...init,
		headers: init.headers,
	});
}
