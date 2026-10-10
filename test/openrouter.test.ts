import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type CallResult,
	type OutputItem,
	requestModel as request,
	responseOutput,
} from "../src/openrouter.ts";

const requestModel = (
	messages: Parameters<typeof request>[0],
	prompt: string,
	fake: typeof fetch,
) =>
	request(messages, prompt, fake, undefined, {
		apiKey: 'fake"secret',
		model: "test-model",
	});

import { completedResponse, frame } from "./model-fixture.ts";

test("retained OpenRouter transport sends contextual JSON without terminal communication logs", async () => {
	const original = console.log;
	const logs: string[] = [];
	console.log = (...values) => logs.push(values.join(" "));
	try {
		const fake: typeof fetch = async (url, init) => {
			assert.equal(url, "https://openrouter.ai/api/v1/responses");
			assert.equal(
				new Headers(init?.headers).get("authorization"),
				'Bearer fake"secret',
			);
			const body = JSON.parse(String(init?.body));
			assert.equal(body.tools[0].name, "read_file");
			assert.match(body.instructions, /target folders/);
			const { tools, instructions, ...request } = body;
			assert.deepEqual(request, {
				model: "test-model",
				input: [
					{ role: "user", content: "1?" },
					{ role: "assistant", content: "1" },
					{ role: "user", content: "double?" },
				],
				stream: true,
			});
			return completedResponse({
				output: [
					{ type: "message", content: [{ type: "output_text", text: "2" }] },
				],
				echo: 'fake"secret',
			});
		};
		assert.equal(
			await requestModel(
				[
					{ role: "user", content: "1?" },
					{ role: "assistant", content: "1" },
				],
				"double?",
				fake,
			),
			"2",
		);
		assert.equal(logs.length, 0);
		const count = logs.length;
		await requestModel(
			[
				{ role: "user", content: "1?" },
				{ role: "assistant", content: "1" },
			],
			"double?",
			fake,
		);
		assert.equal(logs.length, count);
		await assert.rejects(
			() =>
				requestModel(
					[],
					"bad",
					async () => new Response("no", { status: 500 }),
				),
			/OpenRouter request failed/,
		);
		await assert.rejects(() =>
			requestModel([], "bad", async () => new Response("bad json")),
		);
		await assert.rejects(
			() =>
				requestModel([], "bad", async () => completedResponse({ output: [] })),
			/did not return a text answer/,
		);
		await assert.rejects(() =>
			requestModel([], "bad", async () => {
				throw new Error('network fake"secret');
			}),
		);
		assert.doesNotMatch(logs.join("\n"), /fake/);
	} finally {
		console.log = original;
	}
});

