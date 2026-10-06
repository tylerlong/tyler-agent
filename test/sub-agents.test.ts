import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { executeTool, type ToolExecutor } from "../src/count-files.ts";
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

for (const choice of [
	{ args: {}, model: "delegation-model", effort: "high" },
	{ args: { model_id: "compatible" }, model: "compatible", effort: "high" },
	{ args: { model_id: "low-only" }, model: "low-only", effort: undefined },
	{
		args: { reasoning_effort: "low" },
		model: "delegation-model",
		effort: "low",
	},
	{
		args: { reasoning_effort: null },
		model: "delegation-model",
		effort: undefined,
	},
	{
		args: { model_id: "compatible", reasoning_effort: "low" },
		model: "compatible",
		effort: "low",
	},
])
	test(`children and grandchildren inherit effective override ${JSON.stringify(choice.args)}`, async () => {
		const requests: {
			model: string;
			reasoning?: { effort: string };
			input: unknown[];
			instructions: string;
		}[] = [];
		const f = await fixture(async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			requests.push(request);
			const prompt = userPrompt(request.input);
			if (
				JSON.stringify(request.input).includes("function_call_output") ||
				prompt === "leaf"
			)
				return completedResponse({ output: [message("done")] });
			return completedResponse({
				output: [
					childTool({
						prompt: prompt === "root" ? "middle" : "leaf",
						...(prompt === "root" ? choice.args : {}),
					}),
				],
			});
		});
		try {
			const db = new DatabaseSync(f.path);
			for (const [id, efforts] of [
				["compatible", ["low", "high"]],
				["low-only", ["low"]],
			] as const)
				db.prepare(
					"INSERT INTO managed_models(id,name,metadata) VALUES(?,?,?)",
				).run(
					id,
					id,
					JSON.stringify({
						reasoningRequired: false,
						supportedEfforts: efforts,
					}),
				);
			db.prepare("UPDATE chats SET reasoning_effort='high' WHERE id=?").run(
				f.chat.id,
			);
			db.close();
			assert.equal((await f.wait(await f.ask("root"))).status, "succeeded");
			for (const prompt of ["middle", "leaf"]) {
				const request = requests.find(
					(request) => userPrompt(request.input as []) === prompt,
				);
				assert(request);
				assert.equal(request.model, choice.model);
				assert.equal(request.reasoning?.effort, choice.effort);
				assert(request.instructions.includes('"id":"low-only"'));
				assert(request.instructions.includes('"reasoningEfforts":["low"]'));
			}
			const read = new DatabaseSync(f.path);
			assert.equal(
				read.prepare("SELECT model_id FROM chats WHERE id=?").get(f.chat.id)
					?.model_id,
				"delegation-model",
			);
			assert.equal(
				read
					.prepare("SELECT reasoning_effort FROM chats WHERE id=?")
					.get(f.chat.id)?.reasoning_effort,
				"high",
			);
			read.close();
		} finally {
			await f.close();
		}
	});

test("explicit unknown model and unsupported effort reject creation with no rows or requests", async () => {
	let requests = 0;
	const invalid = [
		{ model_id: "missing" },
		{ reasoning_effort: "xhigh" },
		{ model_id: 3 },
		{ reasoning_effort: 3 },
	];
	const f = await fixture(async () => {
		requests++;
		return completedResponse({
			output:
				requests === 1
					? invalid.map((args, index) =>
							childTool({ prompt: "bad", ...args }, String(index)),
						)
					: [message("errors handled")],
		});
	});
	try {
		const rootId = await f.ask("reject overrides");
		assert.equal((await f.wait(rootId)).status, "succeeded");
		const tools = (await f.get(`/api/agents/${rootId}/tools`)).toolCalls;
		assert.deepEqual(
			tools.map(
				(tool: { result: string }) => JSON.parse(tool.result).error.code,
			),
			["invalidModel", "invalidReasoning", "invalidInput", "invalidInput"],
		);
		const db = new DatabaseSync(f.path);
		assert.equal(
			db.prepare("SELECT COUNT(*) AS count FROM agents").get()?.count,
			1,
		);
		db.close();
		assert.equal(requests, 2);
	} finally {
		await f.close();
	}
});

