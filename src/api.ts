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
	code: string;
	details?: string;
	constructor(code: string, details?: string) {
		super(code);
		this.code = code;
		this.details = details;
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
export async function apiFetch(path: string, init?: RequestInit) {
	if (
		!path.startsWith("/api/") ||
		!new URL(path, "http://localhost").pathname.startsWith("/api/")
	)
		throw new ApiError("invalidRequest");
	const headers = new Headers(init?.headers);
	for (const [name, value] of Object.entries(managementHeaders()))
		headers.set(name, value);
	let response: Response;
	try {
		response = await fetch(path, { ...init, headers, redirect: "error" });
	} catch (cause) {
		throw new ApiError("networkFailed", String(cause));
	}
	if (!response.ok) {
		let data: Awaited<ReturnType<Response["json"]>>;
		try {
			data = await response.json();
		} catch (cause) {
			throw new ApiError("invalidResponse", String(cause));
		}
		throw new ApiError(
			data.code ?? "requestFailed",
			data.details ?? (data.code ? undefined : data.error),
		);
	}
	return response;
}
export async function api(path: string, method = "GET", input?: unknown) {
	const response = await apiFetch(path, {
		method,
		...(input === undefined
			? {}
			: {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(input),
				}),
	});
	try {
		return await response.json();
	} catch (cause) {
		throw new ApiError("invalidResponse", String(cause));
	}
}
