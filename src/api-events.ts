import { ApiError, apiFetch } from "./api.ts";

// Each subscription owns one connection and one reconnect timer.
export function subscribeEvents({
	onOpen,
	onEvent,
	onError,
}: {
	onOpen: () => void;
	onEvent: (name: string, data: string) => void;
	onError: (error: ApiError) => void;
}) {
	const controller = new AbortController();
	let retry: ReturnType<typeof setTimeout> | undefined;
	async function connect() {
		try {
			const response = await apiFetch("/api/events", {
				signal: controller.signal,
			});
			if (controller.signal.aborted) return;
			if (!response.body) throw new ApiError("invalidResponse");
			onOpen();
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let pending = "";
			let name = "message";
			let data: string[] = [];
			try {
				while (!controller.signal.aborted) {
					const chunk = await reader.read();
					pending += decoder.decode(chunk.value, { stream: !chunk.done });
					while (true) {
						const end = pending.search(/[\r\n]/);
						if (end === -1) break;
						if (
							pending[end] === "\r" &&
							end === pending.length - 1 &&
							!chunk.done
						)
							break;
						const line = pending.slice(0, end);
						pending = pending.slice(
							end + (pending.slice(end, end + 2) === "\r\n" ? 2 : 1),
						);
						if (!line) {
							if (data.length && !controller.signal.aborted)
								onEvent(name, data.join("\n"));
							name = "message";
							data = [];
						} else {
							const colon = line.indexOf(":");
							const field = colon === -1 ? line : line.slice(0, colon);
							const value =
								colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
							if (field === "event") name = value || "message";
							if (field === "data") data.push(value);
						}
					}
					if (chunk.done) break;
				}
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
			if (!controller.signal.aborted) throw new ApiError("networkFailed");
		} catch (cause) {
			if (controller.signal.aborted) return;
			const error =
				cause instanceof ApiError
					? cause
					: new ApiError("networkFailed", String(cause));
			onError(error);
			if (
				!controller.signal.aborted &&
				error.code !== "managementAuthorizationRequired"
			)
				retry = setTimeout(() => void connect(), 1000);
		}
	}
	void connect();
	return () => {
		controller.abort();
		clearTimeout(retry);
	};
}
