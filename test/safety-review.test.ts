import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ToolExecutor } from "../src/file-tools.ts";
import { createServer } from "../src/server.ts";
import { waitForAgent } from "./agent-fixture.ts";
import { configureDatabase } from "./config-fixture.ts";
import { localFetch, managementTokens } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

const decisionUrl = "https://openrouter.ai/api/alpha/decisions";
const secret = "controlled-safety-secret";
const answer = () =>
	completedResponse({
		output: [
			{
				id: "answer",
				type: "message",
				content: [{ type: "output_text", text: "Task finished" }],
			},
		],
	});
const tools = (count = 1) =>
	completedResponse({
		output: Array.from({ length: count }, (_, index) => ({
			id: `tool-${index}`,
			type: "function_call",
			name: "read_file",
			call_id: `tool-${index}`,
			arguments: JSON.stringify({ path: `/controlled/file-${index}` }),
		})),
	});
const decision = (choice = "allow") =>
	Response.json({
		id: "dec-review",
		model: "typesafe/jev-controlled-version",
		output: [
			{
				type: "message",
				content: [
					{ type: "output_text", text: "REVIEW OUTPUT MUST STAY PRIVATE" },
				],
			},
		],
		answers: {
			safety: {
				type: "choice",
				choice,
				probabilities: { allow: 0.01, block: 0.99 },
				confidence: 0.01,
			},
		},
		usage: { input_tokens: 12, output_tokens: 0, cost: 0 },
	});
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
async function fixture(model: typeof fetch, execute?: ToolExecutor) {
	const directory = await mkdtemp(join(tmpdir(), "weft-safety-"));
	const path = join(directory, "db.sqlite");
	configureDatabase(path, secret, "controlled-task");
	const launch = () =>
		createServer(
			model,
			path,
			async () => {
				throw new Error("Unexpected catalog HTTP");
			},
			execute,
			"a".repeat(64),
			directory,
		).listen(0, "127.0.0.1");
	let server = launch();
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	let base = `http://127.0.0.1:${address.port}`;
	managementTokens.set(base, server.managementToken);
	const request = async (route: string, method = "GET", body?: unknown) => {
		const response = await localFetch(base + route, {
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		assert(
			response.ok,
			`${method} ${route}: ${response.status} ${await response.clone().text()}`,
		);
		return response.json();
	};
	const project = await request("/api/projects", "POST", {
		name: "Safety",
		folders: [],
	});
	const chat = await request(`/api/projects/${project.id}/chats`, "POST", {
		name: "Controlled",
	});
	return {
		request,
		chatId: chat.id,
		databasePath: path,
		raw: (body: unknown) =>
			localFetch(`${base}/api/safety-review`, {
				method: "PATCH",
				body: JSON.stringify(body),
			}),
		restart: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			managementTokens.delete(base);
			server = launch();
			await new Promise<void>((resolve) => server.once("listening", resolve));
			const address = server.address();
			assert(address && typeof address !== "string");
			base = `http://127.0.0.1:${address.port}`;
			managementTokens.set(base, server.managementToken);
		},
		ask: async () =>
			(
				await request(`/api/chats/${chat.id}`, "POST", {
					prompt: "PRIVATE TASK CONTEXT",
				})
			).agentId as number,
		wait: (id: number) => waitForAgent(base, id),
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			managementTokens.delete(base);
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("default safety review records ordinary calls, permits direct allow and keeps Decisions out of task continuation", async () => {
	const http: { url: string; body: Record<string, unknown> }[] = [];
	const executed: string[] = [];
	let tasks = 0;
	const f = await fixture(
		async (url, init) => {
			const body = JSON.parse(String(init?.body));
			http.push({ url: String(url), body });
			assert.equal(
				new Headers(init?.headers).get("authorization"),
				`Bearer ${secret}`,
			);
			if (String(url) === decisionUrl) {
				assert.equal(body.model, "~typesafe/jev-latest");
				assert.match(JSON.stringify(body), /\/controlled\/file-0/);
				assert(!JSON.stringify(body).includes("PRIVATE TASK CONTEXT"));
				return decision();
			}
			assert.equal(body.model, "controlled-task");
			if (++tasks === 1) return tools();
			assert(!JSON.stringify(body).includes("dec-review"));
			assert(!JSON.stringify(body).includes("jev-controlled-version"));
			assert(!JSON.stringify(body).includes("REVIEW OUTPUT MUST STAY PRIVATE"));
			return answer();
		},
		async (name, args) => {
			assert.equal(name, "read_file");
			executed.push(args);
			return { status: "succeeded", result: '{"text":"controlled contents"}' };
		},
	);
	try {
		assert.deepEqual(await f.request("/api/safety-review"), {
			safetyReview: true,
		});
		const id = await f.ask();
		const agent = await f.wait(id);
		assert.equal(agent.status, "succeeded");
		assert.equal(agent.answer, "Task finished");
		assert(
			!JSON.stringify(agent.output).includes("REVIEW OUTPUT MUST STAY PRIVATE"),
		);
		assert.equal(executed.length, 1);
		const calls = (await f.request(`/api/agents/${id}/calls`)).calls;
		assert.equal(calls.length, 3);
		assert(
			calls.every((call: { status: string }) => call.status === "succeeded"),
		);
		const review = calls.find(
			(call: { url: string }) => call.url === decisionUrl,
		);
		assert(review);
		assert.equal(
			JSON.parse(review.responseBody).model,
			"typesafe/jev-controlled-version",
		);
		assert.equal(JSON.parse(review.responseBody).usage.input_tokens, 12);
		assert(!JSON.stringify(calls).includes(secret));
		const lazy = (
			await f.request(
				`/api/agents/${id}/calls?kind=response&callId=${review.id}`,
			)
		).calls;
		assert.equal(lazy[0].responseBody, review.responseBody);
		assert.equal(http.length, calls.length);
	} finally {
		await f.close();
	}
});

test("disabled global safety review sends zero Decisions HTTP and rejects malformed settings", async () => {
	let requests = 0;
	let executed = 0;
	const f = await fixture(
		async (url) => {
			assert.notEqual(String(url), decisionUrl);
			return ++requests === 1 ? tools() : answer();
		},
		async () => {
			executed++;
			return { status: "succeeded", result: "done" };
		},
	);
	try {
		for (const invalid of [
			{},
			{ safetyReview: 0 },
			{ safetyReview: "false" },
			{ safetyReview: false, projectId: 1 },
		]) {
			assert.equal((await f.raw(invalid)).status, 400);
		}
		await f.request("/api/safety-review", "PATCH", { safetyReview: false });
		await f.restart();
		assert.deepEqual(await f.request("/api/safety-review"), {
			safetyReview: false,
		});
		const id = await f.ask();
		assert.equal((await f.wait(id)).status, "succeeded");
		assert.equal(requests, 2);
		assert.equal(executed, 1);
	} finally {
		await f.close();
	}
});

for (const [name, review, reviewStatus] of [
	["block", async () => decision("block"), "succeeded"],
	[
		"HTTP failure",
		async () =>
			Response.json(
				{ error: { message: "controlled HTTP failure" } },
				{ status: 503 },
			),
		"failed",
	],
	[
		"insufficient credits",
		async () =>
			Response.json(
				{ error: { message: "controlled balance failure" } },
				{ status: 402 },
			),
		"failed",
	],
	[
		"network failure",
		async () => {
			throw new TypeError("controlled network failure");
		},
		"failed",
	],
	[
		"timeout",
		async () => {
			throw new DOMException("controlled timeout", "TimeoutError");
		},
		"failed",
	],
	["invalid JSON", async () => new Response("{broken"), "failed"],
	["missing answer", async () => Response.json({ answers: {} }), "failed"],
	["unknown choice", async () => decision("maybe"), "failed"],
] as const) {
	test(`safety ${name} does not execute, counts one review and allows the task model to recover`, async () => {
		let tasks = 0;
		let reviews = 0;
		const f = await fixture(
			async (url, init) => {
				if (String(url) === decisionUrl) {
					reviews++;
					return review();
				}
				if (++tasks === 1) return tools();
				const body = JSON.parse(String(init?.body));
				assert.match(JSON.stringify(body.input), /error|block|prevent/i);
				return answer();
			},
			async () => {
				assert.fail("Blocked or failed review must not execute");
			},
		);
		try {
			const id = await f.ask();
			const agent = await f.wait(id);
			assert.equal(agent.status, "succeeded");
			assert.equal(agent.answer, "Task finished");
			assert.equal(reviews, 1);
			assert.equal(tasks, 2);
			const calls = (await f.request(`/api/agents/${id}/calls`)).calls;
			assert.equal(calls.length, 3);
			assert.equal(
				calls.find((call: { url: string }) => call.url === decisionUrl).status,
				reviewStatus,
			);
			const saved = (await f.request(`/api/agents/${id}/tools`)).toolCalls;
			assert.equal(saved.length, 1);
			assert.equal(saved[0].status, "failed");
		} finally {
			await f.close();
		}
	});
}

test("one task plus three reviews consumes four calls and preserves successes at the next-call limit", async () => {
	let requests = 0;
	let executed = 0;
	const f = await fixture(
		async (url) => {
			requests++;
			return String(url) === decisionUrl ? decision() : tools(3);
		},
		async () => {
			executed++;
			return { status: "succeeded", result: "done" };
		},
	);
	try {
		await f.request("/api/execution-limits", "PATCH", { modelCallLimit: 4 });
		const id = await f.ask();
		await f.wait(id);
		assert.equal(requests, 4);
		assert.equal(executed, 3);
		const calls = (await f.request(`/api/agents/${id}/calls`)).calls;
		assert.equal(calls.length, 4);
		assert(
			calls.every((call: { status: string }) => call.status === "succeeded"),
		);
	} finally {
		await f.close();
	}
});

test("live model-call limit stops reviews part way through a tool list without fabricated HTTP", async () => {
	let requests = 0;
	let executed = 0;
	const f = await fixture(
		async (url) => {
			requests++;
			return String(url) === decisionUrl ? decision() : tools(3);
		},
		async () => {
			executed++;
			await f.request("/api/execution-limits", "PATCH", { modelCallLimit: 2 });
			return { status: "succeeded", result: "done" };
		},
	);
	try {
		const id = await f.ask();
		await f.wait(id);
		assert.equal(requests, 2);
		assert.equal(executed, 1);
		const calls = (await f.request(`/api/agents/${id}/calls`)).calls;
		assert.equal(calls.length, 2);
		assert(
			calls.every((call: { status: string }) => call.status === "succeeded"),
		);
	} finally {
		await f.close();
	}
});

for (const action of ["Stop", "Steer", "restart"] as const) {
	test(`${action} cancels a pending review and a late allow cannot execute or replay its tool`, async () => {
		const entered = gate();
		const late = gate();
		const aborted = gate();
		let executed = 0;
		let requests = 0;
		let signal: AbortSignal | null | undefined;
		const f = await fixture(
			async (url, init) => {
				requests++;
				if (String(url) !== decisionUrl) {
					assert.equal(String(url), "https://openrouter.ai/api/v1/responses");
					return requests === 1 ? tools() : answer();
				}
				signal = init?.signal;
				signal?.addEventListener("abort", aborted.release, { once: true });
				entered.release();
				await late.promise;
				return decision();
			},
			async () => {
				executed++;
				return { status: "succeeded", result: "done" };
			},
		);
		try {
			const id = await f.ask();
			await entered.promise;
			const cancelled =
				action === "restart"
					? f.restart()
					: action === "Steer"
						? f.request(`/api/chats/${f.chatId}`, "POST", {
								prompt: "replacement",
								intent: "steer",
								targetAgentId: id,
								submissionId: "held-review-steer",
							})
						: f.request(`/api/agents/${id}/cancel`, "POST", {});
			await aborted.promise;
			assert.equal(signal?.aborted, true);
			late.release();
			const replacement = await cancelled;
			const stopped = await f.wait(id);
			assert.equal(
				stopped.status,
				action === "restart" ? "failed" : "cancelled",
			);
			if (action === "restart")
				assert.equal(stopped.errorCode, "agentInterrupted");
			if (action === "Steer") {
				assert.equal((await f.wait(replacement.agentId)).status, "succeeded");
			}
			assert.equal(executed, 0);
			const calls = (await f.request(`/api/agents/${id}/calls`)).calls;
			assert.equal(calls.length, 2);
			assert.deepEqual(
				calls.map((call: { status: string }) => call.status),
				["succeeded", "failed"],
			);
			assert.equal(
				calls[1].errorCode,
				action === "restart" ? "modelInterrupted" : "agentCancelled",
			);
			const savedTools = (await f.request(`/api/agents/${id}/tools`)).toolCalls;
			assert.equal(savedTools.length, 1);
			assert.equal(savedTools[0].status, "interrupted");
			const beforeRestart = requests;
			await f.restart();
			assert.equal(requests, beforeRestart);
			assert.equal(executed, 0);
		} finally {
			late.release();
			await f.close();
		}
	});
}

test("a settings change affects the next tool while an in-flight review retains its starting state", async () => {
	const entered = gate();
	const release = gate();
	let reviews = 0;
	let tasks = 0;
	let executed = 0;
	const f = await fixture(
		async (url) => {
			if (String(url) !== decisionUrl)
				return ++tasks === 1 ? tools(2) : answer();
			reviews++;
			entered.release();
			await release.promise;
			return decision("block");
		},
		async () => {
			executed++;
			return { status: "succeeded", result: "done" };
		},
	);
	try {
		const id = await f.ask();
		await entered.promise;
		await f.request("/api/safety-review", "PATCH", { safetyReview: false });
		release.release();
		assert.equal((await f.wait(id)).status, "succeeded");
		assert.equal(reviews, 1);
		assert.equal(executed, 1);
		const saved = (await f.request(`/api/agents/${id}/tools`)).toolCalls;
		assert.deepEqual(
			saved.map((call: { status: string }) => call.status),
			["failed", "succeeded"],
		);
	} finally {
		release.release();
		await f.close();
	}
});

test("failed review consumes the remaining model-call budget without altering the successful task call", async () => {
	let requests = 0;
	const f = await fixture(
		async (url) => {
			requests++;
			if (String(url) === decisionUrl)
				throw new TypeError("controlled failure");
			assert.equal(
				requests,
				1,
				"No task continuation HTTP is permitted after the failed second call",
			);
			return tools();
		},
		async () => {
			assert.fail("Failed review must not execute");
		},
	);
	try {
		await f.request("/api/execution-limits", "PATCH", { modelCallLimit: 2 });
		const id = await f.ask();
		await f.wait(id);
		assert.equal(requests, 2);
		const calls = (await f.request(`/api/agents/${id}/calls`)).calls;
		assert.deepEqual(
			calls.map((call: { status: string }) => call.status),
			["succeeded", "failed"],
		);
	} finally {
		await f.close();
	}
});

for (const boundary of ["request", "result"] as const) {
	test(`safety ${boundary} persistence failure stops the Agent without executing or continuing`, async () => {
		let http = 0;
		let reviews = 0;
		const f = await fixture(
			async (url) => {
				http++;
				if (String(url) === decisionUrl) {
					reviews++;
					return decision();
				}
				assert.equal(
					http,
					1,
					"A recorder failure must not continue the task model",
				);
				return tools();
			},
			async () => {
				assert.fail("Unrecorded review must not execute the tool");
			},
		);
		try {
			const db = new DatabaseSync(f.databasePath);
			try {
				db.exec(
					boundary === "request"
						? "CREATE TRIGGER reject_review BEFORE INSERT ON model_calls WHEN NEW.url='https://openrouter.ai/api/alpha/decisions' BEGIN SELECT RAISE(ABORT,'controlled request persistence failure'); END"
						: "CREATE TRIGGER reject_review BEFORE UPDATE ON model_calls WHEN OLD.url='https://openrouter.ai/api/alpha/decisions' BEGIN SELECT RAISE(ABORT,'controlled result persistence failure'); END",
				);
			} finally {
				db.close();
			}
			const id = await f.ask();
			const agent = await f.wait(id);
			assert.equal(agent.status, "failed");
			assert.equal(
				agent.errorCode,
				"answerWriteFailed",
				JSON.stringify({
					error: agent.error,
					calls: agent.calls,
					http,
					reviews,
				}),
			);
			assert.equal(reviews, boundary === "request" ? 0 : 1);
			assert.equal(http, boundary === "request" ? 1 : 2);
			const calls = (await f.request(`/api/agents/${id}/calls`)).calls;
			assert.equal(calls.length, http);
			assert.equal(calls[0].status, "succeeded");
			if (boundary === "result") {
				assert.equal(calls[1].status, "failed");
				assert.equal(calls[1].errorCode, "answerWriteFailed");
				assert.equal(calls[1].responseBody, null);
				for (const kind of ["metadata", "request", "response"]) {
					const call = (
						await f.request(
							`/api/agents/${id}/calls?kind=${kind}&callId=${calls[1].id}`,
						)
					).calls[0];
					assert.equal(call.status, "failed");
					assert.equal(call.errorCode, "answerWriteFailed");
				}
			}
		} finally {
			await f.close();
		}
	});
}
