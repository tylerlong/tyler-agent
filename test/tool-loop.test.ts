import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTestServer } from "./config-fixture.ts";
import { completedBody, frame } from "./model-fixture.ts";
import { waitForIdle, waitForTurn } from "./turn-fixture.ts";

const message = (text: string) => ({
	id: "answer",
	type: "message",
	content: [{ type: "output_text", text }],
});
const tool = (path: string, call_id = "count-1") => ({
	id: call_id,
	type: "function_call",
	name: "count_files",
	arguments: JSON.stringify({ path }),
	call_id,
});
const completed = (output: unknown[]) =>
	completedBody({ status: "completed", output });
async function fixture(fake: typeof fetch, roots: string[]) {
	const directory = await mkdtemp(join(tmpdir(), "tool-db-"));
	const databasePath = join(directory, "db.sqlite");
	let server = createTestServer(
		fake,
		databasePath,
		"tool-secret",
		"tool-model",
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	let base = `http://127.0.0.1:${address.port}`;
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
			).listen(0, "127.0.0.1");
			await new Promise<void>((r) => server.once("listening", r));
			const address = server.address();
			assert(address && typeof address !== "string");
			base = `http://127.0.0.1:${address.port}`;
		},
		get,
		wait: (id: number) => waitForTurn(base, id),
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

test("Turn counts a real tree and continues with complete protocol context while retaining earlier output", async () => {
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
			assert.equal(JSON.parse(result.output).count, 109);
			return new Response(completed([message("109 files")]));
		},
		[root],
	);
	try {
		const accepted = await f.ask();
		assert.equal(accepted.status, 202);
		assert.equal(
			(await f.wait((await accepted.json()).turnId)).status,
			"succeeded",
		);
		const history = await f.get(`/api/chats/${f.chat.id}`);
		assert.equal(history.turns[0].status, "succeeded");
		assert.equal(history.turns[0].answer, "Counting\n109 files");
		const calls = (await f.get(`/api/turns/${history.turns[0].id}/calls`))
			.calls;
		assert.equal(calls.length, 2);
		assert(calls.every((c: { status: string }) => c.status === "succeeded"));
		for (const request of requests) {
			assert.equal(request.tools[0].name, "count_files");
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
							JSON.parse(r.output).count,
					),
				[0, 1, 0],
			);
			return new Response(completed([message("corrected")]));
		},
		[join(base, "configured-link"), second],
	);
	try {
		const accepted = await f.ask();
		assert.equal(accepted.status, 202);
		assert.equal(
			(await f.wait((await accepted.json()).turnId)).status,
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
			(await f.wait((await accepted.json()).turnId)).status,
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
			const turn = await f.wait((await response.json()).turnId);
			if (!finalAnswer) assert.equal(turn.errorCode, "modelCallLimit");
			assert.equal(turn.status, finalAnswer ? "succeeded" : "failed");
			assert.match(
				turn.answer,
				finalAnswer ? /finished at five/ : /step 1[\s\S]*step 5/,
			);
			assert.equal(
				(await f.get(`/api/turns/${turn.id}/calls`)).calls.length,
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
			name: "count_files",
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
				(await f.wait((await accepted.json()).turnId)).status,
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
				(await f.wait((await accepted.json()).turnId)).status,
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
			(await f.wait((await accepted.json()).turnId)).status,
			"failed",
		);
		assert.equal(requests, 2);
		const turn = (await f.get(`/api/chats/${f.chat.id}`)).turns[0];
		assert.equal(turn.status, "failed");
		assert.equal(turn.answer, "first\npartial second");
		const calls = (await f.get(`/api/turns/${turn.id}/calls`)).calls;
		assert.deepEqual(
			calls.map((c: { status: string }) => c.status),
			["succeeded", "failed"],
		);
	} finally {
		await f.close();
	}
});

test("an accepted Turn keeps its target scope and selected credentials while settings change", async () => {
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
			assert.match(body.instructions, new RegExp(root));
			assert.doesNotMatch(body.instructions, new RegExp(later));
			assert.equal(
				new Headers(init?.headers).get("authorization"),
				"Bearer tool-secret",
			);
			assert.equal(body.model, "tool-model");
			if (requests === 1) {
				entered();
				await gate;
				return new Response(completed([tool(root)]));
			}
			assert.equal(JSON.parse(body.input.at(-1).output).count, 1);
			return new Response(completed([message("captured")]));
		},
		[root],
	);
	try {
		const accepted = await f.ask();
		assert.equal(accepted.status, 202);
		const { turnId } = await accepted.json();
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
		assert.equal((await f.wait(turnId)).status, "succeeded");
		assert.equal(requests, 2);
	} finally {
		release();
		await f.close();
		await rm(base, { recursive: true, force: true });
	}
});

