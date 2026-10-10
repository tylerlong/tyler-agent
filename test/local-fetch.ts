export const managementTokens = new Map<string, string>();

// Explicit programmatic Origin; the production request guard remains active.
export const localFetch: typeof fetch = (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	const method =
		init?.method ?? (input instanceof Request ? input.method : "GET");
	const headers = new Headers(
		init?.headers ?? (input instanceof Request ? input.headers : undefined),
	);
	if (
		!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) &&
		!headers.has("Origin")
	)
		headers.set("Origin", url.origin);
	if (
		!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) &&
		!headers.has("x-tyler-management-token")
	) {
		const token = managementTokens.get(url.origin);
		if (token) headers.set("x-tyler-management-token", token);
	}
	return globalThis.fetch(input, { ...init, headers });
};
