import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedBody } from "./model-fixture.ts";

type Tool = {
	name: string;
	description?: string;
	parameters: Record<string, unknown>;
};
type Request = {
	instructions?: string;
	tools: Tool[];
	input: {
		type?: string;
		output?: unknown;
		role?: string;
		content?: unknown;
	}[];
};
type Log = {
	event: string;
	pid: number;
	label: string;
	detail: { cursor?: string; name?: string; arguments?: unknown };
};
const answer = {
	type: "message",
	content: [{ type: "output_text", text: "MCP complete" }],
};
const args = (mode = "mixed") => ({ mode, payload: { values: [1, 2, 3] } });
const call = (tool: Tool, id: string, mode = "mixed") => ({
	type: "function_call",
	name: tool.name,
	call_id: id,
	arguments: JSON.stringify(args(mode)),
});

async function fixture(
	model: (request: Request) => Promise<unknown[]> | unknown[],
) {
	const directory = await mkdtemp(join(tmpdir(), "mcp-http-"));
	const path = join(directory, "db.sqlite");
	const logPath = join(directory, "service.jsonl");
	const server = createTestServer(
		async (_url, init) =>
			new Response(
				completedBody({
					status: "completed",
					output: await model(JSON.parse(String(init?.body))),
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
		path,
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const send = async (route: string, body: unknown, method = "POST") => {
		const response = await fetch(base + route, {
			method,
			body: JSON.stringify(body),
		});
		if (route === "/api/mcp-settings")
			assert.equal(response.headers.get("cache-control"), "no-store");
		assert(
			response.ok,
			`${route}: ${response.status} ${await response.clone().text()}`,
		);
		return response.json();
	};
	const project = await send("/api/projects", { name: "MCP", folders: [] });
	const chat = await send(`/api/projects/${project.id}/chats`, {
		name: "external tools",
	});
	const service = (id: string, name = id) => ({
		id,
		name,
		enabled: true,
		config: JSON.stringify({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./mcp-stdio-fixture.ts", import.meta.url)),
				logPath,
				name,
			],
			startup_timeout_sec: 5,
		}),
		env: [{ name: "WEFT_MCP_FIXTURE_VALUE", value: "controlled-value" }],
	});
	const logs = async (): Promise<Log[]> => {
		try {
			return (await readFile(logPath, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	};
	return {
		base,
		path,
		service,
		logs,
		send,
		settings: (services: ReturnType<typeof service>[]) =>
			send("/api/mcp-settings", { services }, "PUT"),
		start: async () =>
			(await send(`/api/chats/${chat.id}`, { prompt: "use MCP" }))
				.agentId as number,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

async function eventually(check: () => Promise<boolean>) {
	for (let i = 0; i < 300; i++) {
		if (await check()) return;
		await setTimeout(10);
	}
	assert.fail("External MCP lifecycle condition was not reached");
}
const mcpTool = (request: Request, label: string) => {
	const tool = request.tools.find((item) =>
		item.description?.includes(`${label}: controlled MCP tool`),
	);
	assert(tool, `Missing discovered tool for ${label}`);
	return tool;
};

test("real stdio discovery paginates, maps collisions, preserves schemas and ordered MCP results", async () => {
	const requests: Request[] = [];
	const f = await fixture((request) => {
		requests.push(request);
		const first = mcpTool(request, "first");
		const second = mcpTool(request, "second");
		assert.notEqual(first.name, "read_file");
		assert.notEqual(first.name, second.name);
		assert.equal(
			request.tools.filter((tool) => tool.description?.includes("second page"))
				.length,
			2,
		);
		assert.deepEqual(first.parameters, {
			type: "object",
			properties: {
				mode: { type: "string", enum: ["mixed", "error", "protocol", "wait"] },
				payload: {
					type: "object",
					properties: { values: { type: "array", items: { type: "integer" } } },
					required: ["values"],
					additionalProperties: false,
				},
			},
			required: ["mode", "payload"],
			additionalProperties: false,
		});
		if (requests.length === 1)
			return [
				call(first, "mixed"),
				call(second, "error", "error"),
				call(first, "protocol", "protocol"),
			];
		assert.deepEqual(request.tools, requests[0].tools);
		return [answer];
	});
	try {
		await f.settings([
			f.service("service-a", "first"),
			f.service("service-b", "second"),
		]);
		const agent = await waitForAgent(f.base, await f.start());
		assert.equal(agent.status, "succeeded");
		assert.equal(requests.length, 2);
		const db = new DatabaseSync(f.path);
		const records = db
			.prepare("SELECT call_id,result,status FROM tool_calls ORDER BY id")
			.all();
		db.close();
		assert.equal(records.length, 3);
		const mixed = JSON.parse(String(records[0].result));
		assert.equal(records[0].status, "succeeded");
		assert.deepEqual(
			mixed.map((part: { type: string }) => part.type),
			[
				"input_text",
				"input_text",
				"input_image",
				"input_text",
				"input_text",
				"input_text",
			],
		);
		assert.deepEqual(JSON.parse(mixed[0].text).mcpContent, {
			type: "text",
			text: "first: first",
		});
		assert.deepEqual(JSON.parse(mixed[3].text).mcpContent, {
			type: "text",
			text: "first: last",
		});
		assert.match(mixed[2].image_url, /^data:image\/png;base64,/);
		assert.equal(
			JSON.parse(mixed[4].text).mcpContent.uri,
			"https://example.invalid/unread",
		);
		assert.match(JSON.parse(mixed[4].text).notice, /not been read/i);
		assert.deepEqual(JSON.parse(mixed[5].text).mcpResult, {
			structuredContent: {
				payload: args().payload,
				label: "first",
				inherited: "[REDACTED]",
			},
			isError: false,
		});
		assert.equal(
			JSON.parse(JSON.parse(String(records[1].result)).at(-1).text).mcpResult
				.isError,
			true,
		);
		assert.equal(records[1].status, "failed");
		assert.match(String(records[2].result), /controlled protocol failure/);
		assert.equal(records[2].status, "failed");
		assert.match(JSON.stringify(requests[1].input), /first: first/);
		assert.match(JSON.stringify(requests[1].input), /input_image/);
		const logs = await f.logs();
		assert.equal(logs.filter((entry) => entry.event === "start").length, 2);
		assert.equal(
			logs.filter((entry) => entry.event === "tools/call").length,
			3,
		);
		assert.equal(
			logs.filter((entry) => entry.event === "tools/list").length,
			4,
		);
		assert.deepEqual(
			logs.find((entry) => entry.event === "tools/call")?.detail.arguments,
			args(),
		);
		await eventually(
			async () =>
				(await f.logs()).filter((entry) =>
					["stop", "end"].includes(entry.event),
				).length === 2,
		);
	} finally {
		await f.close();
	}
});

for (const change of ["disable", "delete"] as const) {
	test(`configuration edits apply next Agent while ${change} blocks later calls and lets inflight results finish`, async () => {
		let requests = 0;
		let started!: () => void;
		const startedPromise = new Promise<void>((resolve) => {
			started = resolve;
		});
		let f!: Awaited<ReturnType<typeof fixture>>;
		f = await fixture(async (request) => {
			requests++;
			if (requests === 1) {
				started();
				return [
					call(mcpTool(request, "old"), "inflight", "wait"),
					call(mcpTool(request, "old"), "blocked"),
				];
			}
			if (requests === 2) return [answer];
			assert(mcpTool(request, "new"));
			return [answer];
		});
		try {
			const initial = f.service("stable", "old");
			await f.settings([initial]);
			const id = await f.start();
			await startedPromise;
			await eventually(async () =>
				(await f.logs()).some((entry) => entry.event === "tools/call"),
			);
			await f.settings(
				change === "disable" ? [{ ...initial, enabled: false }] : [],
			);
			const agent = await waitForAgent(f.base, id);
			assert.equal(agent.status, "succeeded");
			const db = new DatabaseSync(f.path);
			const records = db
				.prepare(
					"SELECT t.result,t.status FROM tool_calls t JOIN model_calls m ON m.id=t.model_call_id WHERE m.agent_id=? ORDER BY t.id",
				)
				.all(id);
			db.close();
			assert.match(String(records[0].result), /old: first/);
			assert.match(String(records[1].result), /disabled|unavailable|removed/i);
			assert.equal(
				(await f.logs()).filter((entry) => entry.event === "tools/call").length,
				1,
			);
			await f.settings([f.service("stable", "new")]);
			assert.equal(
				(await waitForAgent(f.base, await f.start())).status,
				"succeeded",
			);
			assert.deepEqual(
				(await f.logs())
					.filter((entry) => entry.event === "start")
					.map((entry) => entry.label),
				["old", "new"],
			);
		} finally {
			await f.close();
		}
	});
}

test("Agent cancellation releases its MCP child process", async () => {
	const f = await fixture((request) => [
		call(mcpTool(request, "cancel"), "waiting", "wait"),
	]);
	try {
		await f.settings([f.service("cancel")]);
		const id = await f.start();
		await eventually(async () =>
			(await f.logs()).some((entry) => entry.event === "tools/call"),
		);
		await f.send(`/api/agents/${id}/cancel`, {});
		assert.equal((await waitForAgent(f.base, id)).status, "cancelled");
		await eventually(async () =>
			(await f.logs()).some((entry) => ["stop", "end"].includes(entry.event)),
		);
	} finally {
		await f.close();
	}
});

test("Root and Sub-agent each discover and own a separate stdio process", async () => {
	let rootRequests = 0;
	let childRequests = 0;
	const f = await fixture((request) => {
		const child = request.input.some(
			(part) =>
				part.role === "user" &&
				JSON.stringify(part.content).includes("MCP child question"),
		);
		const tool = mcpTool(request, "independent");
		if (child) {
			childRequests++;
			return childRequests === 1 ? [call(tool, "child-call")] : [answer];
		}
		rootRequests++;
		return rootRequests === 1
			? [
					call(tool, "root-call"),
					{
						type: "function_call",
						name: "create_sub_agent",
						call_id: "create-child",
						arguments: JSON.stringify({ prompt: "MCP child question" }),
					},
				]
			: [answer];
	});
	try {
		await f.settings([f.service("independent")]);
		assert.equal(
			(await waitForAgent(f.base, await f.start())).status,
			"succeeded",
		);
		const db = new DatabaseSync(f.path);
		const child = db
			.prepare(
				"SELECT id FROM agents WHERE created_by_tool_call_id IS NOT NULL",
			)
			.get();
		db.close();
		assert(child);
		assert.equal(
			(await waitForAgent(f.base, Number(child.id))).status,
			"succeeded",
		);
		assert(rootRequests >= 2);
		assert.equal(childRequests, 2);
		const entries = await f.logs();
		const starts = entries.filter((entry) => entry.event === "start");
		assert.equal(starts.length, 2);
		assert.notEqual(starts[0].pid, starts[1].pid);
		assert.equal(
			new Set(
				entries
					.filter((entry) => entry.event === "tools/call")
					.map((entry) => entry.pid),
			).size,
			2,
		);
		await eventually(
			async () =>
				(await f.logs()).filter((entry) =>
					["stop", "end"].includes(entry.event),
				).length === 2,
		);
	} finally {
		await f.close();
	}
});

test("one connection failure does not stop other services or the Agent", async () => {
	const f = await fixture((request) => {
		assert(mcpTool(request, "healthy"));
		assert.equal(
			request.tools.some((tool) => tool.description?.includes("broken:")),
			false,
		);
		return [answer];
	});
	try {
		const broken = f.service("broken");
		broken.config = JSON.stringify({
			command: join(tmpdir(), "weft-nonexistent-mcp-executable"),
			startup_timeout_sec: 1,
		});
		await f.settings([broken, f.service("healthy")]);
		const id = await f.start();
		const agent = await waitForAgent(f.base, id);
		assert.equal(agent.status, "succeeded");
		const db = new DatabaseSync(f.path);
		const connections = JSON.parse(
			String(
				db.prepare("SELECT mcp_connections FROM agents WHERE id=?").get(id)
					?.mcp_connections,
			),
		);
		db.close();
		assert.equal(
			connections.find((row: { id: string }) => row.id === "broken").status,
			"error",
		);
		assert.match(
			connections.find((row: { id: string }) => row.id === "broken").error,
			/ENOENT|spawn/,
		);
		assert.equal(
			(await f.logs()).filter((entry) => entry.event === "start").length,
			1,
		);
	} finally {
		await f.close();
	}
});

test("saving an enabled service edit preserves the active Agent connection and takes effect on the next Agent", async () => {
	let requests = 0;
	const f = await fixture((request) => {
		requests++;
		if (requests === 1)
			return [
				call(mcpTool(request, "before"), "hold", "wait"),
				call(mcpTool(request, "before"), "same-connection"),
			];
		assert(mcpTool(request, requests === 2 ? "before" : "after"));
		return [answer];
	});
	try {
		await f.settings([f.service("edited", "before")]);
		const first = await f.start();
		await eventually(async () =>
			(await f.logs()).some((entry) => entry.event === "tools/call"),
		);
		await f.settings([f.service("edited", "after")]);
		assert.equal((await waitForAgent(f.base, first)).status, "succeeded");
		const before = await f.logs();
		assert.equal(before.filter((entry) => entry.event === "start").length, 1);
		assert.equal(
			before.filter((entry) => entry.event === "tools/call").length,
			2,
		);
		assert.equal(new Set(before.map((entry) => entry.pid)).size, 1);
		assert.equal(
			(await waitForAgent(f.base, await f.start())).status,
			"succeeded",
		);
		assert.deepEqual(
			(await f.logs())
				.filter((entry) => entry.event === "start")
				.map((entry) => entry.label),
			["before", "after"],
		);
	} finally {
		await f.close();
	}
});

test("MCP JSON placeholders expand once after parsing and preserve stored credentials and template", async () => {
	const secret = 'quoted "credential"\nsecond line';
	const label = 'fragment-<OTHER>-"line\nnext';
	let requests = 0;
	const f = await fixture((request) => {
		requests++;
		const tool = mcpTool(request, label);
		if (requests === 1) return [call(tool, "substituted")];
		const output = request.input.find(
			(part) => part.type === "function_call_output",
		)?.output;
		assert(Array.isArray(output));
		assert.equal(
			JSON.parse(output.at(-1).text).mcpResult.structuredContent.inherited,
			secret,
		);
		return [answer];
	});
	try {
		const service = f.service("substitution");
		const config = JSON.parse(service.config);
		config.args[2] = 'fragment-<LABEL>-"line\nnext';
		service.config = JSON.stringify(config);
		service.env = [
			{ name: "LABEL", value: "<OTHER>" },
			{ name: "OTHER", value: "must-not-expand" },
			{ name: "WEFT_MCP_FIXTURE_VALUE", value: secret },
		];
		await f.settings([service]);
		const saved = await (await fetch(`${f.base}/api/mcp-settings`)).json();
		assert.deepEqual(saved.services, [service]);
		assert.equal(
			(await waitForAgent(f.base, await f.start())).status,
			"succeeded",
		);
		const logs = await f.logs();
		assert.equal(logs.find((entry) => entry.event === "start")?.label, label);
		const db = new DatabaseSync(f.path);
		const record = db.prepare("SELECT result FROM tool_calls").get();
		assert(!String(record?.result).includes(secret));
		assert.match(String(record?.result), /REDACTED/);
		assert.deepEqual(
			JSON.parse(
				String(
					db.prepare("SELECT mcp_services FROM settings").get()?.mcp_services,
				),
			),
			[service],
		);
		db.close();
		const invalid = await fetch(`${f.base}/api/mcp-settings`, {
			method: "PUT",
			body: JSON.stringify({
				services: [
					{ ...service, config: '{"command":"node","extra":"ignored?"}' },
				],
			}),
		});
		assert.equal(invalid.status, 400);
		assert.deepEqual(
			(await (await fetch(`${f.base}/api/mcp-settings`)).json()).services,
			[service],
		);
	} finally {
		await f.close();
	}
});

for (const value of [undefined, ""]) {
	test(`missing ${value === undefined ? "absent" : "empty"} placeholder stops only that service before spawning`, async () => {
		const f = await fixture((request) => {
			assert(mcpTool(request, "healthy"));
			assert.equal(
				request.tools.some((tool) => tool.description?.includes("bad:")),
				false,
			);
			return [answer];
		});
		try {
			const bad = f.service("bad");
			const config = JSON.parse(bad.config);
			config.args[2] = "<MISSING>";
			bad.config = JSON.stringify(config);
			bad.env = value === undefined ? [] : [{ name: "MISSING", value }];
			await f.settings([bad, f.service("healthy")]);
			const id = await f.start();
			assert.equal((await waitForAgent(f.base, id)).status, "succeeded");
			assert.deepEqual(
				(await f.logs())
					.filter((entry) => entry.event === "start")
					.map((entry) => entry.label),
				["healthy"],
			);
			const db = new DatabaseSync(f.path);
			const connections = JSON.parse(
				String(
					db.prepare("SELECT mcp_connections FROM agents WHERE id=?").get(id)
						?.mcp_connections,
				),
			);
			db.close();
			const failed = connections.find(
				(entry: { id: string }) => entry.id === "bad",
			);
			assert.equal(failed.status, "error");
			assert.match(failed.error, /MISSING/);
		} finally {
			await f.close();
		}
	});
}

test("credential redaction keeps JSON booleans, schemas and image bytes valid", async () => {
	let requests = 0;
	let expectedImage: unknown;
	const f = await fixture((request) => {
		requests++;
		const tool = mcpTool(request, "redaction");
		if (requests === 1) return [call(tool, "redacted-values")];
		const output = request.input.find(
			(part) => part.type === "function_call_output",
		)?.output;
		assert(Array.isArray(output));
		expectedImage = output.find((part) => part.type === "input_image");
		assert(expectedImage);
		const metadata = JSON.parse(output.at(-1).text).mcpResult;
		assert.equal(metadata.isError, false);
		assert.equal(metadata.structuredContent.inherited, "false");
		return [answer];
	});
	try {
		const service = f.service("redaction");
		service.env = [
			{ name: "SHORT", value: "false" },
			{ name: "ESCAPED", value: 'quoted "value"\nline' },
			{ name: "PIXEL", value: "AA" },
			{ name: "WEFT_MCP_FIXTURE_VALUE", value: "false" },
		];
		await f.settings([service]);
		const id = await f.start();
		const agent = await waitForAgent(f.base, id);
		assert.equal(agent.status, "succeeded");
		const db = new DatabaseSync(f.path);
		const modelCalls = db
			.prepare(
				"SELECT request_body,response_body FROM model_calls WHERE agent_id=? ORDER BY id",
			)
			.all(id);
		assert.equal(modelCalls.length, 2);
		for (const modelCall of modelCalls) {
			const request = JSON.parse(String(modelCall.request_body));
			assert.equal(
				mcpTool(request, "redaction").parameters.additionalProperties,
				false,
			);
			assert.doesNotThrow(() => JSON.parse(String(modelCall.response_body)));
		}
		const finalResponse = JSON.parse(String(modelCalls[1].response_body));
		assert.equal(finalResponse.output[0].content[0].text, "MCP complete");
		const toolCall = db
			.prepare("SELECT result FROM tool_calls WHERE call_id='redacted-values'")
			.get();
		db.close();
		const result = JSON.parse(String(toolCall?.result));
		assert.deepEqual(
			result.find((part: { type: string }) => part.type === "input_image"),
			expectedImage,
		);
		const metadata = JSON.parse(result.at(-1).text).mcpResult;
		assert.equal(metadata.isError, false);
		assert.equal(metadata.structuredContent.inherited, "[REDACTED]");
	} finally {
		await f.close();
	}
});

test("stderr preserves split UTF8 and withholds incomplete credentials from diagnostics", async () => {
	const secret = "stderr-credential-value";
	const prefix = secret.slice(0, Math.floor(secret.length / 2));
	let requests = 0;
	let f!: Awaited<ReturnType<typeof fixture>>;
	let id!: number;
	let acceptModel!: () => void;
	const accepted = new Promise<void>((resolve) => {
		acceptModel = resolve;
	});
	let releaseModel!: () => void;
	const released = new Promise<void>((resolve) => {
		releaseModel = resolve;
	});
	f = await fixture(async (request) => {
		requests++;
		assert(!String(request.instructions).includes(prefix));
		assert(!String(request.instructions).includes(secret));
		if (requests === 1) {
			acceptModel();
			await released;
			return [call(mcpTool(request, "stderr"), "finish-stderr")];
		}
		assert.match(String(request.instructions), /界 stderr \[REDACTED\]/);
		return [answer];
	});
	const diagnostics = async () => {
		const body = await (await fetch(`${f.base}/api/agents/${id}`)).json();
		return body.agents[0].mcpConnections as { id: string; stderr?: string }[];
	};
	try {
		const service = f.service("stderr");
		service.env.push({ name: "WEFT_MCP_STDERR_TEST_SECRET", value: secret });
		await f.settings([service]);
		id = await f.start();
		await accepted;
		await eventually(
			async () => (await diagnostics())[0]?.stderr?.includes("界") ?? false,
		);
		assert.equal((await diagnostics())[0].stderr, "界 stderr ");
		releaseModel();
		assert.equal((await waitForAgent(f.base, id)).status, "succeeded");
		assert.equal(requests, 2);
		assert.equal((await diagnostics())[0].stderr, "界 stderr [REDACTED]\n");
		const db = new DatabaseSync(f.path);
		const saved = db
			.prepare("SELECT mcp_connections FROM agents WHERE id=?")
			.get(id);
		assert.equal(
			JSON.parse(String(saved?.mcp_connections))[0].stderr,
			"界 stderr [REDACTED]\n",
		);
		for (const record of db
			.prepare("SELECT request_body FROM model_calls WHERE agent_id=?")
			.all(id)) {
			assert(!String(record.request_body).includes(prefix));
			assert(!String(record.request_body).includes("�"));
		}
		db.close();
	} finally {
		releaseModel();
		await f.close();
	}
});
