type Message = { role: "user" | "assistant"; content: string };
let callId = 0;
export class ModelError extends Error {
	code: string;
	details?: string;
	constructor(code: string, message: string, details?: string) {
		super(message);
		this.code = code;
		this.details = details;
	}
}
export async function requestModel(
	messages: Message[],
	prompt: string,
	fetchModel: typeof fetch,
	debugEnabled: boolean,
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
	const shouldLog = debugEnabled;
	const id = shouldLog ? ++callId : 0;
	const started = performance.now();
	const escapedKey = JSON.stringify(apiKey).slice(1, -1);
	const redact = (value: string) =>
		value.replaceAll(apiKey, "[REDACTED]").replaceAll(escapedKey, "[REDACTED]");
	const pretty = (value: unknown) => redact(JSON.stringify(value, null, 2));
	const displayBody = (raw: string) => {
		try {
			return pretty(JSON.parse(raw));
		} catch {
			return redact(raw);
		}
	};
	const log = (kind: string, details: unknown, raw?: string) => {
		console.log(
			`[OpenRouter #${id}] ${kind}\n${pretty(details)}${raw === undefined ? "" : `\nbody:\n${displayBody(raw)}`}`,
		);
	};
	if (shouldLog)
		log(
			"request",
			{ time: new Date().toISOString(), url, method: "POST" },
			body,
		);
	let upstream: Response | undefined;
	let rawBody: string;
	try {
		upstream = await fetchModel(url, { method: "POST", headers, body });
		rawBody = await upstream.text();
	} catch (error) {
		if (shouldLog)
			log("error", {
				...(upstream && { status: upstream.status }),
				error: String(error),
				durationMs: Math.round(performance.now() - started),
			});
		throw new ModelError(
			"modelRequestFailed",
			"OpenRouter request failed",
			redact(String(error)),
		);
	}
	if (shouldLog) {
		log(
			"response",
			{
				status: upstream.status,
				durationMs: Math.round(performance.now() - started),
			},
			rawBody,
		);
	}
	if (!upstream.ok)
		throw new ModelError(
			"modelRequestFailed",
			"OpenRouter request failed",
			redact(rawBody),
		);
	let data: unknown;
	try {
		data = JSON.parse(rawBody);
	} catch {
		throw new ModelError(
			"modelInvalidResponse",
			"OpenRouter returned an invalid response",
			redact(rawBody),
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
			redact(rawBody),
		);

	return answer;
}
