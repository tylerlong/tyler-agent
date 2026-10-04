import { countFilesTool, executeTool } from "./count-files.ts";

type Message = { role: "user" | "assistant"; content: string };
export type OutputPart = { index: number; type: string; text: string };
export type OutputItem = {
	id: string;
	index: number;
	type: string;
	content: OutputPart[];
};
export const answerText = (output: OutputItem[]) =>
	output
		.filter((item) => item.type === "message")
		.flatMap((item) =>
			item.content
				.filter(
					(part) => part.type === "output_text" || part.type === "refusal",
				)
				.map((part) => part.text),
		)
		.join("\n")
		.trim();
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
	status: "pending" | "succeeded" | "failed";
	httpStatus: number | null;
	responseBody: string | null;
	durationMs: number;
	error: string | null;
};
class PersistenceError extends Error {
	constructor(cause: unknown) {
		super("Persistence failed", { cause });
	}
}
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
export type ModelConfig = {
	apiKey: string;
	model: string;
	reasoningEffort?: string | null;
	targetFolders?: string[];
};
type Recorder = {
	request: (request: CallRequest) => void;
	result: (result: CallResult, output: OutputItem[]) => void;
};
export async function requestModel(
	messages: Message[],
	prompt: string,
	fetchModel: typeof fetch,
	record?: Recorder,
	config?: ModelConfig,
) {
	const input: unknown[] = [...messages, { role: "user", content: prompt }];
	let previous: OutputItem[] = [];
	for (let round = 0; round < 5; round++) {
		let current: OutputItem[] = [];
		const response = await requestOnce(
			input,
			fetchModel,
			{
				request: (call) => record?.request(call),
				result: (result, output) => {
					const offset = previous.reduce(
						(next, item) => Math.max(next, item.index + 1),
						0,
					);
					current = output.map((item) => ({
						...item,
						index: offset + item.index,
					}));
					record?.result(result, [...previous, ...current]);
				},
			},
			config,
		);
		previous = [...previous, ...current];
		if (!response.tools.length) return answerText(previous);
		if (round === 4)
			throw new ModelError(
				"modelCallLimit",
				"Turn reached the five model request limit",
			);
		input.push(...response.protocol);
		for (const call of response.tools) {
			const result = await executeTool(
				call.name,
				call.arguments,
				config?.targetFolders ?? [],
			);
			input.push({
				type: "function_call_output",
				call_id: call.call_id,
				output: JSON.stringify(result),
			});
		}
	}
	throw new ModelError(
		"modelCallLimit",
		"Turn reached the five model request limit",
	);
}
async function requestOnce(
	input: unknown[],
	fetchModel: typeof fetch,
	record: Recorder,
	config?: ModelConfig,
) {
	const { apiKey, model, reasoningEffort } = config ?? {
		apiKey: "",
		model: "",
	};
	if (!apiKey || !model)
		throw new ModelError(
			"modelConfigMissing",
			"OpenRouter configuration is missing",
		);
	const secrets = [...new Set([apiKey, JSON.stringify(apiKey).slice(1, -1)])];
	const redact = (text: string) =>
		secrets.reduce(
			(text, secret) => text.replaceAll(secret, "[REDACTED]"),
			text,
		);
	// Hold only an unfinished credential prefix; it cannot be exposed before the next chunk.
	const safe = (text: string, final = false) => {
		text = redact(text);
		if (!final) {
			let hold = 0;
			for (const secret of secrets)
				for (let size = 1; size < secret.length; size++)
					if (text.endsWith(secret.slice(0, size))) hold = Math.max(hold, size);
			if (hold) text = text.slice(0, -hold);
		}
		return text;
	};
	const url = "https://openrouter.ai/api/v1/responses";
	const body = JSON.stringify({
		model,
		input,
		tools: [countFilesTool],
		instructions: `Project target folders (absolute directory paths): ${JSON.stringify(config?.targetFolders ?? [])}. Use count_files only for these folders or their subdirectories.`,
		stream: true,
		...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
	});
	const started = performance.now();
	let upstream: Response | undefined;
	let raw = "";
	let completed = false;
	let protocol: unknown[] = [];
	let terminalFailure = false;
	const items = new Map<number, OutputItem>();
	const item = (index: number, id = "", type = "message") => {
		let value = items.get(index);
		if (!value) {
			value = { index, id, type, content: [] };
			items.set(index, value);
		}
		if (id) value.id = id;
		return value;
	};
	const part = (value: OutputItem, index: number, type: string) => {
		let valuePart = value.content.find(
			(part) => part.index === index && part.type === type,
		);
		if (!valuePart) {
			valuePart = { index, type, text: "" };
			value.content.push(valuePart);
		}
		return valuePart;
	};
	const snapshot = (index: number, data: unknown) => {
		const source = object(data);
		const value = item(
			index,
			String(source.id ?? ""),
			String(source.type ?? "message"),
		);
		value.type = String(source.type ?? value.type);
		for (const field of ["content", "summary"] as const) {
			const content = source[field];
			if (!Array.isArray(content)) continue;
			content.forEach((sourcePart, index) => {
				const data = object(sourcePart);
				const type = String(
					data.type ?? (field === "summary" ? "summary_text" : "output_text"),
				);
				const text = data.text ?? data.refusal;
				if (typeof text === "string") part(value, index, type).text = text;
			});
		}
	};
	const output = (final = false) =>
		[...items.values()]
			.sort((a, b) => a.index - b.index)
			.map((value) => ({
				...value,
				id: redact(value.id),
				type: redact(value.type),
				content: value.content
					.sort((a, b) => a.index - b.index)
					.map((part) => ({
						...part,
						type: redact(part.type),
						text: safe(part.text, final),
					})),
			}));
	const persist = (result: CallResult, values: OutputItem[]) => {
		try {
			record?.result(result, values);
		} catch (error) {
			throw new PersistenceError(error);
		}
	};
	const save = (
		status: CallResult["status"],
		error: string | null = null,
		final = false,
	) =>
		persist(
			{
				status,
				httpStatus: upstream?.status ?? null,
				responseBody: raw ? safe(raw, final) : null,
				durationMs: Math.round(performance.now() - started),
				error: error ? redact(error) : null,
			},
			output(final),
		);
	const event = (frame: string) => {
		const payload = frame
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (!payload || payload === "[DONE]") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			return;
		}
		const data = object(parsed);
		const type = String(data.type ?? "");
		const index = Number(data.output_index ?? 0);
		if (
			type === "response.output_item.added" ||
			type === "response.output_item.done"
		)
			snapshot(index, data.item);
		if (
			type === "response.content_part.added" ||
			type === "response.content_part.done"
		) {
			const p = object(data.part);
			const text = p.text ?? p.refusal;
			if (typeof text === "string")
				part(
					item(index, String(data.item_id ?? "")),
					Number(data.content_index ?? 0),
					String(p.type ?? "output_text"),
				).text = text;
		}
		const kinds: Record<string, string> = {
			"response.output_text.delta": "output_text",
			"response.refusal.delta": "refusal",
			"response.reasoning_text.delta": "reasoning_text",
			"response.reasoning_summary_text.delta": "summary_text",
		};
		if (kinds[type] && typeof data.delta === "string") {
			const value = item(
				index,
				String(data.item_id ?? ""),
				type.includes("reasoning") ? "reasoning" : "message",
			);
			part(
				value,
				Number(data.content_index ?? data.summary_index ?? 0),
				kinds[type],
			).text += data.delta;
		}
		if (
			type === "response.completed" ||
			type === "response.failed" ||
			type === "response.incomplete"
		) {
			const response = object(data.response);
			if (Array.isArray(response.output))
				response.output.forEach((value, index) => {
					snapshot(index, value);
				});
			completed =
				type === "response.completed" &&
				response.status === "completed" &&
				Array.isArray(response.output);
			if (completed) protocol = response.output as unknown[];
			terminalFailure ||= !completed;
		}
		if (type === "error") terminalFailure = true;
	};
	record?.request({
		url,
		method: "POST",
		requestedAt: new Date().toISOString(),
		requestBody: redact(body),
	});
	try {
		upstream = await fetchModel(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body,
		});
		save("pending");
		if (!upstream.body)
			throw new ModelError(
				upstream.ok ? "modelInvalidResponse" : "modelRequestFailed",
				upstream.ok
					? "OpenRouter returned an invalid response"
					: "OpenRouter request failed",
			);
		const reader = upstream.body.getReader();
		const decoder = new TextDecoder();
		let frames = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				const text = decoder.decode(value, { stream: !done });
				raw += text;
				if (upstream.ok) frames += text;
				let boundary = /\r?\n\r?\n/.exec(frames);
				while (boundary) {
					event(frames.slice(0, boundary.index));
					frames = frames.slice(boundary.index + boundary[0].length);
					boundary = /\r?\n\r?\n/.exec(frames);
				}
				save("pending", null, done);
				if (done) break;
			}
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		if (!upstream.ok)
			throw new ModelError(
				"modelRequestFailed",
				"OpenRouter request failed",
				`HTTP ${upstream.status}`,
			);
		if (!completed || terminalFailure)
			throw new ModelError(
				"modelInvalidResponse",
				"OpenRouter returned an incomplete response",
			);
		const tools: { name: string; arguments: string; call_id: string }[] = [];
		const callIds = new Set<string>();
		for (const value of protocol) {
			const call = object(value);
			if (typeof call.type !== "string" || !call.type)
				throw new ModelError(
					"modelInvalidResponse",
					"OpenRouter returned an invalid response",
				);
			if (call.type !== "function_call") continue;
			if (
				typeof call.call_id !== "string" ||
				!call.call_id.trim() ||
				callIds.has(call.call_id) ||
				typeof call.name !== "string" ||
				typeof call.arguments !== "string"
			)
				throw new ModelError(
					"modelInvalidResponse",
					"OpenRouter returned an invalid tool call",
				);
			callIds.add(call.call_id);
			tools.push({
				name: call.name,
				arguments: call.arguments,
				call_id: call.call_id,
			});
		}
		const hasAnswer = protocol.some((value) => {
			const item = object(value);
			return (
				item.type === "message" &&
				Array.isArray(item.content) &&
				item.content.some((value) => {
					const part = object(value);
					const text =
						part.type === "refusal"
							? (part.refusal ?? part.text)
							: part.type === "output_text"
								? part.text
								: null;
					return typeof text === "string" && text.trim().length > 0;
				})
			);
		});
		if (!hasAnswer && !tools.length)
			throw new ModelError(
				"modelNoAnswer",
				"OpenRouter did not return a text answer",
			);
		save("succeeded", null, true);
		return { protocol, tools };
	} catch (error) {
		// Persistence errors never trigger another write or model call.
		if (error instanceof PersistenceError) throw error.cause;
		save(
			"failed",
			error instanceof ModelError ? error.message : String(error),
			true,
		);
		throw error instanceof ModelError
			? error
			: new ModelError("modelRequestFailed", "OpenRouter request failed");
	}
}
