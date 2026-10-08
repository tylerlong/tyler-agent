import {
	executeTool,
	fileTools,
	type ToolExecution,
	type ToolExecutor,
} from "./file-tools.ts";

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
	errorCode?: string | null;
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
const readableItem = (data: unknown, index: number): OutputItem => {
	const source = object(data);
	const content: OutputPart[] = [];
	for (const field of ["content", "summary"] as const) {
		if (!Array.isArray(source[field])) continue;
		source[field].forEach((value, index) => {
			const part = object(value);
			const text = part.text ?? part.refusal;
			if (typeof text === "string")
				content.push({
					index,
					type: String(
						part.type ?? (field === "summary" ? "summary_text" : "output_text"),
					),
					text,
				});
		});
	}
	content.sort((a, b) => a.index - b.index);
	return {
		index,
		id: String(source.id ?? ""),
		type: String(source.type ?? "message"),
		content,
	};
};
export function responseOutput(responseBody: string | null): OutputItem[] {
	if (!responseBody) return [];
	const response = object(JSON.parse(responseBody));
	return Array.isArray(response.output)
		? response.output.map(readableItem)
		: [];
}
export type ModelConfig = {
	apiKey: string;
	model: string;
	reasoningEffort?: string | null;
	targetFolders?: string[];
	models?: { id: string; name: string; reasoningEfforts: string[] }[];
};
export type ToolRequest = { name: string; arguments: string; call_id: string };
type Recorder = {
	request: (request: CallRequest) => void;
	result: (result: CallResult, output: OutputItem[]) => void;
	tools?: (calls: ToolRequest[], reason?: string) => void;
	toolStarted?: (ordinal: number) => void;
	toolFinished?: (ordinal: number, result: ToolExecution) => void;
};
export const createSubAgentTool = {
	type: "function",
	name: "create_sub_agent",
	description:
		"Create an independent sub-agent and immediately return its identity and initial status. Success, failure or cancellation results arrive automatically in subsequent requests. Continue independent work, or finish your current response without Tool Calls to yield while the runtime awaits child results. No ancestor conversation is inherited; supply any background explicitly as context.",
	parameters: {
		type: "object",
		properties: {
			prompt: { type: "string" },
			context: { type: "string" },
			model_id: {
				type: "string",
				description:
					"Optional configured model ID. Omission inherits the parent model.",
			},
			reasoning_effort: {
				type: ["string", "null"],
				description:
					"Omission inherits parent effort; null uses model default. A model-only override retains compatible effort, otherwise uses the new model default.",
			},
		},
		required: ["prompt"],
		additionalProperties: false,
	},
};
export const cancelSubAgentTool = {
	type: "function",
	name: "cancel_sub_agent",
	description:
		"Stop a directly created sub-agent and all its descendants. Returns its actual terminal status, existing output and errors only after execution and cleanup have stopped.",
	parameters: {
		type: "object",
		properties: { agent_id: { type: "integer" } },
		required: ["agent_id"],
		additionalProperties: false,
	},
};
export type AgentLoop = {
	signal?: AbortSignal;
	targetFolders: () => string[];
	limit: () => number;
	pending: () => boolean;
	events: () => unknown[];
	wait: () => Promise<void>;
};
export async function requestModel(
	messages: Message[],
	prompt: string,
	fetchModel: typeof fetch,
	record?: Recorder,
	config?: ModelConfig | (() => ModelConfig),
	execute: ToolExecutor = executeTool,
	loop?: AgentLoop,
) {
	const input: unknown[] = [...messages, { role: "user", content: prompt }];
	let previous: OutputItem[] = [];
	const usedSecrets = new Set<string>();
	for (let round = 0; ; round++) {
		loop?.signal?.throwIfAborted();
		if (round >= (loop?.limit() ?? 16))
			throw new ModelError(
				"modelCallLimit",
				"Agent reached the model request limit",
			);
		input.push(...(loop?.events() ?? []));
		let current: OutputItem[] = [];
		const currentConfig = typeof config === "function" ? config() : config;
		if (currentConfig?.apiKey) {
			usedSecrets.add(currentConfig.apiKey);
			usedSecrets.add(JSON.stringify(currentConfig.apiKey).slice(1, -1));
		}
		const response = await requestOnce(
			input,
			fetchModel,
			{
				request: (call) => record?.request(call),
				result: (result, output) => {
					current = output;
					record?.result(result, current);
				},
			},
			currentConfig,
			[...usedSecrets],
			loop?.signal,
		);
		previous = [...previous, ...current];
		input.push(...response.protocol);
		loop?.signal?.throwIfAborted();
		if (!response.tools.length) {
			if (loop?.pending()) await loop.wait();
			const events = loop?.events() ?? [];
			if (!events.length) return answerText(previous);
			input.push(...events);
			continue;
		}
		const atLimit = round + 1 >= (loop?.limit() ?? 16);
		record?.tools?.(response.tools, atLimit ? "modelCallLimit" : undefined);
		if (atLimit)
			throw new ModelError(
				"modelCallLimit",
				"Agent reached the model request limit",
			);
		for (const [index, call] of response.tools.entries()) {
			loop?.signal?.throwIfAborted();
			record?.toolStarted?.(index + 1);
			const result = await execute(
				call.name,
				call.arguments,
				loop
					? loop.targetFolders()
					: ((typeof config === "function" ? config() : config)
							?.targetFolders ?? []),
				loop?.signal,
			);
			record?.toolFinished?.(index + 1, result);
			loop?.signal?.throwIfAborted();
			input.push({
				type: "function_call_output",
				call_id: call.call_id,
				output: result.result,
			});
		}
	}
}
async function requestOnce(
	input: unknown[],
	fetchModel: typeof fetch,
	record: Recorder,
	config?: ModelConfig,
	usedSecrets: string[] = [],
	signal?: AbortSignal,
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
	const secrets = [
		...new Set([...usedSecrets, apiKey, JSON.stringify(apiKey).slice(1, -1)]),
	];
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
		tools: [...fileTools, createSubAgentTool, cancelSubAgentTool],
		instructions: `Project target folders (absolute directory paths): ${JSON.stringify(config?.targetFolders ?? [])}. Use file tools only within these folders. Configured models for create_sub_agent overrides (IDs, names, allowed reasoning efforts): ${JSON.stringify(config?.models ?? [])}.`,

		stream: true,
		...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
	});
	const started = performance.now();
	let upstream: Response | undefined;
	let raw = "";
	let actualResponse: unknown;
	let isSse = false;
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
		const source = readableItem(data, index);
		const value = item(index, source.id, source.type);
		value.type = String(object(data).type ?? value.type);
		for (const p of source.content) part(value, p.index, p.type).text = p.text;
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
		errorCode: string | null = null,
	) => {
		const response =
			actualResponse !== undefined && (status !== "pending" || terminalFailure)
				? redact(JSON.stringify(actualResponse))
				: !isSse && (!upstream?.ok || status === "failed")
					? safe(raw, final)
					: "";
		persist(
			{
				status,
				httpStatus: upstream?.status ?? null,
				responseBody: response || null,
				durationMs: Math.round(performance.now() - started),
				error: error ? redact(error) : null,
				errorCode,
			},
			output(final),
		);
	};
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
			if (data.response !== undefined) actualResponse = data.response;
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
		if (type === "error") {
			terminalFailure = true;
			actualResponse = parsed;
		}
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
			signal,
		});
		isSse =
			upstream.headers
				.get("content-type")
				?.split(";", 1)[0]
				.trim()
				.toLowerCase() === "text/event-stream";
		save("pending");
		if (!upstream.body)
			throw new ModelError(
				upstream.ok ? "modelInvalidResponse" : "modelRequestFailed",
				upstream.ok
					? "OpenRouter returned an invalid response"
					: "OpenRouter request failed",
			);
		signal?.throwIfAborted();
		const reader = upstream.body.getReader();
		let abortDone: Promise<void> | undefined;
		const abort = () => {
			abortDone = reader.cancel().catch(() => {});
		};
		signal?.addEventListener("abort", abort, { once: true });
		const decoder = new TextDecoder();
		let frames = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				signal?.throwIfAborted();
				const text = decoder.decode(value, { stream: !done });
				if (upstream.ok || isSse) frames += text;
				if (!isSse) {
					raw += text;
					if (/(?:^|[\r\n])(?:data|event):/.test(raw)) {
						isSse = true;
						if (!upstream.ok) frames = raw;
						raw = "";
					}
				}
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
			signal?.removeEventListener("abort", abort);
			await abortDone;
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
				(call.status !== undefined && call.status !== "completed") ||
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
		items.clear();
		protocol.forEach((value, index) => {
			snapshot(index, value);
		});
		save("succeeded", null, true);
		return { protocol, tools };
	} catch (error) {
		// Persistence errors never trigger another write or model call.
		if (error instanceof PersistenceError) throw error.cause;
		const failure = signal?.aborted
			? new ModelError("agentCancelled", "Agent cancelled")
			: error;
		save(
			"failed",
			failure instanceof ModelError ? failure.message : String(failure),
			true,
			failure instanceof ModelError ? failure.code : "modelRequestFailed",
		);
		throw failure instanceof ModelError
			? failure
			: new ModelError("modelRequestFailed", "OpenRouter request failed");
	}
}
