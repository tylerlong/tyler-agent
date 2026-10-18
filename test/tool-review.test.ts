import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CommandExecutor } from "../src/command-executor.ts";
import type { ToolReview } from "../src/file-tools.ts";
import { createServer } from "../src/server.ts";
import { waitForAgent } from "./agent-fixture.ts";
import { configureDatabase } from "./config-fixture.ts";
import { localFetch, managementTokens } from "./local-fetch.ts";
import { httpMcpFixture } from "./mcp-http-fixture.ts";
import { completedResponse } from "./model-fixture.ts";

type Operation = Parameters<ToolReview>[0];
type ModelRequest = {
	tools: { name: string; description?: string }[];
	input: {
		type?: string;
		output?: string;
		call_id?: string;
		content?: unknown;
	}[];
};
const call = (name: string, args: unknown, id = name) => ({
	type: "function_call",
	call_id: id,
	name,
	arguments: JSON.stringify(args),
});
const answer = {
	type: "message",
	content: [{ type: "output_text", text: "done" }],
};

async function fixture(
	model: (request: ModelRequest) => unknown[] | Promise<unknown[]>,
	beforeAllow?: () => Promise<void>,
) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "tool-review-")),
	);
	const path = join(directory, "db.sqlite");
	configureDatabase(path);
	const reviews: Operation[] = [];
	const server = createServer(
		async (url, init) => {
			const body = JSON.parse(String(init?.body));
			if (String(url).endsWith("/decisions")) {
				reviews.push(body.state);
				await beforeAllow?.();
				return Response.json({
					id: `review-${reviews.length}`,
					model: "typesafe/jev-controlled",
					answers: { safety: { type: "choice", choice: "allow" } },
				});
			}
			assert.equal(String(url), "https://openrouter.ai/api/v1/responses");
			return completedResponse({ output: await model(body) });
		},
		path,
		undefined,
		undefined,
		"a".repeat(64),
		directory,
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	managementTokens.set(base, server.managementToken);
	const send = async (route: string, body: unknown, method = "POST") => {
		const response = await localFetch(base + route, {
			method,
			body: JSON.stringify(body),
		});
		assert(
			response.ok,
			`${route}: ${response.status}: ${await response.clone().text()}`,
		);
		return response.json();
	};
	const project = await send("/api/projects", {
		name: "review",
		folders: [directory],
	});
	const chat = await send(`/api/projects/${project.id}/chats`, {
		name: "review",
	});
	return {
		directory,
		reviews,
		send,
		run: async () => {
			const { agentId } = await send(`/api/chats/${chat.id}`, {
				prompt: "controlled tools",
			});
			return waitForAgent(base, agentId);
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			managementTokens.delete(base);
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("built-in tool reviews contain the validated operation before execution, including stdin and polling", async (t) => {
	let round = 0;
	let commandId = 0;
	let owner = "";
	let root = "";
	const executed: string[] = [];
	const assertReviewed = (name: string) => {
		assert.equal(f.reviews.at(-1)?.name, name);
		executed.push(name);
	};
	t.mock.method(
		CommandExecutor.prototype,
		"read",
		async (options: Parameters<CommandExecutor["read"]>[0]) => {
			assertReviewed("read_file");
			assert.deepEqual(f.reviews.at(-1)?.arguments, {
				path: options.path,
				offset: options.offset,
				limit: options.limit,
			});
			return { text: "file contents", base64: "", next_offset: 13, eof: true };
		},
	);
	t.mock.method(CommandExecutor.prototype, "readImage", async () => {
		assertReviewed("read_image");
		return [];
	});
	t.mock.method(
		CommandExecutor.prototype,
		"execute",
		async (options: Parameters<CommandExecutor["execute"]>[0]) => {
			const name = options.patch ? "apply_patch" : "exec_command";
			assertReviewed(name);
			const args = f.reviews.at(-1)?.arguments as Record<string, unknown>;
			assert.equal(args.cwd, options.cwd);
			assert.equal(
				args[name === "apply_patch" ? "patch" : "command"],
				options.patch ?? options.command,
			);
			if (name === "apply_patch") return { exitCode: 0 };
			assert.equal(args.yield_time_ms, options.yieldTimeMs);
			owner = options.agentId;
			commandId = options.toolCallId ?? 0;
			options.onOutput("stdout", "saved log");
			return { exitCode: null, session_id: 7, running: true };
		},
	);
	const startup = () => ({
		command: "printf controlled",
		cwd: root,
		shell: "/bin/sh",
		login: false,
		tty: true,
	});
	t.mock.method(
		CommandExecutor.prototype,
		"sessionStartup",
		(session: number, agent: string) => {
			assert.equal(agent, owner);
			if (session !== 7)
				throw new Error("Session is available only to its owner");
			return startup();
		},
	);
	t.mock.method(
		CommandExecutor.prototype,
		"writeStdin",
		async (options: Parameters<CommandExecutor["writeStdin"]>[0]) => {
			assertReviewed("write_stdin");
			assert.deepEqual(f.reviews.at(-1)?.execution, { startup: startup() });
			assert.equal(
				(f.reviews.at(-1)?.arguments as { chars?: string } | undefined)
					?.chars ?? "",
				options.chars,
			);
			return {
				exitCode: null,
				session_id: 7,
				running: true,
				tool_call_id: commandId,
			};
		},
	);
	const patch =
		"*** Begin Patch\n*** Add File: reviewed.txt\n+complete patch contents\n*** End Patch";
	const f = await fixture(() => {
		switch (++round) {
			case 1:
				return [
					call("read_file", {
						path: join(root, "source.txt"),
						offset: 2,
						limit: 7,
					}),
				];
			case 2:
				return [call("read_image", { path: join(root, "image.png") })];
			case 3:
				return [call("apply_patch", { cwd: root, patch })];
			case 4:
				return [
					call("exec_command", {
						cmd: "printf controlled",
						workdir: root,
						tty: true,
						login: false,
						shell: "/bin/sh",
						yield_time_ms: 1,
					}),
				];
			case 5:
				return [
					call(
						"write_stdin",
						{ session_id: 7, chars: "full input\n", yield_time_ms: 0 },
						"stdin",
					),
				];
			case 6:
				return [call("write_stdin", { session_id: 7 }, "poll")];
			case 7:
				return [
					call("read_tool_output", {
						tool_call_id: commandId,
						offset: 1,
						limit: 4,
					}),
				];
			case 8:
				return [
					call("write_stdin", { session_id: 999 }, "wrong-owner"),
					call("read_tool_output", { tool_call_id: 999 }, "wrong-log"),
					call("read_file", { path: 42 }, "invalid-file"),
				];
			default:
				return [answer];
		}
	});
	root = f.directory;
	try {
		const agent = await f.run();
		assert.equal(agent.status, "succeeded");
		assert.deepEqual(
			f.reviews.map((op) => op.name),
			[
				"read_file",
				"read_image",
				"apply_patch",
				"exec_command",
				"write_stdin",
				"write_stdin",
				"read_tool_output",
			],
		);
		assert.deepEqual(executed, [
			"read_file",
			"read_image",
			"apply_patch",
			"exec_command",
			"write_stdin",
			"write_stdin",
		]);
		assert.deepEqual(f.reviews[2].arguments, {
			cwd: root,
			patch,
			timeout_ms: 30000,
		});
		assert.deepEqual(f.reviews[6].arguments, {
			tool_call_id: commandId,
			offset: 1,
			limit: 4,
		});
		for (const operation of f.reviews)
			assert(operation.description.length > operation.name.length);
	} finally {
		await f.close();
	}
});

test("create and cancel sub-agent tools review their full validated arguments", async () => {
	let rootRound = 0;
	let childId = 0;
	const createArgs = {
		prompt: "child controlled request",
		context: "full child context",
		model_id: "test",
		reasoning_effort: "low",
	};
	const f = await fixture((request) => {
		if (
			JSON.stringify(request.input).includes("child controlled request") &&
			!request.input.some((item) => item.type === "function_call_output")
		)
			return [answer];
		if (++rootRound === 1) return [call("create_sub_agent", createArgs)];
		if (rootRound === 2) {
			const output = request.input.find(
				(item) => item.type === "function_call_output",
			);
			assert(output?.output);
			childId = JSON.parse(output.output).agent_id;
			return [call("cancel_sub_agent", { agent_id: childId })];
		}
		return [answer];
	});
	try {
		await f.run();
		assert.deepEqual(
			f.reviews.map(({ name, arguments: args }) => ({ name, args })),
			[
				{ name: "create_sub_agent", args: createArgs },
				{ name: "cancel_sub_agent", args: { agent_id: childId } },
			],
		);
	} finally {
		await f.close();
	}
});

for (const transport of ["stdio", "http"] as const) {
	test(`${transport} MCP reviews original tool and service names and complete arguments before the actual call`, async () => {
		const peer = transport === "http" ? await httpMcpFixture() : undefined;
		let round = 0;
		const args = {
			mode: "mixed",
			payload: { values: [1, 2, 3] },
		};
		const f = await fixture(
			(request) => {
				if (++round > 1) return [answer];
				const tool = request.tools.find(
					(tool) =>
						tool.description?.includes("controlled MCP tool") ||
						tool.description?.includes("controlled HTTP tool"),
				);
				assert(tool);
				assert.notEqual(tool.name, "read_file");
				return [call(tool.name, args)];
			},
			async () => {
				if (peer)
					assert.equal(
						peer.requests.filter((request) => request.method === "tools/call")
							.length,
						0,
					);
				else
					assert.equal(
						(await readFile(log, "utf8")).includes('"event":"tools/call"'),
						false,
					);
			},
		);
		const log = join(f.directory, "stdio.jsonl");
		try {
			await f.send(
				"/api/mcp-settings",
				{
					services: [
						{
							id: transport,
							name: `real ${transport} service`,
							enabled: true,
							config: JSON.stringify(
								peer
									? { url: peer.url }
									: {
											command: process.execPath,
											args: [
												fileURLToPath(
													new URL("./mcp-stdio-fixture.ts", import.meta.url),
												),
												log,
												"stdio",
											],
										},
							),
							env: [],
						},
					],
				},
				"PUT",
			);
			const agent = await f.run();
			assert.equal(agent.status, "succeeded");
			assert.equal(
				f.reviews.length,
				1,
				"MCP initialization/discovery/cleanup are not reviewed tool calls",
			);
			assert.equal(f.reviews[0].name, "read_file");
			assert.deepEqual(f.reviews[0].arguments, args);
			assert.deepEqual(f.reviews[0].execution, {
				service: `real ${transport} service`,
			});
			assert.match(
				f.reviews[0].description,
				new RegExp(`real ${transport} service`),
			);
			const requests =
				peer?.requests ??
				(await readFile(log, "utf8"))
					.trim()
					.split("\n")
					.map((line) => {
						const value = JSON.parse(line);
						return { method: value.event, params: value.detail };
					});
			const calls = requests.filter(
				(request) => request.method === "tools/call",
			);
			assert.equal(calls.length, 1);
			assert.deepEqual(calls[0].params, { name: "read_file", arguments: args });
		} finally {
			await f.close();
			await peer?.close();
		}
	});
}
