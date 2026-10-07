import assert from "node:assert/strict";
import { test } from "node:test";
import { requestModel as request } from "../src/openrouter.ts";

const requestModel = (
	messages: Parameters<typeof request>[0],
	prompt: string,
	fake: typeof fetch,
) =>
	request(messages, prompt, fake, undefined, {
		apiKey: 'fake"secret',
		model: "test-model",
	});

import { completedResponse } from "./model-fixture.ts";

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
			assert.equal(body.tools[0].name, "list_files");
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
