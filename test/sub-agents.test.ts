import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import type { ToolExecutor } from "../src/count-files.ts";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { completedResponse, frame } from "./model-fixture.ts";

const message = (text: string) => ({
	id: "same-provider-message",
	type: "message",
	content: [{ type: "output_text", text }],
});
const childTool = (args: unknown, callId = "same-provider-call") => ({
	id: callId,
	type: "function_call",
	name: "create_sub_agent",
	call_id: callId,
	arguments: JSON.stringify(args),
});
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => (release = resolve));
	return { promise, release };
}
async function fixture(fake: typeof fetch, execute?: ToolExecutor) {
	const directory = await mkdtemp(join(tmpdir(), "sub-agents-"));
	const path = join(directory, "db.sqlite");
	let server = createTestServer(
		fake,
		path,
		"delegation-api-key",
		"delegation-model",
		execute,
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	let base = `http://127.0.0.1:${address.port}`;
	const post = (route: string, body: unknown) =>
		fetch(base + route, { method: "POST", body: JSON.stringify(body) });
	const get = (route: string) => fetch(base + route).then((r) => r.json());
	const project = await (
		await post("/api/projects", { name: "P", folders: [] })
	).json();
	const chat = await (
		await post(`/api/projects/${project.id}/chats`, { name: "C" })
	).json();
	return {
		path,
		restart: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			server = createTestServer(
				fake,
				path,
				"delegation-api-key",
				"delegation-model",
			).listen(0, "127.0.0.1");
			await new Promise<void>((resolve) => server.once("listening", resolve));
			const address = server.address();
			assert(address && typeof address !== "string");
			base = `http://127.0.0.1:${address.port}`;
		},
		chat,
		get,
		post,
		ask: async (prompt: string) => {
			const response = await post(`/api/chats/${chat.id}`, { prompt });
			assert.equal(response.status, 202);
			return (await response.json()).agentId as number;
		},
		wait: (id: number) => waitForAgent(base, id),
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}
const userPrompt = (input: { role?: string; content?: string }[]) =>
	input.find((item) => item.role === "user")?.content;
async function until(check: () => Promise<boolean>) {
	for (let attempt = 0; attempt < 1000; attempt++) {
		if (await check()) return;
		await setTimeout(5);
	}
	assert.fail("Expected observable delegation state did not arrive");
}

test("parallel blind children return 3 and 7 through notifications while root stays busy", {
	timeout: 15000,
}, async () => {
	const first = gate(),
		second = gate();
	const started = new Set<string>();
	const rootInputs: unknown[][] = [];
	const childInputs: unknown[][] = [];
	let rootInFlight = 0;
	const f = await fixture(async (_url, init) => {
		const request = JSON.parse(String(init?.body));
		assert.equal(request.model, "delegation-model");
		assert(
			request.tools.some(
				(tool: { name: string }) => tool.name === "create_sub_agent",
			),
		);
		assert(
			!request.tools.some((tool: { name: string }) =>
				/wait|poll/.test(tool.name),
			),
		);
		const prompt = userPrompt(request.input);
		if (prompt === "calculate one" || prompt === "calculate two") {
			started.add(prompt);
			childInputs.push(request.input);
			await (prompt === "calculate one" ? first.promise : second.promise);
			return completedResponse({
				output: [message(prompt === "calculate one" ? "3" : "7")],
			});
		}
		assert.equal(prompt, "delegate and add");
		assert.equal(++rootInFlight, 1, "Root model requests are serial");
		try {
			rootInputs.push(request.input);
			if (rootInputs.length === 1)
				return completedResponse({
					output: [
						childTool({ prompt: "calculate one" }, "create-one"),
						childTool({ prompt: "calculate two" }, "create-two"),
					],
				});
			const input = JSON.stringify(request.input);
			return completedResponse({
				output: [
					message(
						input.includes('"7"') || input.includes('\\"7\\"')
							? "10"
							: "waiting for children",
					),
				],
			});
		} finally {
			rootInFlight--;
		}
	});
	try {
		const rootId = await f.ask("delegate and add");
		await until(async () => started.size === 2);
		assert.equal((await f.get(`/api/chats/${f.chat.id}`)).busy, true);
		assert.equal(
			(await f.post(`/api/chats/${f.chat.id}`, { prompt: "too early" })).status,
			409,
		);
		assert.deepEqual(
			childInputs.map((input) => input.length),
			[1, 1],
		);
		const tools = (await f.get(`/api/agents/${rootId}/tools`)).toolCalls;
		assert.equal(tools.length, 2);
		const creations = tools.map((tool: { result: string }) =>
			JSON.parse(tool.result),
		);
		assert(
			creations.every(
				(creation: { agent_id: number; status: string }) =>
					Number.isInteger(creation.agent_id) && creation.status === "pending",
			),
		);
		first.release();
		await until(async () => JSON.stringify(rootInputs).includes("succeeded"));
		assert.equal(
			(await f.get(`/api/chats/${f.chat.id}`)).busy,
			true,
			"First child alone cannot complete root",
		);
		second.release();
		const root = await f.wait(rootId);
		assert.equal(root.status, "succeeded");
		assert.equal(root.output.at(-1).content[0].text, "10");
		for (const creation of creations) {
			const child = (await f.get(`/api/agents/${creation.agent_id}`)).agents[0];
			assert.equal(child.parentAgentId, rootId);
			assert.equal(child.rootAgentId, rootId);
			assert.equal(child.chatId, f.chat.id);
			assert.equal(child.context, "");
			assert.equal(child.status, "succeeded");
			assert(JSON.stringify(rootInputs).includes(String(child.id)));
		}
		assert.equal((await f.get(`/api/chats/${f.chat.id}`)).agents.length, 1);
		const calls = await Promise.all(
			creations.map((creation: { agent_id: number }) =>
				f.get(`/api/agents/${creation.agent_id}/calls`),
			),
		);
		assert.notEqual(
			calls[0].calls[0].id,
			calls[1].calls[0].id,
			"Repeated provider IDs retain separate local ownership",
		);
	} finally {
		first.release();
		second.release();
		await f.close();
	}
});

test("recursive children derive their unique creation source and receive only explicit context", async () => {
	const requests: { input: unknown[] }[] = [];
	const f = await fixture(async (_url, init) => {
		const request = JSON.parse(String(init?.body));
		requests.push(request);
		const input = JSON.stringify(request.input);
		if (userPrompt(request.input) === "root secret") {
			return completedResponse({
				output: [
					input.includes("function_call_output")
						? message("root done")
						: childTool({
								prompt: "middle question",
								context: "explicit middle context",
							}),
				],
			});
		}
		if (userPrompt(request.input) === "explicit middle context") {
			assert(!input.includes("root secret"));
			assert(input.includes("explicit middle context"));
			return completedResponse({
				output: [
					input.includes("function_call_output")
						? message("middle done")
						: childTool({ prompt: "leaf question" }),
				],
			});
		}
		assert.equal(userPrompt(request.input), "leaf question");
		assert(!input.includes("middle question"));
		assert(!input.includes("explicit middle context"));
		return completedResponse({ output: [message("leaf done")] });
	});
	try {
		const rootId = await f.ask("root secret");
		const finished = await f.wait(rootId);
		assert.equal(
			finished.status,
			"succeeded",
			JSON.stringify({ finished, requests }),
		);
		const rootTools = (await f.get(`/api/agents/${rootId}/tools`)).toolCalls;
		const middleId = JSON.parse(rootTools[0].result).agent_id;
		const middle = (await f.get(`/api/agents/${middleId}`)).agents[0];
		const middleTools = (await f.get(`/api/agents/${middleId}/tools`))
			.toolCalls;
		const leafId = JSON.parse(middleTools[0].result).agent_id;
		const leaf = (await f.get(`/api/agents/${leafId}`)).agents[0];
		assert.equal(middle.createdByToolCallId, rootTools[0].id);
		assert.equal(middle.parentAgentId, rootId);
		assert.equal(middle.question, "middle question");
		assert.equal(middle.context, "explicit middle context");
		assert.equal(leaf.createdByToolCallId, middleTools[0].id);
		assert.equal(leaf.parentAgentId, middleId);
		assert.equal(leaf.rootAgentId, rootId);
		const db = new DatabaseSync(f.path);
		try {
			const rows = db
				.prepare(
					"SELECT chat_id,prompt,created_by_tool_call_id FROM agents ORDER BY id",
				)
				.all();
			assert.equal(rows.length, 3);
			assert.equal(rows[0].chat_id, f.chat.id);
			assert.equal(rows[1].chat_id, null);
			assert.equal(rows[1].prompt, null);
			assert.equal(rows[2].chat_id, null);
			assert.equal(rows[2].prompt, null);
		} finally {
			db.close();
		}
	} finally {
		await f.close();
	}
});

test("child failure delivers partial readable output before its sibling finishes without retry", {
	timeout: 15000,
}, async () => {
	const sibling = gate();
	const rootInputs: unknown[][] = [];
	let failedRequests = 0,
		siblingStarted = false;
	const f = await fixture(async (_url, init) => {
		const request = JSON.parse(String(init?.body));
		const prompt = userPrompt(request.input);
		if (prompt === "failing child") {
			failedRequests++;
			return new Response(
				frame("response.output_text.delta", {
					item_id: "partial",
					output_index: 0,
					content_index: 0,
					delta: "usable partial result",
				}) +
					frame("response.failed", {
						response: { error: { message: "child model failed" } },
					}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		if (prompt === "slow sibling") {
			siblingStarted = true;
			await sibling.promise;
			return completedResponse({ output: [message("sibling done")] });
		}
		rootInputs.push(request.input);
		return completedResponse({
			output:
				rootInputs.length === 1
					? [
							childTool({ prompt: "failing child" }, "fail"),
							childTool({ prompt: "slow sibling" }, "slow"),
						]
					: [message("parent continues")],
		});
	});
	try {
		const rootId = await f.ask("handle partial output");
		await until(
			async () =>
				siblingStarted &&
				JSON.stringify(rootInputs).includes("usable partial result"),
		);
		assert(JSON.stringify(rootInputs).includes("failed"));
		assert.equal(failedRequests, 1);
		assert.equal((await f.get(`/api/chats/${f.chat.id}`)).busy, true);
		sibling.release();
		assert.equal((await f.wait(rootId)).status, "succeeded");
		assert.equal(failedRequests, 1);
	} finally {
		sibling.release();
		await f.close();
	}
});

test("invalid creation arguments allocate neither child rows nor model requests", async () => {
	let requests = 0;
	const invalid = [
		{},
		{ prompt: " " },
		{ prompt: 3 },
		{ prompt: "valid", context: {} },
	];
	const f = await fixture(async (_url, init) => {
		requests++;
		const input = JSON.parse(String(init?.body)).input;
		if (requests === 1)
			return completedResponse({
				output: invalid.map((args, index) =>
					childTool(args, `invalid-${index}`),
				),
			});
		assert.equal(requests, 2);
		assert.equal(
			input.filter(
				(item: { type: string }) => item.type === "function_call_output",
			).length,
			invalid.length,
		);
		return completedResponse({ output: [message("errors received")] });
	});
	try {
		const rootId = await f.ask("invalid args");
		const root = await f.wait(rootId);
		assert.equal(root.status, "succeeded");
		assert(
			(await f.get(`/api/agents/${rootId}/tools`)).toolCalls.every(
				(tool: { status: string; result: string }) =>
					tool.status === "failed" && tool.result,
			),
		);
		const db = new DatabaseSync(f.path);
		try {
			assert.equal(
				db.prepare("SELECT COUNT(*) AS count FROM agents").get()?.count,
				1,
			);
		} finally {
			db.close();
		}
		assert.equal(requests, 2);
	} finally {
		await f.close();
	}
});

for (const mode of ["failure", "limit"])
	test(`parent ${mode} holds root busy until children end and later notifications never restart it`, {
		timeout: 15000,
	}, async () => {
		const child = gate();
		let rootRequests = 0,
			childStarted = false;
		const f = await fixture(async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			if (userPrompt(request.input) === "held child") {
				childStarted = true;
				await child.promise;
				return completedResponse({ output: [message("child success")] });
			}
			rootRequests++;
			if (rootRequests === 1)
				return completedResponse({
					output: [childTool({ prompt: "held child" })],
				});
			if (mode === "failure")
				return new Response("parent upstream failed", { status: 503 });
			return completedResponse({
				output: [childTool({ prompt: "must not start" }, "not-executed")],
			});
		});
		try {
			if (mode === "limit") {
				const db = new DatabaseSync(f.path);
				db.prepare("UPDATE settings SET model_call_limit=2 WHERE id=1").run();
				db.close();
			}
			const rootId = await f.ask("failing parent");
			await until(async () => childStarted && rootRequests === 2);
			await until(async () => {
				const calls = await f.get(`/api/agents/${rootId}/calls`);
				return calls.calls.length === 2 && calls.calls[1].status !== "pending";
			});
			const state = await f.get(`/api/agents/${rootId}`);
			assert.equal(state.agents[0].status, "pending");
			assert.equal(state.busy, true);
			child.release();
			const root = await f.wait(rootId);
			assert.equal(root.status, "failed");
			assert.equal(
				root.errorCode,
				mode === "limit" ? "modelCallLimit" : "modelRequestFailed",
			);
			assert.equal(rootRequests, 2);
			if (mode === "limit") {
				const tools = (await f.get(`/api/agents/${rootId}/tools`)).toolCalls;
				assert.equal(tools[1].status, "not_executed");
				assert.equal(tools[1].result, null);
			}
		} finally {
			child.release();
			await f.close();
		}
	});

test("defaults are 16/32 and completed descendants retain slots while invalid creation consumes none", async () => {
	let capAttempted = false;
	let childRequests = 0;
	const f = await fixture(async (_url, init) => {
		const request = JSON.parse(String(init?.body));
		if (userPrompt(request.input) === "only child") {
			childRequests++;
			return completedResponse({ output: [message("finished child")] });
		}
		const input = JSON.stringify(request.input);
		if (!input.includes("function_call_output"))
			return completedResponse({
				output: [
					childTool({ prompt: " " }, "invalid"),
					childTool({ prompt: "only child" }, "valid"),
				],
			});
		if (input.includes("Runtime service") && !capAttempted) {
			capAttempted = true;
			return completedResponse({
				output: [childTool({ prompt: "over cap" }, "cap")],
			});
		}
		return completedResponse({ output: [message("finished parent")] });
	});
	try {
		const db = new DatabaseSync(f.path);
		try {
			assert.deepEqual(
				{
					...db
						.prepare(
							"SELECT model_call_limit,sub_agent_limit FROM settings WHERE id=1",
						)
						.get(),
				},
				{ model_call_limit: 16, sub_agent_limit: 32 },
			);
			db.prepare("UPDATE settings SET sub_agent_limit=1 WHERE id=1").run();
		} finally {
			db.close();
		}
		const rootId = await f.ask("check tree cap");
		assert.equal((await f.wait(rootId)).status, "succeeded");
		const tools = (await f.get(`/api/agents/${rootId}/tools`)).toolCalls;
		assert.deepEqual(
			tools.map((tool: { status: string }) => tool.status),
			["failed", "succeeded", "failed"],
		);
		assert.equal(JSON.parse(tools[2].result).error.code, "subAgentLimit");
		assert.equal(childRequests, 1);
	} finally {
		await f.close();
	}
});

test("restart preserves nested partial records and interrupts the tree without replay", async () => {
	let requests = 0;
	const leafStarted = gate();
	let leafStream!: ReadableStreamDefaultController<Uint8Array>;
	const f = await fixture(async (_url, init) => {
		requests++;
		const request = JSON.parse(String(init?.body));
		const prompt = userPrompt(request.input);
		if (prompt === "held leaf") {
			return new Response(
				new ReadableStream({
					start(controller) {
						leafStream = controller;
						controller.enqueue(
							new TextEncoder().encode(
								frame("response.output_text.delta", {
									item_id: "partial",
									output_index: 0,
									content_index: 0,
									delta: "saved leaf partial",
								}),
							),
						);
						leafStarted.release();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		if (JSON.stringify(request.input).includes("function_call_output"))
			return completedResponse({ output: [message("awaiting child")] });
		return completedResponse({
			output: [
				childTool({
					prompt: prompt === "restart root" ? "middle" : "held leaf",
				}),
			],
		});
	});
	try {
		const rootId = await f.ask("restart root");
		await leafStarted.promise;
		const middleId = JSON.parse(
			(await f.get(`/api/agents/${rootId}/tools`)).toolCalls[0].result,
		).agent_id;
		const leafId = JSON.parse(
			(await f.get(`/api/agents/${middleId}/tools`)).toolCalls[0].result,
		).agent_id;
		await until(async () =>
			JSON.stringify(
				(await f.get(`/api/agents/${leafId}`)).agents[0].output,
			).includes("saved leaf partial"),
		);
		const before = requests;
		await f.restart();
		for (const id of [rootId, middleId, leafId])
			assert.equal(
				(await f.get(`/api/agents/${id}`)).agents[0].status,
				"failed",
			);
		const leaf = (await f.get(`/api/agents/${leafId}`)).agents[0];
		assert.equal(leaf.parentAgentId, middleId);
		assert(JSON.stringify(leaf.output).includes("saved leaf partial"));
		assert.equal(leaf.calls[0].status, "failed");
		assert.equal((await f.get(`/api/chats/${f.chat.id}`)).busy, false);
		assert.equal(requests, before);
	} finally {
		leafStream?.close();
		await f.close();
	}
});

for (const during of ["model", "tool"])
	test(`terminal notifications queue in completion order during an in-flight parent ${during}`, {
		timeout: 15000,
	}, async () => {
		const children = [gate(), gate()];
		const held = gate(),
			entered = gate();
		let childStarts = 0;
		const parentInputs: { role?: string; content?: string }[][] = [];
		const f = await fixture(
			async (_url, init) => {
				const request = JSON.parse(String(init?.body));
				const prompt = userPrompt(request.input);
				if (prompt === "ordered one" || prompt === "ordered two") {
					childStarts++;
					await children[prompt === "ordered one" ? 0 : 1].promise;
					return completedResponse({
						output: [
							message(prompt === "ordered one" ? "result-one" : "result-two"),
						],
					});
				}
				parentInputs.push(request.input);
				if (parentInputs.length === 1) {
					const output = [
						childTool({ prompt: "ordered one" }, "one"),
						childTool({ prompt: "ordered two" }, "two"),
					];
					if (during === "tool")
						output.push({ ...childTool({}, "held-tool"), name: "count_files" });
					return completedResponse({ output });
				}
				if (during === "model" && parentInputs.length === 2) {
					entered.release();
					await held.promise;
				}
				return completedResponse({
					output: [message("parent handled results")],
				});
			},
			async () => {
				entered.release();
				await held.promise;
				return { status: "succeeded", result: '{"count":0}' };
			},
		);
		try {
			const rootId = await f.ask("ordered notifications");
			await entered.promise;
			assert.equal(childStarts, 2);
			const tools = (await f.get(`/api/agents/${rootId}/tools`)).toolCalls;
			const childIds = tools
				.slice(0, 2)
				.map((tool: { result: string }) => JSON.parse(tool.result).agent_id);
			for (const index of [1, 0]) {
				children[index].release();
				await until(
					async () =>
						(await f.get(`/api/agents/${childIds[index]}`)).agents[0].status ===
						"succeeded",
				);
			}
			assert.equal(parentInputs.length, during === "model" ? 2 : 1);
			held.release();
			assert.equal((await f.wait(rootId)).status, "succeeded");
			const notifications = parentInputs
				.at(-1)
				?.filter(
					(item) =>
						item.role === "user" &&
						item.content?.startsWith("[Runtime service:"),
				);
			assert.equal(notifications?.length, 2);
			assert(notifications?.[0].content?.includes("result-two"));
			assert(notifications?.[1].content?.includes("result-one"));
			assert.equal(parentInputs.length, during === "model" ? 3 : 2);
		} finally {
			for (const child of children) child.release();
			held.release();
			await f.close();
		}
	});

test("creation validates the current effective configuration before allocating a child", async () => {
	const entered = gate(),
		response = gate();
	let requests = 0;
	const f = await fixture(async () => {
		requests++;
		entered.release();
		await response.promise;
		return completedResponse({
			output: [childTool({ prompt: "must not start" })],
		});
	});
	try {
		const rootId = await f.ask("invalidate during response");
		await entered.promise;
		const db = new DatabaseSync(f.path);
		try {
			db.exec("PRAGMA foreign_keys=ON");
			db.prepare("DELETE FROM managed_models WHERE id=?").run(
				"delegation-model",
			);
		} finally {
			db.close();
		}
		response.release();
		assert.equal((await f.wait(rootId)).status, "failed");
		const tools = (await f.get(`/api/agents/${rootId}/tools`)).toolCalls;
		assert.equal(tools[0].status, "failed");
		assert(
			["invalidModel", "modelConfigMissing"].includes(
				JSON.parse(tools[0].result).error.code,
			),
		);
		const read = new DatabaseSync(f.path);
		try {
			assert.equal(
				read.prepare("SELECT COUNT(*) AS count FROM agents").get()?.count,
				1,
			);
		} finally {
			read.close();
		}
		assert.equal(requests, 1);
	} finally {
		response.release();
		await f.close();
	}
});

test("a child terminal persistence failure still releases its parent with saved output and a real error", async () => {
	const childStarted = gate(),
		childRelease = gate();
	const parentInputs: unknown[][] = [];
	const f = await fixture(async (_url, init) => {
		const request = JSON.parse(String(init?.body));
		if (userPrompt(request.input) === "unsaved child") {
			childStarted.release();
			await childRelease.promise;
			return completedResponse({ output: [message("durable child output")] });
		}
		parentInputs.push(request.input);
		return completedResponse({
			output:
				parentInputs.length === 1
					? [childTool({ prompt: "unsaved child" })]
					: [message("parent handled save error")],
		});
	});
	try {
		const rootId = await f.ask("terminal save failure");
		await childStarted.promise;
		const db = new DatabaseSync(f.path);
		db.exec(
			"CREATE TRIGGER fail_child_terminal BEFORE UPDATE OF status ON agents WHEN OLD.created_by_tool_call_id IS NOT NULL AND NEW.status != 'pending' BEGIN SELECT RAISE(ABORT,'child terminal unavailable'); END",
		);
		db.close();
		childRelease.release();
		assert.equal((await f.wait(rootId)).status, "succeeded");
		const lastInput = JSON.stringify(parentInputs.at(-1));
		assert(lastInput.includes("durable child output"));
		assert(lastInput.includes("answerWriteFailed"));
		assert(lastInput.includes("failed"));
		const childId = JSON.parse(
			(await f.get(`/api/agents/${rootId}/tools`)).toolCalls[0].result,
		).agent_id;
		const detail = await f.get(`/api/agents/${childId}`);
		assert.equal(detail.agents[0].status, "failed");
		assert.equal(detail.agentBusy, false);
	} finally {
		childRelease.release();
		await f.close();
	}
});