test("failed file-count execution returns actual status and bounded diagnostics, never a partial count", async () => {
	const base = await mkdtemp(join(tmpdir(), "tool-command-"));
	const bin = join(base, "bin");
	await mkdir(bin);
	await writeFile(
		join(bin, "find"),
		"#!/bin/sh\nprintf xx\n/usr/bin/printf '%5000s' broken >&2\nexit 7\n",
		{ mode: 0o755 },
	);
	const originalPath = process.env.PATH;
	let requests = 0;
	const f = await fixture(
		async (_url, init) => {
			requests++;
			if (requests === 1) return new Response(completed([tool(base)]));
			const result = JSON.parse(
				JSON.parse(String(init?.body)).input.at(-1).output,
			);
			assert.equal(result.error.kind, "execution");
			assert.equal(result.error.exitStatus, 7);
			assert.equal(result.error.stdout, "xx");
			assert.equal(result.error.stderr.length, 4096);
			assert.equal(result.error.truncated, true);
			assert(!("count" in result));
			return new Response(completed([message("count failed")]));
		},
		[base],
	);
	try {
		process.env.PATH = bin;
		const accepted = await f.ask();
		assert.equal(accepted.status, 202);
		assert.equal(
			(await f.wait((await accepted.json()).turnId)).status,
			"succeeded",
		);
		assert.equal(requests, 2);
	} finally {
		process.env.PATH = originalPath;
		await f.close();
		await rm(base, { recursive: true, force: true });
	}
});

for (const mode of ["missing", "timeout"] as const)
	test(`file-count ${mode} returns an execution error without inventing a process exit status`, {
		timeout: 25000,
	}, async () => {
		const base = await mkdtemp(join(tmpdir(), "tool-process-"));
		const bin = join(base, "bin");
		await mkdir(bin);
		if (mode === "timeout")
			await writeFile(join(bin, "find"), "#!/bin/sh\nexec /bin/sleep 30\n", {
				mode: 0o755,
			});
		const originalPath = process.env.PATH;
		let requests = 0;
		const f = await fixture(
			async (_url, init) => {
				requests++;
				if (requests === 1) return new Response(completed([tool(base)]));
				const result = JSON.parse(
					JSON.parse(String(init?.body)).input.at(-1).output,
				);
				assert.equal(result.error.kind, "execution");
				if (mode === "timeout") {
					assert.equal(result.error.timedOut, true);
					assert.equal(result.error.exitStatus, null);
					assert.equal(result.error.signal, "SIGKILL");
				} else assert(!("exitStatus" in result.error));
				return new Response(completed([message("execution failed")]));
			},
			[base],
		);
		try {
			process.env.PATH = bin;
			const accepted = await f.ask();
			assert.equal(accepted.status, 202);
			assert.equal(
				(await f.wait((await accepted.json()).turnId)).status,
				"succeeded",
			);
			assert.equal(requests, 2);
		} finally {
			process.env.PATH = originalPath;
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
			(await f.wait((await accepted.json()).turnId)).status,
			"failed",
		);
		const turn = (await f.get(`/api/chats/${f.chat.id}`)).turns[0];
		assert.equal(turn.answer, "partial");
		assert.equal(turn.status, "failed");
	} finally {
		await f.close();
	}
});

