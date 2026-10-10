// Only the startup URL can establish management authority in this browser tab.
const managementKey = "tyler-management-token";
if (typeof window !== "undefined") {
	const url = new URL(window.location.href);
	const fragment = new URLSearchParams(url.hash.slice(1));
	const token = fragment.get("management");
	if (token) {
		sessionStorage.setItem(managementKey, token);
		fragment.delete("management");
		url.hash = fragment.toString();
		history.replaceState(history.state, "", url);
	}
}
export class ApiError extends Error {
	constructor(
		public code: string,
		public details?: string,
	) {
		super(code);
	}
}
export function appError(cause: unknown) {
	return cause instanceof ApiError
		? cause
		: new ApiError("requestFailed", String(cause));
}
export function managementHeaders(): Record<string, string> {
	const token =
		typeof window === "undefined"
			? null
			: sessionStorage.getItem(managementKey);
	return token ? { "x-tyler-management-token": token } : {};
}
export async function api(path: string, method = "GET", input?: unknown) {
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			headers: {
				...(input === undefined ? {} : { "content-type": "application/json" }),
				...(method !== "GET" ? managementHeaders() : {}),
			},
			...(input === undefined
				? {}
				: {
						body: JSON.stringify(input),
					}),
		});
	} catch (cause) {
		throw new ApiError("networkFailed", String(cause));
	}
	let data: Awaited<ReturnType<Response["json"]>>;
	try {
		data = await response.json();
	} catch (cause) {
		throw new ApiError("invalidResponse", String(cause));
	}
	if (!response.ok)
		throw new ApiError(
			data.code ?? "requestFailed",
			data.details ?? (data.code ? undefined : data.error),
		);
	return data;
}
