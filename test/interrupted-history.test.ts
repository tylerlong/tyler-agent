import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { imageFromBytes } from "../src/image-content.ts";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse, frame } from "./model-fixture.ts";

const message = (text: string) => ({
	type: "message",
	content: [{ type: "output_text", text }],
});
const tool = (name: string, args: unknown) => ({
	type: "function_call",
	name,
	arguments: JSON.stringify(args),
	call_id: name,
});
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYioAAAAASUVORK5CYII=",
	"base64",
);
async function fixture(model: typeof globalThis.fetch) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "interrupted-history-")),
	);
	const server = createTestServer(model, join(directory, "db.sqlite")).listen(
		0,
		"127.0.0.1",
	);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const post = (route: string, body: unknown = {}) =>
		fetch(base + route, { method: "POST", body: JSON.stringify(body) });
	const get = (route: string) => fetch(base + route).then((r) => r.json());
	const project = await (
		await post("/api/projects", { name: "P", folders: [directory] })
	).json();
	const chat = await (
		await post(`/api/projects/${project.id}/chats`, { name: "C" })
	).json();
	return {
		directory,
		base,
		post,
		get,
		chat,
		project,
		ask: async (prompt: string, images?: unknown[]) => {
			const response = await post(`/api/chats/${chat.id}`, { prompt, images });
			assert.equal(response.status, 202, await response.clone().text());
			return (await response.json()).agentId as number;
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}
const facts = (input: { role?: string; content?: unknown }[]) => {
	const record = input.find(
		(part) =>
			typeof part.content === "string" &&
			part.content.startsWith("[Historical interrupted task records:"),
	);
	assert(record && typeof record.content === "string");
	return JSON.parse(record.content.slice(record.content.indexOf("] ") + 2));
};

test("Stop preserves edits, native user images, bounded Tool Results, final process state and provisional output in subsequent Roots without replay", {
	skip: process.platform !== "darwin",
	timeout: 30000,
}, async () => {
	const requests: {
		input: {
			role?: string;
			type?: string;
			content?: unknown;
			output?: string;
		}[];
	}[] = [];
	let root = "",
		logId = 0;
	const f = await fixture(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		requests.push(body);
		switch (requests.length) {
			case 1:
				return completedResponse({
					output: [
						tool("apply_patch", {
							patch:
								"*** Begin Patch\n*** Add File: result.txt\n+confirmed edit\n*** End Patch",
							cwd: root,
						}),
					],
				});
			case 2:
				return completedResponse({
					output: [tool("read_image", { path: join(root, "tool.png") })],
				});
			case 3:
				return completedResponse({
					output: [
						tool("exec_command", {
							cmd: "printf historical-log; sleep 60",
							workdir: root,
							yield_time_ms: 100,
							max_output_tokens: 1,
						}),
					],
				});
			case 4: {
				logId = JSON.parse(body.input.at(-1).output).tool_call_id;
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									frame("response.output_text.delta", {
										item_id: "partial",
										output_index: 0,
										content_index: 0,
										delta: "unfinished thought",
									}) +
										frame("response.function_call_arguments.delta", {
											output_index: 1,
											delta: '{"patch":"incomplete',
										}),
								),
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			case 5:
				return completedResponse({
					output: [
						tool("read_tool_output", {
							tool_call_id: logId,
							offset: 4,
							limit: 6,
						}),
					],
				});
			case 6: {
				assert.deepEqual(
					JSON.parse(body.input.at(-1).output).chunks.map(
						(part: { text: string }) => part.text,
					),
					["orical"],
				);
				return completedResponse({ output: [message("followup complete")] });
			}
			default:
				return completedResponse({ output: [message("later complete")] });
		}
	});
	root = f.directory;
	const userImage = imageFromBytes(
		Buffer.concat([png, Buffer.from("user-image")]),
	);
	const toolImage = imageFromBytes(png);
	try {
		await writeFile(join(root, "tool.png"), png);
		const interrupted = await f.ask("original unfinished requirement", [
			userImage,
		]);
		// Observe persisted provisional output, not a timing assumption about the stream.
		const deadline = AbortSignal.timeout(15000);
		for (;;) {
			deadline.throwIfAborted();
			const state = await f.get(`/api/agents/${interrupted}`);
			if (JSON.stringify(state).includes("unfinished though") && logId) {
				const saved = await f.get(
					`/api/agents/${interrupted}/tools?toolId=${logId}`,
				);
				if (
					saved.toolCalls[0].output
						.map((chunk: { text: string }) => chunk.text)
						.join("")
						.includes("historical-log")
				)
					break;
			}
			await new Promise((resolve) => setImmediate(resolve));
		}
		assert.equal(
			(await f.post(`/api/agents/${interrupted}/cancel`)).status,
			200,
		);
		assert.equal((await waitForAgent(f.base, interrupted)).status, "cancelled");
		assert.equal(
			await readFile(join(root, "result.txt"), "utf8"),
			"confirmed edit\n",
		);
		const next = await f.ask("new requirement");
		assert.equal((await waitForAgent(f.base, next)).status, "succeeded");
		const later = await f.ask("later requirement");
		assert.equal((await waitForAgent(f.base, later)).status, "succeeded");
		assert.equal(requests.length, 7);
		for (const request of [requests[4], requests[6]]) {
			assert.deepEqual(request.input[0], {
				role: "user",
				content: [
					{ type: "input_text", text: "original unfinished requirement" },
					userImage,
				],
			});
			assert.equal(
				JSON.stringify(request).split("original unfinished requirement")
					.length - 1,
				1,
			);
			assert.equal(
				request.input.some(
					(item) =>
						item.type === "function_call" ||
						item.type === "function_call_output",
				),
				false,
			);
			const [record] = facts(request.input);
			assert.equal(record.status, "cancelled");
			assert.equal(record.error, "agentCancelled");
			const patch = record.tool_calls.find(
				(call: { name: string }) => call.name === "apply_patch",
			);
			assert.match(patch.arguments, /confirmed edit/);
			assert.equal(patch.status, "succeeded");
			assert(patch.result);
			const command = record.tool_calls.find(
				(call: { name: string }) => call.name === "exec_command",
			);
			assert.equal(JSON.parse(command.result).running, true);
			const returned = JSON.parse(command.result)
				.output.chunks.map((chunk: { text: string }) => chunk.text)
				.join("");
			assert(returned.length <= 4);
			assert.equal(returned, "historical-log".slice(0, returned.length));
			assert.equal(command.commandState.running, false);
			assert.equal(command.commandState.cancelled, true);
			const partial = record.model_calls.at(-1);
			assert.equal(partial.provisional, true);
			assert.match(JSON.stringify(partial.output), /unfinished thought/);
			assert.match(JSON.stringify(partial.output), /incomplete/);
			assert(!JSON.stringify(record).includes(toolImage.image_url));
			assert.match(JSON.stringify(record), /Historical tool image/);
			assert(!JSON.stringify(record).includes("request_body"));
		}
		const calls = (await f.get(`/api/agents/${next}/calls`)).calls;
		assert.deepEqual(JSON.parse(calls[0].requestBody).input, requests[4].input);
		// Historical images keep the existing model-capability rejection before a new paid call.
		const db = new DatabaseSync(join(f.directory, "db.sqlite"));
		db.prepare("UPDATE managed_models SET metadata=? WHERE id='test'").run(
			JSON.stringify({ reasoningRequired: false, inputModalities: ["text"] }),
		);
		db.close();
		const rejected = await f.post(`/api/chats/${f.chat.id}`, {
			prompt: "text only next",
		});
		assert.equal(rejected.status, 400);
		assert.equal((await rejected.json()).code, "modelImageUnsupported");
		assert.equal(requests.length, 7);
	} finally {
		await f.close();
	}
});