test("a continuation persistence failure preserves prior calls and restart interrupts without resuming", async () => {
	let requests = 0;
	const f = await fixture(async () => {
		requests++;
		return requests === 1
			? new Response(completed([message("saved first"), tool("/tmp")]))
			: new Response(completed([message("must not request")]));
	}, []);
	const db = new DatabaseSync(f.databasePath);
	try {
		db.exec(
			"CREATE TRIGGER reject_continuation BEFORE INSERT ON model_calls WHEN EXISTS(SELECT 1 FROM model_calls) BEGIN SELECT RAISE(ABORT,'rejected'); END",
		);
		db.exec(
			"CREATE TRIGGER reject_failure BEFORE UPDATE OF status ON turns WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'rejected'); END",
		);
		const accepted = await f.ask();
		assert.equal(accepted.status, 202);
		await f.waitForIdle((await accepted.json()).turnId);
		assert.equal(requests, 1);
		let turn = (await f.get(`/api/chats/${f.chat.id}`)).turns[0];
		assert.equal(turn.status, "failed");
		assert.equal(turn.errorCode, "answerWriteFailed");
		assert.equal(
			db.prepare("SELECT status FROM turns WHERE id=?").get(turn.id)?.status,
			"pending",
		);
		assert.equal(turn.answer, "saved first");
		assert.equal((await f.get(`/api/turns/${turn.id}/calls`)).calls.length, 1);
		db.exec("DROP TRIGGER reject_continuation; DROP TRIGGER reject_failure");
		await f.restart();
		turn = (await f.get(`/api/chats/${f.chat.id}`)).turns[0];
		assert.equal(turn.status, "failed");
		assert.equal(turn.errorCode, "modelInterrupted");
		assert.equal(turn.answer, "saved first");
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
				(await f.wait((await accepted.json()).turnId)).status,
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
		let turn = (await f.get(`/api/chats/${f.chat.id}`)).turns[0];
		while (turn.output.length < 4) {
			await new Promise((resolve) => setImmediate(resolve));
			turn = (await f.get(`/api/chats/${f.chat.id}`)).turns[0];
		}
		assert.deepEqual(
			turn.output.map((item: { callOrdinal: number }) => item.callOrdinal),
			[1, 1, 2, 2],
		);
		assert.deepEqual(
			turn.calls.map((call: { ordinal: number; status: string }) => [
				call.ordinal,
				call.status,
			]),
			[
				[1, "succeeded"],
				[2, "pending"],
			],
		);
		const metadata = (await f.get(`/api/turns/${turn.id}/calls?kind=metadata`))
			.calls;
		assert.deepEqual(
			metadata.map((call: { id: number }) => call.id),
			turn.calls.map((call: { id: number }) => call.id),
		);
		assert(
			metadata.every(
				(call: object) => !("requestBody" in call) && !("responseBody" in call),
			),
		);
		for (const savedCall of turn.calls) {
			const request = (
				await f.get(
					`/api/turns/${turn.id}/calls?kind=request&callId=${savedCall.id}`,
				)
			).calls;
			assert.equal(request.length, 1);
			assert.equal(request[0].id, savedCall.id);
			assert.equal(request[0].responseBody, null);
			assert.equal(JSON.parse(request[0].requestBody).model, "tool-model");
		}
		const details = (await f.get(`/api/turns/${turn.id}/reasoning`)).output;
		assert.deepEqual(
			details.map((item: { callOrdinal: number }) => item.callOrdinal),
			[1, 2],
		);
		assert.deepEqual(
			details.map(
				(item: { content: { text: string }[] }) => item.content[0].text,
			),
			["first thinking", "second thinking"],
		);
		const onlySecond = (
			await f.get(`/api/turns/${turn.id}/reasoning?callOrdinal=2`)
		).output;
		assert.deepEqual(onlySecond, [details[1]]);
		for (const suffix of ["callId=0", "callId=bogus", "kind=bogus"])
			assert.equal(
				(await f.get(`/api/turns/${turn.id}/calls?${suffix}`)).code,
				"invalidInput",
			);
		assert.equal(
			(await f.get(`/api/turns/${turn.id}/reasoning?callOrdinal=0`)).code,
			"invalidInput",
		);
		assert.equal(
			(await f.get(`/api/turns/${turn.id}/calls?callId=999999`)).code,
			"notFound",
		);
		second.close();
		const submitted = await pending;
		assert([202, 502].includes(submitted.status));
		do {
			turn = (await f.get(`/api/chats/${f.chat.id}`)).turns[0];
		} while (turn.status === "pending");
		assert.equal(turn.status, "failed");
		assert.deepEqual(
			turn.calls.map((call: { status: string }) => call.status),
			["succeeded", "failed"],
		);
		const response = (
			await f.get(
				`/api/turns/${turn.id}/calls?kind=response&callId=${turn.calls[1].id}`,
			)
		).calls;
		assert.equal(response.length, 1);
		assert.match(response[0].responseBody, /second thinking/);
		assert.doesNotMatch(response[0].responseBody, /first thinking/);
		assert.equal(response[0].requestBody, null);
		await f.restart();
		const saved = (await f.get(`/api/turns/${turn.id}`)).turns[0];
		assert.deepEqual(saved.calls, turn.calls);
		assert.deepEqual(saved.output, turn.output);
		assert.deepEqual(
			(await f.get(`/api/turns/${turn.id}/reasoning`)).output,
			details,
		);
		assert.equal(requests, 2);
		assert([200, 202].includes((await f.ask()).status));
		let later = (await f.get(`/api/chats/${f.chat.id}`)).turns.at(-1);
		while (later.status === "pending")
			later = (await f.get(`/api/chats/${f.chat.id}`)).turns.at(-1);
		assert.equal(later.calls[0].ordinal, 1);
		assert(later.calls[0].id > turn.calls[1].id);
		assert.equal(
			(
				await f.get(
					`/api/turns/${later.id}/calls?kind=request&callId=${turn.calls[0].id}`,
				)
			).code,
			"notFound",
		);
		assert.equal(requests, 3);
	} finally {
		await f.close();
	}
});
