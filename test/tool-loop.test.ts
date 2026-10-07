import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ToolExecutor } from "../src/file-tools.ts";
import { createServer } from "../src/server.ts";
import { waitForAgent, waitForIdle } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { completedBody, frame } from "./model-fixture.ts";

const message = (text: string) => ({
	id: "answer",
	type: "message",
	content: [{ type: "output_text", text }],
});
const tool = (path: string, call_id = "count-1") => ({
	id: call_id,
	type: "function_call",
	name: "list_files",
	arguments: JSON.stringify({ path }),
	call_id,
});
const completed = (output: unknown[]) =>
	completedBody({ status: "completed", output });
async function fixture(
	fake: typeof fetch,
	roots: string[],
	execute?: ToolExecutor,
) {
	const directory = await mkdtemp(join(tmpdir(), "tool-db-"));
	const databasePath = join(directory, "db.sqlite");
	let server = createTestServer(
		fake,
		databasePath,
		"tool-secret",
		"tool-model",
		execute,
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	let base = `http://127.0.0.1:${address.port}`;
	// Exercise the existing fifth-call boundary using an explicit current limit.
	const db = new DatabaseSync(databasePath);
	db.prepare("UPDATE settings SET model_call_limit=5 WHERE id=1").run();
	db.close();
	const send = (route: string, body: unknown, method = "POST") =>
		fetch(base + route, { method, body: JSON.stringify(body) });
	const get = (route: string) => fetch(base + route).then((r) => r.json());
	const project = await (
		await send("/api/projects", { name: "P", folders: roots })
	).json();
	const chat = await (
		await send(`/api/projects/${project.id}/chats`, { name: "C" })
	).json();
	return {
		databasePath,
		restart: async () => {
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
			server = createTestServer(
				fake,
				databasePath,
				"tool-secret",
				"tool-model",
				execute,
			).listen(0, "127.0.0.1");
			await new Promise<void>((r) => server.once("listening", r));
			const address = server.address();
			assert(address && typeof address !== "string");
			base = `http://127.0.0.1:${address.port}`;
		},
		get,
		wait: (id: number) => waitForAgent(base, id),
		waitForIdle: (id: number) => waitForIdle(base, id),
		send,
		project,
		chat,
		ask: () =>
			send(`/api/chats/${chat.id}`, {
				modelId: "tool-model",
				prompt: "count files",
			}),
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("fresh database configures through HTTP and saves a complete tool loop", async () => {
	const directory = await mkdtemp(join(tmpdir(), "tool-fresh-"));
	const root = join(directory, "files");
	await mkdir(root);
	await writeFile(join(root, "one.txt"), "one");
	let calls = 0;
	const server = createServer(
		async (_url, init) => {
			calls++;
			const request = JSON.parse(String(init?.body));
			assert.equal(request.model, "fresh-model");
			assert.equal(
				new Headers(init?.headers).get("authorization"),
				"Bearer fresh-secret",
			);
			if (calls === 1) return new Response(completed([tool(root)]));
			assert.equal(JSON.parse(request.input.at(-1).output).entries.length, 1);
			return new Response(completed([message("one file")]));
		},
		join(directory, "db.sqlite"),
		async () =>
			Response.json({
				data: [
					{
						id: "fresh-model",
						name: "Fresh",
						architecture: { output_modalities: ["text"] },
					},
				],
			}),
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const request = async (route: string, method = "GET", body?: unknown) => {
		const response = await fetch(base + route, {
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		assert(response.ok, `${method} ${route}: ${response.status}`);
		return response.json();
	};
	try {
		assert.deepEqual(await request("/api/model-settings"), {
			apiKeyConfigured: false,
			defaultModelId: null,
			models: [],
		});
		await request("/api/model-settings", "PUT", { apiKey: "fresh-secret" });
		await request("/api/model-catalog");
		await request("/api/models", "POST", { id: "fresh-model" });
		await request("/api/model-settings", "PUT", {
			defaultModelId: "fresh-model",
		});
		const project = await request("/api/projects", "POST", {
			name: "Fresh",
			folders: [root],
		});
		const chat = await request(`/api/projects/${project.id}/chats`, "POST", {
			name: "Tools",
		});
		const accepted = await request(`/api/chats/${chat.id}`, "POST", {
			modelId: "fresh-model",
			prompt: "count",
		});
		assert.equal(
			(await waitForAgent(base, accepted.agentId)).status,
			"succeeded",
		);
		const history = await request(`/api/chats/${chat.id}`);
		assert.equal(history.agents[0].answer, "one file");
		assert.equal(history.agents[0].calls.length, 2);
		assert.equal(history.agents[0].toolCalls[0].status, "succeeded");
		const saved = await request(`/api/agents/${accepted.agentId}/tools`);
		assert.equal(saved.toolCalls.length, 1);
		assert.equal(JSON.parse(saved.toolCalls[0].result).entries.length, 1);
		assert.equal(calls, 2);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("Agent lists a real tree and continues with complete protocol context while retaining earlier output", async () => {
	const root = await mkdtemp(join(tmpdir(), "tool-tree-"));
	await mkdir(join(root, "nested"));
	await mkdir(join(root, ".hidden"));
	await Promise.all(
		Array.from({ length: 105 }, (_, i) =>
			writeFile(join(root, "nested", String(i)), "unchanged"),
		),
	);
	for (const name of [
		"space name",
		"line\nname",
		"中文",
		"$(touch injected);*",
	])
		await writeFile(join(root, name), "unchanged");
	await writeFile(join(root, ".ignored"), "hidden");
	await writeFile(join(root, ".hidden", "ignored"), "hidden");
	await symlink(join(root, "nested"), join(root, "link"));
	const before = await readdir(root);
	const requests: { tools: { name: string }[]; instructions: string }[] = [];
	const reasoning = {
		id: "r1",
		type: "reasoning",
		encrypted_content: "opaque",
		summary: [{ type: "summary_text", text: "thinking" }],
	};
	const call = tool(root);
	const f = await fixture(
		async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			requests.push(body);
			if (requests.length === 1)
				return new Response(
					frame("response.function_call_arguments.delta", {
						output_index: 2,
						delta: '{"path":',
					}) +
						frame("response.output_item.done", {
							output_index: 2,
							item: call,
						}) +
						completed([reasoning, message("Counting"), call]),
				);
			assert.deepEqual(body.input.slice(-4, -1), [
				reasoning,
				message("Counting"),
				call,
			]);
			const result = body.input.at(-1);
			assert.equal(result.type, "function_call_output");
			assert.equal(result.call_id, "count-1");
			assert.equal(JSON.parse(result.output).entries.length, 8);
			return new Response(completed([message("109 files")]));
		},
		[root],
	);
	try {
		const accepted = await f.ask();
		assert.equal(accepted.status, 202);
		assert.equal(
			(await f.wait((await accepted.json()).agentId)).status,
			"succeeded",
		);
		const history = await f.get(`/api/chats/${f.chat.id}`);
		assert.equal(history.agents[0].status, "succeeded");
		assert.equal(history.agents[0].answer, "Counting\n109 files");
		const calls = (await f.get(`/api/agents/${history.agents[0].id}/calls`))
			.calls;
		assert.equal(calls.length, 2);
		assert(calls.every((c: { status: string }) => c.status === "succeeded"));
		for (const request of requests) {
			assert.equal(request.tools[0].name, "list_files");
			assert.match(request.instructions, new RegExp(root));
		}
		assert.deepEqual(await readdir(root), before);
		assert.equal(
			await readFile(join(root, "nested", "0"), "utf8"),
			"unchanged",
		);
	} finally {
		await f.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Tool Results reject invalid scope and arguments and let the model correct them in order", async () => {
	const base = await mkdtemp(join(tmpdir(), "tool-scope-"));
	const root = join(base, "root"),
		sibling = join(base, "root-neighbor"),
		second = join(base, "second");
	await Promise.all([root, sibling, second].map((path) => mkdir(path)));
	await mkdir(join(root, "empty"));
	await writeFile(join(second, "file"), "keep");
	await symlink(sibling, join(root, "escape"));
	await symlink(root, join(base, "configured-link"));
	const invalid = [
		{ ...tool(root, "unknown"), name: "shell" },
		{ ...tool(root, "json"), arguments: "{" },
		{
			...tool(root, "extra"),
			arguments: JSON.stringify({ path: root, command: "touch injected" }),
		},
		{ ...tool(root, "type"), arguments: JSON.stringify({ path: 2 }) },
		tool("relative", "relative"),
		tool(sibling, "neighbor"),
		tool(join(root, "escape"), "escape"),
		tool(join(root, "missing"), "missing"),
		tool(join(second, "file"), "file"),
		tool(join(root, "$(touch injected)"), "injection"),
	];
	let request = 0;
	const f = await fixture(
		async (_url, init) => {
			request++;
			const body = JSON.parse(String(init?.body));
			if (request === 1) return new Response(completed(invalid));
			if (request === 2) {
				const results = body.input.filter(
					(i: { type: string }) => i.type === "function_call_output",
				);
				assert.deepEqual(
					results.map((r: { call_id: string; output: string }) => r.call_id),
					invalid.map((i) => i.call_id),
				);
				assert.deepEqual(
					results.map(
						(r: { call_id: string; output: string }) =>
							JSON.parse(r.output).error.kind,
					),
					[
						"validation",
						"validation",
						"validation",
						"validation",
						"validation",
						"scope",
						"scope",
						"execution",
						"validation",
						"execution",
					],
				);
				return new Response(
					completed([
						tool(join(root, "empty"), "empty"),
						tool(second, "second"),
						tool(join(base, "configured-link"), "link"),
					]),
				);
			}
			assert.deepEqual(
				body.input
					.filter((i: { type: string }) => i.type === "function_call_output")
					.slice(-3)
					.map(
						(r: { call_id: string; output: string }) =>
							JSON.parse(r.output).entries.length,
					),
				[0, 1, 2],
			);
			return new Response(completed([message("corrected")]));
		},
		[join(base, "configured-link"), second],
	);
	try {
		const accepted = await f.ask();
		assert.equal(accepted.status, 202);
		assert.equal(
			(await f.wait((await accepted.json()).agentId)).status,
			"succeeded",
		);
		assert.equal(request, 3);
		assert.deepEqual(await readdir(root), ["empty", "escape"]);
	} finally {
		await f.close();
		await rm(base, { recursive: true, force: true });
	}
});

test("a tool request with no target folders gets a scope error without gating text chat", async () => {
	let request = 0;
	const f = await fixture(async (_url, init) => {
		request++;
		if (request === 1) return new Response(completed([tool("/tmp")]));
		const body = JSON.parse(String(init?.body));
		assert.equal(JSON.parse(body.input.at(-1).output).error.kind, "scope");
		return new Response(completed([message("no configured folders")]));
	}, []);
	try {
		const accepted = await f.ask();
		assert.equal(accepted.status, 202);
		assert.equal(
			(await f.wait((await accepted.json()).agentId)).status,
			"succeeded",
		);
		assert.equal(request, 2);
	} finally {
		await f.close();
	}
});

for (const finalAnswer of [true, false])
	test(`fifth Model Call ${finalAnswer ? "can finish" : "stops before executing tools"}`, async () => {
		let request = 0;
		const f = await fixture(async (_url, init) => {
			request++;
			const body = JSON.parse(String(init?.body));
			assert.equal(
				body.input.filter(
					(i: { type: string }) => i.type === "function_call_output",
				).length,
				request - 1,
			);
			return new Response(
				completed(
					request === 5 && finalAnswer
						? [message("finished at five")]
						: [message(`step ${request}`), tool("/tmp", `call-${request}`)],
				),
			);
		}, []);
		try {
			const response = await f.ask();
			assert.equal(response.status, 202);
			const agent = await f.wait((await response.json()).agentId);
			if (!finalAnswer) {
				assert.equal(agent.errorCode, "modelCallLimit");
				const calls = (await f.get(`/api/agents/${agent.id}/calls`)).calls;
				assert(
					calls.every(
						(call: { status: string; errorCode: string | null }) =>
							call.status === "succeeded" && call.errorCode === null,
					),
				);
			}
			assert.equal(agent.status, finalAnswer ? "succeeded" : "failed");
			assert.match(
				agent.answer,
				finalAnswer ? /finished at five/ : /step 1[\s\S]*step 5/,
			);
			assert.equal(
				(await f.get(`/api/agents/${agent.id}/calls`)).calls.length,
				5,
			);
			assert.equal(request, 5);
		} finally {
			await f.close();
		}
	});

for (const output of [
	[
		{
			type: "function_call",
			name: "list_files",
			arguments: '{"path":"/tmp"}',
		},
	],
	[tool("/tmp"), tool("/tmp")],
	[tool("/tmp"), null],
])
	test("malformed completed protocol fails before tool continuation", async () => {
		let requests = 0;
		const f = await fixture(async () => {
			requests++;
			return new Response(completed(output));
		}, []);
		try {
			const accepted = await f.ask();
			assert.equal(accepted.status, 202);
			assert.equal(
				(await f.wait((await accepted.json()).agentId)).status,
				"failed",
			);
			assert.equal(requests, 1);
		} finally {
			await f.close();
		}
	});

for (const terminal of [
	frame("response.output_item.done", { output_index: 0, item: tool("/tmp") }),
	frame("response.completed", {
		response: { status: "in_progress", output: [tool("/tmp")] },
	}),
	frame("response.completed", { response: { output: [tool("/tmp")] } }),
	"data: [DONE]\n\n",
])
	test("only valid completed responses may dispatch tools", async () => {
		let requests = 0;
		const f = await fixture(async () => {
			requests++;
			return new Response(terminal);
		}, []);
		try {
			const accepted = await f.ask();
			assert.equal(accepted.status, 202);
			assert.equal(
				(await f.wait((await accepted.json()).agentId)).status,
				"failed",
			);
			assert.equal(requests, 1);
		} finally {
			await f.close();
		}
	});

test("remote continuation failure retains saved prior and partial output without a retry", async () => {
	let requests = 0;
	const f = await fixture(async () => {
		requests++;
		return requests === 1
			? new Response(completed([message("first"), tool("/tmp")]))
			: new Response(
					frame("response.output_text.delta", {
						output_index: 0,
						delta: "partial second",
					}),
				);
	}, []);
	try {
		const accepted = await f.ask();
		assert.equal(accepted.status, 202);
		assert.equal(
			(await f.wait((await accepted.json()).agentId)).status,
			"failed",
		);
		assert.equal(requests, 2);
		const agent = (await f.get(`/api/chats/${f.chat.id}`)).agents[0];
		assert.equal(agent.status, "failed");
		assert.equal(agent.answer, "first\npartial second");
		const calls = (await f.get(`/api/agents/${agent.id}/calls`)).calls;
		assert.deepEqual(
			calls.map((c: { status: string }) => c.status),
			["succeeded", "failed"],
		);
	} finally {
		await f.close();
	}
});

test("each tool and subsequent Model Call reads current scope and credentials", async () => {
	const base = await mkdtemp(join(tmpdir(), "tool-capture-"));
	const root = join(base, "initial"),
		later = join(base, "later");
	await mkdir(root);
	await mkdir(later);
	await writeFile(join(root, "file"), "keep");
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const started = new Promise<void>((r) => (entered = r));
	let requests = 0;
	const f = await fixture(
		async (_url, init) => {
			requests++;
			const body = JSON.parse(String(init?.body));
			assert.match(
				body.instructions,
				new RegExp(requests === 1 ? root : later),
			);
			assert.equal(
				new Headers(init?.headers).get("authorization"),
				requests === 1 ? "Bearer tool-secret" : "Bearer changed-secret",
			);
			assert.equal(body.model, "tool-model");
			if (requests === 1) {
				entered();
				await gate;
				return new Response(
					completed([
						message("tool-secret first response"),
						tool(root, "tool-secret"),
					]),
				);
			}
			assert.equal(JSON.parse(body.input.at(-1).output).error.kind, "scope");
			assert.match(JSON.stringify(body.input), /tool-secret/);
			return new Response(
				completed([message("tool-secret changed-secret captured")]),
			);
		},
		[root],
	);
	try {
		const accepted = await f.send(`/api/chats/${f.chat.id}`, {
			prompt: "count tool-secret files",
		});
		assert.equal(accepted.status, 202);
		const { agentId } = await accepted.json();
		await started;
		assert.equal(
			(
				await f.send(
					`/api/projects/${f.project.id}`,
					{ name: "P", folders: [later] },
					"PUT",
				)
			).status,
			200,
		);
		assert.equal(
			(await f.send("/api/model-settings", { apiKey: "changed-secret" }, "PUT"))
				.status,
			200,
		);
		assert.equal((await f.get(`/api/chats/${f.chat.id}`)).busy, true);
		assert.equal((await f.ask()).status, 409);
		release();
		assert.equal((await f.wait(agentId)).status, "succeeded");
		assert.equal(requests, 2);
		for (const endpoint of [
			`/api/chats/${f.chat.id}`,
			`/api/agents/${agentId}/calls`,
			`/api/agents/${agentId}/tools`,
		])
			assert.doesNotMatch(
				JSON.stringify(await f.get(endpoint)),
				/tool-secret|changed-secret/,
			);
		const saved = new DatabaseSync(f.databasePath);
		try {
			for (const table of ["agents", "model_calls", "tool_calls"])
				assert.doesNotMatch(
					JSON.stringify(saved.prepare(`SELECT * FROM ${table}`).all()),
					/tool-secret|changed-secret/,
				);
		} finally {
			saved.close();
		}
	} finally {
		release();
		await f.close();
		await rm(base, { recursive: true, force: true });
	}
});

test("a completed final response must itself contain a usable answer", async () => {
	const f = await fixture(
		async () =>
			new Response(
				frame("response.output_text.delta", {
					output_index: 0,
					delta: "partial",
				}) + completed([]),
			),
		[],
	);
	try {
		const accepted = await f.ask();
		assert.equal(accepted.status, 202);
		assert.equal(
			(await f.wait((await accepted.json()).agentId)).status,
			"failed",
		);
		const agent = (await f.get(`/api/chats/${f.chat.id}`)).agents[0];
		assert.equal(agent.answer, "partial");
		assert.equal(agent.status, "failed");
	} finally {
		await f.close();
	}
});

test("a continuation persistence failure preserves prior calls and restart interrupts without resuming", async () => {
	let requests = 0;
	let executions = 0;
	const f = await fixture(
		async () => {
			requests++;
			return requests === 1
				? new Response(completed([message("saved first"), tool("/tmp")]))
				: new Response(completed([message("must not request")]));
		},
		[],
		async () => {
			executions++;
			return { status: "succeeded", result: "saved independently" };
		},
	);
	const db = new DatabaseSync(f.databasePath);
	try {
		db.exec(
			"CREATE TRIGGER reject_continuation BEFORE INSERT ON model_calls WHEN EXISTS(SELECT 1 FROM model_calls) BEGIN SELECT RAISE(ABORT,'rejected'); END",
		);
		db.exec(
			"CREATE TRIGGER reject_failure BEFORE UPDATE OF status ON agents WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'rejected'); END",
		);
		const accepted = await f.ask();
		assert.equal(accepted.status, 202);
		await f.waitForIdle((await accepted.json()).agentId);
		assert.equal(requests, 1);
		let agent = (await f.get(`/api/chats/${f.chat.id}`)).agents[0];
		assert.equal(agent.status, "failed");
		assert.equal(agent.errorCode, "answerWriteFailed");
		assert.equal(
			db.prepare("SELECT status FROM agents WHERE id=?").get(agent.id)?.status,
			"pending",
		);
		assert.equal(agent.answer, "saved first");
		assert.equal(
			(await f.get(`/api/agents/${agent.id}/calls`)).calls.length,
			1,
		);
		const savedTools = (await f.get(`/api/agents/${agent.id}/tools`)).toolCalls;
		assert.equal(savedTools[0].status, "succeeded");
		assert.equal(savedTools[0].result, "saved independently");
		assert.equal(executions, 1);
		db.exec("DROP TRIGGER reject_continuation; DROP TRIGGER reject_failure");
		await f.restart();
		agent = (await f.get(`/api/chats/${f.chat.id}`)).agents[0];
		assert.equal(agent.status, "failed");
		assert.equal(agent.errorCode, "agentInterrupted");
		assert.deepEqual(
			(await f.get(`/api/agents/${agent.id}/tools`)).toolCalls,
			savedTools,
		);
		assert.equal(executions, 1);
		assert.equal(agent.answer, "saved first");
		assert.equal(requests, 1);
	} finally {
		db.close();
		await f.close();
	}
});

for (const status of ["in_progress", "incomplete"])
	test(`an explicitly ${status} Tool Call cannot execute inside a completed response`, async () => {
		let requests = 0;
		const f = await fixture(async () => {
			requests++;
			return new Response(completed([{ ...tool("/tmp"), status }]));
		}, []);
		try {
			const accepted = await f.ask();
			assert.equal(accepted.status, 202);
			assert.equal(
				(await f.wait((await accepted.json()).agentId)).status,
				"failed",
			);
			assert.equal(requests, 1);
		} finally {
			await f.close();
		}
	});

test("Model Call ownership and selected saved bodies survive continuation, failure and restart", async () => {
	const reasoning = {
		id: "same-item-id",
		type: "reasoning",
		summary: [{ type: "summary_text", text: "first thinking" }],
	};
	const call = tool("/tmp");
	let requests = 0;
	let second!: ReadableStreamDefaultController<Uint8Array>;
	const f = await fixture(async (_url, options) => {
		requests++;
		if (requests === 1) return new Response(completed([reasoning, call]));
		if (requests === 3) return new Response(completed([message("followup")]));
		const input = JSON.parse(String(options?.body)).input;
		assert.deepEqual(input.slice(-3, -1), [reasoning, call]);
		return new Response(
			new ReadableStream({
				start(controller) {
					second = controller;
				},
			}),
		);
	}, []);
	try {
		const pending = f.ask();
		pending.catch(() => {});
		while (!second) await new Promise((resolve) => setImmediate(resolve));
		second.enqueue(
			new TextEncoder().encode(
				frame("response.reasoning_summary_text.delta", {
					output_index: 0,
					item_id: "same-item-id",
					delta: "second thinking",
				}) +
					frame("response.output_text.delta", {
						output_index: 1,
						item_id: "same-item-id",
						delta: "partial answer",
					}),
			),
		);
		let agent = (await f.get(`/api/chats/${f.chat.id}`)).agents[0];
		while (agent.output.length < 4) {
			await new Promise((resolve) => setImmediate(resolve));
			agent = (await f.get(`/api/chats/${f.chat.id}`)).agents[0];
		}
		assert.deepEqual(
			agent.output.map((item: { callId: number }) => item.callId),
			[
				agent.calls[0].id,
				agent.calls[0].id,
				agent.calls[1].id,
				agent.calls[1].id,
			],
		);
		assert.deepEqual(
			agent.output.map((item: { index: number }) => item.index),
			[0, 1, 0, 1],
		);
		assert(agent.output.every((item: object) => !("callOrdinal" in item)));
		assert.deepEqual(
			agent.calls.map((call: { ordinal: number; status: string }) => [
				call.ordinal,
				call.status,
			]),
			[
				[1, "succeeded"],
				[2, "pending"],
			],
		);
		const metadata = (
			await f.get(`/api/agents/${agent.id}/calls?kind=metadata`)
		).calls;
		assert.deepEqual(
			metadata.map((call: { id: number }) => call.id),
			agent.calls.map((call: { id: number }) => call.id),
		);
		assert(
			metadata.every(
				(call: object) => !("requestBody" in call) && !("responseBody" in call),
			),
		);
		for (const savedCall of agent.calls) {
			const request = (
				await f.get(
					`/api/agents/${agent.id}/calls?kind=request&callId=${savedCall.id}`,
				)
			).calls;
			assert.equal(request.length, 1);
			assert.equal(request[0].id, savedCall.id);
			assert.equal(request[0].responseBody, null);
			assert.equal(JSON.parse(request[0].requestBody).model, "tool-model");
		}
		const details = (
			await Promise.all(
				agent.calls.map(
					async (call: { id: number }) =>
						(
							await f.get(`/api/agents/${agent.id}/reasoning?callId=${call.id}`)
						).output,
				),
			)
		).flat();
		assert.deepEqual(
			details.map(
				(item: { content: { text: string }[] }) => item.content[0].text,
			),
			["first thinking", "second thinking"],
		);
		const onlySecond = (
			await f.get(
				`/api/agents/${agent.id}/reasoning?callId=${agent.calls[1].id}`,
			)
		).output;
		assert.deepEqual(onlySecond, [details[1]]);
		for (const suffix of ["callId=0", "callId=bogus", "kind=bogus"])
			assert.equal(
				(await f.get(`/api/agents/${agent.id}/calls?${suffix}`)).code,
				"invalidInput",
			);
		assert.equal(
			(await f.get(`/api/agents/${agent.id}/reasoning?callId=0`)).code,
			"invalidInput",
		);
		assert.equal(
			(await f.get(`/api/agents/${agent.id}/calls?callId=999999`)).code,
			"notFound",
		);
		second.close();
		const submitted = await pending;
		assert.equal(submitted.status, 202);
		do {
			agent = (await f.get(`/api/chats/${f.chat.id}`)).agents[0];
		} while (agent.status === "pending");
		assert.equal(agent.status, "failed");
		assert.deepEqual(
			agent.calls.map((call: { status: string }) => call.status),
			["succeeded", "failed"],
		);
		const response = (
			await f.get(
				`/api/agents/${agent.id}/calls?kind=response&callId=${agent.calls[1].id}`,
			)
		).calls;
		assert.equal(response.length, 1);
		assert.match(response[0].responseBody, /second thinking/);
		assert.doesNotMatch(response[0].responseBody, /first thinking/);
		assert.equal(response[0].requestBody, null);
		await f.restart();
		const saved = (await f.get(`/api/agents/${agent.id}`)).agents[0];
		assert.deepEqual(saved.calls, agent.calls);
		assert.deepEqual(saved.output, agent.output);
		assert.deepEqual(
			(
				await f.get(
					`/api/agents/${agent.id}/reasoning?callId=${agent.calls[1].id}`,
				)
			).output,
			[details[1]],
		);
		assert.equal(requests, 2);
		assert.equal((await f.ask()).status, 202);
		let later = (await f.get(`/api/chats/${f.chat.id}`)).agents.at(-1);
		while (later.status === "pending")
			later = (await f.get(`/api/chats/${f.chat.id}`)).agents.at(-1);
		assert.equal(later.calls[0].ordinal, 1);
		assert(later.calls[0].id > agent.calls[1].id);
		assert.equal(
			(
				await f.get(
					`/api/agents/${later.id}/calls?kind=request&callId=${agent.calls[0].id}`,
				)
			).code,
			"notFound",
		);
		assert.equal(
			(
				await f.get(
					`/api/agents/${later.id}/reasoning?callId=${agent.calls[0].id}`,
				)
			).code,
			"notFound",
		);
		assert.equal(
			(await f.get(`/api/agents/${later.id}/reasoning`)).code,
			"invalidInput",
		);
		assert.equal(requests, 3);
	} finally {
		await f.close();
	}
});

test("independent tool records expose ordered waiting/running calls, preserve results and scope repeated identity", async () => {
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const running = new Promise<void>((resolve) => (entered = resolve));
	let execution = 0;
	let requests = 0;
	const result =
		'{"error":"business data","nested":{"items":[null,true,42]},"path":"tool-secret"}';
	const f = await fixture(
		async (_url, init) => {
			requests++;
			if (requests === 1)
				return new Response(
					completed([
						{ ...tool("tool-secret"), name: "inspect_tool-secret" },
						{ ...tool("second", "count-2"), name: "other" },
					]),
				);
			const input = JSON.parse(String(init?.body)).input;
			if (requests === 2) {
				assert.equal(input.at(-2).output, result);
				assert.equal(input.at(-1).output, "plain text\nnot JSON");
				return new Response(
					completed([{ ...tool("third"), name: "inspect_tool-secret" }]),
				);
			}
			assert.equal(input.at(-1).output, "");
			return new Response(completed([message("done")]));
		},
		[],
		async (name, args) => {
			execution++;
			assert.equal(name, execution === 2 ? "other" : "inspect_tool-secret");
			if (execution === 1) {
				assert.equal(JSON.parse(args).path, "tool-secret");
				entered();
				await gate;
			}
			return {
				status: "succeeded",
				result:
					execution === 1
						? result
						: execution === 2
							? "plain text\nnot JSON"
							: "",
			};
		},
	);
	try {
		const { agentId } = await (await f.ask()).json();
		await running;
		const agent = (await f.get(`/api/agents/${agentId}`)).agents[0];
		assert.equal(agent.status, "pending");
		assert.deepEqual(
			agent.toolCalls.map((call: { status: string }) => call.status),
			["running", "waiting"],
		);
		assert.equal(execution, 1);
		assert.equal(requests, 1);
		assert.equal((await f.get(`/api/chats/${f.chat.id}`)).busy, true);
		assert.equal((await f.ask()).status, 409);
		assert(
			agent.toolCalls.every(
				(call: object) => !("arguments" in call) && !("result" in call),
			),
		);
		const pending = (await f.get(`/api/agents/${agentId}/tools`)).toolCalls;
		assert.equal(pending[0].name, "inspect_[REDACTED]");
		assert.equal(JSON.parse(pending[0].arguments).path, "[REDACTED]");
		assert.equal(pending[0].result, null);
		assert.deepEqual(
			pending.map((call: { ordinal: number }) => call.ordinal),
			[1, 2],
		);
		release();
		assert.equal((await f.wait(agentId)).status, "succeeded");
		const saved = (await f.get(`/api/agents/${agentId}/tools`)).toolCalls;
		assert.equal(saved.length, 3);
		assert.equal(new Set(saved.map((call: { id: number }) => call.id)).size, 3);
		assert.equal(saved[0].callId, saved[2].callId);
		assert.notEqual(saved[0].modelCallId, saved[2].modelCallId);
		assert.deepEqual(
			saved.map((call: { status: string }) => call.status),
			["succeeded", "succeeded", "succeeded"],
		);
		assert.equal(
			saved[0].result,
			result.replaceAll("tool-secret", "[REDACTED]"),
		);
		assert.equal(saved[1].result, "plain text\nnot JSON");
		assert.equal(saved[2].result, "");
		const db = new DatabaseSync(f.databasePath);
		assert.doesNotMatch(
			JSON.stringify(db.prepare("SELECT * FROM tool_calls").all()),
			/tool-secret/,
		);
		db.close();
		assert.deepEqual(
			(await f.get(`/api/agents/${agentId}/tools?toolId=${saved[1].id}`))
				.toolCalls,
			[saved[1]],
		);
		for (const toolId of ["0", "bogus", "-1", "1.5", "9007199254740992"])
			assert.equal(
				(await f.get(`/api/agents/${agentId}/tools?toolId=${toolId}`)).code,
				"invalidInput",
			);
		assert.equal(
			(await f.get(`/api/agents/${agentId}/tools?toolId=999999`)).code,
			"notFound",
		);
		assert.equal((await f.get("/api/agents/999999/tools")).code, "notFound");
		assert.equal(
			(
				await f.send(
					`/api/chats/${f.chat.id}/archive`,
					{ archived: true },
					"PUT",
				)
			).status,
			200,
		);
		assert.deepEqual(
			(await f.get(`/api/agents/${agentId}/tools`)).toolCalls,
			saved,
		);
		await f.restart();
		assert.deepEqual(
			(await f.get(`/api/agents/${agentId}/tools`)).toolCalls,
			saved,
		);
		assert.equal(execution, 3);
		assert.equal(requests, 3);
	} finally {
		release();
		await f.close();
	}
});

test("tool execution failures are explicit, redact actual errors, and remain saved after continuation failure", async () => {
	let requests = 0;
	const f = await fixture(
		async () => {
			requests++;
			return requests === 1
				? new Response(completed([tool("/tmp")]))
				: new Response("failed model", { status: 500 });
		},
		[],
		async () => ({
			status: "failed",
			result: '{"error":{"message":"tool-secret failed"},"details":[1,2]}',
		}),
	);
	try {
		const { agentId } = await (await f.ask()).json();
		const agent = await f.wait(agentId);
		assert.equal(agent.status, "failed");
		assert.equal(agent.toolCalls[0].status, "failed");
		const saved = (await f.get(`/api/agents/${agentId}/tools`)).toolCalls;
		assert.equal(
			saved[0].result,
			'{"error":{"message":"[REDACTED] failed"},"details":[1,2]}',
		);
		assert.equal(requests, 2);
		await f.restart();
		assert.deepEqual(
			(await f.get(`/api/agents/${agentId}/tools`)).toolCalls,
			saved,
		);
	} finally {
		await f.close();
	}
});

test("restart interrupts waiting and running tools without replay and preserves prior results", async () => {
	let requests = 0;
	let executions = 0;
	let entered!: () => void;
	let release!: () => void;
	const running = new Promise<void>((r) => {
		entered = r;
	});
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const f = await fixture(
		async () => {
			requests++;
			return new Response(
				completed([
					tool("first", "a"),
					tool("running", "b"),
					tool("waiting", "c"),
				]),
			);
		},
		[],
		async () => {
			executions++;
			if (executions === 2) {
				entered();
				await gate;
			}
			return { status: "succeeded", result: "saved result" };
		},
	);
	try {
		const { agentId } = await (await f.ask()).json();
		await running;
		await f.restart();
		const calls = (await f.get(`/api/agents/${agentId}/tools`)).toolCalls;
		assert.deepEqual(
			calls.map((c: { status: string }) => c.status),
			["succeeded", "interrupted", "interrupted"],
		);
		assert.equal(calls[0].result, "saved result");
		for (const call of calls.slice(1)) {
			assert.equal(call.result, null);
			assert.equal(call.reason, "toolRestartInterrupted");
			assert.equal(typeof call.arguments, "string");
		}
		assert.equal((await f.wait(agentId)).status, "failed");
		assert.equal((await f.get(`/api/chats/${f.chat.id}`)).busy, false);
		release();
		await new Promise<void>((r) => setImmediate(r));
		assert.equal(requests, 1);
		assert.equal(executions, 2);
		assert.deepEqual(
			(await f.get(`/api/agents/${agentId}/tools`)).toolCalls,
			calls,
		);
	} finally {
		release();
		await f.close();
	}
});

for (const boundary of ["establish", "start", "result", "terminal"]) {
	test(`tool ${boundary} save failure stops execution and exposes only committed content`, async () => {
		let requests = 0;
		let executions = 0;
		let f: Awaited<ReturnType<typeof fixture>>;
		f = await fixture(
			async () => {
				requests++;
				const db = new DatabaseSync(f.databasePath);
				const condition =
					boundary === "establish"
						? "BEFORE INSERT ON tool_calls"
						: boundary === "start"
							? "BEFORE UPDATE ON tool_calls WHEN NEW.status='running'"
							: boundary === "result"
								? "BEFORE UPDATE OF result ON tool_calls"
								: "BEFORE UPDATE ON tool_calls WHEN NEW.status='succeeded'";
				db.exec(
					`CREATE TRIGGER fail_tool ${condition} BEGIN SELECT RAISE(FAIL,'tool-secret DB failure'); END`,
				);
				db.close();
				return new Response(
					completed([tool("tool-secret", "a"), tool("waiting", "b")]),
				);
			},
			[],
			async () => {
				executions++;
				return {
					status: "succeeded",
					result: "never committed tool-secret result",
				};
			},
		);
		try {
			const { agentId } = await (await f.ask()).json();
			const agent = await f.wait(agentId);
			assert.equal(agent.status, "failed");
			assert.equal(agent.errorCode, "toolWriteFailed");
			assert.equal(requests, 1);
			assert.equal(
				executions,
				boundary === "result" || boundary === "terminal" ? 1 : 0,
			);
			const calls = (await f.get(`/api/agents/${agentId}/tools`)).toolCalls;
			assert.equal(calls.length, boundary === "establish" ? 0 : 2);
			for (const call of calls) {
				assert.equal(call.status, "interrupted");
				assert.equal(call.reason, "toolSaveFailed");
				assert.equal(call.result, null);
			}
			assert.doesNotMatch(JSON.stringify(calls), /tool-secret|never committed/);
			assert.equal((await f.get(`/api/chats/${f.chat.id}`)).busy, false);
			const db = new DatabaseSync(f.databasePath);
			db.exec("DROP TRIGGER fail_tool");
			db.close();
			await f.restart();
			assert.deepEqual(
				(await f.get(`/api/agents/${agentId}/tools`)).toolCalls,
				calls,
			);
			assert.equal(requests, 1);
			assert.equal(
				executions,
				boundary === "result" || boundary === "terminal" ? 1 : 0,
			);
		} finally {
			await f.close();
		}
	});
}

test("unwritable tool finalization reports save failure without keeping running or inventing a result", async () => {
	let f: Awaited<ReturnType<typeof fixture>>;
	let requests = 0;
	let executions = 0;
	f = await fixture(
		async () => {
			requests++;
			return new Response(completed([tool("first"), tool("next", "next")]));
		},
		[],
		async () => {
			executions++;
			const db = new DatabaseSync(f.databasePath);
			db.exec(
				"CREATE TRIGGER fail_all_tool_updates BEFORE UPDATE ON tool_calls BEGIN SELECT RAISE(FAIL,'blocked'); END",
			);
			db.close();
			return { status: "succeeded", result: "unsaved result" };
		},
	);
	try {
		const { agentId } = await (await f.ask()).json();
		await f.wait(agentId);
		const tools = (await f.get(`/api/agents/${agentId}/tools`)).toolCalls;
		assert.deepEqual(
			tools.map((c: { status: string }) => c.status),
			["interrupted", "interrupted"],
		);
		assert(
			tools.every(
				(c: { reason: string; result: null }) =>
					c.reason === "toolSaveFailed" && c.result === null,
			),
		);
		const history = await f.get(`/api/chats/${f.chat.id}`);
		assert.deepEqual(
			history.agents[0].toolCalls.map((c: { status: string }) => c.status),
			["interrupted", "interrupted"],
		);
		const db = new DatabaseSync(f.databasePath);
		assert.deepEqual(
			db
				.prepare("SELECT status FROM tool_calls ORDER BY id")
				.all()
				.map((c) => c.status),
			["running", "waiting"],
		);
		db.exec("DROP TRIGGER fail_all_tool_updates");
		db.close();
		await f.restart();
		const restarted = (await f.get(`/api/agents/${agentId}/tools`)).toolCalls;
		assert(
			restarted.every(
				(c: { status: string; reason: string; result: null }) =>
					c.status === "interrupted" &&
					c.reason === "toolRestartInterrupted" &&
					c.result === null,
			),
		);
		assert.equal(requests, 1);
		assert.equal(executions, 1);
	} finally {
		await f.close();
	}
});

test("fifth response records unexecuted requests and no fabricated Tool Result", async () => {
	let requests = 0;
	let executions = 0;
	const f = await fixture(
		async () => {
			requests++;
			return new Response(completed([tool(`round-${requests}`)]));
		},
		[],
		async () => {
			executions++;
			return { status: "succeeded", result: "" };
		},
	);
	try {
		const { agentId } = await (await f.ask()).json();
		assert.equal((await f.wait(agentId)).errorCode, "modelCallLimit");
		const tools = (await f.get(`/api/agents/${agentId}/tools`)).toolCalls;
		assert.equal(tools.length, 5);
		assert.equal(tools[4].status, "not_executed");
		assert.equal(tools[4].reason, "modelCallLimit");
		assert.equal(tools[4].result, null);
		assert.equal(JSON.parse(tools[4].arguments).path, "round-5");
		assert.equal(requests, 5);
		assert.equal(executions, 4);
	} finally {
		await f.close();
	}
});

test("each tool in one Model Call reads the current Project scope", async () => {
	const base = await mkdtemp(join(tmpdir(), "tool-current-scope-"));
	const first = join(base, "first"),
		second = join(base, "second");
	await mkdir(first);
	await mkdir(second);
	let entered!: () => void, release!: () => void;
	const started = new Promise<void>((resolve) => (entered = resolve));
	const held = new Promise<void>((resolve) => (release = resolve));
	const scopes: string[][] = [];
	let requests = 0;
	const f = await fixture(
		async () => {
			requests++;
			return new Response(
				completed(
					requests === 1
						? [tool(first, "first"), tool(second, "second")]
						: [message("done")],
				),
			);
		},
		[first],
		async (_name, _args, roots) => {
			scopes.push([...roots]);
			if (scopes.length === 1) {
				entered();
				await held;
			}
			return { status: "succeeded", result: '{"count":0}' };
		},
	);
	try {
		const { agentId } = await (await f.ask()).json();
		await started;
		assert.equal(
			(
				await f.send(
					`/api/projects/${f.project.id}`,
					{ name: "P", folders: [second] },
					"PUT",
				)
			).status,
			200,
		);
		release();
		assert.equal((await f.wait(agentId)).status, "succeeded");
		assert.deepEqual(scopes, [[first], [second]]);
	} finally {
		release();
		await f.close();
		await rm(base, { recursive: true, force: true });
	}
});

const fileCall = (name: string, args: object, call_id: string) => ({
	id: call_id,
	type: "function_call",
	name,
	arguments: JSON.stringify(args),
	call_id,
});

test("file tools return real scoped paths, literal UTF-8 matches and usable bounded continuations through HTTP", async () => {
	const base = await realpath(
		await mkdtemp(join(tmpdir(), "file-tools-http-")),
	);
	const root = join(base, "root"),
		second = join(base, "second"),
		outside = join(base, "root-neighbor");
	await Promise.all([root, second, outside].map((path) => mkdir(path)));
	await mkdir(join(root, "nested"));
	await mkdir(join(root, ".git"));
	await writeFile(join(root, ".hidden"), "secret 中文\n");
	await writeFile(join(root, ".git", "config"), "secret git\n");
	await writeFile(join(second, "other.txt"), "second root\n");
	await writeFile(join(outside, "outside.txt"), "secret outside\n");
	await symlink(outside, join(root, "escape"));
	const textPath = join(root, "nested", "文.txt");
	await writeFile(textPath, "中文 😀\nneedle.* literal\nNeedle.* differs\n");
	await writeFile(join(root, "binary"), Buffer.from([0x61, 0, 0x62]));
	await writeFile(join(root, "invalid-utf8"), Buffer.from([0xff, 0xfe]));
	await Promise.all(
		Array.from({ length: 105 }, (_, i) =>
			writeFile(
				join(root, `entry-${String(i).padStart(3, "0")}.txt`),
				"match\n",
			),
		),
	);
	const linesPath = join(root, "many-lines.txt");
	await writeFile(linesPath, "short\n".repeat(2005));
	let requests = 0;
	let listOffset = 0,
		searchOffset = 0;
	const f = await fixture(
		async (_url, init) => {
			requests++;
			const body = JSON.parse(String(init?.body));
			if (requests === 1)
				return new Response(
					completed([
						fileCall("list_files", { path: root }, "listing"),
						fileCall(
							"list_files",
							{ path: root, pattern: "nested/**/*.txt" },
							"discovery",
						),
						fileCall(
							"search_files",
							{ path: root, query: "needle.*" },
							"literal",
						),
						fileCall(
							"search_files",
							{ path: root, query: "match" },
							"search-page",
						),
						fileCall(
							"search_files",
							{ path: root, query: "secret" },
							"hidden-search",
						),
						fileCall(
							"read_file",
							{ path: textPath, startLine: 1, endLine: 2 },
							"unicode",
						),
						fileCall("read_file", { path: linesPath }, "lines-page"),
						fileCall(
							"read_file",
							{ path: join(root, ".git", "config") },
							"git",
						),
						fileCall(
							"read_file",
							{ path: join(second, "other.txt") },
							"second",
						),
						fileCall("read_file", { path: join(root, "binary") }, "binary"),
						fileCall(
							"read_file",
							{ path: join(root, "invalid-utf8") },
							"invalid",
						),
						fileCall(
							"read_file",
							{ path: join(root, "escape", "outside.txt") },
							"symlink",
						),
						fileCall(
							"read_file",
							{ path: `${root}/../root-neighbor/outside.txt` },
							"traversal",
						),
						fileCall(
							"read_file",
							{ path: join(outside, "outside.txt") },
							"sibling",
						),
						fileCall("read_file", { path: join(root, "missing") }, "missing"),
					]),
				);
			const outputs = body.input.filter(
				(item: { type: string }) => item.type === "function_call_output",
			);
			const results = new Map<
				string,
				{
					entries: { path: string; type: string }[];
					matches: {
						path: string;
						line: number;
						text: string;
						textTruncated: boolean;
					}[];
					truncated: boolean;
					nextOffset: number;
					text: string;
					nextLine: number;
					error: { kind: string };
				}
			>(
				outputs.map((item: { call_id: string; output: string }) => [
					item.call_id,
					JSON.parse(item.output),
				]),
			);
			const result = (id: string) => {
				const found = results.get(id);
				assert(found, `Missing result ${id}`);
				return found;
			};
			if (requests === 2) {
				const listing = result("listing");
				assert.equal(listing.entries.length, 100);
				assert.equal(listing.truncated, true);
				listOffset = listing.nextOffset;
				assert.equal(listOffset, 100);
				assert(
					listing.entries.every(
						(entry: { path: string; type: string }) =>
							entry.path.startsWith(`${root}/`) &&
							["file", "directory", "symlink"].includes(entry.type),
					),
				);
				assert.deepEqual(result("discovery").entries, [
					{ path: textPath, type: "file" },
				]);
				assert.deepEqual(
					result("literal").matches.map(({ path, line, text }) => ({
						path,
						line,
						text,
					})),
					[{ path: textPath, line: 2, text: "needle.* literal" }],
				);
				assert.equal(result("search-page").matches.length, 100);
				searchOffset = result("search-page").nextOffset;
				assert.equal(searchOffset, 100);
				assert.deepEqual(
					result("hidden-search")
						.matches.map(
							(match: {
								textTruncated: boolean;
								path: string;
								line: number;
								text: string;
							}) => match.path,
						)
						.sort(),
					[join(root, ".hidden"), join(root, ".git", "config")].sort(),
				);
				assert.equal(result("unicode").text, "中文 😀\nneedle.* literal\n");
				assert.equal(result("unicode").truncated, false);
				assert.equal(result("lines-page").text, "short\n".repeat(2000));
				assert.equal(result("lines-page").nextLine, 2001);
				assert.equal(result("git").text, "secret git\n");
				assert.equal(result("second").text, "second root\n");
				for (const id of ["binary", "invalid", "traversal"])
					assert.equal(result(id).error.kind, "validation");
				for (const id of ["symlink", "sibling"])
					assert.equal(result(id).error.kind, "scope");
				assert.equal(result("missing").error.kind, "execution");
				return new Response(
					completed([
						fileCall(
							"list_files",
							{ path: root, offset: listOffset },
							"listing-rest",
						),
						fileCall(
							"search_files",
							{ path: root, query: "match", offset: searchOffset },
							"search-rest",
						),
						fileCall(
							"read_file",
							{ path: linesPath, startLine: 2001 },
							"lines-rest",
						),
						fileCall(
							"read_file",
							{ path: textPath, startLine: 2, endLine: 2 },
							"read-again",
						),
					]),
				);
			}
			assert.equal(result("listing-rest").truncated, false);
			assert.equal(result("listing-rest").nextOffset, null);
			const allEntries = [
				...result("listing").entries,
				...result("listing-rest").entries,
			];
			assert.equal(allEntries.length, (await readdir(root)).length);
			assert.equal(
				new Set(allEntries.map((entry) => entry.path)).size,
				allEntries.length,
			);
			assert.equal(result("search-rest").matches.length, 5);
			assert.equal(result("search-rest").truncated, false);
			assert.equal(
				new Set(
					[
						...result("search-page").matches,
						...result("search-rest").matches,
					].map((match) => match.path),
				).size,
				105,
			);
			assert.equal(result("lines-rest").text, "short\n".repeat(5));
			assert.equal(result("read-again").text, "needle.* literal\n");
			return new Response(completed([message("files inspected")]));
		},
		[root, second],
	);
	try {
		const { agentId } = await (await f.ask()).json();
		assert.equal((await f.wait(agentId)).status, "succeeded");
		const saved = (await f.get(`/api/agents/${agentId}/tools`)).toolCalls;
		assert.equal(saved.length, 19);
		assert.equal(
			new Set(saved.map((call: { id: number }) => call.id)).size,
			19,
		);
		assert.deepEqual(
			saved.slice(0, 3).map((call: { name: string }) => call.name),
			["list_files", "list_files", "search_files"],
		);
		assert.equal(requests, 3);
		await f.restart();
		assert.deepEqual(
			(await f.get(`/api/agents/${agentId}/tools`)).toolCalls,
			saved,
		);
	} finally {
		await f.close();
		await rm(base, { recursive: true, force: true });
	}
});

test("read_file byte continuation preserves a long Unicode line exactly", async () => {
	const root = await mkdtemp(join(tmpdir(), "file-tools-bytes-"));
	const path = join(root, "long.txt"),
		text = `${"😀中文".repeat(9000)}\nend\n`;
	await writeFile(path, text);
	let requests = 0,
		collected = "";
	const f = await fixture(
		async (_url, init) => {
			requests++;
			if (requests === 1)
				return new Response(
					completed([fileCall("read_file", { path }, "first")]),
				);
			const result = JSON.parse(
				JSON.parse(String(init?.body)).input.at(-1).output,
			);
			assert(Buffer.byteLength(result.text) <= 50 * 1024);
			assert(!result.text.includes("�"));
			collected += result.text;
			if (result.truncated) {
				assert(result.nextLine >= 1 && result.nextColumn >= 1);
				return new Response(
					completed([
						fileCall(
							"read_file",
							{
								path,
								startLine: result.nextLine,
								startColumn: result.nextColumn,
							},
							`page-${requests}`,
						),
					]),
				);
			}
			assert.equal(collected, text);
			return new Response(completed([message("read completely")]));
		},
		[root],
	);
	try {
		const { agentId } = await (await f.ask()).json();
		assert.equal((await f.wait(agentId)).status, "succeeded");
		assert.equal(requests, 3);
	} finally {
		await f.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("file tools validate continuation arguments and expose Unicode-safe search locations beyond the excerpt boundary", async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "file-tools-arguments-")),
	);
	const path = join(root, "astral.txt");
	await writeFile(path, `${"😀".repeat(5000)}needle${"😀".repeat(5000)}\n`);
	const invalid = [
		fileCall("list_files", { path: root, offset: -1 }, "negative"),
		fileCall("list_files", { path: root, offset: 1.5 }, "fraction"),
		fileCall("list_files", { path: root, pattern: [] }, "pattern"),
		fileCall("search_files", { path: root, query: "" }, "empty"),
		fileCall("read_file", { path, startLine: 0 }, "zero"),
		fileCall("read_file", { path, startLine: 2, endLine: 1 }, "reversed"),
		fileCall("read_file", { path, startColumn: 10009 }, "column"),
		fileCall("read_file", { path: [path] }, "array"),
	];
	let requests = 0;
	const f = await fixture(
		async (_url, init) => {
			requests++;
			if (requests === 1)
				return new Response(
					completed([
						fileCall(
							"search_files",
							{ path: root, query: "needle" },
							"long-match",
						),
						...invalid,
					]),
				);
			const outputs = JSON.parse(String(init?.body)).input.filter(
				(item: { type: string }) => item.type === "function_call_output",
			);
			assert.deepEqual(
				outputs.map((item: { call_id: string }) => item.call_id),
				["long-match", ...invalid.map((item) => item.call_id)],
			);
			const result = JSON.parse(outputs[0].output);
			assert.equal(result.matches.length, 1);
			const match = result.matches[0];
			assert.equal(match.path, path);
			assert.equal(match.line, 1);
			assert.equal(match.column, 5001);
			assert.equal(match.textTruncated, true);
			assert.equal(Array.from(match.text).length, 4096);
			assert(!match.text.includes("�"));
			assert(match.text.includes("needle"));
			assert.equal(
				Array.from(match.text)
					.slice(
						match.column - match.textStartColumn,
						match.column - match.textStartColumn + 6,
					)
					.join(""),
				"needle",
			);
			for (const item of outputs.slice(1))
				assert.equal(JSON.parse(item.output).error.kind, "validation");
			return new Response(completed([message("validated")]));
		},
		[root],
	);
	try {
		const { agentId } = await (await f.ask()).json();
		assert.equal((await f.wait(agentId)).status, "succeeded");
		assert.equal(requests, 2);
	} finally {
		await f.close();
		await rm(root, { recursive: true, force: true });
	}
});
