import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolExecutor } from "../src/file-tools.ts";
import {
	type CallResult,
	ModelError,
	requestModel,
} from "../src/openrouter.ts";
import { completedResponse } from "./model-fixture.ts";

const tools = (count = 1) =>
	completedResponse({
		output: Array.from({ length: count }, (_, i) => ({
			type: "function_call",
			name: "test_tool",
			arguments: '{"value":"complete operation"}',
			call_id: `call-${i}`,
		})),
	});
const answer = () =>
	completedResponse({
		output: [
			{
				type: "message",
				content: [{ type: "output_text", text: "task answer" }],
			},
		],
	});
const decision = (choice: string) =>
	Response.json({
		model: "typesafe/jev-test",
		answers: {
			safety: {
				type: "choice",
				choice,
				probabilities: { allow: 0.01, block: 0.99 },
			},
		},
		usage: { input_tokens: 25, output_tokens: 0 },
	});
const config = { apiKey: "fake-secret", model: "task-model" };

for (const choice of [
	"allow",
	"block",
	"invalid",
	"invalid-json",
	"missing-type",
	"missing-choice",
	"http-error",
	"network-error",
]) {
	test(`Decisions ${choice} keeps task continuation separate and records actual protocol`, async () => {
		let responses = 0;
		let executed = false;
		const records: { url: string; results: CallResult[] }[] = [];
		const fake: typeof fetch = async (url, init) => {
			const body = JSON.parse(String(init?.body));
			if (String(url).endsWith("/decisions")) {
				assert.equal(body.model, "~typesafe/jev-latest");
				assert.deepEqual(body.state, {
					name: "test_tool",
					description: "Test operation",
					arguments: { value: "complete operation" },
				});
				assert.equal(body.questions.safety.type, "choice");
				assert.deepEqual(Object.keys(body.questions.safety.criteria), [
					"allow",
					"block",
				]);
				assert.match(
					body.questions.safety.instructions,
					/Do not judge whether it fits a task/,
				);
				assert.equal(
					new Headers(init?.headers).get("authorization"),
					"Bearer fake-secret",
				);
				if (choice === "network-error") throw new Error("network fake-secret");
				if (choice === "invalid-json")
					return new Response("not JSON fake-secret");
				if (choice === "missing-type")
					return Response.json({ answers: { safety: { choice: "allow" } } });
				if (choice === "missing-choice")
					return Response.json({ answers: { safety: { type: "choice" } } });
				return choice === "http-error"
					? new Response("insufficient credits fake-secret", { status: 402 })
					: decision(choice);
			}
			if (++responses === 1) return tools();
			assert.equal(JSON.stringify(body.input).includes("probabilities"), false);
			return answer();
		};
		const execute: ToolExecutor = async (
			_name,
			_args,
			_roots,
			_signal,
			review,
		) => {
			try {
				await review?.({
					name: "test_tool",
					description: "Test operation",
					arguments: { value: "complete operation" },
				});
				executed = true;
				return { status: "succeeded", result: "done" };
			} catch (error) {
				assert(error instanceof ModelError);
				assert.equal(
					error.code,
					choice === "block" ? "safetyReviewBlocked" : "safetyReviewFailed",
				);
				return { status: "failed", result: error.message };
			}
		};
		assert.equal(
			await requestModel(
				[],
				"private task",
				fake,
				{
					request: (call) => records.push({ url: call.url, results: [] }),
					result: (result) => records.at(-1)?.results.push(result),
				},
				config,
				execute,
			),
			"task answer",
		);
		assert.equal(executed, choice === "allow");
		assert.equal(records.length, 3);
		assert.equal(records[0].results.at(-1)?.status, "succeeded");
		assert.equal(
			records[1].results.at(-1)?.status,
			["allow", "block"].includes(choice) ? "succeeded" : "failed",
		);
		assert.equal(JSON.stringify(records).includes("fake-secret"), false);
	});
}

test("Decisions consume the same dynamic request budget within one multi-tool response", async () => {
	let requests = 0;
	let executed = 0;
	let limit = 4;
	const statuses: string[] = [];
	const fake: typeof fetch = async (url) => {
		requests++;
		if (!String(url).endsWith("/decisions")) return tools(3);
		if (requests === 3) limit = 3;
		return decision("allow");
	};
	const execute: ToolExecutor = async (
		_name,
		_args,
		_roots,
		_signal,
		review,
	) => {
		await review?.({ name: "test_tool", description: "test", arguments: {} });
		executed++;
		return { status: "succeeded", result: "done" };
	};
	await assert.rejects(
		requestModel(
			[],
			"task",
			fake,
			{
				request: () => statuses.push("pending"),
				result: (result) => {
					statuses[statuses.length - 1] = result.status;
				},
			},
			config,
			execute,
			{
				targetFolders: () => [],
				limit: () => limit,
				pending: () => false,
				events: () => [],
				wait: async () => {},
			},
		),
		(error: unknown) =>
			error instanceof ModelError && error.code === "modelCallLimit",
	);
	assert.equal(requests, 3);
	assert.equal(executed, 2);
	assert.deepEqual(statuses, ["succeeded", "succeeded", "succeeded"]);
});

test("disabled review sends no Decisions HTTP and late allow cannot pass cancellation", async () => {
	let requests = 0;
	let executed = false;
	const control = new AbortController();
	const execute: ToolExecutor = async (
		_name,
		_args,
		_roots,
		_signal,
		review,
	) => {
		await review?.({ name: "test_tool", description: "test", arguments: {} });
		executed = true;
		return { status: "succeeded", result: "done" };
	};
	const fake: typeof fetch = async (url) => {
		requests++;
		if (String(url).endsWith("/decisions")) {
			control.abort();
			return decision("allow");
		}
		return requests === 1 ? tools() : answer();
	};
	assert.equal(
		await requestModel(
			[],
			"task",
			fake,
			undefined,
			{ ...config, safetyReview: false },
			execute,
		),
		"task answer",
	);
	assert.equal(requests, 2);
	executed = false;
	requests = 0;
	await assert.rejects(
		requestModel([], "task", fake, undefined, config, execute, {
			signal: control.signal,
			targetFolders: () => [],
			limit: () => 16,
			pending: () => false,
			events: () => [],
			wait: async () => {},
		}),
	);
	assert.equal(executed, false);
	assert.equal(requests, 2);
});