test("interrupted descendant work reaches later Roots before parent notification; log reads stay within Chat and own-Agent Sub-agent boundaries", {
	skip: process.platform !== "darwin",
	timeout: 30000,
}, async () => {
	let root = "",
		childRequests = 0,
		rootRequests = 0,
		readerRequests = 0,
		delegateRequests = 0,
		logId = 0;
	const captured: {
		input: { role?: string; content?: unknown; output?: string }[];
	}[] = [];
	const f = await fixture(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		const prompt = body.input
			.filter((part: { role?: string }) => part.role === "user")
			.at(-1)?.content;
		const firstPrompt = body.input.find(
			(part: { role?: string }) => part.role === "user",
		)?.content;
		if (firstPrompt === "child work") {
			if (++childRequests === 1)
				return completedResponse({
					output: [
						tool("exec_command", {
							cmd: "printf descendant-edit > child.txt; printf child-log",
							workdir: root,
							timeout_ms: 10000,
						}),
					],
				});
			logId = JSON.parse(body.input.at(-1).output).tool_call_id;
			return completedResponse({ output: [message("child completed edit")] });
		}
		if (firstPrompt === "reader child") {
			if (++readerRequests === 1)
				return completedResponse({
					output: [tool("read_tool_output", { tool_call_id: logId })],
				});
			assert.match(
				JSON.parse(body.input.at(-1).output).error,
				/only for this Agent/,
			);
			return completedResponse({
				output: [message("child denied sibling log")],
			});
		}
		if (firstPrompt === "foreign Chat") {
			if (
				!body.input.some(
					(part: { type?: string }) => part.type === "function_call_output",
				)
			)
				return completedResponse({
					output: [tool("read_tool_output", { tool_call_id: logId })],
				});
			assert.match(
				JSON.parse(body.input.at(-1).output).error,
				/only for this Agent/,
			);
			return completedResponse({ output: [message("foreign denied")] });
		}
		if (
			prompt === "resume work" ||
			body.input.some(
				(part: { name?: string }) => part.name === "read_tool_output",
			)
		) {
			captured.push(body);
			if (body.input.at(-1)?.type !== "function_call_output")
				return completedResponse({
					output: [tool("read_tool_output", { tool_call_id: logId })],
				});
			assert.deepEqual(
				JSON.parse(body.input.at(-1).output).chunks.map(
					(chunk: { text: string }) => chunk.text,
				),
				["child-log"],
			);
			return completedResponse({ output: [message("resumed")] });
		}
		if (
			body.input.some(
				(part: { content?: unknown }) => part.content === "delegate reader",
			)
		)
			return completedResponse({
				output:
					++delegateRequests === 1
						? [tool("create_sub_agent", { prompt: "reader child" })]
						: [message("reader done")],
			});
		if (++rootRequests === 1)
			return completedResponse({
				output: [tool("create_sub_agent", { prompt: "child work" })],
			});
		// The parent has already started another request; the child's terminal notification cannot enter it.
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							frame("response.output_text.delta", {
								output_index: 0,
								delta: "parent waiting",
							}),
						),
					);
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
	});
	root = f.directory;
	try {
		const interrupted = await f.ask("root unfinished");
		let childId = 0;
		const deadline = AbortSignal.timeout(15000);
		for (;;) {
			deadline.throwIfAborted();
			const tree = await f.get(`/api/agents/${interrupted}/tree`);
			const child = tree.agents.find(
				(agent: { parentAgentId?: number }) =>
					agent.parentAgentId === interrupted,
			);
			if (child?.status === "succeeded" && rootRequests > 1) {
				childId = child.id;
				break;
			}
			await new Promise((resolve) => setImmediate(resolve));
		}
		await f.post(`/api/agents/${interrupted}/cancel`);
		assert.equal((await waitForAgent(f.base, interrupted)).status, "cancelled");
		assert.equal(
			await readFile(join(root, "child.txt"), "utf8"),
			"descendant-edit",
		);
		const next = await f.ask("resume work");
		assert.equal((await waitForAgent(f.base, next)).status, "succeeded");
		const records = facts(captured[0].input);
		assert.deepEqual(
			records.map((record: { agent_id: number }) => record.agent_id),
			[interrupted, childId],
		);
		assert.equal(records[1].parent_agent_id, interrupted);
		assert.equal(records[1].status, "succeeded");
		assert.match(
			JSON.stringify(records[1]),
			/child completed edit|descendant-edit/,
		);
		const reader = await f.ask("delegate reader");
		// Let the parent return normally once its child reader has delivered a result.
		await waitForAgent(f.base, reader);
		const chat = await (
			await f.post(`/api/projects/${f.project.id}/chats`, { name: "foreign" })
		).json();
		const foreign = await (
			await f.post(`/api/chats/${chat.id}`, { prompt: "foreign Chat" })
		).json();
		assert.equal(
			(await waitForAgent(f.base, foreign.agentId)).status,
			"succeeded",
		);
		assert.equal(childRequests, 2);
		assert.equal(readerRequests, 2);
	} finally {
		await f.close();
	}
});

