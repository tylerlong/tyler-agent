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
export async function api(path: string, method = "GET", input?: unknown) {
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			...(input === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
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