test("valid explicit model survives invalid current root model during creation and child request", async () => {
	const started = gate(),
		release = gate();
	const seen: string[] = [];
	const f = await fixture(async (_url, init) => {
		const request = JSON.parse(String(init?.body));
		seen.push(request.model);
		if (request.model === "delegation-model") {
			started.release();
			await release.promise;
			return completedResponse({
				output: [
					childTool({
						prompt: "valid child",
						model_id: "replacement",
						reasoning_effort: "low",
					}),
				],
			});
		}
		return completedResponse({ output: [message("valid override result")] });
	});
	try {
		const db = new DatabaseSync(f.path);
		db.prepare(
			"INSERT INTO managed_models(id,name,metadata) VALUES('replacement','Replacement',?)",
		).run(JSON.stringify({ supportedEfforts: ["low"] }));
		db.close();
		const rootId = await f.ask("invalidate root");
		await started.promise;
		const edit = new DatabaseSync(f.path);
		edit.exec("PRAGMA foreign_keys=ON");
		edit
			.prepare("DELETE FROM managed_models WHERE id='delegation-model'")
			.run();
		edit.close();
		release.release();
		assert.equal((await f.wait(rootId)).status, "failed");
		const tool = (await f.get(`/api/agents/${rootId}/tools`)).toolCalls[0];
		assert.equal(tool.status, "succeeded");
		const child = (
			await f.get(`/api/agents/${JSON.parse(tool.result).agent_id}`)
		).agents[0];
		assert.equal(child.status, "succeeded");
		assert.equal(child.answer, "valid override result");
		assert.deepEqual(seen, ["delegation-model", "replacement"]);
	} finally {
		release.release();
		await f.close();
	}
});

test("later child calls resolve current root effort, credentials, capability metadata and project scope", async () => {
	const childStarted = gate(),
		release = gate();
	const childRequests: {
		model: string;
		reasoning: { effort: string };
		instructions: string;
		key: string;
	}[] = [];
	const f = await fixture(
		async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			if (userPrompt(request.input) === "current child") {
				childRequests.push({
					...request,
					key: String(new Headers(init?.headers).get("authorization")),
				});
				if (childRequests.length === 1) {
					childStarted.release();
					await release.promise;
					return completedResponse({
						output: [{ ...childTool({}, "local"), name: "count_files" }],
					});
				}
				return completedResponse({ output: [message("child done")] });
			}
			return completedResponse({
				output: JSON.stringify(request.input).includes("function_call_output")
					? [message("root done")]
					: [childTool({ prompt: "current child" })],
			});
		},
		async () => ({ status: "succeeded", result: '{"count":0}' }),
	);
	try {
		const rootId = await f.ask("current values");
		await childStarted.promise;
		const db = new DatabaseSync(f.path);
		db.prepare("UPDATE settings SET api_key='updated-key'").run();
		db.prepare("UPDATE chats SET reasoning_effort='low' WHERE id=?").run(
			f.chat.id,
		);
		db.prepare(
			"INSERT INTO folders(project_id,path) SELECT project_id,'/current-scope' FROM chats WHERE id=?",
		).run(f.chat.id);
		db.close();
		release.release();
		assert.equal((await f.wait(rootId)).status, "succeeded");
		assert.equal(childRequests.length, 2);
		assert.equal(childRequests[0].reasoning, undefined);
		assert.equal(childRequests[1].reasoning.effort, "low");
		assert.equal(childRequests[1].key, "Bearer updated-key");
		assert(childRequests[1].instructions.includes("/current-scope"));
	} finally {
		release.release();
		await f.close();
	}
});

for (const kind of ["model", "tree"])
	test(`lowering current ${kind} limit during an in-flight request prevents subsequent work`, async () => {
		const started = gate(),
			release = gate();
		let roots = 0,
			childRequests = 0;
		const f = await fixture(async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			if (userPrompt(request.input) === "allowed child") {
				childRequests++;
				return completedResponse({ output: [message("child done")] });
			}
			roots++;
			if (roots === (kind === "model" ? 1 : 2)) {
				started.release();
				await release.promise;
				return completedResponse({
					output: [childTool({ prompt: "blocked child" }, "blocked")],
				});
			}
			return completedResponse({
				output:
					roots === 1
						? [childTool({ prompt: "allowed child" })]
						: [message("handled cap")],
			});
		});
		try {
			const rootId = await f.ask("lower running limit");
			await started.promise;
			const db = new DatabaseSync(f.path);
			db.prepare(
				`UPDATE settings SET ${kind === "model" ? "model_call_limit" : "sub_agent_limit"}=1 WHERE id=1`,
			).run();
			db.close();
			release.release();
			const root = await f.wait(rootId);
			assert.equal(root.status, kind === "model" ? "failed" : "succeeded");
			const tools = (await f.get(`/api/agents/${rootId}/tools`)).toolCalls;
			assert.equal(
				tools.at(-1).status,
				kind === "model" ? "not_executed" : "failed",
			);
			assert.equal(
				kind === "model"
					? tools.at(-1).reason
					: JSON.parse(tools.at(-1).result).error.code,
				kind === "model" ? "modelCallLimit" : "subAgentLimit",
			);
			assert.equal(childRequests, kind === "model" ? 0 : 1);
			assert.equal(roots, kind === "model" ? 1 : 3);
		} finally {
			release.release();
			await f.close();
		}
	});