test("cancelled child tool images are omitted from nested cancellation results in interrupted history", {
	skip: process.platform !== "darwin",
	timeout: 30000,
}, async () => {
	let root = "",
		rootRequests = 0,
		childRequests = 0;
	let childReady!: () => void;
	const ready = new Promise<void>((resolve) => {
		childReady = resolve;
	});
	let nextInput: unknown;
	const f = await fixture(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		if (body.input[0].content === "image child") {
			if (++childRequests === 1)
				return completedResponse({
					output: [tool("read_image", { path: join(root, "image.png") })],
				});
			childReady();
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								frame("response.output_text.delta", {
									output_index: 0,
									delta: "child still working",
								}),
							),
						);
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		if (body.input.at(-1).content === "after failure") {
			nextInput = body.input;
			return completedResponse({ output: [message("continued")] });
		}
		if (++rootRequests === 1)
			return completedResponse({
				output: [tool("create_sub_agent", { prompt: "image child" })],
			});
		if (rootRequests === 2) {
			const childId = JSON.parse(body.input.at(-1).output).agent_id;
			await ready;
			return completedResponse({
				output: [tool("cancel_sub_agent", { agent_id: childId })],
			});
		}
		return new Response("parent failed after cancelling child", {
			status: 500,
		});
	});
	root = f.directory;
	try {
		await writeFile(join(root, "image.png"), png);
		const interrupted = await f.ask("work with child image");
		assert.equal((await waitForAgent(f.base, interrupted)).status, "failed");
		const next = await f.ask("after failure");
		assert.equal((await waitForAgent(f.base, next)).status, "succeeded");
		assert(!JSON.stringify(nextInput).includes(imageFromBytes(png).image_url));
		assert.match(JSON.stringify(nextInput), /Historical tool image/);
		assert.equal(rootRequests, 3);
		assert.equal(childRequests, 2);
	} finally {
		await f.close();
	}
});