test("stream partials stay readable without durable frames, and authoritative final output replaces them", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const saved: { result: CallResult; output: OutputItem[] }[] = [];
	const pending = request(
		[],
		"question",
		async () =>
			new Response(
				new ReadableStream({
					start(value) {
						controller = value;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
		{
			request() {},
			result(result, output) {
				saved.push({ result, output });
			},
		},
		{ apiKey: "stream-secret", model: "test" },
	);
	const send = (value: string) =>
		controller.enqueue(new TextEncoder().encode(value));
	await new Promise((resolve) => setImmediate(resolve));
	send(
		frame("response.reasoning_text.delta", {
			output_index: 0,
			delta: "old reasoning",
		}) +
			frame("response.output_text.delta", {
				output_index: 1,
				delta: "old answer stream-",
			}),
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(saved.at(-1)?.output[1].content[0].text, "old answer ");
	send(
		frame("response.output_text.delta", {
			output_index: 1,
			delta: "secret extra",
		}),
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(
		saved.at(-1)?.output[1].content[0].text,
		"old answer [REDACTED] extra",
	);
	const final = {
		status: "completed",
		id: "actual",
		usage: { tokens: 9 },
		provider: "provider",
		output: [
			{
				id: "final",
				type: "message",
				content: [{ type: "refusal", refusal: "final answer" }],
			},
		],
		echo: "stream-secret",
	};
	const bytes = new TextEncoder().encode(
		frame("response.completed", { response: final }),
	);
	for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
	controller.close();
	assert.equal(await pending, "final answer");
	assert(
		saved
			.filter((v) => v.result.status === "pending")
			.every((v) => v.result.responseBody === null),
	);
	const last = saved.at(-1);
	assert(last?.result.responseBody);
	assert.equal(last.result.status, "succeeded");
	assert.deepEqual(JSON.parse(last.result.responseBody), {
		...final,
		echo: "[REDACTED]",
	});
	assert.deepEqual(last.output, responseOutput(last.result.responseBody));
	assert.equal(last.output.length, 1);
	assert.doesNotMatch(JSON.stringify(saved), /stream-secret|data:/);
});

test("continuation sends actual final tool items and excludes provisional text", async () => {
	let rounds = 0;
	const tool = {
		type: "function_call",
		status: "completed",
		id: "tool",
		call_id: "call",
		name: "count_files",
		arguments: '{"path":"/tmp"}',
	};
	const result = await request(
		[],
		"question",
		async (_url, init) => {
			const input = JSON.parse(String(init?.body)).input;
			if (rounds++ === 0)
				return new Response(
					frame("response.output_text.delta", { delta: "stale" }) +
						frame("response.completed", {
							response: { status: "completed", output: [tool] },
						}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			assert.deepEqual(input.slice(1), [
				tool,
				{ type: "function_call_output", call_id: "call", output: "result" },
			]);
			return completedResponse({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "answer" }],
					},
				],
			});
		},
		undefined,
		{ apiKey: "secret", model: "test" },
		async () => ({ status: "succeeded", result: "result", error: null }),
	);
	assert.equal(result, "answer");
	assert.equal(rounds, 2);
});

for (const terminal of [
	{ type: "error", code: "provider", message: "secret diagnostic" },
	{
		type: "response.failed",
		response: {
			status: "failed",
			error: { message: "secret diagnostic" },
			output: [],
		},
	},
	{
		type: "response.incomplete",
		response: {
			status: "incomplete",
			incomplete_details: { reason: "limit" },
			output: [],
		},
	},
])
	test(`actual ${terminal.type} diagnostics survive without SSE records`, async () => {
		const saved: CallResult[] = [];
		await assert.rejects(
			request(
				[],
				"question",
				async () =>
					new Response(
						frame("response.output_text.delta", { delta: "partial" }) +
							frame(terminal.type, terminal),
						{ headers: { "content-type": "text/event-stream" } },
					),
				{
					request() {},
					result(value) {
						saved.push(value);
					},
				},
				{ apiKey: "secret", model: "test" },
			),
		);
		const expected = "response" in terminal ? terminal.response : terminal;
		const last = saved.at(-1);
		assert(last?.responseBody);
		assert.deepEqual(
			JSON.parse(last.responseBody),
			JSON.parse(JSON.stringify(expected).replaceAll("secret", "[REDACTED]")),
		);
		assert.equal(last.status, "failed");
		assert.doesNotMatch(
			JSON.stringify(saved),
			/data:|response.output_text.delta|secret/,
		);
	});

test("HTTP failure parses actual structured SSE diagnostics without retaining frames", async () => {
	const saved: CallResult[] = [];
	await assert.rejects(
		request(
			[],
			"question",
			async () =>
				new Response(
					frame("error", { code: "provider", message: "secret diagnostic" }),
					{ status: 503, headers: { "content-type": "text/event-stream" } },
				),
			{
				request() {},
				result(value) {
					saved.push(value);
				},
			},
			{ apiKey: "secret", model: "test" },
		),
		/OpenRouter request failed/,
	);
	const last = saved.at(-1);
	assert(last?.responseBody);
	assert.equal(last.httpStatus, 503);
	assert.deepEqual(JSON.parse(last.responseBody), {
		type: "error",
		code: "provider",
		message: "[REDACTED] diagnostic",
	});
	assert.doesNotMatch(JSON.stringify(saved), /data:|secret/);
});

test("headerless incomplete SSE preserves readable partials without saving frames or unfinished tails", async () => {
	const saved: { result: CallResult; output: OutputItem[] }[] = [];
	const raw =
		frame("response.output_text.delta", { delta: "partial" }) +
		'data: {"unfinished":';
	await assert.rejects(
		request(
			[],
			"question",
			async () => new Response(raw),
			{
				request() {},
				result(result, output) {
					saved.push({ result, output });
				},
			},
			{ apiKey: "secret", model: "test" },
		),
		/incomplete response/,
	);
	const last = saved.at(-1);
	assert(last);
	assert.equal(last.result.status, "failed");
	assert(saved.every((value) => value.result.responseBody === null));
	assert.equal(last.output[0].content[0].text, "partial");
	assert.doesNotMatch(
		JSON.stringify(saved),
		/data:|response.output_text.delta|unfinished/,
	);
});