const cancelTool = (args: unknown, callId: string) => ({
	...childTool(args, callId),
	name: "cancel_sub_agent",
});

function blockedModel(
	signal: AbortSignal | null | undefined,
	cleanup = Promise.resolve(),
) {
	assert(signal, "Every model request receives its Agent cancellation signal");
	return new Promise<Response>((_resolve, reject) => {
		const abort = () => {
			void cleanup.then(() => reject(signal.reason));
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

for (const target of ["root", "middle"])
	test(`local ${target} cancellation aborts its subtree and waits for streamed cleanup`, {
		timeout: 15000,
	}, async () => {
		const cleanup = gate();
		const signals = new Map<string, AbortSignal>();
		const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
		const f = await fixture(async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			const prompt = userPrompt(request.input);
			assert(init?.signal);
			if (prompt === "leaf" || prompt === "sibling") {
				signals.set(prompt, init.signal);
				return new Response(
					new ReadableStream({
						start(controller) {
							streams.push(controller);
							controller.enqueue(
								new TextEncoder().encode(
									frame("response.output_text.delta", {
										item_id: prompt,
										output_index: 0,
										content_index: 0,
										delta: `saved ${prompt} partial`,
									}),
								),
							);
						},
						cancel: () => cleanup.promise,
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			if (JSON.stringify(request.input).includes("function_call_output"))
				return completedResponse({ output: [message("waiting")] });
			return completedResponse({
				output:
					prompt === "tree"
						? [
								childTool({ prompt: "middle" }, "middle"),
								childTool({ prompt: "sibling" }, "sibling"),
							]
						: [childTool({ prompt: "leaf" }, "leaf")],
			});
		});
		try {
			const rootId = await f.ask("tree");
			await until(async () => signals.size === 2);
			const rootTools = (await f.get(`/api/agents/${rootId}/tools`)).toolCalls;
			const middleId = JSON.parse(rootTools[0].result).agent_id;
			const siblingId = JSON.parse(rootTools[1].result).agent_id;
			const leafId = JSON.parse(
				(await f.get(`/api/agents/${middleId}/tools`)).toolCalls[0].result,
			).agent_id;
			await until(async () =>
				JSON.stringify(
					(await f.get(`/api/agents/${leafId}`)).agents[0].output,
				).includes("saved leaf partial"),
			);
			let finished = false;
			const cancelled = f
				.post(`/api/agents/${target === "root" ? rootId : middleId}/cancel`, {})
				.then((response) => {
					finished = true;
					return response;
				});
			await until(async () => signals.get("leaf")?.aborted === true);
			assert.equal(signals.get("sibling")?.aborted, target === "root");
			assert.equal(
				finished,
				false,
				"Cancellation does not finish before request cleanup",
			);
			assert.equal((await f.get(`/api/chats/${f.chat.id}`)).busy, true);
			assert.equal(
				(await f.get(`/api/agents/${rootId}`)).agents[0].status,
				"pending",
			);
			assert.equal(
				(await f.post(`/api/chats/${f.chat.id}`, { prompt: "too early" }))
					.status,
				409,
			);
			cleanup.release();
			assert.equal((await cancelled).status, 200);
			for (const id of [middleId, leafId]) {
				const agent = (await f.get(`/api/agents/${id}`)).agents[0];
				assert.equal(agent.status, "cancelled");
			}
			const leaf = (await f.get(`/api/agents/${leafId}`)).agents[0];
			assert(JSON.stringify(leaf.output).includes("saved leaf partial"));
			assert.equal(leaf.calls[0].status, "failed");
			assert.equal(
				(await f.get(`/api/agents/${leafId}/calls`)).calls[0].errorCode,
				"agentCancelled",
			);
			if (target === "middle") {
				assert.equal(
					(await f.get(`/api/agents/${siblingId}`)).agents[0].status,
					"pending",
				);
				assert.equal((await f.get(`/api/chats/${f.chat.id}`)).busy, true);
				assert.equal(
					(await f.post(`/api/agents/${rootId}/cancel`, {})).status,
					200,
				);
			}
			assert.equal((await f.wait(rootId)).status, "cancelled");
			const before = await f.get(`/api/agents/${rootId}`);
			assert.equal(
				(await f.post(`/api/agents/${rootId}/cancel`, {})).status,
				200,
			);
			assert.deepEqual(await f.get(`/api/agents/${rootId}`), before);
		} finally {
			cleanup.release();
			for (const stream of streams) {
				try {
					stream.close();
				} catch {}
			}
			await f.close();
		}
	});

test("model cancellation accepts only direct children and returns one result without a duplicate notification", {
	timeout: 15000,
}, async () => {
	const rootRelease = gate(),
		middleRelease = gate();
	const ids = new Map<string, number>();
	const calls = new Map<string, number>();
	const inputs: unknown[][] = [];
	const signals: AbortSignal[] = [];
	let middleValidated = false;
	const f = await fixture(async (_url, init) => {
		const request = JSON.parse(String(init?.body));
		const prompt = userPrompt(request.input) as string;
		const count = (calls.get(prompt) ?? 0) + 1;
		calls.set(prompt, count);
		if (prompt === "other root")
			return completedResponse({ output: [message("terminal other root")] });
		if (prompt === "leaf" || prompt === "sibling") {
			assert(init?.signal);
			signals.push(init.signal);
			return blockedModel(init.signal);
		}
		if (prompt === "middle") {
			if (count === 1)
				return completedResponse({
					output: [childTool({ prompt: "leaf" }, "leaf")],
				});
			if (count === 2) {
				await middleRelease.promise;
				return completedResponse({
					output: ["middle", "root", "sibling"].map((key) =>
						cancelTool({ agent_id: ids.get(key) }, `forbidden-${key}`),
					),
				});
			}
			const results = request.input.filter(
				(item: { type: string }) => item.type === "function_call_output",
			);
			assert.equal(results.length, 4);
			for (const result of results.slice(1))
				assert(JSON.parse(result.output).error);
			middleValidated = true;
			return blockedModel(init?.signal);
		}
		inputs.push(request.input);
		if (count === 1)
			return completedResponse({
				output: [
					childTool({ prompt: "middle" }, "middle"),
					childTool({ prompt: "sibling" }, "sibling"),
				],
			});
		if (count === 2) {
			await rootRelease.promise;
			return completedResponse({
				output: [
					...[
						{},
						{ agent_id: "1" },
						{ agent_id: 1.5 },
						{ agent_id: ids.get("middle"), extra: true },
						{ agent_id: 999999 },
						{ agent_id: ids.get("root") },
						{ agent_id: ids.get("leaf") },
						{ agent_id: ids.get("other") },
					].map((args, index) => cancelTool(args, `invalid-${index}`)),
					cancelTool({ agent_id: ids.get("middle") }, "cancel-middle"),
					cancelTool({ agent_id: ids.get("middle") }, "cancel-middle-again"),
					cancelTool({ agent_id: ids.get("sibling") }, "cancel-sibling"),
				],
			});
		}
		return completedResponse({
			output: [message("cancelled children handled")],
		});
	});
	try {
		const otherProject = await (
			await f.post("/api/projects", { name: "Other", folders: [] })
		).json();
		const otherChat = await (
			await f.post(`/api/projects/${otherProject.id}/chats`, { name: "Other" })
		).json();
		ids.set(
			"other",
			(
				await (
					await f.post(`/api/chats/${otherChat.id}`, { prompt: "other root" })
				).json()
			).agentId,
		);
		const otherId = ids.get("other");
		assert(otherId);
		assert.equal((await f.wait(otherId)).status, "succeeded");
		const rootId = await f.ask("root");
		ids.set("root", rootId);
		await until(async () => signals.length === 2);
		const tools = (await f.get(`/api/agents/${rootId}/tools`)).toolCalls;
		ids.set("middle", JSON.parse(tools[0].result).agent_id);
		ids.set("sibling", JSON.parse(tools[1].result).agent_id);
		ids.set(
			"leaf",
			JSON.parse(
				(await f.get(`/api/agents/${ids.get("middle")}/tools`)).toolCalls[0]
					.result,
			).agent_id,
		);
		middleRelease.release();
		await until(async () => middleValidated);
		assert(signals.every((signal) => !signal.aborted));
		rootRelease.release();
		assert.equal((await f.wait(rootId)).status, "succeeded");
		const resultTools = (
			await f.get(`/api/agents/${rootId}/tools`)
		).toolCalls.slice(2);
		assert.equal(resultTools.length, 11);
		assert(
			resultTools
				.slice(0, 8)
				.every(
					(tool: { status: string; result: string }) =>
						tool.status === "failed" && JSON.parse(tool.result).error,
				),
		);
		assert(
			resultTools
				.slice(8)
				.every((tool: { status: string }) => tool.status === "succeeded"),
		);
		for (const key of ["middle", "leaf", "sibling"])
			assert.equal(
				(await f.get(`/api/agents/${ids.get(key)}`)).agents[0].status,
				"cancelled",
			);
		assert.equal(
			(await f.get(`/api/agents/${ids.get("other")}`)).agents[0].status,
			"succeeded",
		);
		assert.equal(inputs.length, 3);
		assert(
			!JSON.stringify(inputs.at(-1)).includes("[Runtime service:"),
			"Cancellation Tool Result replaces its child terminal notification",
		);
	} finally {
		middleRelease.release();
		rootRelease.release();
		await f.close();
	}
});

test("cancellation signals an active tool and holds the chat until tool cleanup finishes", {
	timeout: 15000,
}, async () => {
	const started = gate(),
		aborted = gate(),
		cleanup = gate();
	let requests = 0;
	let signal!: AbortSignal;
	const f = await fixture(
		async () => {
			requests++;
			return completedResponse({
				output: [
					{ ...childTool({}, "active-tool"), name: "count_files" },
					{ ...childTool({}, "queued-tool"), name: "count_files" },
				],
			});
		},
		async (_name, _args, _roots, receivedSignal) => {
			assert(receivedSignal);
			signal = receivedSignal;
			started.release();
			signal.addEventListener("abort", aborted.release, { once: true });
			await aborted.promise;
			await cleanup.promise;
			return {
				status: "interrupted",
				result: '{"error":{"message":"cancelled after cleanup"}}',
			};
		},
	);
	try {
		const rootId = await f.ask("active tool");
		await started.promise;
		let returned = false;
		const cancellation = f
			.post(`/api/agents/${rootId}/cancel`, {})
			.then((response) => {
				returned = true;
				return response;
			});
		await aborted.promise;
		assert.equal(signal.aborted, true);
		assert.equal(returned, false);
		assert.equal((await f.get(`/api/chats/${f.chat.id}`)).busy, true);
		const running = (await f.get(`/api/agents/${rootId}/tools`)).toolCalls;
		assert.equal(running[0].status, "running");
		cleanup.release();
		assert.equal((await cancellation).status, 200);
		assert.equal((await f.wait(rootId)).status, "cancelled");
		const tools = (await f.get(`/api/agents/${rootId}/tools`)).toolCalls;
		assert.deepEqual(
			tools.map((tool: { status: string }) => tool.status),
			["interrupted", "interrupted"],
		);
		assert.equal(
			JSON.parse(tools[0].result).error.message,
			"cancelled after cleanup",
		);
		assert.equal(tools[1].result, null);
		assert.equal(
			requests,
			1,
			"Cancellation never starts a subsequent Model Call",
		);
	} finally {
		aborted.release();
		cleanup.release();
		await f.close();
	}
});

test("a failed child leaves its sibling running until the model explicitly cancels it", {
	timeout: 15000,
}, async () => {
	const fail = gate(),
		cancel = gate(),
		cleanup = gate();
	let siblingSignal!: AbortSignal;
	let rootRequests = 0;
	let notified = false;
	let siblingId = 0;
	const f = await fixture(
		async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			const prompt = userPrompt(request.input);
			if (prompt === "A") {
				await fail.promise;
				return new Response(
					frame("response.output_text.delta", {
						item_id: "A",
						output_index: 0,
						content_index: 0,
						delta: "A usable partial",
					}) +
						frame("response.failed", {
							response: { error: { message: "A failed" } },
						}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			if (prompt === "B") {
				if (!JSON.stringify(request.input).includes("function_call_output"))
					return completedResponse({
						output: [
							{
								...childTool({ path: "/unused" }, "B-tool"),
								name: "count_files",
							},
						],
					});
				assert(init?.signal);
				siblingSignal = init.signal;
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									frame("response.output_text.delta", {
										item_id: "B",
										output_index: 0,
										content_index: 0,
										delta: "B usable partial",
									}),
								),
							);
						},
						cancel: () => cleanup.promise,
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			rootRequests++;
			if (rootRequests === 1)
				return completedResponse({
					output: [
						childTool({ prompt: "A" }, "A"),
						childTool({ prompt: "B" }, "B"),
					],
				});
			if (rootRequests === 2)
				return completedResponse({ output: [message("waiting")] });
			if (rootRequests === 3) {
				assert(JSON.stringify(request.input).includes("A usable partial"));
				assert(JSON.stringify(request.input).includes("failed"));
				assert.equal(siblingSignal.aborted, false);
				notified = true;
				await cancel.promise;
				return completedResponse({
					output: [cancelTool({ agent_id: siblingId }, "cancel-B")],
				});
			}
			assert.equal(rootRequests, 4);
			const results = request.input.filter(
				(item: { type: string }) => item.type === "function_call_output",
			);
			assert.equal(JSON.parse(results.at(-1).output).status, "cancelled");
			assert(JSON.stringify(results.at(-1)).includes("B usable partial"));
			assert.deepEqual(
				JSON.parse(results.at(-1).output).tool_calls.map(
					(call: { status: string; result: string }) => ({
						status: call.status,
						result: call.result,
					}),
				),
				[
					{
						status: "failed",
						result: '{"error":{"message":"earlier B tool failure"}}',
					},
				],
			);
			return completedResponse({ output: [message("handled cancellation")] });
		},
		async () => ({
			status: "failed",
			result: '{"error":{"message":"earlier B tool failure"}}',
		}),
	);
	try {
		const rootId = await f.ask("A and B");
		await until(async () => Boolean(siblingSignal) && rootRequests === 2);
		siblingId = JSON.parse(
			(await f.get(`/api/agents/${rootId}/tools`)).toolCalls[1].result,
		).agent_id;
		fail.release();
		await until(async () => notified);
		assert.equal(
			(await f.get(`/api/agents/${siblingId}`)).agents[0].status,
			"pending",
		);
		cancel.release();
		await until(async () => siblingSignal.aborted);
		assert.equal(rootRequests, 3);
		assert.equal((await f.get(`/api/chats/${f.chat.id}`)).busy, true);
		cleanup.release();
		assert.equal((await f.wait(rootId)).status, "succeeded");
		assert.equal(
			(await f.get(`/api/agents/${siblingId}`)).agents[0].status,
			"cancelled",
		);
		assert.equal(rootRequests, 4);
	} finally {
		fail.release();
		cancel.release();
		cleanup.release();
		await f.close();
	}
});

test("cancelling count_files kills and reaps its active find process", {
	timeout: 15000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "cancel-find-"));
	const bin = join(directory, "bin");
	const pidFile = join(directory, "pid");
	await mkdir(bin);
	await writeFile(
		join(bin, "find"),
		`#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nexec /bin/sleep 30\n`,
		{ mode: 0o755 },
	);
	const previousPath = process.env.PATH;
	const cancellation = new AbortController();
	try {
		process.env.PATH = bin;
		const execution = executeTool(
			"count_files",
			JSON.stringify({ path: directory }),
			[directory],
			cancellation.signal,
		);
		let pid = 0;
		await until(async () => {
			try {
				pid = Number(await readFile(pidFile, "utf8"));
				return pid > 0;
			} catch {
				return false;
			}
		});
		process.kill(pid, 0);
		cancellation.abort();
		const result = await execution;
		assert.equal(result.status, "interrupted");
		assert.equal(JSON.parse(result.result).error.signal, "SIGKILL");
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	} finally {
		cancellation.abort();
		process.env.PATH = previousPath;
		await rm(directory, { recursive: true, force: true });
	}
});
