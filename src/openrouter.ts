type Message = { role: "user" | "assistant"; content: string };
export class ModelError extends Error {
	code: string;
	details?: string;
	constructor(code: string, message: string, details?: string) {
		super(message);
		this.code = code;
		this.details = details;
	}
}
export type CallRequest = {
	url: string;
	method: string;
	requestedAt: string;
	requestBody: string;
};
export type CallResult = {
	status: "succeeded" | "failed";
	httpStatus: number | null;
	responseBody: string | null;
	durationMs: number;
	error: string | null;
};
export async function requestModel(
	messages: Message[],
	prompt: string,
	fetchModel: typeof fetch,
	record?: {
		request: (request: CallRequest) => void;
		result: (result: CallResult) => void;
	},
) {
	const apiKey = process.env.OPENROUTER_API_KEY;
	const model = process.env.OPENROUTER_MODEL;
	if (!apiKey || !model)
		throw new ModelError(
			"modelConfigMissing",
			"OpenRouter configuration is missing",
		);
	const url = "https://openrouter.ai/api/v1/responses";
	const headers = {
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
	};
	const body = JSON.stringify({
		model,
		input: [...messages, { role: "user", content: prompt }],
		stream: false,
	});
	const started = performance.now();
	const escapedKey = JSON.stringify(apiKey).slice(1, -1);
	const redact = (value: string) =>
		value.replaceAll(apiKey, "[REDACTED]").replaceAll(escapedKey, "[REDACTED]");
	let upstream: Response | undefined;
	let rawBody: string;
	record?.request({
		url,
		method: "POST",
		requestedAt: new Date().toISOString(),
		requestBody: redact(body),
	});
	try {
		upstream = await fetchModel(url, { method: "POST", headers, body });
		rawBody = await upstream.text();
	} catch (error) {
		record?.result({
			status: "failed",
			httpStatus: upstream?.status ?? null,
			responseBody: null,
			durationMs: Math.round(performance.now() - started),
			error: redact(String(error)),
		});
		throw new ModelError(
			"modelRequestFailed",
			"OpenRouter request failed",
			redact(String(error)),
		);
	}
	const result: CallResult = {
		status: "failed",
		httpStatus: upstream.status,
		responseBody: redact(rawBody),
		durationMs: Math.round(performance.now() - started),
		error: null,
	};
	record?.result(result);
	if (!upstream.ok)
		throw new ModelError(
			"modelRequestFailed",
			"OpenRouter request failed",
			`HTTP ${upstream.status}`,
		);
	let data: unknown;
	try {
		data = JSON.parse(rawBody);
	} catch {
		throw new ModelError(
			"modelInvalidResponse",
			"OpenRouter returned an invalid response",
		);
	}
	const output =
		data && typeof data === "object" && "output" in data ? data.output : null;
	const answer = Array.isArray(output)
		? output
				.flatMap((item) =>
					item &&
					typeof item === "object" &&
					item.type === "message" &&
					Array.isArray(item.content)
						? item.content
								.filter(
									(part: { type?: string; text?: unknown }) =>
										part &&
										typeof part === "object" &&
										part.type === "output_text" &&
										typeof part.text === "string",
								)
								.map((part: { text: string }) => part.text)
						: [],
				)
				.join("\n")
				.trim()
		: "";
	if (!answer)
		throw new ModelError(
			"modelNoAnswer",
			"OpenRouter did not return a text answer",
		);

	record?.result({ ...result, status: "succeeded" });
	return redact(answer);
}
