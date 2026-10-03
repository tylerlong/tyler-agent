import assert from "node:assert/strict";
import { test } from "node:test";
import { requestModel } from "../src/openrouter.ts";
import { completedResponse } from "./model-fixture.ts";

test("retained OpenRouter transport sends contextual JSON without terminal communication logs", async () => {
	const previousKey = process.env.OPENROUTER_API_KEY;
	const previousModel = process.env.OPENROUTER_MODEL;
	const original = console.log;
	const logs: string[] = [];
	process.env.OPENROUTER_API_KEY = 'fake"secret';
	process.env.OPENROUTER_MODEL = "test-model";
	console.log = (...values) => logs.push(values.join(" "));
	try {
		const fake: typeof fetch = async (url, init) => {
			assert.equal(url, "https://openrouter.ai/api/v1/responses");
			assert.equal(
				new Headers(init?.headers).get("authorization"),
				'Bearer fake"secret',
			);
			assert.deepEqual(JSON.parse(String(init?.body)), {
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
				echo: process.env.OPENROUTER_API_KEY,
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
		if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = previousKey;
		if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
		else process.env.OPENROUTER_MODEL = previousModel;
	}
});
